'use strict';

/*
 * Panel "Ebenen" of the main map (src/routes/layers.js): layers of external sources over the map, grouped by
 * theme (forest and forest fire, population, land use, traffic, regional services such as Zürich's tree register),
 * and any other layer of geo.admin.ch by its search. Several at once, each with opacity, legend, on/off and order,
 * a year for layers with a time; a click on the map asks what the switched-on layers say there.
 *
 * Shared like map.geo.admin.ch: the address carries `layers=…` (with `@year=`, `,f` for hidden and the opacity),
 * `center` (LV95) and `z` in its syntax (public/geoadmin-link.js), so a link of map.geo.admin.ch opens here and
 * "In map.geo.admin.ch öffnen" opens the same view there. A right click (long press) on the map shows the place in
 * LV95, LV03, WGS84, UTM and MGRS with its height (public/coords.js).
 *
 * More as on map.geo.admin.ch: other WMS and WMTS (a list of providers or any address; the browser reads their
 * capabilities, public/ows.js), KML, GPX and GeoJSON files as layers (public/filelayer.js, the file stays on the
 * device), a slider that compares any layer with the map below it, and a short link with a QR code.
 * Uses the globals of app.js (map, api, el, $, state).
 */

(function layersModule() {
  const STORE = 'myforrest-layers';
  const MAX = 8;
  const L_ = { open: false, catalogue: null, active: new Map(), filter: '', found: [], seq: 0, timer: null, service: null, swipe: null };
  const saved = (() => { try { return JSON.parse(localStorage.getItem(STORE)) || []; } catch { return []; } })();
  const save = () => {
    try {
      // Files stay in this session only; services and geo.admin.ch layers come back.
      localStorage.setItem(STORE, JSON.stringify([...L_.active.values()].filter((a) => a.layer.kind !== 'vector').map((a) => ({
        url: a.layer.url, name: a.layer.name, id: a.layer.id, title: a.layer.title, opacity: a.opacity, visible: a.visible, year: a.year,
        ...(a.layer.capsUrl ? { capsUrl: a.layer.capsUrl, kind: a.layer.kind } : {}),
      }))));
    } catch { /* private mode */ }
  };

  const inView = (l) => {
    if (!l.bbox) return true;
    const c = map.getCenter();
    return c.lng >= l.bbox[0] && c.lng <= l.bbox[2] && c.lat >= l.bbox[1] && c.lat <= l.bbox[3];
  };
  const allLayers = () => (L_.catalogue?.groups || []).flatMap((g) => g.layers);

  /* ---------- Active layers ---------- */

  const FILE_COLOUR = '#c0392b';
  /** The style of a file layer at an opacity (points solid, areas light). */
  const fileStyle = (opacity) => (f) => (f?.geometry?.type === 'Point'
    ? { radius: 6, color: '#fff', weight: 2, fillColor: FILE_COLOUR, opacity, fillOpacity: opacity }
    : { color: FILE_COLOUR, weight: 2.5, opacity, fillColor: FILE_COLOUR, fillOpacity: 0.25 * opacity });
  function vectorLayer(l, a) {
    return L.geoJSON(l.data, {
      style: fileStyle(a.opacity),
      pointToLayer: (f, ll) => L.circleMarker(ll, fileStyle(a.opacity)(f)),
      onEachFeature: (f, layer) => {
        const p = f.properties || {};
        if (p.name || p.description) layer.bindPopup(el('div', {}, [p.name ? el('strong', { text: p.name }) : '', p.description ? el('p', { class: 'small', text: p.description }) : '']));
      },
    });
  }
  const setOpacity = (a) => (a.layer.kind === 'vector' ? a.tile.setStyle(fileStyle(a.opacity)) : a.tile.setOpacity(a.opacity));

  function tileOf(l, a) {
    if (l.kind === 'vector') return vectorLayer(l, a);
    if (l.kind === 'wmts') {
      return L.tileLayer(Ows.tileUrl(l, a.year ? String(a.year) : null), {
        opacity: a.opacity, attribution: l.attribution, className: 'ext-layer', minNativeZoom: l.minZoom, maxNativeZoom: l.maxZoom, maxZoom: 20,
      });
    }
    return L.tileLayer.wms(l.url, {
      layers: l.name, format: 'image/png', transparent: true, version: '1.3.0', opacity: a.opacity, attribution: l.attribution, className: 'ext-layer',
      // Layers with a time dimension: the year, as map.geo.admin.ch asks its WMS.
      ...(a.year ? { time: String(a.year) } : {}),
    });
  }

  function addLayer(l, { opacity = 0.7, visible = true, year = null } = {}) {
    if (L_.active.has(l.id)) return true;
    if (L_.active.size >= MAX) {
      $('layers-status').textContent = `Höchstens ${MAX} Ebenen zugleich.`;
      return false;
    }
    const a = { layer: l, opacity, visible, year };
    a.tile = tileOf(l, a);
    if (visible) a.tile.addTo(map);
    L_.active.set(l.id, a);
    restack();
    save();
    return true;
  }
  function removeLayer(id) {
    const a = L_.active.get(id);
    if (!a) return;
    if (L_.swipe?.id === id) setSwipe(null);
    if (map.hasLayer(a.tile)) map.removeLayer(a.tile);
    L_.active.delete(id);
    save();
  }
  /** The first active layer on top: z-index by the order of the list (files above the tiles, in the same order). */
  function restack() {
    const list = [...L_.active.values()];
    list.forEach((a, i) => a.tile.setZIndex?.(100 + list.length - i));
    [...list].reverse().forEach((a) => { if (a.layer.kind === 'vector' && map.hasLayer(a.tile)) a.tile.bringToFront(); });
  }
  function move(id, step) {
    const list = [...L_.active.entries()];
    const i = list.findIndex(([k]) => k === id);
    const j = i + step;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    L_.active = new Map(list);
    restack();
    save();
    renderActive();
  }
  function setVisible(a, visible) {
    a.visible = visible;
    if (visible && !map.hasLayer(a.tile)) a.tile.addTo(map);
    if (!visible && map.hasLayer(a.tile)) map.removeLayer(a.tile);
    save();
  }
  function setYear(a, year) {
    a.year = year;
    const on = map.hasLayer(a.tile);
    if (on) map.removeLayer(a.tile);
    a.tile = tileOf(a.layer, a);
    if (on) a.tile.addTo(map);
    restack();
    if (L_.swipe?.id === a.layer.id) clipSwipe();
    save();
  }

  /* ---------- Compare: a layer only right of a divider, the map without it on the left ---------- */

  function clipSwipe() {
    const s = L_.swipe;
    const a = s && L_.active.get(s.id);
    const box = a?.tile.getContainer?.();
    if (!box) return;
    const nw = map.containerPointToLayerPoint([0, 0]);
    const se = map.containerPointToLayerPoint(map.getSize());
    box.style.clip = `rect(${nw.y}px, ${se.x}px, ${se.y}px, ${nw.x + map.getSize().x * s.ratio}px)`;
    s.el.style.left = `${s.ratio * 100}%`;
    s.el.querySelector('[role="slider"]').setAttribute('aria-valuenow', String(Math.round(s.ratio * 100)));
  }
  /** Compares the layer `id` (or none) against the map below it, with a divider to drag (mouse, finger, arrow keys). */
  function setSwipe(id) {
    if (L_.swipe) {
      const old = L_.active.get(L_.swipe.id)?.tile.getContainer?.();
      if (old) old.style.clip = '';
      L_.swipe.el.remove();
      L_.swipe = null;
    }
    const a = id && L_.active.get(id);
    if (!a || !a.tile.getContainer) { renderActive(); return; }
    if (!a.visible) setVisible(a, true);
    const handle = el('div', { class: 'map-swipe-handle', role: 'slider', tabindex: '0', 'aria-label': `Trennlinie: rechts ${a.layer.title}, links ohne`, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '50' });
    const node = el('div', { class: 'map-swipe' }, [
      el('span', { class: 'map-swipe-label left', text: 'ohne' }), el('span', { class: 'map-swipe-label right', text: a.layer.title }), handle,
    ]);
    L.DomEvent.disableClickPropagation(node);
    handle.addEventListener('keydown', (e) => {
      const step = { ArrowLeft: -0.05, ArrowRight: 0.05 }[e.key];
      if (!step) return;
      e.preventDefault();
      L_.swipe.ratio = Math.max(0, Math.min(1, L_.swipe.ratio + step));
      clipSwipe();
    });
    handle.addEventListener('pointerdown', (e) => {
      handle.setPointerCapture(e.pointerId);
      const moveTo = (ev) => {
        const r = map.getContainer().getBoundingClientRect();
        L_.swipe.ratio = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
        clipSwipe();
      };
      const up = () => { handle.removeEventListener('pointermove', moveTo); handle.removeEventListener('pointerup', up); };
      handle.addEventListener('pointermove', moveTo);
      handle.addEventListener('pointerup', up);
    });
    map.getContainer().append(node);
    L_.swipe = { id, ratio: 0.5, el: node };
    clipSwipe();
    renderActive();
  }
  map.on('move zoom resize viewreset', clipSwipe);
  map.on('zoomend', () => setTimeout(clipSwipe, 0));

  function renderActive() {
    const box = $('layers-active');
    if (!box) return;
    const list = [...L_.active.values()];
    box.replaceChildren(...list.map((a, i) => {
      const range = el('input', { type: 'range', min: '0.1', max: '1', step: '0.05', value: String(a.opacity), 'aria-label': `Deckkraft ${a.layer.title}` });
      range.addEventListener('input', () => { a.opacity = Number(range.value); setOpacity(a); save(); });
      const legend = el('img', { src: a.layer.legend, alt: `Legende ${a.layer.title}`, loading: 'lazy', class: 'layer-legend' });
      legend.addEventListener('error', () => legend.remove());
      const eye = el('button', {
        type: 'button', class: 'icon layer-eye', 'aria-pressed': String(a.visible), title: a.visible ? 'Ausblenden' : 'Einblenden',
        'aria-label': `${a.layer.title} ${a.visible ? 'ausblenden' : 'einblenden'}`, text: a.visible ? '◉' : '○',
        onclick: () => { setVisible(a, !a.visible); renderActive(); },
      });
      // The year: a choice of the service's time values when it lists them, else a number (geo.admin.ch).
      const year = a.layer.time?.length
        ? el('select', { 'aria-label': `Zeitstand ${a.layer.title}` }, [el('option', { value: '', text: a.layer.timeDefault ? `Standard (${a.layer.timeDefault})` : 'Standard' }), ...a.layer.time.map((t) => el('option', { value: t, text: t }))])
        : el('input', { type: 'number', min: '1800', max: '2100', step: '1', value: a.year ? String(a.year) : '', placeholder: 'aktuell', 'aria-label': `Jahr ${a.layer.title}` });
      if (a.layer.time?.length) year.value = a.year ? String(a.year) : '';
      year.addEventListener('change', () => setYear(a, a.layer.time?.length ? (year.value || null) : (Number(year.value) || null)));
      const timed = a.layer.geoadmin || a.layer.time?.length;
      const comparing = L_.swipe?.id === a.layer.id;
      const canCompare = a.layer.kind !== 'vector';
      return el('li', { class: a.visible ? '' : 'layer-off' }, [
        el('div', { class: 'layer-head' }, [
          eye,
          el('strong', { text: a.layer.title }),
          el('span', { class: 'layer-order' }, [
            el('button', { type: 'button', class: 'icon', text: '↑', title: 'Nach oben', 'aria-label': `${a.layer.title} nach oben`, ...(i === 0 ? { disabled: '' } : {}), onclick: () => move(a.layer.id, -1) }),
            el('button', { type: 'button', class: 'icon', text: '↓', title: 'Nach unten', 'aria-label': `${a.layer.title} nach unten`, ...(i === list.length - 1 ? { disabled: '' } : {}), onclick: () => move(a.layer.id, 1) }),
          ]),
          el('button', { type: 'button', class: 'link small', text: 'entfernen', onclick: () => { removeLayer(a.layer.id); render(); } }),
        ]),
        el('div', { class: 'small k-row layer-tools' }, [
          el('label', { class: 'k-row' }, ['Deckkraft ', range]),
          canCompare ? el('button', {
            type: 'button', class: 'link small', 'aria-pressed': String(comparing), title: 'Mit einem Regler links ohne, rechts mit dieser Ebene',
            text: comparing ? 'Vergleich beenden' : 'Vergleichen', onclick: () => setSwipe(comparing ? null : a.layer.id),
          }) : '',
        ]),
        // Layers with a time (zeitreihen, Arealstatistik, services with a time dimension): the year, shown when one is set.
        timed && a.year ? el('label', { class: 'small k-row' }, ['Jahr ', year]) : '',
        a.layer.kind === 'vector' ? el('p', { class: 'muted small', text: `${a.layer.format}-Datei, ${a.layer.count} Objekt${a.layer.count === 1 ? '' : 'e'}; nur auf diesem Gerät` }) : el('details', { class: 'small' }, [
          el('summary', { text: timed && !a.year ? 'Legende und Jahr' : 'Legende' }),
          timed && !a.year ? el('label', { class: 'small k-row', title: 'Für Ebenen mit Zeitreihe, z. B. Zeitreise oder Arealstatistik' }, ['Jahr ', year]) : '',
          legend,
        ]),
      ]);
    }));
    box.hidden = !L_.active.size;
    $('layers-hint').hidden = !L_.active.size;
    $('layers-share').hidden = !L_.active.size;
  }

  function layerList(layers) {
    return el('ul', {}, layers.map((l) => {
      const box = el('input', { type: 'checkbox', value: l.id });
      box.checked = L_.active.has(l.id);
      box.addEventListener('change', () => {
        if (box.checked) { if (addLayer(l) === false) box.checked = false; } else removeLayer(l.id);
        renderActive();
      });
      return el('li', {}, [el('label', {}, [box, ` ${l.title}`])]);
    }));
  }

  function render() {
    const list = $('layers-groups');
    if (!list || !L_.catalogue) return;
    const q = L_.filter.toLowerCase();
    const groups = L_.catalogue.groups.map((g) => ({ ...g, layers: g.layers.filter((l) => inView(l) && (!q || l.title.toLowerCase().includes(q))) }))
      .filter((g) => g.layers.length);
    // The search also finds every other layer of geo.admin.ch, as on map.geo.admin.ch.
    const shown = new Set(groups.flatMap((g) => g.layers.map((l) => l.name)));
    const more = q.length >= 3 ? L_.found.filter((l) => !shown.has(l.name)) : [];
    list.replaceChildren(...groups.map((g, i) => el('details', { class: 'layer-group', ...(i === 0 || q ? { open: '' } : {}) }, [
      el('summary', {}, [el('span', { text: g.title }), el('span', { class: 'muted small', text: ` ${g.layers.length}` })]),
      layerList(g.layers),
    ])), ...(more.length ? [el('details', { class: 'layer-group', open: '' }, [
      el('summary', {}, [el('span', { text: 'Alle Ebenen von geo.admin.ch' }), el('span', { class: 'muted small', text: ` ${more.length}` })]),
      layerList(more),
    ])] : []));
    if (!groups.length && !more.length) list.replaceChildren(el('p', { class: 'muted small', text: q ? 'Keine Ebene mit diesem Namen.' : 'Keine Ebenen verfügbar.' }));
    renderActive();
  }

  async function searchAll(q) {
    const n = ++L_.seq;
    if (q.length < 3) { L_.found = []; render(); return; }
    const d = await api(`/api/layers/geoadmin?q=${encodeURIComponent(q)}`).catch(() => ({ layers: [] }));
    if (n !== L_.seq) return;
    L_.found = d.layers;
    render();
  }

  /* ---------- Links in the syntax of map.geo.admin.ch ---------- */

  const BG = { landeskarte: 'ch.swisstopo.pixelkarte-farbe', luftbild: 'ch.swisstopo.swissimage' };
  const BG_BACK = { 'ch.swisstopo.pixelkarte-farbe': 'landeskarte', 'ch.swisstopo.pixelkarte-grau': 'landeskarte', 'ch.swisstopo.swissimage': 'luftbild' };

  /** The active layers for a link: geo.admin.ch by name, others as external WMS. */
  function linkLayers() {
    return [...L_.active.values()].filter((a) => a.layer.kind !== 'vector' || a.layer.sourceUrl).map((a) => ({
      id: a.layer.name,
      visible: a.visible,
      opacity: a.opacity,
      params: a.year ? { year: a.year } : {},
      external: a.layer.geoadmin ? null
        : a.layer.kind === 'wmts' ? { type: 'WMTS', url: a.layer.capsUrl, name: a.layer.name }
          : a.layer.kind === 'vector' ? { type: a.layer.format === 'GPX' ? 'GPX' : 'KML', url: a.layer.sourceUrl, name: null }
            : { type: 'WMS', url: a.layer.url, name: a.layer.name },
    }));
  }
  /** This view with its layers, in the address of MyForrest (the same parameters as map.geo.admin.ch). */
  function shareUrl() {
    const c = map.getCenter();
    const geo = new URL(GeoadminLink.link({ lat: c.lat, lon: c.lng, zoom: map.getZoom(), layers: linkLayers(), bgLayer: BG[window.Basemap?.current?.()] || null }));
    const q = new URLSearchParams(geo.hash.split('?')[1]);
    q.delete('lang');
    return `${location.origin}${location.pathname}?${q.toString().replace(/%3B/g, ';').replace(/%2C/g, ',').replace(/%40/g, '@').replace(/%3D/g, '=').replace(/%7C/g, '|')}`;
  }
  function geoadminUrl() {
    const c = map.getCenter();
    return GeoadminLink.link({ lat: c.lat, lon: c.lng, zoom: map.getZoom(), layers: linkLayers(), bgLayer: BG[window.Basemap?.current?.()] || 'ch.swisstopo.pixelkarte-farbe' });
  }

  /** Opens the view of a link (of MyForrest or map.geo.admin.ch): place, zoom, background and layers. */
  async function applyLink(link) {
    const s = GeoadminLink.read(link);
    if (s.lat !== null) map.setView([s.lat, s.lon], Number.isFinite(s.zoom) ? Math.round(s.zoom * 4) / 4 : 13);
    if (s.bgLayer && BG_BACK[s.bgLayer]) window.Basemap?.prefer(BG_BACK[s.bgLayer]);
    if (!s.layers.length) return;
    if (!$('layerpanel').childElementCount) buildPanel();
    await load({ restore: false });
    for (const id of [...L_.active.keys()]) removeLayer(id);
    const missing = [];
    const byName = new Map(allLayers().filter((l) => l.geoadmin).map((l) => [l.name, l]));
    const unknown = s.layers.filter((x) => !x.external && !byName.has(x.id)).map((x) => x.id);
    if (unknown.length) {
      const d = await api(`/api/layers/geoadmin?ids=${encodeURIComponent(unknown.join(','))}`).catch(() => ({ layers: [], missing: unknown }));
      for (const l of d.layers) byName.set(l.name, l);
    }
    for (const x of s.layers) {
      let l = null;
      if (x.external?.type === 'WMTS') {
        const caps = await readService(x.external.url).catch(() => null);
        const found = caps?.layers.find((y) => y.name === x.external.name);
        if (found) l = serviceLayer(caps, found);
      } else if (x.external?.type === 'KML' || x.external?.type === 'GPX') {
        l = await fileFromUrl(x.external.url).catch(() => null);
      } else if (x.external?.type === 'WMS') {
        const host = (() => { try { return new URL(x.external.url).hostname; } catch { return 'WMS'; } })();
        l = allLayers().find((y) => y.url === x.external.url && y.name === x.external.name)
          || { id: `ext:${x.external.url}|${x.external.name}`, url: x.external.url, name: x.external.name, title: `${x.external.name} (${host})`, attribution: host, info: false, geoadmin: false };
      } else if (!x.external) l = byName.get(x.id);
      if (!l) { missing.push(x.external ? `${x.external.type} ${x.external.url}` : x.id); continue; }
      addLayer(l, { opacity: x.opacity ?? 0.75, visible: x.visible, year: x.params.year ?? null });
    }
    render();
    $('layers-status').textContent = `Aus dem Link: ${L_.active.size} Ebene${L_.active.size === 1 ? '' : 'n'}${missing.length ? `; nicht verfügbar: ${missing.join(', ')}` : ''}.`;
  }

  async function load({ restore = true } = {}) {
    if (L_.catalogue) return;
    $('layers-status').textContent = 'Ebenen werden geladen …';
    try {
      L_.catalogue = await api('/api/layers');
      $('layers-status').textContent = L_.catalogue.errors?.length && !L_.catalogue.groups.length ? `Nicht erreichbar: ${L_.catalogue.errors.join('; ')}` : '';
    } catch (err) {
      $('layers-status').textContent = `Ebenen nicht verfügbar: ${err.message}`;
      return;
    }
    // Layers switched on last time (also ones found by the search).
    if (restore) {
      const extra = saved.filter((s) => String(s.id || '').startsWith('ga:'));
      const more = extra.length ? (await api(`/api/layers/geoadmin?ids=${encodeURIComponent(extra.map((s) => s.name).join(','))}`).catch(() => ({ layers: [] }))).layers : [];
      for (const s of saved) {
        let l = allLayers().find((x) => x.url === s.url && x.name === s.name) || more.find((x) => x.name === s.name);
        // Layers of another service: read its capabilities again.
        if (!l && s.capsUrl) {
          const caps = await readService(s.capsUrl).catch(() => null);
          const found = caps?.layers.find((y) => y.name === s.name);
          if (found) l = serviceLayer(caps, found);
        }
        if (l) addLayer(l, { opacity: s.opacity, visible: s.visible !== false, year: s.year || null });
      }
    }
    render();
  }

  /* ---------- Other services and files ---------- */

  /** Capabilities of a WMS or WMTS, read by the browser: { type, title, url, capsUrl, layers }. */
  async function readService(raw) {
    const { url } = Ows.capabilitiesUrl(raw);
    let r;
    try {
      r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    } catch (err) {
      throw new Error(err.name === 'TimeoutError' ? 'Keine Antwort in 20 Sekunden' : 'Nicht erreichbar, oder der Dienst erlaubt keinen Zugriff aus dem Browser (CORS)');
    }
    if (!r.ok) throw new Error(`Der Dienst antwortete mit HTTP ${r.status}`);
    return { ...Ows.parseCapabilities(await r.text(), url), capsUrl: url };
  }
  /** A layer of another service as an entry of the panel. */
  function serviceLayer(caps, x) {
    const host = (() => { try { return new URL(caps.capsUrl).hostname; } catch { return caps.title; } })();
    return {
      id: `${caps.type.toLowerCase()}:${caps.capsUrl}|${x.name}`, kind: caps.type === 'WMTS' ? 'wmts' : 'wms', geoadmin: false, info: false,
      url: caps.type === 'WMS' ? caps.url : caps.capsUrl, capsUrl: caps.type === 'WMTS' ? caps.capsUrl : null, name: x.name,
      title: x.title, attribution: `${caps.title} (${host})`, legend: x.legend, bbox: x.bbox || null,
      template: x.template, minZoom: x.minZoom, maxZoom: x.maxZoom, time: x.time, timeDefault: x.timeDefault,
    };
  }
  async function loadService(raw) {
    const status = $('layers-import-status');
    status.textContent = 'Dienst wird gelesen …';
    try {
      L_.service = await readService(raw);
    } catch (err) {
      L_.service = null;
      status.textContent = `Nicht geladen: ${err.message}`;
      renderService();
      return;
    }
    status.textContent = `${L_.service.title}: ${L_.service.layers.length} Ebene${L_.service.layers.length === 1 ? '' : 'n'}${L_.service.type === 'WMTS' ? ' (nur in Web Mercator)' : ''}.`;
    renderService();
  }
  function renderService(filter = '') {
    const box = $('layers-import-list');
    if (!box) return;
    const c = L_.service;
    if (!c) { box.replaceChildren(); return; }
    const q = filter.toLowerCase();
    const list = c.layers.filter((x) => !q || x.title.toLowerCase().includes(q) || x.name.toLowerCase().includes(q)).slice(0, 80);
    const search = c.layers.length > 12 ? el('input', { type: 'search', placeholder: 'In diesem Dienst suchen', 'aria-label': 'In diesem Dienst suchen', value: filter }) : null;
    search?.addEventListener('input', () => { renderService(search.value); search.focus(); });
    box.replaceChildren(...[search, layerList(list.map((x) => serviceLayer(c, x)))].filter(Boolean));
  }

  /** A KML, GPX or GeoJSON as a layer (`sourceUrl` when it came from an address, so a link can carry it). */
  function fileLayer(text, filename, sourceUrl = null) {
    const f = FileLayer.toGeoJson(text, filename);
    return {
      id: `file:${sourceUrl || `${filename}:${Date.now()}`}`, kind: 'vector', geoadmin: false, info: false, name: f.name, title: f.name,
      format: f.format, data: f.collection, bbox: null, fileBbox: f.bbox, count: f.collection.features.length, sourceUrl, attribution: `${f.format}: ${filename}`,
    };
  }
  async function fileFromUrl(url) {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return fileLayer(await r.text(), new URL(url).pathname.split('/').pop() || url, url);
  }
  async function addFile(file) {
    const status = $('layers-import-status');
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('Datei grösser als 20 MB');
      const l = fileLayer(await file.text(), file.name);
      if (addLayer(l, { opacity: 0.9 }) === false) return;
      const b = l.fileBbox;
      if (b) map.fitBounds([[b[1], b[0]], [b[3], b[2]]], { padding: [40, 40], maxZoom: 17 });
      status.textContent = `${l.format}-Datei «${l.title}»: ${l.count} Objekt${l.count === 1 ? '' : 'e'}.`;
      renderActive();
    } catch (err) {
      status.textContent = `Datei nicht gelesen: ${err.message}`;
    }
  }

  /** A short link with a QR code for this view (routes/shortlinks.js), to print or send. */
  async function shortLink() {
    const box = $('layers-qr');
    box.hidden = false;
    box.replaceChildren(el('p', { class: 'muted small', text: 'Kurzlink wird erstellt …' }));
    try {
      const d = await api('/api/kurzlink', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: shareUrl() }) });
      const local = [...L_.active.values()].some((a) => a.layer.kind === 'vector' && !a.layer.sourceUrl);
      box.replaceChildren(
        el('img', { src: d.qr, alt: `QR-Code für ${d.url}`, class: 'layers-qr-code', width: '160', height: '160' }),
        el('div', {}, [
          el('a', { href: d.url, target: '_blank', rel: 'noopener', text: d.url.replace(/^https?:\/\//, '') }),
          el('div', { class: 'layers-share' }, [
            el('button', { type: 'button', class: 'secondary small', text: 'Kopieren', onclick: (e) => copy(d.url, e.currentTarget) }),
            el('a', { class: 'small', href: d.qr, download: `myforrest-${d.code}.svg`, text: 'QR-Code speichern' }),
          ]),
          local ? el('p', { class: 'muted small', text: 'Dateien von diesem Gerät sind nicht im Link.' }) : '',
        ]),
      );
    } catch (err) {
      box.replaceChildren(el('p', { class: 'small', text: `Kein Kurzlink: ${err.message}` }));
    }
  }

  async function copy(text, button, done = 'Kopiert') {
    try { await navigator.clipboard.writeText(text); } catch { prompt('Kopieren:', text); return; }
    const before = button.textContent;
    button.textContent = done;
    setTimeout(() => { button.textContent = before; }, 1500);
  }

  /** «Weitere Karten und Dateien»: a service from the list or by address, or a file from the device. */
  function importSection() {
    const select = el('select', { id: 'layers-provider', 'aria-label': 'Anbieter' }, [
      el('option', { value: '', text: 'Anbieter wählen …' }), ...Ows.PROVIDERS.map(([title, url]) => el('option', { value: url, text: title })),
    ]);
    const url = el('input', { type: 'url', id: 'layers-service-url', placeholder: 'oder Adresse eines WMS/WMTS', 'aria-label': 'Adresse eines WMS oder WMTS' });
    select.addEventListener('change', () => { if (select.value) { url.value = select.value; loadService(select.value); } });
    const file = el('input', { type: 'file', id: 'layers-file', accept: '.kml,.gpx,.geojson,.json,application/vnd.google-earth.kml+xml,application/gpx+xml,application/geo+json' });
    file.addEventListener('change', () => { if (file.files[0]) addFile(file.files[0]); file.value = ''; });
    return el('details', { class: 'layer-group layers-import', id: 'layers-import' }, [
      el('summary', {}, [el('span', { text: 'Weitere Karten und Dateien' })]),
      select,
      el('form', { class: 'layers-paste', onsubmit: (e) => { e.preventDefault(); if (url.value.trim()) loadService(url.value.trim()); } }, [
        url, el('button', { type: 'submit', class: 'secondary small', text: 'Laden' }),
      ]),
      el('div', { id: 'layers-import-list' }),
      el('label', { class: 'small layers-file' }, [el('span', { text: 'Datei als Ebene (KML, GPX, GeoJSON), bleibt auf diesem Gerät:' }), file]),
      el('p', { id: 'layers-import-status', class: 'muted small', 'aria-live': 'polite' }),
    ]);
  }

  function buildPanel() {
    const panel = $('layerpanel');
    const search = el('input', { type: 'search', id: 'layers-search', placeholder: 'Ebene suchen, z. B. Einwohner, Wanderwege', 'aria-label': 'Ebene suchen' });
    search.addEventListener('input', () => {
      L_.filter = search.value.trim();
      render();
      clearTimeout(L_.timer);
      L_.timer = setTimeout(() => searchAll(L_.filter), 300);
    });
    const paste = el('input', { type: 'url', id: 'layers-paste', placeholder: 'Link von map.geo.admin.ch einfügen', 'aria-label': 'Link von map.geo.admin.ch' });
    const share = el('button', { type: 'button', class: 'secondary small', text: 'Link kopieren', onclick: (e) => copy(shareUrl(), e.currentTarget) });
    panel.replaceChildren(
      el('header', { class: 'sun-head' }, [
        el('div', {}, [el('p', { class: 'eyebrow', text: 'Karten und Daten' }), el('h2', { id: 'layers-title', text: 'Ebenen' }),
          el('p', { class: 'muted small', text: 'Offizielle Karten über den Spots: Wald und Waldbrand, Bevölkerung, Bodennutzung, Verkehr; regional mehr. Die Suche findet jede Ebene von geo.admin.ch.' })]),
        el('button', { type: 'button', class: 'icon', 'aria-label': 'Schliessen', text: '×', onclick: () => toggle(false) }),
      ]),
      el('ul', { id: 'layers-active', class: 'layers-active', hidden: '' }),
      el('p', { id: 'layers-hint', class: 'small layers-hint', hidden: '', text: 'Ein Klick auf die Karte zeigt, was die Ebenen dort sagen; ein Rechtsklick (lange drücken) die Koordinaten.' }),
      el('div', { id: 'layers-share', class: 'layers-share', hidden: '' }, [
        share,
        el('button', { type: 'button', class: 'link small', text: 'Kurzlink mit QR-Code', onclick: shortLink }),
        el('a', { class: 'small', target: '_blank', rel: 'noopener', text: 'In map.geo.admin.ch öffnen', href: '#', onclick: (e) => { e.currentTarget.href = geoadminUrl(); } }),
      ]),
      el('div', { id: 'layers-qr', class: 'layers-qr', hidden: '', 'aria-live': 'polite' }),
      search,
      el('p', { id: 'layers-status', class: 'muted small', 'aria-live': 'polite' }),
      el('div', { id: 'layers-groups' }),
      importSection(),
      el('form', { class: 'layers-paste', onsubmit: (e) => { e.preventDefault(); if (paste.value.trim()) applyLink(paste.value.trim()); } }, [
        paste, el('button', { type: 'submit', class: 'secondary small', text: 'Übernehmen' }),
      ]),
      el('p', { class: 'wx-source', text: 'Quellen: geo.admin.ch (BAFU, BFS, ARE, ASTRA …), Stadt Zürich, SITG Genf, EFFIS; jede Ebene nennt ihre Quelle unten rechts auf der Karte. Links im Format von map.geo.admin.ch.' }),
    );
  }

  /* ---------- What is here? ---------- */

  async function info(e) {
    const on = [...L_.active.values()].filter((a) => a.visible);
    if (!on.length || !L_.open || !$('pick-hint')?.hidden || document.querySelector('.tour-drawing') || window.Measure?.active()) return;
    const ids = on.filter((a) => a.layer.info).map((a) => a.layer.id);
    if (!ids.length) return;
    // Beside the panel (left) and the explorer card (right) the map moves so the answer stays in view.
    const wide = innerWidth > 860;
    const popup = L.popup({
      maxWidth: 320, className: 'layer-popup',
      autoPanPaddingTopLeft: wide ? [450, 240] : [16, 16], autoPanPaddingBottomRight: wide ? [380, 24] : [16, 16],
    }).setLatLng(e.latlng).setContent('Wird abgefragt …').openOn(map);
    let d;
    try {
      d = await api(`/api/layers/info?lat=${e.latlng.lat.toFixed(6)}&lon=${e.latlng.lng.toFixed(6)}&layers=${ids.map(encodeURIComponent).join(',')}`);
    } catch (err) {
      popup.setContent(`Nicht verfügbar: ${err.message}`);
      return;
    }
    popup.setContent(d.items.length
      ? el('div', {}, d.items.map((it) => el('section', {}, [el('strong', { text: it.title }),
        el('dl', {}, it.attributes.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]))])))
      : 'Die Ebenen sagen hier nichts.');
  }

  /** The place in every coordinate system, with its height and links, as the location popup of map.geo.admin.ch. */
  async function where(e) {
    if (window.Measure?.active()) return;
    const { lat, lng: lon } = e.latlng;
    const rows = Coords.format(lat, lon);
    const height = el('dd', { text: '…' });
    const copyBtn = (text) => el('button', { type: 'button', class: 'icon where-copy', text: '⧉', title: 'Kopieren', 'aria-label': `${text} kopieren`, onclick: (ev) => copy(text, ev.currentTarget, '✓') });
    const geo = GeoadminLink.link({ lat, lon, zoom: map.getZoom(), layers: linkLayers(), bgLayer: BG[window.Basemap?.current?.()] || 'ch.swisstopo.pixelkarte-farbe' });
    const box = el('div', { class: 'where' }, [
      el('dl', {}, [
        ...rows.flatMap((r) => [el('dt', { text: r.label }), el('dd', {}, [el('span', { text: r.text }), copyBtn(r.text)])]),
        el('dt', { text: 'Höhe' }), height,
      ]),
      el('p', { class: 'small' }, [
        el('a', { href: `${geo}&crosshair=marker`, target: '_blank', rel: 'noopener', text: 'In map.geo.admin.ch öffnen' }),
      ]),
    ]);
    const wide = innerWidth > 860;
    L.popup({
      minWidth: 280, maxWidth: 340, className: 'layer-popup where-popup',
      autoPanPaddingTopLeft: wide ? [450, 240] : [16, 16], autoPanPaddingBottomRight: wide ? [380, 24] : [16, 16],
    }).setLatLng(e.latlng).setContent(box).openOn(map);
    try {
      const h = await api(`/api/layers/hoehe?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}`);
      height.textContent = Number.isFinite(h.elevation) ? `${h.elevation.toLocaleString('de-CH')} m ü. M. · ${h.source}` : 'unbekannt';
    } catch {
      height.textContent = 'unbekannt';
    }
  }

  function toggle(open) {
    L_.open = open;
    $('layerpanel').hidden = !open;
    $('layers-toggle').setAttribute('aria-expanded', String(open));
    if (open) {
      for (const id of ['sun-toggle', 'species-toggle', 'tours-toggle', 'klima-toggle']) if ($(id)?.getAttribute('aria-expanded') === 'true') $(id).click();
      if (!$('layerpanel').childElementCount) buildPanel();
      load();
    }
  }

  $('layers-toggle')?.addEventListener('click', () => toggle(!L_.open));
  for (const id of ['sun-toggle', 'species-toggle', 'tours-toggle', 'klima-toggle']) {
    $(id)?.addEventListener('click', () => setTimeout(() => {
      if (L_.open && $(id).getAttribute('aria-expanded') === 'true') toggle(false);
    }));
  }
  map.on('click', info);
  map.on('contextmenu', where);
  map.on('moveend', () => { if (L_.open) render(); });
  // A link with layers or a place (MyForrest or map.geo.admin.ch syntax) opens that view; else the layers of last time
  // come back with the page, even with the panel closed.
  const fromLink = GeoadminLink.read(location.search);
  if (fromLink.layers.length || fromLink.lat !== null) setTimeout(() => applyLink(location.search), 300);
  else if (saved.length) setTimeout(() => load(), 1500);

  window.Layers = { toggle, applyLink, shareUrl, add: (title) => {
    const l = allLayers().find((x) => x.title === title);
    if (l) { addLayer(l); render(); }
    return Boolean(l);
  } };
})();
