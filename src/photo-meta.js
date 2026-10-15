'use strict';

/**
 * A description of the photos of an upload (`meta`, e.g. myforrest.json next to the photos of a folder):
 * per file name the place, view direction, time, tags and note, for photos without GPS or to correct it.
 * Accepted shapes (keys case-insensitive, the file name without folders):
 *
 *   [{ "file": "IMG_0001.jpg", "lat": 47.37, "lon": 8.54, "heading": 120, "takenAt": "2026-05-04T08:10:00Z" }, …]
 *   { "photos": [ …same… ] }
 *   { "IMG_0001.jpg": { "lat": 47.37, "lon": 8.54 }, … }
 *   GeoJSON FeatureCollection of points with "file" (or "name") in the properties
 *
 * Field names also: latitude/longitude/lng, direction/bearing/azimuth, time/date/datetime/taken_at,
 * description for the note. Unknown fields are ignored. parseMeta() throws with a message for the user.
 */

const MAX_ENTRIES = 50000;

const pick = (o, names) => {
  for (const n of names) if (o[n] !== undefined && o[n] !== null && o[n] !== '') return o[n];
  return undefined;
};
const num = (v) => (v === undefined ? undefined : Number(v));

function entryOf(raw, geometry) {
  const o = {};
  for (const [k, v] of Object.entries(raw || {})) o[k.toLowerCase()] = v;
  let lat = num(pick(o, ['lat', 'latitude']));
  let lon = num(pick(o, ['lon', 'lng', 'long', 'longitude']));
  if (geometry?.type === 'Point' && Array.isArray(geometry.coordinates)) [lon, lat] = geometry.coordinates.map(Number);
  const e = {};
  if (lat !== undefined || lon !== undefined) {
    if (!(Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return { error: 'ungültige Koordinaten' };
    Object.assign(e, { lat, lon });
  }
  const heading = num(pick(o, ['heading', 'direction', 'bearing', 'azimuth']));
  if (heading !== undefined) {
    if (!Number.isFinite(heading)) return { error: 'ungültige Blickrichtung' };
    e.heading = ((heading % 360) + 360) % 360;
  }
  const time = pick(o, ['takenat', 'taken_at', 'time', 'date', 'datetime']);
  if (time !== undefined) {
    const t = typeof time === 'number' ? time : Date.parse(String(time));
    if (!Number.isFinite(t)) return { error: 'ungültiges Datum' };
    e.takenAt = t;
  }
  const tags = pick(o, ['tags']);
  if (tags !== undefined) e.tags = Array.isArray(tags) ? tags.map(String) : String(tags).split(',');
  const note = pick(o, ['note', 'description', 'notiz']);
  if (note !== undefined) e.note = String(note).slice(0, 2000);
  for (const k of ['activity', 'landscape']) if (o[k] !== undefined) e[k] = String(o[k]);
  return e;
}

const baseName = (name) => String(name).split(/[\\/]/).pop().trim().toLowerCase();

/** The description as Map(file name in lower case → entry); entries with mistakes carry `error`. */
function parseMeta(text) {
  let data;
  try {
    data = JSON.parse(String(text).replace(/^﻿/, ''));
  } catch (err) {
    throw new Error(`Beschreibung (JSON) nicht lesbar: ${err.message}`);
  }
  const rows = [];
  if (Array.isArray(data)) rows.push(...data.map((r) => [pick(lower(r), ['file', 'filename', 'name']), r, null]));
  else if (data && Array.isArray(data.photos)) rows.push(...data.photos.map((r) => [pick(lower(r), ['file', 'filename', 'name']), r, null]));
  else if (data && data.type === 'FeatureCollection' && Array.isArray(data.features)) {
    rows.push(...data.features.map((f) => [pick(lower(f.properties), ['file', 'filename', 'name']), f.properties, f.geometry]));
  } else if (data && typeof data === 'object') rows.push(...Object.entries(data).map(([k, v]) => [k, v, null]));
  else throw new Error('Beschreibung (JSON): erwartet eine Liste von Fotos oder ein Objekt pro Dateiname');
  if (rows.length > MAX_ENTRIES) throw new Error(`Beschreibung (JSON): höchstens ${MAX_ENTRIES} Einträge`);
  const map = new Map();
  for (const [file, raw, geometry] of rows) {
    if (!file || typeof raw !== 'object') continue;
    map.set(baseName(file), entryOf(raw, geometry));
  }
  return map;
}

function lower(o) {
  const out = {};
  for (const [k, v] of Object.entries(o || {})) out[k.toLowerCase()] = v;
  return out;
}

module.exports = { parseMeta, baseName };
