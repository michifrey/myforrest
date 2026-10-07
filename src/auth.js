'use strict';

/**
 * Accounts and sessions without external dependencies.
 *
 * - Passwords: scrypt (node:crypto) with a random 16-byte salt per user,
 *   stored as `scrypt$N$r$p$salt$hash`, compared with timingSafeEqual.
 * - Sessions: a random 32-byte token in an httpOnly, SameSite=Lax cookie; the
 *   database only stores its SHA-256, so a leaked database holds no usable
 *   session. Each session carries its own CSRF token.
 * - Login attempts are rate limited in memory per IP and per account.
 */

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scryptAsync = promisify(crypto.scrypt);

const ROLES = ['user', 'moderator', 'admin'];
const SESSION_COOKIE = 'mf_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY,
    email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name            TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash   TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'moderator', 'admin')),
    default_license TEXT,
    created_at      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
`;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const { N, r, p, keylen } = SCRYPT;
  const hash = await scryptAsync(password, salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [kind, N, r, p, salt, hash] = String(stored).split('$');
  if (kind !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
  });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');

/** Parses a Cookie header by hand ("a=1; b=2"). */
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (!key || Object.hasOwn(out, key)) continue;
    try {
      out[key] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[key] = part.slice(i + 1).trim();
    }
  }
  return out;
}

function serializeCookie(name, value, { maxAge, secure } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.floor(maxAge / 1000)}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Fixed-window rate limiter: at most `max` failures per key within `windowMs`.
 * Kept in memory; good enough for a single process.
 */
function createLimiter({ max, windowMs, now = Date.now }) {
  const hits = new Map();
  const entry = (key) => {
    const t = now();
    let e = hits.get(key);
    if (!e || t - e.start >= windowMs) {
      e = { start: t, count: 0 };
      hits.set(key, e);
    }
    if (hits.size > 10000) {
      for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
    }
    return e;
  };
  return {
    /** Seconds until the key may try again, or 0 when it is not blocked. */
    blocked(key) {
      const e = entry(key);
      return e.count >= max ? Math.ceil((e.start + windowMs - now()) / 1000) : 0;
    },
    hit(key) { entry(key).count += 1; },
    reset(key) { hits.delete(key); },
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{1,38}[\p{L}\p{N}]$/u;

/** Account store bound to a database. */
function createAuth(db, { adminEmail = null } = {}) {
  db.exec(SCHEMA);
  // A precomputed hash so that logins for unknown accounts take as long as real ones.
  let dummyHash = null;
  const dummy = async () => (dummyHash ??= await hashPassword(randomToken()));

  const userById = db.prepare('SELECT * FROM users WHERE id = ?');
  const userByLogin = db.prepare('SELECT * FROM users WHERE email = ? OR name = ?');

  async function register({ email, name, password }) {
    email = typeof email === 'string' ? email.trim() : '';
    name = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
    if (!EMAIL_RE.test(email) || email.length > 200) return { error: 'Bitte eine gültige E-Mail-Adresse angeben' };
    if (!NAME_RE.test(name)) {
      return { error: 'Der Name braucht 3–40 Zeichen (Buchstaben, Ziffern, Leerzeichen, . _ -)' };
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
      return { error: 'Das Passwort braucht mindestens 8 Zeichen' };
    }
    // Names cannot contain "@", so a login string never matches both columns of different accounts.
    if (userByLogin.get(email, name)) {
      return { error: 'E-Mail-Adresse oder Name ist bereits vergeben', status: 409 };
    }
    const hash = await hashPassword(password);
    // The configured admin address, or else the very first account, becomes admin.
    const isFirst = !db.prepare('SELECT 1 FROM users LIMIT 1').get();
    const role = adminEmail
      ? (email.toLowerCase() === adminEmail.toLowerCase() ? 'admin' : 'user')
      : (isFirst ? 'admin' : 'user');
    try {
      const id = Number(db.prepare('INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(email, name, hash, role, Date.now()).lastInsertRowid);
      return { user: userById.get(id) };
    } catch {
      // Lost a race against a concurrent registration with the same address or name.
      return { error: 'E-Mail-Adresse oder Name ist bereits vergeben', status: 409 };
    }
  }

  /** Checks the credentials; `login` may be the e-mail address or the name. */
  async function authenticate(login, password) {
    if (typeof login !== 'string' || typeof password !== 'string' || password.length > 200) return null;
    const user = userByLogin.get(login.trim(), login.trim());
    if (!user) {
      await verifyPassword(password, await dummy());
      return null;
    }
    return (await verifyPassword(password, user.password_hash)) ? user : null;
  }

  function createSession(userId) {
    const token = randomToken();
    const csrf = randomToken();
    const t = Date.now();
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(t);
    db.prepare('INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(sha256(token), userId, csrf, t, t + SESSION_TTL_MS);
    return { token, csrf };
  }

  const sessionRow = db.prepare(`
    SELECT s.token_hash, s.csrf_token, s.expires_at, u.*
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?`);

  /** The session for a raw cookie token, or null when unknown or expired. */
  function session(token) {
    if (!token || token.length > 100) return null;
    const row = sessionRow.get(sha256(token));
    if (!row) return null;
    if (row.expires_at < Date.now()) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
      return null;
    }
    const { token_hash: tokenHash, csrf_token: csrf, expires_at: expiresAt, ...user } = row;
    return { tokenHash, csrf, expiresAt, user };
  }

  const destroySession = (tokenHash) => db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);

  return { register, authenticate, createSession, session, destroySession, userById: (id) => userById.get(id) };
}

const isModerator = (user) => Boolean(user && (user.role === 'moderator' || user.role === 'admin'));

/** Public view of an account (never the e-mail of others or the hash). */
const userJson = (u, { self = false } = {}) => (u ? {
  id: u.id,
  name: u.name,
  role: u.role,
  ...(self ? { email: u.email, defaultLicense: u.default_license } : {}),
} : null);

module.exports = {
  ROLES, SESSION_COOKIE, SESSION_TTL_MS,
  hashPassword, verifyPassword, parseCookies, serializeCookie, createLimiter, createAuth, isModerator, userJson,
};
