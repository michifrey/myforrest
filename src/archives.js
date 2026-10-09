'use strict';

/**
 * Suggestions of archive pictures for a spot, from a catalogue of openly
 * licensed historical photos (e.g. the image archive of the ETH-Bibliothek,
 * e-pics, whose glacier and mountain photos are largely public domain or
 * CC BY-SA). The catalogue is a file prepared by the operator
 * (ARCHIV_KATALOG): CSV (; or ,) or GeoJSON points with
 *
 *   id, title, date (YYYY, YYYY-MM or YYYY-MM-DD), lat/lon (WGS84) or e/n (LV95),
 *   heading (viewing direction, optional), source, license, page (URL), image (URL of the file)
 *
 * A spot gets the pictures within RADIUS_M whose direction (if both have one)
 * is no more than MAX_ANGLE off. One click imports a picture as an archive
 * photo of the spot (dated, placed at the spot, aligned like any photo) –
 * only pictures with a licence that allows it (public domain/CC0, CC BY,
 * CC BY-SA; also CC BY-NC-SA, the most restrictive licence a photo here may carry).
 * The server downloads only the image URLs of the catalogue, nothing else.
 */

const fs = require('node:fs');
const { distanceM } = require('./geo');
const { lv95ToWgs84 } = require('./lv95');

const RADIUS_M = 2000;
const MAX_ANGLE = 60;
const MAX_BYTES = 30 * 1024 * 1024;

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Catalogue licence text → licence key of MyForrest, or null when it does not allow taking the picture over. */
function licenseKey(text) {
  const t = norm(text);
  if (!t) return null;
  if (/^(cc0|publicdomain|pdm|gemeinfrei|domainepublic|publicdomainmark)/.test(t) || t.includes('publicdomain') || t.includes('gemeinfrei')) return 'cc0-1.0';
  if (t.startsWith('ccbysa')) return 'cc-by-sa-4.0';
  if (t.startsWith('ccbyncsa')) return 'cc-by-nc-sa-4.0';
  if (t.startsWith('ccby') && !t.startsWith('ccbync') && !t.startsWith('ccbynd')) return 'cc-by-4.0';
  return null;
}

/** "1932", "1932-08", "1932-08-14" → ms (mid of the year/month when less is known), or null. */
function dateOf(v) {
  const m = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?/.exec(String(v || '').trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), m[2] ? Number(m[2]) : 7, m[3] ? Number(m[3]) : (m[2] ? 15 : 1)];
  return Date.UTC(y, mo - 1, d, 12);
}

function rowsOf(text) {
  const t = String(text).replace(/^﻿/, '').trim();
  if (t.startsWith('{')) {
    const doc = JSON.parse(t);
    return (doc.features || []).filter((f) => f.geometry?.type === 'Point').map((f) => {
      const [x, y] = f.geometry.coordinates;
      return { ...f.properties, ...(Math.abs(x) > 1000 ? { e: x, n: y } : { lon: x, lat: y }) };
    });
  }
  const lines = t.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  const sep = lines[0].includes(';') ? ';' : ',';
  const split = (line) => {
    const out = []; let cur = ''; let q = false;
    for (const ch of line) { if (ch === '"') q = !q; else if (ch === sep && !q) { out.push(cur.trim()); cur = ''; } else cur += ch; }
    out.push(cur.trim());
    return out;
  };
  const head = split(lines[0]).map((h) => h.toLowerCase());
  return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [head[i], v])));
}

/** A number from a cell; empty cells are no number (Number('') would be 0). */
const num = (v) => (v === undefined || v === null || String(v).trim() === '' ? NaN : Number(String(v).replace(',', '.')));

/** Catalogue text → [{ id, title, takenAt, year, lat, lon, heading, source, license, licenseKey, page, image }]. */
function parseCatalogue(text) {
  const out = [];
  for (const r of rowsOf(text)) {
    let lat = num(r.lat ?? r.latitude);
    let lon = num(r.lon ?? r.longitude);
    if (!(Number.isFinite(lat) && Number.isFinite(lon)) && Number.isFinite(num(r.e)) && Number.isFinite(num(r.n))) {
      [lat, lon] = lv95ToWgs84(num(r.e), num(r.n));
    }
    const takenAt = dateOf(r.date ?? r.datum ?? r.year ?? r.jahr);
    const id = String(r.id ?? '').trim();
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon) || takenAt === null) continue;
    const heading = num(r.heading);
    const image = /^https:\/\//.test(r.image || '') ? r.image : null;
    out.push({
      id, title: String(r.title ?? r.titel ?? '').slice(0, 300) || 'Archivbild', takenAt, year: new Date(takenAt).getUTCFullYear(),
      lat, lon, heading: Number.isFinite(heading) ? ((heading % 360) + 360) % 360 : null,
      source: String(r.source ?? r.quelle ?? '').slice(0, 200) || null, license: r.license ?? r.lizenz ?? null,
      licenseKey: licenseKey(r.license ?? r.lizenz), page: /^https?:\/\//.test(r.page || r.url || '') ? (r.page || r.url) : null, image,
    });
  }
  return out;
}

const angleDiff = (a, b) => Math.abs((((a - b) % 360) + 540) % 360 - 180);

function createArchives({ files = process.env.ARCHIV_KATALOG || '', fetchImpl = fetch } = {}) {
  const list = String(files).split(',').map((f) => f.trim()).filter(Boolean);
  let cache = { stamp: '', items: [] };
  function items() {
    const stamp = list.map((f) => { try { return `${f}:${fs.statSync(f).mtimeMs}`; } catch { return `${f}:-`; } }).join('|');
    if (stamp === cache.stamp) return cache.items;
    const all = [];
    for (const f of list) {
      try { all.push(...parseCatalogue(fs.readFileSync(f, 'utf8'))); } catch (err) { console.error(`Archiv-Katalog ${f}: ${err.message}`); }
    }
    cache = { stamp, items: all };
    return all;
  }

  /** Pictures for a spot ({ lat, lon, heading }), nearest first: items plus distanceM. */
  function near(spot, { radiusM = RADIUS_M } = {}) {
    return items()
      .map((it) => ({ ...it, distanceM: Math.round(distanceM(spot, it)) }))
      .filter((it) => it.distanceM <= radiusM
        && (it.heading === null || spot.heading === null || spot.heading === undefined || angleDiff(it.heading, spot.heading) <= MAX_ANGLE))
      .sort((a, b) => a.distanceM - b.distanceM);
  }

  const byId = (id) => items().find((it) => it.id === id) || null;

  /** Downloads a catalogue picture to `file` (only its catalogue URL, image types, size-limited). */
  async function download(item, file) {
    if (!item.image) throw new Error('Kein Bild-Link im Katalog');
    const res = await fetchImpl(item.image, { signal: AbortSignal.timeout(60000), redirect: 'follow' });
    if (!res.ok) throw new Error(`Bildarchiv antwortete mit HTTP ${res.status}`);
    if (!/^image\//.test(res.headers.get('content-type') || '')) throw new Error('Der Link liefert kein Bild');
    if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error('Bild zu gross (höchstens 30 MB)');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('Bild zu gross (höchstens 30 MB)');
    await fs.promises.writeFile(file, buf);
  }

  return { near, byId, download, enabled: () => list.length > 0 };
}

module.exports = { createArchives, parseCatalogue, licenseKey, RADIUS_M, MAX_ANGLE };
