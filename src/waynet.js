'use strict';

/**
 * Ways on in the walk-through along the path network: from where a picture was
 * taken, which own pictures can one reach on foot along paths and roads, and
 * in which direction does the path leave? The network comes from OpenStreetMap
 * through an Overpass API (WEGNETZ_URL, e.g. https://overpass-api.de/api/interpreter);
 * without it everything is off.
 *
 * Ways are fetched per cell of CELL degrees (about 1.1 × 0.75 km) and cached
 * for CELL_DAYS. Only the box of a cell leaves the server, nothing about the
 * pictures or who looks at them. Ways a walker cannot use (motorways, private
 * or foot=no) are left out.
 *
 * `reach(here, targets)`: `here` is snapped onto the nearest path (at most
 * SNAP_M away), then a shortest-path search runs along the network up to
 * MAX_M. Each target (a picture) is snapped the same way; its direction is the
 * one in which its path leaves `here` (measured LEAVE_M along the path, so a
 * short kink at the start does not count), its distance the one along the path.
 * Per leaving direction (within GROUP_DEG) only the nearest target stays.
 */

const { distanceM } = require('./geo');

const CELL = 0.01;
const CELL_DAYS = 30;
const DAY = 86400000;
const SNAP_M = 25;
const MAX_M = 300;
const LEAVE_M = 15;
const GROUP_DEG = 30;
const NOT_FOR_WALKING = 'motorway|motorway_link|trunk|trunk_link|construction|proposed|raceway|bus_guideway|abandoned|platform';

function bearing(a, b) {
  const rad = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lon - a.lon) * rad);
  return ((Math.atan2(y, x) / rad) + 360) % 360;
}
const angleDiff = (a, b) => Math.abs((((a - b) % 360) + 540) % 360 - 180);

/** The point on segment a–b closest to p: { t (0..1), point, d (m) }, in a local metric plane. */
function project(p, a, b) {
  const k = Math.cos((p.lat * Math.PI) / 180);
  const ax = (a.lon - p.lon) * k; const ay = a.lat - p.lat;
  const bx = (b.lon - p.lon) * k; const by = b.lat - p.lat;
  const dx = bx - ax; const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  const point = { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
  return { t, point, d: distanceM(p, point) };
}
const along = (a, b, m) => {
  const len = distanceM(a, b);
  const t = len ? Math.min(1, m / len) : 0;
  return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
};

/** Overpass answer → [{ id, nodes: [id], points: [{lat, lon}], highway, name }]. */
function parseOverpass(body) {
  return (body.elements || [])
    .filter((e) => e.type === 'way' && Array.isArray(e.nodes) && Array.isArray(e.geometry) && e.nodes.length === e.geometry.length && e.nodes.length > 1)
    .map((e) => ({
      id: e.id,
      nodes: e.nodes,
      points: e.geometry.map((g) => ({ lat: g.lat, lon: g.lon })),
      highway: e.tags?.highway || null,
      name: e.tags?.name || null,
    }));
}

/** A graph of the ways: nodes (id → {lat, lon}), edges (id → [{ to, m }]) and the segments. */
function buildGraph(ways) {
  const nodes = new Map();
  const edges = new Map();
  const segments = [];
  const add = (a, b, m) => {
    if (!edges.has(a)) edges.set(a, []);
    edges.get(a).push({ to: b, m });
  };
  for (const w of ways) {
    w.nodes.forEach((id, i) => nodes.set(id, w.points[i]));
    for (let i = 1; i < w.nodes.length; i++) {
      const [a, b] = [w.nodes[i - 1], w.nodes[i]];
      if (a === b) continue;
      const m = distanceM(w.points[i - 1], w.points[i]);
      add(a, b, m);
      add(b, a, m);
      segments.push({ a, b });
    }
  }
  return { nodes, edges, segments };
}

/** The nearest segment to p within SNAP_M: { a, b, t, point, d } or null. */
function snap(graph, p, maxM = SNAP_M) {
  let best = null;
  for (const s of graph.segments) {
    const A = graph.nodes.get(s.a);
    const B = graph.nodes.get(s.b);
    // Quick reject by box (≈ 0.0005° ≈ 40–55 m).
    if (Math.min(A.lat, B.lat) - 0.0005 > p.lat || Math.max(A.lat, B.lat) + 0.0005 < p.lat) continue;
    if (Math.min(A.lon, B.lon) - 0.0008 > p.lon || Math.max(A.lon, B.lon) + 0.0008 < p.lon) continue;
    const r = project(p, A, B);
    if (r.d <= maxM && (!best || r.d < best.d)) best = { a: s.a, b: s.b, ...r };
  }
  return best;
}

/** Small binary heap of [key, value]. */
function heap() {
  const h = [];
  const up = (i) => { while (i > 0) { const p = (i - 1) >> 1; if (h[p][0] <= h[i][0]) break; [h[p], h[i]] = [h[i], h[p]]; i = p; } };
  const down = (i) => {
    for (;;) {
      const l = 2 * i + 1; const r = l + 1; let m = i;
      if (l < h.length && h[l][0] < h[m][0]) m = l;
      if (r < h.length && h[r][0] < h[m][0]) m = r;
      if (m === i) return;
      [h[m], h[i]] = [h[i], h[m]]; i = m;
    }
  };
  return {
    push(k, v) { h.push([k, v]); up(h.length - 1); },
    pop() { const top = h[0]; const last = h.pop(); if (h.length) { h[0] = last; down(0); } return top; },
    get size() { return h.length; },
  };
}

/**
 * Shortest paths from `start` (a snap result) along the graph up to maxM:
 * Map(node → { m, anchor (the point LEAVE_M along the path, or null before), prev }).
 */
function search(graph, start, maxM = MAX_M) {
  const best = new Map();
  const q = heap();
  const S = start.point;
  for (const id of [start.a, start.b]) {
    const P = graph.nodes.get(id);
    const m = distanceM(S, P);
    const anchor = m >= LEAVE_M ? along(S, P, LEAVE_M) : null;
    if (!best.has(id) || best.get(id).m > m) best.set(id, { m, anchor, prev: null });
    q.push(m, id);
  }
  while (q.size) {
    const [m, id] = q.pop();
    const cur = best.get(id);
    if (m > cur.m || m > maxM) continue;
    const here = graph.nodes.get(id);
    for (const e of graph.edges.get(id) || []) {
      const nm = m + e.m;
      if (nm > maxM) continue;
      const old = best.get(e.to);
      if (old && old.m <= nm) continue;
      const anchor = cur.anchor || (nm >= LEAVE_M ? along(here, graph.nodes.get(e.to), LEAVE_M - m) : null);
      best.set(e.to, { m: nm, anchor, prev: id });
      q.push(nm, e.to);
    }
  }
  return best;
}

/** The path from the start to node `id` as [[lat, lon]] (start point first). */
function pathTo(graph, reached, start, id, end) {
  const pts = [];
  for (let n = id; n !== null && n !== undefined; n = reached.get(n)?.prev) pts.push(graph.nodes.get(n));
  pts.reverse();
  return [start.point, ...pts, end].map((p) => [Math.round(p.lat * 1e6) / 1e6, Math.round(p.lon * 1e6) / 1e6]);
}

/**
 * For each target ({ lat, lon, … }) reachable along the network: { target, bearing, distanceM, path }.
 * Only the nearest target per leaving direction. Targets less than 3 m away are left out.
 */
function reachAlong(graph, here, targets, { maxM = MAX_M } = {}) {
  const start = snap(graph, here);
  if (!start) return { onPath: false, links: [] };
  const reached = search(graph, start, maxM);
  const same = (s) => (s.a === start.a && s.b === start.b) || (s.a === start.b && s.b === start.a);
  const found = [];
  for (const target of targets) {
    const s = snap(graph, target);
    if (!s) continue;
    let res = null;
    if (same(s)) {
      const m = distanceM(start.point, s.point);
      res = { m, bearingTo: s.point, path: [[start.point.lat, start.point.lon], [s.point.lat, s.point.lon]] };
    } else {
      for (const id of [s.a, s.b]) {
        const r = reached.get(id);
        if (!r) continue;
        const m = r.m + distanceM(graph.nodes.get(id), s.point);
        if (m > maxM || (res && res.m <= m)) continue;
        res = { m, bearingTo: r.anchor || s.point, path: pathTo(graph, reached, start, id, s.point) };
      }
    }
    if (!res || res.m < 3) continue;
    found.push({ target, bearing: Math.round(bearing(start.point, res.bearingTo) * 10) / 10, distanceM: Math.round(res.m), path: res.path });
  }
  // The nearest per direction in which the path leaves.
  found.sort((a, b) => a.distanceM - b.distanceM);
  const links = [];
  for (const f of found) if (!links.some((l) => angleDiff(l.bearing, f.bearing) < GROUP_DEG)) links.push(f);
  return { onPath: true, links };
}

function createWaynet({ db, url = process.env.WEGNETZ_URL || '', fetchImpl = fetch, now = () => Date.now(), timeoutMs = 20000 } = {}) {
  const enabled = Boolean(url);
  db.exec(`CREATE TABLE IF NOT EXISTS waynet_cells (
    cell TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL, json TEXT NOT NULL
  )`);
  const getCell = db.prepare('SELECT fetched_at, json FROM waynet_cells WHERE cell = ?');
  const putCell = db.prepare('INSERT OR REPLACE INTO waynet_cells (cell, fetched_at, json) VALUES (?, ?, ?)');
  const pending = new Map();

  async function fetchCell(cx, cy) {
    const [s, w, n, e] = [cy * CELL, cx * CELL, (cy + 1) * CELL, (cx + 1) * CELL].map((v) => v.toFixed(4));
    const query = `[out:json][timeout:25];way["highway"]["highway"!~"^(${NOT_FOR_WALKING})$"]["access"!~"^(private|no)$"]["foot"!~"^(no|private)$"](${s},${w},${n},${e});out geom;`;
    const res = await fetchImpl(url, {
      method: 'POST',
      body: new URLSearchParams({ data: query }),
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Wegnetz (Overpass) antwortet mit HTTP ${res.status}`);
    return parseOverpass(await res.json());
  }

  /** The ways of one cell (cached; one request per cell at a time). */
  async function cell(cx, cy) {
    const key = `${cx}:${cy}`;
    const row = getCell.get(key);
    if (row && now() - row.fetched_at < CELL_DAYS * DAY) return JSON.parse(row.json);
    if (!pending.has(key)) {
      pending.set(key, fetchCell(cx, cy)
        .then((ways) => { putCell.run(key, now(), JSON.stringify(ways)); return ways; })
        .catch((err) => { if (row) return JSON.parse(row.json); throw err; })
        .finally(() => pending.delete(key)));
    }
    return pending.get(key);
  }

  /** The ways within `radiusM` of a place (all cells touched, without duplicates). */
  async function waysNear(lat, lon, radiusM = MAX_M + SNAP_M) {
    const dLat = radiusM / 111320;
    const dLon = dLat / Math.cos((lat * Math.PI) / 180);
    const cells = [];
    for (let cx = Math.floor((lon - dLon) / CELL); cx <= Math.floor((lon + dLon) / CELL); cx++) {
      for (let cy = Math.floor((lat - dLat) / CELL); cy <= Math.floor((lat + dLat) / CELL); cy++) cells.push([cx, cy]);
    }
    const seen = new Map();
    for (const ways of await Promise.all(cells.map(([x, y]) => cell(x, y)))) for (const w of ways) seen.set(w.id, w);
    return [...seen.values()];
  }

  /**
   * Targets reachable from `here` along paths: { onPath, links: [{ target, bearing, distanceM, path }],
   * ways: [[[lat, lon]]] near `here` for the mini map }.
   */
  async function reach(here, targets, { maxM = MAX_M, mapM = 150 } = {}) {
    const ways = await waysNear(here.lat, here.lon);
    const result = reachAlong(buildGraph(ways), here, targets, { maxM });
    const near = ways.filter((w) => w.points.some((p) => distanceM(here, p) <= mapM)).slice(0, 200);
    return { ...result, ways: near.map((w) => w.points.map((p) => [Math.round(p.lat * 1e6) / 1e6, Math.round(p.lon * 1e6) / 1e6])) };
  }

  return { enabled: () => enabled, reach, waysNear };
}

module.exports = { createWaynet, parseOverpass, buildGraph, reachAlong, snap, MAX_M, SNAP_M };
