#!/usr/bin/env node
'use strict';

/**
 * Writes the open data as a static STAC catalog into a folder, ready to copy
 * to an object storage (S3, R2, Azure Blob, a plain web server) and to
 * register with Portolan or a STAC browser, without the app running:
 *
 *   catalog.json
 *   myforrest/collection.json, myforrest.gpkg (LV95), myforrest.pmtiles
 *   myforrest/<collection>/<collection>.json (STAC item), .parquet (WGS84),
 *     -lv95.parquet, .geojson
 *
 *   node scripts/export-stac.js <folder> [base URL]
 *
 * The base URL ends up in the data (photo links); default PUBLIC_URL, else
 * http://localhost:3000. DATA_DIR as for the server. The vector tiles are
 * computed first if they are not current (as scripts/build-tiles.js).
 */

const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/app');
const { COLLECTIONS } = require('../src/geodata');
const { writeGeoParquet } = require('../src/parquet');
const { writeGeoPackage } = require('../src/gpkg');

(async () => {
  const out = process.argv[2];
  if (!out) {
    console.error('Aufruf: node scripts/export-stac.js <Ordner> [Basis-URL]');
    process.exit(2);
  }
  const base = String(process.argv[3] || process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
  const app = createApp({ dataDir: process.env.DATA_DIR || undefined, tileOptions: { precompute: true, delayMs: null } });
  const { documents, layerOf } = app.locals.openData;

  await app.locals.ogcTiles.precompute(base);
  const pmtiles = path.join(dataDir, 'tiles', 'myforrest.pmtiles');

  const written = [];
  const target = (file) => {
    const f = path.join(out, file);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    written.push(file);
    return f;
  };
  // Every data file the catalog lists is written here; the catalog leaves out what is missing.
  const docs = documents(base, (file) => {
    const name = path.posix.basename(file);
    const m = name.match(/^(\w+?)(-lv95)?\.(parquet|geojson)$/);
    if (m && COLLECTIONS[m[1]]) {
      if (m[3] === 'parquet') {
        const srs = m[2] ? 2056 : 4326;
        writeGeoParquet(target(file), layerOf(m[1], base, srs), { srsId: srs });
      } else {
        fs.writeFileSync(target(file), JSON.stringify({ type: 'FeatureCollection', features: layerOf(m[1], base, 4326).features }));
      }
      return file;
    }
    if (name === 'myforrest.gpkg') {
      writeGeoPackage(target(file), Object.keys(COLLECTIONS).map((id) => layerOf(id, base, 2056)), { srsId: 2056 });
      return file;
    }
    if (name === 'myforrest.pmtiles' && fs.existsSync(pmtiles)) {
      fs.copyFileSync(pmtiles, target(file));
      return file;
    }
    return null;
  });
  for (const [file, doc] of Object.entries(docs)) fs.writeFileSync(target(file), `${JSON.stringify(doc, null, 2)}\n`);

  for (const file of written) console.log(`${file.padEnd(48)} ${(fs.statSync(path.join(out, file)).size / 1024).toFixed(1).padStart(9)} KiB`);
  console.log(`STAC-Katalog in ${path.join(out, 'catalog.json')}`);
  await app.locals.idle();
  app.locals.ogcTiles.close();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
