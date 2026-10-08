'use strict';

/*
 * Offline maps for a planned route: the map tiles of a corridor around the
 * route (zoom 12–16) and the spots along it (details, previews and the
 * reference photos for the camera overlay) are put into a cache of their own,
 * `myforrest-offline-<id>`. The service worker answers from every cache, so
 * the route works without a connection; these caches are never trimmed and
 * survive updates of the service worker (sw.js). Each cache holds a small
 * description of itself (`offline-meta.json`), so the list of saved routes
 * needs no other storage.
 *
 * Global `offlineMap`: plan(points), save(name, points, spots, onProgress), list(), remove(id).
 */
(function offlineMapModule(root) {
  const PREFIX = 'myforrest-offline-';
  const META = 'offline-meta.json';
  const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const ZOOMS = [12, 13, 14, 15, 16]; // OpenStreetMap asks not to prefetch zoom 17 and above
  const CORRIDOR_M = 300; // tiles within this distance of the route
  const MAX_TILES = 1500;
  const SPOT_DISTANCE_M = 150; // spots this close to the route are taken along
  const LARGE_PER_SPOT = 4; // reference photos per spot (the latest ones)
  const PARALLEL = 4;

  const supported = () => Boolean(root.caches && root.fetch);
  const toRad = (d) => (d * Math.PI) / 180;
  const tileX = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
  const tileY = (lat, z) => {
    const r = toRad(lat);
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
  };
  const metres = (a, b) => {
    const x = toRad(b.lon - a.lon) * Math.cos(toRad((a.lat + b.lat) / 2));
    const y = toRad(b.lat - a.lat);
    return Math.hypot(x, y) * 6371000;
  };

  /** Points along the route at most `step` metres apart. */
  function densify(points, step) {
    const out = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      out.push(a);
      const b = points[i + 1];
      if (!b) break;
      const n = Math.floor(metres(a, b) / step);
      for (let k = 1; k <= n; k++) out.push({ lat: a.lat + ((b.lat - a.lat) * k) / (n + 1), lon: a.lon + ((b.lon - a.lon) * k) / (n + 1) });
    }
    return out;
  }

  /** Tiles of the corridor per zoom: Map z → Set "x/y". */
  function corridorTiles(points, corridorM = CORRIDOR_M) {
    const dense = densify(points, corridorM / 2);
    const byZoom = new Map(ZOOMS.map((z) => [z, new Set()]));
    for (const p of dense) {
      const dLat = corridorM / 111320;
      const dLon = corridorM / (111320 * Math.cos(toRad(p.lat)));
      for (const z of ZOOMS) {
        const set = byZoom.get(z);
        for (let x = tileX(p.lon - dLon, z); x <= tileX(p.lon + dLon, z); x++) {
          for (let y = tileY(p.lat + dLat, z); y <= tileY(p.lat - dLat, z); y++) set.add(`${x}/${y}`);
        }
      }
    }
    return byZoom;
  }

  /**
   * What saving the route would take: tiles up to the deepest zoom that keeps
   * the total within MAX_TILES ({ tiles: ["z/x/y"], maxZoom, tooLong }).
   */
  function plan(points) {
    const byZoom = corridorTiles(points);
    const tiles = [];
    let maxZoom = null;
    for (const z of ZOOMS) {
      const add = [...byZoom.get(z)].map((xy) => `${z}/${xy}`);
      if (tiles.length + add.length > MAX_TILES) break;
      tiles.push(...add);
      maxZoom = z;
    }
    return { tiles, maxZoom, tooLong: maxZoom === null || maxZoom < 14 };
  }

  /** Spots near the route (from the loaded spot list): [{ id, distanceM }]. */
  function spotsNear(points, spots) {
    const dense = densify(points, 20);
    return spots.map((s) => ({ id: s.id, distanceM: Math.min(...dense.map((p) => metres(p, s))) }))
      .filter((s) => s.distanceM <= SPOT_DISTANCE_M);
  }

  async function putAll(cache, urls, onProgress, done = { n: 0, bytes: 0, failed: 0, total: urls.length }) {
    let next = 0;
    const worker = async () => {
      while (next < urls.length) {
        const url = urls[next++];
        try {
          const cross = new URL(url, location.href).origin !== location.origin;
          const res = await fetch(url, cross ? { mode: 'cors', credentials: 'omit' } : { credentials: 'same-origin' });
          // Protected finds are sent with no-store: never kept on the device.
          if (res.ok && !/no-store/i.test(res.headers.get('Cache-Control') || '')) {
            const blob = await res.clone().blob();
            done.bytes += blob.size;
            await cache.put(url, res);
          } else done.failed++;
        } catch {
          done.failed++;
        }
        done.n++;
        onProgress?.(done);
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    return done;
  }

  /**
   * Saves the map and spots along `points` ([{ lat, lon }]) for offline use.
   * `spots` is the loaded spot list ({ id, lat, lon }). Resolves to the
   * description of the saved route.
   */
  async function save(name, points, spots, onProgress) {
    if (!supported()) throw new Error('Dieser Browser kann keine Karten offline speichern');
    const p = plan(points);
    if (!p.tiles.length) throw new Error('Route zu kurz');
    // Ask the browser to keep the data even when storage runs low.
    await root.navigator?.storage?.persist?.().catch(() => false);
    const id = `${Date.now().toString(36)}`;
    const cache = await caches.open(PREFIX + id);
    const near = spotsNear(points, spots);
    const progress = { n: 0, bytes: 0, failed: 0, total: p.tiles.length + near.length };
    // Spot details first: they say which photos to take along.
    const details = [];
    for (const s of near) {
      const url = `api/spots/${s.id}`;
      try {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (res.ok && !/no-store/i.test(res.headers.get('Cache-Control') || '')) {
          details.push(await res.clone().json());
          await cache.put(url, res);
        }
      } catch {
        progress.failed++;
      }
      progress.n++;
      onProgress?.(progress);
    }
    const photoUrls = details.flatMap((d) => [
      ...d.photos.map((ph) => ph.thumbUrl || ph.url),
      ...d.photos.slice(-LARGE_PER_SPOT).map((ph) => ph.largeUrl || ph.url),
    ]);
    const tileUrls = p.tiles.map((t) => { const [z, x, y] = t.split('/'); return TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y); });
    progress.total += photoUrls.length;
    await putAll(cache, [...new Set(['api/spots', ...photoUrls]), ...tileUrls], onProgress, progress);
    const lats = points.map((q) => q.lat);
    const lons = points.map((q) => q.lon);
    const meta = {
      id,
      name: name || 'Route',
      savedAt: new Date().toISOString(),
      tiles: p.tiles.length,
      maxZoom: p.maxZoom,
      spots: details.length,
      photos: photoUrls.length,
      bytes: progress.bytes,
      failed: progress.failed,
      bounds: [[Math.min(...lats), Math.min(...lons)], [Math.max(...lats), Math.max(...lons)]],
    };
    await cache.put(META, new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
    return meta;
  }

  /** The saved routes on this device, newest first. */
  async function list() {
    if (!supported()) return [];
    const names = (await caches.keys()).filter((n) => n.startsWith(PREFIX));
    const metas = await Promise.all(names.map(async (n) => {
      const res = await (await caches.open(n)).match(META);
      return res ? res.json().catch(() => null) : null;
    }));
    return metas.filter(Boolean).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  const remove = (id) => caches.delete(PREFIX + id);

  root.offlineMap = { supported, plan, spotsNear, save, list, remove, PREFIX, MAX_TILES };
}(typeof self !== 'undefined' ? self : this));
