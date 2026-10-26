/**
 * Landschaft im Wandel (landschaft.html): official maps through time over the Landeskarte, map themes from
 * geo.admin.ch, and a report per place (climate, glaciers and water, forest, agriculture and soil, what MyForrest
 * saw there). Maps and the report data come from /api/landschaft (routes/landschaft.js), the climate part from the
 * climate dossier /api/klima.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const CH = L.latLngBounds([45.7, 5.7], [47.95, 10.7]);
  const state = { maps: null, place: null, report: null, timeline: 'heute', theme: '', audience: 'gemeinde' };

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'text') node.textContent = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(children)) if (c !== null && c !== undefined && c !== false) node.append(c);
    return node;
  }
  const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toLocaleString('de-CH', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–');
  const signed = (v, d = 1) => (Number.isFinite(v) ? `${v > 0 ? '+' : v < 0 ? '−' : '±'}${fmt(Math.abs(v), d)}` : '–');
  async function api(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    return r.json();
  }
  const swisstopo = (layer) => L.tileLayer(`https://wmts.geo.admin.ch/1.0.0/${layer}/default/current/3857/{z}/{x}/{y}.jpeg`, {
    maxZoom: 19, maxNativeZoom: 18, bounds: CH, attribution: '© <a href="https://www.swisstopo.admin.ch/">swisstopo</a>',
  });
  const wms = (layer, opacity) => L.tileLayer.wms(layer.url, {
    layers: layer.name, format: 'image/png', transparent: true, version: '1.3.0', opacity, attribution: layer.attribution || '© geo.admin.ch',
  });

  /* ---------- Karte ---------- */

  const map = L.map('ln-map', { zoomControl: true, maxBounds: CH.pad(0.3) }).setView([46.8, 8.2], 8);
  swisstopo('ch.swisstopo.pixelkarte-grau').addTo(map);
  let timeLayer = null;
  let themeLayer = null;
  let marker = null;

  /* The «Zeitreise»: the Landeskarte of one year, a slider over the years and a play button. */
  const zeit = { index: 0, timer: null };
  const zeitTiles = (z, time) => z.tiles.replace('{time}', time);
  function stopPlaying() {
    clearInterval(zeit.timer);
    zeit.timer = null;
    $('ln-zeit-play')?.setAttribute('aria-label', 'Jahre abspielen');
    $('ln-zeit-play')?.classList.remove('playing');
  }
  function setYear(stop, index) {
    const years = stop.zeitreise.years;
    zeit.index = Math.max(0, Math.min(years.length - 1, index));
    const y = years[zeit.index];
    timeLayer?.setUrl(zeitTiles(stop.zeitreise, y.time));
    $('ln-zeit-year').textContent = String(y.year);
    $('ln-zeit-range').value = String(zeit.index);
    // The year in the address, so the view can be shared.
    const q = new URLSearchParams(state.place ? { lat: state.place.lat, lon: state.place.lon } : {});
    q.set('jahr', y.year);
    history.replaceState(null, '', `#karte?${q}`);
  }
  function zeitControls(stop) {
    const years = stop.zeitreise.years;
    const play = () => {
      if (zeit.timer) return stopPlaying();
      if (zeit.index >= years.length - 1) setYear(stop, 0);
      $('ln-zeit-play').setAttribute('aria-label', 'Anhalten');
      $('ln-zeit-play').classList.add('playing');
      // One year every 1.2 s: time for the tiles of the next year to arrive.
      zeit.timer = setInterval(() => {
        if (zeit.index >= years.length - 1) stopPlaying(); else setYear(stop, zeit.index + 1);
      }, 1200);
      return undefined;
    };
    return el('div', { class: 'ln-zeit' }, [
      el('div', { class: 'ln-zeit-row' }, [
        el('button', { type: 'button', id: 'ln-zeit-play', class: 'ln-play', 'aria-label': 'Jahre abspielen', on: { click: play } }),
        el('output', { id: 'ln-zeit-year', for: 'ln-zeit-range', class: 'ln-zeit-year' }),
      ]),
      el('label', { class: 'sr-only', for: 'ln-zeit-range', text: 'Jahr' }),
      el('input', {
        type: 'range', id: 'ln-zeit-range', min: '0', max: String(years.length - 1), step: '1', value: String(zeit.index),
        on: { input: (e) => { stopPlaying(); setYear(stop, Number(e.target.value)); } },
      }),
      el('div', { class: 'ln-zeit-scale' }, [el('span', { text: String(years[0].year) }), el('span', { text: String(years[years.length - 1].year) })]),
    ]);
  }

  function showTimeline(id, { year = null } = {}) {
    state.timeline = id;
    stopPlaying();
    const stop = state.maps?.timeline.find((t) => t.id === id);
    timeLayer?.remove();
    timeLayer = null;
    if (stop?.layer) timeLayer = wms(stop.layer, Number($('ln-opacity').value)).addTo(map);
    if (stop?.zeitreise) {
      const years = stop.zeitreise.years;
      // Start at the year asked for (link), else around 1900.
      const want = year ?? 1900;
      zeit.index = years.reduce((best, y, i) => (Math.abs(y.year - want) < Math.abs(years[best].year - want) ? i : best), 0);
      timeLayer = L.tileLayer(zeitTiles(stop.zeitreise, years[zeit.index].time), {
        maxZoom: 19, maxNativeZoom: 18, bounds: CH, opacity: Number($('ln-opacity').value), attribution: stop.zeitreise.attribution,
      }).addTo(map);
    }
    for (const b of $('ln-timeline').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.id === id));
    $('ln-time-info').replaceChildren(...(stop ? [
      el('strong', { text: `${stop.title} · ${stop.when}` }),
      el('p', { text: stop.text }),
      stop.zeitreise ? zeitControls(stop) : null,
      stop.layer ? el('img', { src: stop.layer.legend, alt: `Legende: ${stop.title}`, loading: 'lazy', class: 'ln-legend', on: { error: (e) => e.target.remove() } }) : null,
    ].filter(Boolean) : []));
    if (stop?.zeitreise) setYear(stop, zeit.index);
  }

  function showTheme(value) {
    state.theme = value;
    themeLayer?.remove();
    themeLayer = null;
    const [t, i] = value.split(':');
    const layer = state.maps?.themes.find((x) => x.id === t)?.layers[Number(i)];
    $('ln-theme-legend').replaceChildren();
    if (!layer) return;
    themeLayer = wms(layer, 0.75).addTo(map);
    $('ln-theme-legend').append(el('img', { src: layer.legend, alt: `Legende: ${layer.title}`, loading: 'lazy', class: 'ln-legend', on: { error: (e) => e.target.remove() } }));
  }

  async function loadMaps() {
    try {
      state.maps = await api('/api/landschaft/karten');
    } catch (err) {
      $('ln-status').textContent = `Karten nicht verfügbar: ${err.message}`;
      state.maps = { timeline: [{ id: 'heute', base: true, when: 'heute', title: 'Landeskarte', text: 'Die aktuelle Landeskarte von swisstopo.' }], themes: [] };
    }
    $('ln-timeline').replaceChildren(...state.maps.timeline.map((t) => el('button', {
      type: 'button', role: 'radio', 'data-id': t.id, 'aria-checked': 'false', on: { click: () => showTimeline(t.id) },
    }, [el('span', { class: 'ln-when', text: t.when }), el('span', { text: t.title })])));
    const options = [el('option', { value: '', text: 'kein Thema' })];
    for (const t of state.maps.themes) {
      if (!t.layers.length) continue;
      options.push(el('optgroup', { label: t.title }, t.layers.map((l, i) => el('option', { value: `${t.id}:${i}`, text: l.title }))));
    }
    $('ln-themes').replaceChildren(...[
      el('label', { class: 'sr-only', for: 'ln-theme', text: 'Thema' }),
      el('select', { id: 'ln-theme', on: { change: (e) => showTheme(e.target.value) } }, options),
      el('div', { id: 'ln-theme-legend' }),
      state.maps.themes.some((t) => t.layers.length) ? null : el('p', { class: 'ln-muted', text: 'Keine Themenkarten verfügbar.' }),
    ].filter(Boolean));
    const year = Number(new URLSearchParams(location.hash.split('?')[1] || '').get('jahr'));
    if (year && state.maps.timeline.some((t) => t.id === 'zeitreise')) showTimeline('zeitreise', { year });
    else showTimeline(state.maps.timeline.some((t) => t.id === state.timeline) ? state.timeline : 'heute');
  }

  function setPlace(lat, lon, { pan = false } = {}) {
    state.place = { lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5 };
    if (!marker) marker = L.marker([lat, lon]).addTo(map);
    marker.setLatLng([lat, lon]);
    if (pan) map.setView([lat, lon], 11);
    $('ln-place').textContent = `${fmt(state.place.lat, 4)}° N, ${fmt(state.place.lon, 4)}° O`;
    $('ln-to-report').href = `#bericht?lat=${state.place.lat}&lon=${state.place.lon}`;
    document.querySelector('.ln-tabs a[data-view="bericht"]').href = $('ln-to-report').href;
    $('ln-to-report').hidden = false;
  }
  map.on('click', (e) => setPlace(e.latlng.lat, e.latlng.lng));
  $('ln-opacity').addEventListener('input', (e) => timeLayer?.setOpacity(Number(e.target.value)));

  /* ---------- Bericht ---------- */

  let reportMap = null;
  const section = (title, children) => el('section', { class: 'ln-section' }, [el('h2', { text: title }), ...children]);
  const empty = (text) => el('p', { class: 'ln-muted', text });
  const items = (list) => list.map((it) => el('div', { class: 'ln-item' }, [
    el('h3', { text: it.title }),
    el('dl', {}, it.attributes.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })])),
  ]));
  const theme = (r, id) => r.themes.find((t) => t.id === id) || { items: [], layers: [] };
  const change = (d, key) => d?.climate?.changes?.find((c) => c.key === key);

  function changeRows(d, keys) {
    const rows = keys.map((k) => change(d, k)).filter((c) => c && Number.isFinite(c.delta));
    if (!rows.length) return null;
    const digits = (c) => d.indicators?.[c.key]?.digits ?? 0;
    const p = d.climate.periods;
    return el('table', {}, [
      el('thead', {}, el('tr', {}, [el('th', { text: 'Kennzahl' }), el('th', { text: p.ref.join('–') }), el('th', { text: p.recent.join('–') }), el('th', { text: 'Änderung' })])),
      el('tbody', {}, rows.map((c) => el('tr', {}, [
        el('td', { text: c.label }),
        el('td', { text: `${fmt(c.ref, digits(c))} ${c.unit}` }),
        el('td', { text: `${fmt(c.recent, digits(c))} ${c.unit}` }),
        el('td', { text: `${signed(c.delta, digits(c))}${Number.isFinite(c.percent) ? ` (${signed(c.percent, 0)} %)` : ''}` }),
      ]))),
    ]);
  }

  function levelsTable(levels) {
    if (!levels?.length) return null;
    const get = (l, k) => l.indicators.find((i) => i.key === k);
    const cell = (l, k, d = 0) => { const i = get(l, k); return i && Number.isFinite(i.value) ? `${fmt(i.normal, d)} → ${fmt(i.value, d)} ${i.unit}` : '–'; };
    return el('table', {}, [
      el('thead', {}, el('tr', {}, [el('th', { text: 'Globale Erwärmung' }), el('th', { text: 'Jahresmittel' }), el('th', { text: 'Hitzetage' }), el('th', { text: 'Sommerregen' }), el('th', { text: 'Höhenverschiebung' })])),
      el('tbody', {}, levels.map((l) => el('tr', {}, [
        el('td', {}, [el('strong', { text: l.title }), el('br'), el('span', { class: 'ln-muted small', text: l.when })]),
        el('td', { text: cell(l, 'tmean', 1) }),
        el('td', { text: cell(l, 'hotDays') }),
        el('td', { text: cell(l, 'summerP') }),
        el('td', { text: Number.isFinite(l.shiftM) ? `${fmt(l.shiftM)} m` : '–' }),
      ]))),
    ]);
  }

  function renderReport(r, d, dError) {
    const body = [];
    const c = d?.climate;

    // Klima
    body.push(section('Klima', c ? [
      el('p', {}, [
        `Die Jahre ${c.periods.recent.join('–')} waren am Ort im Mittel `, el('strong', { text: `${signed(c.warming)} °C` }),
        ` wärmer als ${c.periods.ref.join('–')}; der Trend seit ${c.first} beträgt ${signed(c.trendPerDecade, 2)} °C pro Jahrzehnt.`,
        d.station?.name ? ` Nächste homogene Messreihe: ${d.station.name}.` : '',
      ]),
      changeRows(d, ['tmean', 'summerT', 'hotDays', 'tropicalNights', 'frostDays', 'snowDays', 'summerP', 'dryRun']),
      d.levels?.length ? el('h3', { text: 'Szenarien: was +1,5, +2 und +3 °C weltweit hier bedeuten' }) : null,
      levelsTable(d.levels),
      ...items(theme(r, 'klima').items),
    ] : [empty(dError ? `Klimadaten nicht verfügbar: ${dError}` : 'Keine Klimadaten für diesen Ort.'), ...items(theme(r, 'klima').items)]));

    // Gletscher und Wasser
    const g = r.glacier;
    const water = theme(r, 'wasser');
    body.push(section('Gletscher und Wasser', [
      g ? el('div', { class: 'ln-item' }, [
        el('h3', { text: g.name || 'Gletscher in der Nähe' }),
        el('p', { text: g.distanceM === 0 ? `Der Ort liegt auf dem Eis des Inventars ${g.latestYear}.` : Number.isFinite(g.distanceM) ? `Abstand zum Eis des Inventars ${g.latestYear}: ${fmt(g.distanceM)} m.` : '' }),
        g.history?.length ? el('p', { text: `Eis am Ort: ${g.history.map((h) => `${h.year ?? '?'} ${h.ice ? 'ja' : 'nein'}`).join(' · ')}` }) : null,
        g.length ? el('p', { text: `Längenänderung der Zunge (GLAMOS) ${g.length.firstYear}–${g.length.lastYear}: ${signed(g.length.total, 0)} m${Number.isFinite(g.length.recentRate) ? `, zuletzt ${signed(g.length.recentRate, 1)} m pro Jahr` : ''}.` }) : null,
      ]) : null,
      changeRows(d, ['snowDays', 'summerP', 'winterP', 'dryRun']),
      ...items(water.items),
      !g && !water.items.length && !change(d, 'snowDays') ? empty('Für diesen Ort sagen die Gletscherinventare und Wasserkarten nichts.') : null,
    ]));

    // Wald
    const forest = theme(r, 'wald');
    body.push(section('Wald', [
      ...items(forest.items),
      ...(d?.forest || []).map((f) => el('div', { class: 'ln-item' }, [
        el('h3', { text: f.title }),
        el('p', { text: f.text }),
        f.levels ? el('p', { class: 'ln-muted small', text: Object.entries(f.levels).map(([k, v]) => `${k.replace('GWL', '+')} °C: ${v}`).join(' · ') }) : null,
      ])),
      d?.species?.length ? el('p', { text: `Baumarten der Spots in der Region: ${d.species.map((s) => s.name || s.scientificName).join(', ')}.` }) : null,
      !forest.items.length && !d?.forest?.length ? empty('Für diesen Ort sagen die Waldkarten nichts.') : null,
    ]));

    // Landwirtschaft und Boden
    const soil = theme(r, 'boden');
    body.push(section('Landwirtschaft und Boden', [
      ...items(soil.items),
      changeRows(d, ['growingDays', 'summerP', 'dryRun', 'hotDays']),
      !soil.items.length ? empty('Für diesen Ort sagen die Karten zu Bodennutzung und Landwirtschaft nichts.') : null,
    ]));

    // Beobachtungen
    const o = r.observed;
    body.push(section(`Was MyForrest im Umkreis von ${o.radiusKm} km sah`, o.photos ? [
      el('p', { text: `${fmt(o.photos)} Fotos an ${fmt(o.spots)} Spots${o.firstYear ? `, ${o.firstYear === o.lastYear ? o.firstYear : `${o.firstYear}–${o.lastYear}`}` : ''}.` }),
      o.tags.length ? el('p', { text: `Befunde: ${o.tags.map((t) => `${t.label || t.tag} (${t.spots} Spot${t.spots === 1 ? '' : 's'})`).join(', ')}.` }) : null,
      o.neophytes.length ? el('p', { text: `Neophyten: ${o.neophytes.map((n) => `${n.common || n.name} (${n.n})`).join(', ')}.` }) : null,
    ] : [empty('Noch keine Fotos in der Nähe. Ein Foto beitragen macht den Ort zur eigenen Messreihe.')]));

    // Quellen
    const used = r.themes.flatMap((t) => t.layers).filter((l, i, a) => a.findIndex((x) => x.name === l.name) === i);
    body.push(section('Quellen', [el('ul', { class: 'ln-sources' }, [
      ...(d?.sources ? Object.values(d.sources).filter(Boolean).map((s) => el('li', { text: s })) : []),
      ...(d?.levels?.length ? [el('li', { text: 'Klimaszenarien CH2025 (MeteoSchweiz, ETH Zürich, NCCS) und IPCC AR6, wo am Ort geladen; sonst Klimamodelle, skaliert mit der globalen Erwärmung' })] : []),
      ...used.map((l) => el('li', { text: `${l.title} (${l.name}), ${l.attribution || 'geo.admin.ch'}` })),
      r.glacier ? el('li', { text: 'Gletscherinventare und GLAMOS (Glacier Monitoring Switzerland)' }) : null,
      el('li', { text: 'Fotos und Funde von MyForrest (CC BY-SA 4.0 oder die Lizenz des Fotos)' }),
    ])]));
    $('ln-report-body').replaceChildren(...body);
  }

  async function showReport(lat, lon) {
    $('ln-report-title').textContent = `${fmt(lat, 4)}° N, ${fmt(lon, 4)}° O`;
    $('ln-report-meta').textContent = `Stand ${new Date().toLocaleDateString('de-CH', { day: 'numeric', month: 'long', year: 'numeric' })}`;
    $('ln-report-body').replaceChildren(el('p', { class: 'ln-muted', text: 'Daten werden zusammengestellt …' }));
    if (!reportMap) {
      reportMap = L.map('ln-report-map', { zoomControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, attributionControl: true });
      swisstopo('ch.swisstopo.pixelkarte-farbe').addTo(reportMap);
      reportMap.marker = L.marker([lat, lon]).addTo(reportMap);
    }
    reportMap.invalidateSize();
    reportMap.setView([lat, lon], 12);
    reportMap.marker.setLatLng([lat, lon]);
    const [r, d] = await Promise.allSettled([api(`/api/landschaft/bericht?lat=${lat}&lon=${lon}`), api(`/api/klima?lat=${lat}&lon=${lon}`)]);
    if (r.status !== 'fulfilled') {
      $('ln-report-body').replaceChildren(empty(`Bericht nicht verfügbar: ${r.reason.message}`));
      return;
    }
    const dossier = d.status === 'fulfilled' ? d.value : null;
    if (Number.isFinite(dossier?.centre?.elevation)) $('ln-report-title').textContent += ` · ${fmt(dossier.centre.elevation)} m ü. M.`;
    renderReport(r.value, dossier, d.status === 'fulfilled' ? dossier.climateError : d.reason.message);
  }
  $('ln-print').addEventListener('click', () => window.print());

  /* ---------- Daten holen ---------- */

  const OFFERS = {
    gemeinde: [
      ['Karte im eigenen Geoportal', 'WMS, WMTS und WFS', 'Das fertige QGIS-Projekt veröffentlicht alles in den Farben der App, deckungsgleich mit der Landeskarte.', 'QGIS-Projekt', 'https://github.com/michifrey/myforrest/blob/main/deploy/qgis-server/README.md'],
      ['Für den Forstdienst', 'GeoPackage in LV95', 'Alle Collections in einer Datei, direkt in QGIS oder ArcGIS öffnen.', 'Herunterladen', '/api/export/myforrest.gpkg'],
      ['Für Berichte', 'Bericht pro Ort', 'Klima, Gletscher und Wasser, Wald, Landwirtschaft und Boden an einem Ort, zum Drucken.', 'Bericht', '#karte'],
    ],
    schule: [
      ['Im Unterricht', 'Karten durch die Zeit', 'Eiszeit, Dufour- und Siegfriedkarte, Landeskarte und die Waldhöhenstufen 2085 am eigenen Ort.', 'Zur Karte', '#karte'],
      ['Selbst auswerten', 'Tabelle statt GIS', 'Funde als CSV und GeoJSON, für Tabellenkalkulation oder ein Notebook.', 'Funde als CSV', '/api/export/dwc.csv'],
      ['Mitmachen', 'Eigene Fotos beitragen', 'Ein Spot beim Schulhaus wird über die Jahre zur eigenen Messreihe.', 'Zur Karte von MyForrest', './#explore'],
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
      el('span', { class: 'ln-eyebrow', text: kicker }), el('h3', { text: title }), el('p', { text }), el('a', { href, text: `${cta} →` }),
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
GROUP BY 1 ORDER BY 2 DESC;`;

  /* ---------- Views ---------- */

  function showView() {
    const [id, query] = location.hash.replace('#', '').split('?');
    const view = ['karte', 'bericht', 'daten'].includes(id) ? id : 'karte';
    for (const s of document.querySelectorAll('.ln-view')) s.hidden = s.id !== view;
    for (const a of document.querySelectorAll('.ln-tabs a[data-view]')) a.setAttribute('aria-current', a.dataset.view === view ? 'page' : 'false');
    const q = new URLSearchParams(query || '');
    const lat = Number(q.get('lat'));
    const lon = Number(q.get('lon'));
    const hasPlace = q.has('lat') && Number.isFinite(lat) && Number.isFinite(lon);
    if (hasPlace) setPlace(lat, lon, { pan: view === 'karte' });
    if (view === 'karte') setTimeout(() => map.invalidateSize(), 0);
    if (view === 'bericht' && state.place) {
      showReport(state.place.lat, state.place.lon);
    }
  }
  window.addEventListener('hashchange', showView);
  renderDaten();
  loadMaps();
  showView();
})();
