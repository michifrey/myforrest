'use strict';

/**
 * Cloud-native open data: every collection as GeoParquet (WGS84 or LV95)
 * and as one GeoJSON file, listed in a STAC catalog under /stac (src/stac.js)
 * that registries such as Portolan or a STAC browser read. The same catalog
 * can be written as a folder of static files for an object storage
 * (`documents` with relative asset paths, scripts/export-stac.js).
 */

const { COLLECTIONS } = require('../geodata');
const { geoParquet } = require('../parquet');
const { stacDocuments, absolutize, CATALOG } = require('../stac');
const { LICENSES, DEFAULT_LICENSE } = require('../moderation');

const TITLE = 'MyForrest – Wald im Wandel';
const DESCRIPTION = 'Wiederholungsfotos von Wald, Gletschern und Landschaften: Spots, Fotos, Pflanzenfunde und '
  + 'Ausbreitungsfronten von Neophyten, gesammelt beim Joggen, Wandern und Biken.';
const SPDX = { 'cc-by-sa-4.0': 'CC-BY-SA-4.0', 'cc-by-4.0': 'CC-BY-4.0', 'cc0-1.0': 'CC0-1.0', 'cc-by-nc-sa-4.0': 'CC-BY-NC-SA-4.0' };

module.exports = function registerStac(app, { geodata, baseUrl, layerOf, collectionJson, metadata = {} }) {
  const srsOf = (crs) => (crs === undefined || crs === '4326' ? 4326 : crs === '2056' ? 2056 : null);

  /** All catalog documents for `base`; `asset(file)` maps the data files (see src/stac.js) to hrefs. */
  function documents(base, asset) {
    const license = LICENSES[DEFAULT_LICENSE];
    return stacDocuments({
      title: TITLE,
      description: DESCRIPTION,
      provider: { name: metadata.organisation || 'MyForrest', url: metadata.url || base },
      license: { spdx: SPDX[DEFAULT_LICENSE] || 'other', url: license.url && license.url.replace(/deed\.\w+$/, ''), label: license.label },
      collections: Object.fromEntries(Object.keys(COLLECTIONS).map((id) => {
        const c = collectionJson(id, base);
        return [id, {
          title: c.title,
          description: c.description,
          fields: COLLECTIONS[id].fields,
          bbox: c.extent.spatial.bbox[0],
          interval: c.extent.temporal.interval[0],
          count: geodata.features(id, base).length,
        }];
      })),
      asset,
    });
  }

  /** Data files of the catalog as they are served by the app. */
  const served = (base) => (file) => {
    const name = file.split('/').pop();
    const m = name.match(/^(\w+?)(-lv95)?\.(parquet|geojson)$/);
    if (m && COLLECTIONS[m[1]]) {
      return m[3] === 'geojson' ? `${base}/api/export/geojson/${m[1]}.geojson` : `${base}/api/export/parquet/${m[1]}.parquet${m[2] ? '?crs=2056' : ''}`;
    }
    return { 'myforrest.gpkg': `${base}/api/export/myforrest.gpkg`, 'myforrest.pmtiles': `${base}/api/export/myforrest.pmtiles`, 'geocat.xml': `${base}/api/metadata/geocat.xml` }[name] ?? null;
  };

  const cors = (req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); next(); };
  app.use(['/stac', '/api/export/parquet', '/api/export/geojson'], cors);

  app.get('/api/export/parquet/:id.parquet', (req, res) => {
    const { id } = req.params;
    if (!COLLECTIONS[id]) return res.status(404).json({ error: 'Collection nicht gefunden' });
    const srs = srsOf(req.query.crs);
    if (!srs) return res.status(400).json({ error: 'crs: 4326 (WGS84) oder 2056 (LV95)' });
    const file = geoParquet(layerOf(id, baseUrl(req), srs), { srsId: srs });
    const day = new Date().toISOString().slice(0, 10);
    res.set('Content-Disposition', `attachment; filename="myforrest-${id}${srs === 2056 ? '-lv95' : ''}-${day}.parquet"`);
    res.set('Cache-Control', 'public, max-age=300');
    return res.type('application/vnd.apache.parquet').send(file);
  });

  app.get('/api/export/geojson/:id.geojson', (req, res) => {
    const { id } = req.params;
    if (!COLLECTIONS[id]) return res.status(404).json({ error: 'Collection nicht gefunden' });
    res.set('Cache-Control', 'public, max-age=300');
    return res.type('application/geo+json').send(JSON.stringify({ type: 'FeatureCollection', features: geodata.features(id, baseUrl(req)) }));
  });

  // catalog.json, myforrest/collection.json and myforrest/<id>/<id>.json, with absolute links.
  app.get(['/stac', '/stac/'], (req, res) => res.redirect(`${baseUrl(req)}/stac/${CATALOG}`));
  app.get('/stac/*', (req, res) => {
    const base = baseUrl(req);
    const file = req.params[0];
    const docs = documents(base, served(base));
    if (!docs[file]) return res.status(404).json({ error: 'Nicht im Katalog' });
    return res.type(file === CATALOG || file.endsWith('collection.json') ? 'application/json' : 'application/geo+json')
      .send(JSON.stringify(absolutize(docs[file], `${base}/stac/${file}`)));
  });

  return { documents, layerOf };
};
