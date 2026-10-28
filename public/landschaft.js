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
  const state = { maps: null, place: null, report: null, ready: false, audience: 'gemeinde' };

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

  /* ---------- Karte ---------- */

  /*
   * The map as on map.geo.admin.ch: a background (Landeskarte, grey Landeskarte, aerial image or none) and any number
   * of maps over it, chosen in the catalog («Karten anzeigen») and listed under «Aktive Karten», where each can be
   * hidden, made more transparent, moved up or down, compared with a slider, explained («i») or removed. Maps with
   * years (the «Zeitreise» and the aerial images) get the time slider at the bottom of the map.
   */
  const map = L.map('ln-map', { zoomControl: false, maxBounds: CH.pad(0.3) }).setView([46.8, 8.2], 8);
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.control.scale({ position: 'bottomleft', imperial: false }).addTo(map);
  let marker = null;

  const BACKGROUNDS = [
    { id: 'ch.swisstopo.pixelkarte-farbe', title: 'Landeskarte' },
    { id: 'ch.swisstopo.pixelkarte-grau', title: 'Landeskarte grau' },
    { id: 'ch.swisstopo.swissimage', title: 'Luftbild' },
    { id: 'void', title: 'Kein Hintergrund' },
  ];
  // The tile of each background over central Switzerland, as its picture in the chooser.
  const bgThumb = (id) => (id === 'void' ? null : `https://wmts.geo.admin.ch/1.0.0/${id}/default/current/3857/8/133/90.jpeg`);
  const bg = { id: 'ch.swisstopo.pixelkarte-grau', layer: null, open: false };

  /** Every map that can be shown, by key: { key, title, when, text, kind ('wms', 'zeit', 'glacier'), layer, zeitreise, link, opacity }. */
  const catalog = new Map();
  /** The catalog's folders: { id, title, keys }. */
  let groups = [];
  /** The maps shown, the top one first: { key, visible, opacity, year, open }. */
  const active = [];
  const leaf = new Map(); // key → Leaflet layer
  const panes = new Map(); // key → name of the pane of that map (one per map, so order and opacity are the pane's)
  const DEFAULT_OPACITY = { wms: 0.85, zeit: 0.85, glacier: 1, theme: 0.75 };

  function paneOf(key) {
    if (!panes.has(key)) {
      const name = `ln-pane-${panes.size}`;
      map.createPane(name);
      panes.set(key, name);
    }
    return panes.get(key);
  }
  const yearsOf = (item) => item.zeitreise?.years || [];
  const nearest = (years, want) => years.reduce((best, y, i) => (Math.abs(y.year - want) < Math.abs(years[best].year - want) ? i : best), 0);
  const zeitUrl = (item, year) => {
    const years = yearsOf(item);
    return item.zeitreise.tiles.replace('{time}', years[nearest(years, year)].time);
  };
  const wms = (layer, pane) => L.tileLayer.wms(layer.url, {
    layers: layer.name, format: 'image/png', transparent: true, version: '1.3.0', pane, attribution: layer.attribution || '© geo.admin.ch',
  });
  function makeLayer(item, entry) {
    const pane = paneOf(item.key);
    if (item.kind === 'zeit') {
      return L.tileLayer(zeitUrl(item, entry.year), { maxZoom: 19, maxNativeZoom: 18, bounds: CH, pane, attribution: item.zeitreise.attribution });
    }
    if (item.kind === 'glacier') return glacier.layer;
    return wms(item.layer, pane);
  }

  function setBackground(id) {
    bg.id = BACKGROUNDS.some((b) => b.id === id) ? id : 'ch.swisstopo.pixelkarte-grau';
    bg.layer?.remove();
    bg.layer = bg.id === 'void' ? null : swisstopo(bg.id).addTo(map);
    map.getContainer().classList.toggle('ln-void', bg.id === 'void');
    renderBackgrounds();
    writeHash();
  }
  function renderBackgrounds() {
    const current = BACKGROUNDS.find((b) => b.id === bg.id);
    const thumb = (b) => el('span', { class: `ln-bg-thumb${b.id === 'void' ? ' void' : ''}`, style: bgThumb(b.id) ? `background-image:url(${bgThumb(b.id)})` : null });
    $('ln-bg').replaceChildren(
      el('div', { id: 'ln-bg-list', class: 'ln-bg-list', role: 'radiogroup', 'aria-label': 'Hintergrund', hidden: !bg.open },
        BACKGROUNDS.map((b) => el('button', {
          type: 'button', role: 'radio', 'aria-checked': String(b.id === bg.id), class: 'ln-bg-choice',
          on: { click: () => { bg.open = false; setBackground(b.id); } },
        }, [thumb(b), el('span', { text: b.title })]))),
      el('button', {
        type: 'button', class: 'ln-bg-current', 'aria-expanded': String(bg.open), 'aria-controls': 'ln-bg-list', title: 'Hintergrund wählen',
        on: { click: () => { bg.open = !bg.open; renderBackgrounds(); } },
      }, [thumb(current), el('span', { text: current.title })]),
    );
  }

  /* ----- Active maps ----- */

  function addMap(key, { visible = true, opacity = null, year = null, top = true } = {}) {
    const item = catalog.get(key);
    if (!item || active.some((a) => a.key === key)) return;
    const years = yearsOf(item);
    // Start at the year asked for (link), else around 1900 (maps) or 1950 (aerial images).
    const want = year ?? (/swissimage/.test(item.link) ? 1950 : 1900);
    const entry = {
      key, visible, opacity: opacity ?? item.opacity, year: years.length ? years[nearest(years, want)].year : null, open: false,
    };
    if (top) active.unshift(entry); else active.push(entry);
    apply();
  }
  function removeMap(key) {
    const i = active.findIndex((a) => a.key === key);
    if (i < 0) return;
    if (swipe.key === key) stopSwipe();
    active.splice(i, 1);
    if (info.key === key) showInfo(null);
    apply();
  }
  function moveMap(key, by) {
    const i = active.findIndex((a) => a.key === key);
    const j = i + by;
    if (i < 0 || j < 0 || j >= active.length) return;
    [active[i], active[j]] = [active[j], active[i]];
    apply();
    document.querySelector(`[id="ln-act-${key}"]`)?.querySelector(by < 0 ? '[data-act="up"]' : '[data-act="down"]')?.focus();
  }
  function setYear(key, year) {
    const entry = active.find((a) => a.key === key);
    const item = catalog.get(key);
    if (!entry || !item) return;
    const years = yearsOf(item);
    entry.year = years[nearest(years, year)].year;
    leaf.get(key)?.setUrl(zeitUrl(item, entry.year));
    // In place, so a slider being dragged stays the same element.
    const row = document.querySelector(`[id="ln-act-${key}"]`);
    if (row) {
      row.querySelector('.ln-badge').textContent = String(entry.year);
      row.querySelector('.ln-year select').value = String(entry.year);
    }
    if (timeEntry()?.key === key && $('ln-zeit-year')) {
      $('ln-zeit-year').textContent = String(entry.year);
      $('ln-zeit-range').value = String(years.findIndex((y) => y.year === entry.year));
    }
    swipeLabels();
    writeHash();
  }
  /** The Leaflet side of the list: layers on or off, each pane at its place and with its opacity. */
  function apply() {
    const n = active.length;
    active.forEach((a, i) => {
      const item = catalog.get(a.key);
      const pane = map.getPane(paneOf(a.key));
      pane.style.zIndex = String(250 + (n - i) * 2); // tiles at 200, the place marker at 600
      pane.style.opacity = String(a.opacity);
      let layer = leaf.get(a.key);
      if (!layer) { layer = makeLayer(item, a); leaf.set(a.key, layer); }
      if (a.visible && !map.hasLayer(layer)) layer.addTo(map);
      if (!a.visible && map.hasLayer(layer)) layer.remove();
    });
    for (const [key, layer] of leaf) {
      if (active.some((a) => a.key === key)) continue;
      layer.remove();
      leaf.delete(key);
    }
    glacier.shown = active.some((a) => a.key === GLACIER && a.visible);
    refreshGlaciers();
    if (swipe.el) {
      const target = active.find((a) => a.key === swipe.key);
      if (!target?.visible) stopSwipe();
      else if (swipe.layer) {
        // The second year lies just above the map it is compared with.
        const pane = map.getPane('ln-compare');
        pane.style.zIndex = String(Number(map.getPane(paneOf(swipe.key)).style.zIndex) + 1);
        pane.style.opacity = String(target.opacity);
      }
    }
    renderActive();
    renderCatalog();
    renderTimebar();
    clipSwipe();
    writeHash();
  }

  const icon = (d) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
    return svg;
  };
  const ICON = {
    info: 'M11 10h2v7h-2zm0-4h2v2h-2zM12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16z',
    gear: 'M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3h-4l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.7 1.7 1L11 21h4l.4-2.6c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z',
    close: 'M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z',
    up: 'M12 7.5 5 14.5l1.4 1.4 5.6-5.6 5.6 5.6 1.4-1.4z',
    down: 'M12 16.5 5 9.5l1.4-1.4 5.6 5.6 5.6-5.6 1.4 1.4z',
    swipe: 'M11 2h2v20h-2zM4 8l-3 4 3 4zm16 0v8l3-4z',
  };
  const iconButton = (label, d, onClick, extra = {}) => el('button', { type: 'button', class: 'ln-icon', 'aria-label': label, title: label, on: { click: onClick }, ...extra }, [icon(d)]);

  function renderActive() {
    $('ln-active-count').textContent = String(active.length);
    if (!active.length) {
      $('ln-active').replaceChildren(el('li', { class: 'ln-empty', text: 'Noch keine Karte gewählt. Unter «Karten anzeigen» ankreuzen, was über dem Hintergrund liegen soll.' }));
      return;
    }
    $('ln-active').replaceChildren(...active.map((a, i) => {
      const item = catalog.get(a.key);
      const id = `ln-act-${a.key}`;
      const years = yearsOf(item);
      const tools = el('div', { class: 'ln-layer-tools', id: `${id}-tools`, hidden: !a.open }, [
        el('label', { class: 'ln-opacity' }, [
          el('span', { text: 'Deckkraft' }),
          el('input', {
            type: 'range', min: '0', max: '1', step: '0.05', value: String(a.opacity),
            on: {
              input: (e) => {
                a.opacity = Number(e.target.value);
                map.getPane(paneOf(a.key)).style.opacity = String(a.opacity);
                if (swipe.layer && swipe.key === a.key) map.getPane('ln-compare').style.opacity = String(a.opacity);
                e.target.nextElementSibling.textContent = `${Math.round(a.opacity * 100)} %`;
              },
              change: () => writeHash(),
            },
          }),
          el('output', { text: `${Math.round(a.opacity * 100)} %` }),
        ]),
        years.length ? el('label', { class: 'ln-year' }, [
          el('span', { text: 'Jahr' }),
          el('select', { on: { change: (e) => setYear(a.key, Number(e.target.value)) } },
            years.map((y) => el('option', { value: String(y.year), text: String(y.year), selected: y.year === a.year }))),
        ]) : null,
        item.kind === 'glacier' ? el('div', { class: 'ln-glacier-legend', 'aria-live': 'polite' }) : null,
        el('div', { class: 'ln-layer-buttons' }, [
          el('button', { type: 'button', 'data-act': 'up', disabled: i === 0, on: { click: () => moveMap(a.key, -1) } }, [icon(ICON.up), 'Nach oben']),
          el('button', { type: 'button', 'data-act': 'down', disabled: i === active.length - 1, on: { click: () => moveMap(a.key, 1) } }, [icon(ICON.down), 'Nach unten']),
          item.kind === 'glacier' ? null : el('button', {
            type: 'button', 'aria-pressed': String(swipe.key === a.key && !swipe.layer), disabled: !a.visible,
            on: { click: () => (swipe.key === a.key && !swipe.layer ? stopSwipe() : startSwipe(a.key)) },
          }, [icon(ICON.swipe), 'Vergleichen']),
        ]),
      ]);
      return el('li', { id, class: `ln-layer${a.visible ? '' : ' hidden-layer'}` }, [
        el('div', { class: 'ln-layer-row' }, [
          el('label', { class: 'ln-layer-check' }, [
            el('input', {
              type: 'checkbox', checked: a.visible,
              on: { change: (e) => { a.visible = e.target.checked; apply(); } },
            }),
            el('span', { class: 'ln-layer-title' }, [item.title, a.year ? el('span', { class: 'ln-badge', text: String(a.year) }) : null]),
          ]),
          iconButton(`Info zu ${item.title}`, ICON.info, () => showInfo(info.key === a.key ? null : a.key), { 'aria-pressed': String(info.key === a.key) }),
          iconButton(`Einstellungen: ${item.title}`, ICON.gear, () => {
            a.open = !a.open;
            renderActive();
            document.querySelector(`[id="${id}"] [aria-controls]`)?.focus();
          }, { 'aria-expanded': String(a.open), 'aria-controls': `${id}-tools` }),
          iconButton(`${item.title} entfernen`, ICON.close, () => removeMap(a.key)),
        ]),
        tools,
      ]);
    }));
    glacierLegend();
  }

  /* ----- Catalog ----- */

  const openGroups = new Set(['zeit']);
  function renderCatalog() {
    $('ln-catalog').replaceChildren(...groups.filter((g) => g.keys.length).map((g) => {
      const on = g.keys.filter((k) => active.some((a) => a.key === k)).length;
      const details = el('details', { class: 'ln-folder', open: openGroups.has(g.id) }, [
        el('summary', {}, [el('span', { text: g.title }), on ? el('span', { class: 'ln-badge', text: String(on) }) : null]),
        el('ul', {}, g.keys.map((key) => {
          const item = catalog.get(key);
          const checked = active.some((a) => a.key === key);
          return el('li', { class: 'ln-entry' }, [
            el('label', {}, [
              el('input', { type: 'checkbox', checked, on: { change: (e) => (e.target.checked ? addMap(key) : removeMap(key)) } }),
              el('span', {}, [el('span', { class: 'ln-entry-title', text: item.title }), item.when ? el('span', { class: 'ln-when', text: item.when }) : null]),
            ]),
            iconButton(`Info zu ${item.title}`, ICON.info, () => showInfo(info.key === key ? null : key)),
          ]);
        })),
      ]);
      details.addEventListener('toggle', () => (details.open ? openGroups.add(g.id) : openGroups.delete(g.id)));
      return details;
    }));
  }

  /* ----- Info about a map: what it shows, its legend, its source ----- */

  const info = { key: null };
  function showInfo(key) {
    info.key = key;
    const item = catalog.get(key);
    const box = $('ln-info');
    box.hidden = !item;
    for (const b of document.querySelectorAll('.ln-layer .ln-icon[aria-pressed]')) b.setAttribute('aria-pressed', 'false');
    if (!item) return;
    const legend = item.layer?.legend;
    box.replaceChildren(...[
      el('header', {}, [el('h3', { text: item.title }), iconButton('Info schliessen', ICON.close, () => showInfo(null))]),
      item.when ? el('p', { class: 'ln-when', text: item.when }) : null,
      el('p', { text: item.text || '' }),
      legend ? el('img', { src: legend, alt: `Legende: ${item.title}`, loading: 'lazy', class: 'ln-legend', on: { error: (e) => e.target.remove() } }) : null,
      item.kind === 'glacier' ? null : el('a', {
        href: GeoadminLink.link({ lat: map.getCenter().lat, lon: map.getCenter().lng, zoom: map.getZoom(), layers: [{ id: item.link, visible: true, params: {} }], bgLayer: 'ch.swisstopo.pixelkarte-grau' }),
        target: '_blank', rel: 'noopener', class: 'small', text: 'In map.geo.admin.ch ansehen',
      }),
    ].filter(Boolean));
    const pressed = document.querySelector(`[id="ln-act-${key}"]`)?.querySelector('.ln-icon[aria-pressed]');
    pressed?.setAttribute('aria-pressed', 'true');
  }

  /* ----- Time slider: the years of the top map with years, a play button and two years side by side ----- */

  const zeit = { timer: null };
  const timeEntry = () => active.find((a) => a.visible && yearsOf(catalog.get(a.key)).length);
  function stopPlaying() {
    clearInterval(zeit.timer);
    zeit.timer = null;
  }
  function play(entry) {
    if (zeit.timer) { stopPlaying(); renderTimebar(); return; }
    const years = yearsOf(catalog.get(entry.key));
    if (entry.year >= years[years.length - 1].year) setYear(entry.key, years[0].year);
    // One year every 1.2 s: time for the tiles of the next year to arrive.
    zeit.timer = setInterval(() => {
      const e = timeEntry();
      const ys = e ? yearsOf(catalog.get(e.key)) : [];
      const i = ys.findIndex((y) => y.year === e?.year);
      if (!e || i < 0 || i >= ys.length - 1) { stopPlaying(); renderTimebar(); } else setYear(e.key, ys[i + 1].year);
    }, 1200);
    renderTimebar();
  }
  function renderTimebar() {
    const entry = timeEntry();
    const bar = $('ln-timebar');
    bar.hidden = !entry;
    if (!entry) { stopPlaying(); return; }
    const item = catalog.get(entry.key);
    const years = yearsOf(item);
    const index = years.findIndex((y) => y.year === entry.year);
    const comparing = swipe.key === entry.key && swipe.layer;
    bar.replaceChildren(
      el('button', {
        type: 'button', class: `ln-play${zeit.timer ? ' playing' : ''}`, 'aria-label': zeit.timer ? 'Anhalten' : 'Jahre abspielen', on: { click: () => play(entry) },
      }),
      el('div', { class: 'ln-timebar-main' }, [
        el('div', { class: 'ln-timebar-head' }, [
          el('output', { id: 'ln-zeit-year', class: 'ln-zeit-year', text: String(entry.year) }),
          el('span', { class: 'ln-muted small', text: item.title }),
        ]),
        el('label', { class: 'sr-only', for: 'ln-zeit-range', text: `Jahr: ${item.title}` }),
        el('input', {
          type: 'range', id: 'ln-zeit-range', min: '0', max: String(years.length - 1), step: '1', value: String(Math.max(0, index)),
          on: { input: (e) => { stopPlaying(); setYear(entry.key, years[Number(e.target.value)].year); } },
        }),
        el('div', { class: 'ln-zeit-scale' }, [el('span', { text: String(years[0].year) }), el('span', { text: String(years[years.length - 1].year) })]),
      ]),
      el('div', { class: 'ln-timebar-compare' }, [
        el('label', { class: 'ln-check' }, [
          el('input', {
            type: 'checkbox', id: 'ln-vergleich', checked: Boolean(comparing),
            on: { change: (e) => (e.target.checked ? startYears(entry.key, years[years.length - 1].year) : stopSwipe()) },
          }),
          'Mit einem zweiten Jahr vergleichen',
        ]),
        comparing ? el('label', { class: 'ln-year' }, [
          el('span', { text: 'rechts' }),
          el('select', { id: 'ln-vergleich-year', on: { change: (e) => setCompareYear(Number(e.target.value)) } },
            years.map((y) => el('option', { value: String(y.year), text: String(y.year), selected: y.year === swipe.year }))),
        ]) : null,
      ]),
    );
  }

  /* ----- Comparing with a slider: a map against the map without it, or two years of a map ----- */

  const swipe = { key: null, layer: null, year: null, ratio: 0.5, el: null };
  map.createPane('ln-compare');
  const swipePane = () => (swipe.layer ? map.getPane('ln-compare') : swipe.key ? map.getPane(paneOf(swipe.key)) : null);
  function clipSwipe() {
    const pane = swipePane();
    if (!pane || !swipe.el) return;
    const nw = map.containerPointToLayerPoint([0, 0]);
    const se = map.containerPointToLayerPoint(map.getSize());
    const x = nw.x + map.getSize().x * swipe.ratio;
    pane.style.clip = `rect(${nw.y}px, ${se.x}px, ${se.y}px, ${x}px)`;
    swipe.el.style.left = `${swipe.ratio * 100}%`;
    swipe.el.querySelector('[role="slider"]').setAttribute('aria-valuenow', String(Math.round(swipe.ratio * 100)));
  }
  function swipeLabels() {
    if (!swipe.el) return;
    const item = catalog.get(swipe.key);
    const entry = active.find((a) => a.key === swipe.key);
    swipe.el.querySelector('.left').textContent = swipe.layer ? String(entry?.year ?? '') : 'ohne';
    swipe.el.querySelector('.right').textContent = swipe.layer ? String(swipe.year) : item?.title || '';
  }
  function swipeElement() {
    const handle = el('div', {
      class: 'ln-swipe-handle', role: 'slider', tabindex: '0', 'aria-label': 'Trennlinie des Vergleichs',
      'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '50',
      on: {
        keydown: (e) => {
          const step = { ArrowLeft: -0.05, ArrowRight: 0.05 }[e.key];
          if (!step) return;
          e.preventDefault();
          swipe.ratio = Math.max(0, Math.min(1, swipe.ratio + step));
          clipSwipe();
        },
      },
    });
    const node = el('div', { class: 'ln-swipe' }, [
      el('span', { class: 'ln-swipe-year left' }), el('span', { class: 'ln-swipe-year right' }), handle,
    ]);
    L.DomEvent.disableClickPropagation(node);
    handle.addEventListener('pointerdown', (e) => {
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const r = map.getContainer().getBoundingClientRect();
        swipe.ratio = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
        clipSwipe();
      };
      const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
    map.getContainer().append(node);
    return node;
  }
  function stopSwipe() {
    const pane = swipePane();
    if (pane) pane.style.clip = '';
    swipe.layer?.remove();
    swipe.el?.remove();
    Object.assign(swipe, { key: null, layer: null, year: null, el: null });
    renderActive();
    renderTimebar();
    writeHash();
  }
  /** The map `key` only right of the divider. */
  function startSwipe(key) {
    if (swipe.el) stopSwipe();
    swipe.key = key;
    swipe.el = swipeElement();
    swipeLabels();
    renderActive();
    clipSwipe();
    writeHash();
  }
  /** Two years of the map `key`: its year left of the divider, `year` right of it. */
  function startYears(key, year) {
    if (swipe.el) stopSwipe();
    const item = catalog.get(key);
    swipe.key = key;
    swipe.year = year;
    swipe.layer = L.tileLayer(zeitUrl(item, year), { maxZoom: 19, maxNativeZoom: 18, bounds: CH, pane: 'ln-compare', attribution: item.zeitreise.attribution }).addTo(map);
    swipe.el = swipeElement();
    apply();
    setCompareYear(year);
  }
  function setCompareYear(year) {
    const item = catalog.get(swipe.key);
    if (!item || !swipe.layer) return;
    const years = yearsOf(item);
    swipe.year = years[nearest(years, year)].year;
    swipe.layer.setUrl(zeitUrl(item, swipe.year));
    swipeLabels();
    renderTimebar();
    clipSwipe();
    writeHash();
  }
  map.on('move zoom resize viewreset', clipSwipe);
  // Tiles drawn after a zoom get a new container position: clip again once they are there.
  map.on('zoomend', () => setTimeout(clipSwipe, 0));

  /* ----- The catalog from /api/landschaft/karten ----- */

  const GLACIER = 'gletscherinventare';
  function buildCatalog(maps) {
    catalog.clear();
    const zeitKeys = [];
    for (const t of maps.timeline) {
      if (!t.layer && !t.zeitreise) continue; // the Landeskarte of today is a background
      const key = t.zeitreise ? t.zeitreise.layer : t.layer.name;
      catalog.set(key, {
        key, title: t.title, when: t.when, text: t.text, kind: t.zeitreise ? 'zeit' : 'wms', layer: t.layer, zeitreise: t.zeitreise,
        link: key, opacity: DEFAULT_OPACITY[t.zeitreise ? 'zeit' : 'wms'],
      });
      zeitKeys.push(key);
    }
    groups = [{ id: 'zeit', title: 'Karten durch die Zeit', keys: zeitKeys }];
    for (const th of maps.themes) {
      const keys = [];
      for (const l of th.layers) {
        if (!catalog.has(l.name)) {
          catalog.set(l.name, {
            key: l.name, title: l.title, when: null, text: l.abstract || `Themenkarte «${th.title}» von geo.admin.ch.`, kind: 'wms', layer: l, link: l.name, opacity: DEFAULT_OPACITY.theme,
          });
        }
        keys.push(l.name);
      }
      groups.push({ id: th.id, title: th.title, keys });
    }
    if (maps.glaciers) {
      catalog.set(GLACIER, {
        key: GLACIER, kind: 'glacier', title: 'Gletscherinventare', when: maps.glaciers.years.join(', '), link: GLACIER, opacity: DEFAULT_OPACITY.glacier,
        text: 'Die Umrisse der Gletscher aus den Inventaren: eine Farbe pro Inventar, die alten hell und gestrichelt, das neuste dunkel. In den Einstellungen zeigt ein Jahr nur dieses Inventar.',
      });
      const water = groups.find((g) => g.id === 'wasser') || groups[groups.push({ id: 'wasser', title: 'Gletscher und Wasser', keys: [] }) - 1];
      water.keys.unshift(GLACIER);
    }
  }

  async function loadMaps() {
    try {
      state.maps = await api('/api/landschaft/karten');
    } catch (err) {
      $('ln-status').textContent = `Karten nicht verfügbar: ${err.message}`;
      state.maps = { timeline: [], themes: [], glaciers: null };
    }
    buildCatalog(state.maps);
    const q = new URLSearchParams(location.hash.split('?')[1] || '');
    setBackground(q.get('bg') || 'ch.swisstopo.pixelkarte-grau');
    state.ready = true;
    if (q.has('layers')) fromLayers(GeoadminLink.parseLayers(q.get('layers')));
    else if (q.get('ansicht')) {
      // Links of the earlier page: one map of the timeline (`ansicht`), its year and a comparison year.
      const t = state.maps.timeline.find((x) => x.id === q.get('ansicht'));
      const key = t && (t.zeitreise ? t.zeitreise.layer : t.layer?.name);
      if (key) addMap(key, { year: Number(q.get('jahr')) || null });
    } else fromGeoadmin();
    const compare = Number(q.get('vergleich'));
    const entry = timeEntry();
    if (compare && entry) startYears(entry.key, compare);
    apply();
  }

  /*
   * The maps in the address in the syntax of map.geo.admin.ch (public/geoadmin-link.js), the bottom one first:
   * `layers=ch.swisstopo.zeitreihen@year=1900,,0.85;ch.bafu.…,f`. Links of map.geo.admin.ch itself (`?layers=` in the
   * query, with `center` and `z`) open the same maps here.
   */
  function fromLayers(list) {
    for (const l of list.filter((x) => !x.external)) {
      const key = [...catalog.values()].find((i) => i.link === l.id)?.key;
      if (key) addMap(key, { visible: l.visible, opacity: l.opacity, year: Number.isFinite(l.params.year) ? l.params.year : null });
    }
  }
  function fromGeoadmin() {
    const g = GeoadminLink.read(location.search);
    if (g.lat !== null) map.setView([g.lat, g.lon], Number.isFinite(g.zoom) ? Math.round(g.zoom) : 12);
    if (g.bgLayer) setBackground(g.bgLayer);
    fromLayers(g.layers);
  }
  const linkLayers = () => [...active].reverse().map((a) => ({
    id: catalog.get(a.key).link, visible: a.visible, opacity: a.opacity, params: a.year ? { year: a.year } : {},
  }));
  /** The view in the address: the place, the maps, the background and the comparison year, so it can be shared. */
  function writeHash() {
    if (!state.ready || !$('karte') || $('karte').hidden) return;
    const q = new URLSearchParams(state.place ? placeQuery() : {});
    if (active.length) q.set('layers', GeoadminLink.layersParam(linkLayers()));
    if (bg.id !== 'ch.swisstopo.pixelkarte-grau') q.set('bg', bg.id);
    if (swipe.layer) q.set('vergleich', String(swipe.year));
    // The separators of the layers syntax stay readable (values carry their own %2C, %3B, %40).
    const s = q.toString().replace(/%3B/g, ';').replace(/%2C/g, ',').replace(/%40/g, '@').replace(/%3D/g, '=');
    history.replaceState(null, '', s ? `#karte?${s}` : '#karte');
  }
  /** The map shown here, as a link of map.geo.admin.ch (without the glacier inventories of this server). */
  function geoadminHref() {
    const layers = linkLayers().filter((l) => l.id !== GLACIER);
    // The chosen place in the middle, with the cross of map.geo.admin.ch on it.
    const c = state.place ? { lat: state.place.lat, lng: state.place.lon } : map.getCenter();
    return `${GeoadminLink.link({ lat: c.lat, lon: c.lng, zoom: map.getZoom(), layers, bgLayer: bg.id })}${state.place ? '&crosshair=marker' : ''}`;
  }
  $('ln-geoadmin').addEventListener('click', (e) => { e.currentTarget.href = geoadminHref(); });
  $('ln-share').addEventListener('click', async () => {
    writeHash();
    try {
      await navigator.clipboard.writeText(location.href);
      $('ln-status').textContent = 'Link kopiert.';
    } catch {
      $('ln-status').textContent = `Link: ${location.href}`;
    }
  });
  $('ln-menu-toggle').addEventListener('click', (e) => {
    const open = e.currentTarget.getAttribute('aria-expanded') !== 'true';
    e.currentTarget.setAttribute('aria-expanded', String(open));
    e.currentTarget.lastChild.textContent = open ? 'Menü ausblenden' : 'Menü einblenden';
    $('ln-menu').classList.toggle('collapsed', !open);
  });
  for (const id of ['ln-menu', 'ln-bg', 'ln-timebar', 'ln-info']) {
    L.DomEvent.disableClickPropagation($(id));
    L.DomEvent.disableScrollPropagation($(id));
  }

  /* Glacier outlines of the inventories on this server (/api/glaciers): one colour per inventory, the old ones light
     and dashed, the newest dark. A year in the settings shows that inventory alone. */
  const ICE = [47, 134, 180];
  const glacier = { shown: false, only: null, layer: L.layerGroup(), timer: null, message: '' };
  function iceShade(year) {
    const years = state.maps?.glaciers?.years || [];
    const t = years.length > 1 ? Math.max(0, years.indexOf(year)) / (years.length - 1) : 1;
    const k = 0.35 + 0.65 * t;
    const [r, g, b] = ICE.map((c) => Math.round(c * k + 255 * (1 - k)));
    return { color: `rgb(${r} ${g} ${b})`, t };
  }
  function glacierLegend(message = glacier.message) {
    glacier.message = message;
    const box = document.querySelector(`[id="ln-act-${GLACIER}"] .ln-glacier-legend`);
    if (!box) return;
    box.replaceChildren(...[
      ...state.maps.glaciers.years.map((y) => el('button', {
        type: 'button', 'aria-pressed': String(glacier.only === y), style: `--swatch: ${iceShade(y).color}`, text: String(y),
        title: glacier.only === y ? 'Alle Inventare zeigen' : `Nur das Inventar ${y} zeigen`,
        on: { click: () => { glacier.only = glacier.only === y ? null : y; glacierLegend(); refreshGlaciers(); } },
      })),
      message ? el('span', { class: 'ln-muted small', text: message }) : null,
    ].filter(Boolean));
  }
  async function refreshGlaciers() {
    if (!glacier.shown) return;
    if (map.getZoom() < 9) { glacier.layer.clearLayers(); glacierLegend('Zum Anzeigen hineinzoomen'); return; }
    const b = map.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => v.toFixed(4)).join(',');
    const fc = await api(`/api/glaciers?bbox=${bbox}${glacier.only ? `&year=${glacier.only}` : ''}`).catch(() => null);
    if (!fc || !glacier.shown) return;
    glacier.layer.clearLayers();
    const pane = paneOf(GLACIER);
    // Oldest first, so the smaller recent outlines lie on top.
    for (const f of [...fc.features].sort((a, c) => (a.properties.year ?? 0) - (c.properties.year ?? 0))) {
      const { color, t } = iceShade(f.properties.year);
      L.geoJSON(f, {
        pane, style: { color, weight: t === 1 ? 2.2 : 1.6, dashArray: t === 1 ? null : '5 4', fillColor: color, fillOpacity: 0.1 + 0.2 * t },
      }).bindTooltip(`${f.properties.name} · Stand ${f.properties.year ?? 'unbekannt'}`, { sticky: true }).addTo(glacier.layer);
    }
    glacierLegend(fc.features.length ? '' : 'Keine Gletscher in diesem Ausschnitt');
  }
  map.on('moveend', () => {
    clearTimeout(glacier.timer);
    glacier.timer = setTimeout(refreshGlaciers, 250);
  });

  const coords = (p) => `${fmt(p.lat, 4)}° N, ${fmt(p.lon, 4)}° O`;
  /** The place for the report; `name` when it came from the search (it goes into the address and the report title). */
  function setPlace(lat, lon, { pan = false, name = null, zoom = 11 } = {}) {
    state.place = { lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5, name };
    if (!marker) marker = L.marker([lat, lon]).addTo(map);
    marker.setLatLng([lat, lon]);
    if (pan) map.setView([lat, lon], zoom);
    $('ln-place').textContent = name ? `${name} · ${coords(state.place)}` : coords(state.place);
    $('ln-to-report').href = `#bericht?${placeQuery()}`;
    document.querySelector('.ln-tabs a[data-view="bericht"]').href = $('ln-to-report').href;
    $('ln-to-report').hidden = false;
  }
  const placeQuery = () => new URLSearchParams({ lat: state.place.lat, lon: state.place.lon, ...(state.place.name ? { ort: state.place.name } : {}) });
  map.on('click', (e) => { setPlace(e.latlng.lat, e.latlng.lng); writeHash(); });

  /* Search by place name, address or coordinates (/api/landschaft/suche): the hits below the field, arrow keys and
     Enter to choose; the chosen place becomes the place of the report. */
  const search = { timer: null, results: [], active: -1, seq: 0 };
  function renderHits(message = '') {
    const list = $('ln-search-results');
    list.replaceChildren(...search.results.map((h, i) => el('li', {
      id: `ln-hit-${i}`, role: 'option', 'aria-selected': String(i === search.active),
      on: { mousedown: (e) => { e.preventDefault(); choose(i); } },
    }, [el('span', { text: h.label }), el('span', { class: 'ln-hit-kind', text: h.kind })])));
    if (message) list.append(el('li', { class: 'ln-hit-note', text: message }));
    list.hidden = !search.results.length && !message;
    $('ln-search-q').setAttribute('aria-expanded', String(!list.hidden));
    if (search.active >= 0) $('ln-search-q').setAttribute('aria-activedescendant', `ln-hit-${search.active}`);
    else $('ln-search-q').removeAttribute('aria-activedescendant');
  }
  async function runSearch(q) {
    const n = ++search.seq;
    const r = await api(`/api/landschaft/suche?q=${encodeURIComponent(q)}`).catch((err) => ({ results: [], error: err.message }));
    if (n !== search.seq) return; // a newer search is under way
    search.results = r.results;
    search.active = r.results.length ? 0 : -1;
    renderHits(r.error || (r.results.length ? '' : 'Nichts gefunden'));
  }
  function choose(i) {
    const h = search.results[i];
    if (!h) return;
    // Communes, districts and cantons are large: a wider view than for an address.
    const zoom = { Kanton: 9, Bezirk: 10, Gemeinde: 12, Postleitzahl: 12, Koordinaten: 13, Adresse: 15, Parzelle: 16 }[h.kind] ?? 13;
    setPlace(h.lat, h.lon, { pan: true, zoom, name: h.kind === 'Koordinaten' ? null : h.label });
    // The place (and the year of the «Zeitreise») in the address, so the search result can be shared.
    writeHash();
    $('ln-search-q').value = h.label;
    search.results = [];
    search.active = -1;
    renderHits();
  }
  $('ln-search-q').addEventListener('input', (e) => {
    clearTimeout(search.timer);
    const q = e.target.value.trim();
    if (q.length < 2) { search.seq += 1; search.results = []; renderHits(); return; }
    search.timer = setTimeout(() => runSearch(q), 250);
  });
  $('ln-search-q').addEventListener('keydown', (e) => {
    const n = search.results.length;
    if (e.key === 'ArrowDown' && n) { e.preventDefault(); search.active = (search.active + 1) % n; renderHits(); }
    else if (e.key === 'ArrowUp' && n) { e.preventDefault(); search.active = (search.active - 1 + n) % n; renderHits(); }
    else if (e.key === 'Escape') { search.results = []; search.active = -1; renderHits(); }
  });
  $('ln-search-q').addEventListener('blur', () => { search.results = []; search.active = -1; renderHits(); });
  $('ln-search').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('ln-search-q').value.trim();
    if (q.length < 2) return;
    // Enter before the hits arrived: search now and take the first.
    if (!search.results.length) { clearTimeout(search.timer); await runSearch(q); }
    choose(Math.max(0, search.active));
  });
  L.DomEvent.disableClickPropagation($('ln-search'));
  L.DomEvent.disableScrollPropagation($('ln-search'));

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

  /** The area of the glacier per inventory, with the change since the first one. */
  function areaTable(areas) {
    const first = areas[0].km2;
    return el('table', {}, [
      el('thead', {}, el('tr', {}, [el('th', { text: 'Inventar' }), el('th', { text: 'Fläche' }), el('th', { text: `seit ${areas[0].year}` })])),
      el('tbody', {}, areas.map((a, i) => el('tr', {}, [
        el('td', { text: String(a.year) }),
        el('td', { text: `${fmt(a.km2, a.km2 < 10 ? 2 : 1)} km²` }),
        el('td', { text: i && first > 0 ? `${signed(((a.km2 - first) / first) * 100, 0)} %` : '–' }),
      ]))),
    ]);
  }

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
        g.areas?.length ? areaTable(g.areas) : null,
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

  async function showReport(lat, lon, name = null) {
    $('ln-report-title').textContent = name || coords({ lat, lon });
    const stand = `Stand ${new Date().toLocaleDateString('de-CH', { day: 'numeric', month: 'long', year: 'numeric' })}`;
    $('ln-report-meta').textContent = name ? `${coords({ lat, lon })} · ${stand}` : stand;
    $('ln-report-body').replaceChildren(el('p', { class: 'ln-muted', text: 'Daten werden zusammengestellt …' }));
    // The same report as a PDF made on the server (fixed layout, map excerpts per theme).
    $('ln-pdf').href = `/api/landschaft/bericht.pdf?${new URLSearchParams({ lat, lon, ...(name ? { ort: name } : {}) })}`;
    $('ln-pdf').hidden = false;
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
    document.body.dataset.view = view;
    for (const a of document.querySelectorAll('.ln-tabs a[data-view]')) a.setAttribute('aria-current', a.dataset.view === view ? 'page' : 'false');
    const q = new URLSearchParams(query || '');
    const lat = Number(q.get('lat'));
    const lon = Number(q.get('lon'));
    const hasPlace = q.has('lat') && Number.isFinite(lat) && Number.isFinite(lon);
    if (hasPlace) setPlace(lat, lon, { pan: view === 'karte', name: q.get('ort')?.slice(0, 120) || null });
    if (view === 'karte') { setTimeout(() => map.invalidateSize(), 0); writeHash(); }
    if (view === 'bericht' && state.place) {
      showReport(state.place.lat, state.place.lon, state.place.name);
    }
  }
  window.addEventListener('hashchange', showView);
  renderDaten();
  loadMaps();
  showView();
})();
