// Firefox, camera permission never answered: switching tracked sites and leaving must still
// update sessions instead of waiting on the prompt. Puppeteer cannot open moz-extension:// pages,
// so a test-only hook added to the built background page reports state to a local server.
import puppeteer from 'puppeteer';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'test', 'out', 'firefox-ext');
const PORT = 8766;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-firefox.mjs')], { stdio: 'inherit' });
fs.rmSync(EXT, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'dist', 'firefox'), EXT, { recursive: true });
fs.writeFileSync(path.join(EXT, 'src', 'test-hook.js'), `
import * as db from './shared/db.js';
const { settings } = await chrome.storage.local.get('settings');
await chrome.storage.local.set({ settings: { ...(settings || {}), idleSeconds: 86400, minSessionMs: 5000 } });
setInterval(async () => {
  const session = await chrome.storage.session.get(['state', 'lastFrame']);
  const local = await chrome.storage.local.get(['cameraError', 'modelInfo', 'screenError']);
  const wins = await chrome.windows.getAll({ populate: true });
  const capture = wins.filter((w) => w.tabs.some((t) => t.url.includes('offscreen.html'))).map((w) => ({ type: w.type, state: w.state }));
  const sessions = await db.getAll('sessions');
  const frames = await db.getAll('frames');
  const badge = await chrome.browserAction.getBadgeText({});
  const report = { origin: location.origin, ...session, ...local, capture, badge,
    sessions: sessions.map((s) => ({ domain: s.domain, open: !!s.open, dur: (s.endedAt || Date.now()) - s.startedAt })),
    frames: frames.length, screens: frames.filter((f) => f.screen).length, backend: frames[0]?.backend, inferMs: frames.map((f) => f.inferMs) };
  fetch('http://127.0.0.1:${PORT}/', { method: 'POST', body: JSON.stringify(report) }).catch(() => {});
}, 2000);
`);
const bgHtml = path.join(EXT, 'src', 'background.html');
fs.writeFileSync(bgHtml, fs.readFileSync(bgHtml, 'utf8').replace('</body>', '  <script type="module" src="test-hook.js"></script>\n</body>'));

let last = null;
const srv = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { try { last = JSON.parse(b); } catch {} res.end('ok'); }); }).listen(PORT);
const until = async (pred, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (last && pred(last)) return last; await sleep(500); } return last; };

const browser = await puppeteer.launch({
  browser: 'firefox',
  ...(process.env.FIREFOX_BIN ? { executablePath: process.env.FIREFOX_BIN } : {}),
  headless: !process.env.HEADFUL,
  extraPrefsFirefox: { 'media.navigator.streams.fake': true },
});
let ok = false;
try {
  await browser.installExtension(EXT);
  const ready = await until((r) => r.origin, 20000);
  if (!ready) throw new Error('background page never reported');
  const page = (await browser.pages())[0];
  await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => console.log('yt nav', e.message));
  // Leave the camera prompt unanswered: tracking must keep following the tab anyway.
  await sleep(8000);
  const pending = last;
  await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch((e) => console.log('nav', e.message));
  const switched = await until((r) => r.state?.current?.domain === 'reddit.com', 40000);
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch((e) => console.log('nav', e.message));
  const after = await until((r) => !r.state?.current && !r.capture.length, 60000);
  console.log('pending', JSON.stringify(pending?.state), 'switched', JSON.stringify(switched?.sessions), 'after', JSON.stringify(after?.sessions));
  const checks = {
    'session started while prompt pending': pending?.state?.current?.domain === 'youtube.com',
    'switch to another tracked site starts a new session': switched?.state?.current?.domain === 'reddit.com',
    'session closed after leaving': !after?.state?.current && after?.sessions?.every((s) => !s.open),
    'capture window closed after leaving': after?.capture?.length === 0,
  };
  for (const [k, v] of Object.entries(checks)) console.log(v ? 'PASS' : 'FAIL', k);
  ok = Object.values(checks).every(Boolean);
} finally {
  await browser.close();
  srv.close();
}
process.exit(ok ? 0 : 1);
