/**
 * Landschaft im Wandel: the model behind the time-lapse (landschaft.html). The valley tells its own story,
 * from the last ice age to 2100, in a section from the Jungfrau down to the Rhone at Naters. Seven stops
 * with what the sources say (ice, treeline, the forces at work, the valley's own words); between two stops
 * everything is blended. From today on, the human influence follows one of three emission pathways (IPCC
 * AR6). Plain script for the browser (window.LandschaftModel) and CommonJS for the tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LandschaftModel = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  /** Global warming over 1850–1900 in °C (IPCC AR6 SPM, Table SPM.1, best estimates; 2011–2020: 1.1). */
  const SCENARIOS = {
    low: { label: 'wenig', long: 'Mensch wirkt wenig weiter', ssp: 'SSP1-2.6', color: '#fcbba1', g2050: 1.7, g2100: 1.8 },
    mid: { label: 'mittel', long: 'Mensch wirkt mittel weiter', ssp: 'SSP2-4.5', color: '#fb6a4a', g2050: 2.0, g2100: 2.7 },
    high: { label: 'stark', long: 'Mensch wirkt stark weiter', ssp: 'SSP5-8.5', color: '#ef3b2c', g2050: 2.4, g2100: 4.4 },
  };
  const G_TODAY = 1.2; // the decade up to today
  const SWISS_FACTOR = 2; // Switzerland warms about twice as much as the world (MeteoSchweiz)
  const LAPSE = 0.55; // °C per 100 m in the yearly mean (docs/klimawandel.md)
  const TREELINE_TODAY = 2200; // m, around the Aletschwald

  /** How far the climate climbs the slope (m) for a global warming `g` against today. */
  const climbFor = (g) => Math.round(((SWISS_FACTOR * (g - G_TODAY)) / LAPSE) * 100 / 10) * 10;

  const FORCES = [
    { id: 'orbit', label: 'Erdbahn und Sonne', color: '#e8c46a' },
    { id: 'volcano', label: 'Vulkane', color: '#c9a3a3' },
    { id: 'rhythm', label: 'Eigenrhythmus des Klimas', color: '#9cc3d5' },
    { id: 'water', label: 'Eis und Wasser', color: '#e9f1f6' },
    { id: 'species', label: 'Pflanzen und Tiere wandern', color: '#9ccf8a' },
    { id: 'landuse', label: 'Mensch: Rodung und Weide', color: '#f2b48f' },
    { id: 'ghg', label: 'Mensch: Treibhausgase', color: '#ff7b6b' },
  ];

  const SOURCES = {
    lgm: { label: 'swisstopo: Die Schweiz während des letzteiszeitlichen Maximums (LGM) 1:500 000 (Schlüchter 2009)', url: 'https://opendata.swiss/de/dataset/die-schweiz-wahrend-des-letzteiszeitlichen-maximums-lgm-1-500000' },
    alps: { label: 'Ivy-Ochs et al. (2009): Latest Pleistocene and Holocene glacier variations in the European Alps. Quaternary Science Reviews 28', url: 'https://doi.org/10.1016/j.quascirev.2009.03.009' },
    holocene: { label: 'Joerin, Stocker, Schlüchter (2006): Multicentury glacier fluctuations in the Swiss Alps during the Holocene. The Holocene 16', url: 'https://doi.org/10.1191/0959683606hl964rp' },
    treeline: { label: 'Tinner, Theurillat (2003): Uppermost limit, extent, and fluctuations of the timberline and treeline ecocline in the Swiss Central Alps during the past 11,500 years. Arctic, Antarctic, and Alpine Research 35', url: 'https://doi.org/10.1657/1523-0430(2003)035[0158:ULEAFO]2.0.CO;2' },
    glamos: { label: 'GLAMOS – Glacier Monitoring Switzerland: Längenänderung Grosser Aletschgletscher', url: 'https://www.glamos.ch' },
    ipcc: { label: 'IPCC AR6 WGI (2021), Summary for Policymakers, Tabelle SPM.1', url: 'https://www.ipcc.ch/report/ar6/wg1/' },
    meteoswiss: { label: 'MeteoSchweiz: Klimawandel Schweiz', url: 'https://www.meteoschweiz.admin.ch/klima/klimawandel.html' },
    aletsch2100: { label: 'Jouvet, Huss (2019): Future retreat of Great Aletsch Glacier. Journal of Glaciology 65', url: 'https://folia.unifr.ch/unifr/documents/308133' },
    ch2025: { label: 'Klimaszenarien CH2025 (MeteoSchweiz, ETH Zürich, NCCS)', url: 'https://www.nccs.admin.ch/' },
  };

  /**
   * The stops. ice: 0 (no glacier) to 1 (the valley full, ice age), schematic; tree: treeline in m against
   * today; forces: 0 (hardly) to 3 (strong), an assessment; observed: what the stop rests on.
   */
  function stops(scenario = 'mid') {
    const s = SCENARIOS[scenario] || SCENARIOS.mid;
    const fut = {
      low: { ice50: 0.32, ice00: 0.24, ghg: [1, 1] },
      mid: { ice50: 0.26, ice00: 0.1, ghg: [2, 2] },
      high: { ice50: 0.2, ice00: 0.07, ghg: [3, 3] },
    }[scenario] || { ice50: 0.26, ice00: 0.1, ghg: [2, 2] };
    return [
      {
        id: 'lgm', label: 'vor 24 000 J.', short: '−24 000', when: 'vor 24 000 Jahren', kind: 'Rekonstruiert', ice: 1, tree: -1400, newcomers: 0, village: false,
        forces: [3, 1, 2, 3, 1, 0, 0],
        voice: 'Ich liege unter Eis, Hunderte Meter dick. Es reicht bis weit ins Mittelland. Kein Baum, nur Fels, Kälte und das Knirschen des Gletschers.',
        facts: ['Letzteiszeitliches Maximum: Die Gletscher der Alpen bedecken fast das ganze Mittelland.', 'Wald gibt es erst weit im Süden und Osten.'],
        sources: ['lgm'],
      },
      {
        id: 'dryas', label: 'vor 12 000 J.', short: '−12 000', when: 'vor 12 000 Jahren', kind: 'Rekonstruiert', ice: 0.72, tree: -500, newcomers: 0, village: false,
        forces: [3, 1, 3, 3, 3, 0, 0],
        voice: 'Das grosse Eis ist fort, doch es wird noch einmal kalt. Meine Gletscher stossen vor, unten im Tal wachsen die ersten Föhren und Birken.',
        facts: ['Jüngere Dryas: ein letzter Kälterückfall, die Gletscher stossen nochmals vor (Egesen-Stadium).', 'Föhren und Birken wandern in die Täler ein.'],
        sources: ['alps'],
      },
      {
        id: 'holocene', label: 'vor 7000 J.', short: '−7000', when: 'vor 7000 Jahren', kind: 'Rekonstruiert', ice: 0.38, tree: 150, newcomers: 0, village: false,
        forces: [2, 1, 2, 2, 2, 1, 0],
        voice: 'Ich bin warm, der Wald steht höher als heute, meine Gletscher sind klein. Die ersten Bauern roden und lassen ihr Vieh weiden.',
        facts: ['Wärmste Zeit seit der Eiszeit: Die Gletscher sind zeitweise kleiner als heute.', 'Die Waldgrenze liegt rund 120 bis 180 m höher als heute.'],
        sources: ['holocene', 'treeline'],
      },
      {
        id: '1850', label: '1850', when: '1850', kind: 'Beobachtet', ice: 0.85, tree: -120, newcomers: 0, village: true,
        forces: [1, 2, 2, 2, 1, 3, 1],
        voice: 'Meine Gletscher sind so gross wie seit Jahrtausenden nicht. Die Menschen haben viel Wald geschlagen, ihre Kohle beginnt die Luft zu verändern.',
        facts: ['Ende der Kleinen Eiszeit: Der Grosse Aletschgletscher ist nahe seinem Höchststand.', 'Die Waldgrenze liegt tief, auch weil Wald für Weide und Holz gerodet wurde.'],
        sources: ['glamos', 'treeline'],
      },
      {
        id: 'today', label: 'heute', when: 'heute', kind: 'Beobachtet', ice: 0.45, tree: 0, newcomers: 0.6, village: true,
        forces: [1, 1, 2, 2, 2, 2, 3],
        voice: 'Ich werde wärmer, schneller als seit mindestens 2000 Jahren. Das Eis schwindet, der Wald steigt, neue Arten kommen durchs Tal.',
        facts: ['Die Welt ist rund 1,1 °C wärmer als 1850–1900, die Schweiz etwa doppelt so viel.', 'Der Grosse Aletschgletscher ist seit 1870 über 3 km kürzer geworden.'],
        sources: ['ipcc', 'meteoswiss', 'glamos'],
      },
      {
        id: '2050', label: '2050', when: '2050', kind: s.long, ice: fut.ice50, tree: climbFor(s.g2050), newcomers: 0.8, village: true,
        forces: [1, 1, 2, 3, 3, 2, fut.ghg[0]], global: s.g2050,
        voice: {
          low: 'Die Wärme steigt kaum noch. Mein Eis ist kleiner geworden, aber es bleibt. Der Wald hat Zeit nachzuziehen.',
          mid: 'Ich bin deutlich wärmer. Die Gletscherzunge liegt weit oben, Fels und Seen liegen frei, wo vorher Eis war.',
          high: 'Es geht schnell. Die Fichten unten leiden, der Borkenkäfer hat leichtes Spiel, mein Eis zerfällt.',
        }[scenario],
        facts: [`Welt 2041–2060: +${fmt(s.g2050)} °C (${s.ssp}).`, `Das Klima steigt rund ${climbFor(s.g2050)} m den Hang hinauf.`],
        sources: ['ipcc', 'ch2025'],
      },
      {
        id: '2100', label: '2100', when: '2100', kind: s.long, ice: fut.ice00, tree: climbFor(s.g2100), newcomers: 1, village: true,
        forces: [1, 1, 2, 3, 3, 2, fut.ghg[1]], global: s.g2100,
        voice: {
          low: 'Ich habe mich verändert und werde wieder ruhiger. Mehr als die Hälfte meines Eises ist fort, ein Teil bleibt oben im Firn.',
          mid: 'Mein Eis ist zum grössten Teil verschwunden. Wo Gletscher war, wachsen Pionierpflanzen.',
          high: 'Vom Gletscher bleiben nur Reste. Mein Klima steigt schneller den Hang hinauf, als der Wald wandern kann.',
        }[scenario],
        facts: [`Welt 2081–2100: +${fmt(s.g2100)} °C (${s.ssp}).`, `Das Klima steigt rund ${climbFor(s.g2100)} m den Hang hinauf.`, {
          low: 'Der Grosse Aletschgletscher verliert bis 2100 rund 60 % seines heutigen Eises.',
          mid: 'Der Grosse Aletschgletscher verliert bis 2100 den grössten Teil seines Eises.',
          high: 'Vom Grossen Aletschgletscher bleibt bis 2100 fast nichts.',
        }[scenario]],
        sources: ['ipcc', 'aletsch2100', 'ch2025'],
      },
    ];
  }

  function fmt(v) { return v.toFixed(1).replace('.', ','); }

  /** Slider positions: 100 steps between two stops. */
  const STEPS = 100;
  const MAX_POS = STEPS * 6;
  const TODAY_POS = STEPS * 4;

  /** Everything at slider position `pos` (0 … 600) on the pathway `scenario`. */
  function at(pos, scenario = 'mid') {
    const list = stops(scenario);
    const p = Math.max(0, Math.min(MAX_POS, Number(pos) || 0));
    const i = Math.min(list.length - 2, Math.floor(p / STEPS));
    const t = (p - i * STEPS) / STEPS;
    const a = list[i]; const b = list[i + 1];
    const mix = (x, y) => x + (y - x) * t;
    const near = t < 0.5 ? a : b;
    const tree = mix(a.tree, b.tree);
    // The forest itself follows the climate more slowly: from today on at most 2 m per year (an assumption).
    const yearsAhead = p <= TODAY_POS ? 0 : ((p - TODAY_POS) / (MAX_POS - TODAY_POS)) * 75;
    const forest = p <= TODAY_POS ? tree : Math.min(tree, 2 * yearsAhead);
    return {
      pos: p, stop: near, scenario,
      ice: mix(a.ice, b.ice),
      tree, forest,
      treeline: TREELINE_TODAY + tree,
      forestline: TREELINE_TODAY + forest,
      newcomers: mix(a.newcomers, b.newcomers),
      village: near.village,
      future: p > TODAY_POS,
      forces: FORCES.map((f, k) => ({ ...f, level: Math.round(mix(a.forces[k], b.forces[k])) })),
    };
  }

  /* ---------- The section: Jungfrau (left) to the Rhone at Naters (right) ---------- */

  const W = 1000; const H = 560;
  const TERRAIN = [[0, 3950], [60, 4158], [110, 3800], [160, 3450], [230, 3050], [300, 2750], [380, 2620], [460, 2450],
    [540, 2250], [620, 2050], [700, 1800], [780, 1500], [860, 1180], [920, 900], [970, 700], [1000, 680]];
  const PLACES = [
    { label: 'Jungfrau · 4158 m', x: 60 },
    { label: 'Konkordiaplatz', x: 300 },
    { label: 'Naters · Rhone', x: 975 },
  ];
  const elevation = (x) => {
    for (let k = 1; k < TERRAIN.length; k++) {
      if (x <= TERRAIN[k][0]) {
        const [x0, h0] = TERRAIN[k - 1]; const [x1, h1] = TERRAIN[k];
        return h0 + ((h1 - h0) * (x - x0)) / (x1 - x0);
      }
    }
    return TERRAIN[TERRAIN.length - 1][1];
  };
  const y = (h) => H - 20 - ((h - 500) * (H - 40)) / 3800;
  const interp = (table, v) => {
    for (let k = 1; k < table.length; k++) {
      if (v <= table[k][0]) { const [a0, b0] = table[k - 1]; const [a1, b1] = table[k]; return b0 + ((b1 - b0) * (v - a0)) / (a1 - a0); }
    }
    return table[table.length - 1][1];
  };
  // Elevation of the tongue for an ice share (schematic); 1 fills the valley beyond the section.
  const TONGUE = [[0, 4300], [0.08, 2900], [0.2, 2500], [0.26, 2300], [0.32, 2100], [0.38, 1850], [0.45, 1650], [0.72, 1400], [0.85, 1300], [0.95, 800], [1, 400]];

  /** The glacier as surface and bed points (x, y), or null when it is gone. */
  function glacier(ice) {
    if (ice < 0.02) return null;
    const he = interp(TONGUE, ice);
    let xe = W;
    for (let x = 120; x <= W; x += 10) if (elevation(x) <= he) { xe = x; break; }
    if (he < TERRAIN[TERRAIN.length - 1][1]) xe = W + (TERRAIN[TERRAIN.length - 1][1] - he) * 1.2;
    const thick = 120 + ice * 350 + Math.max(0, ice - 0.9) * 18000;
    const cap = ice > 0.9 ? 3000 : Infinity; // ice-age surface; the peaks stick out
    const surface = []; const bed = [];
    for (let x = 110; x <= Math.min(xe, W); x += 10) {
      const u = (x - 110) / (xe - 110 || 1);
      const ground = elevation(x);
      const top = Math.max(ground, Math.min(ground + thick * Math.pow(Math.sin(Math.PI * Math.min(1, u * 0.5 + 0.5 * u * u)), 0.6), Math.max(ground, cap)));
      surface.push([x, y(top)]); bed.push([x, y(ground)]);
    }
    return { surface, bed, from: 110, to: Math.min(xe, W) };
  }

  const BELT = { rock: '#cfd6d2', alpine: '#9fae7a', conifer: '#2f5b3c', mixed: '#6f9a4f' };

  /** Everything to draw the section for a state from at(). */
  function section(state) {
    const ice = glacier(state.ice);
    const covered = (x) => Boolean(ice && x >= ice.from && x <= ice.to);
    const xs = []; for (let x = 0; x <= W; x += 10) xs.push(x);
    const snow = state.treeline + 800;
    const belts = [];
    for (let k = 0; k < xs.length - 1; k++) {
      if (covered(xs[k])) continue;
      const h = elevation(xs[k]);
      // Steep rock and firn above 3600 m stay bare even in a warm climate.
      const kind = h > snow || h > 3600 ? 'rock' : h > state.forestline ? 'alpine' : h > state.forestline - 600 ? 'conifer' : 'mixed';
      belts.push({ x1: xs[k], y1: y(h), x2: xs[k + 1], y2: y(elevation(xs[k + 1])), color: BELT[kind] });
    }
    const trees = [];
    for (let x = 14; x < W; x += 16) {
      const h = elevation(x);
      if (h > state.forestline || h < 600 || covered(x)) continue;
      const s = h > state.forestline - 150 ? 6 : 11;
      trees.push({ x, y: y(h) - 4, size: s, color: h > state.forestline - 600 ? '#244a31' : '#5c8a44' });
    }
    const newcomers = [920, 945, 965, 985].map((x, k) => ({ x, y: y(elevation(x)) - 12 - (k % 2) * 8, r: Math.max(0, state.newcomers * 9 - k * 1.5) }));
    return {
      width: W, height: H,
      terrain: [[0, H], ...xs.map((x) => [x, y(elevation(x))]), [W, H]],
      glacier: ice ? [...ice.surface, ...ice.bed.reverse()] : null,
      lia: glacier(0.85).surface,
      belts, trees, newcomers,
      treelineY: y(state.treeline),
      grid: [1000, 2000, 3000].map((h) => ({ h, y: y(h) })),
      places: PLACES.map((p) => ({ ...p, y: y(elevation(p.x)) })),
      village: state.village ? { x: 975, y: y(elevation(975)) } : null,
    };
  }

  return {
    SCENARIOS, FORCES, SOURCES, STEPS, MAX_POS, TODAY_POS, TREELINE_TODAY, BELT,
    stops, at, section, climbFor, elevation, fmt,
  };
}));
