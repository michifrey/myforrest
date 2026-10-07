'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { alignImages } = require('../src/align');
const { apply, invert, multiply, IDENTITY } = require('../src/homography');
const truth = require('./fixtures/align-truth.json');

const fx = (name) => path.join(__dirname, 'fixtures', name);

/** Ground truth from the fixture generator: B pixel → A pixel. */
function truthMap(x, y) {
  const [a, b, c, d, e, f, g, h] = truth.coeffs;
  const w = g * x + h * y + 1;
  return [(a * x + b * y + c) / w, (d * x + e * y + f) / w];
}

test('homography helpers invert and compose', () => {
  const H = [1.1, 0.02, 0.03, -0.01, 0.95, 0.05, 0.001, -0.002, 1];
  const back = multiply(invert(H), H);
  back.forEach((v, i) => assert.ok(Math.abs(v - IDENTITY[i]) < 1e-9));
  const [x, y] = apply(H, 0.4, 0.6);
  const [u, v] = apply(invert(H), x, y);
  assert.ok(Math.abs(u - 0.4) < 1e-9 && Math.abs(v - 0.6) < 1e-9);
});

test('recovers a perspective warp despite lighting and scene changes', async () => {
  const r = await alignImages(fx('align-b.jpg'), fx('align-a.jpg'));
  assert.ok(r, 'alignment found');
  const [wa, ha] = truth.a;
  const [wb, hb] = truth.b;
  for (const [x, y] of [[0, 0], [wb, 0], [wb, hb], [0, hb], [wb / 2, hb / 2]]) {
    const [tx, ty] = truthMap(x, y);
    const [px, py] = apply(r.h, x / wb, y / hb);
    assert.ok(Math.hypot(px * wa - tx, py * ha - ty) < 2, `corner (${x},${y}) off by more than 2 px`);
  }
});

test('refuses to align unrelated photos', async () => {
  assert.equal(await alignImages(fx('align-other.jpg'), fx('align-a.jpg')), null);
});
