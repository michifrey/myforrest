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
    // Only existing accounts with a confirmed address; by name or e-mail (unknown addresses get an invitation, see below).
    const unconfirmed = client(base, db);
    await unconfirmed.register('Neuling', { confirmed: false });
    assert.equal((await lead.req(`/api/organizations/${org.id}/members`, { method: 'POST', json: { account: 'Neuling' } })).status, 404);
    assert.equal((await lead.req(`/api/organizations/${org.id}/members`, { method: 'POST', json: { account: 'Niemand' } })).status, 404);
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

test('an invitation by e-mail brings in someone without an account, only with the invited address', async () => {
  await withServer(async (base, app, mails) => {
    const db = app.locals.db;
    const admin = client(base, db);
    await admin.register('Admina');
    const lead = client(base, db);
    const leadUser = await lead.register('Förster');
    await lead.json('/api/auth/pro', { method: 'POST', json: { organization: 'Pro Natura Zürich' } });
    await admin.json(`/api/users/${leadUser.id}/pro`, { method: 'POST', json: { decision: 'verifiziert' } });
    const [org] = await lead.json('/api/organizations/mine');

    // No account with this address: an invitation link instead of an error.
    const res = await lead.req(`/api/organizations/${org.id}/members`, { method: 'POST', json: { account: 'Neu@Example.org' } });
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.invited, 'Neu@Example.org');
    assert.deepEqual(body.organization.invites.map((i) => [i.email, i.role]), [['Neu@Example.org', 'mitglied']]);
    const mail = mails.at(-1);
    assert.equal(mail.to, 'Neu@Example.org');
    assert.match(mail.subject, /Einladung in Pro Natura Zürich/);
    const token = mail.text.match(/#einladung=([\w-]+)/)[1];
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM org_invites').all()).includes(token), 'only the hash is stored');
    // Inviting again replaces the link; the old one is dead.
    await lead.req(`/api/organizations/${org.id}/members`, { method: 'POST', json: { account: 'neu@example.org', role: 'leitung' } });
    const token2 = mails.at(-1).text.match(/#einladung=([\w-]+)/)[1];
    assert.equal((await lead.json(`/api/organizations/mine`))[0].invites.length, 1);
    const anon = client(base, db);
    assert.equal((await anon.req('/api/organizations/invites/lookup', { method: 'POST', json: { token } })).status, 404);
    // The link, before logging in: what it is about.
    const info = await anon.json('/api/organizations/invites/lookup', { method: 'POST', json: { token: token2 } });
    assert.deepEqual([info.organization, info.email, info.role, info.hasAccount], ['Pro Natura Zürich', 'neu@example.org', 'leitung', false]);
    assert.equal((await anon.req('/api/organizations/invites/accept', { method: 'POST', json: { token: token2 } })).status, 401);

    // Someone else with the forwarded link: refused.
    const other = client(base, db);
    await other.register('Fremd');
    assert.equal((await other.req('/api/organizations/invites/accept', { method: 'POST', json: { token: token2 } })).status, 409);
    // The invited person registers (address not confirmed yet) and accepts: member, address confirmed.
    const neu = client(base, db);
    const b = await neu.json('/api/auth/register', { method: 'POST', json: { email: 'neu@example.org', name: 'Neue Person', password: 'geheim-1234' } });
    neu.csrf = b.csrfToken;
    const joined = await neu.json('/api/organizations/invites/accept', { method: 'POST', json: { token: token2 } });
    assert.deepEqual([joined[0].name, joined[0].role], ['Pro Natura Zürich', 'leitung']);
    const me = await neu.me();
    assert.deepEqual([me.pro, me.emailVerified, me.organization], [true, true, 'Pro Natura Zürich']);
    assert.equal((await neu.req('/api/organizations/invites/accept', { method: 'POST', json: { token: token2 } })).status, 404, 'used up');
    assert.equal((await lead.json('/api/organizations/mine'))[0].invites.length, 0);

    // Withdrawing; members do not see invitations; expired ones are gone.
    await lead.req(`/api/organizations/${org.id}/members`, { method: 'POST', json: { account: 'spaeter@example.org' } });
    let mine = (await lead.json('/api/organizations/mine'))[0];
    const col = client(base, db);
    const colUser = await col.register('Kollege');
    await lead.json(`/api/organizations/${org.id}/members`, { method: 'POST', json: { account: 'Kollege' } });
    assert.equal((await col.json('/api/organizations/mine'))[0].invites, undefined);
    assert.ok(colUser.id);
    assert.equal((await lead.req(`/api/organizations/${org.id}/invites/${mine.invites[0].id}`, { method: 'DELETE' })).status, 200);
    await lead.req(`/api/organizations/${org.id}/members`, { method: 'POST', json: { account: 'alt@example.org' } });
    const oldToken = mails.at(-1).text.match(/#einladung=([\w-]+)/)[1];
    db.prepare('UPDATE org_invites SET expires_at = ?').run(Date.now() - 1);
    mine = (await lead.json('/api/organizations/mine'))[0];
    assert.equal(mine.invites.length, 0);
    assert.equal((await anon.req('/api/organizations/invites/lookup', { method: 'POST', json: { token: oldToken } })).status, 404);
    const log = (await admin.json('/api/moderation/log')).map((l) => l.action);
    for (const a of ['org-eingeladen', 'org-einladung-angenommen']) assert.ok(log.includes(a), a);
  });
});
