'use strict';

// Offline maps along a route (public/offline-map.js) and the service worker's
// handling of them and of background uploads (public/sw.js), in a sandbox.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

/** A Cache Storage in memory: { caches, store } with store: name → Map(url → Response). */
function memoryCaches(base = 'http://localhost/') {
  const store = new Map();
  const key = (r) => new URL(typeof r === 'string' ? r : r.url, base).href;
  const open = async (name) => {
    if (!store.has(name)) store.set(name, new Map());
    const m = store.get(name);
    return {
      put: async (r, res) => { m.set(key(r), res); },
      match: async (r) => m.get(key(r))?.clone(),
      keys: async () => [...m.keys()].map((url) => ({ url })),
      delete: async (r) => m.delete(key(r)),
    };
  };
  const caches = {
    open,
    keys: async () => [...store.keys()],
    delete: async (name) => store.delete(name),
    match: async (r) => {
      for (const m of store.values()) if (m.has(key(r))) return m.get(key(r)).clone();
      return undefined;
    },
  };
  return { caches, store };
}

function loadOfflineMap(globals = {}) {
  const self = { location: new URL('http://localhost/'), ...globals };
  const ctx = vm.createContext({ self, URL, Response, console, Math, location: self.location, ...globals });
  vm.runInContext(read('offline-map.js'), ctx, { filename: 'offline-map.js' });
  return self.offlineMap;
}

// A forest walk of about 3 km near Zurich, west to east.
const route = Array.from({ length: 31 }, (_, i) => ({ lat: 47.36 + Math.sin(i / 5) * 0.002, lon: 8.55 + i * 0.0013 }));

test('the tiles along a route: a corridor at zoom 12–16, capped for long routes', () => {
  const om = loadOfflineMap();
  const plan = om.plan(route);
  assert.equal(plan.maxZoom, 16);
  assert.equal(plan.tooLong, false);
  const zooms = new Set(plan.tiles.map((t) => Number(t.split('/')[0])));
  assert.deepEqual([...zooms], [12, 13, 14, 15, 16]);
  // A 3 km corridor of ±300 m at zoom 16 (≈ 400 m tiles): a few dozen tiles, not a whole region.
  const z16 = plan.tiles.filter((t) => t.startsWith('16/'));
  assert.ok(z16.length > 15 && z16.length < 120, `zoom 16: ${z16.length}`);
  assert.ok(plan.tiles.length <= om.MAX_TILES);
  // Every tile lies within the route's box plus the corridor (one tile of slack).
  const tx = (lon) => Math.floor(((lon + 180) / 360) * 2 ** 16);
  const ty = (lat) => Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** 16);
  const lats = route.map((p) => p.lat);
  const lons = route.map((p) => p.lon);
  for (const t of z16) {
    const [, x, y] = t.split('/').map(Number);
    assert.ok(x >= tx(Math.min(...lons)) - 1 && x <= tx(Math.max(...lons)) + 1, t);
    assert.ok(y >= ty(Math.max(...lats)) - 1 && y <= ty(Math.min(...lats)) + 1, t);
  }
  // A day's ride of 100 km fits to zoom 16; 800 km only to zoom 14; 2000 km is too long.
  const line = (n) => Array.from({ length: n }, (_, i) => ({ lat: 46.5 + i * 0.008, lon: 7 + i * 0.006 }));
  assert.deepEqual([om.plan(line(101)).maxZoom, om.plan(line(801)).maxZoom], [16, 14]);
  const long = line(2001);
  const lp = om.plan(long);
  assert.equal(lp.tooLong, true);
  assert.ok(lp.tiles.length <= om.MAX_TILES);
  // Spots within 150 m of the route come along.
  const spots = [{ id: 1, lat: 47.3605, lon: 8.5513 }, { id: 2, lat: 47.37, lon: 8.56 }, { id: 3, lat: route[20].lat + 0.001, lon: route[20].lon }];
  assert.deepEqual(Array.from(om.spotsNear(route, spots), (s) => s.id), [1, 3]);
});

test('saving a route puts tiles, spots and photos into a cache of its own; protected data stays out', async () => {
  const { caches, store } = memoryCaches();
  const fetched = [];
  const fetch = async (url) => {
    const u = new URL(url, 'http://localhost/');
    fetched.push(u.href);
    if (u.pathname === '/api/spots/1') {
      return new Response(JSON.stringify({ id: 1, photos: [1, 2, 3, 4, 5, 6].map((i) => ({ id: i, url: `/uploads/${i}.jpg`, thumbUrl: `/thumbs/${i}-320.webp`, largeUrl: `/thumbs/${i}-1280.webp` })) }));
    }
    if (u.pathname === '/api/spots/3') return new Response('{}', { headers: { 'Cache-Control': 'private, no-store' } });
    return new Response(`data of ${u.href}`);
  };
  const om = loadOfflineMap({ caches, fetch, navigator: {} });
  const spots = [{ id: 1, lat: 47.3605, lon: 8.5513 }, { id: 3, lat: route[20].lat, lon: route[20].lon }];
  const progress = [];
  const meta = await om.save('Hönggerberg', route, spots, (p) => progress.push(p.n));
  const [name] = [...store.keys()];
  assert.match(name, /^myforrest-offline-/);
  const keys = [...store.get(name).keys()];
  assert.equal(meta.tiles, om.plan(route).tiles.length);
  assert.equal(keys.filter((k) => k.startsWith('https://tile.openstreetmap.org/16/')).length, om.plan(route).tiles.filter((t) => t.startsWith('16/')).length);
  assert.ok(keys.includes('http://localhost/api/spots/1') && keys.includes('http://localhost/api/spots'));
  assert.ok(!keys.includes('http://localhost/api/spots/3'), 'a protected find is not stored');
  // All previews, the latest four large photos for the camera overlay.
  assert.equal(keys.filter((k) => k.includes('-320.webp')).length, 6);
  assert.deepEqual(keys.filter((k) => k.includes('-1280.webp')).map((k) => k.match(/(\d)-1280/)[1]), ['3', '4', '5', '6']);
  assert.deepEqual([meta.name, meta.spots, meta.photos, meta.maxZoom], ['Hönggerberg', 1, 10, 16]);
  assert.ok(meta.bytes > 0 && progress.at(-1) === keys.length - 1 + 1, `progress ${progress.at(-1)} of ${keys.length}`);

  const list = await om.list();
  assert.deepEqual(Array.from(list, (m) => m.name), ['Hönggerberg']);
  await om.remove(list[0].id);
  assert.equal((await om.list()).length, 0);
});

/** sw.js in a sandbox with the parts the tests drive. */
function loadServiceWorker({ caches, permission = 'granted', windows = [], summary } = {}) {
  const listeners = {};
  const shown = [];
  const self = {
    location: new URL('http://localhost/sw.js'),
    registration: {
      scope: 'http://localhost/',
      showNotification: async (title, opts) => { shown.push({ title, ...opts }); },
    },
    clients: { matchAll: async () => windows, claim: async () => {} },
    Notification: { permission },
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  const ctx = vm.createContext({
    self, URL, Response, console, caches, fetch: async () => new Response('{}'), setTimeout,
    importScripts: () => { self.offlineQueue = { SYNC_TAG: 'sync-uploads', flush: async () => summary }; },
  });
  vm.runInContext(read('sw.js'), ctx, { filename: 'sw.js' });
  const fire = async (type, data = {}) => {
    let done;
    listeners[type]({ ...data, waitUntil: (p) => { done = p; } });
    await done;
  };
  return { fire, shown, cacheNames: vm.runInContext('CACHE', ctx) };
}

test('updating the service worker keeps routes saved for offline use', async () => {
  const { caches, store } = memoryCaches();
  for (const n of ['myforrest-shell-v1', 'myforrest-tiles-v0', 'myforrest-offline-k3x9', 'other-app']) await caches.open(n);
  const sw = loadServiceWorker({ caches });
  await sw.fire('activate');
  const names = [...store.keys()];
  assert.ok(names.includes('myforrest-offline-k3x9'));
  assert.ok(names.includes('other-app'));
  assert.ok(!names.includes('myforrest-shell-v1') && !names.includes('myforrest-tiles-v0'));
});

test('a background send says by notification what the server rejected, unless the app is in view', async () => {
  const { caches } = memoryCaches();
  const rejected = { sent: 1, created: [{ id: 9 }], skipped: [], spots: [4], failed: [{ id: 2, photos: ['a.jpg', 'b.jpg'], reason: 'Kein GPS im Foto' }], offline: false };
  let sw = loadServiceWorker({ caches, summary: rejected });
  await sw.fire('sync', { tag: 'sync-uploads' });
  assert.equal(sw.shown.length, 1);
  assert.equal(sw.shown[0].title, 'Upload abgelehnt: 2 Fotos');
  assert.match(sw.shown[0].body, /^Kein GPS im Foto · 1 weiteres Foto hochgeladen\. Tippen zeigt die Warteschlange\.$/);
  assert.equal(sw.shown[0].data.url, 'http://localhost/?queue=1');

  // Everything went through: a short note that opens the first spot.
  sw = loadServiceWorker({ caches, summary: { ...rejected, failed: [], created: [{ id: 9 }, { id: 10 }] } });
  await sw.fire('sync', { tag: 'sync-uploads' });
  assert.deepEqual([sw.shown[0].title, sw.shown[0].data.url], ['2 Fotos hochgeladen', 'http://localhost/?spot=4']);

  // The app is open and visible (it shows a note itself), or notifications are not allowed: nothing.
  sw = loadServiceWorker({ caches, summary: rejected, windows: [{ visibilityState: 'visible' }] });
  await sw.fire('sync', { tag: 'sync-uploads' });
  sw = loadServiceWorker({ caches, summary: rejected, permission: 'default' });
  await sw.fire('sync', { tag: 'sync-uploads' });
  assert.equal(sw.shown.length, 0);
});
