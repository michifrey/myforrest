'use strict';

/*
 * Terrain tiles for the 3D map (public/map3d.js): elevation as RGB PNG in the Terrarium encoding
 * (height = R·256 + G + B/256 − 32768 m), WebMercatorQuad, 256 px. By default from the open
 * "Terrain Tiles" on AWS (Mapzen/Tilezen, SRTM and national models, worldwide); TERRAIN_URL= (empty)
 * turns the 3D map off. The server fetches each tile once and keeps it under data/terrain:
 * the browser of the visitor never talks to the source, and the tiles work for everyone from then on.
 *
 *   GET /api/terrain/{z}/{x}/{y}.png   z 0–15
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const MAX_ZOOM = 15;
const MAX_BYTES = 2 * 1024 * 1024;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function registerTerrain(app, { dataDir, url = DEFAULT_URL, fetchImpl = fetch }) {
  const dir = path.join(dataDir, 'terrain');
  const running = new Map(); // tiles being fetched, so parallel requests wait for the same download

  async function fetchTile(z, x, y, file) {
    const res = await fetchImpl(url.replace('{z}', z).replace('{x}', x).replace('{y}', y), { signal: AbortSignal.timeout(20000) });
    if (res.status === 404) return null; // no data there
    if (!res.ok) throw new Error(`Geländekachel: HTTP ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > MAX_BYTES || !data.subarray(0, 4).equals(PNG)) throw new Error('Geländekachel: kein PNG');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
    return data;
  }

  app.get('/api/terrain/:z/:x/:y.png', async (req, res) => {
    if (!url) return res.status(404).json({ error: 'Keine Geländedaten eingerichtet' });
    const [z, x, y] = [req.params.z, req.params.x, req.params.y].map((v) => (/^\d+$/.test(v) ? Number(v) : NaN));
    if (!(z >= 0 && z <= MAX_ZOOM) || !(x >= 0 && x < 2 ** z) || !(y >= 0 && y < 2 ** z)) {
      return res.status(400).json({ error: 'Ungültige Kachel' });
    }
    const file = path.join(dir, String(z), String(x), `${y}.png`);
    const send = (data) => {
      // Terrain does not change: browsers and the service worker may keep a tile for long.
      res.set('Cache-Control', 'public, max-age=2592000, immutable');
      res.type('png').send(data);
    };
    try {
      if (fs.existsSync(file)) return send(fs.readFileSync(file));
      const key = `${z}/${x}/${y}`;
      if (!running.has(key)) running.set(key, fetchTile(z, x, y, file).finally(() => running.delete(key)));
      const data = await running.get(key);
      if (!data) return res.status(404).end();
      return send(data);
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }
  });

  return { enabled: () => Boolean(url) };
}

module.exports = registerTerrain;
module.exports.DEFAULT_URL = DEFAULT_URL;
