/*
 * Drawing on the map, as the drawing tool of map.geo.admin.ch: points, lines and areas in a few colours, each with a
 * name and a note, for a windthrow area, a skid trail or the place of a beetle nest. The drawing stays on the device
 * (localStorage) and on the map until it is deleted, and goes out as KML (with its colours), which map.geo.admin.ch,
 * QGIS, Google Earth and the panel «Ebenen» read back. Runs in Node for the tests (toKml) and in the browser, where it
 * adds the tool «Zeichnen» to the map of app.js.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.Draw = api; api.mount?.(); }
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const COLOURS = [['#c0392b', 'Rot'], ['#e67e22', 'Orange'], ['#f1c40f', 'Gelb'], ['#27ae60', 'Grün'], ['#2980b9', 'Blau'], ['#8e44ad', 'Violett'], ['#1b2a1f', 'Schwarz']];
  const FILL_OPACITY = 0.3;
  const STORE = 'myforrest.drawing.v1';

  const escapeXml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  /** '#rrggbb' and an opacity → the KML colour aabbggrr. */
  function kmlColour(hex, opacity = 1) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '') || [null, 'c0', '39', '2b'];
    const a = Math.round(Math.max(0, Math.min(1, opacity)) * 255).toString(16).padStart(2, '0');
    return `${a}${m[3]}${m[2]}${m[1]}`.toLowerCase();
  }
  const kmlCoords = (list) => list.map(([lon, lat]) => `${Number(lon.toFixed(7))},${Number(lat.toFixed(7))}`).join(' ');
  function kmlGeometry(g) {
    if (g.type === 'Point') return `<Point><coordinates>${kmlCoords([g.coordinates])}</coordinates></Point>`;
    if (g.type === 'LineString') return `<LineString><tessellate>1</tessellate><coordinates>${kmlCoords(g.coordinates)}</coordinates></LineString>`;
    if (g.type === 'Polygon') {
      const ring = (r) => `<LinearRing><coordinates>${kmlCoords(r)}</coordinates></LinearRing>`;
      return `<Polygon><outerBoundaryIs>${ring(g.coordinates[0])}</outerBoundaryIs>${g.coordinates.slice(1).map((r) => `<innerBoundaryIs>${ring(r)}</innerBoundaryIs>`).join('')}</Polygon>`;
    }
    return '';
  }
  /** A FeatureCollection of points, lines and areas (simplestyle colours) → a KML document. */
  function toKml(fc, name = 'MyForrest Zeichnung') {
    const placemarks = fc.features.filter((f) => kmlGeometry(f.geometry || {})).map((f) => {
      const p = f.properties || {};
      const colour = p.stroke || p['marker-color'] || COLOURS[0][0];
      const style = `<Style><IconStyle><color>${kmlColour(p['marker-color'] || colour)}</color></IconStyle>`
        + `<LineStyle><color>${kmlColour(colour, p['stroke-opacity'] ?? 1)}</color><width>${p['stroke-width'] ?? 3}</width></LineStyle>`
        + `<PolyStyle><color>${kmlColour(p.fill || colour, p['fill-opacity'] ?? FILL_OPACITY)}</color></PolyStyle></Style>`;
      return `<Placemark><name>${escapeXml(p.name || '')}</name>${p.description ? `<description>${escapeXml(p.description)}</description>` : ''}${style}${kmlGeometry(f.geometry)}</Placemark>`;
    });
    return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${escapeXml(name)}</name>\n${placemarks.join('\n')}\n</Document></kml>\n`;
  }

  /* ---------- The tool on the map (browser only) ---------- */

  const D = { on: false, mode: 'line', colour: COLOURS[0][0], features: [], draft: [], draftLine: null, draftMarks: null, layer: null, box: null };
  const KINDS = { point: 'Punkt', line: 'Linie', area: 'Fläche' };

  function load() {
    try { D.features = JSON.parse(localStorage.getItem(STORE) || '[]').filter((f) => f?.geometry?.type); } catch { D.features = []; }
  }
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(D.features)); } catch { /* full or blocked: the drawing stays until reload */ }
  }
  const styleOf = (f) => {
    const p = f.properties || {};
    return f.geometry.type === 'Point'
      ? { radius: 7, color: '#fff', weight: 2, fillColor: p['marker-color'] || p.stroke, fillOpacity: 1 }
      : { color: p.stroke, weight: p['stroke-width'] ?? 3, fillColor: p.fill || p.stroke, fillOpacity: p['fill-opacity'] ?? FILL_OPACITY };
  };
  /** The drawing on the map, with its names in a popup; drawn on top of the layers, below the tool's own points. */
  function redrawLayer() {
    D.layer?.remove();
    D.layer = null;
    if (!D.features.length) return;
    D.layer = L.geoJSON({ type: 'FeatureCollection', features: D.features }, {
      style: styleOf,
      pointToLayer: (f, ll) => L.circleMarker(ll, { ...styleOf(f), className: 'drawn' }),
      onEachFeature: (f, layer) => {
        const p = f.properties || {};
        if (!p.name && !p.description) return;
        const box = document.createElement('div');
        if (p.name) box.append(Object.assign(document.createElement('strong'), { textContent: p.name }));
        if (p.description) box.append(Object.assign(document.createElement('p'), { className: 'small', textContent: p.description }));
        layer.bindPopup(box);
      },
    }).addTo(map);
  }

  function mount() {
    if (typeof document === 'undefined' || typeof map === 'undefined' || typeof L === 'undefined') return;
    const btn = document.getElementById('draw-toggle');
    if (!btn) return;
    load();
    redrawLayer();
    btn.addEventListener('click', () => (D.on ? stop() : start()));
    map.on('click', (e) => { if (D.on) click([e.latlng.lng, e.latlng.lat]); });
    map.on('dblclick', (e) => { if (D.on) { L.DomEvent.stop(e); finish(); } });
    document.addEventListener('keydown', (e) => {
      if (!D.on) return;
      if (e.key === 'Escape') { if (D.draft.length) cancelDraft(); else stop(); }
      if (e.key === 'Backspace' && document.activeElement === document.body) { e.preventDefault(); undo(); }
    });
  }

  function start() {
    if (typeof Measure !== 'undefined' && Measure.active()) Measure.stop();
    D.on = true;
    D.draftLine = L.polyline([], { className: 'draw-draft', interactive: false }).addTo(map);
    D.draftMarks = L.layerGroup().addTo(map);
    map.doubleClickZoom.disable();
    document.documentElement.classList.add('drawing');
    document.getElementById('draw-toggle').setAttribute('aria-pressed', 'true');
    D.box = document.createElement('div');
    D.box.className = 'draw-box';
    D.box.setAttribute('role', 'region');
    D.box.setAttribute('aria-label', 'Zeichnen');
    // Outside the map: its buttons are re-drawn on a click, and Leaflet would take such a click for one on the map.
    document.body.append(D.box);
    show();
  }
  function stop() {
    if (!D.on) return;
    cancelDraft();
    D.on = false;
    D.draftLine?.remove();
    D.draftMarks?.remove();
    D.box?.remove();
    map.doubleClickZoom.enable();
    document.documentElement.classList.remove('drawing');
    document.getElementById('draw-toggle')?.setAttribute('aria-pressed', 'false');
  }

  function click(p) {
    if (D.mode === 'point') { add({ type: 'Point', coordinates: p }); return; }
    D.draft.push(p);
    const first = D.draft.length === 1;
    const m = L.circleMarker([p[1], p[0]], { radius: first ? 6 : 4, fillColor: D.colour, fillOpacity: 1, className: `draw-point${first ? ' first' : ''}`, bubblingMouseEvents: false }).addTo(D.draftMarks);
    // A click on the first point closes an area.
    if (first) m.on('click', () => { if (D.mode === 'area' && D.draft.length > 2) finish(); });
    redrawDraft();
  }
  function redrawDraft() {
    const ll = D.draft.map(([x, y]) => [y, x]);
    D.draftLine.setLatLngs(D.mode === 'area' && ll.length > 2 ? [...ll, ll[0]] : ll);
    D.draftLine.setStyle({ color: D.colour });
    show();
  }
  function cancelDraft() {
    D.draft = [];
    D.draftMarks?.clearLayers();
    D.draftLine?.setLatLngs([]);
  }
  function undo() {
    if (!D.draft.length) return;
    D.draft.pop();
    const ms = D.draftMarks.getLayers();
    if (ms.length) D.draftMarks.removeLayer(ms.at(-1));
    redrawDraft();
  }
  function finish() {
    // The two clicks of a double click set the same point twice: once is enough.
    const pts = D.draft.filter((p, i) => !i || p[0] !== D.draft[i - 1][0] || p[1] !== D.draft[i - 1][1]);
    if (D.mode === 'line' && pts.length > 1) add({ type: 'LineString', coordinates: pts });
    if (D.mode === 'area' && pts.length > 2) add({ type: 'Polygon', coordinates: [[...pts, pts[0]]] });
  }
  function add(geometry) {
    const kind = { Point: 'point', LineString: 'line', Polygon: 'area' }[geometry.type];
    const n = D.features.filter((f) => f.geometry.type === geometry.type).length + 1;
    const properties = { name: `${KINDS[kind]} ${n}`, description: '', stroke: D.colour };
    if (kind === 'point') properties['marker-color'] = D.colour;
    else properties['stroke-width'] = 3;
    if (kind === 'area') Object.assign(properties, { fill: D.colour, 'fill-opacity': FILL_OPACITY });
    D.features.push({ type: 'Feature', properties, geometry });
    save();
    cancelDraft();
    redrawLayer();
    show();
    // The name of the new object, ready to type over.
    const inputs = D.box?.querySelectorAll('.draw-list input');
    inputs?.[inputs.length - 1]?.select();
  }
  function remove(i) {
    D.features.splice(i, 1);
    save();
    redrawLayer();
    show();
  }
  function download() {
    const blob = new Blob([toKml({ type: 'FeatureCollection', features: D.features })], { type: 'application/vnd.google-earth.kml+xml' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'myforrest-zeichnung.kml' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /** Length or area of an object, with the formulas of «Messen». */
  function sizeOf(g) {
    if (typeof Measure === 'undefined') return '';
    const ll = (list) => list.map(([x, y]) => [y, x]);
    if (g.type === 'LineString') return Measure.fmtLength(Measure.length(ll(g.coordinates)));
    if (g.type === 'Polygon') return Measure.fmtArea(Measure.area(ll(g.coordinates[0]).slice(0, -1)));
    return '';
  }

  function el(tag, props = {}, children = []) {
    const node = Object.assign(document.createElement(tag), props);
    for (const c of [].concat(children)) if (c) node.append(c);
    return node;
  }
  function show() {
    if (!D.box) return;
    const n = D.draft.length;
    const hint = D.mode === 'point' ? 'In die Karte klicken setzt einen Punkt.'
      : !n ? `In die Karte klicken, um die ${KINDS[D.mode]} zu beginnen.`
        : D.mode === 'line' ? `Doppelklick beendet die Linie${n > 1 ? ` (${sizeOf({ type: 'LineString', coordinates: D.draft })})` : ''}.`
          : `Ein Klick auf den ersten Punkt oder ein Doppelklick schliesst die Fläche${n > 2 ? ` (${sizeOf({ type: 'Polygon', coordinates: [[...D.draft, D.draft[0]]] })})` : ''}.`;
    const modes = el('div', { className: 'draw-modes', role: 'group' }, Object.entries(KINDS).map(([k, label]) => {
      const b = el('button', { type: 'button', className: 'secondary small', textContent: label });
      b.setAttribute('aria-pressed', String(D.mode === k));
      b.addEventListener('click', () => { cancelDraft(); D.mode = k; show(); });
      return b;
    }));
    modes.setAttribute('aria-label', 'Was zeichnen');
    const colours = el('div', { className: 'draw-colours', role: 'radiogroup' }, COLOURS.map(([c, label]) => {
      const b = el('button', { type: 'button', className: 'draw-swatch', title: label });
      b.style.setProperty('--swatch', c);
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', label);
      b.setAttribute('aria-checked', String(D.colour === c));
      b.addEventListener('click', () => { D.colour = c; if (D.draft.length) redrawDraft(); else show(); });
      return b;
    }));
    colours.setAttribute('aria-label', 'Farbe');
    const list = el('ul', { className: 'draw-list' }, D.features.map((f, i) => {
      const name = el('input', { type: 'text', value: f.properties.name || '', maxLength: 120 });
      name.setAttribute('aria-label', `Name: ${KINDS[{ Point: 'point', LineString: 'line', Polygon: 'area' }[f.geometry.type]]}`);
      name.addEventListener('change', () => { f.properties.name = name.value.trim(); save(); redrawLayer(); });
      const note = el('input', { type: 'text', value: f.properties.description || '', placeholder: 'Notiz', maxLength: 500 });
      note.setAttribute('aria-label', `Notiz zu ${f.properties.name || 'diesem Objekt'}`);
      note.addEventListener('change', () => { f.properties.description = note.value.trim(); save(); redrawLayer(); });
      const del = el('button', { type: 'button', className: 'draw-del', textContent: '✕', title: 'Löschen' });
      del.setAttribute('aria-label', `${f.properties.name || 'Objekt'} löschen`);
      del.addEventListener('click', () => remove(i));
      const swatch = el('span', { className: `draw-kind ${f.geometry.type}` });
      swatch.style.setProperty('--swatch', f.properties.stroke || f.properties['marker-color']);
      return el('li', {}, [swatch, el('div', { className: 'draw-fields' }, [name, note]), el('span', { className: 'muted small', textContent: sizeOf(f.geometry) }), del]);
    }));
    const btn = (text, fn, disabled = false, cls = 'secondary small') => {
      const b = el('button', { type: 'button', className: cls, textContent: text, disabled });
      b.addEventListener('click', fn);
      return b;
    };
    D.box.replaceChildren(
      el('p', { className: 'eyebrow', textContent: 'Zeichnen' }),
      modes,
      colours,
      el('p', { className: 'small draw-hint', textContent: hint }),
      D.features.length ? list : el('p', { className: 'muted small', textContent: 'Die Zeichnung bleibt auf diesem Gerät, bis sie gelöscht wird.' }),
      el('div', { className: 'draw-tools' }, [
        btn('Rückgängig', undo, !n),
        btn('KML herunterladen', download, !D.features.length),
        btn('Alles löschen', () => {
          if (!confirm('Die ganze Zeichnung löschen?')) return;
          D.features = [];
          save();
          redrawLayer();
          show();
        }, !D.features.length),
        btn('Fertig', stop),
      ]),
    );
  }

  return { toKml, kmlColour, COLOURS, mount, stop, active: () => D.on, features: () => D.features };
}));
