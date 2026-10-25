/**
 * Landschaft im Wandel, «Von oben» (landschaft.html#oben): the Rhone valley below the Aletsch glacier seen from
 * above, 1900 to 2100. Water (glacier, river, Suonen), forest (pines giving way to oaks), food (fields, vines,
 * irrigation) and temperature (heat over the valley floor) change together; a theme can be picked to bring one to
 * the front. The numbers are in landschaft-model.js (obenStops, oben); this file draws them.
 */
(() => {
  'use strict';

  const M = window.LandschaftModel;
  const $ = (id) => document.getElementById(id);
  const SVG = 'http://www.w3.org/2000/svg';
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const state = { pos: M.OBEN_TODAY, scenario: 'mid', theme: 'alle', playing: false, timer: null };

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
  function svg(tag, attrs = {}, children = []) {
    const node = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) node.setAttribute(k, v);
    for (const c of children) node.append(c);
    return node;
  }

  /** Colour between two hex colours, t 0 … 1. */
  function mixColor(a, b, t) {
    const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
    const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
    const k = Math.max(0, Math.min(1, t));
    return `#${pa.map((v, i) => Math.round(v + (pb[i] - v) * k).toString(16).padStart(2, '0')).join('')}`;
  }
  // The same pseudo-random value for the same tree or field every time.
  const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

  const RIVER = 'M-10 360 C 120 340 220 385 340 362 C 460 340 560 382 680 360 C 800 340 900 378 1010 356';
  const STREAM = (end) => `M372 ${end} C 368 ${end + 60} 386 ${(end + 360) / 2} 364 ${360 - 4}`;
  const SUONEN = [
    'M372 190 C 520 180 640 200 760 186 C 840 178 900 190 960 184',
    'M372 230 C 500 222 620 240 740 226 C 830 218 900 232 960 226',
    'M372 270 C 480 262 600 280 720 268 C 820 258 900 272 960 268',
  ];
  const THEME_OF = { wasser: 'water', wald: 'forest', nahrung: 'food', temperatur: 'heat' };

  function draw(o) {
    const map = $('lo-map');
    const keep = map.querySelector('title');
    map.replaceChildren(...(keep ? [keep] : []));
    const dim = (group) => (state.theme !== 'alle' && THEME_OF[state.theme] !== group ? 'lo-dim' : null);
    const dry = o.drought;

    map.append(svg('defs', {}, [
      svg('radialGradient', { id: 'lo-heat', cx: '50%', cy: '50%', r: '60%' }, [
        svg('stop', { offset: '0', 'stop-color': '#ff5a36', 'stop-opacity': '0.9' }),
        svg('stop', { offset: '1', 'stop-color': '#ff9a3c', 'stop-opacity': '0' }),
      ]),
    ]));

    // Ground: the sunny slope (north), the valley floor, the shady slope (south).
    map.append(svg('rect', { x: 0, y: 0, width: 1000, height: 600, fill: mixColor('#9fae7a', '#c8b77d', dry) }));
    map.append(svg('path', { d: 'M0 0 H1000 V128 C 860 150 740 118 600 140 C 460 160 320 120 180 146 C 100 160 40 140 0 150 Z', fill: '#8c918b' }));
    map.append(svg('path', { d: 'M0 300 C 200 290 400 318 600 302 C 760 290 900 312 1000 298 V430 C 800 444 600 420 400 436 C 200 450 80 430 0 440 Z', fill: mixColor('#a9b680', '#cdbf86', dry) }));
    map.append(svg('path', { d: 'M0 440 C 80 430 200 450 400 436 C 600 420 800 444 1000 430 V600 H0 Z', fill: '#3f5e3c' }));

    // Water: glacier, its stream, the Suonen, the Rhone.
    const water = svg('g', { class: dim('water') });
    const tongue = (g) => {
      const end = 24 + g * 120; const w = 26 + g * 70;
      return { end, d: `M${372 - w} 0 H${372 + w} C ${372 + w * 0.7} ${end * 0.6} ${388} ${end} 372 ${end} C ${356} ${end} ${372 - w * 0.7} ${end * 0.6} ${372 - w} 0 Z` };
    };
    const { end, d: ice } = tongue(o.glacier);
    if (o.glacier > 0.02) water.append(svg('path', { d: ice, fill: '#eef4f8', stroke: '#c9d8e2', 'stroke-width': 1.5 }));
    water.append(svg('path', { d: tongue(0.95).d, fill: 'none', stroke: '#eef4f8', 'stroke-width': 2, 'stroke-dasharray': '6 6', opacity: 0.6 }));
    water.append(svg('path', { d: STREAM(end), fill: 'none', stroke: '#4f93c2', 'stroke-width': 2 + o.water * 3, class: 'lo-flow', style: `--lo-speed:${(2.6 - o.water * 1.4).toFixed(2)}s` }));
    SUONEN.forEach((d, k) => {
      const on = o.suonen > 0.15 + k * 0.25 ? 1 : Math.max(0.15, o.suonen);
      water.append(svg('path', { d, fill: 'none', stroke: '#5aa3d6', 'stroke-width': 2, 'stroke-dasharray': '4 7', opacity: on.toFixed(2), class: o.suonen > 0.15 + k * 0.25 ? 'lo-flow' : null, style: '--lo-speed:3s' }));
    });
    water.append(svg('path', { d: RIVER, fill: 'none', stroke: '#2f7fb4', 'stroke-width': (8 + o.water * 12).toFixed(1), 'stroke-linecap': 'round' }));
    water.append(svg('path', { d: RIVER, fill: 'none', stroke: '#9fd0ef', 'stroke-width': 2, 'stroke-dasharray': '10 18', class: 'lo-flow', style: `--lo-speed:${(3.2 - o.water * 1.6).toFixed(2)}s` }));

    // Food: vines on the sunny slope, fields and irrigation on the valley floor, the village.
    const food = svg('g', { class: dim('food') });
    const vine = mixColor('#5f8f36', '#c4a64e', dry * 0.9);
    for (let r = 0; r < 9; r++) {
      const y = 196 + r * 11;
      food.append(svg('path', { d: `M470 ${y} C 560 ${y - 6} 640 ${y + 6} 720 ${y - 2}`, fill: 'none', stroke: vine, 'stroke-width': 3, 'stroke-linecap': 'round' }));
    }
    let n = 0;
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 12; col++) {
        n += 1;
        const x = 30 + col * 80 + (row ? 20 : 0);
        const y = row ? 382 : 306;
        if (x > 560 && x < 680 && !row) continue; // the village
        const v = Math.max(0, Math.min(1, o.fields + (hash(n) - 0.5) * 0.35));
        food.append(svg('rect', { x, y, width: 64, height: 30, rx: 3, fill: mixColor('#c9a75a', '#5d9a44', v), stroke: '#00000022' }));
      }
    }
    const sprinklers = Math.round(o.irrigation * 10);
    for (let k = 0; k < sprinklers; k++) {
      const x = 62 + ((k * 197) % 900);
      const y = k % 2 ? 397 : 321;
      food.append(svg('circle', { cx: x, cy: y, r: 9, fill: 'none', stroke: '#bfe3ff', 'stroke-width': 2, class: 'lo-spray', style: `animation-delay:${(k * 0.3).toFixed(1)}s` }));
    }
    for (const [x, y, s] of [[590, 306, 12], [608, 314, 14], [628, 304, 11], [646, 316, 13], [612, 330, 10], [634, 332, 12]]) {
      food.append(svg('rect', { x, y, width: s, height: s, fill: '#efe7d6', stroke: '#8a6a4a', 'stroke-width': 1 }));
    }

    // Forest on the shady slope: pines below, giving way to oaks; spruce above.
    const forest = svg('g', { class: dim('forest') });
    let t = 0;
    for (let y = 450; y < 600; y += 15) {
      for (let x = 8 + ((y / 15) % 2) * 7; x < 1000; x += 15) {
        t += 1;
        const h = hash(t);
        const low = y < 530;
        let fill;
        if (!low) fill = h < o.dead * 0.25 ? '#8f8a7e' : '#244a31';
        else if (h < o.dead * (1 - o.oak) * 0.6) fill = '#9a948a';
        else if (h < o.oak) fill = '#9c9a45';
        else fill = '#6f9a4f';
        forest.append(svg('circle', { cx: x + (hash(t + 7) - 0.5) * 5, cy: y + (hash(t + 3) - 0.5) * 5, r: low ? 6 : 6.5, fill }));
      }
    }

    // Temperature: heat shimmering over the valley floor.
    const heat = svg('g', { class: dim('heat') });
    heat.append(svg('ellipse', { cx: 500, cy: 368, rx: 560, ry: 120, fill: 'url(#lo-heat)', opacity: (o.heat * 0.7).toFixed(2), class: reduceMotion ? null : 'lo-shimmer' }));

    const labels = svg('g', { class: 'lo-labels' });
    for (const [x, y, text] of [[470, 40, 'Gletscher (gestrichelt: 1900)'], [770, 178, 'Suonen'], [520, 190, 'Reben'], [100, 352, 'Rhone'], [610, 296, 'Dorf'], [110, 300, 'Äcker'], [100, 470, 'Föhren und Eichen'], [100, 548, 'Fichtenwald']]) {
      const lab = svg('text', { x, y }); lab.textContent = text; labels.append(lab);
    }

    map.append(food, forest, water, heat, labels);
    $('lo-map-title').textContent = `Das Rhonetal von oben, ${o.stop.label}`;
  }

  /* ---------- Side panel and controls ---------- */

  const STATUS = {
    wasser: (o) => (o.water > 0.9 ? 'Viel Wasser im Sommer' : o.water > 0.7 ? 'Weniger Wasser im Sommer' : 'Im Sommer knapp'),
    wald: (o) => (o.pine > 0.85 ? 'Föhrenwald' : o.pine > 0.5 ? 'Föhren sterben, Eichen wachsen nach' : 'Eichen statt Föhren'),
    nahrung: (o) => (o.irrigation > 0.8 ? 'Viel Bewässerung nötig' : o.irrigation > 0.5 ? 'Mehr Bewässerung nötig' : 'Regen und Suonen reichen meist'),
    temperatur: (o) => (Math.abs(o.warming) < 0.15 ? 'So warm wie heute' : `Rund ${o.warming > 0 ? '+' : '−'}${M.fmt(Math.abs(o.warming))} °C gegenüber heute`),
  };
  const SERIES = { wasser: 'water', wald: 'pine', nahrung: 'fields', temperatur: 'heat' };
  const COLORS = { wasser: '#5aa3d6', wald: '#9ccf8a', nahrung: '#e3c06a', temperatur: '#ff7b6b' };

  function spark(theme, o) {
    const pts = M.obenSeries(SERIES[theme], state.scenario);
    const X = (k) => 6 + (k / (pts.length - 1)) * 148;
    const Y = (v) => 34 - v * 28;
    const s = svg('svg', { viewBox: '0 0 160 40', class: 'lo-spark', 'aria-hidden': 'true' });
    s.append(svg('polyline', { points: pts.map((p, k) => `${X(k)},${Y(p.value)}`).join(' '), fill: 'none', stroke: COLORS[theme], 'stroke-width': 2 }));
    const key = SERIES[theme];
    s.append(svg('circle', { cx: X(o.pos / M.OBEN_STEPS), cy: Y(o[key]), r: 3.5, fill: '#eef0e6' }));
    return s;
  }

  function render() {
    const o = M.oben(state.pos, state.scenario);
    const sc = M.SCENARIOS[state.scenario];
    draw(o);
    $('lo-when').textContent = o.stop.label;
    $('lo-when-small').textContent = o.stop.label;
    $('lo-kind').textContent = o.future ? sc.long : o.stop.kind;
    $('lo-kind').style.color = o.future ? sc.color : '';
    if ($('lo-voice').dataset.stop !== `${o.stop.id}:${state.scenario}`) {
      $('lo-voice').dataset.stop = `${o.stop.id}:${state.scenario}`;
      $('lo-voice').textContent = `«${o.stop.voice}»`;
    }
    $('lo-thermo').replaceChildren(
      el('span', { class: 'lo-thermo-value', text: `${o.warming >= 0 ? '+' : '−'}${M.fmt(Math.abs(o.warming))} °C` }),
      el('span', { text: 'Schweiz gegenüber heute (Faustregel: doppelt so viel wie die Welt)' }),
    );
    $('lo-cards').replaceChildren(...Object.entries(M.THEMES).map(([id, t]) => {
      const open = state.theme === id || state.theme === 'alle';
      const facts = state.theme === id ? t.facts : t.facts.slice(0, 1);
      return el('article', { class: `lo-card${state.theme === id ? ' on' : ''}`, style: `--lo-color:${COLORS[id]}` }, [
        el('div', { class: 'lo-card-head' }, [el('h3', { text: t.label }), spark(id, o)]),
        el('p', { class: 'lo-status', text: STATUS[id](o) }),
        open ? el('ul', {}, facts.map(([text, src]) => el('li', {}, [text, ' ', el('a', { href: M.SOURCES[src].url, target: '_blank', rel: 'noopener', text: 'Quelle' })]))) : null,
      ]);
    }));
    $('lo-pos').value = String(state.pos);
    for (const b of $('lo-stops').children) b.setAttribute('aria-current', String(b.dataset.id === o.stop.id));
    for (const b of $('lo-themes').children) b.setAttribute('aria-pressed', String(b.dataset.id === state.theme));
    for (const b of $('lo-scenarios').children) {
      const on = b.dataset.id === state.scenario;
      b.setAttribute('aria-pressed', String(on));
      b.style.background = on ? M.SCENARIOS[b.dataset.id].color : '';
    }
    $('lo-play').classList.toggle('playing', state.playing);
    $('lo-play').setAttribute('aria-label', state.playing ? 'Zeitraffer anhalten' : 'Zeitraffer abspielen');
  }

  function stop() {
    clearInterval(state.timer);
    state.playing = false;
    render();
  }
  function play() {
    if (state.playing) return stop();
    if (state.pos >= M.OBEN_MAX) state.pos = 0;
    state.playing = true;
    state.timer = setInterval(() => {
      state.pos = Math.min(M.OBEN_MAX, state.pos + (reduceMotion ? 10 : 1));
      if (state.pos >= M.OBEN_MAX) stop(); else render();
    }, reduceMotion ? 250 : 60);
    render();
    return undefined;
  }

  M.obenStops(state.scenario).forEach((s, k) => $('lo-stops').append(el('button', {
    type: 'button', 'data-id': s.id, text: s.label,
    on: { click: () => { if (state.playing) stop(); state.pos = k * M.OBEN_STEPS; render(); } },
  })));
  for (const [id, label] of [['alle', 'Alles'], ...Object.entries(M.THEMES).map(([k, t]) => [k, t.label])]) {
    $('lo-themes').append(el('button', { type: 'button', 'data-id': id, text: label, on: { click: () => { state.theme = id; render(); } } }));
  }
  for (const [id, s] of Object.entries(M.SCENARIOS)) {
    $('lo-scenarios').append(el('button', {
      type: 'button', 'data-id': id, text: s.label, style: `border-color:${s.color}`,
      on: { click: () => { state.scenario = id; render(); } },
    }));
  }
  $('lo-pos').addEventListener('input', (e) => { if (state.playing) stop(); state.pos = Number(e.target.value); render(); });
  $('lo-play').addEventListener('click', play);

  window.LandschaftOben = { render, stop: () => { if (state.playing) stop(); } };
})();
