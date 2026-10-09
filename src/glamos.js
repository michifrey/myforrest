'use strict';

/**
 * Length change of glacier tongues from the GLAMOS measurement series
 * (Glacier Monitoring Switzerland, glamos.ch → Daten → Längenänderung):
 * one row per observation period with glacier name, SGI id, start and end
 * date and the change in metres (negative = retreat). Comment lines (#) and
 * the column order are tolerated; columns are found by their names
 * (English or German), the separator may be comma, semicolon or tab.
 *
 * GLAMOS_CSV: one or more files, comma-separated. A spot's glacier (from the
 * inventories, src/glaciers.js) is matched by its SGI id, else by its name
 * without "gletscher", "glacier", "ghiacciaio", "vadret".
 */

const fs = require('node:fs');

const norm = (s) => String(s || '').toLowerCase()
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/é|è|ê/g, 'e').replace(/à|â/g, 'a')
  .replace(/[^a-z0-9]/g, '');
const nameKey = (s) => norm(s).replace(/(gletscher|glacier|ghiacciaio|vadret|vadrec|glatscher)/g, '') || norm(s);
const idKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');

function splitLine(line, sep) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === sep && !quoted) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** CSV text → Map(key → { name, id, series: [{ from, to, change }] }), keys "id:…" and "name:…". */
function parseGlamos(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  const glaciers = new Map();
  if (!lines.length) return glaciers;
  const sep = [';', '\t', ','].find((s) => lines[0].includes(s)) || ',';
  const header = splitLine(lines[0], sep).map(norm);
  const col = (...names) => header.findIndex((h) => names.some((n) => h === n || h.startsWith(n)));
  const iName = col('glaciername', 'gletschername', 'name', 'gletscher');
  const iId = col('glacierid', 'sgiid', 'sgi', 'id');
  const iFrom = col('startdateofobservation', 'startdate', 'start', 'von', 'beginn');
  const iTo = col('enddateofobservation', 'enddate', 'end', 'bis', 'ende');
  const iChange = col('lengthchange', 'laengenaenderung', 'change', 'aenderung');
  if (iChange < 0 || iTo < 0 || (iName < 0 && iId < 0)) throw new Error('GLAMOS: Spalten für Gletscher, Enddatum und Längenänderung nicht gefunden');
  for (const line of lines.slice(1)) {
    const c = splitLine(line, sep);
    const change = Number(String(c[iChange] || '').replace(',', '.'));
    const to = Date.parse(c[iTo]);
    if (!Number.isFinite(change) || !Number.isFinite(to)) continue;
    const from = iFrom >= 0 ? Date.parse(c[iFrom]) : NaN;
    const name = iName >= 0 ? c[iName] : '';
    const id = iId >= 0 ? c[iId] : '';
    const key = id ? `id:${idKey(id)}` : `name:${nameKey(name)}`;
    if (!glaciers.has(key)) glaciers.set(key, { name: name || id, id: id || null, series: [] });
    glaciers.get(key).series.push({ from: Number.isFinite(from) ? from : null, to, change });
  }
  for (const g of glaciers.values()) g.series.sort((a, b) => a.to - b.to);
  return glaciers;
}

const year = (t) => new Date(t).getUTCFullYear();

/** Summary of a series: cumulative curve, total, years and the mean rate of the last ten years. */
function summarize(g) {
  let sum = 0;
  const points = g.series.map((s) => ({ year: year(s.to), change: s.change, cumulative: (sum += s.change) }));
  const first = g.series[0];
  const last = g.series[g.series.length - 1];
  const since = last.to - 10 * 365.25 * 86400000;
  const recent = g.series.filter((s) => s.to > since);
  const span = recent.length ? (last.to - (recent[0].from ?? recent[0].to - 365.25 * 86400000)) / (365.25 * 86400000) : 0;
  return {
    name: g.name,
    id: g.id,
    firstYear: year(first.from ?? first.to),
    lastYear: year(last.to),
    total: Math.round(sum),
    observations: g.series.length,
    recentRate: span > 0 ? Math.round((recent.reduce((a, s) => a + s.change, 0) / span) * 10) / 10 : null,
    points,
  };
}

function createGlamos({ files = process.env.GLAMOS_CSV || '' } = {}) {
  const list = String(files).split(',').map((f) => f.trim()).filter(Boolean);
  let cache = { stamp: '', data: new Map() };
  function data() {
    const stamp = list.map((f) => { try { return `${f}:${fs.statSync(f).mtimeMs}`; } catch { return `${f}:-`; } }).join('|');
    if (stamp === cache.stamp) return cache.data;
    const merged = new Map();
    for (const f of list) {
      try {
        for (const [k, v] of parseGlamos(fs.readFileSync(f, 'utf8'))) merged.set(k, v);
      } catch (err) {
        console.error(`GLAMOS-Datei ${f}: ${err.message}`);
      }
    }
    cache = { stamp, data: merged };
    return merged;
  }

  /** The length series of a glacier from the inventories ({ name, id }), or null. */
  function forGlacier(glacier) {
    if (!glacier || !list.length) return null;
    const d = data();
    // By name: equal, or one ends with the other ("Vadret da Morteratsch" – "Morteratsch").
    const k = nameKey(glacier.name);
    const sameName = (g) => {
      const n = nameKey(g.name);
      return n === k || (Math.min(n.length, k.length) >= 5 && (n.endsWith(k) || k.endsWith(n)));
    };
    const hit = (glacier.id && d.get(`id:${idKey(glacier.id)}`)) || (glacier.name && [...d.values()].find(sameName));
    return hit ? summarize(hit) : null;
  }

  return { forGlacier, enabled: () => list.length > 0 };
}

module.exports = { createGlamos, parseGlamos, summarize };
