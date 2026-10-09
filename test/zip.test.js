'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { PassThrough } = require('node:stream');
const { createZip } = require('../src/zip');

async function build(entries, opts) {
  const out = new PassThrough();
  const chunks = [];
  out.on('data', (c) => chunks.push(c));
  const zip = createZip(out, opts);
  for (const [name, data] of entries) await zip.add(name, data);
  await zip.finish();
  out.end();
  return Buffer.concat(chunks);
}

/** Central directory entries, following ZIP64 records where present. */
function central(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (p === 0xffffffff) {
    const loc = eocd - 20;
    assert.equal(buf.readUInt32LE(loc), 0x07064b50, 'ZIP64 locator');
    const rec = Number(buf.readBigUInt64LE(loc + 8));
    assert.equal(buf.readUInt32LE(rec), 0x06064b50, 'ZIP64 end record');
    count = Number(buf.readBigUInt64LE(rec + 32));
    p = Number(buf.readBigUInt64LE(rec + 48));
  }
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    let offset = buf.readUInt32LE(p + 42);
    if (offset === 0xffffffff) {
      const extra = p + 46 + nameLen;
      assert.equal(buf.readUInt16LE(extra), 0x0001, 'ZIP64 extra field');
      offset = Number(buf.readBigUInt64LE(extra + 4));
    }
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const size = buf.readUInt32LE(p + 20);
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const data = buf.subarray(start, start + size);
    assert.equal(zlib.crc32(data), buf.readUInt32LE(p + 16), `CRC of ${name}`);
    out.push({ name, data: data.toString() });
    p += 46 + nameLen + extraLen;
  }
  return out;
}

const ENTRIES = [['LIESMICH.txt', 'Grüezi\n'], ['fotos/2026-05-01_7.jpg', 'x'.repeat(5000)], ['touren/1_Runde-Älpli.gpx', '<gpx/>']];

test('a ZIP with UTF-8 names and checksums', async () => {
  const buf = await build(ENTRIES);
  assert.deepEqual(central(buf).map((e) => e.name), ENTRIES.map(([n]) => n));
  assert.equal(central(buf)[0].data, 'Grüezi\n');
  assert.equal(buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06])), -1, 'no ZIP64 records when small');
});

test('past the threshold the central directory switches to ZIP64', async () => {
  const buf = await build(ENTRIES, { zip64At: 100 });
  const entries = central(buf);
  assert.deepEqual(entries.map((e) => e.name), ENTRIES.map(([n]) => n));
  assert.equal(entries[2].data, '<gpx/>');
});

test('many entries without piling up listeners', async () => {
  const warnings = [];
  const onWarning = (w) => warnings.push(w.name);
  process.on('warning', onWarning);
  const buf = await build(Array.from({ length: 50 }, (_, i) => [`f${i}.txt`, String(i)]));
  await new Promise((r) => setImmediate(r));
  process.off('warning', onWarning);
  assert.equal(central(buf).length, 50);
  assert.deepEqual(warnings, []);
});
