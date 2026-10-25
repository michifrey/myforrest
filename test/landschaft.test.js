'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const M = require('../public/landschaft-model');
const { createApp } = require('../src/app');

test('Landschaft im Wandel: seven stops with sources, from the ice age to 2100', () => {
  for (const scenario of Object.keys(M.SCENARIOS)) {
    const stops = M.stops(scenario);
    assert.deepEqual(stops.map((s) => s.id), ['lgm', 'dryas', 'holocene', '1850', 'today', '2050', '2100']);
    for (const s of stops) {
      assert.ok(typeof s.voice === 'string' && s.voice.length > 20, `${s.id}: the valley's own words`);
      assert.ok(s.facts.length >= 2 && s.facts.every((f) => typeof f === 'string' && f), `${s.id}: facts`);
      assert.ok(s.sources.length && s.sources.every((k) => M.SOURCES[k]?.url), `${s.id}: sources`);
      assert.equal(s.forces.length, M.FORCES.length, `${s.id}: one level per force`);
      assert.ok(s.forces.every((v) => Number.isInteger(v) && v >= 0 && v <= 3));
    }
    // The ice age fills the valley; there are no greenhouse gases from humans before 1850.
    assert.equal(stops[0].ice, 1);
    assert.ok(stops.slice(0, 3).every((s) => s.forces[6] === 0));
    // Today the human greenhouse gases are the strongest force.
    assert.equal(stops[4].forces[6], 3);
  }
});

test('Landschaft im Wandel: the three pathways differ only from today on, in the expected order', () => {
  const at2100 = Object.keys(M.SCENARIOS).map((s) => M.at(M.MAX_POS, s));
  assert.ok(at2100[0].ice > at2100[1].ice && at2100[1].ice > at2100[2].ice, 'more emissions, less ice');
  assert.ok(at2100[0].treeline < at2100[1].treeline && at2100[1].treeline < at2100[2].treeline, 'more emissions, higher climate treeline');
  // The climate climbs by the rule of docs/klimawandel.md: twice the global warming, 0.55 °C per 100 m.
  assert.equal(M.climbFor(2.7), Math.round(((2 * (2.7 - 1.2)) / 0.55) * 100 / 10) * 10);
  for (const st of at2100) {
    assert.ok(st.future);
    assert.ok(st.forestline <= st.treeline, 'the forest follows the climate more slowly');
    assert.ok(st.forestline - M.TREELINE_TODAY <= 150 + 1e-9, 'at most about 2 m per year from today');
  }
  for (const pos of [0, 150, 300, M.TODAY_POS]) {
    const [a, b, c] = Object.keys(M.SCENARIOS).map((s) => M.at(pos, s));
    assert.deepEqual([a.ice, a.treeline], [b.ice, b.treeline]);
    assert.deepEqual([b.ice, b.treeline], [c.ice, c.treeline]);
    assert.ok(!a.future);
  }
  // Between two stops everything is blended, the words come from the nearer stop.
  const mid = M.at(350, 'mid');
  assert.ok(mid.ice < 0.85 && mid.ice > 0.45);
  assert.equal(M.at(340, 'mid').stop.id, '1850');
  assert.equal(M.at(360, 'mid').stop.id, 'today');
  assert.equal(M.at(-5).pos, 0);
  assert.equal(M.at(9999).pos, M.MAX_POS);
});

test('Landschaft im Wandel: the section draws ice, belts and trees where they belong', () => {
  const iceAge = M.section(M.at(0));
  assert.ok(iceAge.glacier.length > 100, 'the ice age fills the section');
  assert.equal(iceAge.trees.length, 0, 'no forest under the ice');
  const today = M.section(M.at(M.TODAY_POS));
  assert.ok(today.glacier && today.trees.length > 5);
  assert.ok(today.belts.every((b) => Object.values(M.BELT).includes(b.color)));
  // Trees only below the forest line (y grows downwards, so their base lies below the line).
  assert.ok(today.trees.every((t) => t.y + 4 >= today.treelineY - 1));
  const gone = M.section({ ...M.at(M.MAX_POS, 'high'), ice: 0 });
  assert.equal(gone.glacier, null);
  assert.ok(today.places.some((p) => p.label.startsWith('Jungfrau')));
});

test('Landschaft im Wandel is a page of its own, linked from the start page and cached for offline use', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-landschaft-'));
  const app = createApp({ dataDir, tileOptions: { precompute: false } });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(`${base}/landschaft.html`);
    assert.equal(page.status, 200);
    const html = await page.text();
    for (const file of ['landschaft-model.js', 'landschaft.js', 'landschaft.css']) {
      assert.ok(html.includes(file), file);
      assert.equal((await fetch(`${base}/${file}`)).status, 200, file);
    }
    for (const id of ['zeitraffer', 'wege', 'daten']) assert.ok(html.includes(`id="${id}"`), id);
    const start = await (await fetch(`${base}/`)).text();
    assert.ok(start.includes('href="landschaft.html"'));
    assert.ok(start.includes('id="perspektiven"'));
    const sw = await (await fetch(`${base}/sw.js`)).text();
    for (const file of ['landschaft.html', 'landschaft.js', 'landschaft-model.js', 'landschaft.css']) assert.ok(sw.includes(`'${file}'`), file);
  } finally {
    await app.locals.idle();
    server.close();
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
