'use strict';

/*
 * "Touren & Aufträge" map mode:
 *  - Route: draw a tour by clicking waypoints (optionally along paths when the
 *    server has a routing service), record one with the phone's GPS, or import
 *    GPX/TCX/KML/GeoJSON. Kilometre marks, undo, round trip, GPX export, saving
 *    (with an account), and suggestions near the route: photo requests, spots
 *    with a satellite early warning and spots not visited for a year.
 *  - Offline: the map along a route and the spots on it can be saved on the
 *    device (offline-map.js) for areas without reception.
 *  - Meine Touren: saved tours; public tours of others can be shown on the map.
 *  - Aufträge: photo requests ("please photograph this place, looking east"),
 *    shown on the map for everyone; a photo nearby fulfils them.
 * The route under construction stays in this browser (localStorage) until it is
 * saved; suggestions are computed by the server without storing the route.
 * Relies on globals from app.js (map, state, api, el, $, openSpot, distanceM,
 * fmtDate, setPicked) and account.js (Account).
 */
(function toursMode() {
  const STORE = 'myforrest.route.v1';
  const RECORDING = 'myforrest.recording.v1';
  const COMPASS = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
  const COMPASS_LONG = { N: 'Norden', NO: 'Nordosten', O: 'Osten', SO: 'Südosten', S: 'Süden', SW: 'Südwesten', W: 'Westen', NW: 'Nordwesten' };
  const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
  const KIND_LABEL = { auftrag: 'Fotoauftrag', satellit: 'Satellit', lange_nicht: 'Lange nicht besucht' };
  const TOUR_KIND = { gezeichnet: 'geplant', aufgezeichnet: 'aufgezeichnet', importiert: 'importiert' };
  const fmtKm = (m) => (m / 1000).toLocaleString('de-CH', { minimumFractionDigits: m < 100000 ? 2 : 1, maximumFractionDigits: m < 100000 ? 2 : 1 });
  const json = (url, body, method = 'POST') => api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  const T = {
    open: false,
    tab: 'route',
    drawing: true, // clicks on the map add waypoints while the route tab is open
    follow: true, // "Magnet": follow paths whenever the server has a routing service
    route: emptyRoute(),
    requests: [],
    suggestions: [],
    maxDistanceM: 150,
    picking: false, // choosing the place of a new request
    draft: null, // { lat, lon, spotId } of the request being written
    uploadRequest: null, // request the next upload answers
    keepUploadRequest: false,
    recorder: null,
    showPublic: false,
    publicTours: [],
    trackCache: new Map(),
  };
  function emptyRoute() {
    return { waypoints: [], segments: [], raw: null, kind: 'gezeichnet', name: '', savedId: null, hasTime: false };
  }

  const routeLayer = L.layerGroup();
  const markLayer = L.layerGroup();
  const suggestionLayer = L.layerGroup();
  const requestLayer = L.layerGroup().addTo(map);
  const publicLayer = L.layerGroup();
  const hoverLayer = L.layerGroup();

  /* ---------- Route geometry ---------- */

  const ll = (p) => [p.lat, p.lon];
  function routePoints(r = T.route) {
    if (r.raw) return r.raw;
    if (!r.waypoints.length) return [];
    const out = [r.waypoints[0]];
    r.segments.forEach((seg) => out.push(...seg.slice(1)));
    return out;
  }
  function cumulative(points) {
    const cum = [0];
    for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + distanceM(points[i - 1], points[i]));
    return cum;
  }
  const routeLength = (points = routePoints()) => cumulative(points).at(-1) || 0;

  /** Points every `step` metres along the route: [{ lat, lon, km }]. */
  function marksEvery(points, step) {
    const cum = cumulative(points);
    const out = [];
    let next = step;
    for (let i = 1; i < points.length && next <= cum.at(-1); i++) {
      while (next <= cum[i]) {
        const f = (next - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
        const a = points[i - 1];
        const b = points[i];
        out.push({ lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f, km: Math.round(next / 1000) });
        next += step;
      }
    }
    return out;
  }

  async function segmentBetween(a, b) {
    if (!T.follow || !state.config.routing) return [a, b];
    try {
      const r = await api(`/api/route?points=${a.lat},${a.lon};${b.lat},${b.lon}`);
      return [a, ...r.points.slice(1, -1), b];
    } catch (err) {
      setStatus(`Routing nicht möglich (${err.message}) – gerade Linie gezeichnet.`);
      return [a, b];
    }
  }

  /* ---------- Editing ---------- */

  async function addWaypoint(p) {
    const r = T.route;
    if (r.raw) return; // recorded or imported tours are not edited point by point
    r.savedId = null;
    r.waypoints.push(p);
    if (r.waypoints.length > 1) r.segments.push(await segmentBetween(r.waypoints.at(-2), p));
    changed();
  }
  async function moveWaypoint(i, p) {
    const r = T.route;
    r.waypoints[i] = p;
    if (i > 0) r.segments[i - 1] = await segmentBetween(r.waypoints[i - 1], p);
    if (i < r.waypoints.length - 1) r.segments[i] = await segmentBetween(p, r.waypoints[i + 1]);
    r.savedId = null;
    changed();
  }
  function undo() {
    const r = T.route;
    if (r.raw) return clearRoute();
    r.waypoints.pop();
    r.segments.pop();
    changed();
  }
  function clearRoute() {
    if (routePoints().length > 1 && !T.route.savedId && !confirm('Aktuelle Route verwerfen?')) return;
    T.route = emptyRoute();
    changed();
  }
  const roundTrip = () => T.route.waypoints.length > 1 && addWaypoint({ ...T.route.waypoints[0] });

  function setRoute(r, { fit = true } = {}) {
    T.route = { ...emptyRoute(), ...r };
    changed();
    const pts = routePoints();
    if (fit && pts.length > 1) map.fitBounds(L.latLngBounds(pts.map(ll)), { padding: [60, 60] });
  }

  function changed() {
    try { localStorage.setItem(STORE, JSON.stringify(T.route)); } catch { /* private mode */ }
    drawRoute();
    renderRoute();
    scheduleSuggestions();
  }

  /* ---------- Drawing on the map ---------- */

  const dot = (cls) => L.divIcon({ className: '', html: `<span class="wp ${cls}"></span>`, iconSize: [14, 14], iconAnchor: [7, 7] });

  function drawRoute() {
    routeLayer.clearLayers();
    markLayer.clearLayers();
    const pts = routePoints();
    if (pts.length > 1) {
      L.polyline(pts.map(ll), { color: '#fff', weight: 7, opacity: 0.7, interactive: false }).addTo(routeLayer);
      L.polyline(pts.map(ll), { className: 'route-line', weight: 4, opacity: 0.9, interactive: false }).addTo(routeLayer);
    }
    const r = T.route;
    if (r.raw) {
      if (pts.length) {
        L.marker(ll(pts[0]), { icon: dot('start'), keyboard: false, interactive: false }).addTo(routeLayer);
        L.marker(ll(pts.at(-1)), { icon: dot('end'), keyboard: false, interactive: false }).addTo(routeLayer);
      }
    } else {
      r.waypoints.forEach((w, i) => {
        const cls = i === 0 ? 'start' : i === r.waypoints.length - 1 ? 'end' : '';
        const m = L.marker(ll(w), { icon: dot(cls), draggable: true, keyboard: false, title: `Wegpunkt ${i + 1} – ziehen zum Verschieben` });
        m.on('dragend', () => { const p = m.getLatLng(); moveWaypoint(i, { lat: p.lat, lon: p.lng }); });
        m.addTo(routeLayer);
      });
    }
    drawMarks();
  }

  function drawMarks() {
    markLayer.clearLayers();
    const pts = routePoints();
    const len = routeLength(pts);
    if (len < 1000) return;
    // About one mark per 80 px.
    const mPerPx = (40075016.686 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / 2 ** (map.getZoom() + 8);
    const step = [1, 2, 5, 10, 20, 50, 100].find((k) => (k * 1000) / mPerPx >= 80) || 100;
    for (const m of marksEvery(pts, step * 1000)) {
      L.marker([m.lat, m.lon], {
        icon: L.divIcon({ className: '', html: `<span class="km-mark">${m.km}</span>`, iconSize: null, iconAnchor: [10, 9] }),
        keyboard: false, interactive: false,
      }).addTo(markLayer);
    }
  }
  map.on('zoomend', () => { if (T.open || routePoints().length) drawMarks(); });

  map.on('click', (e) => {
    if (!T.open || !$('pick-hint').hidden) return;
    const p = { lat: e.latlng.lat, lon: e.latlng.lng };
    if (T.picking) {
      T.picking = false;
      map.getContainer().classList.remove('tour-drawing');
      T.draft = { ...p, spotId: null };
      setTab('auftraege');
      return;
    }
    if (T.tab === 'route' && T.drawing && !T.recorder && !T.route.raw) addWaypoint(p);
  });

  /* ---------- Recording with GPS ---------- */

  async function startRecording() {
    if (!navigator.geolocation) return setStatus('Dieses Gerät kann keinen Standort liefern.');
    const points = loadRecording(); // continues an interrupted recording
    if (!points.length && routePoints().length > 1 && !T.route.savedId && !confirm('Die aktuelle Route wird ersetzt. Aufzeichnung starten?')) return;
    T.route = { ...emptyRoute(), raw: points, kind: 'aufgezeichnet', hasTime: true, name: `Aufzeichnung ${fmtDate(new Date().toISOString())}` };
    const rec = { points, started: points[0]?.time || Date.now(), watch: null, wake: null, timer: null, here: null };
    T.recorder = rec;
    rec.watch = navigator.geolocation.watchPosition((pos) => {
      const c = pos.coords;
      if (c.accuracy > 40) return setStatus(`Warte auf genaueres GPS (±${Math.round(c.accuracy)} m) …`);
      const p = { lat: c.latitude, lon: c.longitude, time: pos.timestamp };
      if (Number.isFinite(c.altitude)) p.ele = Math.round(c.altitude * 10) / 10;
      const last = rec.points.at(-1);
      if (!last || distanceM(last, p) >= Math.max(4, c.accuracy / 2)) {
        rec.points.push(p);
        try { localStorage.setItem(RECORDING, JSON.stringify(rec.points)); } catch { /* full */ }
        changed();
      }
      if (rec.here) rec.here.setLatLng(ll(p));
      else rec.here = L.circleMarker(ll(p), { radius: 7, className: 'gps-here', interactive: false }).addTo(routeLayer);
      setStatus(`Aufnahme läuft · GPS ±${Math.round(c.accuracy)} m`);
    }, (err) => setStatus(`GPS: ${err.message}`), { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
    // Keep the screen on while recording; browsers stop GPS for pages in the background.
    try { rec.wake = await navigator.wakeLock?.request('screen'); } catch { /* not allowed */ }
    rec.timer = setInterval(renderRoute, 1000);
    changed();
  }
  function loadRecording() {
    try { return JSON.parse(localStorage.getItem(RECORDING)) || []; } catch { return []; }
  }
  function stopRecording() {
    const rec = T.recorder;
    if (!rec) return;
    navigator.geolocation.clearWatch(rec.watch);
    clearInterval(rec.timer);
    rec.wake?.release?.();
    T.recorder = null;
    try { localStorage.removeItem(RECORDING); } catch { /* ignore */ }
    setStatus(rec.points.length > 1 ? 'Aufzeichnung beendet – jetzt speichern oder als GPX exportieren.' : 'Zu wenige Punkte aufgezeichnet.');
    changed();
  }

  /* ---------- Import and export ---------- */

  async function importFile(file) {
    if (!file) return;
    if (file.size > 14 * 1024 * 1024) return setStatus('Datei zu gross (max. 14 MB).');
    setStatus(`Lese ${file.name} …`);
    try {
      const t = await json('/api/tracks/parse', { text: await file.text(), filename: file.name });
      setRoute({ raw: t.points, kind: 'importiert', name: t.name || file.name, hasTime: t.hasTime });
      setStatus(`${t.points.length} Punkte importiert (${t.format.toUpperCase()}${t.hasTime ? ', mit Zeitstempeln' : ''}).`);
    } catch (err) {
      setStatus(err.message);
    }
  }

  function gpxOf(points, name) {
    const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
    const pts = points.map((p) => `<trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">${Number.isFinite(p.ele) ? `<ele>${p.ele}</ele>` : ''}${Number.isFinite(p.time) ? `<time>${new Date(p.time).toISOString()}</time>` : ''}</trkpt>`);
    return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="MyForrest" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${esc(name || 'Tour')}</name><trkseg>\n${pts.join('\n')}\n</trkseg></trk></gpx>\n`;
  }
  function exportGpx() {
    const pts = routePoints();
    if (pts.length < 2) return;
    const a = el('a', { href: URL.createObjectURL(new Blob([gpxOf(pts, T.route.name)], { type: 'application/gpx+xml' })), download: `${(T.route.name || 'tour').replace(/[^\wäöüÄÖÜ -]/g, '')}.gpx` });
    document.body.append(a);
    a.click();
    a.remove();
  }

  async function saveRoute() {
    const pts = routePoints();
    if (pts.length < 2) return;
    if (!Account.user) return setStatus('Zum Speichern bitte oben rechts anmelden. Bis dahin bleibt die Route in diesem Browser.');
    try {
      const t = await json('/api/tracks', {
        name: $('tour-name').value.trim() || T.route.name || 'Tour',
        kind: T.route.kind,
        activity: $('tour-activity').value || null,
        visibility: $('tour-public').checked ? 'oeffentlich' : 'privat',
        points: pts.map((p) => [p.lat, p.lon, p.ele ?? null, p.time ?? null]),
      });
      T.route.savedId = t.id;
      T.route.name = t.name;
      changed();
      setStatus(`Gespeichert als «${t.name}»${t.visibility === 'oeffentlich' ? ' (öffentlich)' : ' (privat)'}.`);
    } catch (err) {
      setStatus(err.message);
    }
  }

  /* ---------- Suggestions along the route ---------- */

  let suggestTimer = null;
  function scheduleSuggestions() {
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(loadSuggestions, 500);
  }
  async function loadSuggestions() {
    let pts = routePoints();
    if (pts.length < 2) {
      T.suggestions = [];
      return renderSuggestions();
    }
    // Every n-th point is plenty for distances of 50 m and more.
    if (pts.length > 4000) pts = pts.filter((_, i) => i % Math.ceil(pts.length / 4000) === 0 || i === pts.length - 1);
    try {
      const r = await json('/api/route-suggestions', { points: pts.map((p) => [p.lat, p.lon]), maxDistanceM: T.maxDistanceM });
      T.suggestions = r.suggestions;
    } catch {
      T.suggestions = [];
    }
    renderSuggestions();
  }

  function renderSuggestions() {
    suggestionLayer.clearLayers();
    const box = $('tour-suggestions');
    if (!box) return;
    if (routePoints().length < 2) {
      box.replaceChildren(el('p', { class: 'muted small', text: 'Sobald eine Route steht, erscheinen hier Fotoaufträge und Spots, die einen Besuch lohnen.' }));
      return;
    }
    if (!T.suggestions.length) {
      box.replaceChildren(el('p', { class: 'muted small', text: `Nichts innerhalb von ${T.maxDistanceM} m der Route.` }));
      return;
    }
    T.suggestions.forEach((s, i) => {
      L.marker([s.lat, s.lon], {
        icon: L.divIcon({ className: '', html: `<span class="sug-badge ${s.kind}">${i + 1}</span>`, iconSize: [22, 22], iconAnchor: [11, 30] }),
        zIndexOffset: 900, keyboard: false,
      }).bindTooltip(`${s.title}`).on('click', () => focusSuggestion(s)).addTo(suggestionLayer);
    });
    box.replaceChildren(el('ol', { class: 'sug-list' }, T.suggestions.map((s, i) => el('li', {}, [
      el('button', { type: 'button', class: 'sug-item', onclick: () => focusSuggestion(s) }, [
        el('span', { class: `sug-badge ${s.kind}`, text: String(i + 1) }),
        el('span', { class: 'sug-text' }, [
          el('strong', { text: s.title }),
          el('span', { class: 'muted small', text: [KIND_LABEL[s.kind], `km ${fmtKm(s.alongM)}`, `${s.distanceM} m neben der Route`,
            s.heading !== null && s.heading !== undefined ? `Blick nach ${COMPASS_LONG[compass(s.heading)]}` : null].filter(Boolean).join(' · ') }),
          s.text ? el('span', { class: 'small', text: s.text }) : '',
        ]),
      ]),
    ]))));
  }

  function focusSuggestion(s) {
    map.setView([s.lat, s.lon], Math.max(map.getZoom(), 16));
    if (s.spotId && s.kind !== 'auftrag') openSpot(s.spotId);
    else if (s.requestId) requestMarkers.get(s.requestId)?.openPopup();
  }

  /* ---------- Photo requests ---------- */

  const requestMarkers = new Map();
  async function loadRequests() {
    try { T.requests = await api('/api/photo-requests'); } catch { T.requests = []; }
    drawRequests();
    if (T.tab === 'auftraege') renderRequests();
  }

  function requestPopup(r) {
    const dir = r.heading !== null ? `Blick nach ${COMPASS_LONG[compass(r.heading)]} (${Math.round(r.heading)}°)` : 'Blickrichtung frei';
    return el('div', { class: 'req-popup' }, [
      el('p', { class: 'eyebrow', text: r.protected ? 'Fotoauftrag · nur PRO' : 'Fotoauftrag' }),
      el('strong', { text: r.title }),
      r.note ? el('p', { class: 'small', text: r.note }) : '',
      el('p', { class: 'muted small', text: `${dir} · seit ${fmtDate(r.createdAt)}${r.spotId ? ` · Spot ${r.spotId}` : ''}` }),
      el('div', { class: 'req-actions' }, [
        el('button', { type: 'button', class: 'btn primary', text: 'Foto dafür hochladen', onclick: () => uploadFor(r) }),
        r.spotId ? el('button', { type: 'button', class: 'secondary', text: 'Spot öffnen', onclick: () => openSpot(r.spotId) }) : '',
        r.own ? el('button', { type: 'button', class: 'link small', text: 'Zurückziehen', onclick: () => withdraw(r) }) : '',
      ]),
    ]);
  }

  function drawRequests() {
    requestLayer.clearLayers();
    requestMarkers.clear();
    for (const r of T.requests) {
      const rot = r.heading !== null ? `<i class="req-dir" style="--h:${r.heading}deg"></i>` : '';
      const m = L.marker([r.lat, r.lon], {
        // A request for a spot sits beside the spot's pin, not on top of it.
        icon: L.divIcon({ className: 'req-icon', html: `${rot}<span class="req-pin" aria-hidden="true"></span>`, iconSize: [26, 26], iconAnchor: r.spotId ? [-10, 38] : [13, 13] }),
        title: `Fotoauftrag: ${r.title}`,
      }).bindPopup(() => requestPopup(r), { maxWidth: 280 });
      m.addTo(requestLayer);
      requestMarkers.set(r.id, m);
    }
  }

  async function withdraw(r) {
    if (!confirm(`Auftrag «${r.title}» zurückziehen?`)) return;
    try {
      await api(`/api/photo-requests/${r.id}`, { method: 'DELETE' });
      map.closePopup();
      await loadRequests();
    } catch (err) {
      alert(err.message);
    }
  }

  function uploadFor(r) {
    map.closePopup();
    T.uploadRequest = r;
    T.keepUploadRequest = true;
    $('open-upload').click();
    // The place of the request is the fallback position for photos without GPS.
    setPicked(L.latLng(r.lat, r.lon));
  }

  function renderRequests() {
    const box = $('tour-requests');
    const center = map.getCenter();
    const here = { lat: center.lat, lon: center.lng };
    const list = [...T.requests].sort((a, b) => distanceM(here, a) - distanceM(here, b));
    const items = [];
    if (T.draft) {
      const d = T.draft;
      items.push(el('form', { class: 'req-form', id: 'req-form' }, [
        el('p', { class: 'eyebrow', text: d.spotId ? `Neuer Auftrag für Spot ${d.spotId}` : 'Neuer Fotoauftrag' }),
        el('p', { class: 'muted small', text: `${d.lat.toFixed(5)}, ${d.lon.toFixed(5)} · keine Zeit, kein Name: nur Ort, Richtung und Text werden gezeigt.` }),
        el('label', { for: 'req-title', text: 'Was soll fotografiert werden?' }),
        el('input', { id: 'req-title', maxlength: '120', required: '', placeholder: 'z. B. Bachufer mit Springkraut' }),
        el('label', { for: 'req-note', text: 'Hinweis (optional)' }),
        el('textarea', { id: 'req-note', rows: '2', maxlength: '1000', placeholder: 'z. B. vom Brückengeländer aus, Richtung Wald' }),
        ...(Account.user && (Account.user.pro || ['moderator', 'admin'].includes(Account.user.role)) ? [
          el('label', { class: 'toggle small' }, [el('input', { type: 'checkbox', id: 'req-protected' }), ' Nur für PRO-Mitglieder (geschützter Fund)']),
        ] : []),
        el('label', { for: 'req-dir', text: 'Blickrichtung' }),
        el('select', { id: 'req-dir' }, [el('option', { value: '', text: d.spotId ? 'wie die bisherigen Fotos' : 'frei' }),
          ...COMPASS.map((c, i) => el('option', { value: String(i * 45), text: `nach ${COMPASS_LONG[c]}` }))]),
        el('div', { class: 'req-actions' }, [
          el('button', { type: 'submit', class: 'btn primary', text: 'Auftrag erstellen' }),
          el('button', { type: 'button', class: 'link small', text: 'Abbrechen', onclick: () => { T.draft = null; renderRequests(); } }),
        ]),
      ]));
    } else {
      items.push(el('button', { type: 'button', class: 'btn primary wide', id: 'req-new', text: 'Neuer Fotoauftrag: Ort auf der Karte wählen', onclick: startRequestPick }));
    }
    items.push(el('h3', { class: 'label', text: `Offene Aufträge (${list.length})` }));
    if (!list.length) items.push(el('p', { class: 'muted small', text: 'Noch keine offenen Aufträge.' }));
    items.push(el('ul', { class: 'req-list' }, list.slice(0, 60).map((r) => el('li', {}, [
      el('button', { type: 'button', class: 'sug-item', onclick: () => { map.setView([r.lat, r.lon], Math.max(map.getZoom(), 16)); requestMarkers.get(r.id)?.openPopup(); } }, [
        el('span', { class: 'req-pin small', 'aria-hidden': 'true' }),
        el('span', { class: 'sug-text' }, [
          el('strong', { text: r.title }),
          el('span', { class: 'muted small', text: [`${(distanceM(here, r) / 1000).toLocaleString('de-CH', { maximumFractionDigits: 1 })} km von der Kartenmitte`,
            r.heading !== null ? `nach ${COMPASS_LONG[compass(r.heading)]}` : null, r.own ? 'dein Auftrag' : null].filter(Boolean).join(' · ') }),
        ]),
      ]),
    ]))));
    box.replaceChildren(...items);
    $('req-form')?.addEventListener('submit', createRequest);
    $('req-title')?.focus();
  }

  function startRequestPick() {
    T.picking = true;
    map.getContainer().classList.add('tour-drawing');
    setStatus('Klicke auf die Karte, wo das Foto entstehen soll.', 'auftraege');
  }

  async function createRequest(e) {
    e.preventDefault();
    const d = T.draft;
    try {
      await json('/api/photo-requests', {
        lat: d.lat, lon: d.lon, spotId: d.spotId, title: $('req-title').value, note: $('req-note').value,
        heading: $('req-dir').value === '' ? null : Number($('req-dir').value),
        protected: Boolean($('req-protected')?.checked),
      });
      T.draft = null;
      await loadRequests();
      renderRequests();
      setStatus('Auftrag erstellt. Wer eine Route in der Nähe plant, sieht ihn jetzt als Vorschlag.', 'auftraege');
    } catch (err) {
      setStatus(err.message, 'auftraege');
    }
  }

  /* ---------- Saved and public tours ---------- */

  async function trackPoints(id) {
    if (!T.trackCache.has(id)) T.trackCache.set(id, await api(`/api/tracks/${id}`));
    return T.trackCache.get(id);
  }

  /* ---------- Offline along a route (offline-map.js) ---------- */

  const fmtMb = (b) => (b < 1e5 ? `${Math.max(1, Math.round(b / 1e3))} kB` : `${(b / 1e6).toLocaleString('de-CH', { maximumFractionDigits: 1 })} MB`);

  /** Saves the map and spots along `points` on this device, with progress in the route tab. */
  async function saveOffline(points, name) {
    const om = window.offlineMap;
    if (!om?.supported()) return setStatus('Dieser Browser kann keine Karten offline speichern.');
    if (points.length < 2) return;
    const plan = om.plan(points);
    if (plan.tooLong) {
      return setStatus(`Die Route ist zu lang, um sie offline zu speichern (höchstens ${om.MAX_TILES} Kartenkacheln). Teile sie in kürzere Abschnitte.`);
    }
    const near = om.spotsNear(points, state.spots || []);
    if (!confirm(`Karte entlang der Route offline speichern?\n${plan.tiles.length} Kartenkacheln bis Zoomstufe ${plan.maxZoom}, ${near.length} Spot${near.length === 1 ? '' : 's'} mit Fotos.`)) return;
    setTab('route');
    $('tour-offline-save').disabled = true;
    try {
      const meta = await om.save(name, points, state.spots || [], (p) => setStatus(`Offline speichern … ${Math.round((p.n / p.total) * 100)} % (${fmtMb(p.bytes)})`));
      setStatus(`Offline gespeichert: ${meta.tiles} Kartenkacheln, ${meta.spots} Spot${meta.spots === 1 ? '' : 's'}, ${fmtMb(meta.bytes)}${meta.failed ? ` (${meta.failed} nicht erreichbar)` : ''}.`);
    } catch (err) {
      setStatus(`Offline speichern fehlgeschlagen: ${err.message}`);
    }
    renderOffline();
  }

  async function renderOffline() {
    const box = $('tour-offline');
    const om = window.offlineMap;
    const pts = routePoints();
    $('tour-offline-save').disabled = !om?.supported() || pts.length < 2;
    const saved = om?.supported() ? await om.list().catch(() => []) : [];
    box.replaceChildren(...(saved.length ? [el('ul', { class: 'tour-list' }, saved.map((m) => el('li', {}, [
      el('div', { class: 'tour-row' }, [
        el('strong', { text: m.name }),
        el('span', { class: 'muted small', text: [fmtDate(m.savedAt), `${m.tiles} Kacheln bis Zoom ${m.maxZoom}`, `${m.spots} Spot${m.spots === 1 ? '' : 's'}`, fmtMb(m.bytes)].join(' · ') }),
      ]),
      el('div', { class: 'tour-actions' }, [
        el('button', { type: 'button', class: 'link small', text: 'Auf der Karte', onclick: () => map.fitBounds(m.bounds, { padding: [30, 30] }) }),
        el('button', { type: 'button', class: 'link small danger', text: 'Löschen', onclick: async () => {
          if (!confirm(`Offline-Karte «${m.name}» von diesem Gerät löschen?`)) return;
          await om.remove(m.id);
          renderOffline();
        } }),
      ]),
    ])))] : [el('p', { class: 'muted small', text: 'Noch nichts offline gespeichert.' })]));
  }

  async function renderMine() {
    const box = $('tour-mine');
    if (!Account.user) {
      box.replaceChildren(el('p', { class: 'muted small', text: 'Mit einem Konto lassen sich Touren speichern, auf allen Geräten öffnen und auf Wunsch veröffentlichen. Ohne Konto bleibt die aktuelle Route nur in diesem Browser.' }));
      return;
    }
    let tours = [];
    try { tours = await api('/api/tracks?mine=1'); } catch (err) { return box.replaceChildren(el('p', { class: 'err', text: err.message })); }
    if (!tours.length) return box.replaceChildren(el('p', { class: 'muted small', text: 'Noch keine gespeicherten Touren.' }));
    box.replaceChildren(el('ul', { class: 'tour-list' }, tours.map((t) => el('li', {}, [
      el('div', { class: 'tour-row' }, [
        el('strong', { text: t.name }),
        el('span', { class: 'muted small', text: [`${fmtKm(t.distanceM)} km`, TOUR_KIND[t.kind], t.startedAt ? fmtDate(t.startedAt) : fmtDate(t.createdAt),
          t.visibility === 'oeffentlich' ? 'öffentlich' : 'privat'].join(' · ') }),
      ]),
      el('div', { class: 'tour-actions' }, [
        el('button', { type: 'button', class: 'secondary', text: 'Anzeigen', onclick: async () => {
          T.trackCache.delete(t.id);
          const full = await trackPoints(t.id);
          setRoute({ raw: full.points, kind: t.kind, name: t.name, savedId: t.id, hasTime: t.hasTime });
          setTab('route');
        } }),
        el('a', { class: 'link small', href: `/api/tracks/${t.id}.gpx`, text: 'GPX' }),
        el('button', { type: 'button', class: 'link small', text: 'Offline speichern', onclick: async () => {
          const full = await trackPoints(t.id);
          saveOffline(full.points, t.name);
        } }),
        el('button', { type: 'button', class: 'link small', text: t.visibility === 'oeffentlich' ? 'privat machen' : 'veröffentlichen', onclick: async () => {
          await json(`/api/tracks/${t.id}`, { visibility: t.visibility === 'oeffentlich' ? 'privat' : 'oeffentlich' }, 'PATCH');
          renderMine();
          if (T.showPublic) loadPublic();
        } }),
        t.hasTime ? el('button', { type: 'button', class: 'link small', text: 'Fotos zuordnen', onclick: () => {
          T.uploadTour = t.id;
          $('open-upload').click();
        } }) : '',
        el('button', { type: 'button', class: 'link small danger', text: 'Löschen', onclick: async () => {
          if (!confirm(`Tour «${t.name}» löschen?`)) return;
          await api(`/api/tracks/${t.id}`, { method: 'DELETE' });
          renderMine();
        } }),
      ]),
    ]))));
  }

  async function loadPublic() {
    publicLayer.clearLayers();
    if (!T.showPublic) return publicLayer.remove();
    publicLayer.addTo(map);
    try { T.publicTours = await api('/api/tracks'); } catch { T.publicTours = []; }
    for (const t of T.publicTours) {
      const m = L.marker([t.start.lat, t.start.lon], {
        icon: L.divIcon({ className: '', html: '<span class="tour-pin" aria-hidden="true"></span>', iconSize: [22, 22], iconAnchor: [11, 22] }),
        title: `${t.name} · ${fmtKm(t.distanceM)} km${t.owner ? ` · ${t.owner}` : ''}`,
      });
      const show = async () => {
        const full = await trackPoints(t.id);
        hoverLayer.clearLayers();
        if (full.points.length > 1) L.polyline(full.points.map(ll), { className: 'public-line', weight: 4, interactive: false }).addTo(hoverLayer);
      };
      m.on('mouseover', show).on('mouseout', () => hoverLayer.clearLayers());
      m.on('click', async () => {
        const full = await trackPoints(t.id);
        setRoute({ raw: full.points, kind: t.kind, name: t.name, savedId: t.own ? t.id : null });
        if (!T.open) toggle(true);
        setTab('route');
      });
      m.addTo(publicLayer);
    }
    hoverLayer.addTo(map);
  }

  /* ---------- Upload integration (called from app.js) ---------- */

  function decorateUploadDialog() {
    const gpx = $('upload-form').gpx?.closest('.dropzone');
    if (!gpx || $('upload-tour')) return;
    gpx.after(el('div', { class: 'upload-tour' }, [
      el('label', { for: 'upload-tour', text: 'oder Fotos über eine Tour verorten' }),
      el('select', { id: 'upload-tour' }),
    ]));
    gpx.parentElement.prepend(el('p', { id: 'upload-request', class: 'upload-request', hidden: '' }));
  }

  async function fillTourSelect() {
    const sel = $('upload-tour');
    if (!sel) return;
    const opts = [el('option', { value: '', text: '– keine –' })];
    const pts = routePoints();
    if (pts.length > 1 && pts.some((p) => Number.isFinite(p.time))) opts.push(el('option', { value: 'current', text: `Aktuelle Route (${T.route.name || 'ohne Namen'})` }));
    if (Account.user) {
      try {
        for (const t of (await api('/api/tracks?mine=1')).filter((x) => x.hasTime)) {
          opts.push(el('option', { value: String(t.id), text: `${t.name} · ${fmtDate(t.startedAt)} · ${fmtKm(t.distanceM)} km` }));
        }
      } catch { /* offline */ }
    }
    sel.replaceChildren(...opts);
    sel.closest('.upload-tour').hidden = opts.length === 1;
    if (T.uploadTour) sel.value = String(T.uploadTour);
    T.uploadTour = null;
  }

  $('open-upload').addEventListener('click', () => {
    decorateUploadDialog();
    if (!T.keepUploadRequest) T.uploadRequest = null;
    T.keepUploadRequest = false;
    const note = $('upload-request');
    note.hidden = !T.uploadRequest;
    note.textContent = T.uploadRequest ? `Foto für den Auftrag «${T.uploadRequest.title}». Fotos mit GPS in der Nähe erledigen ihn.` : '';
    fillTourSelect();
  });

  const Tours = {
    /** Adds the GPX of a chosen tour and the answered request to an upload batch. */
    async decorateUpload(fd) {
      if (T.uploadRequest) fd.append('requestId', String(T.uploadRequest.id));
      const choice = $('upload-tour')?.value;
      if (!choice || fd.has('gpx')) return;
      const pts = choice === 'current' ? routePoints() : (await trackPoints(Number(choice))).points;
      fd.append('gpx', new Blob([gpxOf(pts, 'Tour')], { type: 'application/gpx+xml' }), 'tour.gpx');
    },
    /** Message line for requests the upload fulfilled. */
    afterUpload(requestsDone) {
      if (!requestsDone.length) return null;
      loadRequests();
      if (T.route && routePoints().length > 1) scheduleSuggestions();
      return `${requestsDone.length === 1 ? 'Ein Fotoauftrag ist' : `${requestsDone.length} Fotoaufträge sind`} damit erledigt – danke!`;
    },
    /** "Please photograph this spot again": opens the request form for a spot. */
    requestForSpot(spot) {
      T.draft = { lat: spot.lat, lon: spot.lon, spotId: spot.id };
      if (!T.open) toggle(true);
      setTab('auftraege');
    },
  };
  window.Tours = Tours;

  /* ---------- Panel ---------- */

  function setStatus(text, tab = 'route') {
    const s = $(tab === 'route' ? 'tour-status' : 'req-status');
    if (s) s.textContent = text || '';
  }

  function buildPanel() {
    const panel = $('tourpanel');
    const tabBtn = (id, text) => el('button', { type: 'button', role: 'tab', 'data-tab': id, 'aria-selected': String(T.tab === id), text });
    panel.append(
      el('header', { class: 'sun-head' }, [
        el('div', {}, [
          el('p', { class: 'eyebrow', text: 'Touren & Aufträge' }),
          el('h2', { id: 'tour-title', text: 'Unterwegs im Wald' }),
          el('p', { class: 'muted small', text: 'Route planen, aufzeichnen oder importieren – und sehen, wo unterwegs ein Foto gebraucht wird.' }),
        ]),
        el('button', { type: 'button', id: 'tour-close', class: 'icon', 'aria-label': 'Schliessen', text: '×' }),
      ]),
      el('div', { class: 'sp-tabs', role: 'tablist', 'aria-label': 'Ansicht' }, [
        tabBtn('route', 'Route'), tabBtn('touren', 'Meine Touren'), tabBtn('auftraege', 'Aufträge'),
      ]),
      el('section', { id: 'tour-route' }, [
        el('div', { class: 'tour-km' }, [el('output', { id: 'tour-distance', text: '0.00' }), el('span', { text: 'km' }), el('span', { id: 'tour-meta', class: 'muted small' })]),
        el('div', { class: 'tour-modes', role: 'group', 'aria-label': 'Route erfassen' }, [
          el('button', { type: 'button', id: 'tour-draw', class: 'secondary', 'aria-pressed': 'true', text: 'Zeichnen' }),
          el('button', { type: 'button', id: 'tour-record', class: 'secondary', text: 'Aufzeichnen' }),
          el('button', { type: 'button', id: 'tour-drive', class: 'secondary', title: 'Handy als Dashcam im Auto: Bilder und Route automatisch', text: 'Fahrtmodus', onclick: () => window.Drive?.open() }),
          el('label', { class: 'secondary file-btn', for: 'tour-file', text: 'Importieren' }),
          el('input', { type: 'file', id: 'tour-file', accept: '.gpx,.tcx,.kml,.geojson,.json,.nmea,application/gpx+xml', hidden: '' }),
        ]),
        el('p', { id: 'tour-hint', class: 'muted small' }),
        el('label', { class: 'toggle', id: 'tour-follow-wrap', hidden: '' }, [el('input', { type: 'checkbox', id: 'tour-follow', checked: '' }), ' Magnet: Wegen folgen']),
        el('div', { class: 'tour-tools' }, [
          el('button', { type: 'button', id: 'tour-undo', class: 'link small', text: 'Rückgängig' }),
          el('button', { type: 'button', id: 'tour-loop', class: 'link small', text: 'Zurück zum Start' }),
          el('button', { type: 'button', id: 'tour-clear', class: 'link small', text: 'Neu beginnen' }),
          el('button', { type: 'button', id: 'tour-gpx', class: 'link small', text: 'Als GPX' }),
        ]),
        el('div', { class: 'tour-save' }, [
          el('label', { for: 'tour-name', class: 'sr-only', text: 'Name' }),
          el('input', { id: 'tour-name', maxlength: '120', placeholder: 'Name der Tour' }),
          el('label', { for: 'tour-activity', class: 'sr-only', text: 'Aktivität' }),
          el('select', { id: 'tour-activity' }),
          el('label', { class: 'toggle small' }, [el('input', { type: 'checkbox', id: 'tour-public' }), ' öffentlich (ohne Zeiten und ohne die ersten und letzten 200 m)']),
          el('button', { type: 'button', id: 'tour-save', class: 'btn primary', text: 'Tour speichern' }),
        ]),
        el('p', { id: 'tour-status', class: 'small tour-status', 'aria-live': 'polite' }),
        el('h3', { class: 'label', text: 'Offline unterwegs' }),
        el('p', { class: 'muted small', text: 'Ohne Empfang im Wald: Karte und Spots entlang der Route vorher auf diesem Gerät speichern. Fotos landen dann in der Warteschlange und gehen später raus.' }),
        el('button', { type: 'button', id: 'tour-offline-save', class: 'secondary wide', text: 'Karte entlang der Route offline speichern' }),
        el('div', { id: 'tour-offline' }),
        el('h3', { class: 'label sug-head' }, [el('span', { text: 'Unterwegs fotografieren' })]),
        el('div', { class: 'sp-row' }, [
          el('label', { for: 'tour-dist', class: 'small muted', text: 'Abstand zur Route' }),
          el('input', { type: 'range', id: 'tour-dist', min: '50', max: '500', step: '25', value: String(T.maxDistanceM) }),
          el('output', { id: 'tour-dist-out', class: 'sp-out', text: `${T.maxDistanceM} m` }),
        ]),
        el('div', { id: 'tour-suggestions', 'aria-live': 'polite' }),
      ]),
      el('section', { id: 'tour-touren', hidden: '' }, [
        el('label', { class: 'toggle' }, [el('input', { type: 'checkbox', id: 'tour-show-public' }), ' Öffentliche Touren auf der Karte zeigen']),
        el('h3', { class: 'label', text: 'Meine Touren' }),
        el('div', { id: 'tour-mine' }),
      ]),
      el('section', { id: 'tour-auftraege', hidden: '' }, [
        el('p', { class: 'muted small', text: 'Ein Fotoauftrag bittet um ein Foto von einem Ort, etwa um eine Veränderung zu dokumentieren. Er nennt keine Zeit und keinen Namen: Wer ohnehin dort vorbeikommt, sieht ihn auf der Karte oder als Vorschlag entlang seiner Route.' }),
        el('p', { id: 'req-status', class: 'small tour-status', 'aria-live': 'polite' }),
        el('div', { id: 'tour-requests' }),
      ]),
    );
    $('tour-activity').replaceChildren(el('option', { value: '', text: 'Aktivität' }),
      ...(state.config.activities || ['joggen', 'wandern', 'biken', 'sonstiges']).map((a) => el('option', { value: a, text: a[0].toUpperCase() + a.slice(1) })));
  }

  function renderRoute() {
    const pts = routePoints();
    const r = T.route;
    $('tour-distance').textContent = fmtKm(routeLength(pts));
    const meta = [];
    if (r.raw) meta.push(TOUR_KIND[r.kind] || r.kind);
    else if (r.waypoints.length) meta.push(`${r.waypoints.length} Wegpunkt${r.waypoints.length === 1 ? '' : 'e'}`);
    const times = pts.map((p) => p.time).filter(Number.isFinite);
    if (T.recorder) {
      const s = Math.round((Date.now() - T.recorder.started) / 1000);
      meta.push(`${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`);
    } else if (times.length > 1) {
      const min = Math.round((Math.max(...times) - Math.min(...times)) / 60000);
      meta.push(`${Math.floor(min / 60)} h ${min % 60} min`);
    }
    if (r.savedId) meta.push('gespeichert');
    $('tour-meta').textContent = meta.join(' · ');
    $('tour-record').textContent = T.recorder ? 'Aufnahme beenden' : 'Aufzeichnen';
    $('tour-record').classList.toggle('recording', Boolean(T.recorder));
    $('tour-draw').setAttribute('aria-pressed', String(!r.raw && !T.recorder));
    $('tour-hint').textContent = T.recorder ? 'Die Aufzeichnung läuft, solange diese Seite offen ist. Der Bildschirm bleibt dafür an.'
      : r.raw ? 'Aufgezeichnete und importierte Touren lassen sich speichern und exportieren. «Neu beginnen» startet eine neue Route.'
        : 'Klicke auf die Karte, um Wegpunkte zu setzen. Punkte lassen sich verschieben.';
    $('tour-follow-wrap').hidden = !state.config.routing || Boolean(r.raw);
    if (!$('tour-name').matches(':focus')) $('tour-name').value = r.name || '';
    $('tour-save').disabled = pts.length < 2 || Boolean(T.recorder) || Boolean(r.savedId);
    $('tour-gpx').disabled = pts.length < 2;
    $('tour-offline-save').disabled = !window.offlineMap?.supported() || pts.length < 2;
    $('tour-undo').disabled = !pts.length || Boolean(T.recorder);
    $('tour-loop').disabled = Boolean(r.raw) || r.waypoints.length < 2;
  }

  function setTab(tab) {
    T.tab = tab;
    for (const b of document.querySelectorAll('#tourpanel [role="tab"]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    $('tour-route').hidden = tab !== 'route';
    $('tour-touren').hidden = tab !== 'touren';
    $('tour-auftraege').hidden = tab !== 'auftraege';
    map.getContainer().classList.toggle('tour-drawing', T.open && tab === 'route' && !T.route.raw);
    if (tab === 'touren') renderMine();
    if (tab === 'auftraege') renderRequests();
  }

  function toggle(open) {
    T.open = open;
    $('tourpanel').hidden = !open;
    $('tours-toggle').setAttribute('aria-expanded', String(open));
    if (open) {
      // Only one map panel at a time.
      for (const id of ['sun-toggle', 'species-toggle']) if ($(id)?.getAttribute('aria-expanded') === 'true') $(id).click();
      routeLayer.addTo(map);
      markLayer.addTo(map);
      suggestionLayer.addTo(map);
      setTab(T.tab);
      renderRoute();
      renderOffline();
      scheduleSuggestions();
    } else {
      map.getContainer().classList.remove('tour-drawing');
      T.picking = false;
      suggestionLayer.remove();
      // A recording keeps showing its line.
      if (!T.recorder) { routeLayer.remove(); markLayer.remove(); }
    }
  }

  buildPanel();
  $('tours-toggle').addEventListener('click', () => toggle(!T.open));
  $('tour-close').addEventListener('click', () => toggle(false));
  for (const id of ['sun-toggle', 'species-toggle']) {
    $(id)?.addEventListener('click', () => setTimeout(() => {
      if (T.open && $(id).getAttribute('aria-expanded') === 'true') toggle(false);
    }));
  }
  for (const b of document.querySelectorAll('#tourpanel [role="tab"]')) b.addEventListener('click', () => setTab(b.dataset.tab));
  $('tour-draw').addEventListener('click', () => {
    if (T.recorder) return;
    if (T.route.raw) clearRoute();
    setTab('route');
  });
  $('tour-record').addEventListener('click', () => (T.recorder ? stopRecording() : startRecording()));
  $('tour-file').addEventListener('change', (e) => { importFile(e.target.files[0]); e.target.value = ''; });
  $('tour-follow').addEventListener('change', (e) => { T.follow = e.target.checked; });
  $('tour-undo').addEventListener('click', undo);
  $('tour-loop').addEventListener('click', roundTrip);
  $('tour-clear').addEventListener('click', clearRoute);
  $('tour-gpx').addEventListener('click', exportGpx);
  $('tour-offline-save').addEventListener('click', () => saveOffline(routePoints(), T.route.name || 'Route'));
  $('tour-save').addEventListener('click', saveRoute);
  $('tour-name').addEventListener('input', (e) => { T.route.name = e.target.value; });
  $('tour-dist').addEventListener('input', (e) => {
    T.maxDistanceM = Number(e.target.value);
    $('tour-dist-out').textContent = `${T.maxDistanceM} m`;
    scheduleSuggestions();
  });
  $('tour-show-public').addEventListener('change', (e) => { T.showPublic = e.target.checked; loadPublic(); });
  $('request-photo')?.addEventListener('click', () => state.spot && Tours.requestForSpot(state.spot));

  // The last route of this browser, and a recording interrupted by a reload.
  try {
    const saved = JSON.parse(localStorage.getItem(STORE));
    if (saved && (saved.waypoints?.length || saved.raw?.length)) T.route = { ...emptyRoute(), ...saved };
  } catch { /* nothing stored */ }
  if (loadRecording().length) {
    T.route = { ...emptyRoute(), raw: loadRecording(), kind: 'aufgezeichnet', hasTime: true, name: 'Unterbrochene Aufzeichnung' };
    setStatus('Eine unterbrochene Aufzeichnung wurde wiederhergestellt. «Aufzeichnen» setzt sie fort.');
  }
  renderRoute();
  drawRoute();
  loadRequests();
})();
