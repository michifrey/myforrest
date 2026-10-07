'use strict';

/*
 * MyForrest service worker.
 *
 * - App shell (HTML, CSS, JS, Leaflet, fonts, icons) is precached so the app
 *   opens without a connection. App code is served network-first, so a new
 *   deployment is visible right away when online.
 * - Photos under /uploads are immutable (UUID file names): cache-first.
 * - API GETs: network-first with the last answer as offline fallback.
 * - OpenStreetMap tiles: cache-first with an entry limit.
 * - Background Sync sends uploads queued while offline (see offline-queue.js).
 *
 * Bump SHELL_VERSION when the precache list changes; bump DATA_VERSION only to
 * throw away cached photos, API answers and tiles. Old caches are deleted on activate.
 */

importScripts('offline-queue.js');

const SHELL_VERSION = 'v3';
const DATA_VERSION = 'v1';
const CACHE = {
  shell: `myforrest-shell-${SHELL_VERSION}`,
  vendor: `myforrest-vendor-${SHELL_VERSION}`,
  api: `myforrest-api-${DATA_VERSION}`,
  uploads: `myforrest-uploads-${DATA_VERSION}`,
  tiles: `myforrest-tiles-${DATA_VERSION}`,
};
const LIMIT = { api: 200, uploads: 400, tiles: 800 };
const API_TIMEOUT_MS = 6000;
const TILE_HOST = /(^|\.)tile\.openstreetmap\.org$/;
// API answers the app needs to start; fetched once on activation because the
// very first page load happens before the worker controls the page.
const WARM_API = ['api/config', 'api/trees', 'api/spots'];

// Paths relative to the service worker's scope.
const PRECACHE = [
  './',
  'style.css',
  'app.js',
  'forest.js',
  'sun.js',
  'sunmap.js',
  'hotspots.js',
  'video.js',
  'video.css',
  'vegetation.js',
  'offline-queue.js',
  'pwa.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/marker-icon.png',
  'vendor/leaflet/images/marker-icon-2x.png',
  'vendor/leaflet/images/marker-shadow.png',
  'vendor/leaflet/images/layers.png',
  'vendor/leaflet/images/layers-2x.png',
  'vendor/fonts/fraunces/full.css',
  'vendor/fonts/fraunces/full-italic.css',
  'vendor/fonts/manrope/index.css',
  // Latin subsets cover German; other subsets are cached when first used.
  'vendor/fonts/fraunces/files/fraunces-latin-full-normal.woff2',
  'vendor/fonts/fraunces/files/fraunces-latin-ext-full-normal.woff2',
  'vendor/fonts/fraunces/files/fraunces-latin-full-italic.woff2',
  'vendor/fonts/fraunces/files/fraunces-latin-ext-full-italic.woff2',
  'vendor/fonts/manrope/files/manrope-latin-wght-normal.woff2',
  'vendor/fonts/manrope/files/manrope-latin-ext-wght-normal.woff2',
];

const scopeUrl = () => new URL(self.registration ? self.registration.scope : './', self.location.href);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(CACHE.shell);
    // `reload` bypasses the HTTP cache so a new worker never precaches stale files.
    await shell.addAll(PRECACHE.map((p) => new Request(new URL(p, scopeUrl()), { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set(Object.values(CACHE));
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.startsWith('myforrest-') && !keep.has(n)).map((n) => caches.delete(n)));
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable().catch(() => {});
    const api = await caches.open(CACHE.api);
    await Promise.all(WARM_API.map(async (p) => {
      const url = new URL(p, scopeUrl());
      if (await api.match(url)) return;
      const res = await fetch(url).catch(() => null);
      if (res?.ok) await api.put(url, res);
    }));
    await self.clients.claim();
  })());
});

/* ---------- Strategies ---------- */

async function trim(cache, max) {
  const keys = await cache.keys();
  // Cache keys come back in insertion order: drop the oldest entries.
  await Promise.all(keys.slice(0, Math.max(0, keys.length - max)).map((k) => cache.delete(k)));
}

async function store(cacheName, request, response, max) {
  const cache = await caches.open(cacheName);
  await cache.put(request, response);
  if (max) await trim(cache, max);
}

const timeout = (ms) => new Promise((resolve) => setTimeout(() => resolve('timeout'), ms));

function offlineResponse(request) {
  const url = new URL(request.url);
  if (url.pathname.startsWith(new URL('api/', scopeUrl()).pathname)) {
    return new Response(JSON.stringify({ error: 'Offline – diese Daten sind noch nicht auf dem Gerät gespeichert' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
  return Response.error();
}

/**
 * Network first; a copy of each good answer goes into `cacheName`. Falls back
 * to any cached copy when the network fails, or after `timeoutMs` if a cached
 * copy exists (the network answer still refreshes the cache).
 */
async function networkFirst(event, cacheName, { max, timeoutMs, fallback } = {}) {
  const { request } = event;
  const network = (async () => {
    const preload = event.preloadResponse ? await event.preloadResponse.catch(() => null) : null;
    const res = preload || await fetch(request);
    if (res.ok && res.type === 'basic') event.waitUntil(store(cacheName, request, res.clone(), max).catch(() => {}));
    return res;
  })();
  const fromCache = async () => (await caches.match(request)) || (fallback && await caches.match(fallback));
  try {
    if (timeoutMs) {
      const first = await Promise.race([network, timeout(timeoutMs)]);
      if (first !== 'timeout') return first;
      const cached = await fromCache();
      if (cached) {
        event.waitUntil(network.catch(() => {}));
        return cached;
      }
    }
    return await network;
  } catch {
    return (await fromCache()) || offlineResponse(request);
  }
}

/** Cache first; misses are fetched and stored. */
async function cacheFirst(event, cacheName, { max, cors = false } = {}) {
  const { request } = event;
  const cached = await caches.match(request.url);
  if (cached) return cached;
  try {
    // Map tiles are requested without CORS by <img>; asking with CORS gives a
    // readable response that can be cached without the huge opaque-quota cost.
    const res = cors ? await fetch(request.url, { mode: 'cors', credentials: 'omit' }) : await fetch(request);
    if (res.ok) event.waitUntil(store(cacheName, request.url, res.clone(), max).catch(() => {}));
    return res;
  } catch {
    if (cors) return fetch(request).catch(() => Response.error());
    return Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Uploads, edits and deletes always go to the network; the page queues failed uploads.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin !== self.location.origin) {
    if (TILE_HOST.test(url.hostname)) event.respondWith(cacheFirst(event, CACHE.tiles, { max: LIMIT.tiles, cors: true }));
    return;
  }

  const scopePath = scopeUrl().pathname;
  if (!url.pathname.startsWith(scopePath)) return;
  const path = url.pathname.slice(scopePath.length);

  if (path === 'sw.js') return;
  if (path.startsWith('api/')) {
    event.respondWith(networkFirst(event, CACHE.api, { max: LIMIT.api, timeoutMs: API_TIMEOUT_MS }));
  } else if (path.startsWith('uploads/')) {
    event.respondWith(cacheFirst(event, CACHE.uploads, { max: LIMIT.uploads }));
  } else if (path.startsWith('vendor/') || path.startsWith('icons/')) {
    event.respondWith(cacheFirst(event, CACHE.vendor));
  } else if (request.mode === 'navigate') {
    // Any page in scope falls back to the cached start page.
    event.respondWith(networkFirst(event, CACHE.shell, { fallback: new URL('./', scopeUrl()).href }));
  } else {
    event.respondWith(networkFirst(event, CACHE.shell));
  }
});

/* ---------- Offline uploads ---------- */

self.addEventListener('sync', (event) => {
  if (event.tag !== self.offlineQueue.SYNC_TAG) return;
  event.waitUntil((async () => {
    const summary = await self.offlineQueue.flush();
    // Rejecting makes the browser retry the sync later with back-off.
    if (summary.offline && !event.lastChance) throw new Error('Noch offline');
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'myforrest-flush') event.waitUntil(self.offlineQueue.flush());
});
