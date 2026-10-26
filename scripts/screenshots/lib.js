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
  // The «Zeitreise» of swisstopo and its aerial images: the placeholder map, sepia for old map editions, black and
  // white for old flights.
  await ctx.route(/ch\.swisstopo\.(zeitreihen|swissimage-product)\/default\/(\d{4,8})\/3857\/(\d+)\/(\d+)\/(\d+)\.(png|jpeg)/, safe(async (route) => {
    const [, layer, time, z, x, y] = route.request().url().match(/ch\.swisstopo\.(zeitreihen|swissimage-product)\/default\/(\d{4,8})\/3857\/(\d+)\/(\d+)\/(\d+)\./);
    const key = `m${z}/${x}/${y}`;
    if (!tileCache.has(key)) tileCache.set(key, await tiles.mercatorTile(Number(z), Number(x), Number(y), 'osm'));
    const year = Number(time.slice(0, 4));
    const sharp = require('sharp');
    let body = tileCache.get(key);
    if (layer === 'zeitreihen' && year < 1990) body = await sharp(body).modulate({ saturation: 0.25 }).tint({ r: 214, g: 190, b: 150 }).png().toBuffer();
    if (layer === 'swissimage-product' && year < 1990) body = await sharp(body).grayscale().linear(1.2, -20).png().toBuffer();
    await route.fulfill({ body, contentType: 'image/png' });
  }));
  // swisstopo in Web Mercator (Landschaft im Wandel): the same placeholder map as OpenStreetMap (not the aerial images
  // above, which are JPEG too).
  await ctx.route(/wmts\.geo\.admin\.ch\/(?!1\.0\.0\/ch\.swisstopo\.swissimage-product\/).*\/3857\/(\d+)\/(\d+)\/(\d+)\.jpeg/, safe(async (route) => {
    const [, z, x, y] = route.request().url().match(/\/3857\/(\d+)\/(\d+)\/(\d+)\.jpeg/).map(Number);
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
  // Elevation tiles for the light and shadow on the map, from the demo terrain.
  await ctx.route(/elevation-tiles-prod\/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/, safe(async (route) => {
    const [, z, x, y] = route.request().url().match(/\/(\d+)\/(\d+)\/(\d+)\.png/).map(Number);
    const key = `t${z}/${x}/${y}`;
    if (!tileCache.has(key)) tileCache.set(key, await tiles.terrariumTile(z, x, y));
    await route.fulfill({ body: tileCache.get(key), contentType: 'image/png', headers: { 'access-control-allow-origin': '*' } });
  }));
  // Pictures of Wikidata items (Special:FilePath on Commons): the drawn demo photos of the demo server.
  await ctx.route(/commons\.wikimedia\.org\/wiki\/Special:FilePath\//, safe(async (route) => {
    const n = /Stieleiche/.test(decodeURIComponent(route.request().url())) ? 5 : 3;
    const res = await fetch(`${BASE}/demo-commons/${n}.jpg`);
    await route.fulfill({ body: Buffer.from(await res.arrayBuffer()), contentType: 'image/jpeg' });
  }));
  // DWD maps: a drawn rain band for the radar, nothing for other layers.
  await ctx.route(/maps\.dwd\.de\/geoserver\/dwd\/wms/, safe(async (route) => {
    const q = new URL(route.request().url()).searchParams;
    const get = (k) => q.get(k) ?? q.get(k.toUpperCase());
    const bbox = get('bbox').split(',').map(Number);
    const w = Number(get('width')); const h = Number(get('height'));
    const body = /radar/i.test(get('layers')) ? await tiles.radarImage(bbox, w, h, get('time')) : await tiles.radarImage([0, 0, 1, 1], w, h, null);
    await route.fulfill({ body, contentType: 'image/png' });
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
