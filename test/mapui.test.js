'use strict';

// The main map as on Outdooractive (public/mapui.js): the markup it needs and that it is cached for offline use.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');

test('Map: search and categories at the top, full screen, «Inhalt ausblenden» and the region', () => {
  for (const id of ['map-search', 'map-search-q', 'map-search-results', 'map-chips', 'tag-filter', 'map-fullscreen', 'map-content-toggle', 'map-region']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
});

test('Map: the round buttons at the bottom right, the tools behind «Funktionen», each with its label', () => {
  const fabs = html.slice(html.indexOf('id="map-fabs"'), html.indexOf('<section id="sunpanel"'));
  const more = fabs.slice(fabs.indexOf('id="fab-more"'), fabs.indexOf('id="fab-functions"'));
  for (const id of ['sun-toggle', 'species-toggle', 'measure-toggle', 'draw-toggle', 'klima-toggle', 'glacier-toggle', 'mapillary-toggle', 'map3d-toggle']) {
    assert.ok(more.includes(`id="${id}"`), `${id} under «Funktionen»`);
  }
  for (const id of ['fab-functions', 'tours-toggle', 'layers-toggle']) assert.match(fabs, new RegExp(`id="${id}" class="fab fab-main`), id);
  assert.equal((fabs.match(/class="fab-label"/g) || []).length, 11, 'every button has a label');
  assert.ok(!html.includes('map-toolbar'), 'the old bar is gone');
});

test('Map: mapui.js runs after the modules it uses and is cached for offline use', () => {
  const order = ['app.js', 'basemap.js', 'tours.js', 'coords.js', 'geoadmin-link.js', 'layers.js', 'measure.js', 'draw.js', 'mapui.js'].map((f) => html.indexOf(`<script src="${f}">`));
  assert.ok(order.every((i) => i > 0), 'all scripts present');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in this order');
  assert.ok(sw.includes("'mapui.js'"));
});
