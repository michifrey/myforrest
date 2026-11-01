'use strict';

/*
 * The main map as on Outdooractive: a bar at the top with the search for places (/api/landschaft/suche) and the
 * categories of spots as chips, full screen, «Inhalt ausblenden», the name of the region in view at the bottom
 * (/api/landschaft/region), the round buttons at the bottom right («Funktionen» opens the tools), the place panel on
 * the left after a click on the map (name, height, LV95, «Route hierhin», what the layers say, the spots nearby) and
 * the base maps, path networks and extra layers as picture tiles in the panel «Karten und Ebenen».
 * Uses the globals of app.js (map, api, el, $, state, openSpot, distanceM, fmtDate, setPicked, me) and the modules
 * Basemap, Layers, Tours, Coords, GeoadminLink.
 */

(function mapUiModule() {
  const explore = $('explore');
  const ICON = (d) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 20 20');
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = d;
    return s;
  };

  /* ---------- Buttons at the bottom right: «Funktionen» opens the tools ---------- */

  const more = $('fab-more');
  const fnBtn = $('fab-functions');
  function setMore(open) {
    more.hidden = !open;
    fnBtn.setAttribute('aria-expanded', String(open));
  }
  fnBtn.addEventListener('click', () => setMore(more.hidden));
  // A tool chosen: the list closes (the tool shows itself, and its button stays marked when the list opens again).
  more.addEventListener('click', (e) => { if (e.target.closest('.fab')) setTimeout(() => setMore(false), 0); });
  document.addEventListener('click', (e) => { if (!more.hidden && !e.target.closest('#map-fabs')) setMore(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !more.hidden) { setMore(false); fnBtn.focus(); } });
  for (const b of [...more.querySelectorAll('.fab'), fnBtn, $('tours-toggle'), $('layers-toggle')]) L.DomEvent.disableClickPropagation(b);

  // The legend of the glacier outlines (glacier.js puts it after its button) beside the buttons.
  const moveLegend = () => {
    const legend = more.querySelector('.glacier-legend');
    if (legend) explore.append(legend);
  };
  new MutationObserver(moveLegend).observe(more, { childList: true });
  moveLegend();

  /* ---------- Categories: the filter of the spots as chips ---------- */

  const filter = $('tag-filter');
  function renderChips() {
    const chips = [];
    let group = null;
    for (const o of filter.querySelectorAll('option')) {
      const g = o.parentElement.tagName === 'OPTGROUP' ? o.parentElement.label : '';
      if (chips.length && g !== group) chips.push(el('span', { class: 'chip-sep', 'aria-hidden': 'true' }));
      group = g;
      chips.push(el('button', {
        type: 'button', 'data-value': o.value, 'aria-pressed': String(filter.value === o.value), text: o.textContent,
        title: g ? `${g}: ${o.textContent}` : o.textContent,
        onclick: () => {
          filter.value = o.value;
          filter.dispatchEvent(new Event('change'));
          markChips();
        },
      }));
    }
    $('map-chips').replaceChildren(...chips);
  }
  function markChips() {
    for (const b of $('map-chips').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.value === filter.value));
  }
  new MutationObserver(renderChips).observe(filter, { childList: true, subtree: true });
  // A filter set by a link (storm warning, satellite) shows once the spots are loaded.
  new MutationObserver(markChips).observe($('stats'), { childList: true });
  renderChips();

  /* ---------- Search for places ---------- */

  const search = { timer: null, results: [], active: -1, seq: 0 };
  const input = $('map-search-q');
  const list = $('map-search-results');
  function renderHits(note = '') {
    list.replaceChildren(...search.results.map((h, i) => el('li', {
      id: `map-hit-${i}`, role: 'option', 'aria-selected': String(i === search.active),
      onmousedown: (e) => { e.preventDefault(); choose(i); },
    }, [el('span', { text: h.label }), el('span', { class: 'kind', text: h.kind })])));
    if (note) list.append(el('li', { class: 'note', text: note }));
    list.hidden = !search.results.length && !note;
    input.setAttribute('aria-expanded', String(!list.hidden));
    if (search.active >= 0) input.setAttribute('aria-activedescendant', `map-hit-${search.active}`);
    else input.removeAttribute('aria-activedescendant');
  }
  async function runSearch(q) {
    const n = ++search.seq;
    const r = await api(`/api/landschaft/suche?q=${encodeURIComponent(q)}`).catch((err) => ({ results: [], error: err.message }));
    if (n !== search.seq) return;
    search.results = r.results;
    search.active = r.results.length ? 0 : -1;
    renderHits(r.error || (r.results.length ? '' : 'Nichts gefunden'));
  }
  function choose(i) {
    const h = search.results[i];
    if (!h) return;
    const zoom = { Kanton: 10, Bezirk: 11, Gemeinde: 13, Postleitzahl: 13, Koordinaten: 15, Adresse: 17, Parzelle: 17 }[h.kind] ?? 14;
    map.setView([h.lat, h.lon], zoom);
    input.value = h.label;
    search.results = [];
    search.active = -1;
    renderHits();
    showPlace(h.lat, h.lon, { name: h.kind === 'Koordinaten' ? null : h.label });
  }
  input.addEventListener('input', () => {
    clearTimeout(search.timer);
    const q = input.value.trim();
    if (q.length < 2) { search.seq += 1; search.results = []; renderHits(); return; }
    search.timer = setTimeout(() => runSearch(q), 250);
  });
  input.addEventListener('keydown', (e) => {
    const n = search.results.length;
    if (e.key === 'ArrowDown' && n) { e.preventDefault(); search.active = (search.active + 1) % n; renderHits(); }
    else if (e.key === 'ArrowUp' && n) { e.preventDefault(); search.active = (search.active - 1 + n) % n; renderHits(); }
    else if (e.key === 'Escape') { search.results = []; search.active = -1; renderHits(); }
  });
  input.addEventListener('blur', () => { search.results = []; search.active = -1; renderHits(); });
  $('map-search').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (q.length < 2) return;
    if (!search.results.length) { clearTimeout(search.timer); await runSearch(q); }
    choose(Math.max(0, search.active));
  });

  /* ---------- Full screen and «Inhalt ausblenden» ---------- */

  const fsBtn = $('map-fullscreen');
  function fullscreenChanged(on) {
    explore.classList.toggle('is-fullscreen', on);
    fsBtn.setAttribute('aria-pressed', String(on));
    fsBtn.setAttribute('aria-label', on ? 'Vollbild beenden' : 'Vollbild');
    fsBtn.title = on ? 'Vollbild beenden' : 'Vollbild';
    setTimeout(() => map.invalidateSize(), 50);
  }
  fsBtn.addEventListener('click', async () => {
    if (document.fullscreenElement) { await document.exitFullscreen(); return; }
    if (explore.classList.contains('is-fullscreen-fallback')) {
      explore.classList.remove('is-fullscreen-fallback');
      document.documentElement.style.overflow = '';
      fullscreenChanged(false);
      return;
    }
    try {
      await explore.requestFullscreen();
    } catch {
      // Without the API (iPhone): the map over the whole window.
      explore.classList.add('is-fullscreen-fallback');
      document.documentElement.style.overflow = 'hidden';
      fullscreenChanged(true);
    }
  });
  document.addEventListener('fullscreenchange', () => fullscreenChanged(document.fullscreenElement === explore));

  const contentBtn = $('map-content-toggle');
  contentBtn.addEventListener('click', () => {
    const hide = !explore.classList.contains('content-hidden');
    explore.classList.toggle('content-hidden', hide);
    contentBtn.setAttribute('aria-pressed', String(hide));
    contentBtn.textContent = hide ? 'Inhalt einblenden' : 'Inhalt ausblenden';
  });

  /* ---------- The region in view: commune, district or canton by zoom ---------- */

  const regionCache = new Map();
  async function regionAt(lat, lon) {
    const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
    if (!regionCache.has(key)) regionCache.set(key, api(`/api/landschaft/region?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`).catch(() => null));
    return regionCache.get(key);
  }
  const bezirk = (r) => (r?.bezirk ? (/^bezirk\b/i.test(r.bezirk) ? r.bezirk : `Bezirk ${r.bezirk}`) : null);
  let regionSeq = 0;
  async function showRegion() {
    const n = ++regionSeq;
    const c = map.getCenter();
    const pill = $('map-region');
    if (!Coords.inSwitzerland(c.lat, c.lng)) { pill.hidden = true; return; }
    const z = map.getZoom();
    const r = z < 8 ? null : await regionAt(c.lat, c.lng);
    if (n !== regionSeq) return;
    const text = z < 8 ? 'Schweiz' : z >= 12 ? r?.gemeinde : z >= 10 ? bezirk(r) : r?.kanton && `Kanton ${r.kanton}`;
    pill.hidden = !text;
    if (text) pill.replaceChildren(ICON('<path d="M3 4.5 7.5 3l5 2L17 3.5v12L12.5 17l-5-2L3 16.5z"/><path d="M7.5 3v12M12.5 5v12"/>'), text);
  }
  let regionTimer = null;
  map.on('moveend', () => { clearTimeout(regionTimer); regionTimer = setTimeout(showRegion, 400); });
  setTimeout(showRegion, 1500);

  /* ---------- The place panel: a click on the map ---------- */

  const P = { marker: null, at: null, seq: 0 };
  const placeIcon = L.divIcon({ className: '', html: '<div class="place-marker"></div>', iconSize: [18, 18], iconAnchor: [3, 22] });
  const swiss = (v) => Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  const km = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toLocaleString('de-CH', { maximumFractionDigits: 1 })} km`);

  function section() {
    let s = $('place');
    if (!s) {
      s = el('section', { id: 'place', class: 'place', hidden: '', 'aria-labelledby': 'place-title' });
      $('welcome').after(s);
    }
    return s;
  }
  function closePlace() {
    P.marker?.remove();
    P.marker = null;
    P.at = null;
    section().hidden = true;
    $('welcome').hidden = false;
  }
  /** Something else uses clicks on the map now: picking a place for a photo, measuring, drawing, planning a tour. */
  const busy = () => !$('pick-hint').hidden || window.Measure?.active() || window.Draw?.active()
    || map.getContainer().classList.contains('tour-drawing') || explore.classList.contains('spot-open');

  function actionButton(text, icon, onclick) {
    return el('button', { type: 'button', onclick }, [ICON(icon), text]);
  }
  async function showPlace(lat, lon, { name = null } = {}) {
    const n = ++P.seq;
    P.at = { lat, lon };
    if (!P.marker) P.marker = L.marker([lat, lon], { icon: placeIcon, keyboard: false, interactive: false }).addTo(map);
    P.marker.setLatLng([lat, lon]);
    const s = section();
    $('welcome').hidden = true;
    s.hidden = false;
    const inCh = Coords.inSwitzerland(lat, lon);
    const [e, nn] = inCh ? Coords.toLv95(lat, lon) : [null, null];
    const where = inCh ? `${swiss(e)} E ${swiss(nn)} N` : `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    const title = el('h2', { id: 'place-title', text: name || 'Ort' });
    const meta = el('p', { class: 'place-meta', text: where });
    const sub = el('p', { class: 'muted small', hidden: '' });
    const info = el('div', { class: 'place-info' });
    const geo = GeoadminLink.link({ lat, lon, zoom: map.getZoom(), layers: [], bgLayer: 'ch.swisstopo.pixelkarte-farbe' });
    const myPos = me?.dot ? me.dot.getLatLng() : null;
    const spots = (state.spots || []).map((sp) => ({ sp, d: distanceM(sp, { lat, lon }) })).filter((x) => x.d <= 10000).sort((a, b) => a.d - b.d);
    s.replaceChildren(
      el('header', { class: 'place-head' }, [
        el('div', {}, [title, sub, meta]),
        el('button', { type: 'button', class: 'icon', 'aria-label': 'Ort schliessen', text: '×', onclick: closePlace }),
      ]),
      el('div', { class: 'place-actions' }, [
        actionButton('Route hierhin', '<path d="M4 16c3-6 9-2 12-12"/><circle cx="4" cy="16" r="1.6"/><path d="M12.5 4H16v3.5"/>', () => {
          window.Tours?.routeTo({ lat, lon }, myPos ? { lat: myPos.lat, lon: myPos.lng } : null);
        }),
        actionButton('Foto hier beitragen', '<rect x="2.5" y="5.5" width="15" height="11" rx="2"/><circle cx="10" cy="11" r="3"/><path d="M7 5.5 8.5 3.5h3L13 5.5"/>', () => {
          document.querySelector('[data-action="upload"]')?.click();
          setTimeout(() => setPicked(L.latLng(lat, lon)), 0);
        }),
        actionButton('Koordinaten kopieren', '<rect x="6.5" y="6.5" width="10" height="10" rx="1.5"/><path d="M13.5 6.5v-3h-10v10h3"/>', async (ev) => {
          const b = ev.currentTarget;
          try { await navigator.clipboard.writeText(where); b.lastChild.textContent = 'Kopiert'; } catch { prompt('Koordinaten:', where); }
          setTimeout(() => { b.lastChild.textContent = 'Koordinaten kopieren'; }, 1500);
        }),
        el('a', { href: `${geo}&crosshair=marker`, target: '_blank', rel: 'noopener' }, [ICON('<path d="M8 4H4v12h12v-4M11 3h6v6M17 3l-8 8"/>'), 'map.geo.admin.ch']),
      ]),
      info,
      el('h3', { class: 'label' }, ['Spots in der Nähe', el('span', { text: spots.length ? `${spots.length} bis 10 km` : '' })]),
      spots.length
        ? el('div', { class: 'place-cards' }, spots.slice(0, 6).map(({ sp, d }) => el('button', { type: 'button', class: 'place-card', onclick: () => openSpot(sp.id) }, [
          el('img', { src: sp.latestThumbUrl || sp.latestUrl, alt: '', loading: 'lazy' }),
          el('div', {}, [
            el('p', { class: 'eyebrow', text: `${km(d)} entfernt` }),
            el('strong', { text: `Spot ${sp.id}` }),
            el('span', { class: 'facts' }, [
              el('span', { text: `${sp.photoCount} Foto${sp.photoCount === 1 ? '' : 's'}` }),
              el('span', { text: `seit ${new Date(sp.firstTaken).getFullYear()}` }),
              el('span', { text: `zuletzt ${fmtDate(sp.lastTaken)}` }),
            ]),
          ]),
        ])))
        : el('p', { class: 'empty', text: 'Noch keine Spots in der Nähe. Ein Foto von hier macht den ersten.' }),
    );
    // Height, region and what the layers say, as they come.
    api(`/api/layers/hoehe?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}`).then((h) => {
      if (n === P.seq && Number.isFinite(h.elevation)) meta.textContent = `${Math.round(h.elevation).toLocaleString('de-CH')} m · ${where}`;
    }).catch(() => {});
    if (inCh) {
      regionAt(lat, lon).then((r) => {
        if (n !== P.seq || !r?.gemeinde) return;
        if (!name) title.textContent = r.gemeinde;
        sub.textContent = [bezirk(r), r.kanton && `Kanton ${r.kanton}`].filter(Boolean).join(' · ');
        sub.hidden = false;
      });
    }
    window.Layers?.identify?.(L.latLng(lat, lon)).then((items) => {
      if (n !== P.seq || !items.length) return;
      info.replaceChildren(el('h3', { class: 'label', text: 'Was die Ebenen hier sagen' }), ...items.map((it) => el('section', {}, [
        el('strong', { text: it.title }),
        el('dl', {}, it.attributes.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })])),
      ])));
    }).catch(() => {});
    if (innerWidth <= 860) s.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  map.on('click', (e) => {
    // A spot, a route or another object on the map answers the click itself.
    if (busy() || e.originalEvent?.target?.closest?.('.leaflet-interactive, .leaflet-marker-icon')) return;
    showPlace(e.latlng.lat, e.latlng.lng);
  });
  // An opened spot takes the place of the place panel; closing the spot brings the place back.
  new MutationObserver(() => {
    if (!P.at) return;
    const open = explore.classList.contains('spot-open');
    section().hidden = open;
    if (!open) $('welcome').hidden = true;
  }).observe(explore, { attributes: true, attributeFilter: ['class'] });

  /* ---------- «Karten und Ebenen»: base maps, path networks and extra layers as tiles ---------- */

  // A tile of the map over the forest above Zürich (zoom 13) as the picture of a base map.
  const THUMB = { z: 13, x: 4291, y: 2858 };
  const thumbOf = (b) => (b.key === 'osm' ? `https://tile.openstreetmap.org/${THUMB.z}/${THUMB.x}/${THUMB.y}.png`
    : b.id ? `https://wmts.geo.admin.ch/1.0.0/${b.id}/default/current/3857/${THUMB.z}/${THUMB.x}/${THUMB.y}.jpeg` : null);
  const PICTO = {
    wandern: '<circle cx="11" cy="3.5" r="1.6"/><path d="M10.5 6.5 8 11l3 2 1 5M8 11l-2 6M10.5 6.5l3 3 2.5.5M7.5 8.5 5 10"/>',
    velo: '<circle cx="5" cy="13" r="3.2"/><circle cx="15" cy="13" r="3.2"/><path d="M5 13l3.5-6h5L15 13M8.5 7 10 13h5M11.5 4.5h2"/>',
    mtb: '<circle cx="5" cy="14" r="3"/><circle cx="15" cy="14" r="3"/><path d="M5 14l3-5h5l2 5M8 9l2 5h5M2 6l4-3 3 2 3-2 6 4"/>',
    schnee: '<path d="M10 2v16M3 6l14 8M17 6 3 14M8 3.5l2 2 2-2M8 16.5l2-2 2 2"/>',
    ski: '<path d="M3 15 17 5M5 17 18 8M11 3.5a1.5 1.5 0 1 0 0 .1"/>',
    hang: '<path d="M2 17h16L2 5z"/><path d="M6 17a6 6 0 0 0-1.6-4"/>',
    feuer: '<path d="M10 2c1 4 5 5 5 10a5 5 0 0 1-10 0c0-3 2-4 2-6 1.5 1 2 2 2 3 1-2 1-5 1-7z"/>',
    wild: '<path d="M6 3v3l-2 2M14 3v3l2 2M6 6c1 1 2 1.5 4 1.5S13 7 14 6M7 8l1 9h4l1-9"/>',
    baum: '<path d="M10 2 4 11h3l-3 4h12l-3-4h3zM10 15v3"/>',
    hoehe: '<path d="M3 17V9M7.5 17V4M12 17v-6M16.5 17V7"/>',
    bus: '<rect x="4" y="2.5" width="12" height="12" rx="2"/><path d="M4 9h12M6.5 17v-2.5M13.5 17v-2.5"/><circle cx="7" cy="12" r=".6"/><circle cx="13" cy="12" r=".6"/>',
  };
  const NETWORKS = [
    { name: 'ch.swisstopo.swisstlm3d-wanderwege', label: 'Wanderwege', pic: 'wandern', bg: '#e8a59b', text: 'Das Netz der signalisierten Wanderwege der Schweiz: gelb Wanderwege, rot-weiss Bergwanderwege, blau-weiss Alpinwanderwege (swisstopo, Schweizer Wanderwege).' },
    { name: 'ch.astra.veloland', label: 'Velo', pic: 'velo', bg: '#c3aee0', text: 'Die nationalen, regionalen und lokalen Velorouten von SchweizMobil (ASTRA).' },
    { name: 'ch.astra.mountainbikeland', label: 'Mountainbike', pic: 'mtb', bg: '#efc794', text: 'Die signalisierten Mountainbike-Routen von SchweizMobil (ASTRA).' },
    { name: 'ch.swisstopo-karto.schneeschuhrouten', label: 'Schneeschuh', pic: 'schnee', bg: '#90d3ea', text: 'Schneeschuhrouten von swisstopo, mit dem Schwierigkeitsgrad.' },
    { name: 'ch.swisstopo-karto.skitouren', label: 'Skitouren', pic: 'ski', bg: '#a9bde6', text: 'Skitourenrouten von swisstopo, aus den Skitourenkarten 1:50 000.' },
  ];
  const EXTRAS = [
    { name: 'ch.swisstopo.hangneigung-ueber_30', label: 'Hangneigung', pic: 'hang', bg: '#8e978c', text: 'Hänge steiler als 30° (swisstopo): wo Lawinen anreissen können, für Touren im Winter.' },
    { name: 'ch.bafu.gefahren-waldbrand_warnung', label: 'Waldbrand', pic: 'feuer', bg: '#c9774d', text: 'Die aktuelle Waldbrandgefahr pro Warnregion (BAFU und Kantone).' },
    { name: 'ch.bafu.wrz-wildruhezonen_portal', label: 'Wildruhezonen', pic: 'wild', bg: '#7c8f6b', text: 'Wildruhezonen und Wildschutzgebiete (BAFU): im Winter nicht betreten.' },
    { name: 'ch.bafu.landesforstinventar-waldmischungsgrad', label: 'Waldmischung', pic: 'baum', bg: '#5f8a5b', text: 'Anteil Nadel- und Laubbäume im Wald, aus dem Landesforstinventar (WSL, BAFU).' },
    { name: 'ch.bafu.landesforstinventar-vegetationshoehenmodell', label: 'Vegetationshöhe', pic: 'hoehe', bg: '#6f8f7a', text: 'Die Höhe der Vegetation aus Luftbildern, aus dem Landesforstinventar (WSL, BAFU).' },
    { name: 'ch.bav.haltestellen-oev', label: 'ÖV-Haltestellen', pic: 'bus', bg: '#7d8794', text: 'Die Haltestellen des öffentlichen Verkehrs (BAV): Anreise mit Bahn und Bus.' },
  ];
  const BASE_TEXT = {
    myforrest: 'Die Vektorkarte in den Farben von MyForrest, aus OpenStreetMap (OpenFreeMap).',
    osm: 'Die Standardkarte von OpenStreetMap; auch offline gespeicherte Karten zeigen sie.',
    landeskarte: 'Die Landeskarten von swisstopo in Farbe, im Sommer.',
    winter: 'Die Landeskarte von swisstopo im Winter, mit Skirouten und Schneeschuhrouten in der Karte.',
    grau: 'Die Landeskarte von swisstopo in Grau: darauf lassen sich Ebenen und Spots gut lesen.',
    luftbild: 'SWISSIMAGE, das aktuelle Luftbild von swisstopo.',
  };

  function tile({ label, pic, bg, picUrl, text, role = 'button', pressed, onclick, info }) {
    const picture = el('span', { class: 'pic', style: picUrl ? `background-image:url(${picUrl})` : `background:${bg}` }, picUrl ? [] : [ICON(PICTO[pic] || '')]);
    const attrs = role === 'radio' ? { role: 'radio', 'aria-checked': String(pressed) } : { 'aria-pressed': String(pressed) };
    return el('div', { class: 'map-tile-wrap' }, [
      el('button', { type: 'button', class: 'map-tile', ...attrs, onclick }, [picture, el('span', { text: label })]),
      el('button', { type: 'button', class: 'map-tile-info', text: 'i', 'aria-label': `Info zu ${label}`, title: text, onclick: info }),
    ]);
  }
  function note(grid, wrap, text) {
    grid.querySelector('.map-tile-note')?.remove();
    if (wrap.dataset.noted === '1') { wrap.dataset.noted = ''; return; }
    for (const w of grid.querySelectorAll('[data-noted]')) w.dataset.noted = '';
    wrap.dataset.noted = '1';
    // Below the row of the tile.
    const items = [...grid.children];
    const row = Math.floor(items.indexOf(wrap) / 3);
    const after = items[Math.min(items.length - 1, row * 3 + 2)];
    after.after(el('p', { class: 'map-tile-note', text }));
  }
  function grid(entries) {
    const g = el('div', { class: 'map-tile-grid' });
    for (const x of entries) {
      const t = tile({ ...x, info: () => note(g, t, x.text) });
      g.append(t);
    }
    return g;
  }
  async function toggleLayer(x, btn) {
    if (window.Layers.has(x.name)) { window.Layers.removeName(x.name); return; }
    btn.disabled = true;
    const ok = await window.Layers.addName(x.name);
    btn.disabled = false;
    if (!ok) note(btn.closest('.map-tile-grid'), btn.parentElement, `${x.label}: nicht verfügbar, oder schon acht Ebenen eingeschaltet.`);
  }
  function renderTiles() {
    const panel = $('layerpanel');
    const box = panel.querySelector('.map-tiles');
    if (!box) return;
    const current = window.Basemap?.current?.();
    box.replaceChildren(
      el('h3', { text: 'Karten' }),
      (() => {
        const g = grid(window.Basemap.list().map((b) => ({
          label: b.label, picUrl: thumbOf(b), bg: 'linear-gradient(135deg, #c9d8b4, #f4f0e4 60%, #c3d9dd)', pic: 'baum', text: BASE_TEXT[b.key] || b.label,
          role: 'radio', pressed: b.key === current, onclick: () => window.Basemap.setBase(b.key),
        })));
        g.setAttribute('role', 'radiogroup');
        g.setAttribute('aria-label', 'Grundkarte');
        return g;
      })(),
      el('h3', { text: 'Wegenetze' }),
      grid(NETWORKS.map((x) => ({ ...x, pressed: window.Layers.has(x.name), onclick: (e) => toggleLayer(x, e.currentTarget) }))),
      el('h3', { text: 'Zusatzebenen' }),
      grid(EXTRAS.map((x) => ({ ...x, pressed: window.Layers.has(x.name), onclick: (e) => toggleLayer(x, e.currentTarget) }))),
      el('h3', { class: 'map-tiles-more', text: 'Alle Ebenen, Dienste und Dateien' }),
    );
  }
  $('layers-toggle').addEventListener('click', () => setTimeout(() => {
    const panel = $('layerpanel');
    if (panel.hidden || panel.querySelector('.map-tiles')) return;
    panel.querySelector('.sun-head')?.after(el('section', { class: 'map-tiles', 'aria-label': 'Karten, Wegenetze und Zusatzebenen' }));
    renderTiles();
  }, 0));
  document.addEventListener('layers-change', renderTiles);
  document.addEventListener('basemap', renderTiles);

  window.MapUI = { showPlace, closePlace };
})();
