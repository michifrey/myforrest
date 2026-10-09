'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createApp } = require('../src/app');
const { createSensitiveLists } = require('../src/sensitive');
const { createCantons } = require('../src/canton');

const DAY = 86400000;
const CSV = `kanton;art;status;quelle
ZH;Anemone sylvestris;geschützt;Kantonale Naturschutzverordnung ZH
ZH;Dianthus;geschützt (alle Arten);Kantonale Naturschutzverordnung ZH
CH;Saxifraga mutata;VU;Rote Liste Gefässpflanzen 2016
XY;Bellis perennis;–;erfunden
ZH;123;–;kaputt
`;

test('cantonal lists: a species is protected in its canton, everywhere for CH, in any canton when unknown', () => {
  const db = new DatabaseSync(':memory:');
  const lists = createSensitiveLists(db);
  const r = lists.importCsv(CSV, { now: Date.UTC(2026, 9, 8) });
  assert.deepEqual([r.imported, r.cantons], [3, ['CH', 'ZH']]);
  assert.deepEqual(r.skipped.map((s) => [s.line, s.reason.split(' ')[0]]), [[5, 'Unbekannter'], [6, 'Kein']]);
  assert.deepEqual(lists.why('Anemone sylvestris L.', 'ZH'), { list: 'ZH', status: 'geschützt', source: 'Kantonale Naturschutzverordnung ZH' });
  assert.equal(lists.isSensitive('Anemone sylvestris', 'BE'), false, 'not protected in Bern');
  assert.equal(lists.isSensitive('Anemone sylvestris', null), true, 'canton unknown: on the safe side');
  assert.equal(lists.isSensitive('Anemone sylvestris', ''), false, 'outside Switzerland: cantonal lists do not apply');
  assert.equal(lists.isSensitive('Dianthus carthusianorum', 'ZH'), true, 'a whole genus');
  assert.equal(lists.why('Saxifraga mutata', 'GE').list, 'CH');
  assert.equal(lists.why('Cypripedium calceolus', 'BE').list, 'eingebaut');
  assert.equal(lists.isSensitive('Fagus sylvatica', 'ZH'), false);
  assert.deepEqual(lists.status().map((s) => [s.canton, s.entries]), [['CH', 1], ['ZH', 2]]);
  // A new ZH list replaces the old one; CH stays.
  lists.importCsv('kanton,art\nZH,Pulsatilla vulgaris\n');
  assert.equal(lists.isSensitive('Anemone sylvestris', 'ZH'), false);
  assert.deepEqual(lists.status().map((s) => [s.canton, s.entries]), [['CH', 1], ['ZH', 1]]);
  assert.equal(lists.remove('zh'), 1);
  assert.throws(() => lists.importCsv('name;wert\nx;y\n'), /kanton/);
  db.close();
});

/** swisstopo identify stand-in: east of E 2'650'000 is Zurich, west of it Bern, north of N 1'300'000 Germany. */
async function geoAdmin(url) {
  const u = new URL(url);
  if (u.hostname !== 'api3.geo.admin.ch') return new Response('offline', { status: 503 });
  assert.equal(u.searchParams.get('layers'), 'all:ch.swisstopo.swissboundaries3d-kanton-flaeche.fill');
  const [e, n] = u.searchParams.get('geometry').split(',').map(Number);
  if (n > 1300000) return Response.json({ results: [] });
  return Response.json({ results: [{ layerBodId: 'ch.swisstopo.swissboundaries3d-kanton-flaeche.fill', attributes: e > 2650000 ? { ak: 'ZH', name: 'Zürich' } : { ak: 'BE', name: 'Bern' } }] });
}

test('the canton of a spot is looked up once and kept; outside Switzerland it is empty', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE spots (id INTEGER PRIMARY KEY, lat REAL, lon REAL)');
  db.prepare('INSERT INTO spots (lat, lon) VALUES (47.37, 8.54), (46.95, 7.44), (48.2, 8.5)').run();
  let calls = 0;
  const cantons = createCantons({ db, fetchImpl: async (u) => { calls++; return geoAdmin(u); } });
  assert.deepEqual([await cantons.ofSpot(1), await cantons.ofSpot(2), await cantons.ofSpot(3)], ['ZH', 'BE', '']);
  assert.equal(await cantons.ofSpot(1), 'ZH');
  assert.equal(calls, 3, 'stored after the first lookup');
  // The service down: unknown for now, retried later rather than on every request.
  db.prepare('INSERT INTO spots (lat, lon) VALUES (47.0, 8.3)').run();
  const off = createCantons({ db, fetchImpl: async () => { calls++; return new Response('', { status: 502 }); } });
  assert.equal(await off.ofSpot(4), null);
  assert.equal(await off.ofSpot(4), null);
  assert.equal(calls, 4);
  db.close();
});

/** Pl@ntNet stand-in: a pasque-flower relative protected only in some cantons. */
const plantnet = async () => Response.json({ results: [{ score: 0.66, species: { scientificNameWithoutAuthor: 'Anemone sylvestris', commonNames: ['Wald-Windröschen'] } }] });

async function withServer(opts, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-lists-'));
  const mails = [];
  const mailer = { send: async (m) => { mails.push(m); return { sent: true }; } };
  const app = createApp({ dataDir, weatherFetch: geoAdmin, routerUrl: '', plantnetKey: 'test', fetchImpl: plantnet, mailer, ...opts });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, app, mails);
  } finally {
    await app.locals.idle();
    server.close();
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function client(base) {
  const c = {
    async req(url, { method = 'GET', json, body, type } = {}) {
      const h = {};
      if (c.cookie) h.Cookie = c.cookie;
      if (c.csrf && method !== 'GET') h['X-CSRF-Token'] = c.csrf;
      if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
      if (type) h['Content-Type'] = type;
      const res = await fetch(`${base}${url}`, { method, headers: h, body });
      const set = res.headers.get('set-cookie');
      if (set) c.cookie = set.split(';')[0];
      return res;
    },
    json: async (url, opts) => (await c.req(url, opts)).json(),
    async register(name) {
      const b = await c.json('/api/auth/register', { method: 'POST', json: { email: `${name}@example.org`, name, password: 'geheim-1234' } });
      c.csrf = b.csrfToken;
      return b.user;
    },
    upload(lat, lon) {
      const fd = new FormData();
      fd.append('photos', new Blob([fs.readFileSync(path.join(__dirname, 'fixtures', 'nogps.jpg'))], { type: 'image/jpeg' }), 'blume.jpg');
      fd.append('lat', String(lat));
      fd.append('lon', String(lon));
      return c.json('/api/photos', { method: 'POST', body: fd });
    },
  };
  return c;
}

test('a cantonal list protects finds identified in that canton, also ones identified before', async () => {
  await withServer({}, async (base) => {
    const admin = client(base);
    await admin.register('Admina');
    const anna = client(base);
    await anna.register('Anna');
    const zh = (await anna.upload(47.37, 8.54)).created[0];
    const be = (await anna.upload(46.95, 7.44)).created[0];
    // Identified before any list exists: not protected.
    for (const p of [zh, be]) assert.equal((await anna.json(`/api/photos/${p.id}/identify`, { method: 'POST', json: {} })).protected, false);
    // Only admins load lists.
    assert.equal((await anna.req('/api/protected-species/import', { method: 'POST', body: CSV, type: 'text/csv' })).status, 403);
    const r = await admin.json('/api/protected-species/import', { method: 'POST', body: CSV, type: 'text/csv' });
    assert.deepEqual([r.imported, r.cantons, r.protectedPhotos], [3, ['CH', 'ZH'], 1]);
    // The Zurich find is protected now, the one in Bern is not.
    const spotOf = async (p) => anna.json(`/api/spots/${p.spotId}`);
    const zhPhoto = (await spotOf(zh)).photos[0];
    assert.deepEqual([zhPhoto.protected, zhPhoto.protectedReason], [true, 'art']);
    assert.equal((await spotOf(be)).photos[0].protected, false);
    assert.deepEqual(await (await fetch(`${base}/api/protected-species/check?name=Anemone%20sylvestris&spot=${be.spotId}`)).json(),
      { name: 'Anemone sylvestris', canton: 'BE', protected: null });
    assert.deepEqual(await (await fetch(`${base}/api/protected-species`)).json().then((l) => l.map((x) => x.canton)), ['CH', 'ZH']);

    // Released by hand: a new list or a new identification does not protect it again.
    assert.equal((await anna.req(`/api/photos/${zh.id}`, { method: 'PATCH', json: { protected: false } })).status, 200);
    await admin.json('/api/protected-species/import', { method: 'POST', body: CSV, type: 'text/csv' });
    assert.equal((await anna.json(`/api/photos/${zh.id}/identify`, { method: 'POST', json: {} })).protected, false);
    // A new find in Zurich is protected right away.
    const again = (await anna.upload(47.371, 8.541)).created[0];
    assert.equal((await anna.json(`/api/photos/${again.id}/identify`, { method: 'POST', json: {} })).protected, true);
    assert.deepEqual(await admin.json('/api/protected-species/ZH', { method: 'DELETE' }), { removed: 2 });
  });
});

test('PRO holds for a year: reminder a month before, renewal, and no protected finds once run out', async () => {
  await withServer({}, async (base, app, mails) => {
    const db = app.locals.db;
    const admin = client(base);
    await admin.register('Admina');
    const forst = client(base);
    const me = await forst.register('Forst');
    await forst.json('/api/auth/pro', { method: 'POST', json: { organization: 'Forstrevier Adlisberg', note: 'Revierförster' } });
    await admin.json(`/api/users/${me.id}/pro`, { method: 'POST', json: { decision: 'verifiziert' } });
    let self = (await forst.json('/api/auth/me')).user;
    assert.equal(self.pro, true);
    const days = (Date.parse(self.proValidUntil) - Date.now()) / DAY;
    assert.ok(days > 364.9 && days < 365.1, `valid for ${days} days`);
    assert.equal(self.proRenewable, false);
    // Too early to renew.
    assert.equal((await forst.req('/api/auth/pro', { method: 'POST', json: { organization: 'Forstrevier Adlisberg' } })).status, 409);

    // A protected find by someone else.
    const ben = client(base);
    await ben.register('Benno');
    const fd = new FormData();
    fd.append('photos', new Blob([fs.readFileSync(path.join(__dirname, 'fixtures', 'nogps.jpg'))], { type: 'image/jpeg' }), 'horst.jpg');
    fd.append('lat', '47.37'); fd.append('lon', '8.54'); fd.append('protected', '1');
    const find = (await ben.json('/api/photos', { method: 'POST', body: fd })).created[0];
    assert.equal((await forst.req(`/api/spots/${find.spotId}`)).status, 200);

    // Three weeks before the end: one reminder, not two.
    db.prepare('UPDATE users SET pro_valid_until = ? WHERE id = ?').run(Date.now() + 21 * DAY, me.id);
    assert.equal(await app.locals.remindPro(), 1);
    assert.equal(await app.locals.remindPro(), 0);
    assert.match(mails.at(-1).subject, /läuft am .* ab/);
    assert.match(mails.at(-1).text, /Forstrevier Adlisberg/);
    self = (await forst.json('/api/auth/me')).user;
    assert.deepEqual([self.pro, self.proRenewable], [true, true]);

    // Run out: no more protected finds, one more e-mail.
    // (Time passes: the reminder went out three weeks before the end, which was yesterday.)
    db.prepare('UPDATE users SET pro_valid_until = ?, pro_reminded_at = ? WHERE id = ?').run(Date.now() - DAY, Date.now() - 22 * DAY, me.id);
    self = (await forst.json('/api/auth/me')).user;
    assert.deepEqual([self.pro, self.proExpired], [false, true]);
    assert.equal((await forst.req(`/api/spots/${find.spotId}`)).status, 404);
    assert.equal(await app.locals.remindPro(), 1);
    assert.match(mails.at(-1).subject, /abgelaufen/);

    // Renewal: the member confirms, an admin renews for a year from today.
    const renewed = await forst.json('/api/auth/pro', { method: 'POST', json: { organization: 'Forstrevier Adlisberg', note: 'unverändert' } });
    assert.ok(renewed.proRenewalRequestedAt);
    const list = await admin.json('/api/users');
    assert.ok(list.find((u) => u.id === me.id).proRenewalRequestedAt);
    assert.equal(list.find((u) => u.id === me.id).proExpired, true);
    await admin.json(`/api/users/${me.id}/pro`, { method: 'POST', json: { decision: 'verifiziert' } });
    self = (await forst.json('/api/auth/me')).user;
    assert.deepEqual([self.pro, self.proExpired, self.proRenewalRequestedAt], [true, false, null]);
    assert.ok(Date.parse(self.proValidUntil) - Date.now() > 364 * DAY);
    assert.equal((await forst.req(`/api/spots/${find.spotId}`)).status, 200);
  });
});
