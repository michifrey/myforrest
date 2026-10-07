'use strict';

// Installable app (manifest, service worker, offline queue): the parts that
// can be checked without a browser. The real offline round trip is verified
// in headless Chromium (see docs/funktionen.md, «Installierbare App mit Offline-Upload»).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const sharp = require('sharp');
const { createApp } = require('../src/app');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');

async function withServer(fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-pwa-'));
  const app = createApp({ dataDir, weatherFetch: async () => new Response('offline', { status: 503 }) });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}/`);
  } finally {
    await app.locals.idle?.();
    server.close();
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

/** Runs sw.js in a sandbox and returns its top-level PRECACHE and CACHE constants. */
function loadServiceWorker() {
  const listeners = {};
  const self = {
    location: new URL('http://localhost/sw.js'),
    registration: { scope: 'http://localhost/' },
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  const ctx = vm.createContext({ self, URL, console, importScripts: () => { self.offlineQueue = { SYNC_TAG: 'x' }; } });
  vm.runInContext(read('sw.js'), ctx, { filename: 'sw.js' });
  return { precache: vm.runInContext('PRECACHE', ctx), caches: vm.runInContext('CACHE', ctx), listeners };
}

test('web app manifest is valid, German and has the required icons', async () => {
  const manifest = JSON.parse(read('manifest.webmanifest'));
  assert.equal(manifest.lang, 'de');
  assert.match(manifest.name, /MyForrest/);
  assert.ok(manifest.short_name.length <= 12, 'short_name fits under a home-screen icon');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.start_url && manifest.scope);
  for (const key of ['theme_color', 'background_color']) assert.match(manifest[key], /^#[0-9a-f]{6}$/i);
  // Theme colour matches the meta tag and the forest design tokens.
  const html = read('index.html');
  assert.ok(html.includes(`<meta name="theme-color" content="${manifest.theme_color}">`));
  assert.ok(read('style.css').includes(`--bg: ${manifest.background_color};`));

  const want = new Set(['any:192', 'any:512', 'maskable:192', 'maskable:512']);
  for (const icon of manifest.icons) {
    const meta = await sharp(path.join(PUBLIC, icon.src)).metadata();
    assert.equal(meta.format, 'png');
    assert.equal(`${meta.width}x${meta.height}`, icon.sizes, icon.src);
    want.delete(`${icon.purpose}:${meta.width}`);
  }
  assert.deepEqual([...want], [], 'icons 192/512 for any and maskable');
});

test('index.html links the manifest and loads the PWA scripts after app.js', () => {
  const html = read('index.html');
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.match(html, /<link rel="apple-touch-icon" href="icons\/apple-touch-icon\.png">/);
  assert.match(html, /id="pwa-status"/);
  const pos = (s) => html.indexOf(`<script src="${s}"></script>`);
  assert.ok(pos('app.js') > 0 && pos('offline-queue.js') > pos('app.js') && pos('pwa.js') > pos('offline-queue.js'));
});

test('service worker is served uncached with scope header, manifest with its MIME type', async () => {
  await withServer(async (base) => {
    let res = await fetch(new URL('sw.js', base));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
    assert.equal(res.headers.get('service-worker-allowed'), '/');
    res = await fetch(new URL('manifest.webmanifest', base));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/manifest\+json/);
  });
});

test('every precached URL exists on the server', async () => {
  const { precache } = loadServiceWorker();
  assert.ok(precache.includes('./') && precache.includes('app.js') && precache.includes('offline-queue.js'));
  // Every local script and stylesheet of the page is precached.
  const html = read('index.html');
  for (const [, src] of html.matchAll(/<(?:script src|link rel="stylesheet" href)="([^"]+)"/g)) {
    assert.ok(precache.includes(src), `${src} is precached`);
  }
  await withServer(async (base) => {
    for (const p of precache) {
      const res = await fetch(new URL(p, base));
      assert.equal(res.status, 200, `${p} → ${res.status}`);
      await res.arrayBuffer();
    }
  });
});

test('service worker uses versioned cache names and handles fetch, sync and cleanup', () => {
  const { caches, listeners } = loadServiceWorker();
  const names = Object.values(caches);
  assert.ok(names.length >= 4);
  for (const n of names) assert.match(n, /^myforrest-[a-z]+-v\d+$/);
  assert.equal(new Set(names).size, names.length);
  for (const type of ['install', 'activate', 'fetch', 'sync']) assert.equal(typeof listeners[type], 'function', type);
});

test('offline queue: FormData survives serialisation, network errors are queued, HTTP errors are not', async () => {
  const ctx = vm.createContext({ FormData, Blob, File, URL, console, navigator: { onLine: true } });
  vm.runInContext(read('offline-queue.js'), ctx, { filename: 'offline-queue.js' });
  const q = ctx.offlineQueue;

  const fd = new FormData();
  fd.append('photos', new File([new Uint8Array([1, 2, 3])], 'wald.jpg', { type: 'image/jpeg' }));
  fd.append('note', 'Sturm');
  const entries = q.serialize(fd);
  assert.deepEqual([...entries.map((e) => e.name)], ['photos', 'note']);
  const back = q.deserialize(entries);
  assert.equal(back.get('note'), 'Sturm');
  assert.equal(back.get('photos').name, 'wald.jpg');
  assert.deepEqual([...new Uint8Array(await back.get('photos').arrayBuffer())], [1, 2, 3]);

  // A server answer passes straight through …
  assert.deepEqual((await q.post(fd, async () => ({ created: [1] }))).created, [1]);
  // … an HTTP error is shown to the user, not queued …
  await assert.rejects(q.post(fd, async () => { throw new Error('HTTP 400'); }), /HTTP 400/);
  // … a network error goes to the queue (which needs IndexedDB, absent in Node).
  await assert.rejects(q.post(fd, async () => { throw new TypeError('Failed to fetch'); }), /IndexedDB/);
  ctx.navigator.onLine = false;
  let sent = false;
  await assert.rejects(q.post(fd, async () => { sent = true; }), /IndexedDB/);
  assert.equal(sent, false, 'offline uploads are not even attempted');
});
