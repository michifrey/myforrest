#!/usr/bin/env node
'use strict';

/**
 * Precomputes all vector tiles and writes the PMTiles/MBTiles exports, e.g.
 * after an import or from a cron job, without waiting for the server to do
 * it in the background. Safe while the server runs (same SQLite files, WAL).
 *
 *   node scripts/build-tiles.js [base URL]
 *
 * The base URL ends up in the tiles (photo links); default PUBLIC_URL, else
 * http://localhost:3000. DATA_DIR as for the server.
 */

const { createApp } = require('../src/app');

(async () => {
  const base = String(process.argv[2] || process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const app = createApp({ dataDir: process.env.DATA_DIR || undefined, tileOptions: { precompute: true, delayMs: null } });
  const started = Date.now();
  const built = await app.locals.ogcTiles.precompute(base);
  if (!built.length) console.log(`Alle Kacheln für ${base} sind aktuell.`);
  for (const b of built) console.log(`${b.tileset.padEnd(32)} ${String(b.tiles).padStart(7)} Kacheln ${(b.bytes / 1024).toFixed(0).padStart(7)} KiB ${b.millis} ms`);
  console.log(`Fertig in ${((Date.now() - started) / 1000).toFixed(1)} s. Exporte: data/tiles/myforrest.pmtiles und .mbtiles`);
  await app.locals.idle();
  app.locals.ogcTiles.close();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
