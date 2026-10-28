/*
 * Sun and shade along a route: for a start time and a pace, which stretches
 * lie in the sun and which in the shade of hills, trees or buildings, and at
 * which start time a tour stays most in the shade (or in the sun).
 * Runs in the browser (window.RouteSun) and in Node (module.exports) for tests.
 *
 * Every SAMPLE_M metres along the route gets a horizon of its own, seen from
 * eye height (1.7 m above the ground): in DIRS directions the elevation angle
 * of the highest terrain (out to 20 km, with the Earth's curvature and
 * refraction) and, separately, of the highest tree or roof within
 * OBJECT_REACH_M. The horizon does not depend on the time, so trying many
 * start times costs only the sun positions. A place lies in the sun when the
 * sun's upper limb stands above both horizons.
 *
 * Heights come from samplers (lat, lon) → metres: `ground` for the terrain,
 * `objects` for the height of trees and buildings above the ground (null
 * where nothing is known). `tileSampler` builds one from Web Mercator tiles.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./sun.js'));
  else root.RouteSun = factory(root.Sun);
}(typeof self !== 'undefined' ? self : this, (Sun) => {
  'use strict';

  const RAD = Math.PI / 180;
  const DEG = 180 / Math.PI;
  const EARTH_R = 6371000;
  const REFRACTION_K = 0.13;
  const M_PER_DEG = 111320;
  const SAMPLE_M = 25;
  const MAX_SAMPLES = 1600; // longer routes get a coarser step
  const DIRS = 72; // every 5°
  const EYE_M = 1.7;
  const SUN_RADIUS = 0.27; // °, the sun's upper limb
  const OBJECT_REACH_M = 120; // how far trees and houses count; beyond, the terrain grid sees them anyway
  const OBJECT_STEP_M = 1.5;
  // Distances for the terrain horizon (m): fine close by, coarser far away.
  const TERRAIN_DIST = [];
  for (let d = 30; d <= 20000; d *= 1.12) TERRAIN_DIST.push(Math.round(d));
  const SPEEDS = { joggen: 9, wandern: 4, biken: 15, sonstiges: 4.5 }; // km/h on the flat

  const drop = (d) => ((d * d) / (2 * EARTH_R)) * (1 - REFRACTION_K);
  const mod = (a, n) => ((a % n) + n) % n;

  /** Great-circle-free distance (m) between two nearby points, good enough along a route. */
  function dist(a, b) {
    const x = (b.lon - a.lon) * Math.cos(((a.lat + b.lat) / 2) * RAD);
    return Math.hypot(b.lat - a.lat, x) * M_PER_DEG;
  }

  /**
   * Points every `step` m along `points` ([{ lat, lon, time?, ele? }]), the
   * first and the last included: [{ lat, lon, d, w, time }] with the distance
   * from the start, the length of route each one stands for (w) and, where
   * the route has times, the time it was passed.
   */
  function sample(points, step = SAMPLE_M) {
    const pts = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    if (pts.length < 2) return [];
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
    const total = cum.at(-1);
    if (!(total > 0)) return [];
    const s = Math.max(step, total / MAX_SAMPLES);
    const n = Math.max(1, Math.round(total / s));
    const out = [];
    let i = 1;
    for (let k = 0; k <= n; k++) {
      const d = (k / n) * total;
      while (i < pts.length - 1 && cum[i] < d) i++;
      const a = pts[i - 1]; const b = pts[i];
      const f = cum[i] > cum[i - 1] ? Math.max(0, Math.min(1, (d - cum[i - 1]) / (cum[i] - cum[i - 1]))) : 0;
      const time = Number.isFinite(a.time) && Number.isFinite(b.time) ? a.time + (b.time - a.time) * f : null;
      out.push({ lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f, d, w: (k === 0 || k === n ? 0.5 : 1) * (total / n), time });
    }
    return out;
  }

  /** The point `distance` m from (lat, lon) towards `bearing` (° from north). */
  function towards(lat, lon, bearing, distance) {
    const dLat = (Math.cos(bearing * RAD) * distance) / M_PER_DEG;
    const dLon = (Math.sin(bearing * RAD) * distance) / (M_PER_DEG * Math.cos(lat * RAD));
    return [lat + dLat, lon + dLon];
  }

  /**
   * Horizon of every sample: { terrain: Float32Array(DIRS), objects:
   * Float32Array(DIRS) | null, covered } in degrees above the flat horizon
   * (never below 0). `covered`: a crown or roof right above the place.
   */
  function horizons(samples, { ground, objects = null, eye = EYE_M } = {}) {
    return samples.map((s) => {
      const z0 = ground(s.lat, s.lon);
      const terrain = new Float32Array(DIRS);
      if (!Number.isFinite(z0)) return { terrain, objects: null, covered: false };
      const eyeZ = z0 + eye;
      for (let k = 0; k < DIRS; k++) {
        const az = (k * 360) / DIRS;
        let best = 0;
        for (const d of TERRAIN_DIST) {
          const z = ground(...towards(s.lat, s.lon, az, d));
          if (!Number.isFinite(z)) continue;
          const a = Math.atan2(z - drop(d) - eyeZ, d) * DEG;
          if (a > best) best = a;
        }
        terrain[k] = best;
      }
      if (!objects) return { terrain, objects: null, covered: false };
      const here = objects(s.lat, s.lon);
      if (here === null || here === undefined) return { terrain, objects: null, covered: false };
      const covered = here > eye + 1;
      const obj = new Float32Array(DIRS);
      if (covered) obj.fill(90);
      else {
        for (let k = 0; k < DIRS; k++) {
          const az = (k * 360) / DIRS;
          let best = 0;
          for (let d = OBJECT_STEP_M; d <= OBJECT_REACH_M; d += OBJECT_STEP_M) {
            const [lat, lon] = towards(s.lat, s.lon, az, d);
            const h = objects(lat, lon);
            if (!(h > 0)) continue;
            const z = ground(lat, lon);
            const a = Math.atan2((Number.isFinite(z) ? z : z0) + h - eyeZ, d) * DEG;
            if (a > best) best = a;
          }
          obj[k] = best;
        }
      }
      return { terrain, objects: obj, covered };
    });
  }

  /** A horizon's angle towards an azimuth, between its directions. */
  function angleAt(angles, azimuth) {
    const x = mod(azimuth, 360) / (360 / DIRS);
    const i = Math.floor(x) % DIRS;
    const f = x - Math.floor(x);
    return angles[i] * (1 - f) + angles[(i + 1) % DIRS] * f;
  }

  /** 'sonne', 'gelaende' (terrain), 'baeume' (trees and buildings) or 'nacht' for a sun position and a horizon. */
  function light(sun, hz) {
    if (sun.altitude + SUN_RADIUS <= 0) return 'nacht';
    if (sun.altitude + SUN_RADIUS <= angleAt(hz.terrain, sun.azimuth)) return 'gelaende';
    if (hz.objects && sun.altitude + SUN_RADIUS <= angleAt(hz.objects, sun.azimuth)) return 'baeume';
    return 'sonne';
  }

  /**
   * Pace on a slope relative to the flat, after Tobler's hiking function (Tobler 1993: 6·e^(−3,5·|m + 0,05|) km/h
   * for a gradient m): fastest slightly downhill, slower uphill and on steep descents. 1 on the flat.
   */
  const toblerRel = (m) => Math.exp(-3.5 * Math.abs(Math.max(-1, Math.min(1, m)) + 0.05)) / Math.exp(-3.5 * 0.05);

  /** Gradient at each sample, over ±50 m (the terrain grid is coarser than the samples), from `z`; 0 where unknown. */
  function gradients(samples) {
    return samples.map((s, i) => {
      const a = samples[Math.max(0, i - 2)]; const b = samples[Math.min(samples.length - 1, i + 2)];
      const run = b.d - a.d;
      return run > 0 && Number.isFinite(a.z) && Number.isFinite(b.z) ? (b.z - a.z) / run : 0;
    });
  }

  /**
   * When each sample is passed: its recorded time (`recorded`), else start + distance at `speedKmh`; with `slope`
   * and heights (`z`) on the samples the pace follows the gradient (speedKmh is then the pace on the flat).
   */
  function timesOf(samples, { start, speedKmh, recorded = false, slope = false }) {
    if (recorded && samples.every((s) => Number.isFinite(s.time))) return samples.map((s) => s.time);
    const v = (speedKmh * 1000) / 3600000; // m per ms
    if (!slope || !samples.some((s) => Number.isFinite(s.z))) return samples.map((s) => start + s.d / v);
    const m = gradients(samples);
    const out = [start];
    for (let i = 1; i < samples.length; i++) {
      const rel = (toblerRel(m[i - 1]) + toblerRel(m[i])) / 2;
      out.push(out[i - 1] + (samples[i].d - samples[i - 1].d) / (v * rel));
    }
    return out;
  }

  /**
   * Light along the route for one start: per sample { t, altitude, azimuth,
   * state } and the metres in each state ({ sonne, schatten, gelaende, baeume,
   * nacht, total }; schatten = gelaende + baeume).
   */
  function along(samples, hz, opts) {
    const times = timesOf(samples, opts);
    const sum = { sonne: 0, gelaende: 0, baeume: 0, nacht: 0 };
    const points = samples.map((s, i) => {
      const sun = Sun.position(times[i], s.lat, s.lon);
      const state = light(sun, hz[i]);
      sum[state] += s.w;
      return { t: times[i], altitude: sun.altitude, azimuth: sun.azimuth, state };
    });
    const total = sum.sonne + sum.gelaende + sum.baeume + sum.nacht;
    return { points, sum: { ...sum, schatten: sum.gelaende + sum.baeume, total } };
  }

  /**
   * Start times of a day (from `from` to `to`, ms, every `stepMin` minutes):
   * [{ start, end, sonne, schatten, nacht }] as shares of the route (0–1),
   * plus the start with the most shade and the one with the most sun, both
   * only among starts that end before the sun sets (no night on the way);
   * null when there is none.
   */
  function starts(samples, hz, { from, to, speedKmh, slope = false, stepMin = 15 }) {
    const list = [];
    const duration = samples.length ? timesOf(samples, { start: 0, speedKmh, slope }).at(-1) : 0;
    for (let t = from; t <= to; t += stepMin * 60000) {
      const { sum } = along(samples, hz, { start: t, speedKmh, slope });
      const f = (x) => (sum.total ? x / sum.total : 0);
      list.push({ start: t, end: t + duration, sonne: f(sum.sonne), schatten: f(sum.schatten), nacht: f(sum.nacht) });
    }
    const day = list.filter((s) => s.nacht === 0);
    const pick = (key) => (day.length ? day.reduce((a, b) => (b[key] > a[key] + 1e-9 ? b : a)) : null);
    return { list, shadiest: pick('schatten'), sunniest: pick('sonne') };
  }

  /**
   * A sampler over Web Mercator tiles of zoom `z` (256 px): `get(x, y)`
   * returns a tile's row-major values (Float32Array(65536)) or null/undefined
   * where there are none. Values between pixel centres are interpolated
   * (`smooth`) or taken from the nearest pixel. Returns NaN outside, or `none`.
   */
  function tileSampler(z, get, { smooth = true, none = NaN } = {}) {
    const n = 2 ** z;
    return (lat, lon) => {
      const px = ((lon + 180) / 360) * n * 256;
      const s = Math.sin(lat * RAD);
      const py = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n * 256;
      const tx = Math.floor(px / 256); const ty = Math.floor(py / 256);
      const t = get(mod(tx, n), ty);
      if (!t) return none;
      const lx = px - tx * 256; const ly = py - ty * 256;
      if (!smooth) return t[Math.min(255, Math.floor(ly)) * 256 + Math.min(255, Math.floor(lx))];
      const fx = Math.max(0, Math.min(254.999, lx - 0.5)); const fy = Math.max(0, Math.min(254.999, ly - 0.5));
      const i = fx | 0; const j = fy | 0; const u = fx - i; const v = fy - j; const r = j * 256 + i;
      return (t[r] * (1 - u) + t[r + 1] * u) * (1 - v) + (t[r + 256] * (1 - u) + t[r + 257] * u) * v;
    };
  }

  /** Web Mercator tiles of zoom `z` within `margin` metres of any of the points: ['x/y']. */
  function tilesNear(points, z, margin) {
    const n = 2 ** z;
    const set = new Set();
    for (const p of points) {
      for (const [dy, dx] of [[0, 0], [margin, margin], [margin, -margin], [-margin, margin], [-margin, -margin], [margin, 0], [-margin, 0], [0, margin], [0, -margin]]) {
        const lat = p.lat + dy / M_PER_DEG;
        const lon = p.lon + dx / (M_PER_DEG * Math.cos(p.lat * RAD));
        const s = Math.sin(lat * RAD);
        const x = Math.floor(((lon + 180) / 360) * n);
        const y = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n);
        set.add(`${mod(x, n)}/${y}`);
      }
    }
    return [...set];
  }

  return { sample, horizons, light, along, starts, timesOf, toblerRel, gradients, tileSampler, tilesNear, angleAt, SPEEDS, DIRS, SAMPLE_M, OBJECT_REACH_M };
}));
