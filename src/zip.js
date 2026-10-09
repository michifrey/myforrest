'use strict';

/**
 * Writes a ZIP archive to a stream, without external dependencies.
 *
 * Entries are stored uncompressed: photos are JPEG/WebP already, and the JSON
 * and GPX files are small. Each entry is written as soon as it is added, so
 * an archive with many photos never sits in memory as a whole. File names
 * are UTF-8 (flag bit 11). When the archive grows past 4 GB, the central
 * directory switches to ZIP64 offsets; single entries stay below 4 GB.
 */

const zlib = require('node:zlib');

const MAX32 = 0xffffffff;

/** DOS date and time of a JavaScript date (local time, 2-second steps). */
function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** `zip64At` lowers the 4 GB threshold for the ZIP64 records (tests only). */
function createZip(stream, { zip64At = MAX32 } = {}) {
  const entries = [];
  let offset = 0;
  let failure = null;
  stream.on('error', (err) => { failure = err; });

  const write = (buf) => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    offset += buf.length;
    if (stream.write(buf)) return resolve();
    const done = () => { stream.off('drain', done); stream.off('close', done); return failure ? reject(failure) : resolve(); };
    stream.once('drain', done);
    stream.once('close', done); // a client that hangs up never drains
  });

  return {
    /** Adds a file; `data` is a Buffer or a string (written as UTF-8). */
    async add(name, data, { date = new Date() } = {}) {
      const body = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
      if (body.length >= MAX32) throw new Error(`${name}: einzelne Dateien über 4 GB werden nicht unterstützt`);
      const fileName = Buffer.from(name, 'utf8');
      const crc = zlib.crc32(body);
      const { time, date: day } = dosDateTime(date);
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4); // version needed
      header.writeUInt16LE(0x0800, 6); // UTF-8 names
      header.writeUInt16LE(0, 8); // stored
      header.writeUInt16LE(time, 10);
      header.writeUInt16LE(day, 12);
      header.writeUInt32LE(crc, 14);
      header.writeUInt32LE(body.length, 18);
      header.writeUInt32LE(body.length, 22);
      header.writeUInt16LE(fileName.length, 26);
      header.writeUInt16LE(0, 28);
      entries.push({ fileName, crc, size: body.length, time, day, offset });
      await write(header);
      await write(fileName);
      await write(body);
    },

    /** Writes the central directory; the stream is left open. */
    async finish() {
      const start = offset;
      for (const e of entries) {
        const zip64 = e.offset >= zip64At;
        const extra = zip64 ? Buffer.alloc(12) : Buffer.alloc(0);
        if (zip64) {
          extra.writeUInt16LE(0x0001, 0);
          extra.writeUInt16LE(8, 2);
          extra.writeBigUInt64LE(BigInt(e.offset), 4);
        }
        const h = Buffer.alloc(46);
        h.writeUInt32LE(0x02014b50, 0);
        h.writeUInt16LE((3 << 8) | (zip64 ? 45 : 20), 4); // made by Unix (UTF-8 names, file modes), spec version
        h.writeUInt16LE(zip64 ? 45 : 20, 6); // version needed
        h.writeUInt16LE(0x0800, 8);
        h.writeUInt16LE(0, 10);
        h.writeUInt16LE(e.time, 12);
        h.writeUInt16LE(e.day, 14);
        h.writeUInt32LE(e.crc, 16);
        h.writeUInt32LE(e.size, 20);
        h.writeUInt32LE(e.size, 24);
        h.writeUInt16LE(e.fileName.length, 28);
        h.writeUInt16LE(extra.length, 30);
        h.writeUInt16LE(0, 32); // comment
        h.writeUInt16LE(0, 34); // disk
        h.writeUInt16LE(0, 36); // internal attributes
        h.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, rw-r--r--
        h.writeUInt32LE(zip64 ? MAX32 : e.offset, 42);
        await write(h);
        await write(e.fileName);
        if (extra.length) await write(extra);
      }
      const size = offset - start;
      const needs64 = start >= zip64At || size >= zip64At || entries.length >= 0xffff;
      if (needs64) {
        const end64 = offset;
        const r = Buffer.alloc(56);
        r.writeUInt32LE(0x06064b50, 0);
        r.writeBigUInt64LE(44n, 4);
        r.writeUInt16LE(45, 12);
        r.writeUInt16LE(45, 14);
        r.writeUInt32LE(0, 16);
        r.writeUInt32LE(0, 20);
        r.writeBigUInt64LE(BigInt(entries.length), 24);
        r.writeBigUInt64LE(BigInt(entries.length), 32);
        r.writeBigUInt64LE(BigInt(size), 40);
        r.writeBigUInt64LE(BigInt(start), 48);
        const loc = Buffer.alloc(20);
        loc.writeUInt32LE(0x07064b50, 0);
        loc.writeUInt32LE(0, 4);
        loc.writeBigUInt64LE(BigInt(end64), 8);
        loc.writeUInt32LE(1, 16);
        await write(r);
        await write(loc);
      }
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(0, 4);
      end.writeUInt16LE(0, 6);
      end.writeUInt16LE(needs64 ? 0xffff : entries.length, 8);
      end.writeUInt16LE(needs64 ? 0xffff : entries.length, 10);
      end.writeUInt32LE(needs64 ? MAX32 : size, 12);
      end.writeUInt32LE(needs64 ? MAX32 : start, 16);
      end.writeUInt16LE(0, 20);
      await write(end);
    },
  };
}

module.exports = { createZip };
