'use strict';

/**
 * Spread fronts (Ausbreitungsfronten) of one species.
 *
 * Occupied area per year: all findings up to and including that year
 * (cumulative), each widened by a buffer (default 25 m, about the spot radius).
 * The outline is an alpha shape (alphashape.js): concave, split into
 * separate patches where findings lie more than 2α apart, with holes where
 * nothing grows. α defaults to 2.5 times the 90th percentile of the
 * distances between neighbouring findings; `alpha: null` gives the convex hull instead. All
 * years share one raster frame and α, so their shapes are nested and show
 * how the occupied area grows.
 *
 * Spread rate (method, also returned as text):
 *  1. Origin O = centroid of the findings of the first year.
 *  2. Front radius R(y) = distance from O to the farthest finding up to year y.
 *  3. Rate = least-squares slope of R(y) over the years (m/Jahr); needs findings
 *     in at least two different years.
 *  4. Direction = mean vector from O to the findings that pushed the front out
 *     (findings farther from O than the previous year's front radius), weighted
 *     by how far they lie beyond it. If those vectors point all over the place
 *     (resultant < 35 % of their summed length) the spread is reported as
 *     "in alle Richtungen".
 * The estimate is coarse: few, unevenly searched findings make R(y) depend on
 * where people walk. It is meant as an indication, not a measurement.
 */

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON = 111320;
const COMPASS8 = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
const BUFFER_SAMPLES = 16;
const { alphaShape, createFrame, autoAlpha } = require('./alphashape');

function projection(points) {
  const lat0 = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const lon0 = points.reduce((s, p) => s + p.lon, 0) / points.length;
  const kx = M_PER_DEG_LON * Math.cos((lat0 * Math.PI) / 180);
  return {
    toXY: (p) => [(p.lon - lon0) * kx, (p.lat - lat0) * M_PER_DEG_LAT],
    toLatLon: ([x, y]) => [lat0 + y / M_PER_DEG_LAT, lon0 + x / kx],
  };
}

/** Convex hull (Andrew's monotone chain), counter-clockwise, without repeating the first point. */
function convexHull(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length <= 2) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Polygon area (m²) by the shoelace formula. */
function polygonArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/** Convex hull of points each widened to a circle of `buffer` metres. */
function bufferedHull(xy, buffer) {
  const ring = [];
  for (const [x, y] of xy) {
    for (let k = 0; k < BUFFER_SAMPLES; k++) {
      const a = (2 * Math.PI * k) / BUFFER_SAMPLES;
      ring.push([x + buffer * Math.cos(a), y + buffer * Math.sin(a)]);
    }
  }
  return convexHull(ring);
}

/** Bearing (° from north, clockwise) of a vector in local metres. */
const bearing = (dx, dy) => ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
const compass8 = (deg) => COMPASS8[Math.round(deg / 45) % 8];

function slope(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den ? num / den : 0;
}

const roundRate = (v) => (v < 100 ? Math.round(v / 5) * 5 : Math.round(v / 10) * 10);

/**
 * Front radius and spread rate of findings ({ xy, year }) around the
 * centroid of the first year's findings. `years` lists the years to
 * evaluate (cumulative); the rate needs at least two of them.
 */
function frontRate(items, years) {
  const first = items.filter((i) => i.year === years[0]);
  const origin = [first.reduce((s, i) => s + i.xy[0], 0) / first.length, first.reduce((s, i) => s + i.xy[1], 0) / first.length];
  const dist = ([x, y]) => Math.hypot(x - origin[0], y - origin[1]);
  const radii = [];
  const pushVectors = [];
  let prevRadius = null;
  for (const year of years) {
    const cumulative = items.filter((i) => i.year <= year);
    const radius = cumulative.length ? Math.max(...cumulative.map((i) => dist(i.xy))) : 0;
    if (prevRadius !== null) {
      for (const i of items.filter((it) => it.year === year)) {
        const d = dist(i.xy);
        if (d > prevRadius && d > 0) pushVectors.push({ dx: i.xy[0] - origin[0], dy: i.xy[1] - origin[1], d, w: d - prevRadius });
      }
    }
    radii.push(radius);
    prevRadius = radius;
  }
  if (years.length < 2) return { origin, radii, rate: null };
  const mPerYear = Math.max(0, slope(years, radii));
  let direction = null;
  if (pushVectors.length) {
    let sx = 0; let sy = 0; let sum = 0;
    for (const v of pushVectors) {
      sx += (v.dx / v.d) * v.w;
      sy += (v.dy / v.d) * v.w;
      sum += v.w;
    }
    if (sum > 0 && Math.hypot(sx, sy) >= 0.35 * sum) direction = Math.round(bearing(sx, sy));
  }
  const span = `${years[0]}–${years[years.length - 1]}`;
  const text = mPerYear < 1
    ? `Keine Ausbreitung erkennbar (${span})`
    : `Ausbreitung ~${roundRate(mPerYear)} m/Jahr ${direction !== null ? `nach ${compass8(direction)}` : 'in alle Richtungen'} (${span})`;
  return {
    origin,
    radii,
    rate: { mPerYear: Math.round(mPerYear), direction, compass: direction !== null ? compass8(direction) : null, text },
  };
}

const centroid = (xys) => [xys.reduce((s, p) => s + p[0], 0) / xys.length, xys.reduce((s, p) => s + p[1], 0) / xys.length];

function pointInRing([px, py], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Patches (Teilbestände): the separate polygons of the newest alpha shape.
 * Each finding belongs to the patch that contains it (or the nearest one),
 * and every patch gets its own history: since when it exists, its area
 * and front radius per year, its own spread rate and direction, and – if
 * it appeared after the first year – how far it lies from the findings
 * that existed before (a jump, e.g. seeds carried by water or machines).
 */
function patchesOf(items, finalShape, yearList, frame, toLatLon) {
  const outers = finalShape.polygons.map((poly) => poly[0]);
  const owner = items.map((i) => {
    const k = outers.findIndex((ring) => pointInRing(i.xy, ring));
    if (k >= 0) return k;
    let best = 0; let bestD = Infinity;
    outers.forEach((ring, idx) => {
      for (const p of ring) {
        const d = Math.hypot(p[0] - i.xy[0], p[1] - i.xy[1]);
        if (d < bestD) { bestD = d; best = idx; }
      }
    });
    return best;
  });
  const groups = outers.map((ring, k) => Object.assign(items.filter((_, n) => owner[n] === k), { ring }))
    .filter((g) => g.length);
  // Oldest patch first; among equals the one with more findings.
  groups.sort((a, b) => Math.min(...a.map((i) => i.year)) - Math.min(...b.map((i) => i.year)) || b.length - a.length);
  return groups.map((g, n) => {
    const since = Math.min(...g.map((i) => i.year));
    const years = yearList.filter((y) => y >= since);
    const { origin, radii, rate } = frontRate(g, years);
    const perYear = years.map((year, k) => {
      const cumulative = g.filter((i) => i.year <= year).map((i) => i.xy);
      return {
        year,
        count: g.filter((i) => i.year === year).length,
        cumulativeCount: cumulative.length,
        areaM2: alphaShape(cumulative, frame).areaM2,
        frontRadiusM: Math.round(radii[k]),
      };
    });
    // A patch that appeared later: distance to the nearest finding of an earlier year.
    let jump = null;
    if (since > yearList[0]) {
      const earlier = items.filter((i) => i.year < since);
      const firstOnes = g.filter((i) => i.year === since);
      let best = Infinity; let from = null;
      for (const a of firstOnes) {
        for (const e of earlier) {
          const d = Math.hypot(a.xy[0] - e.xy[0], a.xy[1] - e.xy[1]);
          if (d < best) { best = d; from = e; }
        }
      }
      if (from) {
        const fromPatch = groups.findIndex((other) => other.includes(from)) + 1;
        const [cx, cy] = centroid(firstOnes.map((i) => i.xy));
        jump = { distanceM: Math.round(best), fromPatch, compass: compass8(bearing(cx - from.xy[0], cy - from.xy[1])) };
      }
    }
    const areaGrowth = perYear.length >= 2 ? Math.round(slope(years, perYear.map((y) => y.areaM2))) : null;
    const label = `Teilbestand ${n + 1}`;
    return {
      id: n + 1,
      label,
      since,
      count: g.length,
      areaM2: perYear[perYear.length - 1].areaM2,
      centroid: toLatLon(centroid(g.map((i) => i.xy))),
      outline: g.ring.map(toLatLon),
      origin: toLatLon(origin),
      years: perYear,
      rate: rate && { ...rate, areaM2PerYear: areaGrowth },
      jump,
      text: rate ? rate.text : `Erst seit ${since} – Ausbreitung noch nicht abschätzbar`,
    };
  });
}

/**
 * Spread analysis for a list of occurrences of one species
 * ({ lat, lon, takenAt } each). Returns per-year outlines, the rate estimate
 * for the whole species and – with alpha shapes – per patch.
 */
function spreadFronts(occurrences, { buffer = 25, alpha = 'auto' } = {}) {
  const pts = occurrences.filter((o) => Number.isFinite(o.lat) && Number.isFinite(o.lon) && Number.isFinite(o.takenAt));
  if (!pts.length) return { years: [], rate: null, origin: null, patches: [], shape: alpha === null ? 'convex' : 'alpha', method: methodText(alpha === null) };
  const proj = projection(pts);
  const toLatLon = (p) => proj.toLatLon(p).map((v) => Math.round(v * 1e6) / 1e6);
  const items = pts.map((o) => ({ xy: proj.toXY(o), year: new Date(o.takenAt).getUTCFullYear() }));
  const yearList = [...new Set(items.map((i) => i.year))].sort((a, b) => a - b);
  const allXY = items.map((i) => i.xy);
  const alphaM = alpha === null ? null : (alpha === 'auto' ? autoAlpha(allXY, buffer) : alpha);
  const frame = alphaM === null ? null : createFrame(allXY, { alpha: alphaM, buffer });
  const whole = frontRate(items, yearList);

  let lastShape = null;
  const years = yearList.map((year, k) => {
    const cumulative = items.filter((i) => i.year <= year).map((i) => i.xy);
    const hull = bufferedHull(cumulative, buffer);
    const shape = frame ? alphaShape(cumulative, frame) : null;
    lastShape = shape;
    return {
      year,
      count: items.filter((i) => i.year === year).length,
      cumulativeCount: cumulative.length,
      areaM2: shape ? shape.areaM2 : Math.round(polygonArea(hull)),
      convexAreaM2: Math.round(polygonArea(hull)),
      patches: shape ? shape.patches : 1,
      frontRadiusM: Math.round(whole.radii[k]),
      hull: hull.map(toLatLon),
      // Polygons as [outer, ...holes] (Leaflet's multipolygon nesting); the convex hull when α is off.
      polygons: shape ? shape.polygons.map((poly) => poly.map((ring) => ring.map(toLatLon))) : [[hull.map(toLatLon)]],
    };
  });

  const areaGrowth = years.length >= 2 ? Math.round(slope(yearList, years.map((y) => y.areaM2))) : null;
  const rate = whole.rate && { ...whole.rate, areaM2PerYear: areaGrowth };
  return {
    origin: toLatLon(whole.origin),
    bufferM: buffer,
    shape: frame ? 'alpha' : 'convex',
    alphaM,
    years,
    rate,
    patches: frame ? patchesOf(items, lastShape, yearList, frame, toLatLon) : [],
    text: rate ? rate.text : `Funde aus nur einem Jahr (${yearList[0]}) – Ausbreitung noch nicht abschätzbar`,
    method: methodText(!frame),
  };
}

const methodText = (convex) => (convex
  ? 'Fläche je Jahr: konvexe Hülle aller Funde bis zu diesem Jahr, jeder Fund um den Puffer erweitert. '
  : 'Fläche je Jahr: Alpha-Shape aller Funde bis zu diesem Jahr (alles, was kein fundfreier Kreis mit Radius α '
    + 'erreicht), jeder Fund um den Puffer erweitert; Funde, die mehr als 2α auseinanderliegen, bilden eigene '
    + 'Teilbestände, fundfreie Flächen breiter als 2α bleiben Lücken. ')
  + 'Rate: Steigung (kleinste Quadrate) des Abstands vom Schwerpunkt der Erstfunde zum jeweils entferntesten Fund. '
  + 'Richtung: gewichtetes Mittel der Funde, die die Front nach aussen geschoben haben.'
  + (convex ? '' : ' Pro Teilbestand dasselbe, ab seinem ersten Fund und mit dessen Schwerpunkt als Ursprung; ein später '
    + 'entstandener Teilbestand nennt den Abstand zum nächsten älteren Fund (Sprung).');

module.exports = { spreadFronts, convexHull, polygonArea, compass8 };
