/*
 * Files as a layer of the map, as map.geo.admin.ch imports them: KML and KMZ (placemarks with points, lines and
 * polygons, also in MultiGeometry, gx:Track, with the colours of their styles), GPX (waypoints, tracks, routes) and
 * GeoJSON, each turned into GeoJSON with the name and description of each object. The colours go into the properties
 * of the simplestyle spec (stroke, stroke-width, stroke-opacity, fill, fill-opacity, marker-color). Read in the
 * browser (window.FileLayer); the file never leaves the device. Runs in Node for the tests.
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

  /** KML colour aabbggrr → ['#rrggbb', opacity]. */
  function kmlColour(s) {
    const m = /^\s*([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})\s*$/i.exec(s || '');
    return m ? [`#${m[4]}${m[3]}${m[2]}`.toLowerCase(), Math.round((parseInt(m[1], 16) / 255) * 100) / 100] : null;
  }
  /** The colours of a <Style> as simplestyle properties. */
  function styleProps(style) {
    const out = {};
    const line = text(style, 'LineStyle');
    const poly = text(style, 'PolyStyle');
    const icon = text(style, 'IconStyle');
    const lc = kmlColour(line && text(line, 'color'));
    if (lc) [out.stroke, out['stroke-opacity']] = lc;
    const w = Number(line && text(line, 'width'));
    if (w > 0) out['stroke-width'] = Math.min(w, 20);
    const pc = kmlColour(poly && text(poly, 'color'));
    if (pc) [out.fill, out['fill-opacity']] = pc;
    if (poly && text(poly, 'fill') === '0') out['fill-opacity'] = 0;
    const ic = kmlColour(icon && text(icon, 'color'));
    if (ic) out['marker-color'] = ic[0];
    return out;
  }
  /** Shared styles of a document by id, the normal style of a StyleMap included. */
  function kmlStyles(xml) {
    const styles = {};
    for (const m of xml.matchAll(/<(?:[\w-]+:)?Style\b[^>]*\bid\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:[\w-]+:)?Style>/g)) styles[m[1]] = styleProps(m[2]);
    for (const m of xml.matchAll(/<(?:[\w-]+:)?StyleMap\b[^>]*\bid\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:[\w-]+:)?StyleMap>/g)) {
      const normal = all(m[2], 'Pair').find((p) => text(p, 'key') === 'normal');
      const url = normal && text(normal, 'styleUrl');
      if (url) styles[m[1]] = styles[url.replace(/^.*#/, '')] || {};
    }
    return styles;
  }

  function fromKml(xml) {
    const features = [];
    const styles = kmlStyles(xml);
    for (const pm of all(xml, 'Placemark')) {
      const geoms = kmlGeometries(pm);
      if (!geoms.length) continue;
      const url = text(pm, 'styleUrl');
      const inline = all(pm, 'Style')[0];
      const properties = {
        name: text(pm, 'name'), description: plain(text(pm, 'description')),
        ...(url ? styles[url.replace(/^.*#/, '')] : null), ...(inline ? styleProps(inline) : null),
      };
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

  /* ---------- KMZ: a ZIP with the KML (and its pictures) ---------- */

  const MAX_UNZIPPED = 50 * 1024 * 1024;
  /** The entries of a ZIP (central directory): [{ name, method, data (compressed bytes), size }]. */
  function zipEntries(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('Keine gültige KMZ-Datei (ZIP)');
    const out = [];
    let p = dv.getUint32(eocd + 16, true);
    for (let n = dv.getUint16(eocd + 10, true); n > 0; n--) {
      if (p + 46 > bytes.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error('Beschädigte KMZ-Datei');
      const nameLen = dv.getUint16(p + 28, true);
      const local = dv.getUint32(p + 42, true);
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      out.push({
        name: new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen)), method: dv.getUint16(p + 10, true),
        data: bytes.subarray(start, start + dv.getUint32(p + 20, true)), size: dv.getUint32(p + 24, true),
      });
      p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
    }
    return out;
  }
  /** The bytes of an entry: stored as is, or inflated (deflate) with the stream of the browser, at most 50 MB. */
  async function inflate(entry) {
    if (entry.method === 0) return entry.data;
    if (entry.method !== 8) throw new Error('KMZ mit unbekannter Kompression');
    if (entry.size > MAX_UNZIPPED) throw new Error('KML in der KMZ-Datei grösser als 50 MB');
    const reader = new Blob([entry.data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    const parts = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_UNZIPPED) { reader.cancel(); throw new Error('KML in der KMZ-Datei grösser als 50 MB'); }
      parts.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
  }

  /**
   * The bytes of a file (KML, KMZ, GPX, GeoJSON) → as toGeoJson. A KMZ is a ZIP: its main KML is doc.kml, else the
   * first .kml at the top level, else the first anywhere.
   */
  async function read(buffer, filename = '') {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
      const kmls = zipEntries(bytes).filter((e) => /\.kml$/i.test(e.name));
      const main = kmls.find((e) => /(^|\/)doc\.kml$/i.test(e.name)) || kmls.find((e) => !e.name.includes('/')) || kmls[0];
      if (!main) throw new Error('Keine KML-Datei in der KMZ-Datei');
      const r = toGeoJson(new TextDecoder().decode(await inflate(main)), filename.replace(/\.kmz$/i, '.kml'));
      return { ...r, format: 'KMZ' };
    }
    return toGeoJson(new TextDecoder().decode(bytes), filename);
  }

  return { toGeoJson, read, bboxOf, kmlColour, MAX_FEATURES };
}));
