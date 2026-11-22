// Builds the Firefox / Zen package from the Chrome manifest:
//   dist/firefox/                                   unpacked (about:debugging → Load Temporary Add-on)
//   dist/doomscroll-happiness-monitor-firefox.xpi   zipped, for signing / installing
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist', 'firefox');
const XPI = path.join(ROOT, 'dist', 'doomscroll-happiness-monitor-firefox.xpi');
export const GECKO_ID = 'doomscroll-happiness-monitor@focuslab.ai';

export function firefoxManifest(m) {
  return {
    manifest_version: 2,
    name: m.name,
    version: m.version,
    description: m.description,
    browser_specific_settings: {
      gecko: { id: GECKO_ID, strict_min_version: '140.0', data_collection_permissions: { required: ['none'] } },
    },
    // MV2 grants host access at install; Firefox MV3 would leave it off until the user opts in.
    permissions: [...m.permissions.filter((p) => p !== 'offscreen'), ...m.host_permissions],
    background: { page: 'src/background.html', persistent: true },
    browser_action: m.action,
    options_ui: m.options_ui,
    icons: m.icons,
    content_scripts: m.content_scripts,
    content_security_policy: m.content_security_policy.extension_pages,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  for (const p of ['icons', 'lib', 'models', 'src', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    fs.cpSync(path.join(ROOT, p), path.join(OUT, p), { recursive: true });
  }
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(firefoxManifest(manifest), null, 2) + '\n');
  fs.rmSync(XPI, { force: true });
  execFileSync('zip', ['-qr', '-X', XPI, '.'], { cwd: OUT });
  console.log(`built ${path.relative(ROOT, OUT)} and ${path.relative(ROOT, XPI)} (v${manifest.version})`);
}
