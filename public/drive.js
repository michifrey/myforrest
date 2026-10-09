'use strict';

/* =========================================================
   Drive mode (dashcam): a phone in the car takes a picture every few
   seconds, records the road as a route and uploads only the pictures
   worth keeping (drive-select.js decides on the device).
   Uses the globals of app.js ($, el, api, state, fmtDate), account.js
   (Account, openAuth) and offline-queue.js (offlineQueue).
   ========================================================= */
(function driveMode() {
  const ROUTE_KEY = 'myforrest-drive-route'; // the route of a drive in progress (survives a reload)
  const UNSAVED_KEY = 'myforrest-drive-unsaved'; // routes that could not be saved yet (offline)
  const SETTINGS_KEY = 'myforrest-drive-settings';
  const INTERVALS = [2, 3, 5, 10];
  const SPACINGS = [[50, '50 m'], [100, '100 m'], [150, '150 m'], [300, '300 m'], [0, 'nur an Spots']];
  const store = {
    get(k, fallback) { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } },
    set(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or private */ } },
  };

  const D = {
    running: false, stream: null, watch: null, timer: null, flushTimer: null, wake: null,
    selector: null, frames: new Map(), seq: 0, fix: null, route: [], started: 0,
    kept: { spot: 0, abstand: 0 }, bytesKept: 0, bytesSeen: 0, shots: 0, queued: 0,
    settings: { interval: 3, everyM: 150, ...store.get(SETTINGS_KEY, {}) },
  };

  /* ---------- View ---------- */

  const view = el('div', { id: 'drive', class: 'drive', hidden: '', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'drive-title' });
  const stat = (id, label) => el('div', { class: 'drive-stat' }, [el('output', { id, text: '0' }), el('span', { text: label })]);
  const select = (id, label, options, value) => {
    const s = el('select', { id }, options.map(([v, t]) => el('option', { value: String(v), text: t })));
    s.value = String(value);
    return el('label', { class: 'drive-setting' }, [el('span', { text: label }), s]);
  };
  view.append(
    el('div', { class: 'drive-top' }, [
      el('div', {}, [el('strong', { id: 'drive-title', text: 'Fahrtmodus' }), el('div', { id: 'drive-status', class: 'cam-info', text: 'Handy in die Halterung, Kamera nach vorn.' })]),
      el('button', { type: 'button', id: 'drive-close', class: 'icon', 'aria-label': 'Schliessen', text: '×' }),
    ]),
    el('div', { class: 'drive-preview' }, [el('video', { id: 'drive-video', muted: '', playsinline: '', autoplay: '' })]),
    el('div', { class: 'drive-stats' }, [
      stat('drive-shots', 'Bilder gemacht'),
      stat('drive-kept', 'behalten'),
      stat('drive-km', 'km Strecke'),
      stat('drive-saved', 'gespart'),
    ]),
    el('p', { id: 'drive-why', class: 'drive-why' }),
    el('div', { class: 'drive-settings', id: 'drive-settings' }, [
      select('drive-interval', 'Ein Bild alle', INTERVALS.map((s) => [s, `${s} s`]), D.settings.interval),
      select('drive-every', 'Behalten entlang der Strecke', SPACINGS, D.settings.everyM),
    ]),
    el('div', { class: 'drive-controls' }, [el('button', { type: 'button', id: 'drive-toggle', class: 'btn primary drive-go', text: 'Fahrt starten' })]),
  );
  document.body.append(view);
  const canvasHash = el('canvas', { width: '9', height: '8' });
  const canvasSharp = el('canvas', { width: '160', height: '120' });
  const canvasFull = el('canvas');

  const status = (text) => { $('drive-status').textContent = text; };
  const mb = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes >= 1e6 ? `${Math.round(bytes / 1e6)} MB` : `${Math.round(bytes / 1e3)} kB`);

  function render() {
    const s = D.selector?.stats();
    $('drive-shots').textContent = String(D.shots);
    $('drive-kept').textContent = String(D.kept.spot + D.kept.abstand);
    $('drive-km').textContent = s ? (s.distanceM / 1000).toFixed(1) : '0.0';
    // What storing every picture would have taken, minus what is kept.
    const avg = D.shots ? D.bytesSeen / D.shots : 0;
    $('drive-saved').textContent = D.shots ? mb(Math.max(0, avg * D.shots - D.bytesKept)) : '–';
    if (s) {
      const c = s.counts;
      const parts = [
        D.kept.spot && `${D.kept.spot} an Spots`, D.kept.abstand && `${D.kept.abstand} entlang der Strecke`,
        c.stillstand && `${c.stillstand} Stillstand`, c.doppelt && `${c.doppelt} doppelt`, c.unscharf && `${c.unscharf} unscharf`,
        c['kein-gps'] && `${c['kein-gps']} ohne GPS`, D.queued && `${D.queued} warten auf Upload`,
      ].filter(Boolean);
      $('drive-why').textContent = parts.join(' · ');
    }
    $('drive-toggle').textContent = D.running ? 'Fahrt beenden' : 'Fahrt starten';
    $('drive-toggle').classList.toggle('danger', D.running);
    $('drive-settings').hidden = D.running;
  }

  /* ---------- Pictures ---------- */

  function grey(canvas, video) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const out = new Array(canvas.width * canvas.height);
    for (let i = 0; i < out.length; i++) out[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    return out;
  }

  async function shoot() {
    const video = $('drive-video');
    if (!video.videoWidth || document.hidden) return;
    const time = Date.now();
    const fix = D.fix && time - D.fix.time < 10000 ? D.fix : null;
    const frame = {
      id: ++D.seq, time,
      lat: fix?.lat ?? NaN, lon: fix?.lon ?? NaN, accuracy: fix?.accuracy, speed: fix?.speed, heading: fix?.heading,
      hash: driveSelect.dhash(grey(canvasHash, video)),
      sharpness: driveSelect.sharpness(grey(canvasSharp, video), 160, 120),
    };
    D.shots++;
    // The full picture, held until it is decided (a candidate at a spot waits until the spot is passed).
    if (fix) {
      canvasFull.width = video.videoWidth;
      canvasFull.height = video.videoHeight;
      canvasFull.getContext('2d').drawImage(video, 0, 0);
      const blob = await new Promise((r) => canvasFull.toBlob(r, 'image/jpeg', 0.85));
      if (blob) {
        D.bytesSeen += blob.size;
        D.frames.set(frame.id, { blob, frame });
      }
    } else {
      D.bytesSeen += D.shots > 1 ? D.bytesSeen / (D.shots - 1) : 0;
    }
    await apply(D.selector.offer(frame));
    render();
  }

  async function apply(decisions) {
    for (const d of decisions) {
      const held = D.frames.get(d.id);
      D.frames.delete(d.id);
      if (!d.keep || !held) continue;
      D.kept[d.reason] = (D.kept[d.reason] || 0) + 1;
      D.bytesKept += held.blob.size;
      await enqueue(held, d);
    }
  }

  /** Into the upload queue: sent in the background, also after losing the connection in the forest. */
  async function enqueue({ blob, frame }, decision) {
    const fd = new FormData();
    const at = new Date(frame.time).toISOString();
    fd.append('photos', blob, `fahrt-${at.replace(/[:.]/g, '-')}.jpg`);
    fd.append('lat', String(frame.lat));
    fd.append('lon', String(frame.lon));
    if (Number.isFinite(frame.heading)) fd.append('heading', String(Math.round(frame.heading)));
    fd.append('takenAt', at);
    fd.append('activity', 'fahren');
    if (decision.spotId) fd.append('spotId', String(decision.spotId));
    try {
      await offlineQueue.add(fd);
      D.queued++;
    } catch (err) {
      status(`Bild konnte nicht gespeichert werden: ${err.message}`);
    }
  }

  async function sendQueue() {
    if (navigator.onLine === false) return;
    try {
      await offlineQueue.flush();
      D.queued = (await offlineQueue.stats()).pending;
      render();
    } catch { /* next round */ }
  }

  /* ---------- Route ---------- */

  function onPosition(pos) {
    const c = pos.coords;
    D.fix = {
      lat: c.latitude, lon: c.longitude, accuracy: c.accuracy, time: pos.timestamp,
      speed: Number.isFinite(c.speed) ? c.speed : undefined,
      heading: Number.isFinite(c.heading) && c.speed > 1 ? c.heading : undefined,
    };
    if (c.accuracy > 40) return status(`Warte auf genaueres GPS (±${Math.round(c.accuracy)} m) …`);
    const p = { lat: c.latitude, lon: c.longitude, time: pos.timestamp };
    const last = D.route.at(-1);
    // A point every 25 m: a whole day on the road stays within the 20 000 points of a tour.
    if (!last || driveSelect.distanceM(last, p) >= 25) {
      D.route.push(p);
      store.set(ROUTE_KEY, D.route);
    }
    status(`Unterwegs · GPS ±${Math.round(c.accuracy)} m${Number.isFinite(c.speed) ? ` · ${Math.round(c.speed * 3.6)} km/h` : ''}`);
  }

  /** Saves the route as a tour; offline it waits for the next time. */
  async function saveRoute(points, started) {
    if (points.length < 2) return null;
    // Very long days: every n-th point (start and end kept).
    const step = Math.ceil(points.length / 19000);
    if (step > 1) points = points.filter((_, i) => i % step === 0 || i === points.length - 1);
    const body = { name: `Fahrt ${fmtDate(new Date(started).toISOString())}`, kind: 'aufgezeichnet', activity: 'fahren', points };
    try {
      return await api('/api/tracks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch {
      store.set(UNSAVED_KEY, [...store.get(UNSAVED_KEY, []), body]);
      return null;
    }
  }

  async function saveUnsaved() {
    const waiting = store.get(UNSAVED_KEY, []);
    if (!waiting.length || !Account.user || navigator.onLine === false) return;
    store.set(UNSAVED_KEY, null);
    for (const body of waiting) {
      try {
        await api('/api/tracks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      } catch {
        store.set(UNSAVED_KEY, [...store.get(UNSAVED_KEY, []), body]);
      }
    }
  }

  /* ---------- Start and stop ---------- */

  async function start() {
    if (!Account.user) return openAuth('login', { intro: 'Im Fahrtmodus werden Bilder und Route deinem Konto zugeordnet.', then: start });
    if (!navigator.geolocation || !navigator.mediaDevices?.getUserMedia) return status('Dieses Gerät kann keine Kamera und kein GPS liefern (HTTPS nötig).');
    D.settings = { interval: Number($('drive-interval').value), everyM: Number($('drive-every').value) };
    store.set(SETTINGS_KEY, D.settings);
    if (D.stream?.getVideoTracks().every((t) => t.readyState === 'ended')) D.stream = null;
    try {
      D.stream = D.stream || await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false,
      });
    } catch (err) {
      return status(`Kamera nicht verfügbar (${err.message})`);
    }
    $('drive-video').srcObject = D.stream;
    await $('drive-video').play().catch(() => {});
    const spots = (state.spots || []).map((s) => ({ id: s.id, lat: s.lat, lon: s.lon, heading: s.heading }));
    D.selector = driveSelect.createSelector(spots, D.settings.everyM ? { everyM: D.settings.everyM } : { onlySpots: true });
    Object.assign(D, { running: true, frames: new Map(), shots: 0, bytesSeen: 0, bytesKept: 0, kept: { spot: 0, abstand: 0 }, route: store.get(ROUTE_KEY, []), started: Date.now() });
    if (D.route.length) D.started = D.route[0].time;
    D.watch = navigator.geolocation.watchPosition(onPosition, (err) => status(`GPS: ${err.message}`), { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 });
    D.timer = setInterval(() => shoot().catch((err) => status(err.message)), D.settings.interval * 1000);
    D.flushTimer = setInterval(sendQueue, 60000);
    // The screen stays on: browsers stop camera and GPS for pages in the background.
    try { D.wake = await navigator.wakeLock?.request('screen'); } catch { /* not allowed */ }
    render();
  }

  async function stop() {
    if (!D.running) return;
    clearInterval(D.timer);
    clearInterval(D.flushTimer);
    navigator.geolocation.clearWatch(D.watch);
    D.wake?.release?.();
    D.running = false;
    await apply(D.selector.finish());
    const tour = await saveRoute(D.route, D.started);
    store.set(ROUTE_KEY, null);
    const kept = D.kept.spot + D.kept.abstand;
    status(`Fahrt beendet: ${D.shots} Bilder gemacht, ${kept} behalten${tour ? `, Route «${tour.name}» gespeichert` : D.route.length > 1 ? ', Route wird gespeichert, sobald Netz da ist' : ''}.`);
    render();
    sendQueue();
  }

  function open() {
    view.hidden = false;
    document.body.style.overflow = 'hidden';
    render();
    if (store.get(ROUTE_KEY, []).length) status('Eine unterbrochene Fahrt wurde gefunden – «Fahrt starten» setzt sie fort.');
  }

  async function close() {
    if (D.running && !confirm('Fahrt beenden?')) return;
    await stop();
    D.stream?.getTracks().forEach((t) => t.stop());
    D.stream = null;
    view.hidden = true;
    document.body.style.overflow = '';
  }

  $('drive-toggle').addEventListener('click', () => (D.running ? stop() : start()));
  $('drive-close').addEventListener('click', close);
  document.addEventListener('visibilitychange', async () => {
    if (!D.running) return;
    if (document.hidden) return;
    // Back in view: the screen lock and the camera may need a new start.
    try { D.wake = await navigator.wakeLock?.request('screen'); } catch { /* not allowed */ }
    if (D.stream?.getVideoTracks().every((t) => t.readyState === 'ended')) {
      D.stream = null;
      status('Kamera wurde unterbrochen – bitte die App im Vordergrund lassen.');
    }
  });
  window.addEventListener('online', () => { saveUnsaved(); if (D.running) sendQueue(); });
  setTimeout(saveUnsaved, 5000);

  window.Drive = { open, start, stop, state: D };
  if (new URLSearchParams(location.search).get('action') === 'fahrt') setTimeout(open, 0);
}());
