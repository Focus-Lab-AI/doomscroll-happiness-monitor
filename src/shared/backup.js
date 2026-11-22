// Full backup / restore of the IndexedDB data, images included, for moving between browsers.
//
// File layout: the magic line, then records back to back. Each record is
//   4-byte big-endian header length | header JSON (UTF-8) | blob bytes
// where the header is { t, v, blobs: [[field, size, mimeType], ...] } and the blob bytes follow in that order.
// Record types (t): meta, settings, sessions, frames, activity, end. Sessions come before frames and activity.
//
// Nothing here is Chrome-specific, so the same file can be read by a Firefox build of the extension.
import * as db from './db.js';

const MAGIC = 'DHMBAK1\n';
const STORES = ['sessions', 'frames', 'activity'];
const PAGE = 200;                    // records read from IndexedDB per request while exporting
const BATCH_BYTES = 24 * 1024 * 1024; // image bytes written per transaction while importing
const BATCH_RECORDS = 500;
const enc = new TextEncoder();
const dec = new TextDecoder();

function record(t, v) {
  const blobs = [];
  const plain = {};
  for (const [k, val] of Object.entries(v || {})) {
    if (val instanceof Blob) blobs.push([k, val]);
    else plain[k] = val;
  }
  const header = enc.encode(JSON.stringify({ t, v: plain, blobs: blobs.map(([k, b]) => [k, b.size, b.type]) }));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, header.length);
  return [len, header, ...blobs.map(([, b]) => b)];
}

async function storeCount(store) {
  const d = await db.openDB();
  return new Promise((resolve, reject) => {
    const req = d.transaction(store, 'readonly').objectStore(store).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Yields the backup as a sequence of parts (Uint8Array or Blob), reading IndexedDB a page at a time.
export async function* backupParts(onProgress) {
  const counts = {};
  for (const s of STORES) counts[s] = await storeCount(s);
  const total = STORES.reduce((n, s) => n + counts[s], 0);
  let done = 0;
  yield enc.encode(MAGIC);
  yield* record('meta', { format: 1, exportedAt: new Date().toISOString(), version: chrome.runtime.getManifest().version, counts });
  const { settings } = await chrome.storage.local.get('settings');
  if (settings) yield* record('settings', settings);
  for (const store of STORES) {
    let last = null;
    for (;;) {
      const rows = await db.getAll(store, last == null ? undefined : IDBKeyRange.lowerBound(last, true), PAGE);
      if (!rows.length) break;
      for (const row of rows) yield* record(store, row);
      last = rows[rows.length - 1].id;
      done += rows.length;
      onProgress?.({ done, total });
    }
  }
  yield* record('end', { records: done });
}

// Writes the backup to a FileSystemWritableFileStream (streams to disk, no size limit).
export async function writeBackup(writable, onProgress) {
  let bytes = 0;
  for await (const part of backupParts(onProgress)) {
    await writable.write(part);
    bytes += part.size ?? part.byteLength;
  }
  return bytes;
}

// Builds the backup as one Blob (for browsers without a save-file picker).
export async function backupBlob(onProgress) {
  const parts = [];
  for await (const part of backupParts(onProgress)) parts.push(part);
  return new Blob(parts, { type: 'application/octet-stream' });
}

// Sequential reader over a File that only pulls the small header regions into memory.
function reader(file) {
  const CHUNK = 256 * 1024;
  let buf = new Uint8Array(0);
  let bufOff = 0;
  return async (off, len) => {
    if (off < bufOff || off + len > bufOff + buf.length) {
      buf = new Uint8Array(await file.slice(off, off + Math.max(len, CHUNK)).arrayBuffer());
      bufOff = off;
    }
    if (buf.length < len) throw new Error('Backup file is truncated');
    return buf.subarray(off - bufOff, off - bufOff + len);
  };
}

async function* records(file) {
  const read = reader(file);
  const magic = enc.encode(MAGIC);
  if (file.size < magic.length || dec.decode(await read(0, magic.length)) !== MAGIC) {
    throw new Error('Not a Doomscroll Happiness Monitor backup file');
  }
  let off = magic.length;
  while (off < file.size) {
    const hLen = new DataView(new Uint8Array(await read(off, 4)).buffer).getUint32(0);
    const header = JSON.parse(dec.decode(await read(off + 4, hLen)));
    off += 4 + hLen;
    const v = header.v || {};
    let blobBytes = 0;
    for (const [field, size, type] of header.blobs || []) {
      if (off + size > file.size) throw new Error('Backup file is truncated');
      v[field] = file.slice(off, off + size, type);
      off += size;
      blobBytes += size;
    }
    yield { t: header.t, v, blobBytes, off };
  }
}

async function writeBatch(batch) {
  if (!batch.length) return;
  const d = await db.openDB();
  const tx = d.transaction(STORES, 'readwrite');
  for (const { store, value } of batch) tx.objectStore(store).put(value);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Import transaction aborted'));
  });
}

// Merges a backup file into this browser's data. Sessions that already exist here (same id) are left alone,
// along with their frames, so importing the same file twice does not duplicate anything. Frames and activity
// get fresh ids, so they never collide with rows recorded here. Settings are restored only if none are saved yet.
export async function importBackup(file, onProgress) {
  const existing = new Set((await db.getAll('sessions')).map((s) => s.id));
  const imported = new Set();
  const openEnd = new Map(); // sessions that were still open when exported -> last frame time
  const result = { sessions: 0, frames: 0, activity: 0, skippedSessions: 0, settingsRestored: false, complete: false, exportedAt: null };
  let batch = [];
  let batchBytes = 0;
  const flush = async () => { await writeBatch(batch); batch = []; batchBytes = 0; };

  for await (const { t, v, blobBytes, off } of records(file)) {
    if (t === 'meta') {
      if (v.format !== 1) throw new Error(`Unsupported backup format ${v.format}`);
      result.exportedAt = v.exportedAt;
    } else if (t === 'settings') {
      const { settings } = await chrome.storage.local.get('settings');
      if (!settings) { await chrome.storage.local.set({ settings: v }); result.settingsRestored = true; }
    } else if (t === 'sessions') {
      if (existing.has(v.id)) { result.skippedSessions++; continue; }
      if (v.open || v.endedAt == null) { openEnd.set(v.id, v.startedAt); delete v.open; }
      imported.add(v.id);
      batch.push({ store: 'sessions', value: v });
      result.sessions++;
    } else if (t === 'frames' || t === 'activity') {
      if (!imported.has(v.sessionId)) continue;
      if (openEnd.has(v.sessionId) && v.ts > openEnd.get(v.sessionId)) openEnd.set(v.sessionId, v.ts);
      delete v.id;
      batch.push({ store: t, value: v });
      batchBytes += blobBytes;
      result[t]++;
    } else if (t === 'end') {
      result.complete = true;
    }
    if (batch.length >= BATCH_RECORDS || batchBytes >= BATCH_BYTES) {
      await flush();
      onProgress?.({ done: off, total: file.size });
    }
  }
  await flush();
  for (const [id, endedAt] of openEnd) await db.update('sessions', id, { endedAt });
  onProgress?.({ done: file.size, total: file.size });
  return result;
}
