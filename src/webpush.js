'use strict';

/*
 * Web Push without dependencies: VAPID authentication (RFC 8292) and
 * message encryption (RFC 8291, aes128gcm content coding of RFC 8188), with
 * node:crypto.
 *
 *   const keys = generateVapidKeys();                 // once, then stored
 *   await sendNotification(subscription, JSON.stringify(message), { vapid: { ...keys, subject } });
 *
 * `subscription` is what the browser's PushManager.subscribe() returns:
 * { endpoint, keys: { p256dh, auth } } (base64url). The push service answers
 * 201 when it accepted the message; 404 and 410 mean the subscription is gone.
 */

const crypto = require('node:crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');
const RECORD_SIZE = 4096;

/** A new VAPID key pair: { publicKey (65-byte uncompressed point), privateKey (32 bytes) }, base64url. */
function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

/** The private key as a KeyObject (JWK needs the public coordinates too). */
function privateKeyObject(publicKey, privateKey) {
  const pub = fromB64u(publicKey);
  return crypto.createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: privateKey },
  });
}

/**
 * The Authorization header for a push service (RFC 8292): a JWT signed with
 * ES256 for the endpoint's origin, valid `ttlS` seconds, plus the public key.
 */
function vapidAuthorization(endpoint, { publicKey, privateKey, subject }, { now = Date.now(), ttlS = 12 * 3600 } = {}) {
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + ttlS, sub: subject }));
  const data = `${header}.${claims}`;
  const signature = crypto.sign('sha256', Buffer.from(data), { key: privateKeyObject(publicKey, privateKey), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${data}.${b64u(signature)}, k=${publicKey}`;
}

/**
 * Encrypts `payload` for a subscription's keys (RFC 8291) as one aes128gcm
 * record: salt (16) | record size (4) | key id length (1) | server public key (65) | ciphertext.
 * `salt` and `serverKeys` ({ publicKey, privateKey } base64url) are for tests only.
 */
function encrypt(payload, { p256dh, auth }, { salt = crypto.randomBytes(16), serverKeys = null } = {}) {
  const uaPublic = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('p256dh ist kein P-256-Schlüssel');
  if (authSecret.length !== 16) throw new Error('auth muss 16 Bytes lang sein');
  const ecdh = crypto.createECDH('prime256v1');
  if (serverKeys) ecdh.setPrivateKey(fromB64u(serverKeys.privateKey));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);
  const hkdf = (ikm, saltBytes, info, length) => Buffer.from(crypto.hkdfSync('sha256', ikm, saltBytes, info, length));
  const ikm = hkdf(secret, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const plain = Buffer.concat([Buffer.from(payload), Buffer.from([2])]); // 2: last record, no padding
  if (plain.length + 16 > RECORD_SIZE) throw new Error('Nachricht zu lang für einen Datensatz');
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  const head = Buffer.alloc(21);
  Buffer.from(salt).copy(head, 0);
  head.writeUInt32BE(RECORD_SIZE, 16);
  head.writeUInt8(asPublic.length, 20);
  return Buffer.concat([head, asPublic, body]);
}

/**
 * Sends one push message. Resolves to { status, gone } (`gone`: the
 * subscription expired or was revoked and should be deleted); rejects on
 * network errors.
 */
async function sendNotification(subscription, payload, { vapid, fetchImpl = fetch, ttlS = 24 * 3600, urgency = 'normal', topic = null, timeoutMs = 15000, now } = {}) {
  const body = encrypt(payload, subscription.keys);
  const headers = {
    TTL: String(ttlS),
    Urgency: urgency,
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    Authorization: vapidAuthorization(subscription.endpoint, vapid, { now }),
  };
  if (topic) headers.Topic = topic; // replaces an undelivered message with the same topic
  const res = await fetchImpl(subscription.endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) });
  await res.arrayBuffer().catch(() => null);
  return { status: res.status, ok: res.status >= 200 && res.status < 300, gone: res.status === 404 || res.status === 410 };
}

module.exports = { generateVapidKeys, vapidAuthorization, encrypt, sendNotification, privateKeyObject };
