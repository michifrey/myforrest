/*
 * Measuring on the map, as the drawing tool of map.geo.admin.ch measures: the length of a line, the area and
 * perimeter of a closed one, and the direction of each stretch (azimuth from north), for windthrow areas,
 * clearings or how far a glacier tongue retreated.
 *
 * Distances and azimuths on the WGS84 ellipsoid (Vincenty's inverse formula, to the millimetre over the distances
 * of a map), the area on the authalic sphere of WGS84 with authalic latitudes (edges as great circles; for
 * forest-sized areas a few hundredths of a per cent from the ellipsoid). Runs in Node
 * for the tests (module.exports) and in the browser, where it also adds the tool «Messen» to the map of app.js.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.Measure = api; api.mount?.(); }
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const RAD = Math.PI / 180;
  const A = 6378137;
  const F = 1 / 298.257223563;
  const B = A * (1 - F);
  const R_AUTHALIC = 6371007.181;

  /** Distance (m) and azimuth at the start (° from north) between two points [lat, lon], on the WGS84 ellipsoid. */
  function inverse([lat1, lon1], [lat2, lon2]) {
    const L = (lon2 - lon1) * RAD;
    const U1 = Math.atan((1 - F) * Math.tan(lat1 * RAD));
    const U2 = Math.atan((1 - F) * Math.tan(lat2 * RAD));
    const sinU1 = Math.sin(U1); const cosU1 = Math.cos(U1);
    const sinU2 = Math.sin(U2); const cosU2 = Math.cos(U2);
    let lambda = L;
    let sinS; let cosS; let sigma; let cos2a; let cos2sm; let sinL; let cosL;
    for (let i = 0; i < 200; i++) {
      sinL = Math.sin(lambda); cosL = Math.cos(lambda);
      sinS = Math.hypot(cosU2 * sinL, cosU1 * sinU2 - sinU1 * cosU2 * cosL);
      if (sinS === 0) return { distance: 0, azimuth: 0 };
      cosS = sinU1 * sinU2 + cosU1 * cosU2 * cosL;
      sigma = Math.atan2(sinS, cosS);
      const sinA = (cosU1 * cosU2 * sinL) / sinS;
      cos2a = 1 - sinA * sinA;
      cos2sm = cos2a ? cosS - (2 * sinU1 * sinU2) / cos2a : 0;
      const C = (F / 16) * cos2a * (4 + F * (4 - 3 * cos2a));
      const prev = lambda;
      lambda = L + (1 - C) * F * sinA * (sigma + C * sinS * (cos2sm + C * cosS * (-1 + 2 * cos2sm * cos2sm)));
      if (Math.abs(lambda - prev) < 1e-12) break;
    }
    const u2 = (cos2a * (A * A - B * B)) / (B * B);
    const k1 = (Math.sqrt(1 + u2) - 1) / (Math.sqrt(1 + u2) + 1);
    const Aa = (1 + (k1 * k1) / 4) / (1 - k1);
    const Bb = k1 * (1 - (3 / 8) * k1 * k1);
    const dS = Bb * sinS * (cos2sm + (Bb / 4) * (cosS * (-1 + 2 * cos2sm * cos2sm) - (Bb / 6) * cos2sm * (-3 + 4 * sinS * sinS) * (-3 + 4 * cos2sm * cos2sm)));
    const distance = B * Aa * (sigma - dS);
    const azimuth = (Math.atan2(cosU2 * sinL, cosU1 * sinU2 - sinU1 * cosU2 * cosL) / RAD + 360) % 360;
    return { distance, azimuth };
  }

  /** Length (m) of a line [[lat, lon], …]; `closed` adds the stretch back to the start. */
  function length(points, closed = false) {
    let sum = 0;
    for (let i = 1; i < points.length; i++) sum += inverse(points[i - 1], points[i]).distance;
    if (closed && points.length > 2) sum += inverse(points.at(-1), points[0]).distance;
    return sum;
  }

  // Authalic latitude: the latitude on the sphere of equal area (R_AUTHALIC) that keeps areas of the ellipsoid.
  const E2 = F * (2 - F);
  const E = Math.sqrt(E2);
  const q = (phi) => { const s = Math.sin(phi); return (1 - E2) * (s / (1 - E2 * s * s) - (1 / (2 * E)) * Math.log((1 - E * s) / (1 + E * s))); };
  const QP = q(Math.PI / 2);
  const authalic = (lat) => Math.asin(Math.max(-1, Math.min(1, q(lat * RAD) / QP)));

  /** Area (m²) of a polygon [[lat, lon], …]: spherical excess on the authalic sphere, after the authalic latitude. */
  function area(points) {
    if (points.length < 3) return 0;
    let sum = 0;
    for (let i = 0; i < points.length; i++) {
      const [la1, lo1] = points[i];
      const [la2, lo2] = points[(i + 1) % points.length];
      sum += (lo2 - lo1) * RAD * (2 + Math.sin(authalic(la1)) + Math.sin(authalic(la2)));
    }
    return Math.abs((sum * R_AUTHALIC * R_AUTHALIC) / 2);
  }

  const nf = (d) => new Intl.NumberFormat('de-CH', { maximumFractionDigits: d, minimumFractionDigits: d });
  /** 1234.5 → «1,23 km», 87.2 → «87,2 m». */
  const fmtLength = (m) => (m >= 1000 ? `${nf(2).format(m / 1000)} km` : `${nf(m < 100 ? 1 : 0).format(m)} m`);
  /** Area in m², ares or hectares as foresters read it, with km² for large ones. */
  const fmtArea = (m2) => (m2 >= 1e6 ? `${nf(2).format(m2 / 1e6)} km²` : m2 >= 10000 ? `${nf(2).format(m2 / 10000)} ha` : `${nf(0).format(m2)} m²`);
  const COMPASS = ['N', 'NNO', 'NO', 'ONO', 'O', 'OSO', 'SO', 'SSO', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const fmtAzimuth = (az) => `${nf(0).format(az)}° (${COMPASS[Math.round(az / 22.5) % 16]})`;

  /* ---------- The tool on the map (browser only) ---------- */

  const T = { on: false, points: [], closed: false, line: null, marks: null, box: null };

  function mount() {
    if (typeof document === 'undefined' || typeof map === 'undefined' || typeof L === 'undefined') return;
    const btn = document.getElementById('measure-toggle');
    if (!btn) return;
    btn.addEventListener('click', () => (T.on ? stop() : start()));
    map.on('click', (e) => { if (T.on && !T.closed) add([e.latlng.lat, e.latlng.lng]); });
    map.on('dblclick', (e) => { if (T.on) { L.DomEvent.stop(e); finish(); } });
    document.addEventListener('keydown', (e) => {
      if (!T.on) return;
      if (e.key === 'Escape') stop();
      if (e.key === 'Backspace' && document.activeElement === document.body) { e.preventDefault(); undo(); }
    });
  }

  function start() {
    T.on = true;
    T.points = [];
    T.closed = false;
    T.line = L.polyline([], { className: 'measure-line', interactive: false }).addTo(map);
    T.marks = L.layerGroup().addTo(map);
    map.doubleClickZoom.disable();
    document.documentElement.classList.add('measuring');
    document.getElementById('measure-toggle').setAttribute('aria-pressed', 'true');
    T.box = document.createElement('div');
    T.box.className = 'measure-box';
    T.box.setAttribute('role', 'status');
    T.box.setAttribute('aria-live', 'polite');
    map.getContainer().append(T.box);
    L.DomEvent.disableClickPropagation(T.box);
    show();
  }

  function stop() {
    T.on = false;
    T.line?.remove();
    T.marks?.remove();
    T.box?.remove();
    map.doubleClickZoom.enable();
    document.documentElement.classList.remove('measuring');
    document.getElementById('measure-toggle')?.setAttribute('aria-pressed', 'false');
  }

  function add(p) {
    T.points.push(p);
    const first = T.points.length === 1;
    const m = L.circleMarker(p, { radius: first ? 6 : 4, className: `measure-point${first ? ' first' : ''}`, bubblingMouseEvents: false }).addTo(T.marks);
    // A click on the first point closes the line into an area.
    if (first) m.on('click', () => { if (T.points.length > 2) finish(true); });
    redraw();
  }
  function undo() {
    if (T.closed) { T.closed = false; redraw(); return; }
    T.points.pop();
    const ms = T.marks.getLayers();
    if (ms.length) T.marks.removeLayer(ms.at(-1));
    redraw();
  }
  function finish(close = T.points.length > 2 && inverse(T.points[0], T.points.at(-1)).distance < 1) {
    if (T.points.length < 2) return;
    T.closed = close && T.points.length > 2;
    redraw();
  }
  function redraw() {
    const latlngs = T.closed ? [...T.points, T.points[0]] : T.points;
    T.line.setLatLngs(latlngs);
    T.line.getElement()?.classList.toggle('closed', T.closed);
    show();
  }

  function show() {
    const n = T.points.length;
    const lines = [];
    if (!n) lines.push('Auf die Karte klicken, um zu messen. Doppelklick beendet, ein Klick auf den ersten Punkt schliesst eine Fläche.');
    if (n >= 2) {
      lines.push(`<strong>${T.closed ? 'Umfang' : 'Strecke'}: ${fmtLength(length(T.points, T.closed))}</strong>`);
      if (T.closed) lines.push(`<strong>Fläche: ${fmtArea(area(T.points))}</strong>`);
      const last = inverse(T.points.at(-2), T.points.at(-1));
      if (!T.closed) lines.push(`Letzter Abschnitt: ${fmtLength(last.distance)}, Richtung ${fmtAzimuth(last.azimuth)}`);
    } else if (n === 1) lines.push('Nächsten Punkt setzen …');
    T.box.innerHTML = `<p class="eyebrow">Messen</p>${lines.map((l) => `<p class="small">${l}</p>`).join('')}`;
    const tools = document.createElement('div');
    tools.className = 'measure-tools';
    const btn = (text, fn, disabled = false) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'secondary small';
      b.textContent = text;
      b.disabled = disabled;
      b.addEventListener('click', fn);
      tools.append(b);
    };
    btn('Rückgängig', undo, !n);
    btn('Neu', () => { stop(); start(); }, !n);
    btn('Beenden', stop);
    T.box.append(tools);
  }

  return { inverse, length, area, fmtLength, fmtArea, fmtAzimuth, mount, active: () => T.on };
}));
