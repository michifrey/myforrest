'use strict';

/*
 * 3×3 homographies as flat row-major arrays [h00 h01 h02 h10 h11 h12 h20 h21 h22].
 * Photos are aligned in normalised image coordinates (u = x / width,
 * v = y / height), so transforms are independent of image resolution.
 */

const IDENTITY = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1]);

function multiply(a, b) {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
  }
  return normalize(r);
}

function invert(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!det) return null;
  return normalize([
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ]);
}

function normalize(m) {
  const s = m[8];
  return Math.abs(s) > 1e-12 ? m.map((v) => v / s) : m;
}

function apply(m, x, y) {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

module.exports = { IDENTITY, multiply, invert, apply, normalize };
