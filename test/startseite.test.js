'use strict';

// Start page: the section «Funktionen» links every feature, and the documentation address comes from the config.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

test('every tile of «Funktionen» opens something that exists', () => {
  const html = read('index.html');
  const section = html.slice(html.indexOf('id="funktionen"'), html.indexOf('id="explore"'));
  const toggles = [...section.matchAll(/data-toggle="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(toggles.length >= 6);
  for (const id of toggles) assert.match(html, new RegExp(`<button[^>]*id="${id}"`), `map button ${id}`);
  const runs = new Set([...html.matchAll(/data-run="([^"]+)"/g)].map((m) => m[1]));
  const js = read('features.js');
  for (const r of runs) assert.match(js, new RegExp(`\\b${r}: \\(\\) =>`), `action ${r}`);
  assert.ok(runs.has('fahrt'), 'the drive mode has a button');
  const keys = [...section.matchAll(/data-key="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(keys).size, keys.length, 'link keys are unique');
  assert.match(html, /<nav[^>]*>[\s\S]*href="#funktionen"[\s\S]*data-docs[\s\S]*<\/nav>/, 'navigation: Funktionen and Doku');
  assert.match(read('sw.js'), /'features\.js'/);
});

test('config names the documentation website, with a trailing slash; empty turns the links off', async () => {
  for (const [docsUrl, want] of [[undefined, 'https://michifrey.github.io/myforrest/'], ['https://docs.example/wald', 'https://docs.example/wald/'], ['', null]]) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-start-'));
    const app = createApp({ dataDir, weatherFetch: async () => new Response('offline', { status: 503 }), ...(docsUrl === undefined ? {} : { docsUrl }) });
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    try {
      const { docs } = await (await fetch(`http://127.0.0.1:${server.address().port}/api/config`)).json();
      assert.equal(docs, want);
    } finally {
      server.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }
});
