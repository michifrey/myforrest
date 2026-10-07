'use strict';

/*
 * Procedural forest scenery for the hero and footer: layered tree lines with
 * atmospheric depth, drifting mist, stars and fireflies, plus a gentle
 * parallax. Purely decorative; everything is aria-hidden.
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

  /** One silhouette layer: rolling ground plus a row of trees. */
  function layer({ seed, height, ground, amp, treeH, treeW, gap, broadleafShare = 0 }) {
    const rnd = rng(seed);
    const groundAt = (x) => ground + Math.sin(x / 260 + seed) * amp + Math.sin(x / 97 + seed * 2) * amp * 0.35;
    let hill = `M0 ${height}`;
    for (let x = 0; x <= W; x += 20) hill += `L${x} ${f(groundAt(x))}`;
    hill += `L${W} ${height}Z`;
    // Each shape is its own <path>: overlapping outlines with opposite
    // winding would otherwise cancel out and leave holes.
    const shapes = [hill];
    for (let x = -treeW; x < W + treeW; x += gap * (0.55 + rnd() * 0.9)) {
      const h = treeH * (0.6 + rnd() * 0.6);
      const w = treeW * (0.75 + rnd() * 0.5);
      const base = groundAt(Math.max(0, Math.min(W, x))) + 4;
      shapes.push(rnd() < broadleafShare ? broadleaf(x, base, h * 0.8, w * 1.5, rnd) : spruce(x, base, h, w, rnd));
    }
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${height}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMax slice');
    for (const d of shapes) {
      const path = document.createElementNS(SVG, 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  }

  const LAYERS = [
    { seed: 11, height: 600, ground: 330, amp: 26, treeH: 70, treeW: 26, gap: 15, depth: 0.08 },
    { seed: 23, height: 600, ground: 380, amp: 22, treeH: 100, treeW: 34, gap: 22, depth: 0.16, broadleafShare: 0.1 },
    { seed: 37, height: 600, ground: 430, amp: 18, treeH: 140, treeW: 46, gap: 32, depth: 0.26, broadleafShare: 0.2 },
    { seed: 51, height: 600, ground: 500, amp: 14, treeH: 170, treeW: 58, gap: 52, depth: 0.38, broadleafShare: 0.15 },
    { seed: 67, height: 600, ground: 570, amp: 8, treeH: 260, treeW: 90, gap: 120, depth: 0.52 },
  ];

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const forestEl = document.getElementById('forest');
  const layers = [];
  if (forestEl) {
    LAYERS.forEach((cfg, i) => {
      const wrap = document.createElement('div');
      wrap.className = `tree-layer l${i + 1}`;
      wrap.dataset.depth = String(cfg.depth);
      wrap.append(layer(cfg));
      forestEl.append(wrap);
      layers.push(wrap);
      if (i === 1 || i === 3) {
        const mist = document.createElement('div');
        mist.className = `mist mist-${i}`;
        mist.dataset.depth = String(cfg.depth);
        forestEl.append(mist);
        layers.push(mist);
      }
    });
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
    const svg = layer({ seed: 91, height: 160, ground: 120, amp: 6, treeH: 90, treeW: 30, gap: 30, broadleafShare: 0.2 });
    footer.setAttribute('viewBox', svg.getAttribute('viewBox'));
    footer.setAttribute('preserveAspectRatio', 'xMidYMax slice');
    footer.append(...[...svg.childNodes]);
  }

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
