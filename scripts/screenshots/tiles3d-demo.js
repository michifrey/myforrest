'use strict';
// Demo 3D Tiles for the 3D map, in the format of swisstopo's: a hamlet of houses (b3dm with a glTF of boxes and
// gabled roofs) and the tree crowns of the demo forest (pnts point cloud), each with a tileset.json. Heights are
// ellipsoidal like swisstopo's, i.e. the demo terrain plus 50 m (the app shifts them back down).

const A = 6378137;
const E2 = 6.69437999014e-3;
const GEOID = 50;
const rad = (d) => (d * Math.PI) / 180;

function ecef(lat, lon, h) {
  const p = rad(lat); const l = rad(lon);
  const n = A / Math.sqrt(1 - E2 * Math.sin(p) ** 2);
  return [(n + h) * Math.cos(p) * Math.cos(l), (n + h) * Math.cos(p) * Math.sin(l), (n * (1 - E2) + h) * Math.sin(p)];
}

/** East-north-up frame at a point, as a column-major 4×4 matrix into Earth-centred coordinates. */
function enuToEcef(lat, lon, h) {
  const p = rad(lat); const l = rad(lon);
  const t = ecef(lat, lon, h);
  return [
    -Math.sin(l), Math.cos(l), 0, 0,
    -Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p), 0,
    Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p), 0,
    t[0], t[1], t[2], 1,
  ];
}

const pad = (buf, n, fill = 0) => (buf.length % n ? Buffer.concat([buf, Buffer.alloc(n - (buf.length % n), fill)]) : buf);
const jsonPad = (o, n, offset = 0) => {
  let s = JSON.stringify(o);
  while ((s.length + offset) % n) s += ' ';
  return Buffer.from(s);
};

/** A binary glTF with one mesh of several parts, each { positions, normals, indices, color } with its own material. */
function glb(parts) {
  const f32 = (a) => Buffer.from(new Float32Array(a).buffer);
  const chunks = [];
  const views = [];
  const accessors = [];
  let offset = 0;
  const view = (buf, target) => {
    chunks.push(buf);
    views.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, target });
    offset += buf.length;
    return views.length - 1;
  };
  const primitives = parts.map((p, m) => {
    const count = p.positions.length / 3;
    const min = [0, 1, 2].map((k) => Math.min(...p.positions.filter((_, i) => i % 3 === k)));
    const max = [0, 1, 2].map((k) => Math.max(...p.positions.filter((_, i) => i % 3 === k)));
    accessors.push({ bufferView: view(f32(p.positions), 34962), componentType: 5126, count, type: 'VEC3', min, max });
    accessors.push({ bufferView: view(f32(p.normals), 34962), componentType: 5126, count, type: 'VEC3' });
    accessors.push({ bufferView: view(Buffer.from(new Uint32Array(p.indices).buffer), 34963), componentType: 5125, count: p.indices.length, type: 'SCALAR' });
    const a = accessors.length - 3;
    return { attributes: { POSITION: a, NORMAL: a + 1 }, indices: a + 2, material: m };
  });
  const bin = pad(Buffer.concat(chunks), 4);
  const json = {
    asset: { version: '2.0', generator: 'MyForrest demo' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives }],
    materials: parts.map((p) => ({ pbrMetallicRoughness: { baseColorFactor: p.color, metallicFactor: 0, roughnessFactor: 0.9 } })),
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: bin.length }],
  };
  const j = jsonPad(json, 4);
  const header = Buffer.alloc(12);
  const total = 12 + 8 + j.length + 8 + bin.length;
  header.write('glTF', 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8);
  const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.write(type, 4, 'latin1'); return b; };
  return Buffer.concat([header, ch(j.length, 'JSON'), j, ch(bin.length, 'BIN\0'), bin]);
}

/** Batched 3D model: header, a feature table without features, the glTF. */
function b3dm(model) {
  const ft = jsonPad({ BATCH_LENGTH: 0 }, 8, 28);
  const header = Buffer.alloc(28);
  header.write('b3dm', 0); header.writeUInt32LE(1, 4); header.writeUInt32LE(28 + ft.length + model.length, 8);
  header.writeUInt32LE(ft.length, 12);
  return Buffer.concat([header, ft, model]);
}

/** Point cloud: positions (float, local z-up) and RGB. */
function pnts(points) {
  const n = points.length;
  const pos = Buffer.from(new Float32Array(points.flatMap((p) => p.slice(0, 3))).buffer);
  const rgb = Buffer.from(points.flatMap((p) => p[3]));
  const bin = pad(Buffer.concat([pos, rgb]), 8);
  const ft = jsonPad({ POINTS_LENGTH: n, POSITION: { byteOffset: 0 }, RGB: { byteOffset: pos.length } }, 8, 28);
  const header = Buffer.alloc(28);
  header.write('pnts', 0); header.writeUInt32LE(1, 4); header.writeUInt32LE(28 + ft.length + bin.length, 8);
  header.writeUInt32LE(ft.length, 12); header.writeUInt32LE(bin.length, 16);
  return Buffer.concat([header, ft, bin]);
}

// Hamlet north-east of the windthrow spot, along the forest track; trees around the spot.
const CENTRE = { lat: 47.3745, lon: 8.5735 };
const HOUSES = [
  [47.37505, 8.57300, 14, 10, 7, 20], [47.37520, 8.57345, 12, 9, 6, 20], [47.37480, 8.57380, 16, 11, 8, 110],
  [47.37455, 8.57420, 11, 8, 6, 110], [47.37540, 8.57410, 18, 12, 9, 35], [47.37570, 8.57365, 10, 8, 6, 35],
  [47.37600, 8.57440, 22, 14, 10, 120], [47.37500, 8.57470, 12, 9, 7, 20],
];

function local(lat, lon) {
  return [(lon - CENTRE.lon) * 111320 * Math.cos(rad(CENTRE.lat)), (lat - CENTRE.lat) * 110574];
}

function buildings(elevation) {
  const h0 = elevation(CENTRE.lat, CENTRE.lon) + GEOID;
  const WALL = { positions: [], normals: [], indices: [], color: [0.93, 0.9, 0.84, 1] };
  const ROOF = { positions: [], normals: [], indices: [], color: [0.66, 0.28, 0.2, 1] };
  // Local east, north, up → glTF (y up): x = east, y = up, z = −north.
  const push = (part, e, n, u, ne, nn, nu) => { part.positions.push(e, u, -n); part.normals.push(ne, nu, -nn); return part.positions.length / 3 - 1; };
  const quad = (pts, nrm, part) => {
    const i = pts.map(([e, n, u]) => push(part, e, n, u, ...nrm));
    part.indices.push(i[0], i[1], i[2], i[0], i[2], i[3]);
  };
  const tri = (pts, nrm, part) => { const i = pts.map(([e, n, u]) => push(part, e, n, u, ...nrm)); part.indices.push(...i); };
  for (const [lat, lon, w, d, wallH, heading] of HOUSES) {
    const [ce, cn] = local(lat, lon);
    const base = elevation(lat, lon) + GEOID - h0 - 1; // a metre into the ground: no gap on slopes
    const a = rad(heading);
    const ax = [Math.sin(a), Math.cos(a)]; const ay = [Math.cos(a), -Math.sin(a)];
    const at = (x, y) => [ce + ax[0] * y + ay[0] * x, cn + ax[1] * y + ay[1] * x];
    const corners = [at(-w / 2, -d / 2), at(w / 2, -d / 2), at(w / 2, d / 2), at(-w / 2, d / 2)];
    const top = base + 1 + wallH; const ridge = top + d * 0.45;
    for (let k = 0; k < 4; k++) {
      const [p, q] = [corners[k], corners[(k + 1) % 4]];
      const nrm = [q[1] - p[1], -(q[0] - p[0]), 0];
      const len = Math.hypot(nrm[0], nrm[1]);
      quad([[...p, base], [...q, base], [...q, top], [...p, top]], [nrm[0] / len, nrm[1] / len, 0], WALL);
    }
    // Gable roof along the long side (x): ridge in the middle of y.
    const r0 = at(-w / 2, 0); const r1 = at(w / 2, 0);
    quad([[...corners[0], top], [...corners[1], top], [...r1, ridge], [...r0, ridge]], [-ax[0] * 0.6, -ax[1] * 0.6, 0.8], ROOF);
    quad([[...corners[2], top], [...corners[3], top], [...r0, ridge], [...r1, ridge]], [ax[0] * 0.6, ax[1] * 0.6, 0.8], ROOF);
    tri([[...corners[1], top], [...corners[2], top], [...r1, ridge]], [ay[0], ay[1], 0], WALL);
    tri([[...corners[3], top], [...corners[0], top], [...r0, ridge]], [-ay[0], -ay[1], 0], WALL);
  }
  return { content: b3dm(glb([WALL, ROOF])), h0 };
}

function trees(elevation) {
  const h0 = elevation(CENTRE.lat, CENTRE.lon) + GEOID;
  const points = [];
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 360; i++) {
    const lat = CENTRE.lat - 0.004 + rnd() * 0.006;
    const lon = CENTRE.lon - 0.006 + rnd() * 0.007;
    const [e, n] = local(lat, lon);
    // Keep the hamlet and the track free.
    if (HOUSES.some(([la, lo]) => Math.hypot((la - lat) * 110574, (lo - lon) * 75000) < 22)) continue;
    const ground = elevation(lat, lon) + GEOID - h0;
    const conifer = rnd() < 0.35;
    const height = 18 + rnd() * 14; const r = conifer ? 3 : 5 + rnd() * 2;
    const green = conifer ? [38, 78, 44] : [78 + Math.round(rnd() * 30), 118 + Math.round(rnd() * 30), 52];
    for (let k = 0; k < 140; k++) {
      // Crown: a cone for conifers, an ellipsoid for broadleaves; a few points for the trunk.
      const t = rnd(); const phi = rnd() * Math.PI * 2;
      let dx; let dy; let dz;
      if (k < 8) { dx = 0; dy = 0; dz = (k / 8) * height * 0.5; } else if (conifer) {
        const z = height * (0.3 + 0.7 * t); const rr = r * (1 - (z - height * 0.3) / (height * 0.7)) * Math.sqrt(rnd());
        dx = Math.cos(phi) * rr; dy = Math.sin(phi) * rr; dz = z;
      } else {
        const u = rnd() * 2 - 1; const rr = Math.sqrt(1 - u * u);
        dx = Math.cos(phi) * rr * r; dy = Math.sin(phi) * rr * r; dz = height - r * 1.2 + u * r * 1.1;
      }
      const shade = k < 8 ? [92, 70, 50] : green.map((c) => Math.max(0, Math.min(255, Math.round(c * (0.8 + 0.4 * (dz / height))))));
      points.push([e + dx, n + dy, ground + dz, shade]);
    }
  }
  return { content: pnts(points), h0 };
}

/** The tileset of one kind ('gebaeude', 'baeume') with its content file name. */
function tileset(kind, elevation) {
  const { h0 } = kind === 'gebaeude' ? buildings(elevation) : trees(elevation);
  const w = rad(CENTRE.lon - 0.008); const e = rad(CENTRE.lon + 0.008);
  const s = rad(CENTRE.lat - 0.006); const n = rad(CENTRE.lat + 0.005);
  return {
    asset: { version: '1.0', generator: 'MyForrest demo' },
    geometricError: 200,
    root: {
      transform: enuToEcef(CENTRE.lat, CENTRE.lon, h0),
      boundingVolume: { region: [w, s, e, n, h0 - 200, h0 + 200] },
      geometricError: 0,
      refine: 'ADD',
      content: { uri: kind === 'gebaeude' ? 'gebaeude.b3dm' : 'baeume.pnts' },
    },
  };
}

module.exports = { tileset, buildings, trees, enuToEcef, ecef, b3dm, glb, pnts };
