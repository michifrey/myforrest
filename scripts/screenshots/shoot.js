'use strict';
// Takes the README screenshots from the demo server (see README.md here).
// Usage: node shoot.js [hero map spot satellite sun species vektor touren walk schutz konto profil timelapse compare upload gletscher mobile]
// «gletscher» uses the glacier demo server (BASE_GLETSCHER, default http://localhost:3124; see README.md).
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { launch, desktop, settle, BASE, OUT, WORK } = require('./lib');

const only = process.argv.slice(2);
const want = (n) => !only.length || only.includes(n);
const out = (n) => path.join(OUT, n);
const jpg = { type: 'jpeg', quality: 82 };

async function explore(ctx) {
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && console.log('console:', m.text()));
  await page.goto(`${BASE}/`);
  await settle(page, 2500);
  await page.evaluate(() => document.querySelector('#explore').scrollIntoView());
  await settle(page, 2500);
  return page;
}
const frame = (i) => path.join(WORK, 'frames', `f${i}.png`);
fs.mkdirSync(path.join(WORK, 'frames'), { recursive: true });
const pin = (page, id) => page.locator(`.leaflet-marker-icon[title="Spot ${id}"]`);

(async () => {
  const browser = await launch();
  const ctx = await desktop(browser);

  if (want('hero')) {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/`);
    await settle(page, 3500);
    await page.screenshot({ path: out('hero.jpg'), ...jpg });
    // The four landscapes of the start page, as a 2 × 2 grid.
    const sharp = require('sharp');
    const tiles = [];
    for (const [i, name] of ['wald', 'gletscher', 'gebirge', 'wueste'].entries()) {
      await page.click(`.scene-pick button[data-scene="${name}"]`);
      await settle(page, 3200);
      tiles.push({ input: await sharp(await page.screenshot()).resize(720, 450).toBuffer(), left: (i % 2) * 724, top: Math.floor(i / 2) * 454 });
    }
    await sharp({ create: { width: 1444, height: 904, channels: 3, background: '#ffffff' } }).composite(tiles).jpeg({ quality: 82 }).toFile(out('hero-landschaften.jpg'));
    await page.close();
  }

  if (want('map')) {
    const page = await explore(ctx);
    await page.screenshot({ path: out('map.jpg'), ...jpg });
    await page.close();
  }

  if (want('spot')) {
    const page = await explore(ctx);
    await page.setViewportSize({ width: 1440, height: 1020 });
    await page.evaluate(() => document.querySelector('#explore').scrollIntoView());
    await pin(page, 1).click();
    await settle(page, 2500);
    await page.evaluate(() => { const s = document.querySelector('#time-slider'); s.value = 2; s.dispatchEvent(new Event('input', { bubbles: true })); });
    await settle(page, 2000);
    await page.evaluate(() => { document.querySelector('#panel').scrollTop = 0; });
    await settle(page, 2500);
    await page.screenshot({ path: out('spot.jpg'), ...jpg });
    await page.close();
  }

  if (want('satellite')) {
    const page = await explore(ctx);
    await pin(page, 2).click();
    await settle(page, 3000);
    await page.evaluate(() => document.querySelector('#vegetation-title')?.scrollIntoView({ block: 'start' }));
    await settle(page, 2500);
    await page.locator('#panel').screenshot({ path: out('satellite.jpg'), ...jpg });
    await page.evaluate(() => document.querySelector('.leaflet-marker-icon[title="Spot 6"]').click());
    await settle(page, 3500);
    await page.evaluate(() => document.querySelector('#context-title')?.scrollIntoView({ block: 'start' }));
    await settle(page, 2500);
    await page.locator('#panel').screenshot({ path: out('wetter-kontext.jpg'), ...jpg });
    await page.close();
  }

  if (want('sun')) {
    const page = await explore(ctx);
    await page.click('#sun-toggle');
    await settle(page, 1500);
    await page.fill('#sun-date', '2026-06-20');
    await page.dispatchEvent('#sun-date', 'change');
    await page.evaluate(() => { const s = document.querySelector('#sun-slider'); s.value = 17 * 60 + 30; s.dispatchEvent(new Event('input', { bubbles: true })); });
    await settle(page, 5000);
    await page.evaluate(() => document.activeElement?.blur());
    await page.screenshot({ path: out('sun.jpg'), ...jpg });
    await page.close();
  }

  if (want('species')) {
    const page = await explore(ctx);
    await page.click('#species-toggle');
    await settle(page, 4000);
    await page.screenshot({ path: out('neophyten-hotspots.jpg'), ...jpg });
    await page.click('[data-tab="spread"]').catch((e) => console.log(e.message));
    await settle(page, 4000);
    await page.screenshot({ path: out('neophyten-ausbreitung.jpg'), ...jpg });
    await page.close();
  }

  if (want('vektor')) {
    const page = await ctx.newPage();
    page.on('console', (m) => m.type() === 'error' && console.log('console:', m.text()));
    await page.goto(`${BASE}/vektorkarte.html`);
    await settle(page, 8000);
    await page.screenshot({ path: out('vektorkarte.jpg'), ...jpg });
    await page.goto(`${BASE}/vektorkarte-lv95.html`);
    await settle(page, 8000);
    await page.screenshot({ path: out('vektorkarte-lv95.jpg'), ...jpg });
    await page.close();
  }

  if (want('timelapse')) {
    // Frames at twice the resolution, scaled down to 480 px for the GIF.
    const page = await explore(await desktop(browser, { deviceScaleFactor: 2 }));
    await pin(page, 1).click();
    await settle(page, 2500);
    const n = await page.evaluate(() => Number(document.querySelector('#time-slider').max));
    for (let i = 0; i <= n; i++) {
      await page.evaluate((v) => { const s = document.querySelector('#time-slider'); s.value = v; s.dispatchEvent(new Event('input', { bubbles: true })); }, i);
      await settle(page, 1800);
      await page.locator('.viewer').screenshot({ path: frame(i) });
    }
    execFileSync('convert', ['-delay', '120', '-loop', '0', ...Array.from({ length: n + 1 }, (_, i) => frame(i)),
      '-resize', '480x', '-layers', 'Optimize', '-colors', '160', out('timelapse.gif')]);
    await page.context().close();
  }

  if (want('compare')) {
    const page = await explore(ctx);
    await pin(page, 1).click();
    await settle(page, 2500);
    await page.click('#open-compare');
    await settle(page, 1500);
    await page.selectOption('#cmp-a', { index: 0 });
    await page.selectOption('#cmp-b', { index: 5 });
    await settle(page, 6000);
    await page.evaluate(() => document.querySelector('#compare').scrollIntoView({ block: 'start' }));
    await settle(page, 1500);
    const clip = await page.evaluate(() => {
      const a = document.querySelector('#compare').getBoundingClientRect();
      const b = document.querySelector('#cmp-heat').closest('div, label').getBoundingClientRect();
      return { x: a.x - 4, y: a.y - 4, width: a.width + 8, height: b.bottom - a.y + 12 };
    });
    await page.screenshot({ path: out('compare.jpg'), clip, ...jpg });
    await page.uncheck('#cmp-heat');
    await page.evaluate(() => { const r = document.querySelector('#swipe-range'); r.value = 38; r.dispatchEvent(new Event('input', { bubbles: true })); });
    await settle(page, 1500);
    await page.screenshot({ path: out('compare-swipe.jpg'), clip, ...jpg });
    await page.close();
  }

  if (want('upload')) {
    const page = await explore(ctx);
    await page.setViewportSize({ width: 1440, height: 1180 });
    await page.click('#open-upload');
    await settle(page, 1500);
    await page.locator('#upload-dialog').screenshot({ path: out('upload.png') });
    await page.close();
  }

  if (want('touren')) {
    // A planned tour along the forest track, past the requests and the bark-beetle stand.
    const wp = [[47.3660, 8.5652], [47.3700, 8.5690], [47.3733, 8.5722], [47.3760, 8.5760], [47.3768, 8.5795], [47.3741, 8.5826], [47.3716, 8.5858]]
      .map(([lat, lon]) => ({ lat, lon }));
    const route = { waypoints: wp, segments: wp.slice(1).map((p, i) => [wp[i], p]), raw: null, kind: 'gezeichnet', name: 'Waldrunde Adlisberg', savedId: null, hasTime: false };
    const tctx = await desktop(browser);
    await tctx.addInitScript((r) => { try { localStorage.setItem('myforrest.route.v1', r); } catch {} }, JSON.stringify(route));
    const page = await explore(tctx);
    await page.click('#tours-toggle');
    await settle(page, 2500);
    await page.evaluate(() => map.fitBounds([[47.3655, 8.5640], [47.3775, 8.5870]], { paddingTopLeft: [430, 60], paddingBottomRight: [460, 40] }));
    await settle(page, 2500);
    await page.evaluate(() => document.querySelector('#tour-suggestions')?.scrollIntoView({ block: 'end' }));
    await settle(page, 800);
    await page.screenshot({ path: out('touren.jpg'), ...jpg });
    await page.click('[data-tab="auftraege"]');
    await settle(page, 1200);
    // The request on the forest track, opened from the list.
    await page.locator('#tour-requests .sug-item', { hasText: 'Lichtung' }).click();
    await settle(page, 1200);
    await page.screenshot({ path: out('fotoauftraege.jpg'), ...jpg });
    await tctx.close();
  }

  if (want('walk')) {
    // Walk-through along the 360° recording of the forest track (seed.js), second picture, looking ahead.
    const page = await ctx.newPage();
    await page.goto(`${BASE}/`);
    await settle(page, 2000);
    const ids = await page.evaluate(async () => {
      const spots = await (await fetch('/api/spots')).json();
      const panos = [];
      for (const s of spots) {
        const d = await (await fetch(`/api/spots/${s.id}`)).json();
        for (const p of d.photos) if (p.sequenceId === 'demo-360-waldweg') panos.push([p.takenAt, p.id]);
      }
      return panos.sort().map((x) => x[1]);
    });
    await page.evaluate((id) => Walk.open(id), ids[1]);
    await settle(page, 4000);
    await page.screenshot({ path: out('durchgehen.jpg'), ...jpg });
    await page.close();
  }

  if (want('gletscher')) {
    const GB = process.env.BASE_GLETSCHER || 'http://localhost:3124';
    const gctx = await desktop(browser);
    const page = await gctx.newPage();
    page.on('console', (m) => m.type() === 'error' && console.log('console:', m.text()));
    await page.goto(`${GB}/`);
    await settle(page, 2500);
    await page.evaluate(() => document.querySelector('#explore').scrollIntoView());
    await settle(page, 1500);
    // The map with the outlines of the three inventories.
    await page.click('#glacier-toggle');
    await page.evaluate(() => map.setView([46.6035, 8.4005], 14, { animate: false }));
    await settle(page, 4000);
    await page.screenshot({ path: out('gletscher-karte.jpg'), ...jpg });
    // The spot at the tongue: newest photo, the glacier section of the panel.
    const tongue = await page.evaluate(() => state.spots.find((s) => s.landscape === 'gletscher' && s.photoCount > 3).id);
    await page.evaluate((id) => openSpot(id), tongue);
    await settle(page, 3500);
    // The spot with its landscape and the newest photo, the outlines behind it.
    await page.evaluate(() => { map.setView([46.6015, 8.4005], 15, { animate: false }); map.panBy([230, 0], { animate: false }); });
    await settle(page, 3000);
    await page.screenshot({ path: out('gletscher-spot.jpg'), ...jpg });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.evaluate(() => document.querySelector('#glacier-title')?.scrollIntoView({ block: 'start' }));
    await page.evaluate(() => { document.querySelector('#panel').scrollTop -= 80; });
    await settle(page, 2000);
    await page.locator('#panel').screenshot({ path: out('gletscher.jpg'), ...jpg });
    // Before/after: the postcard of 1928 against 2025.
    await page.evaluate(() => { document.querySelector('#panel').scrollTop = 0; });
    await page.click('#open-compare');
    await settle(page, 1500);
    await page.selectOption('#cmp-a', { index: 0 });
    await page.selectOption('#cmp-b', { index: await page.evaluate(() => state.spot.photos.length - 1) });
    await settle(page, 5000);
    await page.uncheck('#cmp-heat');
    await page.evaluate(() => { const r = document.querySelector('#swipe-range'); r.value = 50; r.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.evaluate(() => document.querySelector('#compare').scrollIntoView({ block: 'start' }));
    await settle(page, 1500);
    const clip = await page.evaluate(() => {
      const a = document.querySelector('#compare').getBoundingClientRect();
      const b = document.querySelector('#cmp-heat').closest('div, label').getBoundingClientRect();
      return { x: a.x - 4, y: a.y - 4, width: a.width + 8, height: b.bottom - a.y + 12 };
    });
    await page.screenshot({ path: out('gletscher-vergleich.jpg'), clip, ...jpg });
    // A mountain spot: the alpine pasture with the snow melt per year.
    const pasture = await page.evaluate(() => state.spots.find((s) => s.landscape === 'gebirge')?.id);
    await page.evaluate((id) => openSpot(id), pasture);
    await settle(page, 3500);
    await page.evaluate(() => document.querySelector('#glacier-title')?.scrollIntoView({ block: 'start' }));
    await page.evaluate(() => { document.querySelector('#panel').scrollTop -= 80; });
    await settle(page, 2000);
    await page.locator('#panel').screenshot({ path: out('gebirge.jpg'), ...jpg });
    await gctx.close();
  }

  if (want('schutz')) {
    // Public: the protected orchid find only as a 5-km square.
    let page = await explore(ctx);
    await page.evaluate(() => map.setView([47.366, 8.628], 13));
    await settle(page, 2500);
    const cell = page.locator('path.protected-cell').first();
    const box = await cell.boundingBox();
    await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.45);
    await settle(page, 1000);
    await page.screenshot({ path: out('schutz-raster.jpg'), ...jpg });
    await page.close();
    // A verified PRO member (forest ranger) sees the find with its exact place.
    const pctx = await desktop(browser);
    page = await pctx.newPage();
    await page.goto(`${BASE}/`);
    await page.evaluate(() => fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'revier@example.org', password: 'demo-passwort' }) }));
    await page.reload();
    await settle(page, 2500);
    await page.evaluate(() => document.querySelector('#explore').scrollIntoView());
    await settle(page, 1500);
    const orchid = await page.evaluate(() => state.spots.find((s) => s.protectedPhotos)?.id);
    await page.evaluate((id) => openSpot(id), orchid);
    await settle(page, 2500);
    await page.evaluate(() => { map.setView([47.3796, 8.5852], 17, { animate: false }); map.panBy([230, 40], { animate: false }); });
    await settle(page, 2000);
    await page.evaluate(() => document.querySelector('#photo-credit')?.scrollIntoView({ block: 'center' }));
    await settle(page, 1200);
    await page.screenshot({ path: out('schutz-pro.jpg'), ...jpg });
    await pctx.close();
  }

  if (want('konto')) {
    // The login dialog with Google, GitHub and e-mail.
    let page = await explore(ctx);
    await page.click('#account-btn');
    await settle(page, 800);
    await page.locator('#auth-dialog').screenshot({ path: out('anmelden.png') });
    await page.close();
    // The account menu of a member whose address is not yet confirmed.
    const kctx = await desktop(browser);
    page = await kctx.newPage();
    await page.goto(`${BASE}/`);
    await page.evaluate(() => fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'revier@example.org', password: 'demo-passwort' }) }));
    await page.reload();
    await settle(page, 2500);
    await page.click('#account-btn');
    await settle(page, 800);
    await page.locator('#account-menu').screenshot({ path: out('konto-menue.png') });
    // Deleting the account: what happens to the photos is an explicit choice. The demo photos are
    // anonymous, so the dialog gets example numbers of a member with photos and tours.
    await page.route('**/api/auth/account', (r) => r.fulfill({
      json: { photos: 12, tracks: 2, requests: 1, confirmWith: 'password', blocker: null },
    }));
    await page.click('text=Konto löschen …');
    await settle(page, 1000);
    await page.locator('#delete-dialog').screenshot({ path: out('konto-loeschen.png') });
    await kctx.close();
  }

  if (want('profil')) {
    // The profile of a member. The demo photos are anonymous: the scene lends the member a selection of
    // them (newest first) and matching figures, without changing the database.
    const spots = await (await fetch(`${BASE}/api/spots`)).json();
    const photos = [];
    for (const s of spots.slice(0, 14)) {
      const spot = await (await fetch(`${BASE}/api/spots/${s.id}`)).json();
      for (const ph of spot.photos.slice(-2)) {
        photos.push({ id: ph.id, spotId: spot.id, spotPhotos: spot.photos.length, url: ph.url, thumbUrl: ph.thumbUrl, largeUrl: ph.largeUrl,
          takenAt: ph.takenAt, activity: ph.activity, panorama: ph.panorama, tags: ph.tags, license: ph.license, hidden: false, protected: false });
      }
    }
    photos.sort((a, b) => b.takenAt.localeCompare(a.takenAt));
    const years = Object.entries(photos.reduce((acc, ph) => ({ ...acc, [ph.takenAt.slice(0, 4)]: (acc[ph.takenAt.slice(0, 4)] || 0) + 1 }), {}))
      .map(([year, n]) => ({ year: Number(year), photos: n })).sort((a, b) => a.year - b.year);
    const profile = {
      name: 'Revierförsterin', memberSince: '2019-04-02T08:00:00.000Z', photos: photos.length, photoBytes: photos.length * 3.4e6,
      spots: new Set(photos.map((ph) => ph.spotId)).size, repeatSpots: 9, hidden: 0, protected: 0,
      firstAt: photos.at(-1).takenAt, lastAt: photos[0].takenAt, years,
      activities: Object.entries(photos.reduce((acc, ph) => ({ ...acc, [ph.activity || 'sonstiges']: (acc[ph.activity || 'sonstiges'] || 0) + 1 }), {}))
        .map(([activity, n]) => ({ activity, photos: n })).sort((a, b) => b.photos - a.photos),
      tracks: 3, requests: { open: 1, done: 2, fulfilled: 4 }, followedSpots: 6,
    };
    const pctx = await desktop(browser);
    const page = await pctx.newPage();
    await page.route('**/api/profile', (r) => r.fulfill({ json: profile }));
    await page.route('**/api/profile/photos?*', (r) => r.fulfill({ json: { total: photos.length, offset: 0, photos } }));
    await page.goto(`${BASE}/`);
    await page.evaluate(() => fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'revier@example.org', password: 'demo-passwort' }) }));
    // Opening /#profil on load opens the profile (a hash change alone does not reload the page).
    await page.goto(`${BASE}/#profil`);
    await page.reload();
    await settle(page, 3500);
    await page.locator('#profile-dialog').screenshot({ path: out('profil.jpg'), ...jpg });
    await pctx.close();
  }

  await browser.close();

  if (want('mobile')) {
    const mb = await launch(['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${path.join(WORK, 'img', 'live.y4m')}`]);
    const mctx = await desktop(mb, {
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 1.5, isMobile: true, hasTouch: true,
      permissions: ['camera', 'geolocation'], geolocation: { latitude: 47.37331, longitude: 8.57199, accuracy: 6 },
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36',
    });
    const page = await mctx.newPage();
    await page.goto(`${BASE}/`);
    await settle(page, 2500);
    await page.evaluate(() => document.querySelector('#explore').scrollIntoView());
    await settle(page, 2000);
    await page.evaluate(() => document.querySelector('.leaflet-marker-icon[title="Spot 1"]').click());
    await settle(page, 3000);
    await page.evaluate(() => document.querySelector('#spot').scrollIntoView({ block: 'start' }));
    await settle(page, 1500);
    await page.screenshot({ path: out('mobile-spot.jpg'), ...jpg });
    await page.click('#open-camera');
    await settle(page, 4000);
    await page.screenshot({ path: out('mobile-camera.jpg'), ...jpg });
    await page.click('[data-mode="edges"]');
    await settle(page, 2000);
    await page.screenshot({ path: out('mobile-camera-edges.jpg'), ...jpg });
    await mb.close();
  }
})();
