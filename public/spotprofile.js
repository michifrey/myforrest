/*
 * "Licht & Wald" in the spot page: the terrain horizon around the spot from
 * north-east over south to north-west, the sun's path of a day over it, the
 * sun at the chosen time and the spot's tree species in their season, drawn
 * like the scenery of the start page (layered silhouettes, mist).
 *
 * The horizon comes from the elevation model (/api/horizon, as in "Sonne &
 * Wetter"), the sun from sun.js, the species and their expected colouring at
 * this spot from the spot itself. Where the sun's path disappears behind the
 * ridge, the spot lies in the shade.
 *
 * The season of a tree kind is a pure function and runs in Node for tests;
 * the drawing needs the browser (window.SpotProfile).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SpotProfile = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const RAD = Math.PI / 180;

  /* ---------- Season of a tree ---------- */

  const SPRING = [143, 179, 90];
  const SUMMER = [63, 108, 52];
  const AUTUMN = [214, 140, 44];
  const LATE = [150, 86, 40];
  const BARE = [112, 94, 74];
  const SPRUCE = [31, 61, 39];
  const FIR = [36, 70, 52];
  const LARCH_GREEN = [104, 146, 72];
  const LARCH_GOLD = [222, 172, 58];
  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.max(0, Math.min(1, t))));

  /** How a species is drawn: spruce, fir (flatter tiers), larch (loses its needles) or broadleaf. */
  function treeKind(t) {
    if (t.group === 'nadel') {
      if (!t.evergreen) return 'laerche';
      return /^(Abies|Pseudotsuga|Taxus)\b/.test(t.scientificName || '') ? 'tanne' : 'fichte';
    }
    return 'laub';
  }

  /** Day of the year the leaves come out: later uphill (~2.5 days per 100 m above 400 m), Robinia late. */
  function leafOutDoy(t, elevation) {
    const uphill = Math.max(0, ((elevation ?? 400) - 400) / 100) * 2.5;
    return Math.round(108 + uphill + (/^Robinia\b/.test(t.scientificName || '') ? 12 : 0));
  }

  /**
   * Colour (rgb), opacity and wording of a species on a day of the year:
   * Austrieb, belaubt, Herbstfärbung, Laubfall, kahl or immergrün. Colouring
   * starts at the spot's expected day (`colourDoyHere`, from height,
   * exposition and cold air), leaves are gone about four weeks later.
   */
  function season(t, doy, elevation) {
    const kind = treeKind(t);
    if (kind === 'fichte') return { rgb: SPRUCE, alpha: 1, label: 'immergrün' };
    if (kind === 'tanne') return { rgb: FIR, alpha: 1, label: 'immergrün' };
    const larch = kind === 'laerche';
    const out = leafOutDoy(t, elevation);
    const turn = t.colourDoyHere ?? t.colourDoy ?? (larch ? 290 : 280);
    const peak = turn + 14;
    const fall = turn + 30;
    const green = larch ? LARCH_GREEN : SUMMER;
    if (doy < out - 6 || doy > fall + 6) return { rgb: BARE, alpha: 0.38, label: 'kahl' };
    if (doy < out + 18) return { rgb: larch ? LARCH_GREEN : SPRING, alpha: Math.min(1, 0.45 + (doy - out + 6) / 24), label: 'Austrieb' };
    if (doy < turn) return { rgb: larch ? LARCH_GREEN : mix(SPRING, SUMMER, (doy - out - 18) / 30), alpha: 1, label: 'belaubt' };
    if (doy < peak) return { rgb: mix(green, larch ? LARCH_GOLD : AUTUMN, (doy - turn) / 14), alpha: 1, label: 'Herbstfärbung' };
    return { rgb: mix(larch ? LARCH_GOLD : AUTUMN, LATE, (doy - peak) / 16), alpha: 1 - Math.max(0, (doy - peak - 6) / 22), label: 'Laubfall' };
  }

  /* ---------- Weather at a moment ---------- */

  /**
   * The weather of the hour around `t` from /api/weather/day: temperature,
   * cloud cover, rain (mm/h), snowfall (cm/h), snow on the ground (cm), what
   * falls ('regen', 'schnee', 'schneeregen' or null) and whether it is
   * slippery. Without separate rain and snowfall, the precipitation is split
   * by temperature (snow up to 0.5 °C, rain from 2 °C, sleet between).
   * Slippery: rain at or below 0 °C (Glatteis), snow lying or falling at up
   * to 1 °C (Schneeglätte), or frost after precipitation in the last six
   * hours (überfrierende Nässe).
   */
  function weatherAt(day, t) {
    const rows = (day?.hourly || []).filter((r) => Number.isFinite(r.t));
    if (!rows.length || t < rows[0].t - 3600e3 || t > rows[rows.length - 1].t + 2 * 3600e3) return null;
    let i = rows.findIndex((r) => r.t > t);
    i = i < 0 ? rows.length - 1 : Math.max(0, i - 1);
    const h = rows[i];
    const num = (v) => (Number.isFinite(v) ? v : null);
    const temp = num(h.temp);
    const precip = num(h.precip) ?? 0;
    const split = h.rain === null || h.rain === undefined || h.snowfall === null || h.snowfall === undefined;
    const snowShare = temp === null ? 0 : temp <= 0.5 ? 1 : temp >= 2 ? 0 : (2 - temp) / 1.5;
    const rain = split ? precip * (1 - snowShare) : num(h.rain) ?? 0;
    const snowfall = split ? precip * snowShare * 0.7 : num(h.snowfall) ?? 0;
    const snowDepth = num(h.snowDepth);
    const falling = snowfall >= 0.05 && rain >= 0.1 ? 'schneeregen' : snowfall >= 0.05 ? 'schnee' : rain >= 0.1 ? 'regen' : null;
    const wetBefore = rows.slice(Math.max(0, i - 6), i + 1).some((r) => (num(r.precip) ?? 0) >= 0.1);
    let ice = null;
    if (temp !== null && temp <= 0 && rain >= 0.1) ice = 'Glatteis';
    else if (temp !== null && temp <= 1 && ((snowDepth ?? 0) >= 1 || snowfall >= 0.05)) ice = 'Schneeglätte';
    else if (temp !== null && temp <= 0 && wetBefore) ice = 'überfrierende Nässe';
    return { temp, cloud: num(h.cloud), rain, snowfall, snowDepth, falling, ice };
  }

  const dayOfYear = (d) => Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 0)) / 864e5);

  const pure = { treeKind, leafOutDoy, season, dayOfYear, weatherAt };
  if (typeof document === 'undefined' || typeof window === 'undefined' || !window.Sun) return pure;

  /* ---------- Drawing (browser) ---------- */

  const Sun = window.Sun;
  const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  const AZ0 = 40;
  const AZ1 = 320;

  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let x = Math.imul(a ^ (a >>> 15), a | 1);
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** A spruce as on the start page; `sparse` > 1 thins the tiers (larch), < 1 fills them (fir). */
  function spruce(ctx, cx, base, h, w, rnd, sparse = 1) {
    const tiers = 5 + Math.floor(rnd() * 3);
    const top = base - h;
    const left = [];
    const right = [];
    for (let i = 1; i <= tiers; i++) {
      const t = i / tiers;
      const y = top + h * 0.92 * t;
      const reach = (w / 2) * t * (0.85 + rnd() * 0.3);
      const inner = reach * (0.45 + rnd() * 0.15) * sparse;
      const sag = h * 0.035;
      left.push([cx - reach, y + sag], [cx - inner, y - sag * 0.4]);
      right.push([cx + reach, y + sag * (0.8 + rnd() * 0.4)], [cx + inner, y - sag * 0.4]);
    }
    const trunk = Math.max(1, w * 0.05);
    ctx.beginPath();
    ctx.moveTo(cx, top);
    for (const [x, y] of left) ctx.lineTo(x, y);
    ctx.lineTo(cx - trunk, base - h * 0.06);
    ctx.lineTo(cx - trunk, base + 6);
    ctx.lineTo(cx + trunk, base + 6);
    ctx.lineTo(cx + trunk, base - h * 0.06);
    for (const [x, y] of right.reverse()) ctx.lineTo(x, y);
    ctx.closePath();
    ctx.fill();
  }

  /** A broadleaf tree: lumpy round crown on a trunk. */
  function broadleaf(ctx, cx, base, h, w, rnd, crown, bark) {
    const r = w / 2;
    const cy = base - h + r;
    ctx.fillStyle = bark;
    ctx.fillRect(cx - w * 0.04, cy + r * 0.2, w * 0.08, base + 6 - cy - r * 0.2);
    ctx.fillStyle = crown;
    ctx.beginPath();
    const lobes = 5 + Math.floor(rnd() * 3);
    for (let i = 0; i < lobes; i++) {
      const a = (i / lobes) * Math.PI * 2;
      const lr = r * (0.45 + rnd() * 0.2);
      const x = cx + Math.cos(a) * r * 0.5;
      const y = cy + Math.sin(a) * r * 0.45;
      ctx.moveTo(x + lr, y);
      ctx.arc(x, y, lr, 0, Math.PI * 2);
    }
    ctx.moveTo(cx + r * 0.7, cy);
    ctx.arc(cx, cy, r * 0.7, 0, Math.PI * 2);
    ctx.fill();
  }

  /** A bare tree in winter: trunk and forks, `w` the trunk's width. */
  function bareTree(ctx, cx, base, h, w, colour) {
    ctx.strokeStyle = colour;
    ctx.lineCap = 'round';
    const fork = (x, y, len, ang, width, depth) => {
      const x2 = x + Math.sin(ang) * len;
      const y2 = y - Math.cos(ang) * len;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      if (depth > 0) {
        fork(x2, y2, len * 0.68, ang - 0.45, width * 0.62, depth - 1);
        fork(x2, y2, len * 0.68, ang + 0.42, width * 0.62, depth - 1);
      }
    };
    fork(cx, base + 4, h * 0.36, 0, w, 4);
  }

  // Sky colours by sun altitude: night, dusk, low sun, day.
  const SKY = [
    { alt: -14, top: [10, 20, 32], low: [24, 42, 48] },
    { alt: -5, top: [38, 52, 76], low: [214, 150, 104] },
    { alt: 2, top: [168, 190, 204], low: [246, 205, 148] },
    { alt: 12, top: [205, 222, 222], low: [246, 226, 184] },
    { alt: 35, top: [218, 230, 222], low: [243, 234, 208] },
  ];
  function skyAt(alt) {
    for (let i = 1; i < SKY.length; i++) {
      if (alt <= SKY[i].alt) {
        const a = SKY[i - 1];
        const b = SKY[i];
        const t = (alt - a.alt) / (b.alt - a.alt);
        return { top: mix(a.top, b.top, t), low: mix(a.low, b.low, t) };
      }
    }
    return SKY[SKY.length - 1];
  }

  // Ground of the near band by landscape.
  const GROUND = { wald: [46, 82, 50], gebirge: [104, 112, 84], gletscher: [150, 158, 160], trocken: [196, 160, 104] };
  const GROUND_DARK = { wald: [23, 48, 30], gebirge: [62, 66, 52], gletscher: [92, 100, 104], trocken: [130, 100, 60] };

  /**
   * Draws the profile into `canvas` for `spot` at `time` (ms) with `horizon`
   * (/api/horizon, or null for an open horizon) and the weather `wx`
   * (weatherAt, or null): clouds, rain, snowfall, snow on the ground, ice.
   * Returns what the caption needs.
   */
  function draw(canvas, spot, time, horizon, wx = null) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(canvas.clientWidth * dpr);
    const H = Math.round(canvas.clientHeight * dpr);
    if (!W || !H) return null;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const ctx = canvas.getContext('2d');
    const day = new Date(time);
    const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
    const doy = dayOfYear(day);
    const hz = (az) => Math.max(0, Sun.horizonAt(horizon, az));
    const now = Sun.position(time, spot.lat, spot.lon);
    const lit = now.altitude + 0.27 > hz(now.azimuth);
    const u = Math.max(H / 400, 0.75 * dpr);
    const baseY = H * 0.7;
    const scale = (baseY - H * 0.1) / 68;
    const X = (az) => ((az - AZ0) / (AZ1 - AZ0)) * W;
    const Y = (alt) => baseY - alt * scale;
    const AZ = (x) => AZ0 + (x / W) * (AZ1 - AZ0);
    const night = now.altitude < -6 ? Math.min(1, (-6 - now.altitude) / 8) : 0;
    // Clouds grey the sky and veil the sun; snow whitens the ground and frosts the conifers.
    const overcast = Number.isFinite(wx?.cloud) ? wx.cloud / 100 : 0;
    const clear = skyAt(now.altitude);
    const grey = night > 0 ? [30, 38, 44] : now.altitude < 4 ? [150, 150, 156] : [176, 182, 184];
    const sky = { top: mix(clear.top, grey, overcast * 0.8), low: mix(clear.low, mix(grey, [255, 255, 255], 0.2), overcast * 0.7) };
    const snow = (wx?.snowDepth ?? 0) >= 1 ? Math.min(1, 0.55 + wx.snowDepth / 40) : 0;
    const SNOW = [236, 240, 243];
    const snowy = (c, k = 1) => mix(c, SNOW, snow * k);
    const dim = (c) => mix(c, [12, 22, 26], night * 0.75);
    const haze = (c, k) => mix(c, sky.low, k);

    // Sky and stars.
    const g = ctx.createLinearGradient(0, 0, 0, baseY);
    g.addColorStop(0, rgb(sky.top));
    g.addColorStop(1, rgb(sky.low));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    if (night > 0) {
      const r = rng(7);
      ctx.fillStyle = `rgba(244,241,220,${0.8 * night})`;
      for (let i = 0; i < 70; i++) { ctx.beginPath(); ctx.arc(r() * W, r() * baseY * 0.9, (0.5 + r()) * u, 0, Math.PI * 2); ctx.fill(); }
    }

    // The day's path, then the sun: the terrain drawn afterwards hides what is behind it.
    const path = [];
    for (let m = 0; m <= 1440; m += 4) path.push({ m, ...Sun.position(dayStart + m * 60000, spot.lat, spot.lon) });
    ctx.save();
    ctx.setLineDash([2 * u, 5 * u]);
    ctx.lineWidth = 2 * u;
    ctx.lineCap = 'round';
    ctx.strokeStyle = night > 0.5 ? 'rgba(240,220,170,0.35)' : 'rgba(168,120,12,0.75)';
    ctx.beginPath();
    let pen = false;
    for (const p of path) {
      if (p.altitude < -1 || p.azimuth < AZ0 - 5 || p.azimuth > AZ1 + 5) { pen = false; continue; }
      if (pen) ctx.lineTo(X(p.azimuth), Y(p.altitude)); else { ctx.moveTo(X(p.azimuth), Y(p.altitude)); pen = true; }
    }
    ctx.stroke();
    ctx.restore();
    if (now.altitude > -2) {
      ctx.save();
      ctx.globalAlpha = 1 - overcast * 0.85;
      const sx = X(now.azimuth);
      const sy = Y(now.altitude);
      const glow = ctx.createRadialGradient(sx, sy, 0, sx, sy, 70 * u);
      glow.addColorStop(0, 'rgba(255,214,120,0.75)');
      glow.addColorStop(0.35, 'rgba(255,200,90,0.25)');
      glow.addColorStop(1, 'rgba(255,200,90,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(sx - 80 * u, sy - 80 * u, 160 * u, 160 * u);
      ctx.fillStyle = now.altitude < 6 ? '#e8932f' : '#d9a21c';
      ctx.beginPath(); ctx.arc(sx, sy, 10 * u, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,240,200,0.9)';
      ctx.beginPath(); ctx.arc(sx - 3 * u, sy - 3 * u, 3.5 * u, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    if (overcast > 0.25) {
      // Soft cloud banks across the upper sky.
      const r = rng(41);
      const tone = night > 0 ? 'rgba(70,80,90,' : 'rgba(250,250,248,';
      for (let i = 0; i < 9; i++) {
        const cx = r() * W;
        const cy = (0.08 + r() * 0.35) * baseY;
        const rx = (60 + r() * 90) * u;
        const ry = rx * (0.22 + r() * 0.12);
        const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, rx);
        cg.addColorStop(0, `${tone}${0.55 * overcast})`);
        cg.addColorStop(1, `${tone}0)`);
        ctx.fillStyle = cg;
        ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry * 2.2, 0, 0, Math.PI * 2); ctx.fill();
      }
    }

    // Far ridge: the terrain horizon, with a fringe of small trees.
    const species = spot.species || [];
    const landscape = spot.landscape || 'wald';
    const forest = landscape === 'wald' || species.length > 0;
    const far = rng(11);
    ctx.fillStyle = rgb(dim(snowy(haze(landscape === 'wald' ? [120, 152, 112] : [138, 146, 140], 0.55), 0.55)));
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 4) ctx.lineTo(x, Y(hz(AZ(x)) + 0.4));
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();
    if (forest) for (let x = -10; x < W + 10; x += (5 + far() * 7) * u) spruce(ctx, x, Y(hz(AZ(Math.max(0, Math.min(W, x)))) + 0.4) + 2 * u, (6 + far() * 6) * u, (4 + far() * 3) * u, far);

    // The trees of the spot, or a plain mixed forest while none are recorded.
    const trees = species.length ? species : (landscape === 'wald' ? [
      { group: 'nadel', evergreen: true, scientificName: 'Picea abies' },
      { group: 'laub', evergreen: false, scientificName: 'Fagus sylvatica', colourDoy: 280 },
    ] : []);
    const look = trees.map((t) => ({ t, kind: treeKind(t), s: season(t, doy, spot.elevation) }));

    // Middle band below the horizon.
    const mid = rng(23);
    const midY = (x) => Y(hz(AZ(x)) * 0.45) + 24 * u + Math.sin(x / (90 * u)) * 5 * u;
    ctx.fillStyle = rgb(dim(snowy(haze(landscape === 'wald' ? [84, 120, 80] : GROUND[landscape] || GROUND.wald, 0.3), 0.75)));
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 4) ctx.lineTo(x, midY(x));
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();
    if (look.length) {
      for (let x = -10; x < W + 10; x += (9 + mid() * 10) * u) {
        const { kind, s } = look[Math.floor(mid() * look.length)];
        const base = midY(Math.max(0, Math.min(W, x))) + 3 * u;
        const h = (15 + mid() * 11) * u;
        const c = rgb(dim(snowy(haze(s.rgb, 0.3), 0.3)), s.alpha);
        if (s.label === 'kahl') continue; // bare trees vanish into the band at this distance
        ctx.fillStyle = c;
        if (kind === 'fichte' || kind === 'tanne') spruce(ctx, x, base, h, h * 0.42, mid);
        else if (kind === 'laerche') spruce(ctx, x, base, h, h * 0.4, mid, 1.25);
        else broadleaf(ctx, x, base, h * 0.85, h * 0.75, mid, c, rgb(dim(haze([70, 60, 48], 0.3))));
      }
    }

    // Mist between middle and near band.
    const my = midY(W / 2);
    const mist = ctx.createLinearGradient(0, my - 10 * u, 0, my + 40 * u);
    mist.addColorStop(0, rgb(sky.low, 0));
    mist.addColorStop(0.6, rgb(sky.low, 0.35 * (1 - night)));
    mist.addColorStop(1, rgb(sky.low, 0));
    ctx.fillStyle = mist;
    ctx.fillRect(0, my - 10 * u, W, 50 * u);

    // Near band on its own layer: the slope of the spot (down towards its aspect) and its trees.
    const layer = draw.layer || (draw.layer = document.createElement('canvas'));
    if (layer.width !== W || layer.height !== H) { layer.width = W; layer.height = H; }
    const n = layer.getContext('2d');
    n.clearRect(0, 0, W, H);
    const tilt = Math.min(1, (spot.slope || 0) / 20) * 30 * u;
    const down = spot.aspect ?? 180;
    const bump = spot.landform === 'kuppe' ? -1 : spot.landform === 'senke' ? 1 : 0;
    const groundY = (x) => H * 0.86 + tilt * Math.cos((AZ(x) - down) * RAD)
      + bump * 14 * u * Math.exp(-(((x - W * 0.5) / (W * 0.28)) ** 2)) + Math.sin(x / (60 * u)) * 2 * u;
    const wet = wx?.falling === 'regen' || wx?.falling === 'schneeregen' ? 0.18 : 0;
    n.fillStyle = rgb(dim(snowy(mix(GROUND[landscape] || GROUND.wald, [10, 20, 14], wet))));
    n.beginPath();
    n.moveTo(0, H);
    for (let x = 0; x <= W; x += 4) n.lineTo(x, groundY(x));
    n.lineTo(W, H);
    n.closePath();
    n.fill();
    if (look.length) {
      const near = rng((spot.id || 1) * 97 + 5);
      let i = 0;
      for (let x = -14 * u; x < W + 14 * u; x += (18 + near() * 26) * u) {
        const { kind, s } = look[(i++ * 7 + Math.floor(near() * 3)) % look.length];
        const base = groundY(Math.max(0, Math.min(W, x))) + 4 * u;
        const h = 72 * u * (0.75 + near() * 0.45);
        const c = dim(kind === 'fichte' || kind === 'tanne' || kind === 'laerche' ? snowy(s.rgb, 0.22) : s.rgb);
        if (kind === 'fichte' || kind === 'tanne') {
          n.fillStyle = rgb(c);
          if (kind === 'fichte') spruce(n, x, base, h, h * 0.4, near);
          else spruce(n, x, base, h * 0.92, h * 0.5, near, 0.8);
        } else if (s.label === 'kahl') {
          bareTree(n, x, base, h * (kind === 'laerche' ? 1 : 0.95), Math.max(2.4 * u, h * 0.06), rgb(dim([88, 74, 60]), 0.9));
        } else if (kind === 'laerche') {
          n.fillStyle = rgb(c, s.alpha);
          spruce(n, x, base, h, h * 0.38, near, 1.35);
        } else {
          broadleaf(n, x, base, h * 0.85, h * 0.8, near, rgb(c, Math.max(0.35, s.alpha)), rgb(dim([74, 58, 44])));
        }
      }
    }
    // Light: warm from the sun's side while it reaches the spot, otherwise cool and flat.
    n.globalCompositeOperation = 'source-atop';
    if (lit) {
      const sx = X(Math.max(AZ0, Math.min(AZ1, now.azimuth)));
      const lg = n.createRadialGradient(sx, Y(now.altitude), 0, sx, Y(now.altitude), W * 0.9);
      const k = Math.min(1, 0.4 + now.altitude / 30);
      lg.addColorStop(0, `rgba(255,214,140,${0.38 * k})`);
      lg.addColorStop(1, 'rgba(255,214,140,0)');
      n.fillStyle = lg;
      n.fillRect(0, 0, W, H);
    } else if (night < 1) {
      n.fillStyle = `rgba(40,60,80,${0.22 * (1 - night)})`;
      n.fillRect(0, 0, W, H);
    }
    n.globalCompositeOperation = 'source-over';
    ctx.drawImage(layer, 0, 0);
    if (wx?.ice) {
      // Ice: a cold glint along the ground.
      ctx.strokeStyle = 'rgba(205,232,255,0.9)';
      ctx.lineWidth = 2.2 * u;
      ctx.beginPath();
      for (let x = 0; x <= W; x += 6) (x ? ctx.lineTo(x, groundY(x) + 1.5 * u) : ctx.moveTo(x, groundY(x) + 1.5 * u));
      ctx.stroke();
      const r = rng(53);
      ctx.fillStyle = 'rgba(240,250,255,0.95)';
      for (let i = 0; i < 18; i++) { const x = r() * W; ctx.beginPath(); ctx.arc(x, groundY(x) + (2 + r() * 8) * u, (0.8 + r()) * u, 0, Math.PI * 2); ctx.fill(); }
    }

    // Ground strip with the compass.
    const strip = 16 * u;
    ctx.fillStyle = rgb(dim(GROUND_DARK[landscape] || GROUND_DARK.wald));
    ctx.fillRect(0, H - strip, W, strip);
    ctx.font = `600 ${9 * u}px 'Manrope Variable', system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(246,243,232,0.8)';
    for (const [az, label] of [[90, 'O'], [135, 'SO'], [180, 'S'], [225, 'SW'], [270, 'W']]) ctx.fillText(label, X(az), H - strip / 2);

    // Rain as slanted streaks, snow as flakes, more the heavier it falls.
    if (wx?.falling) {
      const r = rng(Math.floor(time / 600000));
      const rainCount = wx.rain >= 0.1 ? Math.min(220, 50 + wx.rain * 60) : 0;
      ctx.strokeStyle = night > 0.5 ? 'rgba(170,185,200,0.45)' : 'rgba(120,140,160,0.55)';
      ctx.lineWidth = 1.1 * u;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let i = 0; i < rainCount; i++) {
        const x = r() * (W + 40 * u);
        const y = r() * H;
        const len = (8 + r() * 8) * u;
        ctx.moveTo(x, y);
        ctx.lineTo(x - len * 0.3, y + len);
      }
      ctx.stroke();
      const flakes = wx.snowfall >= 0.05 ? Math.min(260, 60 + wx.snowfall * 220) : 0;
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      for (let i = 0; i < flakes; i++) {
        ctx.beginPath();
        ctx.arc(r() * W, r() * H, (0.8 + r() * 1.6) * u, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Sunshine above the ridge this day.
    const periods = Sun.sunPeriods(dayStart, spot.lat, spot.lon, horizon);
    return { now, lit, periods, look };
  }

  /* ---------- In the spot page ---------- */

  const $ = (id) => document.getElementById(id);
  const canvas = $('spot-profile');
  if (!canvas) return pure;
  const horizons = new Map(); // spot id → /api/horizon (or a promise of it)
  const weathers = new Map(); // "spot id:YYYY-MM-DD" → /api/weather/day (or a promise of it)
  const view = { spot: null, photo: null, day: 'photo', date: null, minute: 720, horizon: null };
  const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(Math.floor(min % 60)).padStart(2, '0')}`;
  const minuteOf = (t) => { const d = new Date(t); return d.getHours() * 60 + d.getMinutes(); };
  const fmtTime = (t) => hhmm(minuteOf(t));

  function chosenTime() {
    const base = view.day === 'date' && view.date ? new Date(view.date)
      : view.day === 'photo' && view.photo ? new Date(view.photo.takenAt) : new Date();
    return new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, view.minute).getTime();
  }

  const isoLocal = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

  /** The hourly weather of the chosen day at the spot: the value when loaded, else undefined (and starts loading). */
  function weatherDay(spot, time) {
    const date = isoLocal(time);
    const key = `${spot.id}:${date}`;
    const hit = weathers.get(key);
    if (hit && !(hit instanceof Promise)) return hit;
    if (!hit) {
      const elev = Number.isFinite(spot.elevation) ? `&elevation=${Math.round(spot.elevation)}` : '';
      weathers.set(key, api(`/api/weather/day?lat=${spot.lat.toFixed(4)}&lon=${spot.lon.toFixed(4)}&date=${date}${elev}`)
        .catch((err) => ({ date, source: null, hourly: [], error: err.message }))
        .then((d) => {
          if (d.error) weathers.delete(key); else weathers.set(key, d); // try again next time after an error
          if (view.spot?.id === spot.id) render();
        }));
    }
    return undefined;
  }

  const CLOUD = (c) => (c < 20 ? 'klar' : c < 50 ? 'leicht bewölkt' : c < 85 ? 'bewölkt' : 'bedeckt');
  function weatherLine(day, wx) {
    if (day === undefined) return 'Wetter wird geladen …';
    if (!wx) return day?.error ? `Wetter nicht verfügbar (${day.error})` : 'Wetter für diesen Tag nicht verfügbar';
    const parts = [];
    if (wx.temp !== null) parts.push(`${wx.temp.toFixed(1).replace('-', '−')} °C`);
    if (wx.falling === 'regen') parts.push(`Regen ${wx.rain.toFixed(1)} mm/h`);
    else if (wx.falling === 'schnee') parts.push(`Schneefall ${wx.snowfall.toFixed(1)} cm/h`);
    else if (wx.falling === 'schneeregen') parts.push('Schneeregen');
    else if (wx.cloud !== null) parts.push(CLOUD(wx.cloud));
    if ((wx.snowDepth ?? 0) >= 1) parts.push(`${Math.round(wx.snowDepth)} cm Schnee`);
    if (wx.ice) parts.push(`Glätte: ${wx.ice}`);
    return `${parts.join(' · ')}${day.source === 'forecast' ? ' (Vorhersage)' : ''}`;
  }

  function render() {
    if (!view.spot || $('side-pane-light')?.hidden) return;
    const time = chosenTime();
    const day = weatherDay(view.spot, time);
    const wx = day ? weatherAt(day, time) : null;
    const out = draw(canvas, view.spot, time, view.horizon, wx);
    if (!out) return;
    $('profile-clock').textContent = hhmm(view.minute);
    const { now, lit, periods, look } = out;
    const total = periods.reduce((s, p) => s + (p.to - p.from), 0) / 60000;
    const sunLine = periods.length
      ? `Sonne über dem Grat ${fmtTime(periods[0].from)}–${fmtTime(periods[periods.length - 1].to)} (${Math.floor(total / 60)} h ${String(Math.round(total % 60)).padStart(2, '0')})`
      : 'An diesem Tag keine Sonne am Spot';
    const at = view.day === 'photo' && view.photo && view.minute === minuteOf(view.photo.takenAt) ? 'Beim Foto' : `Um ${hhmm(view.minute)}`;
    const nowLine = now.altitude < -0.83 ? `${at} Nacht`
      : lit ? `${at} ${now.altitude.toFixed(0)}° hoch aus ${Sun.compass(now.azimuth)}`
        : `${at} im Schatten des Geländes`;
    const terrain = view.horizon?.angles ? '' : (view.horizon ? ' · Horizont nicht verfügbar, offen gerechnet' : ' · Horizont wird geladen …');
    $('profile-caption').textContent = `${sunLine} · ${nowLine}${terrain}`;
    $('profile-weather').textContent = weatherLine(day, wx);
    $('profile-weather').classList.toggle('ice', Boolean(wx?.ice));
    $('profile-trees').textContent = (view.spot.species || []).length
      ? look.map(({ t, s }) => `${t.name} ${s.label}`).join(' · ')
      : (view.spot.landscape || 'wald') === 'wald' ? 'Baumarten noch nicht erfasst: Mischwald als Platzhalter' : '';
    canvas.setAttribute('aria-label', `Horizont des Spots mit Sonnenbogen. ${$('profile-caption').textContent}. ${$('profile-weather').textContent}`);
  }

  async function loadHorizon(spot) {
    if (!horizons.has(spot.id)) {
      horizons.set(spot.id, api(`/api/horizon?lat=${spot.lat.toFixed(5)}&lon=${spot.lon.toFixed(5)}`).catch((err) => ({ angles: null, error: err.message })));
    }
    const h = await horizons.get(spot.id);
    if (!h.angles) horizons.delete(spot.id); // try again next time
    if (view.spot?.id === spot.id) { view.horizon = h; render(); }
  }

  function pickDay(day) {
    view.day = day;
    for (const b of document.querySelectorAll('#profile-day button')) b.setAttribute('aria-pressed', String(b.dataset.day === day));
    view.minute = day === 'photo' && view.photo ? minuteOf(view.photo.takenAt) : minuteOf(Date.now());
    $('profile-time').value = String(view.minute);
    render();
  }

  // Each shown photo sets the day and time; a new spot loads its horizon.
  document.addEventListener('myforrest:photo', (e) => {
    const spot = state.spot; // app.js
    if (!spot) return;
    if (view.spot?.id !== spot.id) { view.horizon = null; loadHorizon(spot); }
    view.spot = spot;
    view.photo = e.detail;
    if (view.day === 'photo') { view.minute = minuteOf(e.detail.takenAt); $('profile-time').value = String(view.minute); }
    render();
  });
  $('profile-time').addEventListener('input', (e) => { view.minute = Number(e.target.value); render(); });
  $('profile-day').addEventListener('click', (e) => { const b = e.target.closest('button[data-day]'); if (b) pickDay(b.dataset.day); });
  new ResizeObserver(() => render()).observe(canvas);
  document.fonts?.ready.then(render);

  /** Shows a given moment (ms), e.g. for the screenshots; "Fototag" or "Heute" go back. */
  function show(t) {
    view.day = 'date';
    view.date = t;
    view.minute = minuteOf(t);
    $('profile-time').value = String(view.minute);
    for (const b of document.querySelectorAll('#profile-day button')) b.setAttribute('aria-pressed', 'false');
    render();
  }

  return { ...pure, draw, render, show };
}));
