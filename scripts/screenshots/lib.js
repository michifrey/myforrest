'use strict';
const { chromium } = require('playwright');
const tiles = require('./tiles');

const BASE = process.env.BASE || 'http://localhost:3123';
const fs = require('fs');
const path = require('path');

const OUT = process.env.OUT || path.join(__dirname, '..', '..', 'docs', 'screenshots');
const WORK = process.env.DEMO_DIR || path.join(__dirname, '.demo');
const CACHE_DIR = path.join(WORK, 'tiles');
fs.mkdirSync(CACHE_DIR, { recursive: true });
const tileCache = {
  has: (k) => fs.existsSync(path.join(CACHE_DIR, k.replace(/\//g, '_') + '.png')),
  get: (k) => fs.readFileSync(path.join(CACHE_DIR, k.replace(/\//g, '_') + '.png')),
  set: (k, v) => fs.writeFileSync(path.join(CACHE_DIR, k.replace(/\//g, '_') + '.png'), v),
};
const safe = (fn) => async (route) => { try { await fn(route); } catch (e) { console.log('tile error', route.request().url(), e.message); } };

async function routeTiles(ctx) {
  await ctx.route(/tile\.openstreetmap\.org\/(\d+)\/(\d+)\/(\d+)\.png/, safe(async (route) => {
    const [, z, x, y] = route.request().url().match(/\/(\d+)\/(\d+)\/(\d+)\.png/).map(Number);
    const key = `m${z}/${x}/${y}`;
    if (!tileCache.has(key)) tileCache.set(key, await tiles.mercatorTile(z, x, y, 'osm'));
    await route.fulfill({ body: tileCache.get(key), contentType: 'image/png' });
  }));
  await ctx.route(/wmts\.geo\.admin\.ch\/.*\/2056\/(\d+)\/(\d+)\/(\d+)\.jpeg/, safe(async (route) => {
    const [, z, x, y] = route.request().url().match(/\/2056\/(\d+)\/(\d+)\/(\d+)\.jpeg/).map(Number);
    const key = `l${z}/${x}/${y}`;
    if (!tileCache.has(key)) tileCache.set(key, await tiles.lv95Tile(z, x, y, 'grau'));
    await route.fulfill({ body: tileCache.get(key), contentType: 'image/png' });
  }));
}

async function launch(extra = []) {
  return chromium.launch({ env: { ...process.env, LANG: 'de_CH.UTF-8', LANGUAGE: 'de_CH' }, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--lang=de-CH', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', ...extra] });
}

async function desktop(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'de-CH', timezoneId: 'Europe/Zurich', serviceWorkers: 'block', ...opts });
  await routeTiles(ctx);
  return ctx;
}

const settle = (page, ms = 1200) => page.waitForTimeout(ms);

module.exports = { launch, desktop, routeTiles, settle, BASE, OUT, WORK };
