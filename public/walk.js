'use strict';

/*
 * Walk-through ("Durchgehen"): step from picture to picture like Street View.
 * 360° panoramas turn with the finger or mouse; flat photos show their view.
 * Arrows on a ring at the bottom lead along the recording (video, drive,
 * upload batch) and to nearby spots, placed by their direction relative to
 * where one looks. The view direction is kept when stepping. A mini map
 * shows position, view cone and the recording. The spot's other dates are a
 * time switch. Pictures of the next steps are loaded ahead, so a walk keeps
 * working offline (service worker) once it has been seen.
 * Steps are soft: a panorama first turns towards the chosen way, then the
 * old view zooms ahead (or back) and fades while the new one arrives slightly
 * zoomed in; a change of date crossfades (only a short fade with reduced motion).
 * With the path network (WEGNETZ_URL) arrows also follow the paths to own
 * pictures up to 300 m away, pointing where the path leaves. Between two flat
 * photos that share enough features a step has depth: the old picture moves
 * into its place in the new one (a homography from the server) while it fades.
 * Between two panoramas the server's rotation of the sphere keeps one looking
 * at the same scenery after the step, even where the headings are off.
 * With Mapillary set up, blue arrows lead to Mapillary pictures where there
 * are no own ones, and one can walk on there (ids "m<id>"); their creator and
 * licence stand at the top. A map layer shows Mapillary pictures to start from.
 * API: GET /api/walk/:photoId, /api/walk/mapillary/:id, /api/walk/transition/:from/:to (src/routes/walk.js).
 * Uses the globals of app.js ($, el, api, state, fmtDate) and video.js (PanoViewer).
 */
(function walkMode() {
  const COMPASS = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
  const COMPASS_LONG = { N: 'Norden', NO: 'Nordosten', O: 'Osten', SO: 'Südosten', S: 'Süden', SW: 'Südwesten', W: 'Westen', NW: 'Nordwesten' };
  const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
  const norm = (d) => ((d % 360) + 540) % 360 - 180; // −180 … 180
  const W = { open: false, data: null, view: 0, token: 0, map: null, marker: null, cone: null, track: null, returnHash: '' };

  /* ---------- View ---------- */

  const root = el('div', { id: 'walk', class: 'walk', hidden: '', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'walk-title' });
  const canvas = el('canvas', { class: 'walk-pano', tabindex: '0', 'aria-label': '360°-Ansicht: ziehen zum Umsehen' });
  const flat = el('img', { class: 'walk-flat', alt: '' });
  const ring = el('div', { class: 'walk-ring', role: 'group', 'aria-label': 'Wege von hier' });
  const timeSel = el('select', { id: 'walk-time', 'aria-label': 'Zeitpunkt an diesem Ort' });
  root.append(
    canvas, flat,
    el('div', { class: 'walk-top' }, [
      el('div', { class: 'walk-title' }, [
        el('strong', { id: 'walk-title', text: 'Durchgehen' }),
        el('span', { id: 'walk-meta', class: 'walk-meta' }),
        el('a', { id: 'walk-credit', class: 'walk-credit', target: '_blank', rel: 'noopener', hidden: '' }),
      ]),
      el('label', { class: 'walk-time' }, [el('span', { text: 'Zeit' }), timeSel]),
      el('button', { type: 'button', id: 'walk-spot', class: 'walk-btn', text: 'Spot öffnen' }),
      el('button', { type: 'button', id: 'walk-close', class: 'walk-btn icon', 'aria-label': 'Durchgehen beenden', text: '×' }),
    ]),
    ring,
    el('div', { id: 'walk-map', class: 'walk-map', 'aria-hidden': 'true' }),
    el('p', { id: 'walk-hint', class: 'walk-hint', 'aria-live': 'polite' }),
  );
  document.body.append(root);
  const pano = window.PanoViewer ? new window.PanoViewer(canvas, () => { if (W.data?.photo.panorama) setView(viewDir(), false); }) : null;

  /** Where one looks (° from north): heading of the picture plus the turn of the panorama. */
  function viewDir() {
    const p = W.data?.photo;
    if (!p) return 0;
    return (((p.heading ?? 0) + (p.panorama && pano ? pano.yaw : 0)) % 360 + 360) % 360;
  }

  function setView(dir, turnPano = true) {
    W.view = dir;
    const p = W.data?.photo;
    if (turnPano && p?.panorama && pano) pano.set({ yaw: norm(dir - (p.heading ?? 0)) });
    renderRing();
    renderMapView();
    $('walk-meta').textContent = metaText();
  }

  const fmtDist = (m) => (m < 1000 ? `${m} m` : `${(m / 1000).toLocaleString('de-CH', { maximumFractionDigits: 1 })} km`);
  function metaText() {
    const p = W.data?.photo;
    if (!p) return '';
    const seq = W.data.sequence ? ` · Bild ${W.data.sequence.index + 1} von ${W.data.sequence.length}` : '';
    const dir = p.heading === null && !p.panorama ? '' : ` · Blick nach ${COMPASS_LONG[compass(W.view)]}`;
    return `${fmtDate(p.takenAt)}${p.panorama ? ' · 360°' : ''}${dir}${seq}`;
  }

  /** Arrows on an ellipse at the bottom: straight ahead is at the top of the ring. */
  function renderRing() {
    const links = W.data?.links || [];
    ring.replaceChildren(...links.map((l) => {
      const rel = norm(l.bearing - W.view);
      const rad = (rel * Math.PI) / 180;
      const ahead = Math.cos(rad);
      const what = l.kind === 'weg' ? (l.direction === 'vor' ? 'Weiter auf der Aufnahme' : 'Zurück auf der Aufnahme')
        : l.kind === 'mapillary' ? `Mapillary-Bild${l.creator ? ` von ${l.creator}` : ''}`
          : l.kind === 'pfad' ? `Auf dem Weg zu Spot ${l.spotId} (Luftlinie ${fmtDist(l.straightM)})` : `Spot ${l.spotId}`;
      const label = l.kind === 'weg' ? (l.direction === 'vor' ? 'Weiter' : 'Zurück') : l.kind === 'mapillary' ? 'Zum Mapillary-Bild'
        : l.kind === 'pfad' ? `Auf dem Weg zu Spot ${l.spotId}` : `Zu Spot ${l.spotId}`;
      const b = el('button', {
        type: 'button',
        class: `walk-arrow ${l.kind}${l.source === 'mapillary' ? ' from-mapillary' : ''}${Math.abs(rel) < 35 ? ' ahead' : ''}`,
        style: `--x:${(Math.sin(rad) * 46).toFixed(1)}%;--y:${(-ahead * 34).toFixed(1)}%;--r:${rel.toFixed(1)}deg;--s:${(0.8 + 0.25 * (ahead + 1) / 2).toFixed(2)}`,
        title: `${what} · ${fmtDist(l.distanceM)} nach ${COMPASS_LONG[compass(l.bearing)]}${l.panorama ? ' · 360°' : ''}`,
        'aria-label': `${label}, ${fmtDist(l.distanceM)} nach ${COMPASS_LONG[compass(l.bearing)]}`,
        onclick: () => step(l),
      }, [el('span', { class: 'walk-chevron', 'aria-hidden': 'true' }), el('span', { class: 'walk-dist', text: fmtDist(l.distanceM) })]);
      return b;
    }));
    $('walk-hint').textContent = links.length ? ''
      : 'Von hier führt kein Weg weiter. Mit einem 360°-Video oder dem Fahrtmodus entstehen Bilderreihen zum Durchgehen.';
  }

  /* ---------- Mini map ---------- */

  function ensureMap() {
    if (W.map) return;
    W.map = L.map('walk-map', { zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(W.map);
    W.ways = L.layerGroup().addTo(W.map);
    W.track = L.polyline([], { className: 'walk-track', weight: 4, interactive: false }).addTo(W.map);
    W.dots = L.layerGroup().addTo(W.map);
    W.marker = L.marker([0, 0], { icon: L.divIcon({ className: '', html: '<span class="walk-me"><i></i></span>', iconSize: [0, 0] }), interactive: false, keyboard: false }).addTo(W.map);
  }
  function renderMap() {
    ensureMap();
    const { photo, track, links, paths = [] } = W.data;
    W.map.setView([photo.lat, photo.lon], 17, { animate: false });
    // The path network around, and the paths the arrows follow (after setView: Leaflet draws only on a placed map).
    W.ways.clearLayers();
    for (const w of paths) L.polyline(w, { className: 'walk-way', weight: 2, interactive: false }).addTo(W.ways);
    for (const l of links) if (l.path) L.polyline(l.path, { className: 'walk-way-to', weight: 3, interactive: false }).addTo(W.ways);
    W.track.setLatLngs(track.length > 1 ? track : []);
    W.dots.clearLayers();
    for (const l of links) L.circleMarker([l.lat, l.lon], { radius: 4, className: `walk-dot ${l.kind}`, interactive: false }).addTo(W.dots);
    W.marker.setLatLng([photo.lat, photo.lon]);
    W.map.setView([photo.lat, photo.lon], 17, { animate: false });
    W.map.invalidateSize();
    renderMapView();
  }
  function renderMapView() {
    const me = W.marker?.getElement()?.querySelector('.walk-me i');
    if (me) me.style.setProperty('--h', `${W.view}deg`);
  }

  /* ---------- Moving ---------- */

  /** Own photos by number, Mapillary pictures as "m<id>". */
  const isMapillary = (id) => /^m\d+$/.test(String(id));

  /* ---------- Soft steps ---------- */

  const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  const frames = (ms, step) => new Promise((resolve) => {
    const t0 = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - t0) / ms);
      step(ease(t));
      if (t < 1) requestAnimationFrame(tick); else resolve();
    };
    requestAnimationFrame(tick);
  });

  /** Turns the panorama so one looks at `bearing` (° from north), quicker for small turns. */
  function turnTo(bearing) {
    const p = W.data?.photo;
    const from = pano.yaw;
    const delta = norm(bearing - viewDir());
    if (Math.abs(delta) < 8) return Promise.resolve();
    return frames(Math.min(600, Math.max(220, Math.abs(delta) * 4.5)), (t) => pano.set({ yaw: from + delta * t }))
      .then(() => setView(((p.heading ?? 0) + pano.yaw + 360) % 360, false));
  }

  /** A still of the current view laid over it, to fade out once the next picture is there. */
  function still() {
    let node = null;
    if (!canvas.hidden && pano?.ok) node = pano.snapshot();
    else if (!flat.hidden && flat.complete && flat.naturalWidth) node = flat.cloneNode();
    if (!node) return null;
    node.removeAttribute('id');
    node.className = `walk-still${node.tagName === 'IMG' ? ' flat' : ''}`;
    node.setAttribute('aria-hidden', 'true');
    root.insertBefore(node, root.querySelector('.walk-top'));
    return node;
  }

  /**
   * Fades the still out: ahead it grows (one walks into the picture, towards `rel` degrees from
   * the middle), back it shrinks, a change of date just fades. The new panorama arrives a little
   * zoomed in and eases back to its field of view.
   */
  async function fadeStill(node, kind, rel = 0) {
    if (!node) return;
    const quiet = reduceMotion();
    const scale = quiet || kind === 'zeit' ? 1 : kind === 'zurueck' ? 0.84 : 1.32;
    const ox = 50 + Math.max(-35, Math.min(35, Math.sin((rel * Math.PI) / 180) * 45));
    node.style.transformOrigin = `${ox}% 58%`;
    const ms = quiet ? 160 : kind === 'zeit' ? 450 : 650;
    const arrive = !quiet && kind !== 'zeit' && !canvas.hidden && pano?.ok;
    const fov = pano?.fov ?? 75;
    if (arrive) pano.set({ fov: fov * (kind === 'zurueck' ? 1.12 : 0.86) });
    await Promise.all([
      node.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: `scale(${scale})` }], { duration: ms, easing: 'ease-in', fill: 'forwards' }).finished.catch(() => {}),
      arrive ? frames(ms, (t) => pano.set({ fov: fov * ((kind === 'zurueck' ? 1.12 : 0.86) + (1 - (kind === 'zurueck' ? 1.12 : 0.86)) * t) })) : null,
    ]);
    node.remove();
  }

  /* ---------- Steps with depth (flat photos) ---------- */

  // 3×3 matrices as flat row-major arrays, like src/homography.js.
  const mul3 = (a, b) => [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]));
  function inv3(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h; const B = -(d * i - f * g); const C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (!det) return null;
    return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det);
  }
  const unit = (m) => m.map((v) => v / m[8]);
  const lerp3 = (a, b, t) => a.map((v, k) => v + (b[k] - v) * t);
  const css3 = (m) => `matrix3d(${m[0]},${m[3]},0,${m[6]},${m[1]},${m[4]},0,${m[7]},0,0,1,0,${m[2]},${m[5]},0,${m[8]})`;
  /** Normalised image coordinates → screen pixels of an <img> shown with object-fit: contain. */
  function shown(img) {
    const w = img.clientWidth; const h = img.clientHeight;
    const k = Math.min(w / img.naturalWidth, h / img.naturalHeight);
    const dw = img.naturalWidth * k; const dh = img.naturalHeight * k;
    return [dw, 0, (w - dw) / 2, 0, dh, (h - dh) / 2, 0, 0, 1];
  }

  /**
   * How the current photo lies in picture `to` ({ id, panorama, source }): { h } between flat photos,
   * { r } between panoramas (from the server, asked at most once per pair), or null.
   */
  const transitions = new Map();
  function transitionTo(to) {
    const from = W.data?.photo;
    if (!from || from.source || to.source === 'mapillary' || isMapillary(to.id) || Boolean(from.panorama) !== Boolean(to.panorama)) return Promise.resolve(null);
    const key = `${from.id}:${to.id}`;
    if (!transitions.has(key)) {
      transitions.set(key, api(`/api/walk/transition/${from.id}/${to.id}`).then((r) => (r.h || r.r ? r : null)).catch(() => null));
    }
    return transitions.get(key);
  }
  /** The transition to `to` if it comes within 1.2 s (usually it was asked ahead), else null. */
  const transitionSoon = (to) => (reduceMotion() ? Promise.resolve(null)
    : Promise.race([transitionTo(to), new Promise((r) => setTimeout(() => r(null), 1200))]));

  /** Yaw and pitch (°) in the next panorama that show what (yaw, pitch) showed in the current one, through rotation `r`. */
  function turnedView(r, yaw, pitch) {
    const [y, p] = [yaw, pitch].map((d) => (d * Math.PI) / 180);
    const v = [Math.cos(p) * Math.sin(y), Math.sin(p), Math.cos(p) * Math.cos(y)];
    const w = [0, 1, 2].map((i) => r[i * 3] * v[0] + r[i * 3 + 1] * v[1] + r[i * 3 + 2] * v[2]);
    return { yaw: (Math.atan2(w[0], w[2]) * 180) / Math.PI, pitch: (Math.asin(Math.max(-1, Math.min(1, w[1]))) * 180) / Math.PI };
  }

  /**
   * Moves the still of the old photo to where its content lies in the new one, while the new photo
   * comes from where it lay in the old: a morph along their common features. False when the
   * transform is implausible on this screen (then the usual zoom is used).
   */
  async function morphStill(node, h) {
    if (!node || node.tagName !== 'IMG' || flat.hidden || !flat.naturalWidth || !node.naturalWidth) return false;
    const M = unit(mul3(mul3(shown(flat), h), inv3(shown(node)) || [1, 0, 0, 0, 1, 0, 0, 0, 1]));
    const back = inv3(M);
    if (!back) return false;
    // The middle of the old picture must stay on screen and the scale between 1/4 and 4.
    const w = root.clientWidth; const hh = root.clientHeight;
    const [x, y, z] = [M[0] * w / 2 + M[1] * hh / 2 + M[2], M[3] * w / 2 + M[4] * hh / 2 + M[5], M[6] * w / 2 + M[7] * hh / 2 + M[8]];
    const scale = Math.sqrt(Math.abs(M[0] * M[4] - M[1] * M[3]));
    if (z <= 0 || x / z < -0.25 * w || x / z > 1.25 * w || y / z < -0.25 * hh || y / z > 1.25 * hh || scale < 0.25 || scale > 4) return false;
    const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const B = unit(back);
    node.style.transformOrigin = '0 0';
    flat.style.transformOrigin = '0 0';
    await frames(700, (t) => {
      node.style.transform = css3(lerp3(I, M, t));
      node.style.opacity = String(1 - t);
      flat.style.transform = css3(lerp3(B, I, t));
    });
    flat.style.transform = '';
    node.remove();
    return true;
  }

  /** A step along an arrow: turn towards it, then walk (between flat photos with depth, if they match). */
  async function step(link) {
    if (!W.data || W.stepping) return;
    W.stepping = true;
    try {
      const rel = norm(link.bearing - W.view);
      const back = link.direction === 'zurueck' || Math.abs(rel) > 110;
      // The transform is usually there already (asked ahead); a slow answer does not hold the step up.
      const t = await transitionSoon(link);
      if (!back && !reduceMotion() && W.data.photo.panorama && !canvas.hidden && pano?.ok) await turnTo(link.bearing);
      await go(link.id, { kind: back ? 'zurueck' : 'vor', rel: back ? 0 : norm(link.bearing - W.view), h: t?.h, r: t?.r });
    } finally {
      W.stepping = false;
    }
  }

  async function go(photoId, { dir = W.view, initial = false, kind = 'zeit', rel = 0, h = null, r = null } = {}) {
    const token = ++W.token;
    // Where one looks in the current panorama, to turn it into the next one with `r`.
    const before = W.data?.photo.panorama && !canvas.hidden && pano?.ok ? { yaw: pano.yaw, pitch: pano.pitch } : null;
    root.querySelectorAll('.walk-still').forEach((n) => n.remove());
    const cover = initial ? null : still();
    root.classList.add('loading');
    let data;
    try {
      const at = W.data && !initial && !W.data.photo.source ? `?at=${encodeURIComponent(W.data.photo.takenAt)}` : '';
      data = await api(isMapillary(photoId) ? `/api/walk/mapillary/${String(photoId).slice(1)}` : `/api/walk/${photoId}${at}`);
    } catch (err) {
      root.classList.remove('loading');
      cover?.remove();
      $('walk-hint').textContent = `Bild nicht verfügbar (${err.message})`;
      return;
    }
    if (token !== W.token) { cover?.remove(); return; }
    W.data = data;
    const p = data.photo;
    const mly = p.source === 'mapillary';
    $('walk-title').textContent = mly ? 'Mapillary' : `Spot ${p.spotId}`;
    $('walk-spot').hidden = mly;
    const credit = $('walk-credit');
    credit.hidden = !mly;
    if (mly) {
      credit.href = p.pageUrl;
      credit.textContent = `Bild: ${p.creator || 'unbekannt'} · Mapillary · ${p.license}`;
    }
    timeSel.replaceChildren(...data.times.map((t) => el('option', { value: String(t.id), text: `${fmtDate(t.takenAt)}${t.panorama ? ' · 360°' : ''}` })));
    timeSel.value = String(p.id);
    timeSel.closest('label').hidden = data.times.length < 2;
    const usePano = p.panorama && pano?.ok;
    canvas.hidden = !usePano;
    flat.hidden = usePano;
    if (usePano) {
      await pano.load(p.url).catch(() => {});
      if (token !== W.token) { cover?.remove(); return; }
      if (r && before && !initial) {
        // The same scenery as before the step, through the rotation between the two panoramas.
        const v = turnedView(r, before.yaw, before.pitch);
        pano.set(v);
        setView(((p.heading ?? 0) + v.yaw + 360) % 360, false);
      } else {
        // Keep looking the same way as before the step; the first picture looks along its own heading.
        setView(initial ? (p.heading ?? 0) : dir);
      }
    } else {
      flat.src = p.largeUrl || p.url;
      await flat.decode().catch(() => {});
      if (token !== W.token) { cover?.remove(); return; }
      setView(p.heading ?? (initial ? 0 : dir), false);
    }
    root.classList.remove('loading');
    renderMap();
    if (!(h && await morphStill(cover, h))) fadeStill(cover, kind, rel);
    history.replaceState(null, '', `#durchgehen=${p.id}`);
    // The next steps are fetched ahead: smoother, and available offline afterwards.
    for (const l of data.links) {
      const img = new Image();
      img.src = l.panorama ? l.url : (l.largeUrl || l.url);
      // Also how they lie in each other, for a step with depth.
      if (!reduceMotion()) transitionTo(l);
    }
  }

  /** The way closest to `rel` degrees from the view (0 = ahead, 180 = behind), if within 70°. */
  function wayTowards(rel) {
    let best = null;
    for (const l of W.data?.links || []) {
      const d = Math.abs(norm(l.bearing - W.view - rel));
      if (d <= 70 && (!best || d < best.d)) best = { d, l };
    }
    return best?.l || null;
  }

  function open(photoId) {
    if (!photoId) return;
    W.returnHash = location.hash.startsWith('#durchgehen=') ? '' : location.hash;
    W.open = true;
    W.data = null;
    root.hidden = false;
    document.documentElement.classList.add('walk-open');
    go(photoId, { initial: true });
    (pano?.ok ? canvas : root.querySelector('#walk-close')).focus();
  }
  function close() {
    if (!W.open) return;
    W.open = false;
    W.token++;
    root.hidden = true;
    document.documentElement.classList.remove('walk-open');
    const last = W.data?.photo;
    history.replaceState(null, '', W.returnHash || location.pathname + location.search);
    // Back in the app at the place one walked to (on a Mapillary picture: the map there).
    if (last?.source === 'mapillary') map.setView([last.lat, last.lon], Math.max(map.getZoom(), 17));
    else if (last && state.spot?.id !== last.spotId) openSpot(last.spotId, last.id).catch(() => {});
  }

  /* ---------- Input ---------- */

  $('walk-close').addEventListener('click', close);
  $('walk-spot').addEventListener('click', () => {
    const p = W.data?.photo;
    close();
    if (p) openSpot(p.spotId, p.id).then(() => $('explore').scrollIntoView({ behavior: 'smooth' })).catch(() => {});
  });
  // Another date at the same spot: aligned photos move into each other, panoramas keep looking at the same place.
  timeSel.addEventListener('change', async () => {
    const id = Number(timeSel.value);
    const to = W.data?.times.find((x) => x.id === id) || { id };
    const t = await transitionSoon(to);
    go(id, { h: t?.h, r: t?.r });
  });
  // On the document: after a step, the arrow that had the focus is gone.
  document.addEventListener('keydown', (e) => {
    if (!W.open || e.target === timeSel) return;
    const key = e.key.toLowerCase();
    let handled = true;
    if (key === 'escape') close();
    else if (key === 'arrowup' || key === 'w') { const l = wayTowards(0); if (l) step(l); }
    else if (key === 'arrowdown' || key === 's') { const l = wayTowards(180); if (l) step(l); }
    else if ((key === 'arrowleft' || key === 'a') && W.data?.photo.panorama) setView(W.view - 15);
    else if ((key === 'arrowright' || key === 'd') && W.data?.photo.panorama) setView(W.view + 15);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation(); // the panorama's own arrow keys turn and tilt
    }
  }, true);

  // Entry: the spot panel, and a link like …/#durchgehen=123.
  $('open-walk')?.addEventListener('click', () => {
    const p = state.spot?.photos?.[state.index];
    if (p) open(p.id);
  });
  const fromHash = () => {
    const m = location.hash.match(/^#durchgehen=(m?\d+)$/);
    if (m && !W.open) open(isMapillary(m[1]) ? m[1] : Number(m[1]));
  };
  window.addEventListener('hashchange', fromHash);
  fromHash();

  /* ---------- Mapillary on the map ---------- */

  // Pictures as small dots from zoom 17 (the search covers the middle of the map); a click starts walking there.
  const mlyLayer = L.layerGroup();
  let mlyOn = false;
  let mlyTimer = null;
  async function loadMapillary() {
    if (!mlyOn) return;
    const z = map.getZoom();
    const btn = $('mapillary-toggle');
    if (z < 17) {
      mlyLayer.clearLayers();
      btn.title = 'Zum Anzeigen näher heranzoomen';
      return;
    }
    const c = map.getCenter();
    const b = map.getBounds();
    const half = 0.0045; // the server searches at most 0.01° per side
    const box = [Math.max(b.getWest(), c.lng - half), Math.max(b.getSouth(), c.lat - half), Math.min(b.getEast(), c.lng + half), Math.min(b.getNorth(), c.lat + half)];
    const list = await api(`/api/mapillary/images?bbox=${box.map((v) => v.toFixed(5)).join(',')}`).catch(() => null);
    if (!list || !mlyOn) return;
    mlyLayer.clearLayers();
    btn.title = list.length ? `${list.length} Mapillary-Bilder im Kartenzentrum` : 'Keine Mapillary-Bilder im Kartenzentrum';
    for (const m of list) {
      L.circleMarker([m.lat, m.lon], { radius: m.panorama ? 5 : 4, className: `mapillary-dot${m.panorama ? ' pano' : ''}` })
        .bindTooltip(`Mapillary${m.panorama ? ' · 360°' : ''}${m.takenAt ? ` · ${fmtDate(m.takenAt)}` : ''}${m.creator ? ` · ${m.creator}` : ''}`)
        .on('click', () => open(m.id))
        .addTo(mlyLayer);
    }
  }
  (async function initMapillary() {
    while (!state.config.landscapes) await new Promise((r) => setTimeout(r, 50));
    if (!state.config.mapillary) return;
    const btn = $('mapillary-toggle');
    btn.hidden = false;
    btn.addEventListener('click', () => {
      mlyOn = !mlyOn;
      btn.setAttribute('aria-pressed', String(mlyOn));
      if (mlyOn) { mlyLayer.addTo(map); loadMapillary(); } else mlyLayer.remove();
    });
    map.on('moveend', () => { clearTimeout(mlyTimer); mlyTimer = setTimeout(loadMapillary, 300); });
  }());

  window.Walk = { open, close };
}());
