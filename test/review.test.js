'use strict';

// Human review of automatic identifications before export (routes/species.js, occurrences.js, export.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');

async function withServer(fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-review-'));
  const app = createApp({ dataDir, routerUrl: '', stormWarnHours: 0, weatherFetch: async () => new Response('', { status: 503 }) });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, app.locals.db);
  } finally {
    await app.locals.idle();
    server.close();
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function client(base) {
  const c = {
    async req(url, { method = 'GET', json } = {}) {
      const h = {};
      if (c.cookie) h.Cookie = c.cookie;
      if (c.csrf && method !== 'GET') h['X-CSRF-Token'] = c.csrf;
      if (json !== undefined) h['Content-Type'] = 'application/json';
      const res = await fetch(`${base}${url}`, { method, headers: h, body: json === undefined ? undefined : JSON.stringify(json) });
      const set = res.headers.get('set-cookie');
      if (set) c.cookie = set.split(';')[0];
      return res;
    },
    json: async (url, opts) => (await c.req(url, opts)).json(),
    text: async (url) => (await c.req(url)).text(),
    async register(name) {
      const b = await c.json('/api/auth/register', { method: 'POST', json: { email: `${name}@example.org`, name, password: 'geheim-1234' } });
      c.csrf = b.csrfToken;
      return b.user;
    },
  };
  return c;
}

function addFinding(db, { lat, lon, date, uploader = null, candidates }) {
  const now = Date.now();
  const spot = db.prepare('INSERT INTO spots (lat, lon, created_at) VALUES (?, ?, ?)').run(lat, lon, now).lastInsertRowid;
  const photo = Number(db.prepare(`INSERT INTO photos (spot_id, file, taken_at, lat, lon, location_source, uploader_id, created_at)
    VALUES (?, ?, ?, ?, ?, 'exif', ?, ?)`).run(spot, `r${spot}.jpg`, Date.parse(date), lat, lon, uploader, now).lastInsertRowid);
  const ins = db.prepare('INSERT INTO identifications (photo_id, scientific_name, common_name, score, neophyte, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (const [name, score, neo = null] of candidates) ins.run(photo, name, null, score, neo, now);
  return photo;
}

test('reviewers confirm, correct or reject; exports say "verified" and can be limited to reviewed finds', async () => {
  await withServer(async (base, db) => {
    const admin = client(base);
    await admin.register('Admina'); // the first account: admin
    const expert = client(base);
    const expertUser = await expert.register('Fachstelle');
    const anna = client(base);
    await anna.register('Anna');
    await expert.json('/api/auth/pro', { method: 'POST', json: { organization: 'Neobiota-Fachstelle' } });
    await admin.json(`/api/users/${expertUser.id}/pro`, { method: 'POST', json: { decision: 'verifiziert' } });

    const springkraut = addFinding(db, { lat: 47.36, lon: 8.55, date: '2025-07-01T10:00:00Z', candidates: [['Impatiens glandulifera', 0.82, 'Drüsiges Springkraut'], ['Impatiens parviflora', 0.1]] });
    const goldrute = addFinding(db, { lat: 47.361, lon: 8.551, date: '2025-08-01T10:00:00Z', candidates: [['Solidago canadensis', 0.45, 'Kanadische Goldrute'], ['Solidago gigantea', 0.3, 'Spätblühende Goldrute']] });
    const unsure = addFinding(db, { lat: 47.362, lon: 8.552, date: '2025-08-02T10:00:00Z', candidates: [['Fallopia japonica', 0.12, 'Japanischer Staudenknöterich']] });
    const steine = addFinding(db, { lat: 47.363, lon: 8.553, date: '2025-08-03T10:00:00Z', candidates: [['Buddleja davidii', 0.35, 'Sommerflieder']] });
    const own = addFinding(db, { lat: 47.364, lon: 8.554, date: '2025-08-04T10:00:00Z', uploader: expertUser.id, candidates: [['Ailanthus altissima', 0.6, 'Götterbaum']] });

    // Only reviewers see the queue: the best candidates of findings not reviewed yet, with all candidates.
    assert.equal((await anna.req('/api/identifications/review')).status, 403);
    const queue = await expert.json('/api/identifications/review?minScore=0');
    assert.deepEqual(queue.map((q) => q.photoId), [own, steine, unsure, goldrute, springkraut]);
    assert.deepEqual(queue.find((q) => q.photoId === goldrute).candidates.map((c) => c.scientificName), ['Solidago canadensis', 'Solidago gigantea']);
    assert.equal(queue.find((q) => q.photoId === own).own, true);

    const review = (who, id, body) => who.req(`/api/photos/${id}/identification-review`, { method: 'PUT', json: body });
    assert.equal((await review(anna, springkraut, { status: 'bestaetigt' })).status, 403, 'members without PRO');
    assert.equal((await review(expert, own, { status: 'bestaetigt' })).status, 403, 'not the own photo');
    assert.equal((await review(expert, springkraut, { status: 'vielleicht' })).status, 400);
    assert.equal((await review(expert, goldrute, { status: 'korrigiert', scientificName: 'goldrute' })).status, 400, 'a Latin name');
    assert.equal((await review(expert, springkraut, { status: 'bestaetigt' })).status, 200);
    assert.equal((await review(expert, goldrute, { status: 'korrigiert', scientificName: 'Solidago gigantea' })).status, 200);
    assert.equal((await review(expert, unsure, { status: 'bestaetigt' })).status, 200, 'below the score threshold, but a person is sure');
    assert.equal((await review(expert, steine, { status: 'abgelehnt' })).status, 200);
    assert.equal((await review(admin, own, { status: 'bestaetigt' })).status, 200, 'moderation may');

    const occ = await anna.json('/api/occurrences');
    const by = Object.fromEntries(occ.map((o) => [o.photoId, o]));
    assert.equal(by[steine], undefined, 'rejected: gone');
    assert.deepEqual([by[goldrute].scientificName, by[goldrute].neophyte, by[goldrute].verification], ['Solidago gigantea', 'Spätblühende Goldrute', 'korrigiert']);
    assert.equal(by[unsure].verification, 'bestaetigt');
    assert.deepEqual((await anna.json('/api/occurrences?verified=1')).map((o) => o.photoId).sort(), [springkraut, goldrute, unsure, own].sort());

    const dwc = await anna.text('/api/export/dwc.csv?verified=1');
    const gold = dwc.trim().split('\n').find((l) => l.includes('Solidago gigantea'));
    assert.match(gold, /"Pl@ntNet \(automatisch\), von Hand geprüft \(MyForrest\)",verified,/);
    assert.match(gold, /Von Hand korrigiert am \d{4}-\d{2}-\d{2} \(Pl@ntNet schlug Solidago canadensis vor\)/);
    assert.ok(!dwc.includes('Buddleja'));
    const inat = await anna.text('/api/export/inaturalist.csv');
    assert.match(inat, /von Hand bestätigt am/);

    // Undo by whoever reviewed (or moderation): the finding is automatic again.
    assert.equal((await expert.req(`/api/photos/${goldrute}/identification-review`, { method: 'DELETE' })).status, 204);
    assert.equal((await anna.json('/api/occurrences')).find((o) => o.photoId === goldrute).scientificName, 'Solidago canadensis');
    // Open data marks it too.
    const items = await anna.json('/ogc/collections/findings/items');
    assert.equal(items.features.find((f) => f.properties.photo_id === springkraut).properties.verification, 'bestaetigt');
    assert.equal(items.features.find((f) => f.properties.photo_id === goldrute).properties.verification, 'automatisch');
  });
});
