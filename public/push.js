'use strict';

/* =========================================================
   Push messages for the satellite early warning (frontend)
   - Account menu: switch push messages on or off for this device.
   - Spot view: whether this account is warned about the spot (regular
     visits or following), with follow / mute.
   Uses the globals of app.js and account.js: $, el, api, state, openSpot, Account, jsonPost, renderNav.
   ========================================================= */

(function pushModule() {
const Push = {
  supported: 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
  subscription: null, // of this device, when push is on here
};

const toast = (msg, opts) => (window.pwaNotify ? window.pwaNotify(msg, opts) : alert(msg));
const keyBytes = (b64u) => Uint8Array.from(atob(b64u.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64u.length % 4)) % 4)), (c) => c.charCodeAt(0));

async function pushRegistration() {
  if (!Push.supported) return null;
  return navigator.serviceWorker.getRegistration().then((r) => r || null).catch(() => null);
}

/** This device's subscription, if push is on here. */
async function readSubscription() {
  const reg = await pushRegistration();
  Push.subscription = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
  return Push.subscription;
}

async function pushOn() {
  if (!Push.supported) {
    toast('Dieser Browser kann keine Push-Nachrichten empfangen. Auf iPhone und iPad geht es, wenn MyForrest als App auf dem Home-Bildschirm installiert ist.', { sticky: true });
    return false;
  }
  const reg = await pushRegistration();
  if (!reg) {
    toast('Push-Nachrichten brauchen die installierbare App (Service Worker); bitte die Seite neu laden.', { sticky: true });
    return false;
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    toast('Benachrichtigungen sind für diese Seite blockiert. Sie lassen sich in den Website-Einstellungen des Browsers erlauben.', { sticky: true });
    return false;
  }
  try {
    const { publicKey } = await api('/api/push');
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
    await jsonPost('/api/push/subscriptions', sub.toJSON());
    Push.subscription = sub;
    toast('Push-Nachrichten sind auf diesem Gerät eingeschaltet.');
    return true;
  } catch (err) {
    toast(`Push-Nachrichten konnten nicht eingeschaltet werden: ${err.message}`, { sticky: true });
    return false;
  }
}

async function pushOff() {
  const sub = Push.subscription || await readSubscription();
  if (sub) {
    await jsonPost('/api/push/subscriptions', { endpoint: sub.endpoint }, 'DELETE').catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
  Push.subscription = null;
  toast('Push-Nachrichten sind auf diesem Gerät ausgeschaltet.');
}

/* ---------- Account menu ---------- */

// Adds the push entries to the menu account.js builds.
const baseRenderNav = renderNav;
renderNav = function renderNavWithPush() { // eslint-disable-line no-global-assign
  baseRenderNav();
  const menu = $('account-menu');
  const logoutItem = menu.querySelector('.menu-item.danger');
  if (!Account.user || !logoutItem) return;
  const item = (text, onclick) => el('button', { type: 'button', role: 'menuitem', class: 'menu-item', onclick }, text);
  const entries = Push.subscription
    ? [item('Push-Nachrichten ausschalten', async () => { await pushOff(); renderNav(); renderFollow(); }),
      item('Testnachricht senden', async () => {
        const r = await api('/api/push/test', { method: 'POST' }).catch(() => ({ delivered: 0 }));
        if (!r.delivered) toast('Die Testnachricht kam nicht an; der Push-Dienst lehnte sie ab.', { sticky: true });
      })]
    : [item('Push-Nachrichten einschalten', async () => { if (await pushOn()) { renderNav(); renderFollow(); } })];
  logoutItem.before(...entries);
};

/* ---------- Spot view: warned about this spot? ---------- */

const followRow = el('p', { id: 'spot-follow', class: 'spot-follow small' });
followRow.hidden = true;
$('spot-meta').after(followRow);
let follow = null;

const BELL = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3a4.5 4.5 0 0 0-4.5 4.5c0 3.6-1.5 5-1.5 5h12s-1.5-1.4-1.5-5A4.5 4.5 0 0 0 10 3zM8.3 15.5a1.8 1.8 0 0 0 3.4 0"/></svg>';

function renderFollow() {
  if (!Account.user || !follow || !state.spot) {
    followRow.hidden = true;
    return;
  }
  const f = follow;
  const set = (mode) => async () => {
    try {
      follow = await jsonPost(`/api/spots/${state.spot.id}/follow`, { mode }, 'PUT');
      if (follow.notified && !Push.subscription) await pushOn();
      renderFollow();
    } catch (err) {
      toast(err.message, { sticky: true });
    }
  };
  const btn = (text, onclick) => el('button', { type: 'button', class: 'link small', text, onclick });
  let text;
  let actions;
  if (f.mode === 'stumm') {
    text = 'Frühwarnungen für diesen Spot sind stummgeschaltet.';
    actions = [btn('Wieder benachrichtigen', set(null))];
  } else if (f.mode === 'folgen') {
    text = 'Du folgst diesem Spot: Sieht der Satellit hier einen Rückgang, kommt eine Push-Nachricht.';
    actions = [btn('Nicht mehr folgen', set(null))];
  } else if (f.regular) {
    text = `Du warst an ${f.days} Tagen hier: Sieht der Satellit einen Rückgang, kommt eine Push-Nachricht.`;
    actions = [btn('Stummschalten', set('stumm'))];
  } else {
    text = `Push-Nachricht bei einem Rückgang im Satellitenbild: automatisch ab ${f.regularDays} Besuchen mit Foto, oder`;
    actions = [btn('Spot folgen', set('folgen'))];
  }
  const parts = [el('span', { text: `${text} ` }), ...actions];
  if (f.notified && !Push.subscription) {
    parts.push(el('span', { class: 'follow-device' }, ['Auf diesem Gerät sind Push-Nachrichten aus. ',
      btn('Einschalten', async () => { if (await pushOn()) { renderNav(); renderFollow(); } })]));
  }
  followRow.innerHTML = BELL;
  followRow.append(...parts);
  followRow.classList.toggle('is-on', f.notified);
  followRow.hidden = false;
}

async function loadFollow() {
  follow = null;
  renderFollow();
  if (!Account.user || !state.spot) return;
  const id = state.spot.id;
  const f = await api(`/api/spots/${id}/follow`).catch(() => null);
  if (state.spot?.id === id) {
    follow = f;
    renderFollow();
  }
}

const baseOpenSpotPush = openSpot;
openSpot = async function openSpotWithFollow(...args) { // eslint-disable-line no-global-assign
  const r = await baseOpenSpotPush(...args);
  loadFollow();
  return r;
};

(async function initPush() {
  await readSubscription();
  renderNav();
  // Logging in or out redraws the menu; the spot row follows.
  const nav = $('account-btn');
  new MutationObserver(() => { if (state.spot) loadFollow(); }).observe(nav, { childList: true });
})();
}());
