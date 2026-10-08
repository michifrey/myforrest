'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { encrypt, vapidAuthorization, generateVapidKeys } = require('../src/webpush');

/** A browser's side of a subscription: its keys, and decryption as in RFC 8291. */
function browserKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
    decrypt(body) {
      const salt = body.subarray(0, 16);
      const idLen = body.readUInt8(20);
      const asPublic = body.subarray(21, 21 + idLen);
      const hkdf = (ikm, s, info, n) => Buffer.from(crypto.hkdfSync('sha256', ikm, s, info, n));
      const ikm = hkdf(ecdh.computeSecret(asPublic), auth, Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), asPublic]), 32);
      const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
      const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
      const data = body.subarray(21 + idLen);
      const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
      d.setAuthTag(data.subarray(data.length - 16));
      const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
      assert.equal(plain[plain.length - 1], 2, 'last-record delimiter');
      return JSON.parse(plain.subarray(0, plain.length - 1).toString());
    },
  };
}

test('message encryption matches the example of RFC 8291, and the VAPID token verifies', () => {
  const body = encrypt('When I grow up, I want to be a watermelon', {
    p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  }, { salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'), serverKeys: { privateKey: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw' } });
  assert.equal(body.toString('base64url'), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');

  const b = browserKeys();
  assert.deepEqual(b.decrypt(encrypt(JSON.stringify({ hallo: 'Wald' }), b.keys)), { hallo: 'Wald' });
  assert.throws(() => encrypt('x', { p256dh: 'AAAA', auth: b.keys.auth }), /P-256/);

  const vapid = { ...generateVapidKeys(), subject: 'mailto:wald@example.org' };
  const now = Date.UTC(2026, 9, 8);
  const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', vapid, { now });
  const [, jwt, k] = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, vapid.publicKey);
  const [h, c, sig] = jwt.split('.');
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.deepEqual(claims, { aud: 'https://fcm.googleapis.com', exp: now / 1000 + 12 * 3600, sub: 'mailto:wald@example.org' });
  const pub = Buffer.from(vapid.publicKey, 'base64url');
  const key = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') } });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
});

/** Same helper as in accounts.test.js: keeps the session cookie and sends the CSRF token. */
function client(base) {
  const c = {
    cookie: null,
    csrf: null,
    async req(url, { method = 'GET', json } = {}) {
      const headers = {};
      if (c.cookie) headers.Cookie = c.cookie;
      if (c.csrf && method !== 'GET') headers['X-CSRF-Token'] = c.csrf;
      if (json !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(`${base}${url}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
      const set = res.headers.get('set-cookie');
      if (set) c.cookie = set.split(';')[0];
      return res;
    },
    async register(email, name) {
      const res = await c.req('/api/auth/register', { method: 'POST', json: { email, name, password: 'geheim-1234' } });
      const b = await res.json();
      c.csrf = b.csrfToken;
      c.id = b.user.id;
      return c;
    },
  };
  return c;
}

test('new early warnings go to regular visitors and followers, once, and not to who muted the spot', async () => {
  // A stand-in push service: records each message, answers 410 for a revoked subscription.
  const received = [];
  const service = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      received.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(req.url === '/gone' ? 410 : 201).end();
    });
  });
  service.listen(0);
  await new Promise((r) => service.once('listening', r));
  const pushBase = `http://127.0.0.1:${service.address().port}`;

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-push-'));
  const offline = async () => new Response('offline', { status: 503 });
  const app = createApp({ dataDir, weatherFetch: offline, tileOptions: { precompute: false }, pushOptions: { allowedHosts: ['127.0.0.1'], allowHttp: true } });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const db = app.locals.db;
  try {
    const anna = await client(base).register('anna@example.org', 'Anna');
    const ben = await client(base).register('ben@example.org', 'Ben');
    const carla = await client(base).register('carla@example.org', 'Carla');
    const devices = {};
    const subscribe = async (who, name) => {
      devices[name] = browserKeys();
      return who.req('/api/push/subscriptions', { method: 'POST', json: { endpoint: `${pushBase}/${name}`, keys: devices[name].keys } });
    };
    assert.equal((await subscribe(anna, 'anna')).status, 201);
    assert.equal((await subscribe(anna, 'gone')).status, 201);
    assert.equal((await subscribe(ben, 'ben')).status, 201);
    assert.equal((await subscribe(carla, 'carla')).status, 201);
    assert.equal((await (await anna.req('/api/push')).json()).subscriptions, 2);
    // Only https endpoints of push services (here also the local stand-in), and well-formed keys.
    const bad = (endpoint, keys = devices.anna.keys) => anna.req('/api/push/subscriptions', { method: 'POST', json: { endpoint, keys } });
    assert.equal((await bad('https://evil.example.org/x')).status, 400);
    assert.equal((await bad('https://fcm.googleapis.com.evil.example.org/x')).status, 400);
    assert.equal((await bad('https://user:pw@fcm.googleapis.com/x')).status, 400);
    assert.equal((await bad(`${pushBase}/x`, { p256dh: 'abc', auth: 'abc' })).status, 400);
    assert.equal((await client(base).req('/api/push/subscriptions', { method: 'POST', json: { endpoint: `${pushBase}/x`, keys: devices.anna.keys } })).status, 401);

    // A spot Anna and Carla photographed on two days (regular), Ben once; NDVI 0.86 every year, now 0.70.
    const now = Date.now();
    const spot = Number(db.prepare('INSERT INTO spots (lat, lon, created_at) VALUES (47.36, 8.58, ?)').run(now).lastInsertRowid);
    const photo = (user, iso) => db.prepare(`INSERT INTO photos (spot_id, file, taken_at, lat, lon, location_source, created_at, uploader_id)
      VALUES (?, ?, ?, 47.36, 8.58, 'exif', ?, ?)`).run(spot, `p-${user}-${iso}.jpg`, now - Number(iso) * 86400000, now, user);
    photo(anna.id, '400'); photo(anna.id, '200');
    photo(carla.id, '410'); photo(carla.id, '210');
    photo(ben.id, '300');
    db.prepare(`INSERT INTO spot_ndvi (spot_id, lat, lon, from_date, to_date, fetched_at, complete) VALUES (?, 47.36, 8.58, '2020-01-01', ?, ?, 1)`)
      .run(spot, new Date(now).toISOString().slice(0, 10), now);
    const scene = db.prepare(`INSERT INTO spot_ndvi_scenes (spot_id, scene_id, date, cloud, ndvi, ndmi, sensor, v, clear_fraction) VALUES (?, ?, ?, 5, ?, NULL, 'S2', 2, 1)`);
    const d = new Date(now);
    const ym = (y) => `${y}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    for (const y of [1, 2, 3]) scene.run(spot, `s${y}`, `${ym(d.getUTCFullYear() - y)}-05`, 0.86);
    scene.run(spot, 'now', `${ym(d.getUTCFullYear())}-01`, 0.7);

    const follow = async (who) => (await who.req(`/api/spots/${spot}/follow`)).json();
    assert.deepEqual(await follow(anna), { mode: null, regular: true, days: 2, regularDays: 2, notified: true, subscriptions: 2 });
    assert.equal((await follow(ben)).notified, false, 'one visit is not regular');
    // Ben follows the spot, Carla mutes it.
    assert.equal((await (await ben.req(`/api/spots/${spot}/follow`, { method: 'PUT', json: { mode: 'folgen' } })).json()).notified, true);
    assert.equal((await (await carla.req(`/api/spots/${spot}/follow`, { method: 'PUT', json: { mode: 'stumm' } })).json()).notified, false);
    assert.equal((await ben.req(`/api/spots/${spot}/follow`, { method: 'PUT', json: { mode: 'immer' } })).status, 400);

    await app.locals.satelliteWatch();
    const paths = received.map((r) => r.path).sort();
    assert.deepEqual(paths, ['/anna', '/ben', '/gone']);
    const toAnna = received.find((r) => r.path === '/anna');
    assert.equal(toAnna.headers['content-encoding'], 'aes128gcm');
    assert.match(toAnna.headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    const message = devices.anna.decrypt(toAnna.body);
    assert.equal(message.title, `Satellit: Rückgang an Spot ${spot}`);
    assert.match(message.body, /^NDVI \(Grün\) 0\.16 unter den Vorjahren seit \w+ \d{4}\. Ein neues Foto/);
    assert.equal(message.url, `./?spot=${spot}`);
    assert.equal(devices.ben.decrypt(received.find((r) => r.path === '/ben').body).title, message.title);
    // The revoked subscription is gone; the warning is not sent twice.
    assert.equal((await (await anna.req('/api/push')).json()).subscriptions, 1);
    await app.locals.satelliteWatch();
    assert.equal(received.length, 3);

    // A test message on request, and unsubscribing.
    assert.deepEqual(await (await ben.req('/api/push/test', { method: 'POST' })).json(), { delivered: 1 });
    assert.equal(devices.ben.decrypt(received.at(-1).body).title, 'MyForrest: Testnachricht');
    await ben.req('/api/push/subscriptions', { method: 'DELETE', json: { endpoint: `${pushBase}/ben` } });
    assert.deepEqual(await (await ben.req('/api/push/test', { method: 'POST' })).json(), { delivered: 0 });
  } finally {
    await app.locals.idle();
    server.close();
    service.close();
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('without test options only https endpoints of known push services are accepted', () => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const noop = () => {};
  const push = require('../src/routes/push')({ get: noop, post: noop, put: noop, delete: noop }, { db, idParam: noop, allowedHosts: [] });
  const ok = (u) => push.endpointAllowed(u);
  assert.ok(ok('https://fcm.googleapis.com/fcm/send/abc'));
  assert.ok(ok('https://updates.push.services.mozilla.com/wpush/v2/abc'));
  assert.ok(ok('https://web.push.apple.com/QK7abc'));
  assert.ok(ok('https://wns2-par02p.notify.windows.com/w/?token=abc'));
  for (const u of ['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://evilfcm.googleapis.com.example.org/x', 'https://notify.windows.com.evil.org/x', 'javascript:alert(1)', 'kein-url']) {
    assert.equal(ok(u), false, u);
  }
  db.close();
});
