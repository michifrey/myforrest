'use strict';

/**
 * Licences per photo, reports and moderation (hide/unhide/delete) with an
 * audit log. Hidden photos stay in the database and on disk but are left
 * out of every public API response; moderators still see them.
 */

const LICENSES = {
  'cc-by-sa-4.0': { label: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/deed.de' },
  'cc-by-4.0': { label: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/deed.de' },
  'cc0-1.0': { label: 'CC0 1.0 (gemeinfrei)', url: 'https://creativecommons.org/publicdomain/zero/1.0/deed.de' },
  'cc-by-nc-sa-4.0': { label: 'CC BY-NC-SA 4.0', url: 'https://creativecommons.org/licenses/by-nc-sa/4.0/deed.de' },
  'all-rights-reserved': { label: 'Alle Rechte vorbehalten', url: null },
};
const DEFAULT_LICENSE = 'cc-by-sa-4.0';

const REPORT_REASONS = {
  personen: 'Personen oder Kennzeichen erkennbar',
  unpassend: 'Unangemessener Inhalt',
  urheberrecht: 'Urheberrechtsverletzung',
  falscher_ort: 'Falscher Ort oder falsches Datum',
  spam: 'Spam oder kein Waldbezug',
  sonstiges: 'Sonstiges',
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS reports (
    id          INTEGER PRIMARY KEY,
    photo_id    INTEGER NOT NULL REFERENCES photos (id) ON DELETE CASCADE,
    user_id     INTEGER REFERENCES users (id) ON DELETE SET NULL,
    reason      TEXT NOT NULL,
    note        TEXT,
    created_at  INTEGER NOT NULL,
    resolved_at INTEGER,
    resolved_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
    resolution  TEXT
  );
  CREATE INDEX IF NOT EXISTS reports_open ON reports (resolved_at, photo_id);

  -- Kept when photos or accounts are deleted, hence no foreign keys.
  CREATE TABLE IF NOT EXISTS moderation_log (
    id         INTEGER PRIMARY KEY,
    actor_id   INTEGER,
    actor_name TEXT,
    action     TEXT NOT NULL,
    photo_id   INTEGER,
    target_user_id INTEGER,
    detail     TEXT,
    created_at INTEGER NOT NULL
  );
`;

const licenseJson = (id) => {
  const key = Object.hasOwn(LICENSES, id) ? id : DEFAULT_LICENSE;
  return { id: key, ...LICENSES[key] };
};

/** `undefined`/empty → null (use default), a known id → id, anything else → false. */
function parseLicense(value) {
  if (value === undefined || value === null || value === '') return null;
  return Object.hasOwn(LICENSES, value) ? value : false;
}

/**
 * SQL condition for "this photo row is visible" under table alias `alias`.
 * Moderators see everything. The alias is a fixed identifier from our own
 * code, never user input.
 */
function visibleSql(showHidden, alias = 'p') {
  return showHidden ? '1 = 1' : `${alias}.hidden_at IS NULL`;
}

function createModeration(db) {
  db.exec(SCHEMA);
  const insertLog = db.prepare(`
    INSERT INTO moderation_log (actor_id, actor_name, action, photo_id, target_user_id, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);

  /** Records a moderation action; `actor` may be null (system). */
  function log(actor, action, { photoId = null, targetUserId = null, detail = null } = {}) {
    insertLog.run(actor?.id ?? null, actor?.name ?? null, action, photoId, targetUserId, detail, Date.now());
  }

  function resolveReports(photoId, actor, resolution) {
    db.prepare('UPDATE reports SET resolved_at = ?, resolved_by = ?, resolution = ? WHERE photo_id = ? AND resolved_at IS NULL')
      .run(Date.now(), actor?.id ?? null, resolution, photoId);
  }

  return {
    log,
    resolveReports,
    report(photoId, userId, reason, note) {
      return Number(db.prepare('INSERT INTO reports (photo_id, user_id, reason, note, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(photoId, userId, reason, note, Date.now()).lastInsertRowid);
    },
    hide(photoId, actor, reason) {
      db.prepare('UPDATE photos SET hidden_at = ?, hidden_reason = ? WHERE id = ?').run(Date.now(), reason, photoId);
      resolveReports(photoId, actor, 'ausgeblendet');
      log(actor, 'hide', { photoId, detail: reason });
    },
    unhide(photoId, actor) {
      db.prepare('UPDATE photos SET hidden_at = NULL, hidden_reason = NULL WHERE id = ?').run(photoId);
      log(actor, 'unhide', { photoId });
    },
    dismiss(photoId, actor) {
      resolveReports(photoId, actor, 'verworfen');
      log(actor, 'dismiss', { photoId });
    },
  };
}

module.exports = { LICENSES, DEFAULT_LICENSE, REPORT_REASONS, licenseJson, parseLicense, visibleSql, createModeration };
