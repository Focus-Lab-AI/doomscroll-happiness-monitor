// Builds the Firefox package, loads it in Firefox with a fake webcam, visits a tracked site and
// checks that a session + frames land in IndexedDB. Puppeteer cannot open moz-extension:// pages,
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
  await browser.defaultBrowserContext().overridePermissions(ready.origin, ['camera']);
  const page = (await browser.pages())[0];
  await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => console.log('yt nav', e.message));
  const during = await until((r) => r.frames >= 3 && r.capture[0]?.state === 'minimized', 60000);
  console.log('during', JSON.stringify(during));
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => console.log('nav', e.message));
  const after = await until((r) => !r.state?.current && !r.capture.length && r.sessions.length && !r.sessions[0].open, 60000);
  console.log('after', JSON.stringify(after));
  const checks = {
    'session recorded': during?.sessions?.[0]?.domain === 'youtube.com',
    'badge shows REC': during?.badge === 'REC',
    'capture window minimized while recording': during?.capture?.[0]?.state === 'minimized',
    'frames stored': during?.frames >= 3,
    'no camera error': !during?.cameraError,
    'session closed after leaving': after?.sessions?.[0]?.open === false && !after?.state?.current,
    'capture window closed after leaving': after?.capture?.length === 0,
  };
  for (const [k, v] of Object.entries(checks)) console.log(v ? 'PASS' : 'FAIL', k);
  ok = Object.values(checks).every(Boolean);
} finally {
  await browser.close();
  srv.close();
}
process.exit(ok ? 0 : 1);
