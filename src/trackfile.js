'use strict';

/**
 * Reads tracks from the files sports watches and route planners export and
 * writes GPX. Supported: GPX (tracks, routes, or waypoints when nothing else),
 * Garmin TCX, KML (LineString and gx:Track) and GeoJSON (LineString,
 * MultiLineString, Features, with optional `coordTimes`), NMEA (dashcams) and FIT (binary, as a Buffer). Points carry
 * `lat`, `lon` and, when known, `ele` (m) and `time` (ms since epoch).
 *
 * parseTrackFile(text, filename?) → { name, format, points, hasTime }
 * toGpx(track) → GPX 1.1 string
 */

const { parseNmea, looksLikeNmea } = require('./dashcam');
const { parseFit, isFit } = require('./fit');

const MAX_POINTS = 20000;

const decode = (s) => String(s)
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&amp;/g, '&')
  .trim();
const escapeXml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

const attr = (attrs, name) => {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`));
  return m ? Number(m[1]) : NaN;
};
const tagText = (xml, tag) => {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`));
  return m ? decode(m[1]) : null;
};
const num = (s) => (s === null || s === '' ? NaN : Number(s));
const timeOf = (s) => {
  const t = s ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? t : null;
};
const valid = (p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;

function point(lat, lon, ele, time) {
  const p = { lat, lon };
  if (Number.isFinite(ele)) p.ele = Math.round(ele * 10) / 10;
  if (Number.isFinite(time)) p.time = time;
  return p;
}

function parseGpxPoints(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tag}>)`, 'g');
  let m;
  while ((m = re.exec(xml))) {
    const body = m[2] || '';
    const ele = num(tagText(body, 'ele'));
    out.push(point(attr(m[1], 'lat'), attr(m[1], 'lon'), ele, timeOf(tagText(body, 'time'))));
  }
  return out.filter(valid);
}

function parseGpx(xml) {
  let points = parseGpxPoints(xml, 'trkpt');
  if (!points.length) points = parseGpxPoints(xml, 'rtept');
  if (!points.length) points = parseGpxPoints(xml, 'wpt');
  const trk = xml.match(/<(trk|rte)\b[^>]*>([\s\S]*?)<\/\1>/);
  const meta = xml.match(/<metadata\b[^>]*>([\s\S]*?)<\/metadata>/);
  const name = (trk && tagText(trk[2].replace(/<(trkseg|trkpt|rtept)\b[\s\S]*/, ''), 'name')) || (meta && tagText(meta[1], 'name'));
  return { name, points };
}

function parseTcx(xml) {
  const points = [];
  const re = /<Trackpoint\b[^>]*>([\s\S]*?)<\/Trackpoint>/g;
  let m;
  while ((m = re.exec(xml))) {
    const lat = num(tagText(m[1], 'LatitudeDegrees'));
    const lon = num(tagText(m[1], 'LongitudeDegrees'));
    points.push(point(lat, lon, num(tagText(m[1], 'AltitudeMeters')), timeOf(tagText(m[1], 'Time'))));
  }
  const name = tagText(xml, 'Notes') || tagText(xml, 'Name') || tagText(xml, 'Id');
  return { name, points: points.filter(valid) };
}

function parseKml(xml) {
  const points = [];
  // gx:Track: <when> and <gx:coord lon lat ele> in the same order
  const track = /<gx:Track\b[^>]*>([\s\S]*?)<\/gx:Track>/g;
  let m;
  while ((m = track.exec(xml))) {
    const whens = [...m[1].matchAll(/<when>([^<]+)<\/when>/g)].map((w) => timeOf(w[1]));
    const coords = [...m[1].matchAll(/<gx:coord>([^<]+)<\/gx:coord>/g)].map((c) => c[1].trim().split(/\s+/).map(Number));
    coords.forEach(([lon, lat, ele], i) => points.push(point(lat, lon, ele, whens[i])));
  }
  if (!points.length) {
    const line = /<LineString\b[^>]*>([\s\S]*?)<\/LineString>/g;
    while ((m = line.exec(xml))) {
      const text = tagText(m[1], 'coordinates') || '';
      for (const tuple of text.split(/\s+/).filter(Boolean)) {
        const [lon, lat, ele] = tuple.split(',').map(Number);
        points.push(point(lat, lon, ele));
      }
    }
  }
  const name = tagText(xml.replace(/<Placemark\b[\s\S]*/, ''), 'name') || tagText(xml, 'name');
  return { name, points: points.filter(valid) };
}

function parseGeoJson(text) {
  const doc = JSON.parse(text);
  const points = [];
  let name = null;
  const addLine = (coords, times) => coords.forEach(([lon, lat, ele], i) => points.push(point(lat, lon, ele, timeOf(times?.[i]))));
  const visit = (g, props = {}) => {
    if (!g) return;
    if (g.type === 'FeatureCollection') return g.features.forEach((f) => visit(f));
    if (g.type === 'Feature') {
      name ??= g.properties?.name || null;
      return visit(g.geometry, g.properties || {});
    }
    const times = props.coordTimes || props.times;
    if (g.type === 'LineString') addLine(g.coordinates, times);
    else if (g.type === 'MultiLineString') g.coordinates.forEach((c, i) => addLine(c, Array.isArray(times?.[0]) ? times[i] : null));
    else if (g.type === 'GeometryCollection') g.geometries.forEach((x) => visit(x, props));
  };
  visit(doc);
  return { name, points: points.filter(valid) };
}

function detect(text, filename = '') {
  const ext = String(filename).toLowerCase().split('.').pop();
  const head = text.slice(0, 2000);
  // NMEA first: BlackVue lines start with "[unix ms]", which would look like JSON.
  if (ext === 'nmea' || looksLikeNmea(head)) return 'nmea';
  if (ext === 'geojson' || ext === 'json' || /^\s*[{[]/.test(head)) return 'geojson';
  if (ext === 'tcx' || /<TrainingCenterDatabase\b/.test(head)) return 'tcx';
  if (ext === 'kml' || /<kml\b/.test(head)) return 'kml';
  if (ext === 'gpx' || /<gpx\b/.test(head)) return 'gpx';
  return null;
}

/** Drops every n-th point beyond MAX_POINTS, keeping first and last. */
function thin(points, max = MAX_POINTS) {
  if (points.length <= max) return points;
  const step = points.length / max;
  const out = [];
  for (let i = 0; i < max - 1; i++) out.push(points[Math.floor(i * step)]);
  out.push(points[points.length - 1]);
  return out;
}

function parseTrackFile(text, filename) {
  // FIT is binary: a Buffer (or its text already decoded) with ".FIT" at byte 8.
  if (Buffer.isBuffer(text) && isFit(text)) return finish(parseFit(text), 'fit', filename);
  if (Buffer.isBuffer(text)) text = text.toString('utf8');
  const format = detect(text, filename);
  if (!format) throw new Error('Unbekanntes Format – unterstützt sind GPX, TCX, KML, GeoJSON, NMEA und FIT');
  let parsed;
  try {
    parsed = {
      gpx: parseGpx, tcx: parseTcx, kml: parseKml, geojson: parseGeoJson,
      nmea: (t) => ({ name: null, points: parseNmea(t).map((p) => point(p.lat, p.lon, p.ele, p.time)) }),
    }[format](text);
  } catch (err) {
    throw new Error(`Datei konnte nicht gelesen werden (${err.message})`);
  }
  return finish(parsed, format, filename);
}

function finish(parsed, format, filename) {
  let points = parsed.points;
  // Recorded tracks come in time order; files sometimes do not.
  if (points.length && points.every((p) => p.time !== undefined)) points = [...points].sort((a, b) => a.time - b.time);
  if (points.length < 2) throw new Error('Die Datei enthält keine Strecke mit mindestens zwei Punkten');
  points = thin(points);
  const fallback = String(filename || '').replace(/\.[^.]+$/, '') || null;
  return { name: parsed.name || fallback, format, points, hasTime: points.some((p) => p.time !== undefined) };
}

function toGpx({ name, points, activity }) {
  const pts = points.map((p) => {
    const inner = [
      Number.isFinite(p.ele) ? `<ele>${p.ele}</ele>` : '',
      Number.isFinite(p.time) ? `<time>${new Date(p.time).toISOString()}</time>` : '',
    ].join('');
    return `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">${inner}</trkpt>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="MyForrest" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${escapeXml(name || 'Tour')}</name>${activity ? `\n    <type>${escapeXml(activity)}</type>` : ''}
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
}

module.exports = { parseTrackFile, toGpx, MAX_POINTS };
