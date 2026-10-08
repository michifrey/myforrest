'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { metadataRecord, recordUuid } = require('../src/metadata');

const noWeather = async () => new Response('offline', { status: 503 });

/** Every start tag closed in order, nothing left open: enough to catch broken generated XML. */
function assertWellFormed(xml) {
  const stack = [];
  const body = xml.replace(/^<\?xml[^?]*\?>/, '');
  for (const [, close, name, selfClosing] of body.matchAll(/<(\/?)([A-Za-z][\w.:-]*)(?:\s[^<>]*?)?(\/?)>/g)) {
    if (close) assert.equal(stack.pop(), name, `</${name}> closes the wrong element`);
    else if (!selfClosing) stack.push(name);
  }
  assert.deepEqual(stack, [], 'all elements closed');
  assert.ok(!/&(?!amp;|lt;|gt;|quot;)/.test(body), 'ampersands escaped');
}

const INFO = {
  base: 'https://myforrest.example.ch',
  bbox: [8.54, 47.37, 8.55, 47.38],
  firstPhoto: Date.UTC(2021, 6, 10),
  lastPhoto: Date.UTC(2025, 6, 24),
  created: Date.UTC(2023, 0, 5),
  updated: Date.UTC(2025, 8, 1, 12, 30),
};
const LICENSE = { licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/', licenseLabel: 'CC BY-SA 4.0' };

test('Metadata record in the Swiss profile GM03 (ISO19139.che) for geocat.ch', () => {
  const xml = metadataRecord(INFO, { organisation: 'Verein <Wald> & Co', email: 'info@example.ch', city: 'Zürich' }, { profile: 'che', ...LICENSE });
  assertWellFormed(xml);
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<che:CHE_MD_Metadata gco:isoType="gmd:MD_Metadata"/);
  assert.match(xml, /<che:CHE_MD_DataIdentification gco:isoType="gmd:MD_DataIdentification">/);
  assert.match(xml, /<che:CHE_CI_ResponsibleParty gco:isoType="gmd:CI_ResponsibleParty">/);
  assert.match(xml, /<che:CHE_MD_LegalConstraints gco:isoType="gmd:MD_LegalConstraints">/);
  assert.ok(xml.includes('Verein &lt;Wald&gt; &amp; Co'), 'organisation escaped');
  // Title, alternate title and abstract in German and French (federal rules of geocat.ch), plus Italian and English.
  for (const id of ['DE', 'FR', 'IT', 'EN']) assert.match(xml, new RegExp(`<gmd:PT_Locale id="${id}">`));
  assert.match(xml, /<gmd:LocalisedCharacterString locale="#FR">MyForrest – Évolution de la forêt/);
  // Alternate titles stay under 36 characters (geocat.ch BGDI rule).
  const alt = xml.match(/<gmd:alternateTitle[^>]*>(.*?)<\/gmd:alternateTitle>/s)[1];
  const altTexts = [...alt.matchAll(/>([^<>]+)</g)].map((m) => m[1]);
  assert.equal(altTexts.length, 5, 'main text and four languages');
  assert.ok(altTexts.every((t) => t.length < 36));
  // Swiss topic category with its sub-category, as the GM03 rules want for "environment".
  assert.match(xml, /<gmd:MD_TopicCategoryCode>environment<\/gmd:MD_TopicCategoryCode>.*environment_NatureProtection/s);
  // Extent and dates from the data.
  assert.match(xml, /<gmd:westBoundLongitude><gco:Decimal>8.54<\/gco:Decimal>/);
  assert.match(xml, /<gml:beginPosition>2021-07-10<\/gml:beginPosition><gml:endPosition>2025-07-24<\/gml:endPosition>/);
  assert.match(xml, /<gco:Date>2023-01-05<\/gco:Date><\/gmd:date><gmd:dateType><gmd:CI_DateTypeCode [^>]*codeListValue="creation"/);
  assert.match(xml, /<gmd:dateStamp><gco:DateTime>2025-09-01T12:30:00<\/gco:DateTime>/);
  // Online resources with geocat.ch's protocols.
  assert.match(xml, /<gmd:URL>https:\/\/myforrest.example.ch\/api\/export\/myforrest.gpkg<\/gmd:URL><\/gmd:linkage><gmd:protocol><gco:CharacterString>WWW:DOWNLOAD-URL/);
  assert.match(xml, /<gmd:URL>https:\/\/myforrest.example.ch\/ogc<\/gmd:URL><\/gmd:linkage><gmd:protocol><gco:CharacterString>WWW:LINK/);
  assert.match(xml, /MAP:Preview/);
  assert.ok(!xml.includes('OGC:WMS'), 'no QGIS Server services unless configured');
  assert.ok(!xml.includes('opendata.swiss'), 'not marked for opendata.swiss unless configured');
  assert.match(xml, /<gmx:Anchor xlink:href="https:\/\/creativecommons.org\/licenses\/by-sa\/4.0\/">CC BY-SA 4.0<\/gmx:Anchor>/);
});

test('Metadata: plain ISO 19139, QGIS Server services, opendata.swiss, stable identifier', () => {
  const xml = metadataRecord(INFO, { organisation: 'MyForrest' }, {
    profile: 'iso', owsUrl: 'https://myforrest.example.ch/ows/', opendataTerms: 'terms_by', ...LICENSE,
  });
  assertWellFormed(xml);
  assert.match(xml, /\n<gmd:MD_Metadata xmlns:gmd=/);
  assert.ok(!xml.includes('che:'), 'no Swiss profile elements');
  assert.ok(!xml.includes('environment_NatureProtection'), 'only ISO topic categories');
  for (const p of ['OGC:WMS', 'OGC:WMTS', 'OGC:WFS']) assert.ok(xml.includes(`<gco:CharacterString>${p}</gco:CharacterString>`), p);
  assert.ok(xml.includes('https://myforrest.example.ch/ows/?SERVICE=WMS&amp;REQUEST=GetCapabilities'));
  assert.match(xml, /<gmd:keyword><gco:CharacterString>opendata.swiss<\/gco:CharacterString><\/gmd:keyword>/);
  assert.match(xml, /opendata.swiss\/en\/terms-of-use\/#terms_by/);
  assert.ok(!metadataRecord(INFO, { organisation: 'x' }, { opendataTerms: 'anything', ...LICENSE }).includes('opendata.swiss'), 'unknown terms ignored');

  const id = recordUuid('https://myforrest.example.ch');
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(recordUuid('https://myforrest.example.ch'), id, 'same server, same record');
  assert.notEqual(recordUuid('https://other.example.ch'), id);
  assert.equal(recordUuid('https://myforrest.example.ch', 'fixed-id'), 'fixed-id');
  assert.ok(xml.includes(`<gmd:fileIdentifier><gco:CharacterString>${id}</gco:CharacterString>`));
});

test('Metadata endpoints use the data and the METADATA_* settings', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, { METADATA_ORGANISATION: 'Forstverein Test', METADATA_EMAIL: 'wald@example.ch', METADATA_OPENDATA_TERMS: 'terms_by' });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myforrest-meta-'));
  const app = createApp({ dataDir, weatherFetch: noWeather, tileOptions: { precompute: false } });
  process.env = saved;
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const db = app.locals.db;
    const spot = db.prepare('INSERT INTO spots (lat, lon, created_at) VALUES (46.95, 7.45, ?)').run(Date.UTC(2024, 2, 1)).lastInsertRowid;
    for (const [lat, lon, taken, created] of [[46.95, 7.45, Date.UTC(2022, 4, 3), Date.UTC(2024, 2, 1)], [46.96, 7.47, Date.UTC(2024, 6, 9), Date.UTC(2024, 6, 10)]]) {
      db.prepare(`INSERT INTO photos (spot_id, file, taken_at, lat, lon, location_source, created_at)
        VALUES (?, ?, ?, ?, ?, 'exif', ?)`).run(spot, `p${taken}.jpg`, taken, lat, lon, created);
    }
    const res = await fetch(`${base}/api/metadata/geocat.xml`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^application\/xml/);
    const xml = await res.text();
    assertWellFormed(xml);
    assert.match(xml, /<che:CHE_MD_Metadata/);
    assert.ok(xml.includes('Forstverein Test') && xml.includes('wald@example.ch'));
    assert.ok(xml.includes('opendata.swiss'));
    assert.match(xml, /<gmd:westBoundLongitude><gco:Decimal>7.45<\/gco:Decimal>.*<gmd:eastBoundLongitude><gco:Decimal>7.47<\/gco:Decimal>/s);
    assert.match(xml, /<gml:beginPosition>2022-05-03<\/gml:beginPosition><gml:endPosition>2024-07-09<\/gml:endPosition>/);
    assert.match(xml, /<gco:Date>2024-03-01<\/gco:Date>.*codeListValue="creation".*<gco:Date>2024-07-10<\/gco:Date>.*codeListValue="revision"/s);
    assert.ok(xml.includes(`<gmd:URL>${base}/api/export/myforrest.pmtiles</gmd:URL>`));
    assert.match(await (await fetch(`${base}/api/metadata/iso19139.xml`)).text(), /<gmd:MD_Metadata/);
    const landing = await (await fetch(`${base}/ogc`)).json();
    assert.deepEqual(landing.links.filter((l) => l.rel === 'describedby').map((l) => l.href),
      [`${base}/api/metadata/geocat.xml`, `${base}/api/metadata/iso19139.xml`]);
  } finally {
    await app.locals.idle();
    server.close();
    app.locals.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
