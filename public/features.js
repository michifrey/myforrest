'use strict';

/*
 * Section «Funktionen» of the start page: every tile opens its feature right away — scrolls to the map and opens
 * the panel (or the drive mode, the upload, PRO). Tiles of features the server has not set up (3D, glaciers) stay
 * hidden like their map buttons. A link with ?funktion=klima (or ebenen, sonne, arten, touren, 3d, gletscher,
 * fahrt, video, pro) opens a feature directly. Links to the documentation follow DOKU_URL.
 * Uses the globals of app.js ($, state) and account.js (Account, openAuth, openPro).
 */

(function featuresModule() {
  const tiles = [...document.querySelectorAll('.feature[data-toggle], .feature[data-run]')];

  const RUN = {
    fahrt: () => window.Drive?.open(),
    upload: () => $('open-upload').click(),
    pro: () => (Account.user ? openPro() : openAuth('login', { intro: 'Melde dich an, um die PRO-Mitgliedschaft zu beantragen.', then: openPro })),
  };

  /** Opens a map panel: to the map, then its button (unless it is open already). */
  function openPanel(id) {
    const btn = $(id);
    if (!btn || btn.hidden) return;
    $('explore').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    const open = btn.getAttribute('aria-expanded') === 'true' || btn.getAttribute('aria-pressed') === 'true';
    if (!open) btn.click();
  }

  function run(tile) {
    if (tile.dataset.toggle) return openPanel(tile.dataset.toggle);
    const dialog = tile.closest('dialog');
    if (dialog?.open) dialog.close();
    RUN[tile.dataset.run]?.();
  }

  document.addEventListener('click', (e) => {
    const tile = e.target.closest('[data-toggle].feature, [data-run]');
    if (tile) run(tile);
  });

  // A tile shows as long as its map button does.
  for (const tile of tiles) {
    const btn = tile.dataset.toggle && $(tile.dataset.toggle);
    if (!btn) continue;
    const sync = () => { tile.hidden = btn.hidden; };
    sync();
    new MutationObserver(sync).observe(btn, { attributes: true, attributeFilter: ['hidden'] });
  }

  // Once the config is there: the address of the documentation, and a feature asked for in the link.
  const wait = setInterval(() => {
    if (!state.config || !('docs' in state.config)) return;
    clearInterval(wait);
    const docs = state.config.docs;
    for (const a of document.querySelectorAll('a[data-docs]')) {
      if (docs) a.href = new URL(a.dataset.docs, docs).href;
      else a.hidden = true;
    }
    const key = new URLSearchParams(location.search).get('funktion');
    const tile = key && tiles.find((t) => t.dataset.key === key);
    // The map buttons appear with their own config checks; give them a moment.
    if (tile) setTimeout(() => run(tile), 600);
  }, 200);

  window.Features = { open: (key) => { const t = tiles.find((x) => x.dataset.key === key); if (t) run(t); } };
})();
