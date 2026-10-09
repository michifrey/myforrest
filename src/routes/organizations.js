'use strict';

/**
 * Organisations with several members (src/orgs.js): their leads add and
 * remove colleagues and hand the lead on; admins see and correct all of them.
 *
 *   GET    /api/organizations/mine                     own organisations with members
 *   GET    /api/organizations                          all (admins)
 *   POST   /api/organizations/:id/members              { account: name or e-mail, role? } (leads, admins)
 *   PATCH  /api/organizations/:id/members/:userId      { role: leitung | mitglied } (leads, admins)
 *   DELETE /api/organizations/:id/members/:userId      leads, admins, or the member itself (leave)
 *   DELETE /api/organizations/:id/invites/:inviteId    withdraw an invitation (leads, admins)
 *   POST   /api/organizations/invites/lookup           { token }: what an invitation link is about
 *   POST   /api/organizations/invites/accept           { token }: join, logged in with the invited address
 *
 * Adding an e-mail address without a confirmed account sends an invitation
 * link instead (14 days); whoever opens it registers or logs in with that
 * address and joins.
 */

const { createLimiter } = require('../auth');
const { ORG_ROLES } = require('../orgs');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

module.exports = function registerOrganizations(app, { db, auth, mod, mailer, publicUrl, limits = {}, fail, adminOnly }) {
  const orgs = auth.orgs;
  const addPerUser = createLimiter({ max: limits.orgAddPerUser ?? 50, windowMs: 24 * 3600 * 1000 });
  const isAdmin = (u) => u?.role === 'admin';

  /** The organisation of the request and what the current account may do in it, or an error sent. */
  function load(req, res) {
    if (!req.user) return void fail(res, 401, 'Bitte zuerst anmelden');
    const org = orgs.get(Number(req.params.id));
    const role = org ? orgs.roleOf(org.id, req.user.id) : null;
    if (!org || (!role && !isAdmin(req.user))) return void fail(res, 404, 'Organisation nicht gefunden');
    return { org, role, manages: role === 'leitung' || isAdmin(req.user) };
  }
  const reply = (res, req, org) => res.json(isAdmin(req.user) && !orgs.roleOf(org.id, req.user.id)
    ? orgs.json(orgs.get(org.id), { withEmail: true })
    : orgs.of(req.user.id, { withMembers: true }).find((o) => o.id === org.id) || null);

  app.get('/api/organizations/mine', (req, res) => {
    if (!req.user) return fail(res, 401, 'Bitte zuerst anmelden');
    res.json(orgs.of(req.user.id, { withMembers: true }));
  });

  app.get('/api/organizations', adminOnly, (req, res) => res.json(orgs.all()));

  app.post('/api/organizations/:id/members', (req, res) => {
    const c = load(req, res);
    if (!c) return;
    if (!c.manages) return fail(res, 403, 'Nur die Leitung der Organisation nimmt Mitglieder auf');
    // Only a verified organisation passes access on (admins may prepare one).
    if (!isAdmin(req.user) && !(c.org.valid_until > Date.now())) {
      return fail(res, 409, 'Die Organisation ist nicht (mehr) verifiziert – zuerst die PRO-Verifizierung der Leitung verlängern');
    }
    const role = req.body?.role ?? 'mitglied';
    if (!ORG_ROLES.includes(role)) return fail(res, 400, `Rolle muss eine von ${ORG_ROLES.join(', ')} sein`);
    const login = String(req.body?.account || '').trim();
    if (!login) return fail(res, 400, 'Bitte den Namen oder die E-Mail-Adresse des Kontos angeben');
    if (addPerUser.blocked(String(req.user.id))) return fail(res, 429, 'Zu viele Aufnahmen – bitte morgen wieder');
    addPerUser.hit(String(req.user.id));
    const row = db.prepare('SELECT id FROM users WHERE (email = ? OR name = ?) AND email_verified_at IS NOT NULL').get(login, login);
    const target = row ? auth.userById(row.id) : null;
    if (!target && EMAIL_RE.test(login) && login.length <= 200) return sendInvite(req, res, c.org, login, role);
    if (!target) return fail(res, 404, 'Kein Konto mit diesem Namen – mit der E-Mail-Adresse der Person kommt eine Einladung');
    if (orgs.roleOf(c.org.id, target.id)) return fail(res, 409, `${target.name} gehört schon zur Organisation`);
    if (!orgs.setMember(c.org.id, target.id, role, req.user.id)) return fail(res, 409, `Eine Organisation hat höchstens ${orgs.MAX_MEMBERS} Mitglieder`);
    mod.log(req.user, 'org-aufgenommen', { targetUserId: target.id, detail: `${c.org.name} (${role})` });
    const link = publicUrl ? `${publicUrl.replace(/\/+$/, '')}/` : 'MyForrest';
    mailer.send({
      to: target.email,
      subject: `MyForrest: Mitglied von ${c.org.name}`,
      text: [
        `Hallo ${target.name}`,
        '',
        `${req.user.name} hat dich in die Organisation ${c.org.name} aufgenommen${role === 'leitung' ? ', in die Leitung' : ''}.`,
        'Solange die Organisation verifiziert ist, siehst du geschützte Funde (seltene Pflanzen, Pilzstellen, Horste) mit genauer Lage.',
        'Bitte gib diese Orte nicht weiter.',
        '',
        `${link} → Konto-Menü → Organisation. Dort kannst du die Organisation auch wieder verlassen.`,
      ].join('\n'),
    }).catch((err) => console.error(`Mitteilung an Konto ${target.id} fehlgeschlagen: ${err.message}`));
    res.status(201);
    reply(res, req, c.org);
  });

  /** No account with a confirmed address yet: an invitation link by e-mail. */
  function sendInvite(req, res, org, email, role) {
    const token = orgs.invite(org.id, email, role, req.user.id);
    if (!token) return fail(res, 409, `Eine Organisation hat höchstens ${orgs.MAX_MEMBERS} Mitglieder und offene Einladungen`);
    mod.log(req.user, 'org-eingeladen', { detail: `${org.name}: ${email} (${role})` });
    const base = publicUrl ? publicUrl.replace(/\/+$/, '') : `${req.protocol}://${req.get('host')}`;
    mailer.send({
      to: email,
      subject: `MyForrest: Einladung in ${org.name}`,
      text: [
        'Hallo',
        '',
        `${req.user.name} lädt dich in die Organisation ${org.name} auf MyForrest ein${role === 'leitung' ? ', in die Leitung' : ''}.`,
        'Als Mitglied siehst du geschützte Funde (seltene Pflanzen, Pilzstellen, Horste) mit genauer Lage, solange die Organisation verifiziert ist.',
        '',
        `Einladung annehmen (14 Tage gültig): ${base}/#einladung=${token}`,
        '',
        `Du brauchst dafür ein Konto mit dieser Adresse (${email}); der Link legt es an oder meldet dich an.`,
        'Wenn du nichts damit anfangen kannst, ignoriere diese E-Mail.',
      ].join('\n'),
    }).catch((err) => console.error(`Einladung an ${email} fehlgeschlagen: ${err.message}`));
    res.status(202).json({ invited: email, organization: orgs.json(orgs.get(org.id), { withEmail: true }) });
  }

  app.delete('/api/organizations/:id/invites/:inviteId', (req, res) => {
    const c = load(req, res);
    if (!c) return;
    if (!c.manages) return fail(res, 403, 'Nur die Leitung der Organisation verwaltet Einladungen');
    if (!orgs.withdrawInvite(c.org.id, Number(req.params.inviteId))) return fail(res, 404, 'Einladung nicht gefunden');
    res.json(orgs.json(orgs.get(c.org.id), { withEmail: true }));
  });

  /* ---------- Opening an invitation link ---------- */

  const lookupPerIp = createLimiter({ max: limits.inviteLookupPerIp ?? 30, windowMs: 3600 * 1000 });
  const invitation = (req, res) => {
    if (lookupPerIp.blocked(req.ip)) return void fail(res, 429, 'Zu viele Versuche – bitte später erneut');
    lookupPerIp.hit(req.ip);
    const inv = orgs.inviteByToken(req.body?.token);
    if (!inv) return void fail(res, 404, 'Die Einladung ist abgelaufen, zurückgezogen oder schon angenommen – bitte um eine neue');
    return inv;
  };

  app.post('/api/organizations/invites/lookup', (req, res) => {
    const inv = invitation(req, res);
    if (!inv) return;
    res.json({
      organization: inv.org_name,
      email: inv.email,
      role: inv.role,
      expiresAt: new Date(inv.expires_at).toISOString(),
      // Whether to register or log in (the link goes to this address only).
      hasAccount: Boolean(db.prepare('SELECT 1 FROM users WHERE email = ?').get(inv.email)),
    });
  });

  app.post('/api/organizations/invites/accept', (req, res) => {
    if (!req.user) return fail(res, 401, 'Bitte zuerst anmelden oder registrieren');
    const inv = invitation(req, res);
    if (!inv) return;
    // Only the invited address: a forwarded link does not let someone else in.
    if (req.user.email.toLowerCase() !== inv.email.toLowerCase()) {
      return fail(res, 409, `Die Einladung gilt für ${inv.email} – bitte mit dieser Adresse anmelden oder registrieren`);
    }
    orgs.acceptInvite(inv, req.user.id);
    // The link came to this address: it is confirmed.
    if (!req.user.email_verified_at) db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').run(Date.now(), req.user.id);
    mod.log(req.user, 'org-einladung-angenommen', { targetUserId: req.user.id, detail: inv.org_name });
    res.json(orgs.of(req.user.id, { withMembers: true }));
  });

  app.patch('/api/organizations/:id/members/:userId', (req, res) => {
    const c = load(req, res);
    if (!c) return;
    if (!c.manages) return fail(res, 403, 'Nur die Leitung der Organisation vergibt Rollen');
    const userId = Number(req.params.userId);
    const current = orgs.roleOf(c.org.id, userId);
    if (!current) return fail(res, 404, 'Kein Mitglied dieser Organisation');
    const role = req.body?.role;
    if (!ORG_ROLES.includes(role)) return fail(res, 400, `Rolle muss eine von ${ORG_ROLES.join(', ')} sein`);
    if (current === 'leitung' && role !== 'leitung' && orgs.leads(c.org.id) <= 1) {
      return fail(res, 409, 'Die Organisation braucht mindestens eine Person in der Leitung');
    }
    orgs.setMember(c.org.id, userId, role, req.user.id);
    if (role !== current) mod.log(req.user, 'org-rolle', { targetUserId: userId, detail: `${c.org.name}: ${current} → ${role}` });
    reply(res, req, c.org);
  });

  app.delete('/api/organizations/:id/members/:userId', (req, res) => {
    const c = load(req, res);
    if (!c) return;
    const userId = Number(req.params.userId);
    const self = userId === req.user.id;
    if (!self && !c.manages) return fail(res, 403, 'Nur die Leitung der Organisation entfernt Mitglieder');
    const current = orgs.roleOf(c.org.id, userId);
    if (!current) return fail(res, 404, 'Kein Mitglied dieser Organisation');
    const others = orgs.members(c.org.id).length - 1;
    // The last lead hands the organisation on first (admins may dissolve it member by member).
    if (current === 'leitung' && orgs.leads(c.org.id) <= 1 && others > 0 && !isAdmin(req.user)) {
      return fail(res, 409, 'Zuerst die Leitung jemand anderem übergeben');
    }
    orgs.removeMember(c.org.id, userId);
    mod.log(req.user, self ? 'org-verlassen' : 'org-entfernt', { targetUserId: userId, detail: c.org.name });
    if (self || !orgs.get(c.org.id)) return res.json(orgs.of(req.user.id, { withMembers: true }));
    reply(res, req, c.org);
  });
};
