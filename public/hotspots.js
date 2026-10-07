'use strict';

/*
 * "Arten & Neophyten" map mode:
 *  - Hotspots: kernel density (Gaussian kernel, adjustable radius) of the
 *    findings of all neophytes, all species or one species, drawn on a canvas
 *    overlay below the spot pins.
 *  - Ausbreitung: per species the occupied area per year (nested hulls,
 *    coloured by year) with a year slider and the estimated spread rate.
 *  - Export: Darwin Core and iNaturalist CSV downloads with filters.
 * Relies on globals from app.js (map, state, api, el, $, openSpot).
 */
(function speciesMode() {
  const ALL_NEO = '@neo';
  const ALL = '@all';
  const hs = {
    open: false,
    tab: 'hotspots',
    species: [],
    selected: ALL_NEO,
    minScore: 0.2,
    bandwidth: 150, // m
    occ: [],
    spread: null,
    yearIndex: 0,
    playing: null,
    token: 0,
    maxDensity: 0,
  };
  const pointLayer = L.layerGroup();
  const frontLayer = L.layerGroup();
  const fmt = (v, d = 0) => v.toLocaleString('de-CH', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtDay = (iso) => new Date(iso).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const speciesLabel = (s) => (s.neophyte || s.commonName ? `${s.neophyte || s.commonName} (${s.scientificName})` : s.scientificName);

  /* ---------- Colours (sequential, one hue; tokens differ for light/dark) ---------- */

  function hexRgb(hex) {
    const h = hex.trim().replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function ramp() {
    const css = getComputedStyle(document.documentElement);
    return [hexRgb(css.getPropertyValue('--kde-lo') || '#e4d4f7'), hexRgb(css.getPropertyValue('--kde-hi') || '#3f1a78')];
  }
  const mix = ([a, b], t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  const rgb = (c) => `rgb(${c[0]} ${c[1]} ${c[2]})`;
  const yearColour = (i, n) => rgb(mix(ramp(), n > 1 ? 0.15 + (0.85 * i) / (n - 1) : 1));
  // SVG presentation attributes do not resolve var(), so read the tokens.
  const cssToken = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

  /* ---------- Kernel density canvas layer ---------- */

  const CELL = 4; // px per density cell; drawn scaled with smoothing
  const metresPerPixel = (lat) => (40075016.686 * Math.cos((lat * Math.PI) / 180)) / 2 ** (map.getZoom() + 8);

  const DensityLayer = L.Layer.extend({
    onAdd(m) {
      this._canvas = L.DomUtil.create('canvas', 'kde-canvas leaflet-zoom-hide');
      m.getPane('overlayPane').appendChild(this._canvas);
      m.on('moveend zoomend resize', this.redraw, this);
      this.redraw();
    },
    onRemove(m) {
      m.off('moveend zoomend resize', this.redraw, this);
      this._canvas.remove();
    },
    redraw() {
      if (!this._map) return;
      const size = this._map.getSize();
      const canvas = this._canvas;
      L.DomUtil.setPosition(canvas, this._map.containerPointToLayerPoint([0, 0]));
      const dpr = window.devicePixelRatio || 1;
      canvas.width = size.x * dpr;
      canvas.height = size.y * dpr;
      canvas.style.width = `${size.x}px`;
      canvas.style.height = `${size.y}px`;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      hs.maxDensity = 0;
      if (!hs.occ.length) return renderLegend();

      const gw = Math.ceil(size.x / CELL);
      const gh = Math.ceil(size.y / CELL);
      const grid = new Float32Array(gw * gh);
      const mpp = metresPerPixel(this._map.getCenter().lat);
      const hPx = hs.bandwidth / mpp; // kernel sd in screen px
      const hCells = hPx / CELL;
      const reach = Math.ceil(3 * hCells);
      const norm = 1e6 / (2 * Math.PI * hs.bandwidth ** 2); // findings per km²
      const inv2s2 = 1 / (2 * hCells * hCells);
      for (const o of hs.occ) {
        const p = this._map.latLngToContainerPoint([o.lat, o.lon]);
        const cx = p.x / CELL;
        const cy = p.y / CELL;
        if (cx < -reach || cy < -reach || cx > gw + reach || cy > gh + reach) continue;
        const x0 = Math.max(0, Math.floor(cx - reach)); const x1 = Math.min(gw - 1, Math.ceil(cx + reach));
        const y0 = Math.max(0, Math.floor(cy - reach)); const y1 = Math.min(gh - 1, Math.ceil(cy + reach));
        for (let y = y0; y <= y1; y++) {
          const dy = y + 0.5 - cy;
          for (let x = x0; x <= x1; x++) {
            const dx = x + 0.5 - cx;
            grid[y * gw + x] += Math.exp(-(dx * dx + dy * dy) * inv2s2) * norm;
          }
        }
      }
      let max = 0;
      for (const v of grid) if (v > max) max = v;
      hs.maxDensity = max;
      renderLegend();
      if (!max) return;

      const [lo, hi] = ramp();
      const off = document.createElement('canvas');
      off.width = gw;
      off.height = gh;
      const octx = off.getContext('2d');
      const img = octx.createImageData(gw, gh);
      for (let i = 0; i < grid.length; i++) {
        const t = grid[i] / max;
        if (t < 0.01) continue;
        const c = mix([lo, hi], Math.sqrt(t));
        img.data[i * 4] = c[0];
        img.data[i * 4 + 1] = c[1];
        img.data[i * 4 + 2] = c[2];
        img.data[i * 4 + 3] = Math.round(255 * 0.82 * Math.min(1, Math.sqrt(t) * 1.4)); // fades out at the edge
      }
      octx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(off, 0, 0, gw * CELL * dpr, gh * CELL * dpr);
    },
  });
  const density = new DensityLayer();

  /* ---------- Data ---------- */

  const query = (extra = {}) => {
    const q = new URLSearchParams({ minScore: String(hs.minScore) });
    if (hs.selected === ALL_NEO) q.set('neophytes', '1');
    else if (hs.selected !== ALL) q.set('species', hs.selected);
    for (const [k, v] of Object.entries(extra)) if (v !== null && v !== undefined && v !== '') q.set(k, v);
    return q;
  };

  async function loadSpecies() {
    try {
      hs.species = await api(`/api/species?minScore=${hs.minScore}`);
    } catch {
      hs.species = [];
    }
    const sel = $('sp-species');
    const neoCount = hs.species.filter((s) => s.neophyte).reduce((a, s) => a + s.count, 0);
    const allCount = hs.species.reduce((a, s) => a + s.count, 0);
    const opts = [
      el('option', { value: ALL_NEO, text: `Alle Neophyten (${neoCount})` }),
      el('option', { value: ALL, text: `Alle Arten (${allCount})` }),
    ];
    const neo = hs.species.filter((s) => s.neophyte);
    const other = hs.species.filter((s) => !s.neophyte);
    if (neo.length) opts.push(el('optgroup', { label: 'Neophyten' }, neo.map((s) => el('option', { value: s.scientificName, text: `${speciesLabel(s)} · ${s.count}` }))));
    if (other.length) opts.push(el('optgroup', { label: 'Weitere Arten' }, other.map((s) => el('option', { value: s.scientificName, text: `${speciesLabel(s)} · ${s.count}` }))));
    sel.replaceChildren(...opts);
    if (![ALL_NEO, ALL].includes(hs.selected) && !hs.species.some((s) => s.scientificName === hs.selected)) hs.selected = ALL_NEO;
    sel.value = hs.selected;
  }

  async function loadOccurrences() {
    const token = ++hs.token;
    let occ = [];
    try {
      occ = await api(`/api/occurrences?${query()}`);
    } catch {
      occ = [];
    }
    if (token !== hs.token) return;
    hs.occ = occ;
    drawPoints();
    density.redraw();
    renderHotspotStats();
  }

  function selectedSpread() {
    if (![ALL_NEO, ALL].includes(hs.selected)) return hs.selected;
    // Aggregates have no single front: take the most frequent neophyte (or species).
    const pick = hs.species.find((s) => s.neophyte) || hs.species[0];
    return pick ? pick.scientificName : null;
  }

  async function loadSpread() {
    const token = ++hs.token;
    const name = selectedSpread();
    hs.spread = null;
    if (!name) { renderSpread(); drawFronts(); return; }
    let data = null;
    try {
      data = await api(`/api/spread?species=${encodeURIComponent(name)}&minScore=${hs.minScore}`);
    } catch {
      data = null;
    }
    if (token !== hs.token) return;
    hs.spread = data;
    hs.yearIndex = data && data.years.length ? data.years.length - 1 : 0;
    renderSpread();
    drawFronts();
    const last = data?.years[data.years.length - 1];
    if (last) map.fitBounds(L.latLngBounds(last.hull), { padding: [60, 60], maxZoom: 17 });
  }

  /* ---------- Map drawing ---------- */

  function drawPoints() {
    pointLayer.clearLayers();
    if (!hs.open || hs.tab !== 'hotspots') return;
    for (const o of hs.occ) {
      L.circleMarker([o.lat, o.lon], {
        radius: 4,
        weight: 1.5,
        color: '#fff',
        fillColor: o.neophyte ? cssToken('--neo', '#8650c8') : cssToken('--accent', '#2f5d34'),
        fillOpacity: 1,
        className: 'sp-point',
      })
        .bindTooltip(`${o.neophyte || o.commonName || o.scientificName}<br><i>${o.scientificName}</i><br>${fmtDay(o.takenAt)} · Score ${fmt(o.score, 2)}`)
        .on('click', () => typeof openSpot === 'function' && openSpot(o.spotId, o.photoId))
        .addTo(pointLayer);
    }
  }

  function drawFronts() {
    frontLayer.clearLayers();
    if (!hs.open || hs.tab !== 'spread' || !hs.spread?.years.length) return;
    const ys = hs.spread.years;
    // Largest (newest) first, so the older, smaller hulls on top stay hoverable.
    for (let i = hs.yearIndex; i >= 0; i--) {
      const y = ys[i];
      const current = i === hs.yearIndex;
      L.polygon(y.hull, {
        color: yearColour(i, ys.length),
        weight: current ? 3 : 1.5,
        dashArray: current ? null : '4 4',
        fillColor: yearColour(i, ys.length),
        fillOpacity: current ? 0.12 : 0.08,
        className: 'sp-front',
      }).bindTooltip(`${y.year}: ${fmt(y.cumulativeCount)} Funde bis dahin · ${fmt(y.areaM2 / 10000, 2)} ha`, { sticky: true })
        .addTo(frontLayer);
    }
    const yearOf = (o) => new Date(o.takenAt).getUTCFullYear();
    const idxOf = new Map(ys.map((y, i) => [y.year, i]));
    for (const o of hs.spreadOcc || []) {
      const i = idxOf.get(yearOf(o));
      if (i === undefined || i > hs.yearIndex) continue;
      L.circleMarker([o.lat, o.lon], {
        radius: i === hs.yearIndex ? 5 : 3.5, weight: 1.5, color: '#fff', fillColor: yearColour(i, ys.length), fillOpacity: 1,
      }).bindTooltip(`${fmtDay(o.takenAt)} · Score ${fmt(o.score, 2)}`).addTo(frontLayer);
    }
    if (hs.spread.origin) {
      L.circleMarker(hs.spread.origin, { radius: 3, weight: 2, color: cssToken('--text', '#1b2a1f'), fill: false, interactive: false }).addTo(frontLayer);
    }
  }

  /* ---------- Panel ---------- */

  function buildPanel() {
    const panel = $('speciespanel');
    const tabBtn = (id, text) => el('button', { type: 'button', role: 'tab', 'data-tab': id, 'aria-selected': String(hs.tab === id), text });
    panel.append(
      el('header', { class: 'sun-head' }, [
        el('div', {}, [
          el('p', { class: 'eyebrow', text: 'Arten & Neophyten' }),
          el('h2', { id: 'sp-title', text: 'Wo wächst was?' }),
          el('p', { class: 'muted small', text: 'Funde aus der Pl@ntNet-Bestimmung: pro Foto die wahrscheinlichste Art.' }),
        ]),
        el('button', { type: 'button', id: 'sp-close', class: 'icon', 'aria-label': 'Schliessen', text: '×' }),
      ]),
      el('div', { class: 'sp-tabs', role: 'tablist', 'aria-label': 'Ansicht' }, [
        tabBtn('hotspots', 'Hotspots'), tabBtn('spread', 'Ausbreitung'), tabBtn('export', 'Export'),
      ]),
      el('div', { class: 'sp-row' }, [
        el('label', { for: 'sp-species', class: 'sr-only', text: 'Art' }),
        el('select', { id: 'sp-species' }),
        el('label', { class: 'sp-score', title: 'Mindest-Score der Bestimmung (0–1)' }, [
          'Score ≥ ', el('input', { id: 'sp-minscore', type: 'number', min: '0', max: '1', step: '0.05', value: String(hs.minScore) }),
        ]),
      ]),
      el('div', { id: 'sp-hotspots', role: 'tabpanel' }, [
        el('div', { class: 'sun-time' }, [
          el('label', { for: 'sp-bw', class: 'small', text: 'Radius' }),
          el('input', { id: 'sp-bw', type: 'range', min: '30', max: '1000', step: '10', value: String(hs.bandwidth) }),
          el('output', { id: 'sp-bw-out', for: 'sp-bw', class: 'sp-out', text: `${hs.bandwidth} m` }),
        ]),
        el('div', { id: 'sp-legend', class: 'sp-legend' }),
        el('div', { id: 'sp-hot-stats', class: 'sun-tiles' }),
        el('p', { class: 'wx-source', text: 'Kerndichte-Schätzung (Gauss-Kern): jeder Fund wird mit dem gewählten Radius als Standardabweichung über die Fläche verteilt; die Farbe zeigt Funde pro km², relativ zum dichtesten Ort im Kartenausschnitt.' }),
      ]),
      el('div', { id: 'sp-spread', role: 'tabpanel', hidden: '' }, [
        el('p', { id: 'sp-rate', class: 'sp-rate' }),
        el('div', { class: 'sun-time' }, [
          el('button', { type: 'button', id: 'sp-play', class: 'secondary sun-play', 'aria-label': 'Jahre abspielen', text: '▶' }),
          el('label', { for: 'sp-year', class: 'sr-only', text: 'Jahr' }),
          el('input', { id: 'sp-year', type: 'range', min: '0', max: '0', step: '1', value: '0' }),
          el('output', { id: 'sp-year-out', for: 'sp-year', class: 'sp-out' }),
        ]),
        el('div', { id: 'sp-years', class: 'sp-years' }),
        el('p', { id: 'sp-method', class: 'wx-source' }),
      ]),
      el('div', { id: 'sp-export', role: 'tabpanel', hidden: '' }, [
        el('p', { class: 'small', text: 'Funde als Datei für Biodiversitäts-Portale. Darwin Core ist das Austauschformat von GBIF und Info Flora; die iNaturalist-Datei entspricht deren CSV-Import.' }),
        el('div', { class: 'sp-checks' }, [
          el('label', {}, [el('input', { type: 'checkbox', id: 'sp-x-neo', checked: '' }), ' Nur Neophyten']),
          el('label', {}, [el('input', { type: 'checkbox', id: 'sp-x-species' }), ' Nur die gewählte Art']),
          el('label', {}, [el('input', { type: 'checkbox', id: 'sp-x-bbox' }), ' Nur Kartenausschnitt']),
        ]),
        el('div', { class: 'sp-dates' }, [
          el('label', {}, ['Von ', el('input', { type: 'date', id: 'sp-x-from' })]),
          el('label', {}, ['Bis ', el('input', { type: 'date', id: 'sp-x-to' })]),
        ]),
        el('p', { id: 'sp-x-count', class: 'muted small' }),
        el('div', { class: 'sp-downloads' }, [
          el('a', { id: 'sp-dl-dwc', class: 'btn primary', href: '#', download: '', text: 'Darwin Core (CSV)' }),
          el('a', { id: 'sp-dl-inat', class: 'btn', href: '#', download: '', text: 'iNaturalist (CSV)' }),
        ]),
        el('p', { class: 'wx-source', text: 'Direktes Hochladen zu iNaturalist oder Info Flora bräuchte dort ein Konto und eine OAuth-Anmeldung; deshalb gibt es hier nur den Datei-Export. iNaturalist übernimmt beim CSV-Import keine Fotos – der Link zum Foto steht in der Beschreibung. Alle Bestimmungen sind automatisch (Pl@ntNet) und ungeprüft.' }),
      ]),
    );
  }

  function renderLegend() {
    const box = $('sp-legend');
    if (!box) return;
    const [lo, hi] = ramp();
    box.replaceChildren(
      el('span', { class: 'small', text: 'gering' }),
      el('i', { class: 'sp-ramp', style: `background: linear-gradient(90deg, ${rgb(lo)}, ${rgb(hi)})` }),
      el('span', { class: 'small', text: hs.maxDensity ? `${fmt(hs.maxDensity, hs.maxDensity < 10 ? 1 : 0)} Funde/km²` : 'hoch' }),
    );
  }

  function tile(label, value, sub) {
    return el('div', { class: 'wx-tile' }, [el('span', { text: label }), el('b', { text: value }), el('em', { text: sub || '' })]);
  }

  function renderHotspotStats() {
    const occ = hs.occ;
    const species = new Set(occ.map((o) => o.scientificName));
    const spots = new Set(occ.map((o) => o.spotId));
    const years = occ.map((o) => new Date(o.takenAt).getUTCFullYear());
    const perSpecies = new Map();
    for (const o of occ) perSpecies.set(o.scientificName, (perSpecies.get(o.scientificName) || 0) + 1);
    const top = species.size > 1 ? [...perSpecies.entries()].sort((a, b) => b[1] - a[1])[0] : null;
    const topInfo = top && hs.species.find((s) => s.scientificName === top[0]);
    $('sp-hot-stats').replaceChildren(
      tile('Funde', fmt(occ.length), `an ${fmt(spots.size)} Spots`),
      tile('Arten', fmt(species.size), years.length ? `${Math.min(...years)}–${Math.max(...years)}` : 'noch keine Funde'),
      ...(top ? [tile('Häufigste Art', topInfo?.neophyte || topInfo?.commonName || top[0], `${fmt(top[1])} von ${fmt(occ.length)} Funden`)] : []),
    );
    if (!occ.length) {
      $('sp-hot-stats').append(el('p', { class: 'muted small sp-empty', text: 'Keine Funde für diese Auswahl. Bestimme Pflanzen auf Fotos mit „Pflanze bestimmen“.' }));
    }
  }

  function renderSpread() {
    const s = hs.spread;
    const slider = $('sp-year');
    const years = s?.years || [];
    slider.max = String(Math.max(0, years.length - 1));
    slider.value = String(hs.yearIndex);
    slider.disabled = years.length < 2;
    $('sp-play').disabled = years.length < 2;
    $('sp-year-out').textContent = years.length ? String(years[hs.yearIndex].year) : '–';
    const name = s ? (s.commonName ? `${s.commonName} (${s.scientificName})` : s.scientificName) : '';
    $('sp-rate').replaceChildren(...(s && s.count
      ? [el('span', { class: 'muted small', text: name }), el('b', { text: s.text })]
      : [el('span', { class: 'muted small', text: 'Für die Ausbreitung braucht es Funde einer Art.' })]));
    $('sp-years').replaceChildren(...(years.length ? [el('table', {}, [
      el('thead', {}, el('tr', {}, ['', 'Jahr', 'neu', 'total', 'Fläche', 'Front'].map((h) => el('th', { text: h })))),
      el('tbody', {}, years.map((y, i) => el('tr', { class: i === hs.yearIndex ? 'current' : '', 'data-i': String(i) }, [
        el('td', {}, el('i', { class: 'sp-swatch', style: `background:${yearColour(i, years.length)}` })),
        el('td', { text: String(y.year) }),
        el('td', { text: fmt(y.count) }),
        el('td', { text: fmt(y.cumulativeCount) }),
        el('td', { text: `${fmt(y.areaM2 / 10000, 2)} ha` }),
        el('td', { text: `${fmt(y.frontRadiusM)} m` }),
      ]))),
    ])] : []));
    $('sp-method').textContent = s ? `Methode: ${s.method} Puffer ${s.bufferM} m um jeden Fund. Die Schätzung hängt stark davon ab, wo gesucht wurde.` : '';
  }

  function exportQuery() {
    const q = new URLSearchParams({ minScore: String(hs.minScore) });
    if ($('sp-x-neo').checked) q.set('neophytes', '1');
    if ($('sp-x-species').checked && ![ALL_NEO, ALL].includes(hs.selected)) q.set('species', hs.selected);
    if ($('sp-x-bbox').checked) {
      const b = map.getBounds();
      q.set('bbox', [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => v.toFixed(5)).join(','));
    }
    if ($('sp-x-from').value) q.set('from', $('sp-x-from').value);
    if ($('sp-x-to').value) q.set('to', $('sp-x-to').value);
    return q;
  }

  let countToken = 0;
  async function updateExport() {
    if (!hs.open || hs.tab !== 'export') return;
    $('sp-x-species').disabled = [ALL_NEO, ALL].includes(hs.selected);
    const q = exportQuery();
    $('sp-dl-dwc').href = `/api/export/dwc.csv?${q}`;
    $('sp-dl-inat').href = `/api/export/inaturalist.csv?${q}`;
    const token = ++countToken;
    try {
      const occ = await api(`/api/occurrences?${q}`);
      if (token === countToken) $('sp-x-count').textContent = occ.length === 1 ? '1 Fund wird exportiert.' : `${fmt(occ.length)} Funde werden exportiert.`;
    } catch (err) {
      if (token === countToken) $('sp-x-count').textContent = err.message;
    }
  }

  /* ---------- State changes ---------- */

  async function refresh() {
    if (!hs.open) return;
    stopPlay();
    pointLayer.clearLayers();
    frontLayer.clearLayers();
    if (hs.tab === 'hotspots') {
      density.addTo(map);
      await loadOccurrences();
    } else {
      density.remove();
    }
    if (hs.tab === 'spread') {
      const name = selectedSpread();
      try {
        hs.spreadOcc = name ? await api(`/api/occurrences?species=${encodeURIComponent(name)}&minScore=${hs.minScore}`) : [];
      } catch {
        hs.spreadOcc = [];
      }
      await loadSpread();
    }
    if (hs.tab === 'export') {
      updateExport();
    }
  }

  function setTab(tab) {
    hs.tab = tab;
    for (const b of document.querySelectorAll('#speciespanel [role="tab"]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    $('sp-hotspots').hidden = tab !== 'hotspots';
    $('sp-spread').hidden = tab !== 'spread';
    $('sp-export').hidden = tab !== 'export';
    refresh();
  }

  function setYear(i) {
    hs.yearIndex = i;
    renderSpread();
    drawFronts();
  }

  function stopPlay() {
    clearInterval(hs.playing);
    hs.playing = null;
    const b = $('sp-play');
    if (b) { b.textContent = '▶'; b.setAttribute('aria-label', 'Jahre abspielen'); }
  }

  async function toggle(open) {
    hs.open = open;
    $('speciespanel').hidden = !open;
    $('species-toggle').setAttribute('aria-expanded', String(open));
    if (open) {
      // Only one map panel at a time.
      if ($('sun-toggle')?.getAttribute('aria-expanded') === 'true') $('sun-toggle').click();
      pointLayer.addTo(map);
      frontLayer.addTo(map);
      // The findings replace the spot pins while the mode is open.
      hs.hidPins = map.hasLayer(state.markers);
      if (hs.hidPins) state.markers.remove();
      await loadSpecies();
      refresh();
    } else {
      stopPlay();
      density.remove();
      pointLayer.remove();
      frontLayer.remove();
      if (hs.hidPins) state.markers.addTo(map);
      hs.hidPins = false;
    }
  }

  buildPanel();
  renderLegend();
  $('species-toggle').addEventListener('click', () => toggle(!hs.open));
  $('sp-close').addEventListener('click', () => toggle(false));
  $('sun-toggle')?.addEventListener('click', () => {
    if (hs.open && $('sun-toggle').getAttribute('aria-expanded') === 'true') toggle(false);
  });
  for (const b of document.querySelectorAll('#speciespanel [role="tab"]')) b.addEventListener('click', () => setTab(b.dataset.tab));
  $('sp-species').addEventListener('change', (e) => { hs.selected = e.target.value; refresh(); });
  $('sp-minscore').addEventListener('change', async (e) => {
    const v = Number(e.target.value);
    if (!Number.isFinite(v) || v < 0 || v > 1) { e.target.value = String(hs.minScore); return; }
    hs.minScore = v;
    await loadSpecies();
    refresh();
  });
  $('sp-bw').addEventListener('input', (e) => {
    hs.bandwidth = Number(e.target.value);
    $('sp-bw-out').textContent = `${hs.bandwidth} m`;
    density.redraw();
  });
  $('sp-year').addEventListener('input', (e) => { stopPlay(); setYear(Number(e.target.value)); });
  $('sp-years').addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-i]');
    if (row) { stopPlay(); setYear(Number(row.dataset.i)); }
  });
  $('sp-play').addEventListener('click', () => {
    if (hs.playing) return stopPlay();
    const n = hs.spread?.years.length || 0;
    if (n < 2) return;
    $('sp-play').textContent = '❚❚';
    $('sp-play').setAttribute('aria-label', 'Anhalten');
    if (hs.yearIndex >= n - 1) setYear(0);
    hs.playing = setInterval(() => {
      if (hs.yearIndex >= n - 1) return stopPlay();
      setYear(hs.yearIndex + 1);
    }, 1100);
  });
  for (const id of ['sp-x-neo', 'sp-x-species', 'sp-x-bbox', 'sp-x-from', 'sp-x-to']) $(id).addEventListener('change', updateExport);
  map.on('moveend', () => { if ($('sp-x-bbox').checked) updateExport(); });
  // Re-colour when the colour scheme changes.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (!hs.open) return;
    density.redraw();
    renderSpread();
    drawFronts();
    renderLegend();
  });
}());
