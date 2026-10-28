/*
 * Files as a layer of the map, as map.geo.admin.ch imports them: KML (placemarks with points, lines and polygons,
 * also in MultiGeometry, gx:Track), GPX (waypoints, tracks, routes) and GeoJSON, each turned into GeoJSON with the
 * name and description of each object. Read in the browser (window.FileLayer); the file never leaves the device.
 * Runs in Node for the tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FileLayer = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const MAX_FEATURES = 5000;
  const decode = (s) => String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&').trim();
  const text = (xml, tag) => {
    const m = new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`).exec(xml);
    return m ? decode(m[1]) : null;
  };
  const all = (xml, tag) => [...xml.matchAll(new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'g'))].map((m) => m[1]);
  /** Plain text of a description (KML often carries HTML). */
  const plain = (s) => (s ? decode(s).replace(/<(br|\/p|\/div|\/li|\/tr)\b[^>]*>/gi, ' ').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 500) : null);

  /** KML coordinates «lon,lat[,ele] lon,lat …» → [[lon, lat], …]. */
  const coords = (s) => String(s || '').trim().split(/\s+/).map((p) => p.split(',').map(Number)).filter((c) => c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1])).map(([x, y]) => [x, y]);

  function kmlGeometries(xml) {
    const out = [];
    for (const p of all(xml, 'Point')) { const c = coords(text(p, 'coordinates')); if (c.length) out.push({ type: 'Point', coordinates: c[0] }); }
    for (const l of all(xml, 'LineString')) { const c = coords(text(l, 'coordinates')); if (c.length > 1) out.push({ type: 'LineString', coordinates: c }); }
    for (const pg of all(xml, 'Polygon')) {
      const outer = coords(text(text(pg, 'outerBoundaryIs') || '', 'coordinates'));
      const inner = all(pg, 'innerBoundaryIs').map((b) => coords(text(b, 'coordinates'))).filter((r) => r.length > 3);
      if (outer.length > 3) out.push({ type: 'Polygon', coordinates: [outer, ...inner] });
    }
    // gx:Track: <gx:coord>lon lat ele</gx:coord>
    for (const t of all(xml, 'Track')) {
      const c = all(t, 'coord').map((s) => s.trim().split(/\s+/).map(Number)).filter((v) => v.length >= 2 && v.every(Number.isFinite)).map(([x, y]) => [x, y]);
      if (c.length > 1) out.push({ type: 'LineString', coordinates: c });
    }
    return out;
  }

  function fromKml(xml) {
    const features = [];
    for (const pm of all(xml, 'Placemark')) {
      const geoms = kmlGeometries(pm);
      if (!geoms.length) continue;
      const properties = { name: text(pm, 'name'), description: plain(text(pm, 'description')) };
      features.push({ type: 'Feature', properties, geometry: geoms.length === 1 ? geoms[0] : { type: 'GeometryCollection', geometries: geoms } });
    }
    return { name: text(xml.split(/<Placemark\b/)[0], 'name'), features };
  }

  function fromGpx(xml) {
    const features = [];
    const pts = (block, tag) => [...block.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'g'))].map((m) => {
      const lat = Number(/lat\s*=\s*["']([^"']+)/.exec(m[1])?.[1]);
      const lon = Number(/lon\s*=\s*["']([^"']+)/.exec(m[1])?.[1]);
      return [lon, lat];
    }).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    for (const m of xml.matchAll(/<wpt\b([^>]*)>([\s\S]*?)<\/wpt>|<wpt\b([^>]*)\/>/g)) {
      const head = m[1] || m[3];
      const c = pts(`<wpt ${head}>`, 'wpt')[0];
      if (c) features.push({ type: 'Feature', properties: { name: text(m[2] || '', 'name'), description: plain(text(m[2] || '', 'desc')) }, geometry: { type: 'Point', coordinates: c } });
    }
    for (const trk of all(xml, 'trk')) {
      const lines = all(trk, 'trkseg').map((s) => pts(s, 'trkpt')).filter((l) => l.length > 1);
      if (lines.length) features.push({ type: 'Feature', properties: { name: text(trk, 'name'), description: plain(text(trk, 'desc')) }, geometry: lines.length === 1 ? { type: 'LineString', coordinates: lines[0] } : { type: 'MultiLineString', coordinates: lines } });
    }
    for (const rte of all(xml, 'rte')) {
      const line = pts(rte, 'rtept');
      if (line.length > 1) features.push({ type: 'Feature', properties: { name: text(rte, 'name'), description: plain(text(rte, 'desc')) }, geometry: { type: 'LineString', coordinates: line } });
    }
    return { name: text(text(xml, 'metadata') || '', 'name') || text(all(xml, 'trk')[0] || '', 'name'), features };
  }

  function fromGeoJson(json) {
    const doc = JSON.parse(json);
    const features = doc.type === 'FeatureCollection' ? doc.features : doc.type === 'Feature' ? [doc] : [{ type: 'Feature', properties: {}, geometry: doc }];
    return { name: doc.name || null, features: features.filter((f) => f?.geometry?.type) };
  }

  /** Bounding box [west, south, east, north] of a FeatureCollection, or null. */
  function bboxOf(fc) {
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    const walk = (c) => {
      if (typeof c[0] === 'number') { b[0] = Math.min(b[0], c[0]); b[1] = Math.min(b[1], c[1]); b[2] = Math.max(b[2], c[0]); b[3] = Math.max(b[3], c[1]); } else c.forEach(walk);
    };
    const geom = (g) => (g.type === 'GeometryCollection' ? g.geometries.forEach(geom) : walk(g.coordinates));
    fc.features.forEach((f) => geom(f.geometry));
    return Number.isFinite(b[0]) ? b : null;
  }

  /**
   * A file's text → { name, format, collection (FeatureCollection), bbox }; throws when it is none of the formats
   * or holds nothing to draw.
   */
  function toGeoJson(content, filename = '') {
    const t = String(content).trim();
    let format;
    let r;
    if (/\.geo?json$/i.test(filename) || /^[{[]/.test(t)) { format = 'GeoJSON'; r = fromGeoJson(t); }
    else if (/<kml\b/i.test(t)) { format = 'KML'; r = fromKml(t); }
    else if (/<gpx\b/i.test(t)) { format = 'GPX'; r = fromGpx(t); }
    else throw new Error('Unbekanntes Format: KML, GPX oder GeoJSON');
    if (!r.features.length) throw new Error(`Keine Punkte, Linien oder Flächen in der ${format}-Datei`);
    const collection = { type: 'FeatureCollection', features: r.features.slice(0, MAX_FEATURES) };
    return { name: r.name || filename.replace(/\.[^.]+$/, '') || format, format, collection, bbox: bboxOf(collection), truncated: r.features.length > MAX_FEATURES };
  }

  return { toGeoJson, bboxOf, MAX_FEATURES };
}));
