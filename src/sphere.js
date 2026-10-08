'use strict';

/*
 * Geometry of 360° panoramas (equirectangular images).
 *
 * Two panoramas taken at the same place differ by a rotation of the camera
 * (where it pointed, how it was tilted), not by a homography: every pixel is
 * a direction on the sphere, and the whole sphere turns. Alignment therefore
 * fits a 3-D rotation to matched features (RANSAC around Horn's closed-form
 * solution), and comparing two panoramas resamples one through the rotation,
 * wrapping around the seam.
 *
 * Coordinates: u = x / width (0…1, centre = 0.5 = straight ahead), v = y /
 * height (0 = up). Direction vectors: x right, y up, z forward. Rotations
 * are row-major 3×3 arrays like the homographies.
 */

const IDENTITY = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1]);
const TAU = 2 * Math.PI;

/** Unit vector of an equirectangular point (u, v). */
function toVector(u, v) {
  const lon = (u - 0.5) * TAU;
  const lat = (0.5 - v) * Math.PI;
  const c = Math.cos(lat);
  return [c * Math.sin(lon), Math.sin(lat), c * Math.cos(lon)];
}

/** Equirectangular point (u in [0, 1), v in [0, 1]) of a direction. */
function toUV([x, y, z]) {
  const lon = Math.atan2(x, z);
  const lat = Math.asin(Math.max(-1, Math.min(1, y / (Math.hypot(x, y, z) || 1))));
  let u = lon / TAU + 0.5;
  u -= Math.floor(u);
  return [u, 0.5 - lat / Math.PI];
}

const rotate = (r, [x, y, z]) => [r[0] * x + r[1] * y + r[2] * z, r[3] * x + r[4] * y + r[5] * z, r[6] * x + r[7] * y + r[8] * z];

function multiply(a, b) {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  }
  return r;
}

/** The inverse of a rotation is its transpose. */
const transpose = (m) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));

/** Rotation for yaw (turn right, °), pitch (tilt up, °) and roll (°), applied roll → pitch → yaw. */
function fromAngles(yawDeg, pitchDeg = 0, rollDeg = 0) {
  const [y, p, r] = [yawDeg, pitchDeg, rollDeg].map((d) => (d * Math.PI) / 180);
  const Ry = [Math.cos(y), 0, Math.sin(y), 0, 1, 0, -Math.sin(y), 0, Math.cos(y)];
  const Rp = [1, 0, 0, 0, Math.cos(p), Math.sin(p), 0, -Math.sin(p), Math.cos(p)];
  const Rr = [Math.cos(r), -Math.sin(r), 0, Math.sin(r), Math.cos(r), 0, 0, 0, 1];
  return multiply(Ry, multiply(Rp, Rr));
}

/** Yaw (° clockwise, where "straight ahead" turns to) and tilt (° of the up axis) of a rotation. */
function describe(r) {
  const f = rotate(r, [0, 0, 1]);
  const up = rotate(r, [0, 1, 0]);
  const yaw = ((Math.atan2(f[0], f[2]) * 180) / Math.PI + 360) % 360;
  return { yaw: Math.round(yaw * 10) / 10, tilt: Math.round((angle(up, [0, 1, 0]) * 180 / Math.PI) * 10) / 10 };
}

/** Largest eigenvector of a symmetric 4×4 matrix (Jacobi rotations). */
function topEigenvector(N) {
  const a = N.map((row) => [...row]);
  const v = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += a[p][q] ** 2;
    if (off < 1e-20) break;
    for (let p = 0; p < 4; p++) {
      for (let q = p + 1; q < 4; q++) {
        if (Math.abs(a[p][q]) < 1e-30) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 4; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 4; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 4; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i < 4; i++) if (a[i][i] > a[best][best]) best = i;
  return [v[0][best], v[1][best], v[2][best], v[3][best]];
}

/**
 * The rotation R that best maps vectors `from[i]` onto `to[i]` (least
 * squares; Horn 1987, unit quaternions). Needs at least two non-parallel pairs.
 */
function fitRotation(from, to) {
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < from.length; i++) {
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r][c] += from[i][r] * to[i][c];
  }
  const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = S;
  const N = [
    [xx + yy + zz, yz - zy, zx - xz, xy - yx],
    [yz - zy, xx - yy - zz, xy + yx, zx + xz],
    [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
    [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
  ];
  const [w, x, y, z] = topEigenvector(N);
  return [
    w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), w * w - x * x - y * y + z * z,
  ];
}

/**
 * RANSAC over matched directions [[from, to]]: rotations from random triples,
 * scored by the pairs within `thresholdRad`, refitted on the inliers.
 * Returns { R, inliers } or null.
 */
function ransacRotation(pairs, thresholdRad, rnd, iterations = 400) {
  if (pairs.length < 3) return null;
  const inliersOf = (R) => pairs.filter(([a, b]) => angle(rotate(R, a), b) < thresholdRad);
  let best = null;
  for (let it = 0; it < iterations; it++) {
    const idx = new Set();
    while (idx.size < 3) idx.add(Math.floor(rnd() * pairs.length));
    const sample = [...idx].map((i) => pairs[i]);
    // Nearly identical directions do not pin down a rotation.
    if (angle(sample[0][0], sample[1][0]) < 0.05 || angle(sample[0][0], sample[2][0]) < 0.05) continue;
    const R = fitRotation(sample.map((p) => p[0]), sample.map((p) => p[1]));
    const inl = inliersOf(R);
    if (!best || inl.length > best.length) best = inl;
  }
  if (!best || best.length < 3) return null;
  let R = fitRotation(best.map((p) => p[0]), best.map((p) => p[1]));
  const final = inliersOf(R);
  if (final.length >= best.length) R = fitRotation(final.map((p) => p[0]), final.map((p) => p[1]));
  return { R, inliers: Math.max(final.length, best.length) };
}

/**
 * Resamples panorama `src` ({ data, width, height }, RGB bytes) into a
 * `width` × `height` view in which direction d shows what `src` sees at
 * `rAtoSrc` · d. Bilinear, wrapping around the seam. Returns RGB bytes.
 */
function remap(src, rAtoSrc, width, height) {
  const out = Buffer.alloc(width * height * 3);
  const { data, width: sw, height: sh } = src;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [u, v] = toUV(rotate(rAtoSrc, toVector((x + 0.5) / width, (y + 0.5) / height)));
      let sx = u * sw - 0.5;
      const sy = Math.max(0, Math.min(sh - 1, v * sh - 0.5));
      if (sx < 0) sx += sw;
      const x0 = Math.floor(sx) % sw;
      const x1 = (x0 + 1) % sw;
      const y0 = Math.floor(sy);
      const y1 = Math.min(sh - 1, y0 + 1);
      const fx = sx - Math.floor(sx);
      const fy = sy - y0;
      const o = (y * width + x) * 3;
      for (let c = 0; c < 3; c++) {
        const p00 = data[(y0 * sw + x0) * 3 + c];
        const p10 = data[(y0 * sw + x1) * 3 + c];
        const p01 = data[(y1 * sw + x0) * 3 + c];
        const p11 = data[(y1 * sw + x1) * 3 + c];
        out[o + c] = Math.round((p00 * (1 - fx) + p10 * fx) * (1 - fy) + (p01 * (1 - fx) + p11 * fx) * fy);
      }
    }
  }
  return out;
}

module.exports = { IDENTITY, toVector, toUV, rotate, multiply, transpose, angle, fromAngles, describe, fitRotation, ransacRotation, remap };
