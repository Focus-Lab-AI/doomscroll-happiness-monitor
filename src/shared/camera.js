// Camera permission helpers shared by the dashboard banner, the settings page and the popup.
// Chrome's permissions.query is not reliable for extension origins, so a successful
// getUserMedia from an extension page is recorded as `cameraGranted` and treated as the truth.

export const IS_FIREFOX = navigator.userAgent.includes('Firefox/');
export const BROWSER = IS_FIREFOX ? 'Firefox' : 'Chrome';
// Where to unblock the camera for this extension, written for the browser it runs in.
export const CAMERA_UNBLOCK_HINT = IS_FIREFOX
  ? 'Click the camera icon in the address bar of this page and remove the block, or open about:preferences#privacy → Permissions → Camera → Settings and remove the moz-extension:// entry.'
  : 'Open chrome://settings/content/camera and remove this extension from the "Not allowed to use your camera" list.';

export async function queryCameraState() {
  try { return (await navigator.permissions.query({ name: 'camera' })).state; } catch { return 'unknown'; }
}

export async function getCameraStatus() {
  const [state, local] = await Promise.all([
    queryCameraState(),
    chrome.storage.local.get(['cameraGranted', 'cameraError', 'cameraBannerDismissed', 'modelInfo']),
  ]);
  const { cameraGranted, cameraError, cameraBannerDismissed, modelInfo } = local;
  let lastFrame = null;
  try { ({ lastFrame } = await chrome.storage.session.get('lastFrame')); } catch {}
  const capturing = !!lastFrame && Date.now() - lastFrame.ts < 60000;
  const refused = !!cameraError && /NotAllowed|Permission/i.test(`${cameraError.name} ${cameraError.message}`) && (!cameraGranted || cameraError.ts > cameraGranted);
  const granted = state !== 'denied' && !refused && (state === 'granted' || !!cameraGranted || capturing);
  const showBanner = !granted && !cameraBannerDismissed; // Dismiss always wins
  const cause = granted ? '' : state === 'denied' ? `${BROWSER} reports the camera as blocked for this extension.`
    : refused ? `The capture page was refused the camera (${cameraError.name}: ${cameraError.message}, at ${new Date(cameraError.ts).toLocaleTimeString()}).`
    : `${BROWSER} reports permission "${state}" and no grant has been recorded yet.`;
  return { state, granted, refused, capturing, showBanner, cause, cameraGranted, cameraError, cameraBannerDismissed, lastFrame, modelInfo };
}

export function diagLine(s) {
  return [
    `diag: permissions.query=${s.state}`,
    `grantedFlag=${s.cameraGranted ? new Date(s.cameraGranted).toLocaleString() : 'none'}`,
    `captureError=${s.cameraError ? `${s.cameraError.name}: ${s.cameraError.message} @ ${new Date(s.cameraError.ts).toLocaleTimeString()}` : 'none'}`,
    `lastFrame=${s.lastFrame ? `${new Date(s.lastFrame.ts).toLocaleTimeString()} face=${s.lastFrame.faceFound}` : 'none'}`,
    `dismissed=${!!s.cameraBannerDismissed}`,
    `ua=${navigator.userAgent.match(/(Chrome|Firefox)\/[\d.]+/)?.[0] || '?'}`,
  ].join(' · ');
}

// Resolves { ok: true } or { ok: false, name, message, hint }. Never hangs: times out if
// Chrome (or macOS) never answers the permission prompt.
export async function requestCamera({ timeoutMs = 20000 } = {}) {
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('No answer from the camera permission prompt'), { name: 'TimeoutError' })), timeoutMs); });
  try {
    const stream = await Promise.race([navigator.mediaDevices.getUserMedia({ video: true, audio: false }), timeout]);
    for (const t of stream.getTracks()) t.stop();
    await chrome.storage.local.set({ cameraGranted: Date.now() });
    await chrome.storage.local.remove('cameraError');
    chrome.runtime.sendMessage({ target: 'background', type: 'camera-granted' }).catch(() => {});
    return { ok: true };
  } catch (e) {
    const name = e?.name || 'Error';
    const hints = {
      NotAllowedError: IS_FIREFOX ? `Firefox blocked the camera for this extension, or the prompt was dismissed. ${CAMERA_UNBLOCK_HINT} On macOS also check System Settings → Privacy & Security → Camera → Firefox (or Zen).` : 'Chrome blocked the camera for this extension, or the prompt was dismissed. Open chrome://settings/content/camera and remove this extension from the "Not allowed" list. On macOS also check System Settings → Privacy & Security → Camera → Google Chrome.',
      TimeoutError: IS_FIREFOX ? 'Firefox never answered. Look for the camera prompt in the address bar. On macOS the browser itself may lack camera permission: System Settings → Privacy & Security → Camera → enable Firefox (or Zen), then restart it.' : 'Chrome never answered. On macOS this usually means Chrome itself has no camera permission: System Settings → Privacy & Security → Camera → enable Google Chrome, then restart Chrome.',
      NotFoundError: 'No camera device was found.',
      NotReadableError: 'Another app is using the camera (Zoom, FaceTime, Photo Booth…). Close it and try again.',
      OverconstrainedError: 'The camera does not support the requested settings.',
    };
    return { ok: false, name, message: e?.message || String(e), hint: hints[name] || '' };
  } finally {
    clearTimeout(timer);
  }
}

export async function dismissCameraBanner() {
  await chrome.storage.local.set({ cameraBannerDismissed: true });
}
export async function undismissCameraBanner() {
  await chrome.storage.local.remove('cameraBannerDismissed');
}
