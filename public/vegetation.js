'use strict';

/*
 * Vegetation density per photo (green fraction, canopy cover) and the
 * satellite context of a spot (NDVI and the moisture index NDMI from
 * Sentinel-2, Landsat before 2017), as small multiples on a shared time axis,
 * with drops between photos and early warnings.
 * Uses the globals of app.js (state, api, el, svg, $, fmtDate, showPhoto, openSpot).
 */

(function vegetationModule() {
  const W = 360;
  const H = 120;
  const LEFT = 34;
  const RIGHT = 8;
  const TOP = 8;
  const BOTTOM = 20;
  const DAY = 86400000;
  const pctText = (v) => `${Math.round(v * 100)} %`;
  const ndviText = (v) => v.toFixed(2).replace('-', '−');
  const INDEX = {
    ndvi: { name: 'NDVI', title: 'NDVI, Grün der Vegetation', what: 'Der NDVI (Grün der Vegetation)' },
    ndmi: { name: 'NDMI', title: 'NDMI, Feuchte im Kronendach', what: 'Der Feuchteindex NDMI (Wasser im Kronendach)' },
  };
  const SENSORS = { S2: 'Sentinel-2', L8: 'Landsat 8', L7: 'Landsat 7', L5: 'Landsat 5' };
  const monthRange = (a, b) => (a === b ? monthLabel(a) : `${monthLabel(a)} – ${monthLabel(b)}`);
  const monthMs = (ym) => Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 15);
  const monthLabel = (ym) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

  let token = 0;
  let vegData = null;
  let ndviData = null;
  let pollTimer = null;

  /** Time axis shared by all charts of the spot. */
  function timeDomain() {
    const times = [];
    for (const p of vegData?.photos || []) times.push(Date.parse(p.takenAt));
    for (const m of ndviData?.monthly || []) times.push(monthMs(m.month));
    if (!times.length) return null;
    let t0 = Math.min(...times);
    let t1 = Math.max(...times);
    if (t1 - t0 < 60 * DAY) { t0 -= 30 * DAY; t1 += 30 * DAY; }
    const pad = (t1 - t0) * 0.03;
    return [t0 - pad, t1 + pad];
  }

  function timeTicks([t0, t1]) {
    const y0 = new Date(t0).getUTCFullYear();
    const y1 = new Date(t1).getUTCFullYear();
    const years = y1 - y0;
    const ticks = [];
    if (years >= 2) {
      const step = years > 6 ? 2 : 1;
      for (let y = y0 + 1; y <= y1; y += step) ticks.push({ t: Date.UTC(y, 0, 1), label: String(y) });
    } else {
      for (let y = y0; y <= y1; y++) {
        for (const m of [0, 3, 6, 9]) {
          const t = Date.UTC(y, m, 1);
          if (t > t0 && t < t1) ticks.push({ t, label: m === 0 ? String(y) : MONTHS[m] });
        }
      }
    }
    return ticks;
  }

  /**
   * One line chart: `points` [{ t, v, label, value, extra, onClick }], y range
   * `[y0, y1]` with `yTicks`, class `cls` for the series colour. `bands` are
   * highlighted time ranges, `marks` small ticks on the time axis (photo dates).
   */
  function lineChart({ title, cls, points, domain, yRange, yTicks, yFormat, bands = [], marks = [], legend = [], caption, columns, current }) {
    const [t0, t1] = domain;
    const [y0, y1] = yRange;
    const x = (t) => LEFT + ((t - t0) / (t1 - t0)) * (W - LEFT - RIGHT);
    const y = (v) => TOP + (H - TOP - BOTTOM) * (1 - (v - y0) / (y1 - y0));
    const wrap = el('div', { class: `wx-chart veg-chart ${cls}` });
    const tip = el('div', { class: 'wx-tip', hidden: '' });
    const nodes = [];
    for (const v of yTicks) {
      nodes.push(svg('line', { class: 'grid', x1: LEFT, x2: W - RIGHT, y1: y(v), y2: y(v), ...(v === y0 ? {} : { 'stroke-dasharray': '2 3' }) }));
      nodes.push(svg('text', { class: 'axis', x: LEFT - 4, y: y(v) + 3, 'text-anchor': 'end' }, [yFormat(v)]));
    }
    for (const tk of timeTicks(domain)) {
      nodes.push(svg('text', { class: 'axis', x: x(tk.t), y: H - 6, 'text-anchor': 'middle' }, [tk.label]));
    }
    for (const b of bands) {
      nodes.push(svg('rect', { class: 'drop-band', x: x(b.from), y: TOP, width: Math.max(2, x(b.to) - x(b.from)), height: H - TOP - BOTTOM }));
      if (b.label) nodes.push(svg('text', { class: 'drop-label', x: (x(b.from) + x(b.to)) / 2, y: TOP + 10, 'text-anchor': 'middle' }, [b.label]));
    }
    for (const m of marks) {
      nodes.push(svg('path', { class: 'photo-mark', d: `M${x(m)} ${y(y0) + 1}l-3.5 5h7z` }));
    }
    // Date of the photo shown above; moved by updateCurrent().
    nodes.push(svg('line', { class: 'now', x1: x(current ?? t0), x2: x(current ?? t0), y1: TOP, y2: y(y0), visibility: current ? 'visible' : 'hidden' }));
    // Line, broken where consecutive points are far apart (missing satellite months).
    const maxGap = points.gapMs || Infinity;
    let d = '';
    points.forEach((p, i) => {
      const jump = i === 0 || p.t - points[i - 1].t > maxGap;
      d += `${jump ? 'M' : 'L'}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`;
    });
    if (d) nodes.push(svg('path', { class: 'series-line', d }));
    const cross = svg('line', { class: 'cross', x1: 0, x2: 0, y1: TOP, y2: y(y0), visibility: 'hidden' });
    nodes.push(cross);
    for (const p of points) {
      nodes.push(svg('circle', { class: `dot${p.flag ? ' flagged' : ''}`, cx: x(p.t), cy: y(p.v), r: points.length > 40 ? 2.5 : 4 }));
    }
    // Hit columns between neighbouring points: hover, focus and click.
    points.forEach((p, i) => {
      const xl = i === 0 ? LEFT : (x(points[i - 1].t) + x(p.t)) / 2;
      const xr = i === points.length - 1 ? W - RIGHT : (x(p.t) + x(points[i + 1].t)) / 2;
      const hit = svg('rect', {
        class: 'hit', x: xl, y: TOP, width: Math.max(1, xr - xl), height: H - TOP - BOTTOM,
        ...(p.onClick ? { tabindex: 0, role: 'button' } : {}), 'aria-label': `${p.label}: ${p.value}`,
      });
      const show = () => {
        tip.replaceChildren(el('strong', { text: p.label }), p.value, ...(p.extra ? [el('br'), p.extra] : []));
        tip.hidden = false;
        cross.setAttribute('x1', x(p.t));
        cross.setAttribute('x2', x(p.t));
        cross.setAttribute('visibility', 'visible');
        const box = wrap.getBoundingClientRect();
        const sv = wrap.querySelector('svg').getBoundingClientRect();
        const half = tip.offsetWidth / 2 + 4;
        tip.style.left = `${Math.min(Math.max(sv.left - box.left + (x(p.t) / W) * sv.width, half), box.width - half)}px`;
        tip.style.top = `${sv.top - box.top + (y(p.v) / H) * sv.height}px`;
      };
      const hide = () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); };
      hit.addEventListener('mouseenter', show);
      hit.addEventListener('focus', show);
      hit.addEventListener('mouseleave', hide);
      hit.addEventListener('blur', hide);
      if (p.onClick) {
        hit.addEventListener('click', p.onClick);
        hit.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.onClick(); } });
      }
      nodes.push(hit);
    });
    const table = el('div', { class: 'sr-only' }, el('table', {}, [
      el('caption', { text: caption }),
      el('tr', {}, columns.head.map((h) => el('th', { text: h }))),
      ...columns.rows.map((r) => el('tr', {}, r.map((c) => el('td', { text: c })))),
    ]));
    wrap.append(
      el('h4', { text: title }),
      ...(legend.length ? [el('div', { class: 'wx-legend' }, legend)] : []),
      svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': caption }, nodes),
      tip,
      table,
    );
    return wrap;
  }

  function photoCharts(domain) {
    const spot = state.spot;
    const rows = vegData.photos.filter((p) => typeof p.greenFraction === 'number');
    if (!rows.length) return [];
    const indexOf = (id) => spot.photos.findIndex((p) => p.id === id);
    const current = spot.photos[state.index] ? Date.parse(spot.photos[state.index].takenAt) : null;
    const make = (key, title, extra) => {
      const points = rows.map((p) => ({
        t: Date.parse(p.takenAt),
        v: p[key],
        label: fmtDate(p.takenAt),
        value: pctText(p[key]),
        extra: extra(p),
        onClick: indexOf(p.photoId) >= 0 ? () => showPhoto(indexOf(p.photoId)) : null,
      }));
      return lineChart({
        title,
        cls: 'veg',
        points,
        domain,
        yRange: [0, 1],
        yTicks: [0, 0.5, 1],
        yFormat: (v) => `${v * 100}`,
        current,
        caption: `${title} pro Foto in Prozent`,
        columns: {
          head: ['Aufnahme', `${title} (%)`, 'Ausschnitt'],
          rows: rows.map((p) => [fmtDate(p.takenAt), String(Math.round(p[key] * 100)), p.frame === 'spot' ? 'gemeinsam' : 'eigenes Foto']),
        },
      });
    };
    const frameNote = (p) => (p.frame === 'spot' ? '' : 'nicht ausgerichtet: eigener Ausschnitt');
    return [
      make('greenFraction', 'Grünanteil (%)', (p) => [`Lücken/Himmel ${pctText(p.gapFraction)}`, frameNote(p)].filter(Boolean).join(' · ')),
      make('canopyCover', 'Kronendach-Deckung, obere Bildhälfte (%)', (p) => [`Grünwert GCC ${p.gcc.toFixed(2)}`, frameNote(p)].filter(Boolean).join(' · ')),
    ];
  }

  /** Monthly chart of one satellite index ('ndvi' or 'ndmi'), with its drops between photos. */
  function indexChart(domain, key) {
    const months = ndviData.monthly.filter((m) => m[key] !== null && m[key] !== undefined);
    if (!months.length) return null;
    const info = INDEX[key];
    const drops = ndviData.drops.filter((d) => (d.index || 'ndvi') === key);
    const flagged = new Set();
    const bands = drops.map((d) => {
      const from = Date.parse(d.fromDate);
      const to = Date.parse(d.toDate);
      for (const m of months) if (monthMs(m.month) > from && monthMs(m.month) <= to + 45 * DAY) flagged.add(m.month);
      return { from, to, label: `−${d.drop.toFixed(2)}` };
    });
    const sensorsOf = (m) => (m.sensors || ['S2']).map((x) => SENSORS[x] || x).join(', ');
    const points = months.map((m) => ({
      t: monthMs(m.month),
      v: m[key],
      flag: flagged.has(m.month),
      label: monthLabel(m.month),
      value: `${info.name} ${ndviText(m[key])}`,
      extra: `${sensorsOf(m)}${key === 'ndvi' ? ` · ${m.scenes} wolkenfreie Szene${m.scenes === 1 ? '' : 'n'}` : ''}`,
    }));
    points.gapMs = 75 * DAY;
    const values = months.map((m) => m[key]);
    const yRange = key === 'ndvi' ? [Math.min(0, ...values) < 0 ? -0.2 : 0, 1] : [Math.min(-0.2, ...values), Math.max(0.6, ...values)];
    const yTicks = key === 'ndvi' ? (yRange[0] < 0 ? [-0.2, 0, 0.5, 1] : [0, 0.5, 1]) : [-0.2, 0, 0.2, 0.4, 0.6];
    const legend = [el('span', {}, [el('i', { class: `swatch-${key}` }), `${info.name} Monatswert`])];
    if (bands.length) legend.push(el('span', {}, [el('i', { class: 'swatch-drop' }), 'starker Rückgang zwischen Fotos']));
    legend.push(el('span', {}, [el('i', { class: 'swatch-photo' }), 'Fotodatum']));
    const current = state.spot.photos[state.index] ? Date.parse(state.spot.photos[state.index].takenAt) : null;
    const landsat = months.some((m) => (m.sensors || []).some((x) => x.startsWith('L')));
    return lineChart({
      title: `Satellit: ${info.title} (Monatswerte${landsat ? ', vor 2017 Landsat' : ''})`,
      cls: key,
      points,
      domain,
      yRange,
      yTicks,
      yFormat: (v) => ndviText(v),
      bands,
      marks: state.spot.photos.map((p) => Date.parse(p.takenAt)),
      legend,
      current,
      caption: `${info.name} im Umkreis des Spots, pro Monat`,
      columns: {
        head: ['Monat', info.name, 'Satellit'],
        rows: months.map((m) => [m.month, ndviText(m[key]), sensorsOf(m)]),
      },
    });
  }

  /** Storm in the period between two photos, or (`before`) in the months before an early warning. */
  const stormSentence = (storm, before = false) => (storm ? ` ${before ? 'In den Monaten davor' : 'Im Zeitraum'}: ${storm.text} (${storm.class}).` : '');

  function dropCards() {
    const photos = state.spot.photos;
    return ndviData.drops.map((d) => {
      const info = INDEX[d.index || 'ndvi'];
      const support = d.evidence.map((e) => (e.kind === 'change' ? `${e.label} (${pctText(e.area)} der Ansicht)` : `Beobachtung „${state.config.tags[e.tag] || e.tag}“`));
      const text = `${info.what} im Umkreis des Spots fiel zwischen ${fmtDate(d.fromDate)} und ${fmtDate(d.toDate)} von ${ndviText(d.before)} auf ${ndviText(d.after)} `
        + `(gleiche Jahreszeit verglichen, −${d.drop.toFixed(2)}). `
        + (d.index === 'ndmi' ? 'Weniger Wasser im Kronendach deutet auf Trockenstress oder lichtere Kronen. ' : '')
        + (support.length
          ? `Das stützt, was die Fotos zeigen: ${support.join(', ')}.`
          : 'Die Fotos zeigen dazu (noch) keine eingeordnete Veränderung; der Rückgang kann auch ausserhalb des Bildausschnitts liegen.')
        + stormSentence(d.storm);
      const idx = photos.findIndex((p) => p.id === d.toPhotoId);
      return el('article', { class: 'irregular', 'data-severity': d.severity }, [
        el('header', {}, [el('h4', { text: `Satellit: ${info.name}-Rückgang` }), el('span', { class: 'sev', text: d.severity })]),
        el('p', { text }),
        ...(idx >= 0 ? [el('button', { type: 'button', class: 'link small', text: `Foto vom ${fmtDate(d.toDate)} zeigen`, onclick: () => showPhoto(idx) })] : []),
      ]);
    });
  }

  /** Early warnings: the last months against the same season of earlier years, without new photos. */
  function alertCards() {
    return (ndviData.alerts || []).map((a) => {
      const info = INDEX[a.index];
      const text = `${info.what} lag ${monthRange(a.since, a.until)} bei ${ndviText(a.now)}, `
        + `${a.drop.toFixed(2)} unter dem Wert derselben Jahreszeit ${a.baselineYears === 1 ? 'im Vorjahr' : `in den ${a.baselineYears} Vorjahren`} (${ndviText(a.baseline)}).`
        + (a.index === 'ndmi' ? ' Das kann Trockenstress anzeigen, bevor sich die Kronen verfärben.' : '')
        + stormSentence(a.storm, true)
        + (a.visit ? ` Das letzte Foto ist ${a.lastPhoto ? `vom ${fmtDate(a.lastPhoto)}` : 'älter'}: Ein neues Foto würde zeigen, was dahinter steckt.` : '');
      return el('article', { class: 'irregular early-warning', 'data-severity': a.severity }, [
        el('header', {}, [el('h4', { text: `Satellit: Frühwarnung ${info.name}` }), el('span', { class: 'sev', text: a.severity })]),
        el('p', { text }),
      ]);
    });
  }

  function ndviStatus() {
    if (!ndviData || ndviData.status === 'disabled') return [];
    const s = ndviData;
    const out = [];
    if (s.status === 'pending') {
      out.push(el('p', { class: 'context-loading', text: 'Satellitendaten werden geladen …' }));
    } else if (s.status === 'offline' && !s.monthly.length) {
      out.push(el('p', { class: 'context-loading' }, [
        `Satellitendaten derzeit nicht erreichbar${s.error ? ` (${s.error})` : ''}. `,
        el('button', { type: 'button', class: 'link small', text: 'Erneut versuchen', onclick: retryNdvi }),
      ]));
    } else if (!s.monthly.length) {
      out.push(el('p', { class: 'context-loading', text: 'Keine wolkenfreien Satellitenaufnahmen für diesen Zeitraum gefunden.' }));
    }
    if (s.landsatError) out.push(el('p', { class: 'context-loading', text: `Landsat (vor 2017) derzeit nicht erreichbar (${s.landsatError}); wird später erneut versucht.` }));
    return out;
  }

  function render() {
    const body = $('vegetation-body');
    if (!state.spot || !body) return;
    const domain = timeDomain();
    const parts = [];
    if (vegData) {
      if (vegData.pending) parts.push(el('p', { class: 'context-loading', text: `Vegetationsdichte wird berechnet (${vegData.pending} Foto${vegData.pending === 1 ? '' : 's'}) …` }));
      if (domain) parts.push(...photoCharts(domain));
      if (vegData.photos.some((p) => p.frame === 'spot')) {
        parts.push(el('p', { class: 'hint', text: 'Aus den Bildfarben geschätzt, bei ausgerichteten Fotos im gemeinsamen Bildausschnitt des Spots. Grün = Laub und Nadeln; Kronendach-Deckung = Anteil der oberen Bildhälfte ohne sichtbaren Himmel.' }));
      }
    }
    if (ndviData && ndviData.status !== 'disabled') {
      parts.push(...alertCards());
      if (domain && ndviData.monthly.length) {
        parts.push(...['ndvi', 'ndmi'].map((k) => indexChart(domain, k)).filter(Boolean));
        parts.push(el('p', {
          class: 'hint',
          text: 'NDVI misst das Grün, NDMI das Wasser in den Blättern und Nadeln; ein sinkender NDMI zeigt Trockenstress oft vor der Verfärbung. '
            + 'Sentinel-2 mittelt rund 30 × 30 m um den Spot (NDMI 40 × 40 m), Landsat 30-m-Pixel; das umfasst mehr (und anderes) als der Bildausschnitt. '
            + `Wolken, Schatten und Schnee sind ausgeblendet. ${ndviData.source || ''}.`,
        }));
        parts.push(...dropCards());
      }
      parts.push(...ndviStatus());
    }
    $('vegetation-wrap').hidden = !parts.length;
    body.replaceChildren(...parts);
  }

  /** Moves the "current photo" line of every chart without redrawing (keeps keyboard focus). */
  function updateCurrent() {
    const domain = timeDomain();
    const p = state.spot?.photos[state.index];
    if (!domain || !p) return;
    const xv = LEFT + ((Date.parse(p.takenAt) - domain[0]) / (domain[1] - domain[0])) * (W - LEFT - RIGHT);
    for (const line of document.querySelectorAll('#vegetation-body line.now')) {
      line.setAttribute('x1', xv);
      line.setAttribute('x2', xv);
      line.setAttribute('visibility', 'visible');
    }
  }

  async function retryNdvi() {
    const id = state.spot?.id;
    ndviData = { ...ndviData, status: 'pending' };
    render();
    const fresh = await api(`/api/spots/${id}/ndvi`, { method: 'POST' }).catch(() => null);
    if (fresh && state.spot?.id === id) { ndviData = fresh; render(); }
  }

  async function load(polls = 0) {
    const my = ++token;
    clearTimeout(pollTimer);
    const id = state.spot?.id;
    if (!id) return;
    const [veg, ndvi] = await Promise.all([
      api(`/api/spots/${id}/vegetation`).catch(() => null),
      api(`/api/spots/${id}/ndvi`).catch(() => null),
    ]);
    if (my !== token || state.spot?.id !== id) return;
    vegData = veg;
    ndviData = ndvi;
    render();
    // Background work (photo analysis, satellite download) is polled for a while.
    if ((veg?.pending || ndvi?.status === 'pending') && polls < 30) {
      pollTimer = setTimeout(() => { if (state.spot?.id === id) load(polls + 1); }, polls < 5 ? 2000 : 5000);
    }
  }

  // Hook into the spot view of app.js without touching it.
  const baseOpenSpot = openSpot;
  openSpot = async function openSpotWithVegetation(...args) { // eslint-disable-line no-global-assign
    const r = await baseOpenSpot(...args);
    vegData = null;
    ndviData = null;
    $('vegetation-wrap').hidden = true;
    load();
    return r;
  };
  const baseShowPhoto = showPhoto;
  showPhoto = function showPhotoWithVegetation(...args) { // eslint-disable-line no-global-assign
    const r = baseShowPhoto(...args);
    updateCurrent();
    return r;
  };
}());
