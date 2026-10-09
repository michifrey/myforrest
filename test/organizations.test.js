'use strict';

// Organisations with several members (src/orgs.js, src/routes/organizations.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createApp } = require('../src/app');
const { createAuth, isPro } = require('../src/auth');

const DAY = 86400000;

async function withServer(fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-orgs-'));
  const mails = [];
  const mailer = { send: async (m) => { mails.push(m); return { sent: true }; } };
  const offline = async () => new Response('offline', { status: 503 });
  const app = createApp({ dataDir, weatherFetch: offline, fetchImpl: offline, routerUrl: '', mailer });
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

function client(base, db) {
  const c = {
    async req(url, { method = 'GET', json, body } = {}) {
      const h = {};
      if (c.cookie) h.Cookie = c.cookie;
      if (c.csrf && method !== 'GET') h['X-CSRF-Token'] = c.csrf;
      if (json !== undefined) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
      const res = await fetch(`${base}${url}`, { method, headers: h, body });
      const set = res.headers.get('set-cookie');
      if (set) c.cookie = set.split(';')[0];
      return res;
    },
    json: async (url, opts) => (await c.req(url, opts)).json(),
    async register(name, { confirmed = true } = {}) {
      const b = await c.json('/api/auth/register', { method: 'POST', json: { email: `${name.toLowerCase()}@example.org`, name, password: 'geheim-1234' } });
      c.csrf = b.csrfToken;
      if (confirmed) db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').run(Date.now(), b.user.id);
      return b.user;
    },
    me: async () => (await c.json('/api/auth/me')).user,
  };
  return c;
}

test('a verified lead adds colleagues, who see protected finds as long as the organisation holds', async () => {
  await withServer(async (base, app, mails) => {
    const db = app.locals.db;
    const admin = client(base, db);
    await admin.register('Admina');
    const lead = client(base, db);
    const leadUser = await lead.register('Förster');
    await lead.json('/api/auth/pro', { method: 'POST', json: { organization: 'Forstrevier  Adlisberg', note: 'Revierförster' } });
    await admin.json(`/api/users/${leadUser.id}/pro`, { method: 'POST', json: { decision: 'verifiziert' } });
    let [org] = await lead.json('/api/organizations/mine');
    assert.deepEqual([org.name, org.role, org.valid, org.members.length], ['Forstrevier Adlisberg', 'leitung', true, 1]);
    assert.equal(org.members[0].email, 'förster@example.org', 'leads see the addresses');

    // A protected find by someone else.
    const ben = client(base, db);
    await ben.register('Benno');
    const fd = new FormData();
    fd.append('photos', new Blob([fs.readFileSync(path.join(__dirname, 'fixtures', 'nogps.jpg'))], { type: 'image/jpeg' }), 'horst.jpg');
    fd.append('lat', '47.37'); fd.append('lon', '8.54'); fd.append('protected', '1');
    const find = (await ben.json('/api/photos', { method: 'POST', body: fd })).created[0];

    const col = client(base, db);
    const colUser = await col.register('Waldarbeiterin');
    assert.equal((await col.req(`/api/spots/${find.spotId}`)).status, 404);
    // Only existing accounts with a confirmed address; by name or e-mail.
    const unconfirmed = client(base, db);
    await unconfirmed.register('Neuling', { confirmed: false });
    assert.equal((await lead.req(`/api/organizations/${org.id}/members`, { method: 'POST', json: { account: 'Neuling' } })).status, 404);
    assert.equal((await lead.req(`/api/organizations/${org.id}/members`, { method: 'POST', json: { account: 'niemand@example.org' } })).status, 404);
    const added = await lead.req(`/api/organizations/${org.id}/members`, { method: 'POST', json: { account: 'waldarbeiterin@example.org' } });
    assert.equal(added.status, 201);
    assert.equal((await added.json()).members.length, 2);
    assert.equal(mails.at(-1).to, 'waldarbeiterin@example.org');
    assert.match(mails.at(-1).subject, /Mitglied von Forstrevier Adlisberg/);
    assert.equal((await lead.req(`/api/organizations/${org.id}/members`, { method: 'POST', json: { account: 'Waldarbeiterin' } })).status, 409);

    let me = await col.me();
    assert.deepEqual([me.pro, me.organization, me.proViaOrganization, me.proStatus], [true, 'Forstrevier Adlisberg', true, null]);
    assert.equal(me.organizations[0].role, 'mitglied');
    assert.equal((await col.req(`/api/spots/${find.spotId}`)).status, 200);
    // Members see the names, not the addresses, and cannot add anyone.
    [org] = await col.json('/api/organizations/mine');
    assert.equal(org.members.find((m) => m.id === leadUser.id).email, undefined);
    assert.equal((await col.req(`/api/organizations/${org.id}/members`, { method: 'POST', json: { account: 'Benno' } })).status, 403);
    // Strangers do not see the organisation at all.
    assert.equal((await ben.req(`/api/organizations/${org.id}/members/${colUser.id}`, { method: 'DELETE' })).status, 404);

    // The lead's verification runs out: the members lose access too; the reminder said so.
    db.prepare('UPDATE users SET pro_valid_until = ? WHERE id = ?').run(Date.now() + 21 * DAY, leadUser.id);
    assert.equal(await app.locals.remindPro(), 1);
    assert.match(mails.at(-1).text, /1 weiteren Mitglieder/);
    db.prepare('UPDATE users SET pro_valid_until = ? WHERE id = ?').run(Date.now() - DAY, leadUser.id);
    me = await col.me();
    assert.equal(me.pro, false);
    assert.equal((await col.req(`/api/spots/${find.spotId}`)).status, 404);
    assert.equal((await lead.req(`/api/organizations/${org.id}/members`, { method: 'POST', json: { account: 'Benno' } })).status, 409, 'an organisation run out passes nothing on');
    // Renewed: back.
    await lead.json('/api/auth/pro', { method: 'POST', json: { organization: 'Forstrevier Adlisberg' } });
    await admin.json(`/api/users/${leadUser.id}/pro`, { method: 'POST', json: { decision: 'verifiziert' } });
    assert.equal((await col.req(`/api/spots/${find.spotId}`)).status, 200);

    // Handing on the lead: the last lead cannot leave first; then the old lead leaves.
    assert.equal((await lead.req(`/api/organizations/${org.id}/members/${leadUser.id}`, { method: 'DELETE' })).status, 409);
    assert.equal((await lead.req(`/api/organizations/${org.id}/members/${leadUser.id}`, { method: 'PATCH', json: { role: 'mitglied' } })).status, 409);
    assert.equal((await lead.req(`/api/organizations/${org.id}/members/${colUser.id}`, { method: 'PATCH', json: { role: 'leitung' } })).status, 200);
    assert.equal((await lead.req(`/api/organizations/${org.id}/members/${leadUser.id}`, { method: 'DELETE' })).status, 200);
    // The new lead is not verified personally, so the organisation does not hold any more.
    me = await col.me();
    assert.deepEqual([me.pro, me.organizations[0].role, me.organizations[0].valid], [false, 'leitung', false]);

    // Admins see every organisation and the log has each step.
    const all = await admin.json('/api/organizations');
    assert.deepEqual(all.map((o) => [o.name, o.members.length]), [['Forstrevier Adlisberg', 1]]);
    const users = await admin.json('/api/users');
    assert.equal(users.find((u) => u.id === colUser.id).organizations[0].name, 'Forstrevier Adlisberg');
    const log = (await admin.json('/api/moderation/log')).map((l) => l.action);
    for (const a of ['org-aufgenommen', 'org-rolle', 'org-verlassen']) assert.ok(log.includes(a), a);

    // The member leaves too: the organisation is gone.
    assert.deepEqual(await col.json(`/api/organizations/${org.id}/members/${colUser.id}`, { method: 'DELETE' }), []);
    assert.deepEqual(await admin.json('/api/organizations'), []);
  });
});

test('verifications from before organisations: each verified account leads the organisation it named', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  // A database of the previous version: accounts with PRO, no organisation tables yet.
  createAuth(db);
  db.exec('DROP TABLE org_members; DROP TABLE organizations');
  const add = db.prepare("INSERT INTO users (email, name, password_hash, role, created_at, pro_status, organization, pro_valid_until) VALUES (?, ?, 'x', 'user', 0, ?, ?, ?)");
  add.run('a@x.ch', 'Anna', 'verifiziert', 'WWF Zürich', Date.now() + 100 * DAY);
  add.run('b@x.ch', 'Beat', 'verifiziert', 'wwf zürich', Date.now() + 200 * DAY);
  add.run('c@x.ch', 'Cla', 'angefragt', 'Pro Natura', null);
  const auth = createAuth(db);
  const all = auth.orgs.all();
  assert.deepEqual(all.map((o) => [o.name, o.members.map((m) => `${m.name}:${m.role}`)]), [['WWF Zürich', ['Anna:leitung', 'Beat:leitung']]]);
  assert.equal(all[0].validUntil, new Date(auth.userById(2).pro_valid_until).toISOString(), 'the latest end among the leads');
  // Once only: someone who leaves is not put back on the next start.
  auth.orgs.removeMember(all[0].id, 1);
  assert.equal(createAuth(db).orgs.all()[0].members.length, 1);
  // An account deleted: its membership goes with it.
  db.prepare('DELETE FROM users WHERE id = 2').run();
  assert.deepEqual(createAuth(db).orgs.of(2), []);
  // A member through the organisation counts as PRO only while it holds.
  const u = { id: 9, pro_status: null, org_pro_until: Date.now() + DAY };
  assert.deepEqual([isPro(u), isPro({ ...u, org_pro_until: Date.now() - DAY })], [true, false]);
  db.close();
});
