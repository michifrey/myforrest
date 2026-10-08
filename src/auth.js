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
 * - Accounts may instead (or in addition) sign in with an identity provider
 *   (src/oauth.js); such logins are stored in `identities`. Accounts created
 *   that way have no password (an empty `password_hash`) and a verified e-mail.
 * - E-mail addresses of password accounts are confirmed with a link: a random
 *   token, valid for 24 hours, of which the database again only keeps the SHA-256.
 *   A forgotten password is reset the same way, with a link valid for 1 hour;
 *   resetting ends every session of the account.
 */

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scryptAsync = promisify(crypto.scrypt);

const ROLES = ['user', 'moderator', 'admin'];
const SESSION_COOKIE = 'mf_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const VERIFY_TTL_MS = 24 * 3600 * 1000;
const RESET_TTL_MS = 3600 * 1000;
const TOKEN_TTL_MS = { verify: VERIFY_TTL_MS, reset: RESET_TTL_MS };
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

  CREATE TABLE IF NOT EXISTS identities (
    provider   TEXT NOT NULL,
    subject    TEXT NOT NULL,
    user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    email      TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (provider, subject)
  );
  CREATE INDEX IF NOT EXISTS identities_user ON identities (user_id);

  CREATE TABLE IF NOT EXISTS email_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    purpose    TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
    email      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS email_tokens_user ON email_tokens (user_id, purpose);
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

function serializeCookie(name, value, { maxAge, secure, path = '/' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly', 'SameSite=Lax'];
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
  if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'email_verified_at')) {
    db.exec('ALTER TABLE users ADD COLUMN email_verified_at INTEGER'); // set when an identity provider confirmed the address
  }
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
    try {
      return { user: insertUser({ email, name, hash }) };
    } catch {
      // Lost a race against a concurrent registration with the same address or name.
      return { error: 'E-Mail-Adresse oder Name ist bereits vergeben', status: 409 };
    }
  }

  function insertUser({ email, name, hash, verifiedAt = null }) {
    // The configured admin address, or else the very first account, becomes admin.
    const isFirst = !db.prepare('SELECT 1 FROM users LIMIT 1').get();
    const role = adminEmail
      ? (email.toLowerCase() === adminEmail.toLowerCase() ? 'admin' : 'user')
      : (isFirst ? 'admin' : 'user');
    const id = Number(db.prepare('INSERT INTO users (email, name, password_hash, role, email_verified_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(email, name, hash, role, verifiedAt, Date.now()).lastInsertRowid);
    return userById.get(id);
  }

  /** A free display name derived from the provider's name or the e-mail address. */
  function freeName(wanted, email) {
    let base = String(wanted || email.split('@')[0]).normalize('NFKC')
      .replace(/[^\p{L}\p{N} ._-]+/gu, '').replace(/\s+/g, ' ').slice(0, 34)
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (!NAME_RE.test(base)) base = `Waldfreund${base ? ` ${base}` : ''}`.slice(0, 34).trim();
    for (let i = 1; i < 1000; i += 1) {
      const name = i === 1 ? base : `${base} ${i}`;
      if (NAME_RE.test(name) && !db.prepare('SELECT 1 FROM users WHERE name = ?').get(name)) return name;
    }
    return `Waldfreund ${crypto.randomBytes(3).toString('hex')}`;
  }

  const identityRow = db.prepare('SELECT * FROM identities WHERE provider = ? AND subject = ?');
  const linkIdentity = (provider, profile, userId) => db.prepare(
    'INSERT INTO identities (provider, subject, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(provider, profile.subject, userId, profile.email, Date.now());

  /**
   * Resolves a login through an identity provider. `current` is the account
   * of the browser's session, if any: then the identity is linked to it.
   * Otherwise a known identity logs in, and an unknown one with a verified,
   * unused address creates an account. An address that already belongs to
   * an account is linked automatically only once the account has confirmed
   * it; before that nobody has checked that the account's owner controls it
   * (account pre-hijacking), so its owner logs in with the password and
   * links the provider from the account menu.
   */
  function identityLogin(provider, profile, current = null) {
    const known = identityRow.get(provider, profile.subject);
    const verify = (user) => {
      if (profile.emailVerified && profile.email && !user.email_verified_at && profile.email.toLowerCase() === user.email.toLowerCase()) {
        db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').run(Date.now(), user.id);
      }
      return userById.get(user.id);
    };
    if (current) {
      if (known && known.user_id !== current.id) return { error: 'Diese Anmeldung gehört bereits zu einem anderen Konto', status: 409 };
      if (!known) linkIdentity(provider, profile, current.id);
      return { user: verify(current), linked: !known };
    }
    if (known) return { user: verify(userById.get(known.user_id)) };
    if (!profile.email || !profile.emailVerified || !EMAIL_RE.test(profile.email) || profile.email.length > 200) {
      return { error: 'Der Anbieter hat keine bestätigte E-Mail-Adresse geliefert', status: 400 };
    }
    const sameEmail = db.prepare('SELECT * FROM users WHERE email = ?').get(profile.email);
    if (sameEmail?.email_verified_at) {
      linkIdentity(provider, profile, sameEmail.id);
      return { user: sameEmail, linked: true };
    }
    if (sameEmail) {
      return {
        error: 'Zu dieser E-Mail-Adresse gibt es schon ein Konto. Bitte mit Passwort anmelden und die Anmeldung dann im Konto-Menü verknüpfen.',
        status: 409,
      };
    }
    try {
      const user = insertUser({ email: profile.email, name: freeName(profile.name, profile.email), hash: '', verifiedAt: Date.now() });
      linkIdentity(provider, profile, user.id);
      return { user, created: true };
    } catch {
      return { error: 'Das Konto konnte nicht angelegt werden – bitte erneut versuchen', status: 409 };
    }
  }

  /**
   * A new token for a link to the account's current address, `purpose`
   * 'verify' or 'reset'; earlier ones of the same purpose stop working.
   */
  function createEmailToken(user, purpose = 'verify') {
    const token = randomToken();
    const t = Date.now();
    db.prepare('DELETE FROM email_tokens WHERE (user_id = ? AND purpose = ?) OR expires_at < ?').run(user.id, purpose, t);
    db.prepare('INSERT INTO email_tokens (token_hash, user_id, purpose, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sha256(token), user.id, purpose, user.email, t, t + TOKEN_TTL_MS[purpose]);
    return token;
  }

  const LINK_ERRORS = {
    verify: { invalid: 'Der Bestätigungslink ist ungültig oder wurde schon ersetzt', expired: 'Der Bestätigungslink ist abgelaufen – im Konto-Menü einen neuen anfordern' },
    reset: { invalid: 'Der Link zum Zurücksetzen ist ungültig oder wurde schon benutzt', expired: 'Der Link zum Zurücksetzen ist abgelaufen – bitte einen neuen anfordern' },
  };

  /** The account for a token from a link, or `{ error }`. */
  function tokenUser(token, purpose) {
    const errors = LINK_ERRORS[purpose];
    if (typeof token !== 'string' || !token || token.length > 100) return { error: errors.invalid };
    const row = db.prepare('SELECT * FROM email_tokens WHERE token_hash = ? AND purpose = ?').get(sha256(token), purpose);
    const user = row ? userById.get(row.user_id) : null;
    if (!row || !user) return { error: errors.invalid };
    if (row.expires_at < Date.now()) {
      db.prepare('DELETE FROM email_tokens WHERE token_hash = ?').run(row.token_hash);
      return { error: errors.expired, expired: true };
    }
    // The link went to an address the account no longer has.
    if (row.email.toLowerCase() !== user.email.toLowerCase()) return { error: errors.invalid };
    return { user };
  }

  const markVerified = (user) => {
    if (!user.email_verified_at) db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').run(Date.now(), user.id);
  };

  /** Confirms the address for a token from the link; returns the account or `{ error }`. */
  function confirmEmail(token) {
    const r = tokenUser(token, 'verify');
    if (r.error) return r;
    markVerified(r.user);
    db.prepare("DELETE FROM email_tokens WHERE user_id = ? AND purpose = 'verify'").run(r.user.id);
    return { user: userById.get(r.user.id) };
  }

  /** May this token still reset a password? (to show the form only for live links) */
  const checkResetToken = (token) => tokenUser(token, 'reset');

  /**
   * Sets a new password for the account of a reset token. The link proves
   * control of the address, so it counts as confirmed; all sessions of the
   * account end (whoever knew the old password is logged out) and the token
   * is used up.
   */
  async function resetPassword(token, password) {
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
      return { error: 'Das Passwort braucht mindestens 8 Zeichen', status: 400 };
    }
    const r = tokenUser(token, 'reset');
    if (r.error) return { ...r, status: 400 };
    const hash = await hashPassword(password);
    // Re-check after the (slow) hashing: the token may have been used meanwhile.
    const used = db.prepare("DELETE FROM email_tokens WHERE token_hash = ? AND purpose = 'reset'").run(sha256(token));
    if (!used.changes) return { error: LINK_ERRORS.reset.invalid, status: 400 };
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, r.user.id);
    markVerified(r.user);
    db.prepare('DELETE FROM email_tokens WHERE user_id = ?').run(r.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(r.user.id);
    return { user: userById.get(r.user.id) };
  }

  /**
   * Changes the password of a logged-in account after checking the current
   * one. Every other session of the account ends (the one in `keepTokenHash`
   * stays), and open reset links stop working.
   */
  async function changePassword(user, current, password, keepTokenHash) {
    if (!hasPassword(user)) return { error: 'Dieses Konto hat noch kein Passwort', status: 400 };
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
      return { error: 'Das neue Passwort braucht mindestens 8 Zeichen', status: 400 };
    }
    if (typeof current !== 'string' || current.length > 200 || !(await verifyPassword(current, user.password_hash))) {
      return { error: 'Das aktuelle Passwort stimmt nicht', status: 403, wrong: true };
    }
    const hash = await hashPassword(password);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
    db.prepare("DELETE FROM email_tokens WHERE user_id = ? AND purpose = 'reset'").run(user.id);
    const ended = db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(user.id, keepTokenHash).changes;
    return { user: userById.get(user.id), endedSessions: Number(ended) };
  }

  const userByEmail = (email) => (typeof email === 'string' && EMAIL_RE.test(email.trim()) ? db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim()) : null);

  const identitiesOf = (userId) => db.prepare('SELECT provider FROM identities WHERE user_id = ? ORDER BY provider').all(userId).map((r) => r.provider);

  /** Removes a provider login, unless it is the account's only way to sign in. */
  function unlinkIdentity(user, provider) {
    const linked = identitiesOf(user.id);
    if (!linked.includes(provider)) return { error: 'Diese Anmeldung ist nicht verknüpft', status: 404 };
    if (!hasPassword(user) && linked.length === 1) {
      return { error: 'Das ist die einzige Anmeldung dieses Kontos – zuerst eine andere verknüpfen', status: 400 };
    }
    db.prepare('DELETE FROM identities WHERE user_id = ? AND provider = ?').run(user.id, provider);
    return {};
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

  return {
    register, authenticate, createSession, session, destroySession, identityLogin, identitiesOf, unlinkIdentity,
    createEmailToken, confirmEmail, checkResetToken, resetPassword, changePassword, userByEmail,
    userById: (id) => userById.get(id),
  };
}

const hasPassword = (user) => String(user?.password_hash || '').startsWith('scrypt$');

const isModerator = (user) => Boolean(user && (user.role === 'moderator' || user.role === 'admin'));

/** Public view of an account (never the e-mail of others or the hash). */
const userJson = (u, { self = false, identities } = {}) => (u ? {
  id: u.id,
  name: u.name,
  role: u.role,
  ...(self ? {
    email: u.email,
    emailVerified: Boolean(u.email_verified_at),
    hasPassword: hasPassword(u),
    ...(identities ? { identities } : {}),
    defaultLicense: u.default_license,
  } : {}),
} : null);

module.exports = {
  ROLES, SESSION_COOKIE, SESSION_TTL_MS, VERIFY_TTL_MS, RESET_TTL_MS,
  hashPassword, verifyPassword, parseCookies, serializeCookie, createLimiter, createAuth, isModerator, hasPassword, userJson,
};
