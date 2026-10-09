'use strict';

/*
 * The Android app (android/): the page runs in its WebView, and the app records in the background
 * what a browser stops as soon as the screen is off: the GPS track of a tour and the drive mode
 * (camera + route). The app offers `window.MyForrestNative` (strings only); this wraps it.
 *
 * Global `nativeApp`: null in the browser, else
 *   has(feature)          'tour' | 'drive'
 *   start(mode, options)  → null when started (or asking for permissions), else the reason
 *   stop()                → state after the end (waits for the last picture)
 *   state()               { mode, running, finished, interrupted, error, status, fix, points, waiting, shots, … }
 *   route(from)           route points from index `from` on
 *   kept()                kept pictures waiting for the upload queue: [{ id, time, lat, lon, heading?, spotId?, reason, size }]
 *   frame(id)             a kept picture as Blob (null when gone)
 *   ack(id), clear(), chooseServer()
 */
(function nativeAppModule(root) {
  const bridge = root.MyForrestNative;
  if (!bridge) {
    root.nativeApp = null;
    return;
  }
  const parse = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };
  const info = parse(bridge.info(), {});
  const features = new Set(info.features || []);

  function frame(id) {
    const b64 = bridge.frame(String(id));
    if (!b64) return null;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: 'image/jpeg' });
  }

  root.nativeApp = {
    info,
    has: (feature) => features.has(feature),
    start(mode, options = {}) {
      const r = bridge.start(mode, JSON.stringify(options));
      return r === 'ok' ? null : r;
    },
    stop: () => parse(bridge.stop(), {}),
    state: () => parse(bridge.state(), {}),
    route: (from = 0) => parse(bridge.route(from), []),
    kept: () => parse(bridge.kept(), []),
    frame,
    ack: (id) => bridge.ack(String(id)),
    clear: () => bridge.clear(),
    chooseServer: () => bridge.chooseServer(),
  };
  document.documentElement.classList.add('native-app');
}(typeof self !== 'undefined' ? self : this));
