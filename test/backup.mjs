// Full backup export -> wipe -> import round trip in headless Chrome, including the settings-page buttons.
import puppeteer from 'puppeteer';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ headless: true, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox'] });
let failures = 0;
const check = (c, m) => { console.log(c ? 'ok' : 'FAIL', m); if (!c) failures++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dhm-backup-'));
try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('background.js'));
  const extId = new URL(sw.url()).host;
  const page = await browser.newPage();
  page.on('pageerror', (e) => { console.log('[pageerror]', e.message); failures++; });
  page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()); });
  await page.goto(`chrome-extension://${extId}/src/settings/settings.html`, { waitUntil: 'load' });
  await sleep(400);

  // Seed: 3 closed sessions + 1 still open, 40 frames each with two image blobs of distinct bytes, some activity.
  await page.evaluate(async () => {
    const m = await import(chrome.runtime.getURL('src/shared/db.js'));
    await m.clearAll();
    const base = Date.now() - 3600000;
    for (let s = 0; s < 4; s++) {
      const id = 'bk-' + s;
      const sess = { id, domain: 'reddit.com', url: 'https://reddit.com/r/' + s, title: 'tïtle ✓ ' + s, startedAt: base + s * 600000, endedAt: s === 3 ? null : base + s * 600000 + 120000 };
      if (s === 3) sess.open = 1;
      await m.put('sessions', sess);
      for (let f = 0; f < 40; f++) {
        const thumb = new Blob([new Uint8Array(3000).fill((s * 40 + f) % 251)], { type: 'image/jpeg' });
        const screen = f % 5 === 0 ? null : new Blob([new Uint8Array(20000 + f).fill((s + f) % 253)], { type: 'image/jpeg' });
        await m.add('frames', { sessionId: id, ts: sess.startedAt + f * 3000, faceFound: true, score: 0.9, box: { x: 1, y: 2, w: 3, h: 4 }, expressions: { happy: 0.5, sad: 0.1 }, mood: 0.4, dominant: 'happy', thumb, screen, inferMs: 12, pageUrl: 'https://reddit.com/x', pageTitle: 'p' + f });
      }
      for (let a = 0; a < 5; a++) await m.add('activity', { sessionId: id, ts: sess.startedAt + a * 10000, scrollPx: a * 100, clicks: a, keys: 0 });
    }
  });

  const snapshot = () => page.evaluate(async () => {
    const m = await import(chrome.runtime.getURL('src/shared/db.js'));
    const hex = async (b) => b ? `${b.type}:${b.size}:${[...new Uint8Array(await crypto.subtle.digest('SHA-1', await b.arrayBuffer()))].map((x) => x.toString(16).padStart(2, '0')).join('')}` : null;
    const sessions = (await m.getAll('sessions')).sort((a, b) => a.id.localeCompare(b.id));
    const frames = [];
    for (const s of sessions) for (const { id, thumb, screen, ...f } of await m.framesForSession(s.id)) frames.push({ ...f, thumb: await hex(thumb), screen: await hex(screen) });
    const activity = [];
    for (const s of sessions) for (const { id, ...a } of await m.activityForSession(s.id)) activity.push(a);
    return { sessions, frames, activity };
  });
  const before = await snapshot();
  check(before.frames.length === 160 && before.activity.length === 20, 'seeded 160 frames, 20 activity rows');

  // Export through the button (no save picker -> download path), reading the bytes back out of the page.
  const file = path.join(tmp, 'test.dhmbak');
  await page.evaluate(() => {
    delete window.showSaveFilePicker;
    window.__saved = null;
    const orig = URL.createObjectURL;
    URL.createObjectURL = (b) => { window.__saved = b; return orig.call(URL, b); };
    HTMLAnchorElement.prototype.click = function () {};
  });
  await page.click('#backupBtn');
  await page.waitForFunction(() => document.querySelector('#backupStatus').textContent.startsWith('Backup ready'), { timeout: 20000 });
  const b64 = await page.evaluate(async () => {
    const buf = new Uint8Array(await window.__saved.arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  });
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  const size = fs.statSync(file).size;
  check(size > 160 * 3000, `backup file written (${(size / 1e6).toFixed(2)} MB)`);
  check(fs.readFileSync(file).subarray(0, 8).toString() === 'DHMBAK1\n', 'magic header');

  // The streaming writer must produce byte-identical output.
  const same = await page.evaluate(async () => {
    const m = await import(chrome.runtime.getURL('src/shared/backup.js'));
    const parts = [];
    const bytes = await m.writeBackup({ write: async (p) => { parts.push(p); } });
    const a = new Blob(parts);
    return { bytes, size: a.size };
  });
  check(same.bytes === same.size && Math.abs(same.size - size) < 64, 'streaming writer matches blob size');

  // Wipe everything (data + settings), then import through the file input.
  await page.evaluate(async () => {
    const m = await import(chrome.runtime.getURL('src/shared/db.js'));
    await m.clearAll();
    await chrome.storage.local.remove('settings');
  });
  const status = () => page.$eval('#backupStatus', (e) => e.textContent);
  const doImport = async (f) => {
    await page.evaluate(() => { document.querySelector('#backupStatus').textContent = ''; });
    await (await page.$('#importFile')).uploadFile(f);
    await page.waitForFunction(() => /^(Imported|Failed)/.test(document.querySelector('#backupStatus').textContent), { timeout: 20000 });
    return status();
  };
  let st = await doImport(file);
  check(/Imported 4 sessions, 160 frames/.test(st) && !/WARNING/.test(st), 'import status: ' + st);
  const after = await snapshot();
  const open = after.sessions.find((s) => s.id === 'bk-3');
  check(open && !open.open && open.endedAt === before.frames.filter((f) => f.sessionId === 'bk-3').at(-1).ts, 'open session closed at its last frame');
  const norm = (snap) => ({ ...snap, sessions: snap.sessions.map((s) => s.id === 'bk-3' ? { ...s, open: undefined, endedAt: 0 } : s) });
  check(JSON.stringify(norm(after)) === JSON.stringify(norm(before)), 'sessions, frames, image bytes and activity identical after round trip');
  check((await page.$eval('#dataStats', (e) => e.textContent)).startsWith('4 sessions · 160 frames'), 'data stats refreshed');

  // Importing again must not duplicate; a session recorded here in the meantime must survive.
  await page.evaluate(async () => {
    const m = await import(chrome.runtime.getURL('src/shared/db.js'));
    await m.put('sessions', { id: 'local-1', domain: 'x.com', url: '', title: 'local', startedAt: Date.now(), endedAt: Date.now() + 90000 });
    await m.add('frames', { sessionId: 'local-1', ts: Date.now(), mood: 0.1, thumb: null, screen: null });
    await chrome.storage.local.set({ settings: { captureIntervalMs: 7000 } });
  });
  st = await doImport(file);
  check(/Imported 0 sessions, 0 frames/.test(st) && /4 sessions already here were skipped/.test(st), 're-import skips existing: ' + st);
  const again = await snapshot();
  check(again.frames.length === 161 && again.sessions.length === 5, 'no duplicates, local session kept');
  check((await page.evaluate(() => chrome.storage.local.get('settings'))).settings.captureIntervalMs === 7000, 'existing settings not overwritten');

  // Truncated and foreign files.
  const cut = path.join(tmp, 'cut.dhmbak');
  fs.writeFileSync(cut, fs.readFileSync(file).subarray(0, Math.floor(size / 2)));
  await page.evaluate(async () => { const m = await import(chrome.runtime.getURL('src/shared/db.js')); await m.clearAll(); });
  st = await doImport(cut);
  check(/Failed: Backup file is truncated|WARNING/.test(st), 'truncated file reported: ' + st);
  const junk = path.join(tmp, 'junk.dhmbak');
  fs.writeFileSync(junk, '{"sessions":[]}');
  st = await doImport(junk);
  check(/Failed: Not a Doomscroll Happiness Monitor backup/.test(st), 'foreign file rejected: ' + st);
  check(!(await page.$eval('#backupBtn', (b) => b.disabled)), 'buttons re-enabled after failure');
} catch (e) {
  console.log('FAIL exception', e); failures++;
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failures ? `${failures} failure(s)` : 'all ok');
process.exit(failures ? 1 : 0);
