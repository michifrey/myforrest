'use strict';

/**
 * Accounts, sessions, CSRF protection, permissions on photos, reports and
 * moderation. Registered by src/app.js before its own routes:
 *
 *   const accounts = registerAccounts(app, ctx);
 *
 * `ctx` holds `db`, `requireLogin`, `requireVerifiedEmail`, `adminEmail`, `oauth` (src/oauth.js),
 * `mailer` (src/mail.js), and later `photoJson`
 * (set by app.js once defined). Returns helpers app.js uses to filter hidden
 * photos and to stamp uploads with their uploader and licence.
 *
 * CSRF: requests that carry a session cookie must send the session's token in
 * the `X-CSRF-Token` header (the frontend gets it from GET /api/auth/me). A
 * custom header cannot be set cross-site without a CORS preflight, which this
 * server never allows. In addition, a cross-origin `Origin` header is
 * rejected for such requests and for login/registration, which also only
 * accept `application/json`. Requests without a session cookie carry no
 * authority and are unaffected, so anonymous use works as before.
 *
 * Identity providers: GET /api/auth/oauth/:provider redirects to Google or
 * GitHub, which return to …/callback. That logs in, creates an account, or,
 * with a session in this browser, links the provider to it; then it
 * redirects to the start page (`/?auth=ok|created|linked` or `/?auth_error=…`).
 *
 * E-mail confirmation: registering sends a link to GET /api/auth/verify,
 * which confirms the address and redirects to `/?auth=verified`. With
 * `requireVerifiedEmail`, writes need an account with a confirmed address
 * (it implies `requireLogin`).
 *
 * Forgotten password: POST /api/auth/password/forgot mails a link to
 * `/#reset=<token>` (the fragment never reaches servers or Referer headers);
 * the page then posts the new password to /api/auth/password/reset. The
 * answer to "forgot" is the same whether or not the address has an account.
 * Logged in, POST /api/auth/password/change takes the current and a new
 * password; the account gets a notice by e-mail.
 *
 * Deleting the account: DELETE /api/auth/account with the password (or,
 * without one, the account name) and `photos: 'delete' | 'anonymize'`.
 * GET /api/auth/account tells the dialog what would be affected.
 */

const crypto = require('node:crypto');
const path = require('node:path');
const {
  SESSION_COOKIE, SESSION_TTL_MS, ROLES, hasPassword, parseCookies, serializeCookie, createLimiter, createAuth, isModerator, canSeeProtected, userJson,
  proExpired, mayRenewPro, proValidDays, PRO_REMIND_DAYS, PRO_RENEW_DAYS,
} = require('../auth');
const { STATE_COOKIE, STATE_TTL_MS, createOAuth } = require('../oauth');
const { createMailer } = require('../mail');
const {
  LICENSES, DEFAULT_LICENSE, REPORT_REASONS, licenseJson, parseLicense, visibleSql, createModeration,
} = require('../moderation');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Writes that stay open to anonymous visitors even with requireLogin.
const OPEN_WRITES = [/^\/auth\/(login|register|logout|password\/forgot|password\/reset)$/, /^\/photos\/\d+\/report$/];
// Writes an account with an unconfirmed address may still make with requireVerifiedEmail.
const UNVERIFIED_WRITES = [/^\/auth\//, ...OPEN_WRITES];

const sameString = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

module.exports = function registerAccounts(app, ctx) {
  const { db, adminEmail = null, requireVerifiedEmail = false } = ctx;
  const requireLogin = Boolean(ctx.requireLogin || requireVerifiedEmail);
  const auth = createAuth(db, { adminEmail });
  const oauth = ctx.oauth || createOAuth();
  const mailer = ctx.mailer || createMailer();
  const publicUrl = ctx.publicUrl || null;
  const mod = createModeration(db);
  const limits = ctx.rateLimits || {};
  const loginPerAccount = createLimiter({ max: limits.loginPerAccount ?? 5, windowMs: 15 * 60 * 1000 });
  const loginPerIp = createLimiter({ max: limits.loginPerIp ?? 30, windowMs: 15 * 60 * 1000 });
  const oauthPerIp = createLimiter({ max: limits.oauthPerIp ?? 30, windowMs: 15 * 60 * 1000 });
  const registerPerIp = createLimiter({ max: limits.registerPerIp ?? 10, windowMs: 3600 * 1000 });
  const forgotPerIp = createLimiter({ max: limits.forgotPerIp ?? 10, windowMs: 3600 * 1000 });
  const forgotPerAddress = createLimiter({ max: limits.forgotPerAddress ?? 3, windowMs: 3600 * 1000 });
  const resetPerIp = createLimiter({ max: limits.resetPerIp ?? 20, windowMs: 15 * 60 * 1000 });
  const renamePerAccount = createLimiter({ max: limits.renamePerAccount ?? 3, windowMs: 24 * 3600 * 1000 });
  const verifyPerAccount = createLimiter({ max: limits.verifyPerAccount ?? 3, windowMs: 3600 * 1000 });
  const reportPerIp = createLimiter({ max: limits.reportPerIp ?? 30, windowMs: 3600 * 1000 });

  const canSeeHidden = (req) => isModerator(req.user);
  /** What this request may see: hidden photos (moderation), protected ones (PRO, moderation), own uploads. */
  const view = (req) => ({ hidden: canSeeHidden(req), protected: canSeeProtected(req.user), userId: req.user?.id ?? null });
  const secure = (req) => req.secure || req.get('x-forwarded-proto') === 'https';
  const fail = (res, status, error) => res.status(status).json({ error });

  /* ---------- Session from the cookie ---------- */

  app.use(['/api', '/uploads', '/thumbs'], (req, res, next) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    req.session = token ? auth.session(token) : null;
    req.user = req.session?.user ?? null;
    if (token && !req.session) res.append('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAge: 0, secure: secure(req) }));
    next();
  });

  // Answers for PRO members and moderation may contain protected finds: no shared or device caches.
  app.use('/api', (req, res, next) => {
    if (canSeeProtected(req.user)) res.set('Cache-Control', 'private, no-store');
    next();
  });

  const crossOrigin = (req) => {
    const origin = req.get('origin');
    if (!origin) return false;
    try {
      const host = req.get('x-forwarded-host') || req.get('host');
      return new URL(origin).host !== host;
    } catch {
      return true;
    }
  };

  /* ---------- CSRF and login requirement for state-changing requests ---------- */

  app.use('/api', (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const authRoute = /^\/auth\/(login|register|password\/forgot|password\/reset)$/.test(req.path);
    if ((req.session || authRoute) && crossOrigin(req)) return fail(res, 403, 'Anfrage von fremder Herkunft abgelehnt');
    if (req.session && !sameString(req.get('x-csrf-token') || '', req.session.csrf)) {
      return fail(res, 403, 'Sicherheitstoken fehlt oder ist abgelaufen – bitte Seite neu laden');
    }
    if (requireLogin && !req.user && !OPEN_WRITES.some((re) => re.test(req.path))) {
      return fail(res, 401, 'Bitte zuerst anmelden');
    }
    if (requireVerifiedEmail && req.user && !req.user.email_verified_at && !UNVERIFIED_WRITES.some((re) => re.test(req.path))) {
      return fail(res, 403, 'Bitte zuerst die E-Mail-Adresse bestätigen (Link in der E-Mail, neu anfordern im Konto-Menü)');
    }
    next();
  });

  /* ---------- Hidden photos are not served to the public ---------- */

  // Originals and previews of hidden and protected photos; protected files are never cached by proxies.
  const fileRow = db.prepare(`SELECT p.id FROM photos p WHERE (p.file = ? OR p.thumb_file = ? OR p.large_file = ?)
    AND NOT (${visibleSql(false, 'p')})`);
  app.use(['/uploads', '/thumbs'], (req, res, next) => {
    const name = path.basename(req.path);
    const restricted = fileRow.get(name, name, name);
    if (!restricted) return next();
    const ok = db.prepare(`SELECT 1 FROM photos p WHERE p.id = ? AND ${visibleSql(view(req), 'p')}`).get(restricted.id);
    if (!ok) return res.status(404).end();
    // express.static sets its own Cache-Control afterwards: override it on the way out.
    const setHeader = res.setHeader.bind(res);
    res.setHeader = (k, v) => setHeader(k, String(k).toLowerCase() === 'cache-control' ? 'private, no-store' : v);
    res.setHeader('Cache-Control', 'private, no-store');
    next();
  });

  const photoRow = db.prepare('SELECT id, spot_id, uploader_id, hidden_at, protected FROM photos WHERE id = ?');
  /** May this request see the photo row at all? */
  const mayView = (req, photo) => {
    if (photo.hidden_at && !canSeeHidden(req)) return false;
    return !photo.protected || canSeeProtected(req.user) || Boolean(req.user && req.user.id === photo.uploader_id);
  };
  const userName = db.prepare('SELECT id, name FROM users WHERE id = ?');

  /** May `user` edit (tags, note) or delete this photo? */
  function mayChange(user, photo, action) {
    if (isModerator(user)) return true;
    if (photo.uploader_id !== null) return Boolean(user && user.id === photo.uploader_id);
    // Anonymous photos: open as in the prototype, unless logins are required.
    if (!requireLogin) return true;
    return action === 'edit' && Boolean(user);
  }

  app.use('/api/spots/:id', (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || isModerator(req.user)) return next();
    const exists = db.prepare('SELECT 1 FROM spots WHERE id = ?').get(id);
    const visible = db.prepare(`SELECT 1 FROM photos p WHERE p.spot_id = ? AND ${visibleSql(view(req), 'p')} LIMIT 1`).get(id);
    if (exists && !visible) return fail(res, 404, 'Spot nicht gefunden');
    next();
  });

  app.use('/api/photos/:id', (req, res, next) => {
    const id = Number(req.params.id);
    const photo = Number.isSafeInteger(id) ? photoRow.get(id) : null;
    if (!photo) return next(); // app.js answers 400/404
    const own = Boolean(req.user && req.user.id === photo.uploader_id);
    if (!mayView(req, photo) && !(own && req.method === 'DELETE')) return fail(res, 404, 'Foto nicht gefunden');
    if (req.query.to !== undefined) {
      const other = photoRow.get(Number(req.query.to));
      if (other && !mayView(req, other)) return fail(res, 404, 'Foto nicht gefunden');
    }
    if (req.path !== '/') return next();

    if (req.method === 'PATCH') {
      const body = req.body || {};
      const touchesContent = body.tags !== undefined || body.note !== undefined;
      if (touchesContent && !mayChange(req.user, photo, 'edit')) {
        return fail(res, req.user ? 403 : 401, 'Nur wer das Foto hochgeladen hat, kann es bearbeiten');
      }
      if (body.protected !== undefined) {
        // Uploaders protect or release their own photos; PRO members and moderation any photo.
        if (!own && !canSeeProtected(req.user)) return fail(res, req.user ? 403 : 401, 'Nur wer das Foto hochgeladen hat, PRO-Mitglieder oder Moderation können den Schutz ändern');
        const on = body.protected === true || body.protected === 1 || body.protected === '1';
        // Released by hand: noted, so that a protection list or a new identification does not protect it again.
        const reason = !on ? 'freigegeben' : own && !canSeeProtected(req.user) ? 'upload' : isModerator(req.user) && !own ? 'moderation' : own ? 'upload' : 'pro';
        db.prepare('UPDATE photos SET protected = ?, protected_reason = ? WHERE id = ?').run(on ? 1 : 0, reason, id);
        if (!own) mod.log(req.user, on ? 'protect' : 'unprotect', { photoId: id, targetUserId: photo.uploader_id });
      }
      if (body.license !== undefined) {
        const license = parseLicense(body.license);
        if (!license) return fail(res, 400, `Lizenz muss eine von ${Object.keys(LICENSES).join(', ')} sein`);
        if (!own) return fail(res, req.user ? 403 : 401, 'Nur wer das Foto hochgeladen hat, kann die Lizenz ändern');
        db.prepare('UPDATE photos SET license = ? WHERE id = ?').run(license, id);
      }
    } else if (req.method === 'DELETE') {
      if (!mayChange(req.user, photo, 'delete')) {
        return fail(res, req.user ? 403 : 401, 'Nur wer das Foto hochgeladen hat oder moderiert, kann es löschen');
      }
      if (isModerator(req.user) && !own) {
        const actor = req.user;
        res.on('finish', () => {
          if (res.statusCode === 204) mod.log(actor, 'delete', { photoId: id, targetUserId: photo.uploader_id });
        });
      }
    }
    next();
  });

  /* ---------- Accounts ---------- */

  const startSession = (req, res, user) => {
    const { token, csrf } = auth.createSession(user.id);
    res.append('Set-Cookie', serializeCookie(SESSION_COOKIE, token, { maxAge: SESSION_TTL_MS, secure: secure(req) }));
    return { user: selfJson(user), csrfToken: csrf };
  };
  const selfJson = (user) => (user ? { ...userJson(user, { self: true, identities: auth.identitiesOf(user.id) }), organizations: auth.orgs.of(user.id) } : null);
  const jsonOnly = (req, res) => {
    if (req.is('application/json')) return true;
    fail(res, 415, 'Bitte als JSON senden');
    return false;
  };

  app.get('/api/auth/me', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      user: selfJson(req.user),
      csrfToken: req.session?.csrf ?? null,
      requireLogin,
      requireVerifiedEmail,
      providers: oauth.list(),
      licenses: Object.entries(LICENSES).map(([id, l]) => ({ id, ...l })),
      defaultLicense: DEFAULT_LICENSE,
      reportReasons: REPORT_REASONS,
    });
  });

  app.post('/api/auth/register', async (req, res, next) => {
    if (!jsonOnly(req, res)) return;
    const wait = registerPerIp.blocked(req.ip);
    if (wait) return res.set('Retry-After', String(wait)).status(429).json({ error: 'Zu viele Registrierungen – bitte später erneut versuchen' });
    try {
      const { email, name, password } = req.body || {};
      const r = await auth.register({ email, name, password });
      if (r.error) return fail(res, r.status || 400, r.error);
      registerPerIp.hit(req.ip);
      if (r.user.role === 'admin') mod.log(r.user, 'role', { targetUserId: r.user.id, detail: 'admin (erstes Konto)' });
      const verification = await sendVerification(req, r.user);
      res.status(201).json({ ...startSession(req, res, r.user), verification });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/auth/login', async (req, res, next) => {
    if (!jsonOnly(req, res)) return;
    const login = typeof req.body?.login === 'string' ? req.body.login.trim().toLowerCase() : '';
    const accountKey = `${req.ip}|${login}`;
    const wait = Math.max(loginPerAccount.blocked(accountKey), loginPerIp.blocked(req.ip));
    if (wait) {
      return res.set('Retry-After', String(wait)).status(429)
        .json({ error: `Zu viele Fehlversuche – bitte in ${Math.ceil(wait / 60)} Minuten erneut versuchen` });
    }
    try {
      const user = await auth.authenticate(login, req.body?.password);
      if (!user) {
        loginPerAccount.hit(accountKey);
        loginPerIp.hit(req.ip);
        return fail(res, 401, 'E-Mail/Name oder Passwort ist falsch');
      }
      loginPerAccount.reset(accountKey);
      // A fresh session per login; an earlier one in this browser is ended.
      if (req.session) auth.destroySession(req.session.tokenHash);
      res.json(startSession(req, res, user));
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    if (req.session) auth.destroySession(req.session.tokenHash);
    res.append('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAge: 0, secure: secure(req) }));
    res.status(204).end();
  });

  /* ---------- E-mail confirmation ---------- */

  const origin = (req) => `${secure(req) ? 'https' : 'http'}://${req.get('x-forwarded-host') || req.get('host')}`;

  /** Mails a confirmation link; 'sent', 'logged' (no SMTP configured) or 'failed'. */
  async function sendVerification(req, user) {
    const token = auth.createEmailToken(user);
    const link = `${(publicUrl || origin(req)).replace(/\/+$/, '')}/api/auth/verify?token=${encodeURIComponent(token)}`;
    try {
      const r = await mailer.send({
        to: user.email,
        subject: 'MyForrest: E-Mail-Adresse bestätigen',
        text: [
          `Hallo ${user.name}`,
          '',
          'Bitte bestätige deine E-Mail-Adresse für MyForrest mit diesem Link:',
          '',
          link,
          '',
          'Der Link ist 24 Stunden gültig. Hast du kein Konto angelegt, kannst du diese E-Mail ignorieren.',
        ].join('\n'),
      });
      return r?.logged ? 'logged' : 'sent';
    } catch (err) {
      console.error(`Bestätigungs-E-Mail an Konto ${user.id} fehlgeschlagen: ${err.message}`);
      return 'failed';
    }
  }

  app.get('/api/auth/verify', (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const r = auth.confirmEmail(req.query.token);
    res.redirect(303, `/?${new URLSearchParams(r.error ? { auth_error: r.error } : { auth: 'verified' })}`);
  });

  app.post('/api/auth/verify/resend', async (req, res, next) => {
    if (!req.user) return fail(res, 401, 'Bitte zuerst anmelden');
    if (req.user.email_verified_at) return fail(res, 400, 'Die E-Mail-Adresse ist schon bestätigt');
    const wait = verifyPerAccount.blocked(req.user.id);
    if (wait) {
      return res.set('Retry-After', String(wait)).status(429)
        .json({ error: `Schon mehrere Links verschickt – bitte in ${Math.ceil(wait / 60)} Minuten erneut versuchen` });
    }
    verifyPerAccount.hit(req.user.id);
    try {
      const verification = await sendVerification(req, req.user);
      if (verification === 'failed') return fail(res, 502, 'Die E-Mail konnte nicht verschickt werden – bitte später erneut versuchen');
      res.json({ verification });
    } catch (err) {
      next(err);
    }
  });

  /* ---------- Forgotten password ---------- */

  const baseUrl = (req) => (publicUrl || origin(req)).replace(/\/+$/, '');

  async function sendReset(req, user) {
    const token = auth.createEmailToken(user, 'reset');
    try {
      await mailer.send({
        to: user.email,
        subject: 'MyForrest: Passwort zurücksetzen',
        text: [
          `Hallo ${user.name}`,
          '',
          `Für dein MyForrest-Konto (${user.email}) wurde ein neues Passwort angefordert. Mit diesem Link legst du es fest:`,
          '',
          `${baseUrl(req)}/#reset=${encodeURIComponent(token)}`,
          '',
          'Der Link ist 1 Stunde gültig und funktioniert nur einmal. Danach bist du auf allen Geräten abgemeldet.',
          'Hast du nichts angefordert, kannst du diese E-Mail ignorieren – dein Passwort bleibt, wie es ist.',
        ].join('\n'),
      });
    } catch (err) {
      console.error(`E-Mail zum Zurücksetzen an Konto ${user.id} fehlgeschlagen: ${err.message}`);
    }
  }

  app.post('/api/auth/password/forgot', (req, res) => {
    if (!jsonOnly(req, res)) return;
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!email) return fail(res, 400, 'Bitte die E-Mail-Adresse angeben');
    const wait = forgotPerIp.blocked(req.ip);
    if (wait) return res.set('Retry-After', String(wait)).status(429).json({ error: 'Zu viele Anfragen – bitte später erneut versuchen' });
    forgotPerIp.hit(req.ip);
    // Same answer and timing for known and unknown addresses: the mail goes out in the background.
    const user = forgotPerAddress.blocked(email) ? null : auth.userByEmail(email);
    if (user) {
      forgotPerAddress.hit(email);
      sendReset(req, user);
    }
    res.json({ ok: true });
  });

  app.post('/api/auth/password/change', async (req, res, next) => {
    if (!jsonOnly(req, res)) return;
    if (!req.user) return fail(res, 401, 'Bitte zuerst anmelden');
    // Wrong current passwords count like failed logins.
    const accountKey = `${req.ip}|${req.user.email.toLowerCase()}`;
    const wait = loginPerAccount.blocked(accountKey);
    if (wait) {
      return res.set('Retry-After', String(wait)).status(429)
        .json({ error: `Zu viele Fehlversuche – bitte in ${Math.ceil(wait / 60)} Minuten erneut versuchen` });
    }
    try {
      const r = await auth.changePassword(req.user, req.body?.current, req.body?.password, req.session.tokenHash);
      if (r.error) {
        if (r.wrong) loginPerAccount.hit(accountKey);
        return fail(res, r.status, r.error);
      }
      loginPerAccount.reset(accountKey);
      // A notice, so that a change by somebody else does not go unnoticed (in the background).
      mailer.send({
        to: r.user.email,
        subject: 'MyForrest: Passwort geändert',
        text: [
          `Hallo ${r.user.name}`,
          '',
          `Das Passwort deines MyForrest-Kontos (${r.user.email}) wurde soeben geändert${r.endedSessions ? '; andere Geräte sind abgemeldet' : ''}.`,
          '',
          'Warst du das nicht? Dann setze das Passwort hier sofort neu:',
          `${baseUrl(req)}/ → Anmelden → Passwort vergessen?`,
        ].join('\n'),
      }).catch((err) => console.error(`Hinweis zur Passwortänderung an Konto ${r.user.id} fehlgeschlagen: ${err.message}`));
      res.json({ user: selfJson(r.user), endedSessions: r.endedSessions });
    } catch (err) {
      next(err);
    }
  });

  /* ---------- Display name ---------- */

  app.patch('/api/auth/me', (req, res) => {
    if (!jsonOnly(req, res)) return;
    if (!req.user) return fail(res, 401, 'Bitte zuerst anmelden');
    if (req.body?.name === undefined) return fail(res, 400, 'Bitte einen neuen Namen angeben (name)');
    const wait = renamePerAccount.blocked(req.user.id);
    if (wait) {
      return res.set('Retry-After', String(wait)).status(429)
        .json({ error: `Der Name wurde heute schon mehrmals geändert – wieder möglich in ${Math.ceil(wait / 3600)} Stunden` });
    }
    const r = auth.rename(req.user, req.body.name);
    if (r.error) return fail(res, r.status, r.error);
    renamePerAccount.hit(req.user.id);
    // The moderation can trace who someone was before (photo credits always show the current name).
    mod.log(r.user, 'rename', { targetUserId: r.user.id, detail: `${r.previous} → ${r.user.name}` });
    res.json({ user: selfJson(r.user) });
  });

  /* ---------- Deleting the account ---------- */

  const accountCounts = (userId) => ({
    photos: db.prepare('SELECT COUNT(*) AS n FROM photos WHERE uploader_id = ?').get(userId).n,
    tracks: db.prepare('SELECT COUNT(*) AS n FROM tracks WHERE owner_id = ?').get(userId).n,
    requests: db.prepare("SELECT COUNT(*) AS n FROM photo_requests WHERE requester_id = ? AND status = 'offen'").get(userId).n,
  });

  app.get('/api/auth/account', (req, res) => {
    if (!req.user) return fail(res, 401, 'Bitte zuerst anmelden');
    res.set('Cache-Control', 'no-store');
    res.json({ ...accountCounts(req.user.id), confirmWith: hasPassword(req.user) ? 'password' : 'name', blocker: auth.deleteBlocker(req.user) });
  });

  app.delete('/api/auth/account', async (req, res, next) => {
    if (!jsonOnly(req, res)) return;
    if (!req.user) return fail(res, 401, 'Bitte zuerst anmelden');
    const user = req.user;
    const photos = req.body?.photos;
    if (!['delete', 'anonymize'].includes(photos)) return fail(res, 400, 'Bitte wählen, was mit den Fotos geschieht (photos: delete oder anonymize)');
    const accountKey = `${req.ip}|${user.email.toLowerCase()}`;
    const wait = loginPerAccount.blocked(accountKey);
    if (wait) {
      return res.set('Retry-After', String(wait)).status(429)
        .json({ error: `Zu viele Fehlversuche – bitte in ${Math.ceil(wait / 60)} Minuten erneut versuchen` });
    }
    try {
      const ok = await auth.confirmOwner(user, { password: req.body?.password, name: req.body?.name });
      if (ok.error) {
        if (ok.wrong) loginPerAccount.hit(accountKey);
        return fail(res, ok.status, ok.error);
      }
      const blocker = auth.deleteBlocker(user);
      if (blocker) return fail(res, 409, blocker);

      const counts = accountCounts(user.id);
      let deleted = 0;
      if (photos === 'delete') {
        for (const photo of db.prepare('SELECT * FROM photos WHERE uploader_id = ?').all(user.id)) {
          await ctx.removePhoto(photo);
          deleted += 1;
        }
      }
      const { anonymized } = auth.deleteUser(user);
      loginPerAccount.reset(accountKey);
      // Only counts and the account id stay in the log, not the name or the address.
      mod.log(null, 'account-delete', {
        targetUserId: user.id,
        detail: `${deleted} Fotos gelöscht, ${anonymized} anonym behalten, ${counts.tracks} Touren gelöscht`,
      });
      mailer.send({
        to: user.email,
        subject: 'MyForrest: Konto gelöscht',
        text: [
          `Hallo ${user.name}`,
          '',
          `Dein MyForrest-Konto (${user.email}) ist gelöscht. ${photos === 'delete'
            ? `Deine ${deleted} Fotos sind ebenfalls gelöscht.`
            : `Deine ${anonymized} Fotos bleiben ohne deinen Namen («Anonym») erhalten.`}`,
          '',
          'Warst du das nicht? Dann antworte bitte auf diese E-Mail.',
        ].join('\n'),
      }).catch((err) => console.error(`Bestätigung der Kontolöschung fehlgeschlagen: ${err.message}`));
      res.append('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAge: 0, secure: secure(req) }));
      res.json({ deletedPhotos: deleted, anonymizedPhotos: anonymized, deletedTracks: counts.tracks });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/auth/password/reset', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const r = auth.checkResetToken(req.query.token);
    if (r.error) return fail(res, 400, r.error);
    res.json({ name: r.user.name, email: r.user.email });
  });

  app.post('/api/auth/password/reset', async (req, res, next) => {
    if (!jsonOnly(req, res)) return;
    const wait = resetPerIp.blocked(req.ip);
    if (wait) return res.set('Retry-After', String(wait)).status(429).json({ error: 'Zu viele Fehlversuche – bitte später erneut versuchen' });
    try {
      const r = await auth.resetPassword(req.body?.token, req.body?.password);
      if (r.error) {
        resetPerIp.hit(req.ip);
        return fail(res, r.status, r.error);
      }
      // Every session of the account has ended, this browser's included: log in afresh.
      loginPerAccount.reset(`${req.ip}|${r.user.email.toLowerCase()}`);
      res.json(startSession(req, res, r.user));
    } catch (err) {
      next(err);
    }
  });

  /* ---------- Identity providers (Google, GitHub) ---------- */

  const stateCookie = (req, value, maxAge) => serializeCookie(STATE_COOKIE, value, {
    maxAge, secure: secure(req), path: '/api/auth/oauth/',
  });
  const backTo = (res, params) => res.redirect(303, `/?${new URLSearchParams(params)}`);

  app.get('/api/auth/oauth/:provider', (req, res) => {
    const provider = oauth.get(req.params.provider);
    if (!provider) return fail(res, 404, 'Diese Anmeldung ist nicht eingerichtet');
    const { url, cookie } = oauth.begin(provider, origin(req));
    res.set('Cache-Control', 'no-store');
    res.append('Set-Cookie', stateCookie(req, cookie, STATE_TTL_MS));
    res.redirect(303, url);
  });

  app.get('/api/auth/oauth/:provider/callback', async (req, res) => {
    const provider = oauth.get(req.params.provider);
    if (!provider) return fail(res, 404, 'Diese Anmeldung ist nicht eingerichtet');
    res.set('Cache-Control', 'no-store');
    // The state cookie is single-use.
    res.append('Set-Cookie', stateCookie(req, '', 0));
    const wait = oauthPerIp.blocked(req.ip);
    if (wait) return backTo(res, { auth_error: `Zu viele Anmeldeversuche – bitte in ${Math.ceil(wait / 60)} Minuten erneut versuchen` });
    let profile;
    try {
      profile = await oauth.finish(provider, origin(req), req.query, parseCookies(req.headers.cookie)[STATE_COOKIE]);
    } catch (err) {
      oauthPerIp.hit(req.ip);
      return backTo(res, { auth_error: err.message });
    }
    const r = auth.identityLogin(provider.id, profile, req.user);
    if (r.error) return backTo(res, { auth_error: r.error });
    if (r.created && r.user.role === 'admin') mod.log(r.user, 'role', { targetUserId: r.user.id, detail: `admin (erstes Konto, ${provider.label})` });
    if (!req.user) startSession(req, res, r.user);
    backTo(res, r.linked ? { auth: 'linked', provider: provider.id } : { auth: r.created ? 'created' : 'ok' });
  });

  app.delete('/api/auth/identities/:provider', (req, res) => {
    if (!req.user) return fail(res, 401, 'Bitte zuerst anmelden');
    const r = auth.unlinkIdentity(req.user, req.params.provider);
    if (r.error) return fail(res, r.status, r.error);
    res.json({ user: selfJson(auth.userById(req.user.id)) });
  });

  /* ---------- Reports (open to everyone) ---------- */

  app.post('/api/photos/:id/report', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || !photoRow.get(id)) return fail(res, 404, 'Foto nicht gefunden');
    const reason = req.body?.reason;
    if (!Object.hasOwn(REPORT_REASONS, reason)) {
      return fail(res, 400, `Grund muss einer von ${Object.keys(REPORT_REASONS).join(', ')} sein`);
    }
    const wait = reportPerIp.blocked(req.ip);
    if (wait) return res.set('Retry-After', String(wait)).status(429).json({ error: 'Zu viele Meldungen – bitte später erneut versuchen' });
    reportPerIp.hit(req.ip);
    const note = req.body?.note ? String(req.body.note).slice(0, 1000) : null;
    if (req.user) {
      const open = db.prepare('SELECT id FROM reports WHERE photo_id = ? AND user_id = ? AND resolved_at IS NULL').get(id, req.user.id);
      if (open) return res.status(200).json({ id: open.id, duplicate: true });
    }
    res.status(201).json({ id: mod.report(id, req.user?.id ?? null, reason, note) });
  });

  /* ---------- Moderation ---------- */

  const moderatorOnly = (req, res, next) => {
    if (!req.user) return fail(res, 401, 'Bitte zuerst anmelden');
    if (!isModerator(req.user)) return fail(res, 403, 'Nur für Moderatorinnen und Moderatoren');
    next();
  };
  const adminOnly = (req, res, next) => {
    if (!req.user) return fail(res, 401, 'Bitte zuerst anmelden');
    if (req.user.role !== 'admin') return fail(res, 403, 'Nur für Administratorinnen und Administratoren');
    next();
  };
  const fullPhoto = (id) => db.prepare('SELECT * FROM photos WHERE id = ?').get(id);

  app.get('/api/moderation/queue', moderatorOnly, (req, res) => {
    const reports = db.prepare(`
      SELECT r.*, u.name AS reporter FROM reports r LEFT JOIN users u ON u.id = r.user_id
      WHERE r.resolved_at IS NULL ORDER BY r.created_at`).all();
    const byPhoto = new Map();
    for (const r of reports) {
      if (!byPhoto.has(r.photo_id)) byPhoto.set(r.photo_id, []);
      byPhoto.get(r.photo_id).push({
        id: r.id,
        reason: r.reason,
        reasonLabel: REPORT_REASONS[r.reason] || r.reason,
        note: r.note,
        reporter: r.reporter,
        createdAt: new Date(r.created_at).toISOString(),
      });
    }
    const reported = [...byPhoto].map(([photoId, list]) => ({ photo: ctx.photoJson(fullPhoto(photoId)), reports: list }));
    const hidden = db.prepare('SELECT * FROM photos WHERE hidden_at IS NOT NULL ORDER BY hidden_at DESC LIMIT 200').all()
      .map(ctx.photoJson);
    res.json({ reported, hidden });
  });

  const moderationAction = (fn) => (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || !photoRow.get(id)) return fail(res, 404, 'Foto nicht gefunden');
    const error = fn(id, req);
    if (error) return fail(res, 400, error);
    res.json(ctx.photoJson(fullPhoto(id)));
  };

  app.post('/api/moderation/photos/:id/hide', moderatorOnly, moderationAction((id, req) => {
    const reason = req.body?.reason ? String(req.body.reason).slice(0, 500) : null;
    mod.hide(id, req.user, reason);
  }));
  app.post('/api/moderation/photos/:id/unhide', moderatorOnly, moderationAction((id, req) => mod.unhide(id, req.user)));
  app.post('/api/moderation/photos/:id/dismiss', moderatorOnly, moderationAction((id, req) => mod.dismiss(id, req.user)));

  app.get('/api/moderation/log', moderatorOnly, (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    res.json(db.prepare(`
      SELECT l.*, t.name AS target_name FROM moderation_log l LEFT JOIN users t ON t.id = l.target_user_id
      ORDER BY l.id DESC LIMIT ?`).all(limit).map((l) => ({
      id: l.id,
      actor: l.actor_name,
      action: l.action,
      photoId: l.photo_id,
      targetUser: l.target_name,
      detail: l.detail,
      createdAt: new Date(l.created_at).toISOString(),
    })));
  });

  /* ---------- Roles (admins) ---------- */

  app.get('/api/users', adminOnly, (req, res) => {
    res.json(db.prepare(`
      SELECT u.id, u.name, u.email, u.role, u.created_at, u.pro_status, u.organization, u.pro_note, u.pro_requested_at,
             u.pro_valid_until, u.pro_renewal_requested_at, COUNT(p.id) AS photos
      FROM users u LEFT JOIN photos p ON p.uploader_id = u.id GROUP BY u.id ORDER BY u.id`).all()
      .map((u) => ({
        id: u.id, name: u.name, email: u.email, role: u.role, photos: u.photos, createdAt: new Date(u.created_at).toISOString(),
        proStatus: u.pro_status || null, organization: u.organization || null, proNote: u.pro_note || null,
        proRequestedAt: u.pro_requested_at ? new Date(u.pro_requested_at).toISOString() : null,
        proValidUntil: u.pro_status === 'verifiziert' && u.pro_valid_until ? new Date(u.pro_valid_until).toISOString() : null,
        proExpired: proExpired(u),
        proRenewalRequestedAt: u.pro_renewal_requested_at ? new Date(u.pro_renewal_requested_at).toISOString() : null,
        organizations: auth.orgs.of(u.id),
      })));
  });

  app.patch('/api/users/:id', adminOnly, (req, res) => {
    const id = Number(req.params.id);
    const target = Number.isSafeInteger(id) ? auth.userById(id) : null;
    if (!target) return fail(res, 404, 'Konto nicht gefunden');
    const role = req.body?.role;
    if (!ROLES.includes(role)) return fail(res, 400, `Rolle muss eine von ${ROLES.join(', ')} sein`);
    if (target.id === req.user.id) return fail(res, 400, 'Die eigene Rolle kann nicht geändert werden');
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    mod.log(req.user, 'role', { targetUserId: id, detail: `${target.role} → ${role}` });
    res.json(userJson(auth.userById(id)));
  });

  /* ---------- PRO membership: verified organisations (forest services, nature NGOs …) ---------- */

  const proPerUser = createLimiter({ max: limits.proPerUser ?? 5, windowMs: 24 * 3600 * 1000 });
  app.post('/api/auth/pro', (req, res) => {
    if (!req.user) return fail(res, 401, 'Bitte zuerst anmelden');
    if (!jsonOnly(req, res)) return;
    // A verified member asks for renewal near or after the end; PRO stays until then (status remains verified).
    const renewal = req.user.pro_status === 'verifiziert';
    if (renewal && !mayRenewPro(req.user)) {
      return fail(res, 409, `Das Konto ist PRO-Mitglied bis ${new Date(req.user.pro_valid_until).toLocaleDateString('de-CH')}; verlängern lässt es sich ab ${PRO_RENEW_DAYS} Tagen vor dem Ablauf`);
    }
    const organization = String(req.body?.organization || '').trim().slice(0, 160);
    const note = String(req.body?.note || '').trim().slice(0, 1000) || null;
    if (organization.length < 2) return fail(res, 400, 'Bitte die Organisation angeben (z. B. Forstamt, Naturschutzorganisation)');
    if (proPerUser.blocked(String(req.user.id))) return fail(res, 429, 'Zu viele Anträge – bitte morgen wieder');
    proPerUser.hit(String(req.user.id));
    if (renewal) {
      db.prepare('UPDATE users SET organization = ?, pro_note = ?, pro_renewal_requested_at = ? WHERE id = ?').run(organization, note, Date.now(), req.user.id);
    } else {
      db.prepare("UPDATE users SET pro_status = 'angefragt', organization = ?, pro_note = ?, pro_requested_at = ?, pro_decided_at = NULL, pro_decided_by = NULL WHERE id = ?")
        .run(organization, note, Date.now(), req.user.id);
    }
    res.json(selfJson(auth.userById(req.user.id)));
  });

  /** Admins verify or decline a request, or revoke PRO. */
  app.post('/api/users/:id/pro', adminOnly, (req, res) => {
    const id = Number(req.params.id);
    const target = Number.isSafeInteger(id) ? auth.userById(id) : null;
    if (!target) return fail(res, 404, 'Konto nicht gefunden');
    const decision = req.body?.decision;
    if (!['verifiziert', 'abgelehnt', 'entzogen'].includes(decision)) return fail(res, 400, 'decision: verifiziert, abgelehnt oder entzogen');
    const organization = req.body?.organization !== undefined ? String(req.body.organization).trim().slice(0, 160) : target.organization;
    if (decision === 'verifiziert' && !organization) return fail(res, 400, 'Bitte die Organisation angeben');
    // A verification holds for PRO_VALID_DAYS; a renewal adds them to the current end (or to today, once run out).
    const now = Date.now();
    const validUntil = decision === 'verifiziert'
      ? Math.max(now, target.pro_status === 'verifiziert' ? target.pro_valid_until || now : now) + proValidDays() * 86400000 : null;
    db.prepare(`UPDATE users SET pro_status = ?, organization = ?, pro_decided_at = ?, pro_decided_by = ?, pro_valid_until = ?,
      pro_renewal_requested_at = NULL, pro_reminded_at = NULL WHERE id = ?`)
      .run(decision === 'entzogen' ? null : decision, organization || null, now, req.user.id, validUntil, id);
    mod.log(req.user, `pro-${decision}`, { targetUserId: id, detail: organization || null });
    // The verified applicant leads the organisation and may add colleagues.
    if (decision === 'verifiziert') auth.orgs.verified(id, organization, req.user.id);
    res.json(userJson(auth.userById(id)));
  });

  require('./organizations')(app, { db, auth, mod, mailer, publicUrl, limits, fail, adminOnly });

  /* ---------- Reminders before PRO runs out ---------- */

  /**
   * E-mails PRO members whose verification ends within PRO_REMIND_DAYS (once),
   * and once more when it has run out. Runs daily; returns how many were sent.
   */
  async function remindPro(now = Date.now()) {
    const fmt = (ms) => new Date(ms).toLocaleDateString('de-CH');
    const link = publicUrl ? `${publicUrl.replace(/\/+$/, '')}/` : 'MyForrest';
    let sent = 0;
    const due = db.prepare(`SELECT * FROM users WHERE pro_status = 'verifiziert' AND pro_valid_until IS NOT NULL
      AND pro_valid_until - ? <= ? AND pro_renewal_requested_at IS NULL`).all(now, PRO_REMIND_DAYS * 86400000);
    for (const u of due) {
      const ended = u.pro_valid_until <= now;
      // Before the end: once from 30 days before; after it: once more.
      const remindedFor = u.pro_reminded_at ?? 0;
      if (ended ? remindedFor >= u.pro_valid_until : remindedFor >= u.pro_valid_until - PRO_REMIND_DAYS * 86400000) continue;
      try {
        await mailer.send({
          to: u.email,
          subject: ended ? 'MyForrest: PRO-Mitgliedschaft abgelaufen' : `MyForrest: PRO-Mitgliedschaft läuft am ${fmt(u.pro_valid_until)} ab`,
          text: [
            `Hallo ${u.name}`,
            '',
            ended
              ? `Die PRO-Verifizierung deines Kontos (${u.organization}) ist am ${fmt(u.pro_valid_until)} abgelaufen. Geschützte Funde siehst du erst wieder, wenn sie verlängert ist.`
              : `Die PRO-Verifizierung deines Kontos (${u.organization}) gilt bis ${fmt(u.pro_valid_until)}. Sie wird jedes Jahr bestätigt.`,
            ...(auth.orgs.dependants(u.id) ? [`Du leitest eine Organisation: ihre ${auth.orgs.dependants(u.id)} weiteren Mitglieder sehen geschützte Funde nur, solange eine Person der Leitung verifiziert ist.`] : []),
            '',
            `Bitte bestätige deine Angaben: ${link} → Konto-Menü → PRO-Mitgliedschaft → Verlängern.`,
          ].join('\n'),
        });
        db.prepare('UPDATE users SET pro_reminded_at = ? WHERE id = ?').run(now, u.id);
        sent++;
      } catch (err) {
        console.error(`Erinnerung an PRO-Konto ${u.id} fehlgeschlagen: ${err.message}`);
      }
    }
    return sent;
  }
  if (ctx.proReminders !== false) setInterval(() => remindPro().catch(() => {}), 24 * 3600 * 1000).unref?.();

  /* ---------- Helpers for app.js ---------- */

  return {
    remindPro,
    canSeeHidden,
    /** SQL condition for visible photo rows (alias `p` by default) in this request. */
    visibleSql: (req, alias) => visibleSql(view(req), alias),
    publicSql: (alias) => visibleSql(false, alias),
    view,
    canSeeProtected: (req) => canSeeProtected(req.user),
    /** Ids of the spots with at least one photo this request may see. */
    visibleSpotIds(req) {
      return new Set(db.prepare(`SELECT DISTINCT p.spot_id AS id FROM photos p WHERE ${visibleSql(view(req), 'p')}`).all().map((r) => r.id));
    },

    /** Uploader and licence for an upload, or `{ error }` for an unknown licence. */
    uploadOwner(req) {
      const license = parseLicense(req.body?.license);
      if (license === false) return { error: `Lizenz muss eine von ${Object.keys(LICENSES).join(', ')} sein` };
      const user = req.user;
      if (user && license && license !== user.default_license) {
        db.prepare('UPDATE users SET default_license = ? WHERE id = ?').run(license, user.id);
      }
      return { userId: user?.id ?? null, license: license || user?.default_license || DEFAULT_LICENSE };
    },
    stampPhoto(photoId, owner) {
      db.prepare('UPDATE photos SET uploader_id = ?, license = ? WHERE id = ?').run(owner.userId, owner.license, photoId);
    },

    /** Extra fields for a photo's JSON: uploader (attribution), licence, moderation state. */
    photoExtras(p) {
      const u = p.uploader_id ? userName.get(p.uploader_id) : null;
      return {
        uploader: u ? { id: u.id, name: u.name } : null,
        license: licenseJson(p.license),
        hidden: Boolean(p.hidden_at),
        protected: Boolean(p.protected),
        ...(p.protected ? { protectedReason: p.protected_reason } : {}),
        ...(p.hidden_at ? { hiddenReason: p.hidden_reason } : {}),
      };
    },
  };
};
