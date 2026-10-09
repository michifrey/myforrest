'use strict';

/*
 * Landscape profiles in the spot view and glaciers (src/routes/landscapes.js):
 *   - the spot's landscape (Wald, Gletscher …) with how it was set, changeable;
 *   - for glacier spots: the glacier, where its ice was in each inventory year,
 *     the ice share of late summer from Sentinel-2, and archive photos (old
 *     pictures dated by hand, aligned with the new ones);
 *   - on the map: the glacier outlines of each inventory year.
 * Uses the globals of app.js (state, api, el, svg, $, map, openSpot, loadSpots, postPhotos).
 */

(function glacierModule() {
  const SOURCES = { auto: 'erkannt an den Gletscherumrissen', upload: 'beim Hochladen gewählt', manual: 'von Hand gesetzt' };
  let token = 0;
  let pollTimer = null;

  const landscapeLabel = (key) => state.config.landscapes?.[key]?.label || key;
  const pct = (v) => `${Math.round(v * 100)} %`;

  /* ---------- Landscape of the spot ---------- */

  function renderLandscape(spot) {
    const box = $('spot-landscape');
    const landscapes = Object.entries(state.config.landscapes || {});
    if (!box || landscapes.length < 2) return;
    const select = el('select', { 'aria-label': 'Landschaft des Spots ändern' }, [
      el('option', { value: '', text: 'automatisch' }),
      ...landscapes.map(([key, l]) => el('option', { value: key, text: l.label })),
    ]);
    select.value = spot.landscapeSource ? spot.landscape : '';
    select.addEventListener('change', async () => {
      select.disabled = true;
      try {
        await api(`/api/spots/${spot.id}/landscape`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ landscape: select.value || null }),
        });
        const photoId = state.spot?.photos[state.index]?.id;
        await Promise.all([loadSpots(), openSpot(spot.id, photoId)]);
      } catch (err) {
        alert(`Landschaft nicht geändert: ${err.message}`);
        select.disabled = false;
      }
    });
    box.replaceChildren(
      el('span', { class: `land-badge land-${spot.landscape}`, text: landscapeLabel(spot.landscape) }),
      el('span', { class: 'muted', text: spot.landscapeSource ? ` ${SOURCES[spot.landscapeSource] || ''}` : ' Standard' }),
      ' · ',
      el('label', { class: 'land-change' }, ['ändern ', select]),
    );
    box.hidden = false;
  }

  /* ---------- Glacier at the spot ---------- */

  /** "1850 und 1973" */
  const listYears = (ys) => (ys.length < 2 ? String(ys[0]) : `${ys.slice(0, -1).join(', ')} und ${ys[ys.length - 1]}`);

  function historyText(g) {
    const ice = g.history.filter((h) => h.ice && h.year).map((h) => h.year);
    const free = g.history.filter((h) => !h.ice && h.year).map((h) => h.year);
    if (!ice.length) return `In keinem Inventar (${listYears(free)}) lag hier Eis.`;
    if (!free.length) return `In allen Inventaren (${listYears(ice)}) lag hier Eis.`;
    const lastIce = Math.max(...ice);
    const after = free.filter((y) => y > lastIce);
    return after.length
      ? `Hier lag ${listYears(ice)} Eis, ${listYears(after)} nicht mehr.`
      : `Hier lag ${listYears(ice)} Eis, ${listYears(free)} nicht.`;
  }

  /** Bars of the late-summer ice share per year. */
  function iceChart(summers) {
    const W = 360; const H = 120; const left = 34; const right = 8; const top = 8; const bottom = 20;
    const n = summers.length;
    const step = (W - left - right) / n;
    const bw = Math.min(26, step * 0.7);
    const y = (v) => top + (H - top - bottom) * (1 - v);
    const nodes = [];
    for (const v of [0, 0.5, 1]) {
      nodes.push(svg('line', { class: 'grid', x1: left, x2: W - right, y1: y(v), y2: y(v), ...(v ? { 'stroke-dasharray': '2 3' } : {}) }));
      nodes.push(svg('text', { class: 'axis', x: left - 4, y: y(v) + 3, 'text-anchor': 'end' }, [pct(v)]));
    }
    summers.forEach((s, i) => {
      const cx = left + step * (i + 0.5);
      const r = svg('rect', { class: `ice-bar${s.ice < 0.5 ? ' free' : ''}`, x: cx - bw / 2, y: y(s.ice), width: bw, height: Math.max(1, y(0) - y(s.ice)) });
      r.append(svg('title', {}, [`Spätsommer ${s.year}: ${pct(s.ice)} Schnee und Eis (${MONTHS[Number(s.month.slice(5, 7)) - 1]})`]));
      nodes.push(r);
      if (n <= 12 || i % 2 === 0) nodes.push(svg('text', { class: 'axis', x: cx, y: H - 6, 'text-anchor': 'middle' }, [String(s.year)]));
    });
    const caption = 'Anteil Schnee und Eis im Spätsommer, pro Jahr';
    return el('div', { class: 'wx-chart veg-chart ice-chart' }, [
      el('h4', { text: 'Eis im Spätsommer (Sentinel-2)' }),
      svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': caption }, nodes),
      el('div', { class: 'sr-only' }, el('table', {}, [
        el('caption', { text: caption }),
        el('tr', {}, ['Jahr', 'Anteil', 'Monat'].map((h) => el('th', { text: h }))),
        ...summers.map((s) => el('tr', {}, [String(s.year), pct(s.ice), s.month].map((c) => el('td', { text: c })))),
      ])),
    ]);
  }

  /** Cumulative length change of the tongue (GLAMOS), as a line from 0 at the first measurement. */
  function lengthChart(len) {
    const W = 360; const H = 120; const left = 44; const right = 8; const top = 8; const bottom = 20;
    const pts = [{ year: len.firstYear, cumulative: 0 }, ...len.points];
    const lo = Math.min(0, ...pts.map((p) => p.cumulative));
    const hi = Math.max(0, ...pts.map((p) => p.cumulative));
    const span = (hi - lo) || 1;
    const x = (yr) => left + ((yr - len.firstYear) / Math.max(1, len.lastYear - len.firstYear)) * (W - left - right);
    const y = (v) => top + (H - top - bottom) * ((hi - v) / span);
    const fmtM = (v) => `${v < 0 ? '−' : ''}${Math.abs(Math.round(v)).toLocaleString('de-CH')} m`;
    const nodes = [];
    for (const v of [hi, (hi + lo) / 2, lo]) {
      nodes.push(svg('line', { class: 'grid', x1: left, x2: W - right, y1: y(v), y2: y(v), 'stroke-dasharray': '2 3' }));
      nodes.push(svg('text', { class: 'axis', x: left - 4, y: y(v) + 3, 'text-anchor': 'end' }, [fmtM(v)]));
    }
    nodes.push(svg('polyline', { class: 'length-line', points: pts.map((p) => `${x(p.year).toFixed(1)},${y(p.cumulative).toFixed(1)}`).join(' ') }));
    for (const yr of [len.firstYear, Math.round((len.firstYear + len.lastYear) / 2), len.lastYear]) {
      nodes.push(svg('text', { class: 'axis', x: x(yr), y: H - 6, 'text-anchor': 'middle' }, [String(yr)]));
    }
    const caption = `Längenänderung der Zunge seit ${len.firstYear}, aufsummiert`;
    return el('div', { class: 'wx-chart veg-chart length-chart' }, [
      el('h4', { text: 'Gletscherzunge (GLAMOS)' }),
      el('p', { class: 'small', text: `${len.total < 0 ? 'Rückzug' : 'Vorstoss'} seit ${len.firstYear}: ${fmtM(len.total)} (${len.observations} Messungen bis ${len.lastYear})`
        + (len.recentRate !== null ? ` · zuletzt ${len.recentRate < 0 ? '−' : '+'}${Math.abs(len.recentRate).toLocaleString('de-CH')} m pro Jahr` : '') }),
      svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': caption }, nodes),
      el('div', { class: 'sr-only' }, el('table', {}, [
        el('caption', { text: caption }),
        el('tr', {}, ['Jahr', 'Änderung', 'Summe'].map((h) => el('th', { text: h }))),
        ...len.points.map((p) => el('tr', {}, [String(p.year), fmtM(p.change), fmtM(p.cumulative)].map((c) => el('td', { text: c })))),
      ])),
    ]);
  }

  function archiveForm(spot) {
    const file = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/heic,.heic', required: '' });
    const date = el('input', { type: 'date', required: '', min: '1840-01-01', max: new Date().toISOString().slice(0, 10) });
    const status = el('p', { class: 'muted small', 'aria-live': 'polite' });
    const form = el('form', { class: 'archive-form' }, [
      el('label', {}, ['Bild (Scan, Postkarte, altes Foto) ', file]),
      el('label', {}, ['Aufnahmedatum ', date]),
      el('button', { type: 'submit', class: 'secondary', text: 'Archivfoto hinzufügen' }),
      status,
    ]);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!file.files[0] || !date.value) return;
      const fd = new FormData();
      fd.append('photos', file.files[0]);
      fd.append('spotId', String(spot.id));
      fd.append('archive', '1');
      fd.append('takenAt', new Date(`${date.value}T12:00:00Z`).toISOString());
      const latest = spot.photos[spot.photos.length - 1];
      if (latest) fd.append('refPhotoId', String(latest.id));
      status.textContent = 'Wird hochgeladen und ausgerichtet …';
      try {
        const res = await postPhotos(fd);
        if (res.queued) { status.textContent = 'Offline gespeichert; wird hochgeladen, sobald wieder Netz da ist.'; return; }
        if (!res.created?.length) throw new Error(res.skipped?.map((s) => s.reason).join(', ') || 'Upload fehlgeschlagen');
        await Promise.all([loadSpots(), openSpot(spot.id, res.created[0].id)]);
      } catch (err) {
        status.textContent = `Nicht hochgeladen: ${err.message}`;
      }
    });
    return el('details', { class: 'archive' }, [
      el('summary', { text: 'Archivfoto hinzufügen' }),
      el('p', { class: 'muted small', text: 'Alte Aufnahmen vom gleichen Standort zeigen, wie weit das Eis früher reichte. Das Datum gibst du von Hand an; das Bild wird auf die neuen Fotos ausgerichtet und erscheint im Zeitverlauf und im Vorher/Nachher.' }),
      form,
    ]);
  }

  /** Melt-out month per year (mountain spots): dots from March to August. */
  function meltChart(meltOut) {
    const W = 360; const H = 120; const left = 34; const right = 8; const top = 8; const bottom = 20;
    const n = meltOut.length;
    const step = (W - left - right) / n;
    const y = (m) => top + ((m - 3) / 5) * (H - top - bottom);
    const nodes = [];
    for (const m of [3, 4, 5, 6, 7, 8]) {
      nodes.push(svg('line', { class: 'grid', x1: left, x2: W - right, y1: y(m), y2: y(m), 'stroke-dasharray': '2 3' }));
      nodes.push(svg('text', { class: 'axis', x: left - 4, y: y(m) + 3, 'text-anchor': 'end' }, [MONTHS[m - 1]]));
    }
    const pts = meltOut.map((s, i) => [left + step * (i + 0.5), y(s.month)]);
    nodes.push(svg('path', { class: 'melt-line', d: pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`).join('') }));
    meltOut.forEach((s, i) => {
      const c = svg('circle', { class: 'melt-dot', cx: pts[i][0], cy: pts[i][1], r: 4.5 });
      c.append(svg('title', {}, [`${s.year}: aper im ${MONTHS[s.month - 1]}`]));
      nodes.push(c);
      if (n <= 12 || i % 2 === 0) nodes.push(svg('text', { class: 'axis', x: pts[i][0], y: H - 6, 'text-anchor': 'middle' }, [String(s.year)]));
    });
    const caption = 'Monat der Ausaperung (erster Monat mit weniger als der Hälfte Schnee), pro Jahr';
    return el('div', { class: 'wx-chart veg-chart melt-chart' }, [
      el('h4', { text: 'Schneeschmelze (Sentinel-2)' }),
      svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': caption }, nodes),
      el('div', { class: 'sr-only' }, el('table', {}, [
        el('caption', { text: caption }),
        el('tr', {}, ['Jahr', 'Monat'].map((h) => el('th', { text: h }))),
        ...meltOut.map((s) => el('tr', {}, [String(s.year), MONTHS[s.month - 1]].map((c) => el('td', { text: c })))),
      ])),
    ]);
  }

  /** "Aper im Mittel rund 4 Wochen früher als 2017–2019" from the first and last three years. */
  function meltTrend(meltOut) {
    if (meltOut.length < 4) return null;
    const k = Math.min(3, Math.floor(meltOut.length / 2));
    const avg = (list) => list.reduce((a, s) => a + s.month, 0) / list.length;
    const early = meltOut.slice(0, k);
    const late = meltOut.slice(-k);
    const weeks = Math.round((avg(late) - avg(early)) * 4.35);
    const span = (list) => `${list[0].year}–${list[list.length - 1].year}`;
    if (Math.abs(weeks) < 2) return `Der Schnee schmilzt ${span(late)} etwa zur selben Zeit wie ${span(early)}.`;
    return `Der Schnee schmilzt ${span(late)} im Mittel rund ${Math.abs(weeks)} Wochen ${weeks < 0 ? 'früher' : 'später'} als ${span(early)}.`;
  }

  function renderSnow(spot, data) {
    const sat = data.satellite;
    const parts = [];
    if (data.glacier && data.glacier.distanceM !== null && data.glacier.distanceM <= 3000) {
      parts.push(el('p', { class: 'small', text: `${data.glacier.name || 'Gletscher'}: Eisrand ${data.glacier.latestYear} ${data.glacier.distanceM >= 1000 ? `${(data.glacier.distanceM / 1000).toFixed(1).replace('.', ',')} km` : `${data.glacier.distanceM} m`} entfernt.` }));
    }
    if (sat.meltOut.length) {
      parts.push(meltChart(sat.meltOut));
      const trend = meltTrend(sat.meltOut);
      if (trend) parts.push(el('p', { class: 'melt-trend', text: trend }));
    }
    if (sat.status === 'pending') parts.push(el('p', { class: 'context-loading', text: 'Satellitendaten (Schnee) werden geladen …' }));
    else if (sat.status === 'offline' && !sat.meltOut.length) parts.push(el('p', { class: 'context-loading', text: 'Satellitendaten derzeit nicht erreichbar.' }));
    parts.push(archiveForm(spot));
    parts.push(el('p', {
      class: 'hint',
      text: 'Schneeschmelze: der erste Monat von März bis August, in dem die Szenenklassifikation von Sentinel-2 im Umkreis von rund 40 m weniger als die Hälfte Schnee zeigt, in Jahren mit weissem Winter. '
        + 'Eine frühere Ausaperung verlängert die Vegetationszeit und begünstigt die Verbuschung von Alpweiden.',
    }));
    return parts;
  }

  /** Archive pictures of open collections near the spot (ARCHIV_KATALOG), with one-click import. */
  let archiveCache = null; // { spotId, data }: the panel is redrawn while satellite data loads
  async function renderArchives(spot) {
    const box = $('glacier-archives');
    if (!box) return;
    let data = archiveCache?.spotId === spot.id ? archiveCache.data : undefined;
    if (data === undefined) {
      try { data = await api(`/api/spots/${spot.id}/archive-suggestions`); } catch { data = null; }
      archiveCache = { spotId: spot.id, data };
    }
    if (!data?.enabled || !data.items.length || state.spot?.id !== spot.id) { box.replaceChildren(); return; }
    const logged = Boolean(window.Account?.user);
    box.replaceChildren(
      el('h4', { text: 'Archivbilder in der Nähe' }),
      el('ul', { class: 'archive-list' }, data.items.slice(0, 6).map((it) => {
        const status = el('span', { class: 'small muted', role: 'status' });
        const take = it.photoId
          ? el('span', { class: 'small', text: 'übernommen' })
          : it.importable && logged
            ? el('button', {
              type: 'button', class: 'link small', text: 'Als Archivfoto übernehmen',
              onclick: async (e) => {
                e.target.disabled = true;
                status.textContent = 'Wird geladen und ausgerichtet …';
                try {
                  await api(`/api/spots/${spot.id}/archive-suggestions/${encodeURIComponent(it.id)}`, { method: 'POST' });
                  archiveCache = null;
                  if (typeof openSpot === 'function') openSpot(spot.id);
                } catch (err) {
                  status.textContent = err.message;
                  e.target.disabled = false;
                }
              },
            })
            : el('span', { class: 'small muted', text: it.importable ? 'Zum Übernehmen anmelden' : 'Lizenz erlaubt keine Übernahme' });
        return el('li', {}, [
          el('b', { text: `${it.year} · ${it.title}` }),
          el('span', { class: 'small muted', text: [`${it.distanceM >= 1000 ? `${(it.distanceM / 1000).toFixed(1).replace('.', ',')} km` : `${it.distanceM} m`} entfernt`, it.source, it.license].filter(Boolean).join(' · ') }),
          el('span', { class: 'archive-actions' }, [
            it.page ? el('a', { class: 'link small', href: it.page, target: '_blank', rel: 'noopener', text: 'Im Archiv ansehen' }) : '',
            take, status,
          ]),
        ]);
      })),
      el('p', { class: 'hint', text: 'Historische Fotos aus Sammlungen mit offener Lizenz, nach Standort und Blickrichtung. Übernommen werden sie als Archivfoto mit ihrem Datum und ihrer Lizenz; die Quelle steht in der Notiz.' }),
    );
  }

  function renderGlacier(spot, data) {
    const wrap = $('glacier-wrap');
    const body = $('glacier-body');
    const isGlacier = data.landscape === 'gletscher';
    $('glacier-title').textContent = data.landscape === 'gebirge' ? 'Schnee' : 'Gletscher';
    if (data.landscape === 'gebirge') {
      body.replaceChildren(...renderSnow(spot, data), el('div', { id: 'glacier-archives', class: 'glacier-archives' }));
      wrap.hidden = false;
      renderArchives(spot);
      return;
    }
    if (!isGlacier && !data.glacier) { wrap.hidden = true; return; }
    const parts = [];
    const g = data.glacier;
    if (g) {
      const where = g.distanceM === 0 ? `auf dem Eis (Stand ${g.latestYear})`
        : g.distanceM !== null ? `Eisrand ${g.latestYear}: ${g.distanceM >= 1000 ? `${(g.distanceM / 1000).toFixed(1).replace('.', ',')} km` : `${g.distanceM} m`} entfernt` : '';
      parts.push(el('p', { class: 'glacier-name' }, [el('strong', { text: g.name || 'Gletscher' }), where ? ` · ${where}` : '']));
      if (g.history.some((h) => h.year)) {
        parts.push(el('div', { class: 'glacier-history' }, g.history.filter((h) => h.year).map((h) =>
          el('span', { class: `chip ${h.ice ? 'ice' : 'free'}`, title: h.ice ? `${h.year}: im Gletscher (${h.name || 'Eis'})` : `${h.year}: eisfrei`, text: `${h.year} · ${h.ice ? 'Eis' : 'eisfrei'}` }))));
        parts.push(el('p', { class: 'small', text: historyText(g) }));
      }
    } else if (isGlacier && data.outlines) {
      parts.push(el('p', { class: 'muted small', text: 'Kein Gletscher der geladenen Inventare in der Nähe.' }));
    }
    if (data.length?.points?.length) parts.push(lengthChart(data.length));
    const sat = data.satellite;
    if (sat.summers.length) {
      parts.push(iceChart(sat.summers));
      if (sat.iceFreeSince) {
        parts.push(el('p', { class: 'glacier-free', text: `Seit dem Spätsommer ${sat.iceFreeSince} liegt hier kein Eis mehr: Der Gletscher hat diesen Ort freigegeben.` }));
      }
    }
    if (isGlacier && sat.status === 'pending') parts.push(el('p', { class: 'context-loading', text: 'Satellitendaten (Schnee und Eis) werden geladen …' }));
    else if (isGlacier && sat.status === 'offline' && !sat.summers.length) parts.push(el('p', { class: 'context-loading', text: 'Satellitendaten derzeit nicht erreichbar.' }));
    if (isGlacier) parts.push(archiveForm(spot));
    parts.push(el('p', {
      class: 'hint',
      text: [
        g ? 'Umrisse aus den Gletscherinventaren (z. B. GLAMOS, Swiss Glacier Inventory).' : '',
        data.length ? `Längenänderung: Messreihe von GLAMOS (Glacier Monitoring Switzerland) für ${data.length.name}.` : '',
        sat.summers.length ? 'Eis im Spätsommer: der kleinste Monatswert Juli bis Oktober der Szenenklassifikation von Sentinel-2 (Schnee und Eis) im Umkreis von rund 40 m; auch Firn und Altschnee zählen als weiss.' : '',
        'Gletscher nur mit Erfahrung, Ausrüstung oder Bergführer betreten: Spalten sind oft verdeckt.',
      ].filter(Boolean).join(' '),
    }));
    if (isGlacier) parts.push(el('div', { id: 'glacier-archives', class: 'glacier-archives' }));
    body.replaceChildren(...parts);
    wrap.hidden = false;
    if (isGlacier) renderArchives(spot);
  }

  async function load(spot, polls = 0) {
    const my = ++token;
    clearTimeout(pollTimer);
    const data = await api(`/api/spots/${spot.id}/glacier`).catch(() => null);
    if (my !== token || state.spot?.id !== spot.id || !data) return;
    renderGlacier(state.spot, data);
    if (['gletscher', 'gebirge'].includes(data.landscape) && data.satellite.status === 'pending' && polls < 30) {
      pollTimer = setTimeout(() => { if (state.spot?.id === spot.id) load(state.spot, polls + 1); }, polls < 5 ? 2000 : 5000);
    }
  }

  const baseOpenSpot = openSpot;
  openSpot = async function openSpotWithLandscape(...args) { // eslint-disable-line no-global-assign
    const r = await baseOpenSpot(...args);
    $('glacier-wrap').hidden = true;
    renderLandscape(state.spot);
    load(state.spot);
    return r;
  };

  const baseLoadSpots = loadSpots;
  loadSpots = async function loadSpotsWithLegend(...args) { // eslint-disable-line no-global-assign
    const r = await baseLoadSpots(...args);
    $('legend-ice').hidden = !(state.spots || []).some((s) => s.landscape === 'gletscher');
    $('legend-rock').hidden = !(state.spots || []).some((s) => s.landscape === 'gebirge');
    $('legend-sand').hidden = !(state.spots || []).some((s) => s.landscape === 'trocken');
    return r;
  };

  /* ---------- Glacier outlines on the map ---------- */

  const layer = L.layerGroup();
  let shown = false;
  let only = null; // one inventory year, or all
  let years = [];
  let timer = null;
  // The years of the inventories, next to the map button in the toolbar.
  const legend = el('div', { class: 'glacier-legend', hidden: '' });

  // Older inventories lighter, the latest in full colour (SVG attributes take no CSS variables).
  const ICE = [47, 134, 180];
  const shade = (year) => {
    const i = years.indexOf(year);
    const t = years.length > 1 ? Math.max(0, i) / (years.length - 1) : 1;
    const k = 0.35 + 0.65 * t;
    const [r, g, b] = ICE.map((c) => Math.round(c * k + 255 * (1 - k)));
    return { color: `rgb(${r} ${g} ${b})`, t };
  };

  function renderLegend(message = '') {
    legend.replaceChildren(
      el('strong', { text: 'Gletscherstand' }),
      ...years.map((y) => el('button', {
        type: 'button',
        class: `glacier-year${only === y ? ' active' : ''}`,
        'aria-pressed': String(only === y),
        style: `--swatch: ${shade(y).color}`,
        text: String(y),
        onclick: () => { only = only === y ? null : y; renderLegend(); refresh(); },
      })),
      ...(message ? [el('span', { class: 'muted small', text: message })] : []),
    );
  }

  async function refresh() {
    if (!shown) return;
    if (map.getZoom() < 9) { layer.clearLayers(); renderLegend('Zum Anzeigen hineinzoomen'); return; }
    const b = map.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => v.toFixed(4)).join(',');
    const fc = await api(`/api/glaciers?bbox=${bbox}${only ? `&year=${only}` : ''}`).catch(() => null);
    if (!fc || !shown) return;
    years = fc.years;
    layer.clearLayers();
    // Oldest first, so the smaller recent outlines lie on top.
    const features = [...fc.features].sort((a, c) => (a.properties.year ?? 0) - (c.properties.year ?? 0));
    for (const f of features) {
      const { color, t } = shade(f.properties.year);
      L.geoJSON(f, {
        style: { className: 'glacier-outline', color, weight: t === 1 ? 2 : 1.4, dashArray: t === 1 ? null : '4 3', fillColor: color, fillOpacity: 0.12 + 0.18 * t },
      }).bindTooltip(`${f.properties.name} · Stand ${f.properties.year ?? 'unbekannt'}`, { sticky: true }).addTo(layer);
    }
    renderLegend(fc.features.length ? '' : 'Keine Gletscher in diesem Ausschnitt');
  }

  function toggle(on) {
    shown = on;
    $('glacier-toggle').setAttribute('aria-pressed', String(on));
    legend.hidden = !on;
    if (on) {
      layer.addTo(map);
      refresh();
    } else {
      layer.remove();
    }
  }

  map.on('moveend', () => { clearTimeout(timer); timer = setTimeout(refresh, 250); });

  // The config is loaded by app.js (until then it holds placeholders); wait for it before showing the map button.
  (async function init() {
    while (!state.config.landscapes) await new Promise((r) => setTimeout(r, 50));
    if (!state.config.glaciers) return;
    years = state.config.glaciers.years;
    const button = $('glacier-toggle');
    button.hidden = false;
    button.after(legend);
    button.addEventListener('click', () => toggle(!shown));
  }());

  window.Glaciers = { toggle };
}());
