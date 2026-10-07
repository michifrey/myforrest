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
 * Spread analysis for a list of occurrences of one species
 * ({ lat, lon, takenAt } each). Returns per-year hulls and the rate estimate.
 */
function spreadFronts(occurrences, { buffer = 25, alpha = 'auto' } = {}) {
  const pts = occurrences.filter((o) => Number.isFinite(o.lat) && Number.isFinite(o.lon) && Number.isFinite(o.takenAt));
  if (!pts.length) return { years: [], rate: null, origin: null, shape: alpha === null ? 'convex' : 'alpha', method: methodText(alpha === null) };
  const proj = projection(pts);
  const yearOf = (o) => new Date(o.takenAt).getUTCFullYear();
  const yearList = [...new Set(pts.map(yearOf))].sort((a, b) => a - b);
  const xyOf = new Map(pts.map((o) => [o, proj.toXY(o)]));

  const firstXY = pts.filter((o) => yearOf(o) === yearList[0]).map((o) => xyOf.get(o));
  const origin = [firstXY.reduce((s, p) => s + p[0], 0) / firstXY.length, firstXY.reduce((s, p) => s + p[1], 0) / firstXY.length];
  const dist = ([x, y]) => Math.hypot(x - origin[0], y - origin[1]);
  const allXY = pts.map((o) => xyOf.get(o));
  const alphaM = alpha === null ? null : (alpha === 'auto' ? autoAlpha(allXY, buffer) : alpha);
  const frame = alphaM === null ? null : createFrame(allXY, { alpha: alphaM, buffer });
  const toLatLon = (p) => proj.toLatLon(p).map((v) => Math.round(v * 1e6) / 1e6);

  const years = [];
  const pushVectors = [];
  let prevRadius = null;
  for (const year of yearList) {
    const cumulative = pts.filter((o) => yearOf(o) <= year).map((o) => xyOf.get(o));
    const fresh = pts.filter((o) => yearOf(o) === year);
    const hull = bufferedHull(cumulative, buffer);
    const shape = frame ? alphaShape(cumulative, frame) : null;
    const radius = Math.max(...cumulative.map(dist));
    if (prevRadius !== null) {
      for (const o of fresh) {
        const p = xyOf.get(o);
        const d = dist(p);
        if (d > prevRadius && d > 0) pushVectors.push({ dx: p[0] - origin[0], dy: p[1] - origin[1], d, w: d - prevRadius });
      }
    }
    years.push({
      year,
      count: fresh.length,
      cumulativeCount: cumulative.length,
      areaM2: shape ? shape.areaM2 : Math.round(polygonArea(hull)),
      convexAreaM2: Math.round(polygonArea(hull)),
      patches: shape ? shape.patches : 1,
      frontRadiusM: Math.round(radius),
      hull: hull.map(toLatLon),
      // Polygons as [outer, ...holes] (Leaflet's multipolygon nesting); the convex hull when α is off.
      polygons: shape ? shape.polygons.map((poly) => poly.map((ring) => ring.map(toLatLon))) : [[hull.map(toLatLon)]],
    });
    prevRadius = radius;
  }

  let rate = null;
  if (yearList.length >= 2) {
    const mPerYear = Math.max(0, slope(years.map((y) => y.year), years.map((y) => y.frontRadiusM)));
    let direction = null;
    let directed = false;
    if (pushVectors.length) {
      let sx = 0; let sy = 0; let sum = 0;
      for (const v of pushVectors) {
        sx += (v.dx / v.d) * v.w;
        sy += (v.dy / v.d) * v.w;
        sum += v.w;
      }
      if (sum > 0 && Math.hypot(sx, sy) >= 0.35 * sum) {
        direction = Math.round(bearing(sx, sy));
        directed = true;
      }
    }
    const span = `${yearList[0]}–${yearList[yearList.length - 1]}`;
    let text;
    if (mPerYear < 1) text = `Keine Ausbreitung erkennbar (${span})`;
    else {
      text = `Ausbreitung ~${roundRate(mPerYear)} m/Jahr ${directed ? `nach ${compass8(direction)}` : 'in alle Richtungen'} (${span})`;
    }
    rate = { mPerYear: Math.round(mPerYear), direction, compass: directed ? compass8(direction) : null, text };
  }

  const areaGrowth = years.length >= 2
    ? Math.round(slope(years.map((y) => y.year), years.map((y) => y.areaM2)))
    : null;

  return {
    origin: proj.toLatLon(origin).map((v) => Math.round(v * 1e6) / 1e6),
    bufferM: buffer,
    shape: frame ? 'alpha' : 'convex',
    alphaM,
    years,
    rate: rate && { ...rate, areaM2PerYear: areaGrowth },
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
  + 'Richtung: gewichtetes Mittel der Funde, die die Front nach aussen geschoben haben.';

module.exports = { spreadFronts, convexHull, polygonArea, compass8 };
