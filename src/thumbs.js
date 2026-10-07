'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

/**
 * Preview images: every photo gets a small thumbnail (lists, timeline, map)
 * and a large version for the viewer, both as WebP. They are rotated
 * according to EXIF like the browser shows the original, and keep its aspect
 * ratio, so alignments (in normalised coordinates) apply to them unchanged.
 */
const SIZES = { thumb: 320, large: 1280 };

function createThumbnails({ db, uploadDir, thumbDir }) {
  fs.mkdirSync(thumbDir, { recursive: true });
  const setFiles = db.prepare('UPDATE photos SET thumb_file = ?, large_file = ? WHERE id = ?');

  /** Renders both sizes of a photo and records them; returns the file names. */
  async function generate(photo) {
    const src = path.join(uploadDir, photo.file);
    const stem = path.parse(photo.file).name;
    const names = {};
    for (const [kind, px] of Object.entries(SIZES)) {
      names[kind] = `${stem}-${px}.webp`;
      await sharp(src, { failOn: 'none' })
        .rotate()
        .resize({ width: px, height: px, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: kind === 'thumb' ? 72 : 80 })
        .toFile(path.join(thumbDir, names[kind]));
    }
    setFiles.run(names.thumb, names.large, photo.id);
    return names;
  }

  /** Like `generate`, but logs failures instead of throwing (the original still works). */
  async function ensure(photo) {
    try {
      return await generate(photo);
    } catch (err) {
      console.error(`Vorschaubild für Foto ${photo.id} fehlgeschlagen:`, err.message);
      return null;
    }
  }

  /** Creates the missing previews of photos uploaded before this feature existed. */
  async function backfill() {
    const missing = db.prepare('SELECT id, file FROM photos WHERE thumb_file IS NULL OR large_file IS NULL ORDER BY id').all();
    for (const photo of missing) await ensure(photo);
    return missing.length;
  }

  async function remove(photo) {
    await Promise.all([photo.thumb_file, photo.large_file].filter(Boolean)
      .map((f) => fsp.rm(path.join(thumbDir, f), { force: true })));
  }

  /** Preview URLs of a photo row; fall back to the original while none exist. */
  const urls = (photo) => ({
    thumbUrl: photo.thumb_file ? `/thumbs/${photo.thumb_file}` : `/uploads/${photo.file}`,
    largeUrl: photo.large_file ? `/thumbs/${photo.large_file}` : `/uploads/${photo.file}`,
  });

  return { generate, ensure, backfill, remove, urls };
}

module.exports = { createThumbnails, SIZES };
