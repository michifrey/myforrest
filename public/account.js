'use strict';

/* =========================================================
   Accounts, licences, reports and moderation (frontend)
   Uses the globals of app.js: $, el, api, state, loadSpots, openSpot, fmtDate, fmtDateTime.
   ========================================================= */

const Account = {
  user: null,
  csrf: null,
  requireLogin: false,
  requireVerifiedEmail: false,
  licenses: [],
  defaultLicense: 'cc-by-sa-4.0',
  reportReasons: {},
  providers: [], // identity providers enabled on the server: [{ id, label }]
};
window.Account = Account;

// Every state-changing same-origin request carries the session's CSRF token.
(() => {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const isReq = input instanceof Request;
    const method = String(init.method || (isReq ? input.method : 'GET')).toUpperCase();
    const url = new URL(isReq ? input.url : input, location.href);
    if (Account.csrf && url.origin === location.origin && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const headers = new Headers(init.headers || (isReq ? input.headers : undefined));
      headers.set('X-CSRF-Token', Account.csrf);
      init = { ...init, headers };
    }
    return nativeFetch(input, init);
  };
})();

const isMod = () => Account.user && (Account.user.role === 'moderator' || Account.user.role === 'admin');
const ROLE_LABEL = { user: 'Mitglied', moderator: 'Moderation', admin: 'Administration' };
const ACTION_LABEL = { hide: 'ausgeblendet', unhide: 'wieder eingeblendet', dismiss: 'Meldungen verworfen', delete: 'gelöscht', role: 'Rolle geändert' };
const licenseById = (id) => Account.licenses.find((l) => l.id === id);

const jsonPost = (url, body, method = 'POST') => api(url, {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
});

/** Re-reads the map and the open spot, e.g. after logging in or a moderation action. */
async function refreshViews() {
  const open = state.spot ? { id: state.spot.id, photo: state.spot.photos[state.index]?.id } : null;
  await loadSpots();
  if (!open) return;
  try {
    await openSpot(open.id, open.photo);
  } catch {
    $('close-spot').click();
  }
}

/* ---------- Account menu in the navigation ---------- */

const menuBtn = el('button', { type: 'button', id: 'account-btn', class: 'account-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
const menu = el('div', { id: 'account-menu', class: 'account-menu', role: 'menu', hidden: '' });
$('open-upload').before(el('div', { class: 'account' }, [menuBtn, menu]));

function renderNav() {
  const u = Account.user;
  menuBtn.replaceChildren();
  if (!u) {
    menuBtn.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="7" r="3.4"/>'
      + '<path d="M3.5 17.5c.8-3.4 3.4-5.2 6.5-5.2s5.7 1.8 6.5 5.2"/></svg><span class="account-label">Anmelden</span>';
    menuBtn.setAttribute('aria-label', 'Anmelden oder registrieren');
    menuBtn.removeAttribute('aria-haspopup');
    return;
  }
  menuBtn.setAttribute('aria-haspopup', 'menu');
  menuBtn.setAttribute('aria-label', `Konto ${u.name}`);
  menuBtn.append(
    el('span', { class: 'avatar', text: u.name.slice(0, 1).toUpperCase(), 'aria-hidden': 'true' }),
    el('span', { class: 'account-label', text: u.name }),
  );
  const item = (text, onclick, extra = {}) => el('button', { type: 'button', role: 'menuitem', class: 'menu-item', onclick, ...extra }, text);
  const linked = u.identities || [];
  const providerItems = Account.providers.map((p) => (linked.includes(p.id)
    ? item(`${p.label} trennen`, () => unlinkProvider(p))
    : el('a', { role: 'menuitem', class: 'menu-item', href: `/api/auth/oauth/${p.id}`, text: `Mit ${p.label} verknüpfen` })));
  const via = linked.map((id) => Account.providers.find((p) => p.id === id)?.label || id);
  menu.replaceChildren(
    el('div', { class: 'menu-who' }, [
      el('strong', { text: u.name }),
      el('span', { class: 'muted small', text: `${u.email}${u.emailVerified ? ' ✓' : ''} · ${ROLE_LABEL[u.role]}` }),
      ...(via.length ? [el('span', { class: 'muted small', text: `Anmeldung über ${via.join(', ')}${u.hasPassword ? ' oder Passwort' : ''}` })] : []),
      ...(u.emailVerified ? [] : [el('span', { class: 'menu-unverified small', text: 'E-Mail-Adresse noch nicht bestätigt' })]),
    ]),
    ...(u.emailVerified ? [] : [item('Bestätigungslink senden', resendVerification)]),
    ...providerItems,
    ...(isMod() ? [item('Moderation', () => openModeration('reported'))] : []),
    ...(u.role === 'admin' ? [item('Konten & Rollen', () => openModeration('users'))] : []),
    item('Abmelden', logout, { class: 'menu-item danger' }),
  );
}

function toggleMenu(open = menu.hidden) {
  menu.hidden = !open;
  menuBtn.setAttribute('aria-expanded', String(open));
  if (open) menu.querySelector('button')?.focus();
}
menuBtn.addEventListener('click', () => (Account.user ? toggleMenu() : openAuth('login')));
document.addEventListener('click', (e) => { if (!menu.hidden && !e.target.closest('.account')) toggleMenu(false); });
menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { toggleMenu(false); menuBtn.focus(); } });
menu.addEventListener('click', (e) => { if (e.target.closest('.menu-item')) toggleMenu(false); });

const VERIFY_MESSAGE = {
  sent: (email) => `Wir haben dir einen Bestätigungslink an ${email} geschickt. Er ist 24 Stunden gültig.`,
  logged: () => 'Auf diesem Server ist kein E-Mail-Versand eingerichtet; der Bestätigungslink steht im Server-Log.',
  failed: () => 'Der Bestätigungslink konnte gerade nicht verschickt werden. Im Konto-Menü kannst du ihn später neu anfordern.',
};

async function resendVerification() {
  try {
    const r = await jsonPost('/api/auth/verify/resend');
    alert(VERIFY_MESSAGE[r.verification](Account.user.email));
  } catch (err) {
    alert(err.message);
  }
}

async function unlinkProvider(p) {
  if (!confirm(`Anmeldung mit ${p.label} von diesem Konto trennen?`)) return;
  try {
    const r = await api(`/api/auth/identities/${p.id}`, { method: 'DELETE' });
    Account.user = r.user;
    renderNav();
  } catch (err) {
    alert(err.message);
  }
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  Account.user = null;
  Account.csrf = null;
  renderNav();
  fillLicenseSelect();
  await refreshViews();
}

/* ---------- Login / registration dialog ---------- */

const authDialog = el('dialog', { id: 'auth-dialog', class: 'auth-dialog', 'aria-labelledby': 'auth-title' });
authDialog.innerHTML = `
  <form id="auth-form" method="dialog" novalidate>
    <div class="dialog-head">
      <p class="eyebrow">Konto</p>
      <h2 id="auth-title">Anmelden</h2>
    </div>
    <div class="tabs" role="tablist" data-modes="login register">
      <button type="button" role="tab" data-mode="login" aria-selected="true">Anmelden</button>
      <button type="button" role="tab" data-mode="register" aria-selected="false">Registrieren</button>
    </div>
    <p id="auth-intro" class="muted small"></p>
    <div id="auth-providers" class="auth-providers" hidden></div>
    <label class="field" data-modes="register"><span>Name <em>wird bei deinen Fotos genannt</em></span>
      <input name="name" autocomplete="nickname" maxlength="40"></label>
    <label class="field" data-modes="login register forgot"><span id="auth-login-label">E-Mail oder Name</span>
      <input name="login" autocomplete="username" required></label>
    <label class="field" data-modes="login register reset"><span><span id="auth-password-label">Passwort</span>
      <em data-modes="register reset">mindestens 8 Zeichen</em></span>
      <input name="password" type="password" autocomplete="current-password" required minlength="8"></label>
    <p class="auth-switch small" data-modes="login"><button type="button" class="link" data-to="forgot">Passwort vergessen?</button></p>
    <p class="auth-switch small" data-modes="forgot"><button type="button" class="link" data-to="login">Zurück zur Anmeldung</button></p>
    <p id="auth-error" class="auth-error" role="alert" hidden></p>
    <div class="row end">
      <button type="button" class="link" id="auth-cancel">Abbrechen</button>
      <button type="submit" class="btn primary" id="auth-submit">Anmelden</button>
    </div>
  </form>`;
document.body.append(authDialog);
const authForm = authDialog.querySelector('form');
let authMode = 'login';
let afterAuth = null;
let resetToken = null;

// Modes of the dialog: log in, register, ask for a reset link, set a new password from the link.
const AUTH_MODES = {
  login: { title: 'Anmelden', submit: 'Anmelden', login: 'E-Mail oder Name', password: 'Passwort' },
  register: { title: 'Konto erstellen', submit: 'Registrieren', login: 'E-Mail', password: 'Passwort' },
  forgot: { title: 'Passwort vergessen', submit: 'Link senden', login: 'E-Mail' },
  reset: { title: 'Neues Passwort', submit: 'Passwort speichern', password: 'Neues Passwort' },
};

function setAuthMode(mode) {
  authMode = mode;
  const m = AUTH_MODES[mode];
  authDialog.querySelectorAll('[role="tab"]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.mode === mode)));
  authDialog.querySelectorAll('[data-modes]').forEach((n) => { n.hidden = !n.dataset.modes.split(' ').includes(mode); });
  if (m.login) $('auth-login-label').textContent = m.login;
  if (m.password) $('auth-password-label').textContent = m.password;
  const byEmail = mode !== 'login';
  authForm.login.type = byEmail ? 'email' : 'text';
  authForm.login.autocomplete = byEmail ? 'email' : 'username';
  authForm.password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('auth-title').textContent = m.title;
  renderProviders();
  $('auth-submit').textContent = m.submit;
  $('auth-submit').hidden = false;
  $('auth-error').hidden = true;
  $('auth-error').classList.remove('ok');
}
const setIntro = (text) => {
  $('auth-intro').textContent = text;
  $('auth-intro').hidden = !text;
};
authDialog.querySelectorAll('[role="tab"]').forEach((t) => t.addEventListener('click', () => setAuthMode(t.dataset.mode)));
authDialog.querySelectorAll('[data-to]').forEach((b) => b.addEventListener('click', () => {
  setAuthMode(b.dataset.to);
  setIntro(b.dataset.to === 'forgot' ? 'Gib die E-Mail-Adresse deines Kontos an. Wir schicken dir einen Link, mit dem du ein neues Passwort festlegst.' : '');
  authForm.login.focus();
}));

/** "Continue with Google/GitHub": a plain link, the server redirects to the provider and back. */
function renderProviders() {
  const box = $('auth-providers');
  box.hidden = !Account.providers.length || !['login', 'register'].includes(authMode);
  box.replaceChildren(
    ...Account.providers.map((p) => el('a', {
      class: `btn secondary provider provider-${p.id}`, href: `/api/auth/oauth/${p.id}`, text: `Mit ${p.label} ${authMode === 'register' ? 'registrieren' : 'anmelden'}`,
    })),
    el('p', { class: 'auth-or muted small', text: authMode === 'register' ? 'oder mit E-Mail und Passwort' : 'oder mit E-Mail/Name und Passwort' }),
  );
}
$('auth-cancel').addEventListener('click', () => authDialog.close());

/** Opens the dialog; `then` runs after a successful login (e.g. continue to the upload). */
function openAuth(mode = 'login', { intro = '', then = null } = {}) {
  authForm.reset();
  setAuthMode(mode);
  setIntro(intro);
  afterAuth = then;
  authDialog.showModal();
}
Account.openAuth = openAuth;

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = authForm;
  const submit = $('auth-submit');
  submit.disabled = true;
  try {
    const [url, body] = {
      login: ['login', { login: f.login.value, password: f.password.value }],
      register: ['register', { email: f.login.value, name: f.name.value, password: f.password.value }],
      forgot: ['password/forgot', { email: f.login.value }],
      reset: ['password/reset', { token: resetToken, password: f.password.value }],
    }[authMode];
    const res = await fetch(`/api/auth/${url}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (authMode === 'forgot') {
      $('auth-error').textContent = `Falls es zu ${f.login.value.trim()} ein Konto gibt, ist ein Link unterwegs. Er ist 1 Stunde gültig – schau auch im Spam-Ordner nach.`;
      $('auth-error').classList.add('ok');
      $('auth-error').hidden = false;
      submit.hidden = true;
      return;
    }
    const wasReset = authMode === 'reset';
    resetToken = null;
    Account.user = data.user;
    Account.csrf = data.csrfToken;
    authDialog.close();
    renderNav();
    fillLicenseSelect();
    await refreshViews();
    if (data.verification) alert(VERIFY_MESSAGE[data.verification](data.user.email));
    if (wasReset) alert('Dein neues Passwort ist gespeichert. Du bist angemeldet; auf anderen Geräten bist du abgemeldet.');
    const next = afterAuth;
    afterAuth = null;
    next?.();
  } catch (err) {
    $('auth-error').textContent = err.message;
    $('auth-error').hidden = false;
  } finally {
    submit.disabled = false;
  }
});

// With REQUIRE_LOGIN, uploading and repeat photos ask to log in first
// (and with REQUIRE_VERIFIED_EMAIL, to confirm the address).
document.addEventListener('click', (e) => {
  const trigger = e.target.closest('#open-upload, #open-camera, [data-action="upload"]');
  if (!trigger) return;
  if (Account.user && Account.requireVerifiedEmail && !Account.user.emailVerified) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (confirm('Zum Beitragen von Fotos muss deine E-Mail-Adresse bestätigt sein. Neuen Bestätigungslink senden?')) resendVerification();
    return;
  }
  if (!Account.requireLogin || Account.user) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  openAuth('login', {
    intro: 'Zum Beitragen von Fotos ist ein Konto nötig.',
    then: () => trigger.click(),
  });
}, true);

/* ---------- Licence in the upload form ---------- */

function fillLicenseSelect() {
  const select = $('upload-license');
  if (!select) return;
  const chosen = Account.user?.defaultLicense || Account.defaultLicense;
  // defaultSelected: the form's reset() on opening the dialog keeps this choice.
  select.replaceChildren(...Account.licenses.map((l) => {
    const o = el('option', { value: l.id, text: l.label });
    o.defaultSelected = l.id === chosen;
    return o;
  }));
  select.value = chosen;
  updateLicenseHint();
}
function updateLicenseHint() {
  const l = licenseById($('upload-license')?.value);
  const hint = $('upload-license-hint');
  if (!hint || !l) return;
  const who = Account.user ? `als «${Account.user.name}»` : 'als «Anonym»';
  hint.replaceChildren(
    `Fotos werden ${who} genannt. `,
    l.url ? el('a', { href: l.url, target: '_blank', rel: 'noopener', text: 'Was bedeutet das?' }) : 'Nur Ansicht in MyForrest, keine Weiterverwendung.',
  );
}
$('upload-license')?.addEventListener('change', updateLicenseHint);
$('upload-form').addEventListener('reset', () => setTimeout(updateLicenseHint));

/* ---------- Credit, licence and actions next to each photo ---------- */

const credit = el('div', { id: 'photo-credit', class: 'photo-credit' });
$('viewer-caption').closest('.viewer').after(credit);

function canEdit(p) {
  if (isMod()) return true;
  if (p.uploader) return Boolean(Account.user && Account.user.id === p.uploader.id);
  return !Account.requireLogin || Boolean(Account.user);
}
function canDelete(p) {
  if (isMod()) return true;
  if (p.uploader) return Boolean(Account.user && Account.user.id === p.uploader.id);
  return !Account.requireLogin;
}

Account.photoShown = (p) => {
  const own = Boolean(Account.user && p.uploader && Account.user.id === p.uploader.id);
  const lic = p.license || licenseById(Account.defaultLicense);
  const licNode = lic.url
    ? el('a', { href: lic.url, target: '_blank', rel: 'license noopener', text: lic.label })
    : el('span', { text: lic.label });
  const parts = [
    el('span', { class: 'credit-by' }, ['Foto: ', el('strong', { text: p.uploader ? p.uploader.name : 'Anonym' })]),
    el('span', { class: 'credit-lic' }, ['Lizenz: ', licNode]),
  ];
  if (own) {
    const sel = el('select', { 'aria-label': 'Lizenz ändern', class: 'credit-select' },
      Account.licenses.map((l) => el('option', { value: l.id, text: l.label })));
    sel.value = lic.id;
    sel.addEventListener('change', async () => {
      try {
        const updated = await jsonPost(`/api/photos/${p.id}`, { license: sel.value }, 'PATCH');
        Object.assign(p, { license: updated.license });
        Account.photoShown(p);
      } catch (err) {
        alert(err.message);
        sel.value = lic.id;
      }
    });
    parts[1] = el('label', { class: 'credit-lic' }, ['Lizenz: ', sel]);
  }
  const actions = el('span', { class: 'credit-actions' });
  if (!own) actions.append(el('button', { type: 'button', class: 'link small', onclick: () => openReport(p), text: 'Melden' }));
  if (isMod()) {
    actions.append(p.hidden
      ? el('button', { type: 'button', class: 'link small', text: 'Einblenden', onclick: () => moderate(p.id, 'unhide') })
      : el('button', { type: 'button', class: 'link small danger', text: 'Ausblenden', onclick: () => hidePrompt(p.id) }));
  }
  parts.push(actions);
  credit.replaceChildren(...parts);
  if (p.hidden) {
    credit.prepend(el('span', { class: 'hidden-badge', text: p.hiddenReason ? `Ausgeblendet: ${p.hiddenReason}` : 'Ausgeblendet' }));
  }
  credit.classList.toggle('is-hidden', Boolean(p.hidden));

  $('save-photo').hidden = !canEdit(p);
  $('delete-photo').hidden = !canDelete(p);
  [...$('thumbs').children].forEach((b, i) => b.classList.toggle('is-hidden', Boolean(state.spot.photos[i]?.hidden)));
};

/* ---------- Reporting a photo ---------- */

const reportDialog = el('dialog', { id: 'report-dialog', 'aria-labelledby': 'report-title' });
reportDialog.innerHTML = `
  <form method="dialog">
    <div class="dialog-head">
      <p class="eyebrow">Melden</p>
      <h2 id="report-title">Foto melden</h2>
    </div>
    <p class="muted small" id="report-what"></p>
    <fieldset class="field"><legend>Grund</legend><div id="report-reasons" class="checks"></div></fieldset>
    <label class="field"><span>Hinweis <em>optional</em></span><textarea name="note" rows="2" maxlength="1000"></textarea></label>
    <p id="report-msg" class="auth-error" role="alert" hidden></p>
    <div class="row end">
      <button type="button" class="link" id="report-cancel">Abbrechen</button>
      <button type="submit" class="btn primary" id="report-submit">Meldung senden</button>
    </div>
  </form>`;
document.body.append(reportDialog);
$('report-cancel').addEventListener('click', () => reportDialog.close());
let reportPhoto = null;

function openReport(p) {
  reportPhoto = p;
  const form = reportDialog.querySelector('form');
  form.reset();
  $('report-what').textContent = `Foto vom ${fmtDate(p.takenAt)} an Spot ${p.spotId}. Die Moderation prüft die Meldung.`;
  $('report-reasons').replaceChildren(...Object.entries(Account.reportReasons).map(([k, label], i) =>
    el('label', {}, [el('input', { type: 'radio', name: 'reason', value: k, ...(i === 0 ? { required: '' } : {}) }), label])));
  $('report-msg').hidden = true;
  $('report-submit').hidden = false;
  reportDialog.showModal();
}
reportDialog.querySelector('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  if (!form.reason.value) {
    $('report-msg').textContent = 'Bitte einen Grund wählen.';
    $('report-msg').hidden = false;
    return;
  }
  try {
    await jsonPost(`/api/photos/${reportPhoto.id}/report`, { reason: form.reason.value, note: form.note.value });
    $('report-msg').textContent = 'Danke! Die Meldung ist eingegangen.';
    $('report-msg').classList.add('ok');
    $('report-submit').hidden = true;
  } catch (err) {
    $('report-msg').textContent = err.message;
    $('report-msg').classList.remove('ok');
  }
  $('report-msg').hidden = false;
});

/* ---------- Moderation view ---------- */

const modDialog = el('dialog', { id: 'mod-dialog', class: 'mod-dialog', 'aria-labelledby': 'mod-title' });
modDialog.innerHTML = `
  <div class="dialog-head mod-head">
    <div>
      <p class="eyebrow">Moderation</p>
      <h2 id="mod-title">Gemeldete Fotos</h2>
    </div>
    <button type="button" class="icon" id="mod-close" aria-label="Schliessen">×</button>
  </div>
  <div class="tabs mod-tabs" role="tablist">
    <button type="button" role="tab" data-tab="reported" aria-selected="true">Meldungen <span class="count" id="mod-count"></span></button>
    <button type="button" role="tab" data-tab="hidden" aria-selected="false">Ausgeblendet</button>
    <button type="button" role="tab" data-tab="log" aria-selected="false">Protokoll</button>
    <button type="button" role="tab" data-tab="users" aria-selected="false" data-admin>Konten</button>
  </div>
  <div id="mod-body" class="mod-body" aria-live="polite"></div>`;
document.body.append(modDialog);
$('mod-close').addEventListener('click', () => modDialog.close());
modDialog.querySelectorAll('[role="tab"]').forEach((t) => t.addEventListener('click', () => showModTab(t.dataset.tab)));
let modTab = 'reported';

function openModeration(tab = 'reported') {
  modDialog.querySelector('[data-admin]').hidden = Account.user?.role !== 'admin';
  modDialog.showModal();
  showModTab(tab);
}
Account.openModeration = openModeration;

const TAB_TITLE = { reported: 'Gemeldete Fotos', hidden: 'Ausgeblendete Fotos', log: 'Protokoll', users: 'Konten & Rollen' };

async function showModTab(tab) {
  modTab = tab;
  modDialog.querySelectorAll('[role="tab"]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === tab)));
  $('mod-title').textContent = TAB_TITLE[tab];
  const body = $('mod-body');
  body.replaceChildren(el('p', { class: 'muted', text: 'Lade …' }));
  try {
    if (tab === 'log') return renderLog(await api('/api/moderation/log'));
    if (tab === 'users') return renderUsers(await api('/api/users'));
    const q = await api('/api/moderation/queue');
    $('mod-count').textContent = q.reported.length ? String(q.reported.length) : '';
    const items = tab === 'reported' ? q.reported : q.hidden.map((photo) => ({ photo, reports: [] }));
    body.replaceChildren(...(items.length ? items.map(modCard)
      : [el('p', { class: 'mod-empty muted', text: tab === 'reported' ? 'Keine offenen Meldungen.' : 'Keine ausgeblendeten Fotos.' })]));
  } catch (err) {
    body.replaceChildren(el('p', { class: 'auth-error', text: err.message }));
  }
}

function modCard({ photo: p, reports }) {
  const btn = (text, onclick, cls = 'secondary') => el('button', { type: 'button', class: cls, text, onclick });
  return el('article', { class: `mod-card${p.hidden ? ' is-hidden' : ''}` }, [
    el('a', { href: p.url, target: '_blank', rel: 'noopener', class: 'mod-thumb' }, el('img', { src: p.url, alt: `Foto ${p.id}`, loading: 'lazy' })),
    el('div', { class: 'mod-info' }, [
      el('strong', { text: `Foto ${p.id} · Spot ${p.spotId}` }),
      el('span', { class: 'muted small', text: `${fmtDateTime(p.takenAt)} · ${p.uploader ? p.uploader.name : 'Anonym'} · ${p.license.label}` }),
      ...(p.hidden ? [el('span', { class: 'hidden-badge', text: p.hiddenReason ? `Ausgeblendet: ${p.hiddenReason}` : 'Ausgeblendet' })] : []),
      ...(reports.length ? [el('ul', { class: 'mod-reports' }, reports.map((r) => el('li', {}, [
        el('b', { text: r.reasonLabel }),
        r.note ? ` – «${r.note}»` : '',
        el('span', { class: 'muted small', text: ` · ${r.reporter || 'anonym'}, ${fmtDate(r.createdAt)}` }),
      ])))] : []),
      el('div', { class: 'row mod-actions' }, [
        p.hidden ? btn('Einblenden', () => moderate(p.id, 'unhide')) : btn('Ausblenden', () => hidePrompt(p.id), 'primary'),
        ...(reports.length && !p.hidden ? [btn('Meldung verwerfen', () => moderate(p.id, 'dismiss'))] : []),
        btn('Zum Spot', async () => { modDialog.close(); await openSpot(p.spotId, p.id); $('explore').scrollIntoView({ behavior: 'smooth' }); }, 'link small'),
        btn('Löschen', () => deletePhoto(p), 'link small danger'),
      ]),
    ]),
  ]);
}

function renderLog(entries) {
  $('mod-body').replaceChildren(entries.length
    ? el('ol', { class: 'mod-log' }, entries.map((l) => el('li', {}, [
      el('span', { class: 'muted small', text: fmtDateTime(l.createdAt) }),
      el('span', {}, [
        el('b', { text: l.actor || 'System' }), ' ',
        ACTION_LABEL[l.action] || l.action,
        l.photoId ? `: Foto ${l.photoId}` : '',
        l.targetUser ? ` (${l.targetUser})` : '',
        l.detail ? ` – ${l.detail}` : '',
      ]),
    ])))
    : el('p', { class: 'muted', text: 'Noch keine Einträge.' }));
}

function renderUsers(users) {
  $('mod-body').replaceChildren(el('table', { class: 'mod-users' }, [
    el('thead', {}, el('tr', {}, ['Name', 'E-Mail', 'Fotos', 'Rolle'].map((h) => el('th', { text: h })))),
    el('tbody', {}, users.map((u) => {
      const sel = el('select', { 'aria-label': `Rolle von ${u.name}` },
        Object.entries(ROLE_LABEL).map(([k, label]) => el('option', { value: k, text: label })));
      sel.value = u.role;
      if (u.id === Account.user.id) sel.disabled = true;
      sel.addEventListener('change', async () => {
        try {
          await jsonPost(`/api/users/${u.id}`, { role: sel.value }, 'PATCH');
        } catch (err) {
          alert(err.message);
          sel.value = u.role;
        }
      });
      return el('tr', {}, [el('td', { text: u.name }), el('td', { text: u.email }), el('td', { text: String(u.photos) }), el('td', {}, sel)]);
    })),
  ]));
}

async function moderate(photoId, action, body) {
  try {
    await jsonPost(`/api/moderation/photos/${photoId}/${action}`, body);
    await refreshViews();
    if (modDialog.open) showModTab(modTab);
  } catch (err) {
    alert(err.message);
  }
}
function hidePrompt(photoId) {
  const reason = prompt('Foto ausblenden – Begründung (optional, nur für die Moderation sichtbar):', '');
  if (reason === null) return;
  moderate(photoId, 'hide', { reason });
}
async function deletePhoto(p) {
  if (!confirm(`Foto ${p.id} vom ${fmtDate(p.takenAt)} endgültig löschen?`)) return;
  try {
    await api(`/api/photos/${p.id}`, { method: 'DELETE' });
    await refreshViews();
    showModTab(modTab);
  } catch (err) {
    alert(err.message);
  }
}

/* ---------- Back from Google/GitHub (/?auth=… or /?auth_error=…) ---------- */

/** The link from the reset e-mail: /#reset=<token>. */
async function resetFromLink() {
  const m = location.hash.match(/^#reset=([\w-]+)$/);
  if (!m) return false;
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  openAuth('reset');
  try {
    const who = await api(`/api/auth/password/reset?token=${encodeURIComponent(m[1])}`);
    resetToken = m[1];
    setIntro(`Für das Konto «${who.name}» (${who.email}). Danach bist du auf allen anderen Geräten abgemeldet.`);
    authForm.password.focus();
  } catch (err) {
    setAuthMode('forgot');
    setIntro('');
    $('auth-error').textContent = err.message;
    $('auth-error').hidden = false;
  }
  return true;
}

function authReturn() {
  if (location.hash.startsWith('#reset=')) return resetFromLink();
  const q = new URLSearchParams(location.search);
  const error = q.get('auth_error');
  const result = q.get('auth');
  if (!error && !result) return;
  q.delete('auth_error');
  q.delete('auth');
  const provider = Account.providers.find((p) => p.id === q.get('provider'));
  q.delete('provider');
  history.replaceState(null, '', `${location.pathname}${q.size ? `?${q}` : ''}${location.hash}`);
  if (error) {
    openAuth('login');
    $('auth-error').textContent = error;
    $('auth-error').hidden = false;
  } else if (result === 'verified') {
    alert('Danke! Deine E-Mail-Adresse ist bestätigt.');
  } else if (result === 'linked' && provider) {
    alert(`${provider.label} ist jetzt mit deinem Konto verknüpft.`);
  } else if (result === 'created' && Account.user) {
    alert(`Willkommen, ${Account.user.name}! Dein Konto ist angelegt. Deine Fotos werden unter diesem Namen genannt.`);
  }
}

/* ---------- Init ---------- */

(async function initAccount() {
  renderNav();
  try {
    const me = await api('/api/auth/me');
    Object.assign(Account, {
      user: me.user,
      csrf: me.csrfToken,
      requireLogin: me.requireLogin,
      requireVerifiedEmail: Boolean(me.requireVerifiedEmail),
      licenses: me.licenses,
      defaultLicense: me.defaultLicense,
      reportReasons: me.reportReasons,
      providers: me.providers || [],
    });
  } catch {
    // Server without accounts: keep the defaults.
  }
  renderNav();
  authReturn();
  fillLicenseSelect();
  if (state.spot) Account.photoShown(state.spot.photos[state.index]);
  // A moderator sees hidden photos: reload once the session is known.
  if (isMod()) refreshViews();
})();
