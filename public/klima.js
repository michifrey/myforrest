'use strict';

/*
 * "Klima im Wandel" (src/routes/klima.js): a dossier of the region around the
 * map centre or a spot, and a short version in the spot's tab "Klima".
 *   - warming stripes since 1940 (ERA5) and of the nearest homogeneous series
 *     of MeteoSchweiz (since 1864, when loaded);
 *   - what changed per indicator, 1961–1990 against the last ten years;
 *   - a timeline that puts the observations of the spots (photos, notes,
 *     storms, summer NDVI, leaf-out, snow melt, ice) under the summers of the
 *     same years;
 *   - the synthesis, the outlook from the climate models (and CH2025) and the sources.
 * Uses the globals of app.js (state, api, el, svg, $, map, openSpot, selectSpotTab).
 */

(function klimaModule() {
  // Diverging palette of the warming stripes (cold to warm), one step per 0.325 °C.
  const STRIPES = ['#08306b', '#08519c', '#2171b5', '#4292c6', '#6baed6', '#9ecae1', '#c6dbef', '#deebf7',
    '#fee0d2', '#fcbba1', '#fc9272', '#fb6a4a', '#ef3b2c', '#cb181d', '#a50f15', '#67000d'];
  const STEP = 0.325;
  const stripeColour = (a) => STRIPES[Math.max(0, Math.min(15, Math.floor(a / STEP) + 8))];
  // Summer rain in % of the normal: dry (brown) to wet (blue).
  const RAIN = ['#8c510a', '#bf812d', '#dfc27d', '#f6e8c3', '#c7eae5', '#80cdc1', '#35978f', '#01665e'];
  const rainColour = (pct) => RAIN[Math.max(0, Math.min(7, Math.floor((pct - 40) / 20)))];
  const KIND = { klima: 'Klima', beobachtung: 'Fotos', satellit: 'Satellit', phaenologie: 'Phänologie', zukunft: 'Ausblick' };
  const RADII = [5, 15, 30];
  const HEAT_NOTES = ['trockenheit', 'waerme', 'fruehe_verfaerbung', 'borkenkaefer_risiko', 'nadelverfaerbung'];
  const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

  const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toLocaleString('de-CH', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–');
  const signed = (v, unit = '', d = 1) => (Number.isFinite(v) ? `${v > 0 ? '+' : v < 0 ? '−' : '±'}${fmt(Math.abs(v), d)}${unit ? ` ${unit}` : ''}` : '–');
  const dateOfDoy = (doy) => {
    const d = new Date(Date.UTC(2021, 0, doy));
    return `${d.getUTCDate()}. ${MONTHS[d.getUTCMonth()]}`;
  };
  const title = (text) => svg('title', {}, [document.createTextNode(text)]);

  /* ---------- Charts ---------- */

  /** Warming stripes: one bar per year, coloured by the anomaly, with decade labels. */
  function stripesChart(stripes, { height = 120, labels = true, label = 'Klimastreifen' } = {}) {
    const W = 1000;
    const H = height + (labels ? 22 : 0);
    const n = stripes.length;
    const w = W / n;
    const nodes = stripes.map((s, i) => svg('rect', { x: (i * w).toFixed(2), y: 0, width: (w + 0.6).toFixed(2), height, fill: stripeColour(s.anomaly) },
      [title(`${s.year}: ${fmt(s.value, 1)} °C (${signed(s.anomaly, '°C')} gegenüber 1961–1990)`)]));
    if (labels) {
      for (let i = 0; i < n; i++) {
        const y = stripes[i].year;
        // Every 20 years, the first and the last year (without crowding the last label).
        if ((y % 20 === 0 && n - 1 - i >= Math.max(4, n / 25)) || i === 0 || i === n - 1) {
          const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
          nodes.push(svg('text', { x: (i * w + (i === n - 1 ? w : i === 0 ? 0 : w / 2)).toFixed(1), y: H - 4, 'text-anchor': anchor, class: 'k-axis' }, [document.createTextNode(String(y))]));
        }
      }
    }
    return svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'k-stripes', role: 'img', 'aria-label': label, preserveAspectRatio: 'none' }, nodes);
  }

  /** Small bars of one indicator per year with the 1961–1990 mean as a line. */
  function sparkBars(years, key, ref) {
    const W = 240; const H = 46;
    const pts = years.filter((r) => Number.isFinite(r[key]));
    if (pts.length < 10) return null;
    const max = Math.max(...pts.map((r) => r[key]), ref || 0, 1);
    const w = W / pts.length;
    const nodes = pts.map((r, i) => svg('rect', {
      x: (i * w).toFixed(2), y: (H - (r[key] / max) * H).toFixed(1), width: Math.max(0.8, w - 0.6).toFixed(2), height: ((r[key] / max) * H).toFixed(1),
      class: r.year >= 1991 ? 'k-bar now' : 'k-bar',
    }, [title(`${r.year}: ${fmt(r[key])}`)]));
    if (Number.isFinite(ref)) nodes.push(svg('line', { x1: 0, x2: W, y1: H - (ref / max) * H, y2: H - (ref / max) * H, class: 'k-ref' }));
    return svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'k-spark', preserveAspectRatio: 'none', 'aria-hidden': 'true' }, nodes);
  }

  /** Observed anomalies (yearly and ten-year mean) and the climate models to 2050, against 1991–2020. */
  function outlookChart(years, models) {
    const W = 1000; const H = 300; const left = 44; const right = 12; const top = 14; const bottom = 26;
    const base = mean(years.filter((r) => r.year >= 1991 && r.year <= 2020).map((r) => r.tmean));
    const obs = years.map((r) => ({ year: r.year, a: r.tmean - base }));
    const names = Object.keys(models || {});
    const allA = [...obs.map((o) => o.a), ...names.flatMap((m) => models[m].map((p) => p.anomaly))];
    const lo = Math.floor(Math.min(-1.5, ...allA)); const hi = Math.ceil(Math.max(2, ...allA));
    const x0 = obs[0]?.year ?? 1940; const x1 = 2050;
    const x = (yr) => left + ((yr - x0) / (x1 - x0)) * (W - left - right);
    const y = (a) => top + ((hi - a) / (hi - lo)) * (H - top - bottom);
    const nodes = [];
    for (let a = lo; a <= hi; a++) {
      nodes.push(svg('line', { x1: left, x2: W - right, y1: y(a), y2: y(a), class: a === 0 ? 'k-zero' : 'k-grid' }));
      nodes.push(svg('text', { x: left - 6, y: y(a) + 4, 'text-anchor': 'end', class: 'k-axis' }, [document.createTextNode(`${a > 0 ? '+' : a < 0 ? '−' : ''}${Math.abs(a)} °C`)]));
    }
    for (let yr = Math.ceil(x0 / 20) * 20; yr <= x1; yr += 20) {
      nodes.push(svg('text', { x: x(yr), y: H - 6, 'text-anchor': 'middle', class: 'k-axis' }, [document.createTextNode(String(yr))]));
    }
    // Spread of the models (smoothed over ten years) as a band, the median as a dashed line.
    const smooth = (pts) => pts.map((p, i) => {
      const win = pts.slice(Math.max(0, i - 5), i + 5);
      return { year: p.year, a: mean(win.map((q) => q.a ?? q.anomaly)) };
    });
    if (names.length) {
      const byYear = new Map();
      for (const m of names) for (const p of smooth(models[m])) (byYear.get(p.year) || byYear.set(p.year, []).get(p.year)).push(p.a);
      const yrs = [...byYear.keys()].sort((a, b) => a - b);
      const band = [...yrs.map((yr) => `${x(yr).toFixed(1)},${y(Math.max(...byYear.get(yr))).toFixed(1)}`),
        ...yrs.reverse().map((yr) => `${x(yr).toFixed(1)},${y(Math.min(...byYear.get(yr))).toFixed(1)}`)];
      yrs.reverse();
      nodes.push(svg('polygon', { points: band.join(' '), class: 'k-band' }, [title(`Spanne von ${names.length} Klimamodellen (Zehnjahresmittel)`)]));
      nodes.push(svg('polyline', { points: yrs.map((yr) => `${x(yr).toFixed(1)},${y(medianOf(byYear.get(yr))).toFixed(1)}`).join(' '), class: 'k-model' },
        [title('Median der Klimamodelle')]));
    }
    nodes.push(svg('polyline', { points: obs.map((o) => `${x(o.year).toFixed(1)},${y(o.a).toFixed(1)}`).join(' '), class: 'k-obs-year' }));
    nodes.push(svg('polyline', { points: smooth(obs).map((o) => `${x(o.year).toFixed(1)},${y(o.a).toFixed(1)}`).join(' '), class: 'k-obs' },
      [title('Gemessen (ERA5), Zehnjahresmittel')]));
    for (const o of obs) nodes.push(svg('circle', { cx: x(o.year), cy: y(o.a), r: 2.6, fill: stripeColour(o.a + (base - meanRef(years))), class: 'k-dot' }, [title(`${o.year}: ${signed(o.a, '°C')} gegenüber 1991–2020`)]));
    nodes.push(svg('text', { x: W - right, y: y(0) - 6, 'text-anchor': 'end', class: 'k-axis' }, [document.createTextNode('Mittel 1991–2020')]));
    return svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'k-outlook', role: 'img', 'aria-label': 'Temperatur gemessen und nach Klimamodellen bis 2050' }, nodes);
  }
  function mean(xs) {
    const v = xs.filter(Number.isFinite);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
  }
  function medianOf(xs) {
    const v = [...xs].sort((a, b) => a - b);
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }
  const meanRef = (years) => mean(years.filter((r) => r.year >= 1961 && r.year <= 1990).map((r) => r.tmean));

  /**
   * Timeline: per year one column, per source one lane. The summers on top (temperature and rain
   * against 1991–2020), below what the spots and the stations of the region recorded in that year.
   */
  function timeline(d) {
    const years = d.years || [];
    const obs = d.observations || {};
    const obsYears = Object.keys(obs).map(Number);
    const last = years.length ? years[years.length - 1].year : Math.max(...obsYears);
    const first = Math.max(years[0]?.year ?? 1940, Math.min(last - 29, ...obsYears.filter((y) => y > 1900)));
    const cols = [];
    for (let y = first; y <= last; y++) cols.push(y);
    const byYear = new Map(years.map((r) => [r.year, r]));
    const nT = mean(years.filter((r) => r.year >= 1991 && r.year <= 2020).map((r) => r.summerT));
    const nP = mean(years.filter((r) => r.year >= 1991 && r.year <= 2020).map((r) => r.summerP));
    const heat = (o) => HEAT_NOTES.reduce((n, k) => n + (o?.notes?.[k] || 0), 0);
    // Phenology as days before (−) or after the mean of all years shown; the date in the tooltip.
    const phenoMean = (key) => mean(cols.map((y) => obs[y]?.[key]));
    const pheno = (y, key, name) => {
      const v = obs[y]?.[key];
      if (!Number.isFinite(v)) return null;
      const dd = Math.round(v - phenoMean(key));
      return { text: dd ? `${dd > 0 ? '+' : '−'}${Math.abs(dd)}` : '±0', cls: `k-n pheno${dd < 0 ? ' early' : dd > 0 ? ' late' : ''}`, tip: `${name} der Buche ${y}: ${dateOfDoy(v)} (${dd ? `${Math.abs(dd)} Tage ${dd < 0 ? 'früher' : 'später'} als im Mittel` : 'wie im Mittel'})` };
    };
    const lanes = [
      { label: 'Sommer', note: 'Temperatur Jun–Aug gegenüber 1991–2020', cell: (y) => {
        const v = byYear.get(y)?.summerT; if (!Number.isFinite(v)) return null;
        return { fill: stripeColour((v - nT) * 1.2), tip: `Sommer ${y}: ${fmt(v, 1)} °C (${signed(v - nT, '°C')})` };
      } },
      { label: 'Sommerregen', note: 'in % des Mittels', cell: (y) => {
        const v = byYear.get(y)?.summerP; if (!Number.isFinite(v) || !nP) return null;
        const pct = (v / nP) * 100;
        return { fill: rainColour(pct), tip: `Sommerregen ${y}: ${fmt(v)} mm (${fmt(pct)} %)` };
      } },
      { label: 'Fotos', obs: true, cell: (y) => (obs[y]?.photos ? { text: String(obs[y].photos), cls: 'k-n', tip: `${obs[y].photos} Fotos, ${obs[y].spots || 0} neue Spots` } : null) },
      { label: 'Trockenheit & Hitze', note: 'Hinweise der Fotos', obs: true, cell: (y) => {
        const n = heat(obs[y]); return n ? { text: String(n), cls: 'k-n heat', tip: Object.entries(obs[y].notes).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(', ') } : null;
      } },
      { label: 'Stürme', obs: true, cell: (y) => {
        const s = obs[y]?.storms || []; if (!s.length) return null;
        return { text: s.some((e) => e.windthrow) ? '▲' : '◆', cls: `k-n storm${s.some((e) => e.windthrow) ? ' throw' : ''}`, tip: s.map((e) => `${e.date}: ${e.gust} km/h${e.windthrow ? ', Windwurf' : ''}`).join('\n') };
      } },
      { label: 'NDVI Hochsommer', note: 'Wald-Spots, Sentinel-2/Landsat', obs: true, cell: (y) => {
        const v = obs[y]?.ndviSummer; if (!Number.isFinite(v)) return null;
        return { fill: `rgb(47 125 52 / ${Math.max(0.12, Math.min(1, (v - 0.55) / 0.35)).toFixed(2)})`, tip: `NDVI Jul–Aug ${y}: ${v.toFixed(2)}` };
      } },
      { label: 'Austrieb Buche', note: 'Tage früher (−) oder später als im Mittel', obs: true, cell: (y) => pheno(y, 'leafOut', 'Blattentfaltung') },
      { label: 'Verfärbung Buche', note: 'Stationen der Region', obs: true, cell: (y) => pheno(y, 'colour', 'Blattverfärbung') },
      { label: 'Schneeschmelze', note: 'Gebirge-Spots', obs: true, cell: (y) => (Number.isFinite(obs[y]?.meltMonth) ? { text: MONTHS[Math.round(obs[y].meltMonth) - 1], cls: 'k-n snow', tip: `Aper ${y} im ${MONTHS[Math.round(obs[y].meltMonth) - 1]}` } : null) },
      { label: 'Eis im Spätsommer', note: 'Gletscher-Spots', obs: true, cell: (y) => (Number.isFinite(obs[y]?.iceShare) ? { text: `${Math.round(obs[y].iceShare * 100)}`, cls: 'k-n ice', tip: `Schnee und Eis ${y}: ${Math.round(obs[y].iceShare * 100)} %` } : null) },
      { label: 'Neophyten', note: 'Funde', obs: true, cell: (y) => (obs[y]?.neophytes ? { text: String(obs[y].neophytes), cls: 'k-n neo', tip: `${obs[y].neophytes} Funde invasiver Neophyten` } : null) },
    ].filter((l) => cols.some((y) => l.cell(y)));
    const grid = el('div', { class: 'k-timeline', style: `--cols:${cols.length}`, role: 'table', 'aria-label': 'Zeitachse: Klima und Beobachtungen der Region' });
    grid.append(el('div', { class: 'k-lane-head', role: 'rowheader' }), ...cols.map((y) => el('div', { class: `k-year${y % 5 === 0 ? ' major' : ''}`, text: y % 5 === 0 ? String(y) : '', title: String(y) })));
    let obsStarted = false;
    for (const lane of lanes) {
      if (lane.obs && !obsStarted) {
        obsStarted = true;
        grid.append(el('div', { class: 'k-divider', text: 'Was MyForrest in der Region sah' }));
      }
      grid.append(el('div', { class: 'k-lane-head', role: 'rowheader' }, [el('strong', { text: lane.label }), lane.note ? el('span', { text: lane.note }) : '']));
      for (const y of cols) {
        const c = lane.cell(y);
        grid.append(el('div', { class: `k-cell ${c?.cls || ''}`, title: c?.tip || `${lane.label} ${y}: keine Daten`, style: c?.fill ? `background:${c.fill}` : '' }, c?.text ? [c.text] : []));
      }
    }
    return grid;
  }

  /* ---------- Sections ---------- */

  function placeLine(d) {
    const c = d.centre;
    const ns = `${fmt(Math.abs(c.lat), 3)}° ${c.lat >= 0 ? 'N' : 'S'}, ${fmt(Math.abs(c.lon), 3)}° ${c.lon >= 0 ? 'O' : 'W'}`;
    return `${ns}${Number.isFinite(c.elevation) ? ` · ${fmt(c.elevation)} m ü. M.` : ''} · ${d.spots} Spot${d.spots === 1 ? '' : 's'} im Umkreis von ${d.radiusKm} km`;
  }

  function changeCards(d) {
    const keys = ['hotDays', 'tropicalNights', 'summerDays', 'frostDays', 'snowDays', 'growingDays', 'summerP', 'dryRun'];
    const cards = [];
    for (const k of keys) {
      const c = d.climate.changes.find((x) => x.key === k);
      if (!c || !Number.isFinite(c.delta)) continue;
      if (['tropicalNights', 'hotDays', 'snowDays'].includes(k) && !(c.ref >= 0.5 || c.recent >= 0.5)) continue;
      const pct = Number.isFinite(c.percent) ? ` (${c.percent > 0 ? '+' : ''}${c.percent} %)` : '';
      const ind = d.indicators[k];
      const dir = c.delta > 0 ? 'up' : c.delta < 0 ? 'down' : '';
      cards.push(el('article', { class: 'k-card' }, [
        el('h4', { text: c.label }),
        el('p', { class: `k-delta ${dir}`, text: `${signed(c.delta, '', ind.digits)}${pct}` }),
        el('p', { class: 'k-then-now', text: `${fmt(c.ref, ind.digits)} → ${fmt(c.recent, ind.digits)} ${c.unit}` }),
        sparkBars(d.years, k, c.ref) || '',
        el('p', { class: 'k-foot', text: `1961–1990 → ${d.climate.periods.recent.join('–')}` }),
      ]));
    }
    return el('div', { class: 'k-cards' }, cards);
  }

  function synthesisList(items) {
    return el('ol', { class: 'k-synth' }, items.map((s) => el('li', { class: `k-${s.kind}` }, [
      el('span', { class: 'k-kind', text: KIND[s.kind] || s.kind }),
      el('strong', { text: s.title }),
      el('p', { text: s.text }),
    ])));
  }

  function projectionTable(p) {
    const keys = ['tmean', 'summerT', 'hotDays', 'tropicalNights', 'frostDays', 'snowDays', 'summerP', 'winterP'];
    // Indicators that do not occur here (no tropical nights in the mountains) are left out.
    const rows = keys.map((k) => p.indicators.find((i) => i.key === k)).filter((r) => r && (r.normal || r.high));
    const centre = Math.floor((p.future[0] + p.future[1]) / 2);
    return el('table', { class: 'k-table' }, [
      el('thead', {}, el('tr', {}, [el('th', { text: 'Kennzahl' }), el('th', { text: `${p.normal.join('–')}` }), el('th', { text: `um ${centre}` }), el('th', { text: 'Spanne der Modelle' })])),
      el('tbody', {}, rows.map((r) => el('tr', {}, [
        el('td', { text: r.label }),
        el('td', { text: `${fmt(r.normal, r.unit === '°C' ? 1 : 0)} ${r.unit}` }),
        el('td', { class: 'k-strong', text: `${fmt(r.value, r.unit === '°C' ? 1 : 0)} ${r.unit}${Number.isFinite(r.percent) ? ` (${r.percent > 0 ? '+' : ''}${r.percent} %)` : ''}` }),
        el('td', { text: `${fmt(r.low, r.unit === '°C' ? 1 : 0)}–${fmt(r.high, r.unit === '°C' ? 1 : 0)}` }),
      ]))),
    ]);
  }

  function scenarioTable(s) {
    const levels = Object.keys(s.levels).sort();
    const keys = [...new Set(levels.flatMap((l) => s.levels[l].map((r) => r.key)))];
    const cell = (l, k) => {
      const r = s.levels[l].find((x) => x.key === k);
      if (!r) return '–';
      const range = Number.isFinite(r.low) && Number.isFinite(r.high) ? ` (${fmt(r.low, 1)} bis ${fmt(r.high, 1)})` : '';
      return `${r.value > 0 ? '+' : ''}${fmt(r.value, 1)} ${r.unit}${range}`;
    };
    return el('table', { class: 'k-table' }, [
      el('thead', {}, el('tr', {}, [el('th', { text: 'Änderung gegenüber 1991–2020' }), ...levels.map((l) => el('th', { text: `+${l.replace('GWL', '')} °C global` }))])),
      el('tbody', {}, keys.map((k) => el('tr', {}, [el('td', { text: s.levels[levels[0]].find((x) => x.key === k)?.label || k }), ...levels.map((l) => el('td', { text: cell(l, k) }))]))),
    ]);
  }

  const SOURCES = [
    ['ERA5 / ERA5-Land (Copernicus, ECMWF)', 'https://open-meteo.com/en/docs/historical-weather-api', 'Tageswerte seit 1940 am Ort, über Open-Meteo, CC BY 4.0'],
    ['Homogene Messreihen der MeteoSchweiz (NBCN)', 'https://opendatadocs.meteoswiss.ch/c-climate-data/c1-climate-stations_homogeneous', 'seit 1864, Open Government Data, Quelle: MeteoSchweiz'],
    ['Klimamodelle CMIP6 HighResMIP', 'https://open-meteo.com/en/docs/climate-api', 'bis 2050, hoher Emissionspfad, über Open-Meteo'],
    ['Klimaszenarien CH2025 (MeteoSchweiz, ETH Zürich, NCCS)', 'https://www.nccs.admin.ch/', 'für +1.5, +2 und +3 °C globale Erwärmung'],
    ['Phänologie (MeteoSchweiz, DWD)', 'https://opendatadocs.meteoswiss.ch/', 'Blattaustrieb und Verfärbung der Buche'],
    ['Sentinel-2 und Landsat', 'https://dataspace.copernicus.eu/', 'NDVI, Schnee und Eis an den Spots'],
    ['IPCC AR6, Arbeitsgruppe I', 'https://www.ipcc.ch/report/ar6/wg1/', 'wann die Welt +1,5, +2 und +3 °C erreicht'],
    ['Wald und Klimawandel, Tree-App (BAFU, WSL)', 'https://www.tree-app.ch/', 'Baumartenempfehlung für jeden Waldstandort'],
    ['Karten von geo.admin.ch', 'https://map.geo.admin.ch/', 'Klimanormwerte, Höhenstufen des Waldes und weitere offizielle Karten'],
  ];

  /** One card per warming level: when it is reached, what it means here. */
  function levelCards(levels) {
    const get = (l, k) => l.indicators.find((i) => i.key === k);
    const row = (label, i, unit, d = 0, pct = false) => {
      if (!i || !Number.isFinite(i.value)) return '';
      const text = pct ? `${i.normal ? `${Math.round(((i.value - i.normal) / i.normal) * 100) > 0 ? '+' : ''}${Math.round(((i.value - i.normal) / i.normal) * 100)} %` : '–'}`
        : `${fmt(i.normal, d)} → ${fmt(i.value, d)}${unit ? ` ${unit}` : ''}`;
      return el('div', {}, [el('dt', { text: label }), el('dd', { text })]);
    };
    return el('div', { class: 'k-levels' }, levels.map((l) => {
      const t = get(l, 'tmean');
      const dd = get(l, 'beetleDD');
      return el('article', { class: `k-level k-${l.level.replace('.', '')}` }, [
        el('p', { class: 'k-kind', text: l.pathway }),
        el('h4', { text: l.title }),
        el('p', { class: 'k-level-dt', text: t ? `${signed(t.value - t.normal, '°C')} am Ort` : '' }),
        el('p', { class: 'k-when', text: l.when }),
        el('dl', { class: 'k-level-facts' }, [
          row('Jahresmittel', t, '°C', 1),
          row('Hitzetage', get(l, 'hotDays'), ''),
          row('Tropennächte', get(l, 'tropicalNights')?.value >= 1 ? get(l, 'tropicalNights') : null, ''),
          row('Frosttage', get(l, 'frostDays'), ''),
          row('Tage mit Neuschnee', get(l, 'snowDays')?.normal >= 1 ? get(l, 'snowDays') : null, ''),
          row('Sommerregen', get(l, 'summerP'), '', 0, true),
          dd ? el('div', {}, [el('dt', { text: 'Käfergenerationen' }), el('dd', { text: `${fmt(dd.normal / 557, 1)} → ${fmt(dd.value / 557, 1)}` })]) : '',
          Number.isFinite(l.shiftM) ? el('div', {}, [el('dt', { text: 'Klima wie heute' }), el('dd', { text: `${fmt(l.shiftM)} m tiefer` })]) : '',
        ]),
        el('p', { class: 'k-src', text: l.source === 'CH2025' ? 'Quelle: CH2025' : `aus den Modellen skaliert (Faktor ${fmt(l.factor, 2)})` }),
      ]);
    }));
  }

  const SEVERITY = { gering: 'gering', mittel: 'mittel', hoch: 'hoch', chance: 'Chance' };
  /** Impacts on the forest, each with its severity per warming level. */
  function forestCards(topics, levels) {
    return el('div', { class: 'k-forest' }, topics.map((t) => el('article', { class: `k-impact k-impact-${t.key}` }, [
      el('h4', { text: t.title }),
      el('ul', { class: 'k-sev', 'aria-label': 'Einschätzung pro Szenario' }, levels.map((l) => el('li', { class: `sev-${t.levels[l.level]}` },
        [el('span', { text: l.title.replace(' weltweit', '') }), el('strong', { text: SEVERITY[t.levels[l.level]] || '–' })]))),
      el('p', { text: t.text }),
    ])));
  }

  /* ---------- Dossier ---------- */

  let current = null;
  let token = 0;

  function dossier() {
    let box = $('klima');
    if (box) return box;
    box = el('section', { id: 'klima', class: 'klima-dossier', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'klima-title', hidden: '' });
    document.body.append(box);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !box.hidden) close(); });
    return box;
  }

  function close() {
    const box = $('klima');
    if (box) box.hidden = true;
    document.documentElement.classList.remove('klima-open');
    (K.open ? $('klima-dossier-here') : $('klima-toggle'))?.focus();
  }

  /** Opens the dossier for `{ lat, lon }` or `{ spot }`, with the radius in km. */
  async function open(where, radius = 15) {
    current = { ...where, radius };
    const box = dossier();
    box.hidden = false;
    document.documentElement.classList.add('klima-open');
    const my = ++token;
    box.replaceChildren(header(null, radius), el('p', { class: 'k-loading', text: 'Klimadaten seit 1940 werden geladen … beim ersten Mal kann das einige Sekunden dauern.' }));
    box.querySelector('.k-close').focus();
    const q = where.spot ? `spot=${where.spot}` : `lat=${where.lat.toFixed(4)}&lon=${where.lon.toFixed(4)}`;
    try {
      const d = await api(`/api/klima?${q}&radius=${radius}`);
      if (my !== token) return;
      render(box, d);
    } catch (err) {
      if (my !== token) return;
      box.replaceChildren(header(null, radius), el('p', { class: 'k-loading', text: `Klimadaten nicht verfügbar: ${err.message}` }));
    }
  }

  function header(d, radius) {
    const select = el('select', { 'aria-label': 'Umkreis' }, RADII.map((r) => el('option', { value: String(r), text: `${r} km` })));
    select.value = String(radius);
    select.addEventListener('change', () => open(current, Number(select.value)));
    return el('header', { class: 'k-head' }, [
      el('div', {}, [
        el('p', { class: 'eyebrow', text: 'Klima im Wandel' }),
        el('h2', { id: 'klima-title', text: d?.spot ? `Die Region um Spot ${d.spot}` : 'Die Region auf der Karte' }),
        el('p', { class: 'muted small', text: d ? placeLine(d) : '' }),
        d ? geneva3d(d.centre.lat, d.centre.lon) : '',
      ]),
      el('div', { class: 'k-head-tools' }, [el('label', { class: 'small' }, ['Umkreis ', select]),
        el('button', { type: 'button', class: 'icon k-close', 'aria-label': 'Schliessen', text: '×', onclick: close })]),
    ]);
  }

  const section = (id, heading, lead, ...body) => el('section', { class: 'k-section', 'aria-labelledby': id }, [
    el('h3', { id, text: heading }), lead ? el('p', { class: 'k-lead', text: lead }) : '', ...body,
  ]);

  function render(box, d) {
    const parts = [header(d, d.radiusKm)];
    if (!d.climate) {
      parts.push(el('p', { class: 'k-loading', text: `Die Klimareihe ist gerade nicht erreichbar${d.climateError ? ` (${d.climateError})` : ''}. Später erneut öffnen.` }));
      box.replaceChildren(...parts);
      return;
    }
    const c = d.climate;
    const [r0, r1] = c.periods.ref;
    parts.push(el('div', { class: 'k-hero' }, [
      stripesChart(c.stripes, { height: 150, label: `Klimastreifen ${c.first}–${c.last}` }),
      el('div', { class: 'k-hero-text' }, [
        el('p', { class: 'k-big', text: signed(c.warming, '°C') }),
        el('p', { text: `So viel wärmer war es ${c.periods.recent.join('–')} als ${r0}–${r1}. Jeder Streifen ist ein Jahr seit ${c.first}, von kühl (blau) bis warm (rot); Trend ${signed(c.trendPerDecade, '°C', 2)} pro Jahrzehnt seit ${r0}.` }),
        el('p', { class: 'k-src', text: `Wärmste Jahre: ${c.records.warmest.map((r) => r.year).join(', ')} · ${d.sources.era5}` }),
      ]),
    ]));
    if (d.station) {
      const s = d.station;
      parts.push(section('k-station', `Gemessen seit ${s.first}: ${s.name}`,
        `Homogene Messreihe ${s.km} km entfernt${Number.isFinite(s.elevation) ? ` auf ${fmt(s.elevation)} m` : ''}. ` +
        (Number.isFinite(s.sinceIndustrial) ? `Die letzten zehn Jahre waren ${signed(s.sinceIndustrial, '°C')} wärmer als ${s.preindustrial.join('–')}, die Zeit vor der starken Industrialisierung.` : ''),
        stripesChart(s.stripes, { height: 70, label: `Klimastreifen ${s.name}` }),
        el('p', { class: 'k-src', text: d.sources.station })));
    }
    parts.push(section('k-changes', 'Was sich verändert hat', `Kennzahlen pro Jahr am Ort, ${r0}–${r1} gegenüber den letzten zehn Jahren. Die Balken zeigen jedes Jahr seit ${c.first}, die Linie das Mittel ${r0}–${r1}.`, changeCards(d)));
    parts.push(section('k-timeline-title', 'Klima und Beobachtungen, Jahr für Jahr',
      'Oben die Sommer der Region, darunter, was die Spots, die Satelliten und die Phänologie-Stationen im selben Jahr festhielten. Ein Feld zeigt beim Überfahren die Werte.',
      el('div', { class: 'k-timeline-wrap' }, timeline(d))));
    if (d.synthesis.length) parts.push(section('k-synth-title', 'Was die Daten zusammen zeigen', 'Gleichzeitige Ereignisse sind noch kein Beweis für eine Ursache; sie zeigen, wo sich ein zweiter Blick lohnt.', synthesisList(d.synthesis)));
    if (d.projection) {
      parts.push(section('k-outlook', 'Ausblick bis 2050',
        `Gemessene Temperatur (Punkte, Linie: Zehnjahresmittel) und ${d.projection.models.length} Klimamodelle (Band und gestrichelter Median) mit einem hohen Emissionspfad, gegenüber 1991–2020. ` +
        'Für die Kennzahlen kommt die Änderung jedes Modells zum gemessenen Mittel dazu.',
        outlookChart(d.years, d.modelSeries), projectionTable(d.projection), el('p', { class: 'k-src', text: d.sources.models })));
    }
    if (d.levels?.length) {
      parts.push(section('k-levels', 'Drei Szenarien für die Region',
        'Die Klimaszenarien der Schweiz (CH2025) rechnen mit Stufen der globalen Erwärmung gegenüber 1850–1900. ' +
        (d.levels[0].source === 'CH2025' ? 'Die Zahlen stammen aus CH2025.' : 'Ohne geladene CH2025-Daten skaliert MyForrest die Änderung der Klimamodelle mit der globalen Erwärmung (Pattern Scaling); 2031–2050 entsprechen auf dem hohen Emissionspfad etwa +2 °C.'),
        levelCards(d.levels)));
    }
    if (d.forest?.length) {
      parts.push(section('k-forest', 'Was das für den Wald bedeutet',
        `Faustregeln aus dem Forschungsprogramm «Wald und Klimawandel» von BAFU und WSL, angewandt auf die Höhe (${fmt(d.centre.elevation)} m), die Szenarien und ` +
        (d.species?.length ? `die Baumarten der Spots (${d.species.map((t) => t.name).join(', ')}).` : 'die häufigen Baumarten (an den Spots sind noch keine bestimmt).') +
        ' Der Boden, vor allem wie viel Wasser er speichert, entscheidet ebenso viel; für einen Bestand gibt die Tree-App die Empfehlung.',
        forestCards(d.forest, d.levels)));
    }
    if (d.scenarios) {
      parts.push(section('k-ch2025', `Klimaszenarien CH2025: ${d.scenarios.place}`,
        `Änderungen bei 1.5, 2 und 3 °C globaler Erwärmung, für den nächsten Ort mit Szenarien (${d.scenarios.km} km).`, scenarioTable(d.scenarios)));
    }
    parts.push(section('k-sources', 'Quellen und Grenzen',
      'ERA5 rechnet auf einem Gitter von rund 9–30 km; Hitzetage und Tropennächte in Städten und Frost in Senken unterschätzt es. Die Temperatur ist auf die Höhe des Ortes umgerechnet. Die Klimamodelle bilden Jahre nicht nach, nur das Klima; einzelne Jahre im Band sind keine Prognose.',
      el('ul', { class: 'k-sources' }, SOURCES.map(([name, href, what]) => el('li', {}, [el('a', { href, target: '_blank', rel: 'noopener', text: name }), ` – ${what}`]))),
      d.phenoStations?.length ? el('p', { class: 'k-src', text: `Phänologie-Stationen: ${d.phenoStations.map((s) => `${s.name} (${s.km} km)`).join(', ')}` }) : ''));
    box.replaceChildren(...parts);
  }

  /* ---------- Spot tab ---------- */

  let spotToken = 0;
  async function renderSpot(spot) {
    const body = $('klima-spot-body');
    if (!body || !spot) return;
    const my = ++spotToken;
    body.replaceChildren(el('p', { class: 'muted small', text: 'Klimadaten seit 1940 werden geladen …' }));
    let d;
    try {
      d = await api(`/api/klima?spot=${spot.id}&radius=5`);
    } catch (err) {
      if (my === spotToken) body.replaceChildren(el('p', { class: 'muted small', text: `Klimadaten nicht verfügbar: ${err.message}` }));
      return;
    }
    if (my !== spotToken) return;
    if (!d.climate) {
      body.replaceChildren(el('p', { class: 'muted small', text: `Klimadaten nicht verfügbar${d.climateError ? `: ${d.climateError}` : ''}.` }));
      return;
    }
    const c = d.climate;
    const pick = (k) => c.changes.find((x) => x.key === k);
    const facts = ['hotDays', 'frostDays', 'snowDays'].map(pick).filter((x) => x && Number.isFinite(x.delta) && (x.ref >= 0.5 || x.recent >= 0.5));
    body.replaceChildren(
      stripesChart(c.stripes, { height: 46, labels: false, label: `Klimastreifen ${c.first}–${c.last}` }),
      el('p', { class: 'k-spot-line' }, [el('strong', { text: signed(c.warming, '°C') }), ` wärmer als 1961–1990 (${c.first}–${c.last}, ${fmt(d.centre.elevation)} m)`]),
      el('dl', { class: 'k-facts' }, facts.map((f) => el('div', {}, [el('dt', { text: f.label }), el('dd', { text: `${fmt(f.ref)} → ${fmt(f.recent)}` })]))),
      d.synthesis.length > 1 ? synthesisList(d.synthesis.slice(1, 3)) : '',
      d.forest?.length ? el('h4', { class: 'label', text: 'Was das für den Wald hier bedeutet' }) : '',
      d.forest?.length ? forestCards(d.forest.filter((t) => t.key !== 'winter').slice(0, 3), d.levels) : '',
      el('button', { type: 'button', class: 'secondary', text: 'Ganzes Klima-Dossier der Region', onclick: () => open({ spot: spot.id }, 15) }),
      geneva3d(d.centre.lat, d.centre.lon),
    );
  }

  /* ---------- Climate on the map ---------- */

  // What the cells show: value of a cell (`c`) at the chosen level (`l`), colour scale and legend.
  const WARM = ['#fff5eb', '#fee6ce', '#fdd0a2', '#fdae6b', '#fd8d3c', '#f16913', '#d94801', '#a63603', '#7f2704'];
  const DRYWET = ['#8c510a', '#bf812d', '#dfc27d', '#f6e8c3', '#c7eae5', '#80cdc1', '#35978f'];
  const LAYERS = {
    warming: { label: 'Erwärmung seit 1961–1990', unit: '°C', scenario: false, get: (c) => c.warming, steps: [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4], colours: WARM, d: 1, sign: true },
    hotNow: { label: 'Hitzetage heute (letzte 10 Jahre)', unit: 'Tage', scenario: false, get: (c) => c.hotDays, steps: [1, 3, 6, 10, 15, 20, 30, 40], colours: WARM, d: 0 },
    dT: { label: 'Wärmer als 1991–2020', unit: '°C', scenario: true, get: (c, l) => c.levels?.[l]?.dT, steps: [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4], colours: WARM, d: 1, sign: true },
    hot: { label: 'Hitzetage im Szenario', unit: 'Tage', scenario: true, get: (c, l) => c.levels?.[l]?.hotDays, steps: [1, 3, 6, 10, 15, 20, 30, 40], colours: WARM, d: 0 },
    summerP: { label: 'Sommerregen im Szenario', unit: '%', scenario: true, get: (c, l) => c.levels?.[l]?.summerP, steps: [-25, -15, -8, -3, 3, 8], colours: DRYWET, d: 0, sign: true },
    beetle: { label: 'Borkenkäfer-Generationen im Szenario', unit: '', scenario: true, get: (c, l) => c.levels?.[l]?.beetle, steps: [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4], colours: WARM, d: 1 },
    shift: { label: 'Klima wie heute … m tiefer', unit: 'm', scenario: true, get: (c, l) => c.levels?.[l]?.shiftM, steps: [100, 200, 300, 400, 500, 600, 700, 800], colours: WARM, d: 0 },
  };
  const K = { open: false, grid: null, wms: null, layer: 'dT', level: 'GWL2.0', poll: null, timer: null, data: null, wmsList: null };
  const colourOf = (def, v) => {
    if (!Number.isFinite(v)) return null;
    let i = def.steps.findIndex((s) => v < s);
    if (i < 0) i = def.steps.length;
    return def.colours[Math.min(i, def.colours.length - 1)];
  };
  const valueText = (def, v) => (Number.isFinite(v) ? `${def.sign ? signed(v, '', def.d) : fmt(v, def.d)}${def.unit ? ` ${def.unit}` : ''}` : '–');

  function buildPanel() {
    const panel = $('klimapanel');
    const layerSel = el('select', { id: 'klima-layer', class: 'small' }, Object.entries(LAYERS).map(([k, l]) => el('option', { value: k, text: l.label })));
    layerSel.value = K.layer;
    const levelSel = el('select', { id: 'klima-level', class: 'small' }, [
      el('option', { value: 'GWL1.5', text: '+1,5 °C weltweit (Pariser Ziel)' }),
      el('option', { value: 'GWL2.0', text: '+2 °C weltweit (um 2040–2060)' }),
      el('option', { value: 'GWL3.0', text: '+3 °C weltweit (ohne mehr Klimaschutz)' }),
    ]);
    levelSel.value = K.level;
    layerSel.addEventListener('change', () => { K.layer = layerSel.value; syncLevel(); drawGrid(); });
    levelSel.addEventListener('change', () => { K.level = levelSel.value; drawGrid(); });
    const gridToggle = el('input', { type: 'checkbox', id: 'klima-grid', checked: '' });
    gridToggle.addEventListener('change', () => { if (gridToggle.checked) loadGrid(); else { K.grid?.remove(); K.grid = null; } });
    const wmsSel = el('select', { id: 'klima-wms', class: 'small' }, [el('option', { value: '', text: 'keine' })]);
    wmsSel.addEventListener('change', () => setWms(wmsSel.value));
    const opacity = el('input', { type: 'range', id: 'klima-wms-opacity', min: '0.2', max: '1', step: '0.1', value: '0.7', 'aria-label': 'Deckkraft der offiziellen Karte' });
    opacity.addEventListener('input', () => K.wms?.setOpacity(Number(opacity.value)));
    panel.replaceChildren(
      el('header', { class: 'sun-head' }, [
        el('div', {}, [el('p', { class: 'eyebrow', text: 'Klima im Wandel' }), el('h2', { id: 'klima-panel-title', text: 'Klima auf der Karte' }),
          el('p', { class: 'muted small', text: 'Felder von 0,1° (rund 8 × 11 km), auf die Höhe der Feldmitte gerechnet.' })]),
        el('button', { type: 'button', class: 'icon', 'aria-label': 'Schliessen', text: '×', onclick: () => toggle(false) }),
      ]),
      el('button', { type: 'button', id: 'klima-dossier-here', class: 'btn primary wide', text: 'Klima-Dossier für die Kartenmitte', onclick: () => { const c = map.getCenter(); open({ lat: c.lat, lon: c.lng }, 15); } }),
      el('div', { class: 'k-panel-box' }, [
        el('label', { class: 'toggle small' }, [gridToggle, ' Klima-Raster auf der Karte']),
        el('label', { class: 'small k-row' }, ['Zeigen ', layerSel]),
        el('label', { class: 'small k-row', id: 'klima-level-row' }, ['Szenario ', levelSel]),
        el('div', { id: 'klima-legend', class: 'k-legend' }),
        el('p', { id: 'klima-status', class: 'muted small' }),
        el('p', { id: 'klima-when', class: 'small k-when' }),
      ]),
      el('div', { class: 'k-panel-box' }, [
        el('label', { class: 'small k-row' }, ['Offizielle Karte ', wmsSel]),
        el('label', { class: 'small k-row' }, ['Deckkraft ', opacity]),
        el('p', { id: 'klima-wms-status', class: 'muted small', text: 'Karten von geo.admin.ch, z. B. Klimanormwerte der MeteoSchweiz oder die Höhenstufen des Waldes heute und im Klimawandel (BAFU); im Kanton Genf auch Hitzeinseln und Kronendach (SITG).' }),
      ]),
      el('p', { class: 'wx-source', text: 'ERA5 und Klimamodelle (CMIP6) über Open-Meteo, Szenarien nach CH2025 und IPCC AR6; Karten: geo.admin.ch' }),
    );
    syncLevel();
  }

  const WHEN = {
    'GWL1.5': 'Pariser Ziel: Anfang der 2030er-Jahre erreicht; dabei bleibt es nur mit sehr starkem Klimaschutz.',
    'GWL2.0': 'Mit hohen Emissionen um 2040–2050, mit mittleren um 2050–2060 (IPCC AR6).',
    'GWL3.0': 'Mit mittleren Emissionen gegen Ende des Jahrhunderts, mit hohen um 2060–2070 (IPCC AR6).',
  };
  function syncLevel() {
    const def = LAYERS[K.layer];
    $('klima-level-row').hidden = !def.scenario;
    $('klima-when').textContent = def.scenario ? WHEN[K.level] : '';
    const steps = def.steps;
    $('klima-legend').replaceChildren(...def.colours.slice(0, steps.length + 1).map((c, i) => el('span', {}, [
      el('i', { style: `background:${c}` }),
      i === 0 ? `< ${fmt(steps[0], def.d)}` : i === steps.length ? `≥ ${fmt(steps[i - 1], def.d)}` : `${fmt(steps[i - 1], def.d)}`,
    ])), el('span', { class: 'k-unit', text: def.unit }));
  }

  async function loadGrid() {
    if (!K.open || !$('klima-grid')?.checked) return;
    const b = map.getBounds();
    clearTimeout(K.poll);
    let d;
    try {
      d = await api(`/api/klima/karte?bbox=${[b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => v.toFixed(3)).join(',')}`);
    } catch (err) {
      $('klima-status').textContent = `Klimaraster nicht verfügbar: ${err.message}`;
      return;
    }
    K.data = d;
    drawGrid();
    if (d.tooLarge) $('klima-status').textContent = 'Für das Klima-Raster näher heranzoomen.';
    else {
      $('klima-status').textContent = `${d.cells.length} Felder${d.pending ? `, ${d.pending} werden berechnet` : ''}` +
        (d.pending && !d.budgetLeft ? ' (Tageskontingent erreicht, morgen weiter)' : '');
      // While cells are computed in the background, ask again.
      if (d.pending && d.budgetLeft) K.poll = setTimeout(loadGrid, 6000);
    }
  }

  function drawGrid() {
    syncLevel();
    if (!K.data || !$('klima-grid')?.checked) return;
    const def = LAYERS[K.layer];
    const half = K.data.cell / 2;
    K.grid?.remove();
    K.grid = L.layerGroup(K.data.cells.map((c) => {
      const v = def.get(c, K.level);
      const colour = colourOf(def, v);
      return L.rectangle([[c.lat - half, c.lon - half], [c.lat + half, c.lon + half]], {
        className: 'k-cell-rect', weight: 0.6, color: '#ffffff', fillColor: colour || 'transparent', fillOpacity: colour ? 0.62 : 0,
      }).bindTooltip(`${def.label}: <b>${valueText(def, v)}</b><br>${fmt(c.elevation)} m · heute ${fmt(c.hotDays)} Hitzetage`, { sticky: true })
        .bindPopup(() => cellPopup(c));
    })).addTo(map);
  }

  function cellPopup(c) {
    const l = c.levels?.[K.level];
    const lv = { 'GWL1.5': '+1,5 °C', 'GWL2.0': '+2 °C', 'GWL3.0': '+3 °C' }[K.level];
    return el('div', { class: 'k-popup' }, [
      el('strong', { text: `${fmt(c.lat, 2)}° N, ${fmt(c.lon, 2)}° O · ${fmt(c.elevation)} m` }),
      el('p', { text: `Seit 1961–1990 ${signed(c.warming, '°C')}; heute ${fmt(c.hotDays)} Hitzetage, ${fmt(c.frostDays)} Frosttage.` }),
      l ? el('p', { text: `Bei ${lv} weltweit: ${signed(l.dT, '°C')} gegenüber 1991–2020, ${fmt(l.hotDays)} Hitzetage, Sommerregen ${l.summerP > 0 ? '+' : ''}${fmt(l.summerP)} %, ${fmt(l.beetle, 1)} Käfergenerationen; das Klima entspricht dem heutigen ${fmt(l.shiftM)} m tiefer.` }) : '',
      el('button', { type: 'button', class: 'btn primary', text: 'Klima-Dossier hier', onclick: () => open({ lat: c.lat, lon: c.lon }, 15) }),
      geneva3d(c.lat, c.lon),
    ]);
  }

  async function loadWms() {
    if (!K.wmsList) {
      try {
        K.wmsList = await api('/api/klima/layers');
      } catch {
        K.wmsList = { layers: [] };
      }
    }
    fillWms();
  }

  /** The maps on offer: everywhere those of geo.admin.ch, regional ones (Geneva) only when the map is there. */
  function fillWms() {
    const sel = $('klima-wms');
    if (!sel || !K.wmsList) return;
    const c = map.getCenter();
    const here = (l) => !l.bbox || (c.lng >= l.bbox[0] && c.lng <= l.bbox[2] && c.lat >= l.bbox[1] && c.lat <= l.bbox[3]);
    const chosen = sel.value;
    const groups = new Map();
    K.wmsList.layers.forEach((l, i) => { if (here(l)) (groups.get(l.group) || groups.set(l.group, []).get(l.group)).push([i, l]); });
    sel.replaceChildren(el('option', { value: '', text: 'keine' }),
      ...[...groups].map(([g, ls]) => el('optgroup', { label: g }, ls.map(([i, l]) => el('option', { value: String(i), text: l.title })))));
    sel.value = [...sel.options].some((o) => o.value === chosen) ? chosen : '';
    if (sel.value !== chosen) setWms('');
    if (!K.wmsList.layers.length) $('klima-wms-status').textContent = K.wmsList.error || 'Keine offiziellen Klimakarten gefunden.';
  }

  function setWms(value) {
    K.wms?.remove();
    K.wms = null;
    const l = value === '' ? null : K.wmsList?.layers[Number(value)];
    if (!l) return;
    K.wms = L.tileLayer.wms(l.url, {
      layers: l.name, format: 'image/png', transparent: true, version: '1.3.0', opacity: Number($('klima-wms-opacity').value),
      attribution: l.attribution || '© geo.admin.ch', className: 'k-wms',
    }).addTo(map);
  }

  // Genève 3D (geneva3d.ch): a 3D twin of the canton by Arnaud Ricci (volunteer project, beta), linked for places in Geneva.
  const GENEVA = [5.95, 46.12, 6.32, 46.37];
  const inGeneva = (lat, lon) => lon >= GENEVA[0] && lon <= GENEVA[2] && lat >= GENEVA[1] && lat <= GENEVA[3];
  const geneva3d = (lat, lon) => (inGeneva(lat, lon) ? el('p', { class: 'k-src k-g3d' }, [
    el('a', { href: 'https://geneva3d.ch/', target: '_blank', rel: 'noopener', text: 'In Genève 3D ansehen' }),
    ' – der Kanton als 3D-Modell mit 239 000 Bäumen, ÖV und Wetter (privates Projekt von Arnaud Ricci, Beta)',
  ]) : '');

  const OTHER_PANELS = ['sun-toggle', 'species-toggle', 'tours-toggle'];
  function toggle(open_) {
    K.open = open_;
    $('klimapanel').hidden = !open_;
    $('klima-toggle').setAttribute('aria-expanded', String(open_));
    if (open_) {
      // Only one map panel at a time.
      for (const id of OTHER_PANELS) if ($(id)?.getAttribute('aria-expanded') === 'true') $(id).click();
      if (!$('klimapanel').childElementCount) buildPanel();
      loadGrid();
      loadWms();
      if (K.wms) K.wms.addTo(map);
    } else {
      clearTimeout(K.poll);
      K.grid?.remove();
      K.grid = null;
      K.wms?.remove();
    }
  }

  /* ---------- Wiring ---------- */

  $('klima-toggle')?.addEventListener('click', () => toggle(!K.open));
  for (const id of OTHER_PANELS) {
    $(id)?.addEventListener('click', () => setTimeout(() => {
      if (K.open && $(id).getAttribute('aria-expanded') === 'true') toggle(false);
    }));
  }
  map.on('moveend', () => {
    clearTimeout(K.timer);
    if (K.open) K.timer = setTimeout(() => { loadGrid(); fillWms(); }, 400);
  });
  $('tab-klima')?.addEventListener('click', () => renderSpot(state.spot));

  window.Klima = { open, close, renderSpot, toggle };
})();
