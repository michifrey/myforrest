'use strict';
// Takes the README screenshots from the demo server (see README.md here).
// Usage: node shoot.js [hero funktionen landschaft map standort spot baeume ebenen gebaeude3d klima satellite sun schatten species vektor tourschatten wikimedia touren walk wegnetz uebergang schutz konto profil timelapse compare upload gletscher landschaft-gletscher mobile]
// «mapillary» needs the demo server started with DEMO_MAPILLARY=1 (a Mapillary stand-in, see README.md).
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
    await settle(page, 2000);
    // The scenes rotate every eight seconds; the picture shows the forest.
    await page.click('.scene-pick button[data-scene="wald"]');
    await settle(page, 3200);
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

  if (want('funktionen')) {
    // The section «Funktionen» of the start page: every tile opens its feature.
    const page = await ctx.newPage();
    await page.goto(`${BASE}/`);
    await settle(page, 2000);
    await page.evaluate(() => scrollTo(0, document.querySelector('#funktionen').offsetTop));
    await settle(page, 1500); // the heading fades in
    await page.addStyleTag({ content: '.nav { position: static !important; }' });
    await page.locator('#funktionen').screenshot({ path: out('funktionen.jpg'), ...jpg });
    await page.close();
  }

  if (want('landschaft')) {
    // The two perspectives on the start page, and «Landschaft im Wandel» (landschaft.html).
    let page = await ctx.newPage();
    await page.goto(`${BASE}/`);
    await settle(page, 2000);
    await page.evaluate(() => scrollTo(0, document.querySelector('#perspektiven').offsetTop));
    await settle(page, 1500); // the heading fades in
    await page.addStyleTag({ content: '.nav { position: static !important; }' });
    await page.locator('#perspektiven').screenshot({ path: out('perspektiven.jpg'), ...jpg });
    await page.close();

    // Landschaft im Wandel: the Dufour map over the demo forest, the forest belts 2085, the report of a place.
    page = await ctx.newPage();
    const place = '#karte?lat=47.37&lon=8.54';
    const stop = async (id) => {
      await page.click(`#ln-timeline button[data-id="${id}"]`);
      await settle(page, 2500);
    };
    await page.goto(`${BASE}/landschaft.html${place}`);
    await settle(page, 2500);
    await page.evaluate(() => { window.scrollTo(0, 0); });
    await stop('dufour');
    await page.screenshot({ path: out('landschaft.jpg'), ...jpg });
    await stop('wald-2085-t');
    await page.screenshot({ path: out('landschaft-2085.jpg'), ...jpg });
    // The «Zeitreise»: the Landeskarte of 1900.
    await stop('zeitreise');
    await page.evaluate(() => {
      const range = document.getElementById('ln-zeit-range');
      range.value = '3';
      range.dispatchEvent(new Event('input'));
    });
    await settle(page, 6000);
    await page.screenshot({ path: out('landschaft-zeitreise.jpg'), ...jpg });
    // The aerial images of 1956.
    await stop('luftbild');
    await page.evaluate(() => {
      const range = document.getElementById('ln-zeit-range');
      range.value = '3';
      range.dispatchEvent(new Event('input'));
    });
    await settle(page, 6000);
    await page.screenshot({ path: out('landschaft-luftbild.jpg'), ...jpg });
    // Two years side by side: 1956 left, the newest flight right of the divider.
    await page.click('#ln-vergleich');
    for (let i = 0; i < 4; i += 1) await page.press('.ln-swipe-handle', 'ArrowRight');
    await settle(page, 6000);
    await page.screenshot({ path: out('landschaft-vergleich.jpg'), ...jpg });
    await page.goto(`${BASE}/landschaft.html#bericht?lat=47.37&lon=8.54`);
    await page.waitForSelector('.ln-section', { timeout: 120000 });
    await settle(page, 2500);
    await page.locator('#bericht').screenshot({ path: out('landschaft-bericht.jpg'), ...jpg });
    await page.goto(`${BASE}/landschaft.html#daten`);
    await settle(page, 1200);
    await page.locator('#daten').screenshot({ path: out('landschaft-daten.jpg'), ...jpg });
    await page.close();
  }

  if (want('map')) {
    const page = await explore(ctx);
    await page.screenshot({ path: out('map.jpg'), ...jpg });
    await page.close();
  }

  if (want('standort')) {
    // The browser shares the location: the map starts there, with the blue dot and the "Mein Standort" button.
    const gctx = await desktop(browser, { permissions: ['geolocation'], geolocation: { latitude: 47.3712, longitude: 8.5745, accuracy: 30 } });
    const page = await explore(gctx);
    // The map down to the buttons at its bottom left (above the footer's tree line).
    await page.evaluate(() => window.scrollBy(0, 120));
    await settle(page, 1500);
    const clip = await page.evaluate(() => {
      const m = document.querySelector('#map').getBoundingClientRect();
      const c = document.querySelector('.leaflet-bottom.leaflet-left').getBoundingClientRect();
      const bottom = Math.min(c.bottom + 16, window.innerHeight);
      return { x: m.x, y: bottom - 600, width: 960, height: 600 };
    });
    await page.screenshot({ path: out('standort.jpg'), clip, ...jpg });
    await gctx.close();
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
    // "Licht & Wald" on an autumn photo: the beeches colouring, the sun low in the afternoon.
    const autumn = await page.evaluate(() => state.spot.photos.findIndex((p) => new Date(p.takenAt).getMonth() === 9));
    if (autumn >= 0) await page.evaluate((i) => { const s = document.querySelector('#time-slider'); s.value = i; s.dispatchEvent(new Event('input', { bubbles: true })); }, autumn);
    await page.click('#side-tab-light');
    await settle(page, 2500);
    await page.locator('.side-card').screenshot({ path: out('licht-wald.jpg'), ...jpg });
    // Weather in "Licht & Wald": the demo's rainy November day and snowy February morning, beside the autumn photo.
    const sharp = require('sharp');
    const cards = [await page.locator('.side-card').screenshot()];
    for (const iso of ['2025-11-21T11:00', '2026-02-10T09:30']) {
      await page.evaluate((t) => SpotProfile.show(new Date(t).getTime()), iso);
      await settle(page, 2500);
      cards.push(await page.locator('.side-card').screenshot());
    }
    const metas = await Promise.all(cards.map((c) => sharp(c).metadata()));
    const height = Math.max(...metas.map((m) => m.height));
    await sharp({ create: { width: metas.reduce((w, m) => w + m.width, 0) + 2 * 16, height, channels: 3, background: '#f4f0e4' } })
      .composite(cards.map((input, i) => ({ input, left: metas.slice(0, i).reduce((w, m) => w + m.width + 16, 0), top: 0 })))
      .jpeg({ quality: 82 }).toFile(out('licht-wald-wetter.jpg'));
    // The weather tab: DWD radar (the demo's rain front) and the forecast.
    await page.click('#side-tab-weather');
    await settle(page, 5000);
    await page.locator('.side-card').screenshot({ path: out('wetter-spot.jpg'), ...jpg });
    await page.click('#side-tab-light');
    await page.close();
  }

  if (want('satellite')) {
    const page = await explore(ctx);
    await pin(page, 2).click();
    await settle(page, 3000);
    await page.click('#tab-verlauf');
    await page.evaluate(() => document.querySelector('#vegetation-title')?.scrollIntoView({ block: 'start' }));
    await page.evaluate(() => { document.querySelector('#panel').scrollTop -= 90; });
    await settle(page, 2500);
    await page.locator('#panel').screenshot({ path: out('satellite.jpg'), ...jpg });
    await page.evaluate(() => document.querySelector('.leaflet-marker-icon[title="Spot 6"]').click());
    await settle(page, 3500);
    await page.click('#tab-kontext');
    await page.evaluate(() => document.querySelector('#context-title')?.scrollIntoView({ block: 'start' }));
    await page.evaluate(() => { document.querySelector('#panel').scrollTop -= 90; });
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

  if (want('schatten')) {
    // Low evening sun: the hill shades the forest to its east; DWD radar on top.
    const page = await explore(ctx);
    await page.click('#sun-toggle');
    await settle(page, 1500);
    await page.fill('#sun-date', '2026-10-09');
    await page.dispatchEvent('#sun-date', 'change');
    await page.evaluate(() => { const s = document.querySelector('#sun-slider'); s.value = 17 * 60 + 50; s.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.selectOption('#dwd-layer', 'radar');
    await settle(page, 5000);
    await page.evaluate(() => document.activeElement?.blur());
    await page.screenshot({ path: out('licht-schatten.jpg'), ...jpg });
    await page.selectOption('#dwd-layer', '');
    // The MeteoSwiss radar over the big map, now: the demo's rain front over the forest.
    await page.click('#sun-today');
    await page.evaluate(() => { const s = document.querySelector('#sun-slider'); s.value = new Date().getHours() * 60 + new Date().getMinutes(); s.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.uncheck('#shade-toggle');
    await page.selectOption('#dwd-layer', 'radar-ch');
    await page.evaluate(() => map.setView([47.25, 8.45], 9, { animate: false }));
    await settle(page, 5000);
    await page.evaluate(() => document.activeElement?.blur());
    await page.screenshot({ path: out('radar-karte.jpg'), ...jpg });
    await page.selectOption('#dwd-layer', '');
    await page.check('#shade-toggle');
    await page.close();
  }

  if (want('baumschatten')) {
    // Zoomed in on the village and the forest edge: houses and trees throw their shadows (heights from swissSURFACE3D).
    const page = await explore(ctx);
    await page.click('#sun-toggle');
    await settle(page, 1500);
    await page.fill('#sun-date', '2026-10-09');
    await page.dispatchEvent('#sun-date', 'change');
    await page.evaluate(() => map.setView([47.3705, 8.5585], 16));
    await page.evaluate(() => { const s = document.querySelector('#sun-slider'); s.value = 16 * 60 + 40; s.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForFunction(() => /swissSURFACE3D/.test(document.querySelector('#shade-status').textContent), null, { timeout: 90000 });
    await settle(page, 2000);
    await page.evaluate(() => document.activeElement?.blur());
    await page.screenshot({ path: out('baumschatten.jpg'), ...jpg });
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

  if (want('karte3d')) {
    // The 3D map: the spots on the demo terrain, tilted, with the popup of a spot.
    const page = await explore(ctx);
    await page.click('#map3d-toggle');
    await page.waitForFunction(() => window.Map3D?.map?.loaded(), null, { timeout: 120000, polling: 1000 });
    await page.evaluate(() => window.Map3D.map.jumpTo({ center: [8.5745, 47.3738], zoom: 15.2, pitch: 64, bearing: -32 }));
    await page.waitForFunction(() => window.Map3D.map.areTilesLoaded(), null, { timeout: 120000, polling: 1000 });
    await settle(page, 3000);
    await page.evaluate(() => window.Map3D.showSpot(1));
    await settle(page, 4000);
    await page.screenshot({ path: out('karte-3d.jpg'), ...jpg });
    // From a spot: "Umgebung in 3D" looks the way its photos look.
    await page.evaluate(() => window.Map3D.close());
    await pin(page, 3).click();
    await settle(page, 2500);
    await page.click('#spot-3d');
    await page.waitForFunction(() => window.Map3D?.map?.loaded(), null, { timeout: 120000, polling: 1000 });
    await settle(page, 4000);
    await page.screenshot({ path: out('karte-3d-spot.jpg'), ...jpg });
    await page.close();
  }

  if (want('ebenen')) {
    // Panel «Ebenen»: fire danger and residents over the demo area, the answer of a click; then land use and
    // the tree register of Zürich (demo services in the format of geo.admin.ch and the city).
    const page = await explore(ctx);
    await page.evaluate(() => map.setView([47.3705, 8.5655], 15, { animate: false }));
    await page.click('#layers-toggle');
    await page.waitForSelector('#layers-groups .layer-group', { timeout: 60000 });
    for (const title of ['Bevölkerung pro Hektare (Demo)', 'Waldbrandgefahr (Demo)']) await page.evaluate((t) => window.Layers.add(t), title);
    await settle(page, 3500);
    await page.mouse.click(480, 720); // in the village: residents and fire danger
    await page.waitForSelector('.layer-popup dl', { timeout: 30000 });
    await settle(page, 1200);
    await page.screenshot({ path: out('ebenen.jpg'), ...jpg });
    await page.evaluate(() => { document.querySelectorAll('#layers-active button').forEach((b) => b.click()); map.closePopup(); });
    for (const title of ['Arealstatistik: Bodennutzung (Demo)', 'Baumstandorte (Demo)']) await page.evaluate((t) => window.Layers.add(t), title);
    await settle(page, 3500);
    await page.screenshot({ path: out('ebenen-nutzung.jpg'), ...jpg });
    await page.evaluate(() => document.querySelectorAll('#layers-active button').forEach((b) => b.click()));
    await page.close();
  }

  if (want('gebaeude3d')) {
    // Buildings and trees as 3D Tiles over the terrain (demo tiles in swisstopo's format), from the windthrow spot.
    const page = await explore(ctx);
    await page.click('#map3d-toggle');
    await page.waitForFunction(() => window.Map3D?.map?.loaded(), null, { timeout: 120000, polling: 1000 });
    await page.evaluate(() => window.Map3D.map.jumpTo({ center: [8.5736, 47.3747], zoom: 17.1, pitch: 64, bearing: 25 }));
    await page.evaluate(() => window.Map3D.showTiles(['gebaeude', 'baeume']));
    await page.waitForFunction(() => window.Map3D.map.areTilesLoaded(), null, { timeout: 120000, polling: 1000 });
    await settle(page, 9000);
    await page.screenshot({ path: out('karte-3d-gebaeude.jpg'), ...jpg });
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
    await page.setViewportSize({ width: 1440, height: 1500 }); // the comparison is as wide as the detail page
    await page.evaluate(() => document.querySelector('#explore').scrollIntoView());
    await pin(page, 1).click();
    await settle(page, 2500);
    await page.click('#open-compare');
    await settle(page, 1500);
    await page.selectOption('#cmp-a', { index: 0 });
    await page.selectOption('#cmp-b', { index: 5 });
    await settle(page, 6000);
    await page.evaluate(() => document.querySelector('#compare').scrollIntoView({ block: 'start' }));
    await page.evaluate(() => { document.querySelector('#panel').scrollTop -= 90; }); // below the sticky head
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
    // A whole folder with its description (myforrest.json): the photos land in the photo field.
    const folder = path.join(WORK, 'Waldrand-2026-10');
    fs.rmSync(folder, { recursive: true, force: true });
    fs.mkdirSync(folder, { recursive: true });
    for (let i = 0; i < 48; i++) fs.copyFileSync(path.join(__dirname, '..', '..', 'test', 'fixtures', 'nogps.jpg'), path.join(folder, `IMG_${4101 + i}.jpg`));
    fs.writeFileSync(path.join(folder, 'myforrest.json'), '[]');
    await page.setInputFiles('#upload-folder', folder);
    await settle(page, 800);
    const a = await page.locator('#upload-form .dropzone').first().boundingBox();
    const b = await page.locator('.folder-row').boundingBox();
    const d = await page.locator('#upload-dialog').boundingBox();
    await page.screenshot({ path: out('upload-ordner.png'), clip: { x: d.x, y: a.y - 12, width: d.width, height: b.y + b.height - a.y + 28 } });
    await page.close();
  }

  if (want('wikimedia')) {
    // The windthrow spot: what Wikidata, OpenStreetMap and Commons know about the place (demo stand-ins).
    const page = await explore(ctx);
    await page.setViewportSize({ width: 1440, height: 1400 });
    await page.evaluate(() => document.querySelector('#explore').scrollIntoView());
    await pin(page, 1).click();
    await settle(page, 2500);
    await page.evaluate(() => { document.querySelector('#wiki-box').open = true; });
    await page.waitForSelector('#wiki-body .wiki-photos', { timeout: 60000 });
    await page.evaluate(() => document.querySelector('#wiki-box').scrollIntoView({ block: 'start' }));
    await page.waitForFunction(() => [...document.querySelectorAll('#wiki-box img')].every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 30000 });
    await settle(page, 800);
    // The box with a margin of the page around it.
    const clip = await page.evaluate(() => {
      const b = document.querySelector('#wiki-box').getBoundingClientRect();
      return { x: b.left - 16, y: b.top - 16, width: b.width + 32, height: b.height + 32 };
    });
    await page.screenshot({ path: out('wikimedia.jpg'), clip, ...jpg });
    await page.close();
  }

  if (want('tourschatten')) {
    // Sun and shade along a summer evening walk: across the meadow, along the forest edge and onto the forest track.
    const wp = [[47.3641, 8.5500], [47.3645, 8.5590], [47.3660, 8.5652], [47.3700, 8.5690]]
      .map(([lat, lon]) => ({ lat, lon }));
    const route = { waypoints: wp, segments: wp.slice(1).map((p, i) => [wp[i], p]), raw: null, kind: 'gezeichnet', name: 'Abendrunde', savedId: null, hasTime: false };
    const tctx = await desktop(browser);
    await tctx.addInitScript((r) => { try { localStorage.setItem('myforrest.route.v1', r); } catch {} }, JSON.stringify(route));
    const page = await explore(tctx);
    await page.click('#tours-toggle');
    await settle(page, 2000);
    await page.evaluate(() => { document.querySelector('#tour-sun').open = true; });
    await page.fill('#tour-sun-date', '2026-07-15');
    await page.fill('#tour-sun-time', '18:30');
    await page.click('#tour-sun-go');
    await page.waitForSelector('#tour-sun-result .sun-bar', { timeout: 120000 });
    await page.evaluate(() => map.fitBounds([[47.3636, 8.5495], [47.3705, 8.5695]], { paddingTopLeft: [440, 70], paddingBottomRight: [380, 50] }));
    await settle(page, 2500);
    await page.evaluate(() => document.querySelector('#tour-sun')?.scrollIntoView({ block: 'start' }));
    await settle(page, 800);
    await page.screenshot({ path: out('tour-sonne-schatten.jpg'), ...jpg });
    await tctx.close();
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

  if (want('wegnetz')) {
    // Walk-through from the windthrow spot: the path first runs north, then to the 360° recording.
    const page = await ctx.newPage();
    await page.goto(`${BASE}/`);
    await settle(page, 2000);
    const id = await page.evaluate(async () => {
      const spots = await (await fetch('/api/spots')).json();
      const s = spots.reduce((a, b) => (Math.hypot(b.lat - 47.37327, b.lon - 8.57203) < Math.hypot(a.lat - 47.37327, a.lon - 8.57203) ? b : a));
      const d = await (await fetch(`/api/spots/${s.id}`)).json();
      return d.photos[d.photos.length - 1].id;
    });
    await page.evaluate((x) => Walk.open(x), id);
    await settle(page, 4000);
    await page.screenshot({ path: out('durchgehen-wegnetz.jpg'), ...jpg });
    await page.close();
  }

  if (want('uebergang')) {
    // A soft step in the walk-through, recorded as video: turn towards the way, walk ahead, and back again.
    const dir = path.join(WORK, 'video');
    fs.rmSync(dir, { recursive: true, force: true });
    const vctx = await desktop(browser, { viewport: { width: 960, height: 600 }, recordVideo: { dir, size: { width: 960, height: 600 } } });
    const page = await vctx.newPage();
    await page.goto(`${BASE}/`);
    await settle(page, 2000);
    const ids = await page.evaluate(async () => {
      const panos = [];
      for (const s of await (await fetch('/api/spots')).json()) {
        for (const p of (await (await fetch(`/api/spots/${s.id}`)).json()).photos) if (p.sequenceId === 'demo-360-waldweg') panos.push([p.takenAt, p.id]);
      }
      return panos.sort().map((x) => x[1]);
    });
    await page.evaluate((id) => Walk.open(id), ids[1]);
    await settle(page, 2500);
    for (let k = 0; k < 4; k++) await page.keyboard.press('a'); // look a little to the left first
    await settle(page, 800);
    const start = await page.evaluate(() => performance.now());
    await page.locator('.walk-arrow.weg[aria-label^="Weiter"]').click();
    await settle(page, 2300);
    await page.keyboard.press('s');
    await settle(page, 2000);
    const end = await page.evaluate(() => performance.now());
    const video = await page.video().path();
    await vctx.close();
    // The page clock started with the video: cut from shortly before the click to the end.
    const from = Math.max(0, start / 1000 - 0.6);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-ss', from.toFixed(2), '-t', ((end - start) / 1000 + 0.6).toFixed(2), '-i', video,
      '-vf', 'fps=10,scale=400:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=112[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
      out('durchgehen-uebergang.gif')]);
  }

  if (only.includes('mapillary')) {
    // Walking the forest track with Mapillary pictures across it, then on one of them, and the map layer.
    const page = await ctx.newPage();
    await page.goto(`${BASE}/`);
    await settle(page, 2000);
    const ids = await page.evaluate(async () => {
      const panos = [];
      for (const s of await (await fetch('/api/spots')).json()) {
        for (const p of (await (await fetch(`/api/spots/${s.id}`)).json()).photos) if (p.sequenceId === 'demo-360-waldweg') panos.push([p.takenAt, p.id]);
      }
      return panos.sort().map((x) => x[1]);
    });
    await page.evaluate((id) => Walk.open(id), ids[1]);
    await settle(page, 5000);
    await page.screenshot({ path: out('durchgehen-mapillary.jpg'), ...jpg });
    await page.click('.walk-arrow.mapillary');
    await settle(page, 6000);
    await page.screenshot({ path: out('mapillary.jpg'), ...jpg });
    await page.keyboard.press('Escape');
    await settle(page, 1000);
    await page.evaluate(() => document.querySelector('#explore').scrollIntoView());
    await page.click('#mapillary-toggle');
    await page.evaluate(() => map.setView([47.37388, 8.57279], 17, { animate: false }));
    await settle(page, 3500);
    await page.screenshot({ path: out('mapillary-karte.jpg'), ...jpg });
    await page.close();
  }

  if (want('baeume')) {
    // Species suggestions from a tree inventory in the species box of the windthrow spot.
    const page = await explore(ctx);
    await pin(page, 1).click();
    await page.waitForSelector('#species-inventory:not([hidden]) .inventory-list', { state: 'attached', timeout: 60000 });
    await page.setViewportSize({ width: 1440, height: 2400 });
    await page.evaluate(() => { const d = document.querySelector('#species-box'); d.open = true; document.querySelector('#species-inventory').scrollIntoView({ block: 'center' }); });
    await settle(page, 1200);
    await page.locator('#species-inventory').screenshot({ path: out('bauminventar.jpg'), ...jpg });
    await page.close();
  }

  if (want('klima')) {
    // "Klima im Wandel": the dossier of the region around the windthrow spot, its parts, and the spot's tab.
    const page = await explore(ctx);
    // The climate map: hot days at +2 °C in cells of 0.1°, then the forest belts of the (demo) WMS.
    await page.evaluate(() => map.setView([47.37, 8.58], 11, { animate: false }));
    await page.click('#klima-toggle');
    await page.selectOption('#klima-layer', 'hot');
    await page.waitForFunction(() => document.querySelectorAll('.k-cell-rect').length >= 20 && !/berechnet/.test(document.querySelector('#klima-status').textContent), null, { timeout: 180000 });
    await settle(page, 1500);
    await page.screenshot({ path: out('klima-karte.jpg'), ...jpg });
    await page.uncheck('#klima-grid');
    await page.selectOption('#klima-wms', { label: 'Vegetationshöhenstufen 2085, trockeneres Klima (Demo)' });
    await settle(page, 3000);
    await page.screenshot({ path: out('klima-karte-wald.jpg'), ...jpg });
    await page.check('#klima-grid');
    await page.selectOption('#klima-wms', '');
    await page.evaluate(() => map.setView([47.3733, 8.5720], 14, { animate: false }));
    await page.click('#klima-dossier-here');
    await page.waitForSelector('#klima .k-hero', { timeout: 120000 });
    await settle(page, 1500);
    await page.screenshot({ path: out('klima-dossier.jpg'), ...jpg });
    await page.addStyleTag({ content: '#klima .k-head { position: static; }' }); // the sticky header would cover the parts
    for (const [id, file] of [['k-changes', 'klima-kennzahlen.jpg'], ['k-timeline-title', 'klima-zeitachse.jpg'], ['k-synth-title', 'klima-synthese.jpg'], ['k-outlook', 'klima-ausblick.jpg'],
      ['k-levels', 'klima-szenarien.jpg'], ['k-forest', 'klima-wald.jpg']]) {
      const part = page.locator(`#klima section[aria-labelledby="${id}"]`);
      await part.scrollIntoViewIfNeeded();
      await settle(page, 600);
      await part.screenshot({ path: out(file), ...jpg });
    }
    await page.keyboard.press('Escape');
    await pin(page, 1).click();
    await settle(page, 2500);
    await page.click('#tab-klima');
    await page.waitForSelector('#klima-spot-body .k-stripes', { timeout: 60000 });
    // The tab is taller than the window: a tall window shows all of it.
    await page.setViewportSize({ width: 1440, height: 2600 });
    await settle(page, 1200);
    await page.locator('#pane-klima').screenshot({ path: out('klima-spot.jpg'), ...jpg });
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
    await page.click('#tab-verlauf');
    await page.evaluate(() => document.querySelector('#glacier-title')?.scrollIntoView({ block: 'start' }));
    await page.evaluate(() => { document.querySelector('#panel').scrollTop -= 80; });
    await settle(page, 2000);
    await page.locator('#panel').screenshot({ path: out('gletscher.jpg'), ...jpg });
    // GLAMOS length change and the archive pictures from the catalogue.
    await page.waitForSelector('#glacier-archives .archive-list', { timeout: 10000 }).catch(() => {});
    await page.evaluate(() => document.querySelector('.length-chart')?.scrollIntoView({ block: 'start' }));
    await page.evaluate(() => { document.querySelector('#panel').scrollTop -= 60; });
    await settle(page, 1500);
    await page.locator('#panel').screenshot({ path: out('gletscher-archiv.jpg'), ...jpg });
    // Before/after: the postcard of 1928 against 2025.
    await page.setViewportSize({ width: 1440, height: 1500 });
    await page.evaluate(() => document.querySelector('#explore').scrollIntoView());
    await page.evaluate(() => { document.querySelector('#panel').scrollTop = 0; });
    await page.click('#open-compare');
    await settle(page, 1500);
    await page.selectOption('#cmp-a', { index: 0 });
    await page.selectOption('#cmp-b', { index: await page.evaluate(() => state.spot.photos.length - 1) });
    await settle(page, 5000);
    await page.uncheck('#cmp-heat');
    await page.evaluate(() => { const r = document.querySelector('#swipe-range'); r.value = 50; r.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.evaluate(() => document.querySelector('#compare').scrollIntoView({ block: 'start' }));
    await page.evaluate(() => { document.querySelector('#panel').scrollTop -= 90; }); // below the sticky head
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
    await page.click('#tab-verlauf');
    await page.evaluate(() => document.querySelector('#glacier-title')?.scrollIntoView({ block: 'start' }));
    await page.evaluate(() => { document.querySelector('#panel').scrollTop -= 80; });
    await settle(page, 2000);
    await page.locator('#panel').screenshot({ path: out('gebirge.jpg'), ...jpg });
    await gctx.close();
  }

  if (want('landschaft-gletscher')) {
    // Landschaft im Wandel with the glacier inventories of the glacier demo server: the outlines over the aerial
    // image of 1956, and the area per inventory in the report.
    const GB = process.env.BASE_GLETSCHER || 'http://localhost:3124';
    const gctx = await desktop(browser);
    const page = await gctx.newPage();
    page.on('console', (m) => m.type() === 'error' && console.log('console:', m.text()));
    await page.goto(`${GB}/landschaft.html#karte?lat=46.592&lon=8.4&ansicht=luftbild&jahr=1956`);
    await settle(page, 2500);
    await page.click('#ln-glacier-toggle');
    await page.click('.leaflet-control-zoom-in');
    await settle(page, 800);
    await page.click('.leaflet-control-zoom-in');
    await settle(page, 6000);
    // Scroll the panel only (not the page) to the glacier section.
    await page.evaluate(() => {
      const panel = document.querySelector('.ln-panel');
      panel.scrollTop = document.getElementById('ln-glaciers').offsetTop - panel.offsetTop - 360;
      window.scrollTo(0, 0);
    });
    await settle(page, 800);
    await page.screenshot({ path: out('landschaft-gletscher.jpg'), ...jpg });
    await page.goto(`${GB}/landschaft.html#bericht?lat=46.6&lon=8.4`);
    await page.waitForSelector('.ln-section', { timeout: 120000 });
    await settle(page, 2500);
    const section = page.locator('.ln-section', { has: page.locator('h2', { hasText: 'Gletscher und Wasser' }) });
    await section.screenshot({ path: out('landschaft-gletscher-bericht.jpg'), ...jpg });
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
    // API keys for scripts: two existing keys and a new one, shown once.
    await page.route('**/api/auth/tokens', (r) => r.fulfill(r.request().method() === 'POST'
      ? { status: 201, json: { id: 3, name: 'NAS-Import', token: 'mf_Q2xhdWRlIGRlbW8ga2V5IGZvciB0aGUgc2NyZWVuc2hvdA', createdAt: '2026-10-15T08:00:00.000Z', lastUsedAt: null } }
      : { json: { tokens: [
        { id: 1, name: 'Laptop', createdAt: '2026-03-02T08:00:00.000Z', lastUsedAt: '2026-10-12T17:41:00.000Z' },
        { id: 2, name: 'Wildkamera-Skript', createdAt: '2026-06-20T08:00:00.000Z', lastUsedAt: '2026-10-15T06:05:00.000Z' },
        { id: 3, name: 'NAS-Import', createdAt: '2026-10-15T08:00:00.000Z', lastUsedAt: null },
      ] } }));
    await page.click('#profile-keys summary');
    await page.fill('#key-form input[name=name]', 'NAS-Import');
    await page.click('#key-form button');
    await settle(page, 800);
    await page.locator('#profile-keys').screenshot({ path: out('api-schluessel.png') });
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
