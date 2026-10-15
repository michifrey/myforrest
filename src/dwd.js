'use strict';

/*
 * Maps of the Deutscher Wetterdienst (DWD) to lay over the map: precipitation
 * radar, weather warnings and forest fire danger from DWD's open GeoServer
 * (WMS, free, attribution "Deutscher Wetterdienst"). The browser loads the
 * map images straight from DWD; the server only reads the capabilities once
 * an hour to learn which of these layers exist and for which times the radar
 * has pictures. Coverage: Germany and its border areas.
 */

const WMS = 'https://maps.dwd.de/geoserver/dwd/wms';
const TTL = 3600000;

/**
 * Layers offered, in this order: exact name or a pattern for names DWD may change. On the workspace endpoint
 * (/geoserver/dwd/wms) GeoServer lists the names without the workspace (`Niederschlagsradar`), on the global one
 * with it (`dwd:Niederschlagsradar`); both are accepted, and the map asks for the name as listed.
 * `Niederschlagsradar` is DWD's alias for its current radar product (RV, 1 km, every 5 minutes, with a forecast of
 * up to 2 hours); its time dimension reads like `2026-10-02T12:30:00.000Z/2026-10-03T12:30:00.000Z/PT5M`.
 */
const WANTED = [
  { id: 'radar', match: /^(dwd:)?Niederschlagsradar$/, title: 'Niederschlagsradar', fallback: 'dwd:Niederschlagsradar', timed: true },
  { id: 'warnungen', match: /^(dwd:)?Warnungen_Gemeinden$/, title: 'Wetterwarnungen', fallback: 'dwd:Warnungen_Gemeinden' },
  { id: 'waldbrand', match: /waldbrand/i, title: 'Waldbrandgefahr' },
];

/** Layer names, titles and time dimensions from a WMS 1.3 capabilities document. */
function parseCapabilities(xml) {
  const layers = [];
  for (const m of xml.matchAll(/<Layer\b[^>]*>([\s\S]*?)(?=<Layer\b|<\/Layer>)/g)) {
    const body = m[1];
    const name = body.match(/<Name>([^<]+)<\/Name>/)?.[1]?.trim();
    if (!name) continue;
    const title = body.match(/<Title>([^<]*)<\/Title>/)?.[1]?.trim() || name;
    const dim = body.match(/<Dimension\b[^>]*name="time"[^>]*>([^<]*)<\/Dimension>/i);
    layers.push({ name, title, time: dim ? dim[1].trim() : null });
  }
  return layers;
}

/**
 * First and last time of a WMS time dimension ("start/end/PT5M" or a comma
 * list of times), as ms; null when it cannot be read.
 */
function timeRange(extent) {
  if (!extent) return null;
  const parts = extent.split(',').map((s) => s.trim()).filter(Boolean);
  const first = parts[0].split('/')[0];
  const lastPart = parts[parts.length - 1].split('/');
  const last = lastPart.length >= 2 ? lastPart[1] : lastPart[0];
  const from = Date.parse(first); const to = Date.parse(last);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const step = lastPart.length === 3 ? lastPart[2].match(/^PT(\d+)M$/)?.[1] : null;
  return { from, to, stepMin: step ? Number(step) : null };
}

function createDwd({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  let cache = null;

  /** Layers to offer: `{ url, attribution, layers: [{ id, name, title, from?, to?, stepMin? }], error? }`. */
  async function layers() {
    if (cache && now() - cache.at < TTL) return cache.value;
    let value;
    try {
      const res = await fetchImpl(`${WMS}?service=WMS&version=1.3.0&request=GetCapabilities`, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`DWD antwortete mit HTTP ${res.status}`);
      const found = parseCapabilities(await res.text());
      const out = [];
      for (const w of WANTED) {
        const layer = found.find((l) => w.match.test(l.name));
        if (!layer) continue;
        const range = w.timed ? timeRange(layer.time) : null;
        out.push({ id: w.id, name: layer.name, title: w.title, ...(range || {}) });
      }
      if (!out.length) throw new Error('keine passenden Karten gefunden');
      value = { url: WMS, attribution: 'Deutscher Wetterdienst', layers: out };
      cache = { at: now(), value };
    } catch (err) {
      // Without the list, offer the layers that have existed for years; try again in 10 minutes.
      value = {
        url: WMS,
        attribution: 'Deutscher Wetterdienst',
        layers: WANTED.filter((w) => w.fallback).map((w) => ({ id: w.id, name: w.fallback, title: w.title })),
        error: err.message,
      };
      cache = { at: now() - TTL + 600000, value };
    }
    return value;
  }

  return { layers };
}

module.exports = { createDwd, parseCapabilities, timeRange };
