// Firefox (and Zen) expose the promise-based WebExtension API as `browser`; its `chrome`
// alias is callback-based. Point `chrome` at `browser` so the rest of the code is shared.
if (typeof browser !== 'undefined' && browser.runtime?.id) globalThis.chrome = browser;
