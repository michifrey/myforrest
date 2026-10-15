#!/usr/bin/env node
'use strict';

/*
 * Uploads a whole folder of photos (with subfolders) to a myForrest server, in batches, over the API.
 * Place and time come from the photos' EXIF data or from a description next to them (myforrest.json,
 * format in docs/api.md). Needs Node 20 or later, nothing else.
 *
 *   node scripts/upload-folder.js <ordner> --server https://myforrest.example --token mf_…
 *
 * The API key (Profil → API-Schlüssel) can also come from MYFORREST_TOKEN, the server from
 * MYFORREST_SERVER. Uploaded files are noted in <ordner>/.myforrest-upload.log: a second run
 * continues where the first stopped. Each subfolder becomes one sequence (walk-through in time order).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const IMAGE = /\.(jpe?g|png|webp|heic|heif)$/i;
const VIDEO = /\.(mp4|mov|m4v|insv|360)$/i;
const LOG_NAME = '.myforrest-upload.log';

const HELP = `Ganzen Ordner mit Fotos zu myForrest hochladen.

  node scripts/upload-folder.js <ordner> [optionen]

  --server URL        Adresse des Servers (oder MYFORREST_SERVER), z. B. https://myforrest.onrender.com
  --token KEY         API-Schlüssel aus Profil → API-Schlüssel (oder MYFORREST_TOKEN)
  --meta DATEI        Beschreibung (JSON) mit Ort/Blickrichtung/Zeit pro Datei;
                      Standard: <ordner>/myforrest.json, falls vorhanden
  --activity A        joggen | wandern | biken | fahren | sonstiges
  --landscape L       Landschaftsprofil, z. B. wald
  --tags a,b          Tags für alle Fotos
  --note TEXT         Notiz für alle Fotos
  --license ID        Lizenz, z. B. cc-by-4.0
  --protected         Fotos geschützt hochladen
  --batch N           Fotos pro Anfrage (Standard 20, höchstens 200)
  --dry-run           nur zeigen, was hochgeladen würde
  --help              diese Hilfe
`;

function parseArgs(argv) {
  const opts = { batch: 20 };
  const flags = new Set(['protected', 'dry-run', 'help']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      if (opts.dir) throw new Error(`Unerwartetes Argument: ${a}`);
      opts.dir = a;
      continue;
    }
    const [key, inline] = a.slice(2).split(/=(.*)/s);
    if (flags.has(key)) opts[key] = true;
    else if (['server', 'token', 'meta', 'activity', 'landscape', 'tags', 'note', 'license', 'batch'].includes(key)) {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Error(`--${key} braucht einen Wert`);
      opts[key] = v;
    } else throw new Error(`Unbekannte Option: --${key}`);
  }
  opts.server = (opts.server || process.env.MYFORREST_SERVER || '').replace(/\/+$/, '');
  opts.token = opts.token || process.env.MYFORREST_TOKEN || '';
  opts.batch = Math.max(1, Math.min(200, Number(opts.batch) || 20));
  return opts;
}

/** All files below `dir`, relative paths with '/', sorted by path (numbers in natural order). */
function listFiles(dir, rel = '') {
  const out = [];
  for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (d.name.startsWith('.')) continue; // .DS_Store, ._IMG_0001.jpg, our log
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) out.push(...listFiles(dir, r));
    else if (d.isFile()) out.push(r);
  }
  return out.sort((a, b) => a.localeCompare(b, 'de', { numeric: true }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** POST with retries on network errors, 429 and 5xx. Resolves to the JSON answer. */
async function post(url, token, makeBody, tries = 4) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: await makeBody() });
    } catch (err) {
      if (attempt >= tries) throw new Error(`Verbindung fehlgeschlagen: ${err.cause?.message || err.message}`);
      await sleep(2000 * 2 ** (attempt - 1));
      continue;
    }
    const body = await res.json().catch(() => ({}));
    if (res.ok) return body;
    if ((res.status === 429 || res.status >= 500) && attempt < tries) {
      await sleep(Number(res.headers.get('retry-after')) * 1000 || 2000 * 2 ** (attempt - 1));
      continue;
    }
    throw new Error(`${body.error || `HTTP ${res.status}`}${res.status === 401 ? ' (API-Schlüssel prüfen)' : ''}`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.dir) {
    process.stdout.write(HELP);
    return opts.help ? 0 : 2;
  }
  const dir = path.resolve(opts.dir);
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Kein Ordner: ${dir}`);
  if (!opts['dry-run'] && !opts.server) throw new Error('Bitte --server angeben (oder MYFORREST_SERVER setzen)');
  if (!opts['dry-run'] && !opts.token) throw new Error('Bitte --token angeben (oder MYFORREST_TOKEN setzen) – Profil → API-Schlüssel');

  const metaPath = opts.meta ? path.resolve(opts.meta) : path.join(dir, 'myforrest.json');
  const meta = fs.existsSync(metaPath) ? fs.readFileSync(metaPath) : null;
  if (opts.meta && !meta) throw new Error(`Beschreibung nicht gefunden: ${metaPath}`);
  if (meta) JSON.parse(meta.toString('utf8').replace(/^﻿/, '')); // fail early on a broken file

  const logPath = path.join(dir, LOG_NAME);
  const done = new Set(fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean) : []);
  const files = listFiles(dir);
  const videos = files.filter((f) => VIDEO.test(f));
  const todo = files.filter((f) => IMAGE.test(f) && !done.has(f));
  console.log(`${todo.length} Fotos hochzuladen${done.size ? ` (${done.size} schon erledigt)` : ''}${meta ? `, Beschreibung: ${path.relative(dir, metaPath).startsWith('..') ? metaPath : path.relative(dir, metaPath)}` : ''}`);
  if (videos.length) console.log(`${videos.length} Videos übersprungen – bitte im Browser hochladen (werden auf dem Server geschnitten).`);
  if (opts['dry-run']) {
    todo.forEach((f) => console.log(`  ${f}`));
    return 0;
  }

  // Batches never span two folders: each folder is its own sequence.
  const groups = new Map();
  for (const f of todo) {
    const folder = path.posix.dirname(f);
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(f);
  }
  const offset = String(-new Date().getTimezoneOffset());
  const stats = { created: 0, skipped: 0, failed: 0, spots: new Set() };
  let n = 0;
  for (const [folder, list] of groups) {
    const sequenceId = list.length > 1 ? crypto.randomUUID() : null;
    for (let i = 0; i < list.length; i += opts.batch) {
      const batch = list.slice(i, i + opts.batch);
      n += batch.length;
      process.stdout.write(`[${n}/${todo.length}] ${folder === '.' ? '' : `${folder}/ `}${batch.length} Fotos … `);
      const makeBody = async () => {
        const fd = new FormData();
        for (const f of batch) fd.append('photos', await fs.openAsBlob(path.join(dir, f)), path.posix.basename(f));
        if (meta) fd.append('meta', new Blob([meta], { type: 'application/json' }), 'myforrest.json');
        fd.append('utcOffsetMinutes', offset);
        for (const k of ['activity', 'landscape', 'tags', 'note', 'license']) if (opts[k]) fd.append(k, opts[k]);
        if (opts.protected) fd.append('protected', '1');
        if (sequenceId) fd.append('sequenceId', sequenceId);
        return fd;
      };
      try {
        const r = await post(`${opts.server}/api/photos`, opts.token, makeBody);
        stats.created += r.created?.length || 0;
        stats.skipped += r.skipped?.length || 0;
        (r.spots || []).forEach((s) => stats.spots.add(s));
        console.log(`${r.created?.length || 0} gespeichert${r.skipped?.length ? `, ${r.skipped.length} übersprungen` : ''}`);
        for (const s of r.skipped || []) console.log(`    ${s.name}: ${s.reason}`);
        fs.appendFileSync(logPath, batch.map((f) => `${f}\n`).join(''));
      } catch (err) {
        stats.failed += batch.length;
        console.log(`Fehler: ${err.message}`);
        if (/API-Schlüssel|anmelden/.test(err.message)) throw err;
      }
    }
  }
  console.log(`Fertig: ${stats.created} Fotos gespeichert, ${stats.spots.size} Spots, ${stats.skipped} übersprungen${stats.failed ? `, ${stats.failed} fehlgeschlagen (nochmals starten, um sie zu wiederholen)` : ''}.`);
  if (stats.skipped) console.log(`Übersprungene Fotos stehen trotzdem in ${LOG_NAME}; Zeile löschen, um eines erneut zu senden.`);
  return stats.failed ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, listFiles };
