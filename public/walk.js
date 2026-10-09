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
 * API: GET /api/walk/:photoId (src/routes/walk.js).
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
      const b = el('button', {
        type: 'button',
        class: `walk-arrow ${l.kind}${Math.abs(rel) < 35 ? ' ahead' : ''}`,
        style: `--x:${(Math.sin(rad) * 46).toFixed(1)}%;--y:${(-ahead * 34).toFixed(1)}%;--r:${rel.toFixed(1)}deg;--s:${(0.8 + 0.25 * (ahead + 1) / 2).toFixed(2)}`,
        title: `${l.kind === 'weg' ? (l.direction === 'vor' ? 'Weiter auf der Aufnahme' : 'Zurück auf der Aufnahme') : `Spot ${l.spotId}`} · ${fmtDist(l.distanceM)} nach ${COMPASS_LONG[compass(l.bearing)]}${l.panorama ? ' · 360°' : ''}`,
        'aria-label': `${l.kind === 'weg' ? (l.direction === 'vor' ? 'Weiter' : 'Zurück') : `Zu Spot ${l.spotId}`}, ${fmtDist(l.distanceM)} nach ${COMPASS_LONG[compass(l.bearing)]}`,
        onclick: () => go(l.id),
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
    W.track = L.polyline([], { className: 'walk-track', weight: 4, interactive: false }).addTo(W.map);
    W.dots = L.layerGroup().addTo(W.map);
    W.marker = L.marker([0, 0], { icon: L.divIcon({ className: '', html: '<span class="walk-me"><i></i></span>', iconSize: [0, 0] }), interactive: false, keyboard: false }).addTo(W.map);
  }
  function renderMap() {
    ensureMap();
    const { photo, track, links } = W.data;
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

  async function go(photoId, { dir = W.view, initial = false } = {}) {
    const token = ++W.token;
    root.classList.add('loading');
    let data;
    try {
      const at = W.data && !initial ? `?at=${encodeURIComponent(W.data.photo.takenAt)}` : '';
      data = await api(`/api/walk/${photoId}${at}`);
    } catch (err) {
      root.classList.remove('loading');
      $('walk-hint').textContent = `Bild nicht verfügbar (${err.message})`;
      return;
    }
    if (token !== W.token) return;
    W.data = data;
    const p = data.photo;
    $('walk-title').textContent = `Spot ${p.spotId}`;
    timeSel.replaceChildren(...data.times.map((t) => el('option', { value: String(t.id), text: `${fmtDate(t.takenAt)}${t.panorama ? ' · 360°' : ''}` })));
    timeSel.value = String(p.id);
    timeSel.closest('label').hidden = data.times.length < 2;
    const usePano = p.panorama && pano?.ok;
    canvas.hidden = !usePano;
    flat.hidden = usePano;
    if (usePano) {
      await pano.load(p.url).catch(() => {});
      if (token !== W.token) return;
      // Keep looking the same way as before the step; the first picture looks along its own heading.
      setView(initial ? (p.heading ?? 0) : dir);
    } else {
      flat.src = p.largeUrl || p.url;
      setView(p.heading ?? (initial ? 0 : dir), false);
    }
    root.classList.remove('loading');
    renderMap();
    history.replaceState(null, '', `#durchgehen=${p.id}`);
    // The next steps are fetched ahead: smoother, and available offline afterwards.
    for (const l of data.links) {
      const img = new Image();
      img.src = l.panorama ? l.url : (l.largeUrl || l.url);
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
    // Back in the app at the place one walked to.
    if (last && state.spot?.id !== last.spotId) openSpot(last.spotId, last.id).catch(() => {});
  }

  /* ---------- Input ---------- */

  $('walk-close').addEventListener('click', close);
  $('walk-spot').addEventListener('click', () => {
    const p = W.data?.photo;
    close();
    if (p) openSpot(p.spotId, p.id).then(() => $('explore').scrollIntoView({ behavior: 'smooth' })).catch(() => {});
  });
  timeSel.addEventListener('change', () => go(Number(timeSel.value)));
  // On the document: after a step, the arrow that had the focus is gone.
  document.addEventListener('keydown', (e) => {
    if (!W.open || e.target === timeSel) return;
    const key = e.key.toLowerCase();
    let handled = true;
    if (key === 'escape') close();
    else if (key === 'arrowup' || key === 'w') { const l = wayTowards(0); if (l) go(l.id); }
    else if (key === 'arrowdown' || key === 's') { const l = wayTowards(180); if (l) go(l.id); }
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
    const m = location.hash.match(/^#durchgehen=(\d+)$/);
    if (m && !W.open) open(Number(m[1]));
  };
  window.addEventListener('hashchange', fromHash);
  fromHash();

  window.Walk = { open, close };
}());
