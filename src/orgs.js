'use strict';

/**
 * Organisations with several members (forest services, cantonal offices,
 * nature NGOs). An organisation comes into being when an admin verifies a PRO
 * application: the applicant leads it ("leitung"). The leads add colleagues
 * with an account ("mitglied"), who then see protected finds without applying
 * themselves, and hand the lead on.
 *
 * An organisation holds as long as at least one of its leads is verified
 * personally: its end is the latest `pro_valid_until` among them. The yearly
 * confirmation thus stays with the leads (renewal in src/routes/accounts.js);
 * when it runs out or is revoked, the members lose access as well.
 */

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS organizations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS org_members (
    org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('leitung', 'mitglied')),
    added_at INTEGER NOT NULL,
    added_by INTEGER,
    PRIMARY KEY (org_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS org_members_user ON org_members(user_id);
  -- Invitations for people without an account (yet): a link by e-mail, only its SHA-256 is stored.
  CREATE TABLE IF NOT EXISTS org_invites (
    id INTEGER PRIMARY KEY,
    org_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email TEXT NOT NULL COLLATE NOCASE,
    role TEXT NOT NULL CHECK (role IN ('leitung', 'mitglied')),
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    created_by INTEGER,
    expires_at INTEGER NOT NULL,
    UNIQUE (org_id, email)
  );
`;

const crypto = require('node:crypto');

const ROLES = ['leitung', 'mitglied'];
const INVITE_TTL_MS = 14 * 86400000;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const MAX_MEMBERS = 200;

/** Same organisation whatever the case and spacing: "WWF  zürich" = "WWF Zürich". */
const nameKey = (name) => String(name || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('de-CH');

/** SQL for the end of an organisation (alias of organizations.id given): the latest end among its verified leads. */
const validUntilSql = (orgId) => `(SELECT MAX(l.pro_valid_until) FROM org_members lm JOIN users l ON l.id = lm.user_id
  WHERE lm.org_id = ${orgId} AND lm.role = 'leitung' AND l.pro_status = 'verifiziert')`;

const hasTable = (db) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'org_members'").get());

/**
 * Adds to a user row what it has through organisations: `org_pro_until` (the
 * latest end among its organisations) and `org_name` (that organisation).
 */
function withOrgPro(db, user) {
  if (!user || !hasTable(db)) return user;
  const best = db.prepare(`SELECT o.name, ${validUntilSql('o.id')} AS until FROM org_members m JOIN organizations o ON o.id = m.org_id
    WHERE m.user_id = ? ORDER BY until DESC LIMIT 1`).get(user.id);
  return { ...user, org_pro_until: best?.until ?? null, org_name: best?.name ?? null };
}

function createOrganizations(db) {
  const fresh = !hasTable(db);
  db.exec(SCHEMA);
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  const byKey = db.prepare('SELECT * FROM organizations WHERE name_key = ?');
  const byId = db.prepare(`SELECT o.*, ${validUntilSql('o.id')} AS valid_until FROM organizations o WHERE o.id = ?`);
  const membership = db.prepare('SELECT * FROM org_members WHERE org_id = ? AND user_id = ?');

  /** The organisation of this name, created when new. */
  function ensure(name) {
    const clean = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 160);
    if (clean.length < 2) return null;
    const found = byKey.get(nameKey(clean));
    if (found) return found.id;
    return Number(db.prepare('INSERT INTO organizations (name, name_key, created_at) VALUES (?, ?, ?)').run(clean, nameKey(clean), Date.now()).lastInsertRowid);
  }

  const get = (id) => byId.get(id) || null;
  const roleOf = (orgId, userId) => membership.get(orgId, userId)?.role || null;

  /** Members and open invitations together (for MAX_MEMBERS). */
  const size = (orgId) => db.prepare(`SELECT (SELECT COUNT(*) FROM org_members WHERE org_id = ?)
    + (SELECT COUNT(*) FROM org_invites WHERE org_id = ? AND expires_at > ?) AS n`).get(orgId, orgId, Date.now()).n;

  /** Adds an account or changes its role; returns false when the organisation is full. */
  function setMember(orgId, userId, role, by = null) {
    if (!ROLES.includes(role)) throw new Error(`Rolle muss eine von ${ROLES.join(', ')} sein`);
    if (membership.get(orgId, userId)) {
      db.prepare('UPDATE org_members SET role = ? WHERE org_id = ? AND user_id = ?').run(role, orgId, userId);
      return true;
    }
    if (size(orgId) >= MAX_MEMBERS) return false;
    db.prepare('INSERT INTO org_members (org_id, user_id, role, added_at, added_by) VALUES (?, ?, ?, ?, ?)').run(orgId, userId, role, Date.now(), by);
    return true;
  }

  /** Removes a member; an organisation without members is removed too. */
  function removeMember(orgId, userId) {
    const n = db.prepare('DELETE FROM org_members WHERE org_id = ? AND user_id = ?').run(orgId, userId).changes;
    db.prepare('DELETE FROM organizations WHERE id = ? AND NOT EXISTS (SELECT 1 FROM org_members WHERE org_id = ?)').run(orgId, orgId);
    return n > 0;
  }

  const leads = (orgId) => db.prepare("SELECT COUNT(*) AS n FROM org_members WHERE org_id = ? AND role = 'leitung'").get(orgId).n;

  /** A verified PRO application: the applicant leads the organisation of that name. */
  function verified(userId, organization, by) {
    const orgId = ensure(organization);
    if (orgId) setMember(orgId, userId, 'leitung', by);
    return orgId;
  }

  /** The members of an organisation (`withEmail` for its leads and admins). */
  function members(orgId, { withEmail = false } = {}) {
    return db.prepare(`SELECT u.id, u.name, u.email, u.pro_status, u.pro_valid_until, m.role, m.added_at
      FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY m.role, u.name COLLATE NOCASE`).all(orgId)
      .map((m) => ({
        id: m.id,
        name: m.name,
        ...(withEmail ? { email: m.email } : {}),
        role: m.role,
        // A lead counts for the organisation's validity only while verified personally.
        verified: m.pro_status === 'verifiziert' && Boolean(m.pro_valid_until && m.pro_valid_until > Date.now()),
        addedAt: iso(m.added_at),
      }));
  }

  /** An organisation as JSON. */
  function json(org, opts) {
    const until = org.valid_until ?? null;
    return {
      id: org.id,
      name: org.name,
      validUntil: iso(until),
      valid: Boolean(until && until > Date.now()),
      createdAt: iso(org.created_at),
      members: members(org.id, opts),
      // Open invitations: for the lead and admins only.
      ...(opts?.withEmail ? { invites: invites(org.id) } : {}),
    };
  }

  /* ---------- Invitations for people without an account ---------- */

  const invites = (orgId) => db.prepare('SELECT id, email, role, created_at, expires_at FROM org_invites WHERE org_id = ? AND expires_at > ? ORDER BY email')
    .all(orgId, Date.now()).map((i) => ({ id: i.id, email: i.email, role: i.role, createdAt: iso(i.created_at), expiresAt: iso(i.expires_at) }));

  /**
   * Invites an address; a new invitation to the same address replaces the
   * old one. Returns the token for the link, or null when the organisation is full.
   */
  function invite(orgId, email, role, by) {
    if (!ROLES.includes(role)) throw new Error(`Rolle muss eine von ${ROLES.join(', ')} sein`);
    const old = db.prepare('SELECT id FROM org_invites WHERE org_id = ? AND email = ?').get(orgId, email);
    if (!old && size(orgId) >= MAX_MEMBERS) return null;
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    db.prepare('DELETE FROM org_invites WHERE org_id = ? AND email = ?').run(orgId, email);
    db.prepare('INSERT INTO org_invites (org_id, email, role, token_hash, created_at, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(orgId, email, role, sha256(token), now, by, now + INVITE_TTL_MS);
    return token;
  }

  /** The open invitation behind a link (with the organisation's name), or null. */
  function inviteByToken(token) {
    if (typeof token !== 'string' || token.length > 100) return null;
    return db.prepare(`SELECT i.*, o.name AS org_name FROM org_invites i JOIN organizations o ON o.id = i.org_id
      WHERE i.token_hash = ? AND i.expires_at > ?`).get(sha256(token), Date.now()) || null;
  }

  /** Accepting: the account joins (its role stays if it is already a member) and the invitation is used up. */
  function acceptInvite(inv, userId) {
    if (!roleOf(inv.org_id, userId)) {
      db.prepare('INSERT INTO org_members (org_id, user_id, role, added_at, added_by) VALUES (?, ?, ?, ?, ?)').run(inv.org_id, userId, inv.role, Date.now(), inv.created_by);
    }
    db.prepare('DELETE FROM org_invites WHERE id = ?').run(inv.id);
  }

  const withdrawInvite = (orgId, inviteId) => db.prepare('DELETE FROM org_invites WHERE org_id = ? AND id = ?').run(orgId, inviteId).changes > 0;

  /** The organisations of an account, with its role in each. */
  function of(userId, { withMembers = false } = {}) {
    return db.prepare(`SELECT o.*, m.role, ${validUntilSql('o.id')} AS valid_until FROM org_members m JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = ? ORDER BY o.name COLLATE NOCASE`).all(userId)
      .map((o) => (withMembers ? { ...json(o, { withEmail: o.role === 'leitung' }), role: o.role }
        : { id: o.id, name: o.name, role: o.role, validUntil: iso(o.valid_until), valid: Boolean(o.valid_until && o.valid_until > Date.now()) }));
  }

  /** All organisations with members (admins; one whose last account was deleted is left out). */
  const all = () => db.prepare(`SELECT o.*, ${validUntilSql('o.id')} AS valid_until FROM organizations o
    WHERE EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = o.id) ORDER BY o.name COLLATE NOCASE`).all()
    .map((o) => json(o, { withEmail: true }));

  /** Members who see protected finds only through an organisation that a lead has: their count. */
  function dependants(leadId) {
    return db.prepare(`SELECT COUNT(DISTINCT m.user_id) AS n FROM org_members lm JOIN org_members m ON m.org_id = lm.org_id
      WHERE lm.user_id = ? AND lm.role = 'leitung' AND m.user_id != ?`).get(leadId, leadId).n;
  }

  // Verifications from before organisations existed (once): each verified account leads the organisation it named.
  if (fresh) {
    for (const u of db.prepare("SELECT id, organization FROM users WHERE pro_status = 'verifiziert' AND organization IS NOT NULL").all()) {
      verified(u.id, u.organization, null);
    }
  }

  return {
    ensure, get, roleOf, setMember, removeMember, leads, verified, members, json, of, all, dependants,
    invite, inviteByToken, acceptInvite, withdrawInvite, MAX_MEMBERS,
  };
}

module.exports = { createOrganizations, withOrgPro, nameKey, ORG_ROLES: ROLES, MAX_MEMBERS, INVITE_TTL_MS };
