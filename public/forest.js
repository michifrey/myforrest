'use strict';

/*
 * Procedural scenery for the hero and footer: layered silhouettes with
 * atmospheric depth, drifting mist, stars and fireflies, plus a gentle
 * parallax. The hero changes between four landscapes (forest, glacier,
 * mountains, desert), each with its own scene, colours and headline; the
 * buttons below the headline pick one. Purely decorative scenery is aria-hidden.
 */
(function forest() {
  const SVG = 'http://www.w3.org/2000/svg';
  const W = 1600;

  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), a | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const f = (n) => n.toFixed(1);

  /** A spruce: tiered, slightly irregular branches and a short trunk. */
  function spruce(cx, base, h, w, rnd) {
    const tiers = 5 + Math.floor(rnd() * 3);
    const top = base - h;
    const left = [];
    const right = [];
    for (let i = 1; i <= tiers; i++) {
      const t = i / tiers;
      const y = top + h * 0.92 * t;
      const reach = (w / 2) * t * (0.85 + rnd() * 0.3);
      const inner = reach * (0.45 + rnd() * 0.15);
      const sag = h * 0.035;
      left.push([cx - reach, y + sag], [cx - inner, y - sag * 0.4]);
      right.push([cx + reach, y + sag * (0.8 + rnd() * 0.4)], [cx + inner, y - sag * 0.4]);
    }
    const trunk = Math.max(1.5, w * 0.05);
    let d = `M${f(cx)} ${f(top)}`;
    for (const [x, y] of left) d += `L${f(x)} ${f(y)}`;
    d += `L${f(cx - trunk)} ${f(base - h * 0.06)}L${f(cx - trunk)} ${f(base + 8)}L${f(cx + trunk)} ${f(base + 8)}L${f(cx + trunk)} ${f(base - h * 0.06)}`;
    for (const [x, y] of right.reverse()) d += `L${f(x)} ${f(y)}`;
    return `${d}Z`;
  }

  /** A broadleaf tree: lumpy round crown on a trunk. */
  function broadleaf(cx, base, h, w, rnd) {
    const r = w / 2;
    const cy = base - h + r;
    let d = `M${f(cx - w * 0.04)} ${f(base + 8)}L${f(cx - w * 0.04)} ${f(cy + r * 0.6)}L${f(cx + w * 0.04)} ${f(cy + r * 0.6)}L${f(cx + w * 0.04)} ${f(base + 8)}Z`;
    const lobes = 5 + Math.floor(rnd() * 3);
    for (let i = 0; i < lobes; i++) {
      const a = (i / lobes) * Math.PI * 2;
      const lr = r * (0.45 + rnd() * 0.2);
      const x = cx + Math.cos(a) * r * 0.5;
      const y = cy + Math.sin(a) * r * 0.45;
      d += `M${f(x - lr)} ${f(y)}a${f(lr)} ${f(lr)} 0 1 0 ${f(lr * 2)} 0a${f(lr)} ${f(lr)} 0 1 0 ${f(-lr * 2)} 0Z`;
    }
    d += `M${f(cx - r * 0.7)} ${f(cy)}a${f(r * 0.7)} ${f(r * 0.7)} 0 1 0 ${f(r * 1.4)} 0a${f(r * 0.7)} ${f(r * 0.7)} 0 1 0 ${f(-r * 1.4)} 0Z`;
    return d;
  }

  /** Shapes of a forest layer: rolling ground plus a row of trees. */
  function forestShapes({ seed, height, ground, amp, treeH, treeW, gap, broadleafShare = 0 }) {
    const rnd = rng(seed);
    const groundAt = (x) => ground + Math.sin(x / 260 + seed) * amp + Math.sin(x / 97 + seed * 2) * amp * 0.35;
    let hill = `M0 ${height}`;
    for (let x = 0; x <= W; x += 20) hill += `L${x} ${f(groundAt(x))}`;
    hill += `L${W} ${height}Z`;
    const shapes = [hill];
    for (let x = -treeW; x < W + treeW; x += gap * (0.55 + rnd() * 0.9)) {
      const h = treeH * (0.6 + rnd() * 0.6);
      const w = treeW * (0.75 + rnd() * 0.5);
      const base = groundAt(Math.max(0, Math.min(W, x))) + 4;
      shapes.push(rnd() < broadleafShare ? broadleaf(x, base, h * 0.8, w * 1.5, rnd) : spruce(x, base, h, w, rnd));
    }
    return shapes;
  }

  /** A jagged ridge by midpoint displacement: [[x, y]…] every ~10 px. */
  function ridgeLine(rnd, { base, height, step = 160, jag = 0.6, bumps = [] }) {
    let pts = [];
    for (let x = -step; x <= W + step; x += step) pts.push([x, base - height * (0.35 + 0.65 * rnd())]);
    let amp = height * jag * 0.5;
    for (let d = step; d > 10; d /= 2) {
      const next = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const [x0, y0] = pts[i];
        const [x1, y1] = pts[i + 1];
        next.push(pts[i], [(x0 + x1) / 2, (y0 + y1) / 2 + (rnd() - 0.5) * amp]);
      }
      next.push(pts[pts.length - 1]);
      pts = next;
      amp *= 0.55;
    }
    // Bumps lift (negative) or lower (positive) the ridge around a place: a peak, a notch for a valley.
    return pts.map(([x, y]) => [x, bumps.reduce((v, b) => v + b.dy * Math.exp(-(((x - b.x) / b.w) ** 2)), y)]);
  }

  const area = (pts, bottom) => `M${f(pts[0][0])} ${bottom}${pts.map(([x, y]) => `L${f(x)} ${f(y)}`).join('')}L${f(pts[pts.length - 1][0])} ${bottom}Z`;

  /** Snow on a ridge: from the crest down, thicker the higher the peak, nothing below the snow line. */
  function snowCap(rnd, pts, snowLine, depth) {
    const lower = pts.map(([x, y]) => [x, y < snowLine ? Math.min(snowLine + 6, y + (snowLine - y) * depth * (0.6 + rnd() * 0.8)) : y]);
    return `M${f(pts[0][0])} ${f(pts[0][1])}${pts.map(([x, y]) => `L${f(x)} ${f(y)}`).join('')}${lower.reverse().map(([x, y]) => `L${f(x)} ${f(y)}`).join('')}Z`;
  }

  /** Dunes: long windward slopes and short steep lee faces, with the crest line lighter. */
  function duneLine(rnd, { base, height, period, phase = 0 }) {
    const pts = [];
    const shape = (u) => (u < 0.72 ? Math.sin((u / 0.72) * (Math.PI / 2)) : (1 - (u - 0.72) / 0.28) ** 1.6);
    const heights = Array.from({ length: Math.ceil(W / period) + 3 }, () => 0.55 + rnd() * 0.45);
    for (let x = -20; x <= W + 20; x += 8) {
      const t = (x + phase) / period + 1;
      const k = Math.floor(t);
      pts.push([x, base - height * heights[k] * shape(t - k) - Math.sin(x / 310 + phase) * height * 0.15]);
    }
    return pts;
  }

  /** A flat-topped mesa between x0 and x1. */
  function mesa(x0, x1, top, base, rnd) {
    const shoulder = (x1 - x0) * 0.12;
    return `M${f(x0)} ${base}L${f(x0 + shoulder * 0.6)} ${f(top + (base - top) * 0.35)}L${f(x0 + shoulder)} ${f(top + 4)}`
      + `L${f(x0 + shoulder * 1.3)} ${f(top)}L${f(x1 - shoulder * (1.2 + rnd() * 0.3))} ${f(top + rnd() * 6)}`
      + `L${f(x1 - shoulder * 0.7)} ${f(top + (base - top) * 0.3)}L${f(x1)} ${base}Z`;
  }

  /**
   * A glacier tongue flowing from the range behind (`ridge`, its upper edge follows the crest a little
   * below) down to its end at (cx, end): wide in the basin, narrowing quickly, bending as it flows.
   */
  function glacier(cx, top, end, topW, endW, ridge) {
    const ridgeY = (x) => {
      const i = ridge.findIndex(([px]) => px >= x);
      return i <= 0 ? ridge[0][1] : ridge[i - 1][1] + ((x - ridge[i - 1][0]) / (ridge[i][0] - ridge[i - 1][0])) * (ridge[i][1] - ridge[i - 1][1]);
    };
    const edge = (side) => {
      const out = [];
      const x0 = cx + (side * topW) / 2;
      const y0 = ridgeY(x0) + 25;
      for (let i = 0; i <= 14; i++) {
        const t = i / 14;
        const w = topW + (endW - topW) * Math.sqrt(t);
        out.push([cx + Math.sin(t * Math.PI) * 45 + (side * w) / 2, y0 + (end - y0) * t]);
      }
      return out;
    };
    const l = edge(-1);
    const r = edge(1);
    const crest = ridge.filter(([x]) => x > l[0][0] && x < r[0][0]).reverse().map(([x, y]) => `L${f(x)} ${f(y + 25)}`).join('');
    const tip = `Q${f(cx)} ${f(end + endW * 0.45)} ${f(r[14][0])} ${f(r[14][1])}`;
    return `M${l.map(([x, y]) => `${f(x)} ${f(y)}`).join('L')}${tip}${[...r].reverse().map(([x, y]) => `L${f(x)} ${f(y)}`).join('')}${crest}Z`;
  }

  /** Crevasses across the tongue, as short arcs. */
  function crevasses(rnd, cx, top, end, topW, endW) {
    let d = '';
    for (let i = 0; i < 16; i++) {
      const t = 0.12 + rnd() * 0.8;
      const y = top + (end - top) * t;
      const w = (topW + (endW - topW) * Math.sqrt(t)) * (0.2 + rnd() * 0.3);
      const x = cx + Math.sin(t * Math.PI) * 45 + (rnd() - 0.5) * w;
      d += `M${f(x - w / 2)} ${f(y)}Q${f(x)} ${f(y + 5)} ${f(x + w / 2)} ${f(y)}`;
    }
    return d;
  }

  /** Low shrubs with flat crowns (drylands). */
  function shrub(cx, base, w, h, rnd) {
    return broadleaf(cx, base, h, w, rnd);
  }

  /*
   * The layers of each scene, far to near: shapes are [d, class] (class:
   * '' = the layer colour, 'snow', 'ice', 'crevasse', 'crest', 'rock').
   */
  const SCENES = {
    wald: () => [
      { seed: 11, ground: 330, amp: 26, treeH: 70, treeW: 26, gap: 15, depth: 0.08 },
      { seed: 23, ground: 380, amp: 22, treeH: 100, treeW: 34, gap: 22, depth: 0.16, broadleafShare: 0.1 },
      { seed: 37, ground: 430, amp: 18, treeH: 140, treeW: 46, gap: 32, depth: 0.26, broadleafShare: 0.2 },
      { seed: 51, ground: 500, amp: 14, treeH: 170, treeW: 58, gap: 52, depth: 0.38, broadleafShare: 0.15 },
      { seed: 67, ground: 570, amp: 8, treeH: 260, treeW: 90, gap: 120, depth: 0.52 },
    ].map((cfg) => ({ depth: cfg.depth, shapes: forestShapes({ ...cfg, height: 600 }).map((d) => [d, '']) })),

    gletscher: () => {
      const rnd = rng(301);
      const far = ridgeLine(rnd, { base: 300, height: 190, jag: 0.7, bumps: [{ x: 1180, dy: -50, w: 160 }] });
      // The valley the glacier flows down: a notch in the middle range.
      const mid = ridgeLine(rnd, { base: 400, height: 170, jag: 0.6, bumps: [{ x: 1140, dy: 130, w: 95 }, { x: 860, dy: -40, w: 120 }] });
      const near = ridgeLine(rnd, { base: 500, height: 90, step: 200, jag: 0.5, bumps: [{ x: 1110, dy: 70, w: 210 }] });
      const front = ridgeLine(rnd, { base: 575, height: 45, step: 200, jag: 0.4 });
      const tongue = [1120, 280, 470, 230, 60];
      return [
        { depth: 0.06, shapes: [[area(far, 600), ''], [snowCap(rnd, far, 250, 0.9), 'snow']] },
        { depth: 0.1, shapes: [[glacier(...tongue, far), 'ice'], [crevasses(rnd, ...tongue), 'crevasse']] },
        { depth: 0.16, shapes: [[area(mid, 600), ''], [snowCap(rnd, mid, 290, 0.6), 'snow']] },
        { depth: 0.3, shapes: [[area(near, 600), '']] },
        { depth: 0.5, shapes: [[area(front, 600), ''], ...[1400, 1530].map((x) => [spruce(x, 568, 120 + rnd() * 60, 44, rnd), ''])] },
      ];
    },

    gebirge: () => {
      const rnd = rng(415);
      const far = ridgeLine(rnd, { base: 320, height: 170, jag: 0.7 });
      // A big rock peak on the right, like the Matterhorn above its valley.
      const peak = ridgeLine(rnd, { base: 430, height: 120, jag: 0.7, bumps: [{ x: 1150, dy: -250, w: 120 }, { x: 1290, dy: -90, w: 90 }] });
      const slope = ridgeLine(rnd, { base: 470, height: 70, step: 240, jag: 0.35 });
      const pasture = ridgeLine(rnd, { base: 530, height: 50, step: 320, jag: 0.25 });
      const front = ridgeLine(rnd, { base: 585, height: 35, step: 200, jag: 0.5 });
      const trees = (pts, n, h, w, from = 0) => Array.from({ length: n }, () => {
        const i = Math.floor(from + rnd() * (pts.length - from));
        return [spruce(pts[i][0], pts[i][1] + 4, h * (0.6 + rnd() * 0.6), w, rnd), ''];
      });
      return [
        { depth: 0.05, shapes: [[area(far, 600), ''], [snowCap(rnd, far, 270, 0.9), 'snow']] },
        { depth: 0.12, shapes: [[area(peak, 600), ''], [snowCap(rnd, peak, 250, 0.5), 'snow']] },
        { depth: 0.22, shapes: [[area(slope, 600), ''], ...trees(slope, 9, 45, 16)] },
        { depth: 0.34, shapes: [[area(pasture, 600), ''], ...trees(pasture, 6, 90, 30)] },
        { depth: 0.5, shapes: [[area(front, 600), ''], ...[60, 300, 1420].map((x) => [spruce(x, 585, 200 + rnd() * 60, 70, rnd), ''])] },
      ];
    },

    wueste: () => {
      const rnd = rng(523);
      const mesas = [[760, 1020, 250], [1080, 1180, 285], [1260, 1560, 240]].map(([a, b, top]) => [mesa(a, b, top, 600, rnd), '']);
      const d1 = duneLine(rnd, { base: 400, height: 70, period: 420, phase: 40 });
      const d2 = duneLine(rnd, { base: 455, height: 80, period: 520, phase: 170 });
      const d3 = duneLine(rnd, { base: 520, height: 70, period: 640, phase: 330 });
      const d4 = duneLine(rnd, { base: 585, height: 50, period: 760, phase: 90 });
      const crest = (pts) => [snowCap(rnd, pts, Math.min(...pts.map((p) => p[1])) + 40, 0.12), 'crest'];
      return [
        { depth: 0.04, shapes: mesas },
        { depth: 0.12, shapes: [[area(d1, 600), ''], crest(d1)] },
        { depth: 0.22, shapes: [[area(d2, 600), ''], crest(d2)] },
        { depth: 0.34, shapes: [[area(d3, 600), ''], crest(d3)] },
        { depth: 0.5, shapes: [[area(d4, 600), ''], ...[180, 360, 1300].map((x) => [shrub(x, 578, 110 + rnd() * 40, 60, rnd), ''])] },
      ];
    },
  };

  function layerSvg(shapes) {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} 600`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMax slice');
    // Each shape is its own <path>: overlapping outlines with opposite
    // winding would otherwise cancel out and leave holes.
    for (const [d, cls] of shapes) {
      const path = document.createElementNS(SVG, 'path');
      path.setAttribute('d', d);
      if (cls) path.setAttribute('class', cls);
      svg.append(path);
    }
    return svg;
  }

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const forestEl = document.getElementById('forest');
  const layers = [];
  const sceneEls = {};
  /** Draws a scene once, the first time it is shown. */
  function buildScene(name) {
    if (sceneEls[name] || !forestEl) return sceneEls[name];
    const scene = document.createElement('div');
    scene.className = 'scene';
    scene.dataset.scene = name;
    SCENES[name]().forEach((cfg, i) => {
      const wrap = document.createElement('div');
      wrap.className = `tree-layer l${i + 1}`;
      wrap.dataset.depth = String(cfg.depth);
      wrap.append(layerSvg(cfg.shapes));
      scene.append(wrap);
      layers.push(wrap);
      if (i === 1 || i === 3) {
        const mist = document.createElement('div');
        mist.className = `mist mist-${i}`;
        mist.dataset.depth = String(cfg.depth);
        scene.append(mist);
        layers.push(mist);
      }
    });
    forestEl.append(scene);
    sceneEls[name] = scene;
    return scene;
  }

  const stars = document.getElementById('stars');
  if (stars) {
    const rnd = rng(7);
    stars.setAttribute('viewBox', '0 0 1600 600');
    stars.setAttribute('preserveAspectRatio', 'xMidYMin slice');
    for (let i = 0; i < 140; i++) {
      const c = document.createElementNS(SVG, 'circle');
      c.setAttribute('cx', f(rnd() * 1600));
      c.setAttribute('cy', f(rnd() * rnd() * 420));
      c.setAttribute('r', f(0.4 + rnd() * 1.3));
      c.style.animationDelay = `${f(rnd() * 6)}s`;
      stars.append(c);
    }
  }

  const flies = document.getElementById('fireflies');
  if (flies) {
    const rnd = rng(3);
    for (let i = 0; i < 22; i++) {
      const s = document.createElement('i');
      s.style.left = `${f(rnd() * 100)}%`;
      s.style.top = `${f(45 + rnd() * 50)}%`;
      s.style.animationDelay = `${f(rnd() * -12)}s, ${f(rnd() * -4)}s`;
      s.style.animationDuration = `${f(9 + rnd() * 9)}s, ${f(2.5 + rnd() * 3)}s`;
      flies.append(s);
    }
  }

  const footer = document.getElementById('footer-trees');
  if (footer) {
    footer.setAttribute('viewBox', `0 0 ${W} 160`);
    footer.setAttribute('preserveAspectRatio', 'xMidYMax slice');
    for (const d of forestShapes({ seed: 91, height: 160, ground: 120, amp: 6, treeH: 90, treeW: 30, gap: 30, broadleafShare: 0.2 })) {
      const path = document.createElementNS(SVG, 'path');
      path.setAttribute('d', d);
      footer.append(path);
    }
  }

  /* ---------- Changing landscapes ---------- */

  const hero = document.getElementById('top');
  const ORDER = ['wald', 'gletscher', 'gebirge', 'wueste'];
  const TEXT = {
    wald: {
      eyebrow: 'Citizen Science · Waldmonitoring',
      line: 'Der Wald <em>erinnert</em> sich.',
      lede: 'Fotos von deinen Läufen, Wanderungen und Touren zeigen, wie sich der Wald verändert: Sturmschäden, Borkenkäfer, Neophyten. Jahr für Jahr, am selben Ort.',
    },
    gletscher: {
      eyebrow: 'Citizen Science · Gletscher',
      line: 'Der Gletscher <em>erinnert</em> sich.',
      lede: 'Neue Fotos und alte Postkarten vom selben Standort zeigen, wie weit das Eis reichte und wann es einen Ort freigab. Jahr für Jahr, am selben Ort.',
    },
    gebirge: {
      eyebrow: 'Citizen Science · Gebirge',
      line: 'Die Berge <em>erinnern</em> sich.',
      lede: 'Felsstürze, Murgänge, Lawinenzüge und Alpweiden, die verbuschen: Fotos von deinen Touren zeigen, wie sich die Berge verändern. Jahr für Jahr, am selben Ort.',
    },
    wueste: {
      eyebrow: 'Citizen Science · Trockengebiete',
      line: 'Die Wüste <em>erinnert</em> sich.',
      lede: 'Wandernde Dünen, Erosion und schwindende Vegetation: Fotos vom selben Ort zeigen, wie sich Trockengebiete verändern. Jahr für Jahr, am selben Ort.',
    },
  };
  const ROTATE_MS = 8000;
  let current = null;
  let rotation = null;
  let picked = false; // a click on a landscape stops the rotation

  function show(name) {
    if (!hero || name === current || !SCENES[name]) return;
    const first = current === null;
    current = name;
    buildScene(name);
    // Draw the next scene ahead, so it is ready when it fades in.
    const next = ORDER[(ORDER.indexOf(name) + 1) % ORDER.length];
    setTimeout(() => buildScene(next), 400);
    hero.dataset.scene = name;
    for (const [n, el] of Object.entries(sceneEls)) el.classList.toggle('active', n === name);
    const t = TEXT[name];
    const swap = () => {
      document.getElementById('hero-eyebrow').textContent = t.eyebrow;
      document.getElementById('hero-line').innerHTML = t.line;
      document.getElementById('hero-lede').textContent = t.lede;
      hero.classList.remove('swapping');
    };
    if (reduceMotion || first) swap();
    else {
      hero.classList.add('swapping');
      setTimeout(swap, 450);
    }
    for (const b of document.querySelectorAll('.scene-pick button')) b.setAttribute('aria-pressed', String(b.dataset.scene === name));
  }

  const visible = { hero: true };
  function schedule() {
    clearInterval(rotation);
    rotation = null;
    if (reduceMotion || picked || document.hidden || !visible.hero) return;
    rotation = setInterval(() => show(ORDER[(ORDER.indexOf(current) + 1) % ORDER.length]), ROTATE_MS);
  }

  if (hero && forestEl) {
    const pick = document.getElementById('scene-pick');
    for (const name of ORDER) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.scene = name;
      b.textContent = { wald: 'Wald', gletscher: 'Gletscher', gebirge: 'Gebirge', wueste: 'Wüste' }[name];
      b.addEventListener('click', () => { picked = true; show(name); schedule(); });
      pick?.append(b);
    }
    show('wald');
    document.addEventListener('visibilitychange', schedule);
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(([e]) => { visible.hero = e.isIntersecting; schedule(); }, { threshold: 0.3 }).observe(hero);
    }
    schedule();
  }
  window.Landscapes = { show, stop: () => { picked = true; schedule(); } };

  // Parallax: deeper layers move faster as the hero scrolls away.
  if (!reduceMotion && layers.length) {
    let mouseX = 0;
    let ticking = false;
    const update = () => {
      ticking = false;
      const y = window.scrollY;
      if (y > window.innerHeight * 1.2) return;
      for (const el of layers) {
        const depth = Number(el.dataset.depth);
        el.style.transform = `translate3d(${f(mouseX * depth * -40)}px, ${f(y * depth * 0.6)}px, 0)`;
      }
    };
    const request = () => {
      if (!ticking) { ticking = true; requestAnimationFrame(update); }
    };
    window.addEventListener('scroll', request, { passive: true });
    window.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      mouseX = e.clientX / window.innerWidth - 0.5;
      request();
    }, { passive: true });
    update();
  }

  // Solid navigation once the hero is scrolled past.
  const nav = document.getElementById('nav');
  if (nav) {
    const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 40);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  // Fade sections in as they enter the viewport.
  const reveal = document.querySelectorAll('.card, .section-head');
  if (!reduceMotion && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add('visible'); io.unobserve(e.target); }
    }, { threshold: 0.2 });
    reveal.forEach((el) => { el.classList.add('reveal'); io.observe(el); });
  }
}());
