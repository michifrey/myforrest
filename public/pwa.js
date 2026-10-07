'use strict';

/*
 * Installable app and offline uploads (page side).
 *
 * Registers the service worker, shows the queue of uploads waiting for a
 * connection (with discard), sends them when back online, offers the install
 * prompt (and the iOS "Zum Home-Bildschirm" hint) and adds a camera button
 * to the upload dialog. Everything degrades silently: without service worker,
 * IndexedDB or Background Sync the app works as before.
 *
 * Uses from app.js (optional): loadSpots(), setPicked(), state, L.
 */
(function () {
  const q = window.offlineQueue;
  const byId = (id) => document.getElementById(id);

  function h(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(children)) if (c !== null && c !== undefined) node.append(c);
    return node;
  }
  const icon = (d) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 20 20');
    s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    s.append(p);
    return s;
  };
  const ICON_QUEUE = 'M5.5 15.5h9a3.5 3.5 0 0 0 .4-7A5 5 0 0 0 5.2 7.6 4 4 0 0 0 5.5 15.5zM10 13V8.5M7.8 10.6 10 8.4l2.2 2.2';
  const ICON_OFFLINE = 'M5.5 15.5h9a3.5 3.5 0 0 0 .4-7A5 5 0 0 0 5.2 7.6 4 4 0 0 0 5.5 15.5zM3 3l14 14';
  const ICON_INSTALL = 'M10 3v9M6.5 8.5 10 12l3.5-3.5M4 15.5h12';
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const fmtTime = (ms) => new Date(ms).toLocaleString('de-CH', { dateStyle: 'short', timeStyle: 'short' });
  const fmtSize = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} kB`);

  /* ---------- Toast ---------- */

  const toast = h('div', { class: 'pwa-toast', role: 'status', 'aria-live': 'polite', hidden: true });
  document.body.append(toast);
  let toastTimer = null;
  function notify(message, { sticky = false } = {}) {
    toast.replaceChildren(
      h('span', { text: message }),
      h('button', { type: 'button', class: 'icon', 'aria-label': 'Hinweis schliessen', text: '×', onclick: () => { toast.hidden = true; } }),
    );
    toast.hidden = false;
    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(() => { toast.hidden = true; }, 6000);
  }

  /* ---------- Status pills in the navigation ---------- */

  const status = byId('pwa-status') || (() => {
    const box = h('div', { id: 'pwa-status', class: 'pwa-status' });
    const nav = byId('nav');
    if (nav) nav.insertBefore(box, byId('open-upload'));
    return box;
  })();

  const queueBtn = h('button', { type: 'button', class: 'pwa-pill', id: 'queue-indicator', hidden: true, 'aria-haspopup': 'dialog' });
  const installBtn = h('button', { type: 'button', class: 'pwa-pill', id: 'install-app', hidden: true, title: 'MyForrest als App installieren' },
    [icon(ICON_INSTALL), h('span', { class: 'pwa-long', text: 'App installieren' })]);
  installBtn.setAttribute('aria-label', 'MyForrest als App installieren');
  status.append(queueBtn, installBtn);

  let lastStats = { pending: 0, failed: 0, items: 0 };
  let sending = false;

  function renderIndicator() {
    const { pending, failed } = lastStats;
    const offline = navigator.onLine === false;
    if (!pending && !failed && !offline) {
      queueBtn.hidden = true;
      return;
    }
    let long;
    if (pending) {
      long = sending && !offline
        ? `${plural(pending, 'Foto wird', 'Fotos werden')} gesendet …`
        : `${plural(pending, 'Foto wartet', 'Fotos warten')} auf Verbindung`;
    } else if (failed) {
      long = `${plural(failed, 'Foto', 'Fotos')} nicht hochgeladen`;
    } else {
      long = 'Offline';
    }
    const short = pending || failed ? String(pending || failed) : '';
    queueBtn.replaceChildren(icon(offline ? ICON_OFFLINE : ICON_QUEUE), h('span', { class: 'pwa-long', text: long }));
    if (short) queueBtn.append(h('span', { class: 'pwa-short', text: short }));
    queueBtn.setAttribute('aria-label', offline && !pending ? 'Offline – Uploads werden auf dem Gerät gespeichert' : long);
    queueBtn.title = offline ? 'Offline – neue Uploads werden gespeichert und später gesendet' : long;
    queueBtn.classList.toggle('is-failed', Boolean(failed && !pending));
    queueBtn.classList.toggle('is-offline', offline);
    queueBtn.hidden = false;
  }

  async function refresh() {
    if (!q) return renderIndicator();
    try {
      lastStats = await q.stats();
    } catch {
      lastStats = { pending: 0, failed: 0, items: 0 };
    }
    renderIndicator();
    if (dialog.open) renderDialog();
  }

  /* ---------- Queue dialog ---------- */

  const dialog = h('dialog', { id: 'queue-dialog', class: 'queue-dialog', 'aria-labelledby': 'queue-title' });
  document.body.append(dialog);
  const objectUrls = [];

  async function renderDialog() {
    objectUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
    let items = [];
    try { items = q ? await q.list() : []; } catch { /* no IndexedDB */ }
    const offline = navigator.onLine === false;
    const rows = items.map((item) => {
      const firstPhoto = item.entries.find((e) => e.name === 'photos' && e.blob);
      let thumb = h('span', { class: 'queue-thumb' });
      if (firstPhoto) {
        const url = URL.createObjectURL(firstPhoto.blob);
        objectUrls.push(url);
        thumb = h('img', { class: 'queue-thumb', src: url, alt: '' });
      }
      const what = [
        item.spotId ? 'Wiederholungsfoto' : plural(item.photos.length, 'Foto', 'Fotos'),
        item.gpx ? '+ GPX' : null,
        fmtSize(item.bytes),
      ].filter(Boolean).join(' · ');
      const state = item.failed
        ? h('span', { class: 'queue-state failed', text: `Abgelehnt: ${item.failed}` })
        : h('span', { class: 'queue-state', text: item.lastError ? `Wartet · ${item.lastError}` : 'Wartet auf Verbindung' });
      return h('li', { class: 'queue-item' }, [
        thumb,
        h('div', { class: 'queue-text' }, [
          h('strong', { text: item.photos.length === 1 ? item.photos[0] : what }),
          h('span', { class: 'muted small', text: `${item.photos.length === 1 ? `${what} · ` : ''}gespeichert ${fmtTime(item.createdAt)}` }),
          item.note ? h('span', { class: 'muted small', text: `«${item.note}»` }) : null,
          state,
        ]),
        h('button', {
          type: 'button', class: 'link small danger', text: 'Verwerfen',
          'aria-label': `${what} verwerfen`,
          onclick: async () => {
            if (!confirm('Diesen Upload verwerfen? Die Fotos werden nicht hochgeladen.')) return;
            await q.remove(item.id);
            refresh();
          },
        }),
      ]);
    });

    dialog.replaceChildren(h('div', { class: 'queue-box' }, [
      h('div', { class: 'dialog-head' }, [
        h('button', { type: 'button', class: 'icon', 'aria-label': 'Schliessen', text: '×', onclick: () => dialog.close() }),
        h('p', { class: 'eyebrow', text: 'Warteschlange' }),
        h('h2', { id: 'queue-title', text: 'Uploads ohne Verbindung' }),
      ]),
      h('p', {
        class: 'muted small',
        text: offline
          ? 'Du bist offline. Neue Uploads werden auf diesem Gerät gespeichert und automatisch gesendet, sobald wieder Verbindung besteht.'
          : 'Gespeicherte Uploads werden automatisch gesendet, sobald Verbindung besteht.',
      }),
      rows.length ? h('ul', { class: 'queue-list' }, rows) : h('p', { class: 'queue-empty', text: 'Keine wartenden Uploads.' }),
      h('div', { class: 'row end' }, [
        rows.length ? h('button', {
          type: 'button', class: 'link danger', text: 'Alle verwerfen',
          onclick: async () => {
            if (!confirm('Alle wartenden Uploads verwerfen?')) return;
            await q.clear();
            refresh();
          },
        }) : null,
        h('button', {
          type: 'button', class: 'btn primary', text: 'Jetzt senden',
          disabled: offline || !items.some((i) => !i.failed),
          onclick: () => sendNow(true),
        }),
      ]),
    ]));
  }

  queueBtn.addEventListener('click', () => {
    renderDialog().then(() => { if (!dialog.open) dialog.showModal(); });
  });
  dialog.addEventListener('close', () => objectUrls.splice(0).forEach((u) => URL.revokeObjectURL(u)));
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });

  /* ---------- Sending ---------- */

  function handleSummary(summary) {
    if (!summary || summary.busy) return;
    if (summary.created.length) {
      notify(`${plural(summary.created.length, 'Foto', 'Fotos')} aus der Warteschlange hochgeladen.`);
      if (typeof loadSpots === 'function') loadSpots().catch(() => {});
    }
    if (summary.skipped.length) {
      notify(`${plural(summary.skipped.length, 'Foto', 'Fotos')} übersprungen: ${summary.skipped.map((s) => s.reason)[0]}`, { sticky: true });
    }
    if (summary.failed.length) {
      notify(`Ein Upload wurde abgelehnt: ${summary.failed[0].reason}`, { sticky: true });
    }
    refresh();
  }

  async function sendNow(manual = false) {
    if (!q || sending || navigator.onLine === false) return;
    if (!manual && !lastStats.pending) return;
    sending = true;
    renderIndicator();
    try {
      handleSummary(await q.flush());
    } catch (err) {
      console.warn('Warteschlange konnte nicht gesendet werden', err);
    } finally {
      sending = false;
      refresh();
    }
  }

  if (q) {
    q.subscribe((msg) => {
      if (msg.type === 'flushed') handleSummary(msg.summary);
      else refresh();
    });
    // A queued upload from app.js: tell the user it is safe on the device.
    const originalPost = q.post;
    q.post = async (fd, send) => {
      const res = await originalPost(fd, send);
      if (res.queued) notify(`Keine Verbindung: ${plural(res.queued, 'Foto wird', 'Fotos werden')} gespeichert und später gesendet.`);
      return res;
    };
  }
  window.addEventListener('online', () => { renderIndicator(); sendNow(); });
  window.addEventListener('offline', renderIndicator);
  // Without Background Sync nobody else retries: check every minute while uploads wait.
  setInterval(() => { if (lastStats.pending) sendNow(); }, 60000);

  /* ---------- Service worker ---------- */

  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js', { scope: './' }).catch((err) => console.warn('Service Worker nicht registriert', err));
    });
  }

  /* ---------- Install prompt ---------- */

  const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let deferredPrompt = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    installBtn.hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    installBtn.hidden = true;
    notify('MyForrest ist jetzt als App installiert.');
  });
  if (isIos && !standalone()) installBtn.hidden = false;

  installBtn.addEventListener('click', async () => {
    if (deferredPrompt) {
      const prompt = deferredPrompt;
      deferredPrompt = null;
      installBtn.hidden = true;
      // A prompt can only be shown once; the browser fires beforeinstallprompt again if declined.
      await prompt.prompt().catch(() => {});
      return;
    }
    if (isIos) {
      notify('Auf iPhone und iPad: In Safari unten auf «Teilen» tippen und «Zum Home-Bildschirm» wählen.', { sticky: true });
    }
  });

  /* ---------- Camera capture in the upload dialog ---------- */

  const form = byId('upload-form');
  const photosInput = form?.elements.photos;
  let canMerge = false;
  try { canMerge = typeof DataTransfer === 'function' && Boolean(new DataTransfer().items); } catch { /* old browser */ }
  const touch = window.matchMedia?.('(pointer: coarse)').matches;
  if (photosInput && canMerge && touch) {
    const camInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, id: 'capture-photo' });
    const camBtn = h('button', { type: 'button', class: 'secondary wide capture-btn' }, [
      icon('M3 7.5h3l1.5-2h5l1.5 2h3v8H3zM10 13.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2z'),
      'Mit Kamera aufnehmen',
    ]);
    camBtn.addEventListener('click', () => camInput.click());
    camInput.addEventListener('change', () => {
      const file = camInput.files[0];
      camInput.value = '';
      if (!file) return;
      const dt = new DataTransfer();
      for (const f of photosInput.files) dt.items.add(f);
      dt.items.add(file);
      photosInput.files = dt.files;
      photosInput.dispatchEvent(new Event('change', { bubbles: true }));
      // Camera pictures often carry no GPS: use the current position as fallback location.
      if (navigator.geolocation && typeof setPicked === 'function' && typeof state === 'object' && !state.picked && typeof L === 'object') {
        navigator.geolocation.getCurrentPosition(
          (pos) => { if (!state.picked) setPicked(L.latLng(pos.coords.latitude, pos.coords.longitude)); },
          () => {},
          { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
        );
      }
    });
    const dropzone = photosInput.closest('.dropzone');
    dropzone?.after(camBtn, camInput);
  }

  /* ---------- Start ---------- */

  // Manifest shortcut "Foto beitragen".
  if (new URLSearchParams(location.search).get('action') === 'upload') {
    window.addEventListener('load', () => byId('open-upload')?.click());
  }
  refresh().then(() => sendNow());
})();
