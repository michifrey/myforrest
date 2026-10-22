'use strict';

/*
 * Panel "Ebenen" of the main map (src/routes/layers.js): layers of external sources over the map, grouped by
 * theme (forest and forest fire, population, land use, traffic, regional services such as Zürich's tree register),
 * several at once, each with opacity and legend. A click on the map asks what the switched-on layers say there.
 * Uses the globals of app.js (map, api, el, $, state).
 */

(function layersModule() {
  const STORE = 'myforrest-layers';
  const MAX = 4;
  const L_ = { open: false, catalogue: null, active: new Map(), filter: '' };
  const saved = (() => { try { return JSON.parse(localStorage.getItem(STORE)) || []; } catch { return []; } })();
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify([...L_.active.values()].map((a) => ({ url: a.layer.url, name: a.layer.name, opacity: a.opacity })))); } catch { /* private mode */ } };

  const inView = (l) => {
    if (!l.bbox) return true;
    const c = map.getCenter();
    return c.lng >= l.bbox[0] && c.lng <= l.bbox[2] && c.lat >= l.bbox[1] && c.lat <= l.bbox[3];
  };

  function addLayer(l, opacity = 0.7) {
    if (L_.active.has(l.id)) return;
    if (L_.active.size >= MAX) {
      $('layers-status').textContent = `Höchstens ${MAX} Ebenen zugleich.`;
      return false;
    }
    const tile = L.tileLayer.wms(l.url, {
      layers: l.name, format: 'image/png', transparent: true, version: '1.3.0', opacity, attribution: l.attribution, className: 'ext-layer',
    }).addTo(map);
    L_.active.set(l.id, { layer: l, tile, opacity });
    save();
    return true;
  }
  function removeLayer(id) {
    const a = L_.active.get(id);
    if (!a) return;
    map.removeLayer(a.tile);
    L_.active.delete(id);
    save();
  }

  function renderActive() {
    const box = $('layers-active');
    if (!box) return;
    box.replaceChildren(...[...L_.active.values()].map((a) => {
      const range = el('input', { type: 'range', min: '0.2', max: '1', step: '0.1', value: String(a.opacity), 'aria-label': `Deckkraft ${a.layer.title}` });
      range.addEventListener('input', () => { a.opacity = Number(range.value); a.tile.setOpacity(a.opacity); save(); });
      const legend = el('img', { src: a.layer.legend, alt: `Legende ${a.layer.title}`, loading: 'lazy', class: 'layer-legend' });
      legend.addEventListener('error', () => legend.remove());
      return el('li', {}, [
        el('div', { class: 'layer-head' }, [
          el('strong', { text: a.layer.title }),
          el('button', { type: 'button', class: 'link small', text: 'entfernen', onclick: () => { removeLayer(a.layer.id); render(); } }),
        ]),
        el('label', { class: 'small k-row' }, ['Deckkraft ', range]),
        el('details', { class: 'small' }, [el('summary', { text: 'Legende' }), legend]),
      ]);
    }));
    box.hidden = !L_.active.size;
    $('layers-hint').hidden = !L_.active.size;
  }

  function render() {
    const list = $('layers-groups');
    if (!list || !L_.catalogue) return;
    const q = L_.filter.toLowerCase();
    const groups = L_.catalogue.groups.map((g) => ({ ...g, layers: g.layers.filter((l) => inView(l) && (!q || l.title.toLowerCase().includes(q))) }))
      .filter((g) => g.layers.length);
    list.replaceChildren(...groups.map((g, i) => el('details', { class: 'layer-group', ...(i === 0 || q ? { open: '' } : {}) }, [
      el('summary', {}, [el('span', { text: g.title }), el('span', { class: 'muted small', text: ` ${g.layers.length}` })]),
      el('ul', {}, g.layers.map((l) => {
        const box = el('input', { type: 'checkbox', value: l.id });
        box.checked = L_.active.has(l.id);
        box.addEventListener('change', () => {
          if (box.checked) { if (addLayer(l) === false) box.checked = false; } else removeLayer(l.id);
          renderActive();
        });
        return el('li', {}, [el('label', {}, [box, ` ${l.title}`])]);
      })),
    ])));
    if (!groups.length) list.replaceChildren(el('p', { class: 'muted small', text: q ? 'Keine Ebene mit diesem Namen.' : 'Keine Ebenen verfügbar.' }));
    renderActive();
  }

  async function load() {
    if (L_.catalogue) return;
    $('layers-status').textContent = 'Ebenen werden geladen …';
    try {
      L_.catalogue = await api('/api/layers');
      $('layers-status').textContent = L_.catalogue.errors?.length && !L_.catalogue.groups.length ? `Nicht erreichbar: ${L_.catalogue.errors.join('; ')}` : '';
    } catch (err) {
      $('layers-status').textContent = `Ebenen nicht verfügbar: ${err.message}`;
      return;
    }
    // Layers switched on last time.
    for (const s of saved) {
      const l = L_.catalogue.groups.flatMap((g) => g.layers).find((x) => x.url === s.url && x.name === s.name);
      if (l) addLayer(l, s.opacity);
    }
    render();
  }

  function buildPanel() {
    const panel = $('layerpanel');
    const search = el('input', { type: 'search', id: 'layers-search', placeholder: 'Ebene suchen, z. B. Einwohner', 'aria-label': 'Ebene suchen' });
    search.addEventListener('input', () => { L_.filter = search.value.trim(); render(); });
    panel.replaceChildren(
      el('header', { class: 'sun-head' }, [
        el('div', {}, [el('p', { class: 'eyebrow', text: 'Karten und Daten' }), el('h2', { id: 'layers-title', text: 'Ebenen' }),
          el('p', { class: 'muted small', text: 'Offizielle Karten über den Spots: Wald und Waldbrand, Bevölkerung, Bodennutzung, Verkehr; regional mehr.' })]),
        el('button', { type: 'button', class: 'icon', 'aria-label': 'Schliessen', text: '×', onclick: () => toggle(false) }),
      ]),
      el('ul', { id: 'layers-active', class: 'layers-active', hidden: '' }),
      el('p', { id: 'layers-hint', class: 'small layers-hint', hidden: '', text: 'Ein Klick auf die Karte zeigt, was die Ebenen dort sagen.' }),
      search,
      el('p', { id: 'layers-status', class: 'muted small' }),
      el('div', { id: 'layers-groups' }),
      el('p', { class: 'wx-source', text: 'Quellen: geo.admin.ch (BAFU, BFS, ARE, ASTRA …), Stadt Zürich, SITG Genf, EFFIS; jede Ebene nennt ihre Quelle unten rechts auf der Karte.' }),
    );
  }

  /* ---------- What is here? ---------- */

  async function info(e) {
    if (!L_.active.size || !L_.open || !$('pick-hint')?.hidden || document.querySelector('.tour-drawing')) return;
    const ids = [...L_.active.values()].filter((a) => a.layer.info).map((a) => a.layer.id);
    if (!ids.length) return;
    // Beside the panel (left) and the explorer card (right) the map moves so the answer stays in view.
    const wide = innerWidth > 860;
    const popup = L.popup({
      maxWidth: 320, className: 'layer-popup',
      autoPanPaddingTopLeft: wide ? [450, 240] : [16, 16], autoPanPaddingBottomRight: wide ? [380, 24] : [16, 16],
    }).setLatLng(e.latlng).setContent('Wird abgefragt …').openOn(map);
    let d;
    try {
      d = await api(`/api/layers/info?lat=${e.latlng.lat.toFixed(6)}&lon=${e.latlng.lng.toFixed(6)}&layers=${ids.join(',')}`);
    } catch (err) {
      popup.setContent(`Nicht verfügbar: ${err.message}`);
      return;
    }
    popup.setContent(d.items.length
      ? el('div', {}, d.items.map((it) => el('section', {}, [el('strong', { text: it.title }),
        el('dl', {}, it.attributes.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]))])))
      : 'Die Ebenen sagen hier nichts.');
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
  map.on('moveend', () => { if (L_.open) render(); });
  // Layers switched on last time come back with the page, even with the panel closed.
  if (saved.length) setTimeout(() => load(), 1500);

  window.Layers = { toggle, add: (title) => {
    const l = L_.catalogue?.groups.flatMap((g) => g.layers).find((x) => x.title === title);
    if (l) { addLayer(l); render(); }
    return Boolean(l);
  } };
})();
