/**
 * Landschaft im Wandel (landschaft.html): the valley as a section, from the last ice age to 2100, told in its
 * own words; three pathways of the human influence side by side; and the open data. The model, numbers and
 * sources are in landschaft-model.js.
 */
(() => {
  'use strict';

  const M = window.LandschaftModel;
  const $ = (id) => document.getElementById(id);
  const SVG = 'http://www.w3.org/2000/svg';
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const state = { pos: M.TODAY_POS, scenario: 'mid', playing: false, timer: null, wegeYear: 2100, audience: 'gemeinde' };

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'text') node.textContent = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(children)) if (c) node.append(c);
    return node;
  }
  function svg(tag, attrs = {}) {
    const node = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) node.setAttribute(k, v);
    return node;
  }
  const pts = (list) => list.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

  /* ---------- The section ---------- */

  /** Draws the section of `st` (from M.at) into the svg `target`; `small` leaves out labels and the grid. */
  function drawSection(target, st, { small = false } = {}) {
    const s = M.section(st);
    const keep = target.querySelector('title');
    target.replaceChildren(...(keep ? [keep] : []));
    target.append(svg('rect', { x: 0, y: 0, width: s.width, height: s.height, fill: '#1f3238' }));
    if (!small) for (const g of s.grid) target.append(svg('line', { x1: 0, y1: g.y, x2: s.width, y2: g.y, stroke: '#eef0e6', 'stroke-opacity': 0.08 }));
    target.append(svg('polygon', { points: pts(s.terrain), fill: '#5b5146' }));
    for (const b of s.belts) target.append(svg('line', { x1: b.x1, y1: b.y1.toFixed(1), x2: b.x2, y2: b.y2.toFixed(1), stroke: b.color, 'stroke-width': small ? 18 : 14, 'stroke-linecap': 'round' }));
    for (const t of s.trees) {
      const z = small ? t.size * 1.5 : t.size;
      target.append(svg('polygon', { points: pts([[t.x - z * 0.6, t.y], [t.x + z * 0.6, t.y], [t.x, t.y - z * 1.8]]), fill: t.color }));
    }
    if (s.glacier) target.append(svg('polygon', { points: pts(s.glacier), fill: '#e9f1f6', 'fill-opacity': 0.95 }));
    target.append(svg('polyline', { points: pts(s.lia), fill: 'none', stroke: '#e9f1f6', 'stroke-width': small ? 3 : 2, 'stroke-dasharray': '6 6', opacity: 0.6 }));
    if (st.treeline >= 1000) {
      target.append(svg('line', { x1: small ? 0 : 64, y1: s.treelineY.toFixed(1), x2: s.width, y2: s.treelineY.toFixed(1), stroke: '#f2b48f', 'stroke-width': small ? 3 : 2, 'stroke-dasharray': '10 7' }));
      if (!small) {
        const t = svg('text', { x: 72, y: (s.treelineY - 8).toFixed(1), class: 'ln-treeline' });
        t.textContent = `Waldgrenze nach Klima ≈ ${Math.round(st.treeline / 50) * 50} m`;
        target.append(t);
      }
    }
    for (const n of s.newcomers) if (n.r > 0.5) target.append(svg('circle', { cx: n.x, cy: n.y.toFixed(1), r: n.r.toFixed(1), fill: '#b98be6', stroke: '#d7b8f5', 'stroke-width': 1.5 }));
    if (s.village) {
      const g = svg('g', { fill: '#eef0e6' });
      g.append(svg('rect', { x: s.village.x - 14, y: (s.village.y - 11).toFixed(1), width: 9, height: 8 }));
      g.append(svg('rect', { x: s.village.x - 3, y: (s.village.y - 14).toFixed(1), width: 11, height: 11 }));
      target.append(g);
    }
    if (!small) {
      // Labels inside the rock, below the surface, so they never meet the treeline or the ice.
      for (const p of s.places) {
        const right = p.x > 800;
        const t = svg('text', { x: right ? p.x - 4 : p.x + 6, y: (p.y + 30).toFixed(1), class: 'ln-place-label', 'text-anchor': right ? 'end' : 'start' });
        t.textContent = p.label;
        target.append(t);
      }
      for (const g of s.grid) {
        const t = svg('text', { x: 10, y: (g.y - 6).toFixed(1), class: 'ln-axis' });
        t.textContent = `${g.h} m`;
        target.append(t);
      }
    }
  }

  /* ---------- Zeitraffer ---------- */

  const stopsEl = $('ln-stops');
  const scenariosEl = $('ln-scenarios');

  function renderLapse() {
    const st = M.at(state.pos, state.scenario);
    const stop = st.stop;
    const sc = M.SCENARIOS[state.scenario];
    drawSection($('ln-section'), st);
    $('ln-section-title').textContent = `Schnitt durch das Tal vom Gipfel bis zur Rhone, ${stop.when}`;
    $('ln-when').textContent = stop.when;
    $('ln-when-small').textContent = stop.when;
    $('ln-kind').textContent = st.future ? sc.long : stop.kind;
    $('ln-kind').style.color = st.future ? sc.color : '';
    if ($('ln-voice').dataset.stop !== `${stop.id}:${state.scenario}`) {
      $('ln-voice').dataset.stop = `${stop.id}:${state.scenario}`;
      $('ln-voice').textContent = `«${stop.voice}»`;
      $('ln-facts').replaceChildren(...stop.facts.map((f) => el('li', { text: f })));
    }
    $('ln-forces').replaceChildren(...st.forces.map((f) => el('li', { class: f.level ? '' : 'faint' }, [
      el('span', { class: 'ln-force-name' }, [el('span', { class: 'dot', style: `background:${f.color}` }), f.label]),
      el('span', { class: 'ln-meter', role: 'img', 'aria-label': `${f.label}: ${['kaum', 'schwach', 'mittel', 'stark'][f.level]}` },
        [1, 2, 3].map((n) => el('span', { style: n <= f.level ? `background:${f.color}` : '' }))),
    ])));
    $('ln-pos').value = String(state.pos);
    for (const b of stopsEl.children) b.setAttribute('aria-current', String(b.dataset.id === stop.id));
    for (const b of scenariosEl.children) {
      const on = b.dataset.id === state.scenario;
      b.setAttribute('aria-pressed', String(on));
      b.style.background = on ? M.SCENARIOS[b.dataset.id].color : '';
    }
    $('ln-play').classList.toggle('playing', state.playing);
    $('ln-play').setAttribute('aria-label', state.playing ? 'Zeitraffer anhalten' : 'Zeitraffer abspielen');
  }

  function stop() {
    clearInterval(state.timer);
    state.playing = false;
    renderLapse();
  }
  function play() {
    if (state.playing) return stop();
    if (state.pos >= M.MAX_POS) state.pos = 0;
    state.playing = true;
    // The ice-age millennia go by quicker than the decades on the right.
    state.timer = setInterval(() => {
      state.pos = Math.min(M.MAX_POS, state.pos + (reduceMotion ? 10 : 2));
      if (state.pos >= M.MAX_POS) stop(); else renderLapse();
    }, reduceMotion ? 250 : 50);
    renderLapse();
    return undefined;
  }

  M.stops(state.scenario).forEach((s, k) => stopsEl.append(el('button', {
    type: 'button', 'data-id': s.id, 'aria-label': s.when,
    on: { click: () => { if (state.playing) stop(); state.pos = k * M.STEPS; renderLapse(); } },
  }, [el('span', { class: 'long', text: s.label }), el('span', { class: 'short', text: s.short || s.label })])));
  for (const [id, s] of Object.entries(M.SCENARIOS)) {
    scenariosEl.append(el('button', {
      type: 'button', 'data-id': id, text: s.label, style: `border-color:${s.color}`,
      on: { click: () => { state.scenario = id; renderLapse(); renderWege(); } },
    }));
  }
  $('ln-pos').addEventListener('input', (e) => { if (state.playing) stop(); state.pos = Number(e.target.value); renderLapse(); });
  $('ln-play').addEventListener('click', play);

  /* ---------- Drei Wege ---------- */

  function renderWege() {
    const year = state.wegeYear;
    $('ln-wege-year').textContent = String(year);
    $('ln-wege-years').replaceChildren(...[2050, 2100].map((y) => el('button', {
      type: 'button', text: String(y), 'aria-pressed': String(y === year),
      on: { click: () => { state.wegeYear = y; renderWege(); } },
    })));
    const pos = year === 2050 ? M.STEPS * 5 : M.MAX_POS;
    $('ln-wege-cards').replaceChildren(...Object.entries(M.SCENARIOS).map(([id, s]) => {
      const st = M.at(pos, id);
      const pic = svg('svg', { viewBox: '0 0 1000 560', role: 'img', 'aria-label': `${s.long}: Schnitt durch das Tal im Jahr ${year}` });
      drawSection(pic, st, { small: true });
      return el('a', { class: 'ln-card', href: '#zeitraffer', style: `border-color:${s.color}`, on: { click: () => { state.scenario = id; state.pos = pos; } } }, [
        el('div', { class: 'ln-card-head' }, [el('span', {}, [el('span', { class: 'dot', style: `background:${s.color}` }), s.long]), el('span', { class: 'muted', text: s.ssp })]),
        pic,
        el('blockquote', { text: `«${st.stop.voice}»` }),
        el('dl', {}, [
          el('div', {}, [el('dt', { text: 'Welt gegenüber 1850–1900' }), el('dd', { text: `+${M.fmt(st.stop.global)} °C` })]),
          el('div', {}, [el('dt', { text: 'Waldgrenze nach Klima' }), el('dd', { text: `≈ ${Math.round(st.treeline / 50) * 50} m` })]),
        ]),
      ]);
    }));
  }

  /* ---------- Daten holen ---------- */

  const OFFERS = {
    gemeinde: [
      ['Karte im eigenen Geoportal', 'WMS, WMTS und WFS', 'Das fertige QGIS-Projekt veröffentlicht alles in den Farben der App, deckungsgleich mit der Landeskarte.', 'QGIS-Projekt', 'https://github.com/michifrey/myforrest/blob/main/deploy/qgis-server/README.md'],
      ['Für den Forstdienst', 'GeoPackage in LV95', 'Alle Collections in einer Datei, direkt in QGIS oder ArcGIS öffnen.', 'Herunterladen', '/api/export/myforrest.gpkg'],
      ['Für Berichte', 'Klima-Dossier des Orts', 'Messreihen, Klimaszenarien CH2025 und was sie für den Wald heissen.', 'Dossier öffnen', './?funktion=klima'],
    ],
    schule: [
      ['Im Unterricht', 'Zeitraffer von der Eiszeit bis 2100', 'Das Tal erzählt selbst, mit drei Wegen zum Vergleichen und den Quellen dazu.', 'Zeitraffer', '#zeitraffer'],
      ['Selbst auswerten', 'Tabelle statt GIS', 'Funde als CSV und GeoJSON, für Tabellenkalkulation oder ein Notebook.', 'Funde als CSV', '/api/export/dwc.csv'],
      ['Mitmachen', 'Eigene Fotos beitragen', 'Ein Spot beim Schulhaus wird über die Jahre zur eigenen Messreihe.', 'Zur Karte', './#explore'],
    ],
    gis: [
      ['Cloud-native', 'GeoParquet und STAC', 'Jede Collection als GeoParquet 1.1, beschrieben in einem statischen STAC-Katalog.', 'Katalog', '/stac/catalog.json'],
      ['Dienste', 'OGC API Features und Tiles', 'Auch im Kachelgitter von swisstopo (LV95), mit MapLibre-Stil.', 'Landing Page', '/ogc'],
      ['Programmierbar', 'REST-API', 'Spots, Fotos und Funde lesen und schreiben, mit API-Schlüssel.', 'API-Doku', 'https://michifrey.github.io/myforrest/api/'],
    ],
  };
  const AUDIENCES = [['gemeinde', 'Gemeinde und Forst'], ['schule', 'Schule'], ['gis', 'GIS und Entwicklung']];
  const COLLECTIONS = [
    ['spots', 'Spots', 'Orte mit Wiederholungsfotos, Befund und Blickrichtung'],
    ['photos', 'Fotos', 'Einzelne Fotos mit Zeit, Tags und Lizenz'],
    ['findings', 'Pflanzenfunde', 'Bestimmungen mit Pl@ntNet, Neophyten markiert'],
    ['spread_fronts', 'Ausbreitungsfronten', 'Besiedelte Fläche pro Art und Jahr'],
  ];

  function renderDaten() {
    $('ln-audience').replaceChildren(...AUDIENCES.map(([id, label]) => el('button', {
      type: 'button', role: 'tab', text: label, 'aria-selected': String(id === state.audience),
      on: { click: () => { state.audience = id; renderDaten(); } },
    })));
    $('ln-offers').replaceChildren(...OFFERS[state.audience].map(([kicker, title, text, cta, href]) => el('article', { class: 'ln-offer' }, [
      el('span', { class: 'ln-label', text: kicker }),
      el('h3', { text: title }),
      el('p', { text }),
      el('a', { href, text: `${cta} →` }),
    ])));
  }
  $('ln-rows').replaceChildren(...COLLECTIONS.map(([id, title, text]) => el('tr', {}, [
    el('th', { scope: 'row', text: title }),
    el('td', { text }),
    el('td', {}, [el('a', { href: `/api/export/parquet/${id}.parquet`, text: 'WGS84' }), ' · ', el('a', { href: `/api/export/parquet/${id}.parquet?crs=2056`, text: 'LV95' })]),
    el('td', {}, [el('a', { href: `/api/export/geojson/${id}.geojson`, text: 'Datei' })]),
    el('td', {}, [el('a', { href: `/ogc/collections/${id}/items`, text: 'Items' })]),
  ])));
  $('ln-code').textContent = `-- DuckDB, direkt aus dem Netz
INSTALL spatial; LOAD spatial;
SELECT scientific_name, count(*) AS funde
FROM '${location.origin}/api/export/parquet/findings.parquet'
WHERE neophyte = 1
GROUP BY 1 ORDER BY 2 DESC;

# Der ganze Katalog als Ordner (auf dem Server)
npm run stac -- ./myforrest-stac ${location.origin}`;

  /* ---------- Sources and views ---------- */

  $('ln-sources').replaceChildren(...Object.values(M.SOURCES).map((s) => el('li', {}, [el('a', { href: s.url, rel: 'noopener', target: '_blank', text: s.label })])));

  function showView() {
    const id = (location.hash.replace('#', '') || 'zeitraffer');
    const view = ['zeitraffer', 'wege', 'daten'].includes(id) ? id : 'zeitraffer';
    for (const s of document.querySelectorAll('.ln-view')) s.hidden = s.id !== view;
    for (const a of document.querySelectorAll('.ln-tabs a[data-view]')) a.setAttribute('aria-current', a.dataset.view === view ? 'page' : 'false');
    if (view !== 'zeitraffer' && state.playing) stop();
    if (view === 'zeitraffer') renderLapse();
  }
  window.addEventListener('hashchange', showView);
  renderWege();
  renderDaten();
  showView();
})();
