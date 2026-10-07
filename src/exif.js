'use strict';

const exifr = require('exifr');

const EXIF_DATE = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/;
const OFFSET = /^([+-])(\d{2}):?(\d{2})$/;

/** Parses "+02:00" into minutes east of UTC, or null. */
function parseOffset(value) {
  const m = typeof value === 'string' && value.trim().match(OFFSET);
  if (!m) return null;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/**
 * Converts an EXIF local timestamp ("2024:05:01 10:00:00") to UTC ms.
 * Cameras store wall-clock time without a zone, so the offset comes from
 * OffsetTimeOriginal when present, otherwise from `fallbackOffsetMin`.
 */
function exifDateToUtc(value, offsetMin) {
  const m = typeof value === 'string' && value.match(EXIF_DATE);
  if (!m) return null;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isFinite(asUtc) ? asUtc - offsetMin * 60 * 1000 : null;
}

/** GPS altitude in metres (negative below sea level), or null. */
function altitudeOf(tags) {
  const alt = Number(tags.GPSAltitude);
  if (!Number.isFinite(alt)) return null;
  const ref = tags.GPSAltitudeRef;
  const below = (ref && typeof ref === 'object' ? ref[0] : Number(ref)) === 1;
  return Math.round((below ? -alt : alt) * 10) / 10;
}

/** Reads capture time, GPS position, altitude and viewing direction from an image. */
async function readPhotoMeta(buffer, fallbackOffsetMin = 0) {
  let tags = {};
  let gps = null;
  try {
    tags = (await exifr.parse(buffer, {
      pick: ['DateTimeOriginal', 'CreateDate', 'OffsetTimeOriginal', 'OffsetTime', 'GPSImgDirection', 'GPSAltitude', 'GPSAltitudeRef'],
      reviveValues: false,
    })) || {};
    gps = await exifr.gps(buffer);
  } catch {
    // Images without (or with broken) EXIF are fine: position/time come from elsewhere.
  }
  const offset = parseOffset(tags.OffsetTimeOriginal) ?? parseOffset(tags.OffsetTime) ?? fallbackOffsetMin;
  const heading = Number(tags.GPSImgDirection);
  return {
    takenAt: exifDateToUtc(tags.DateTimeOriginal || tags.CreateDate, offset),
    lat: gps && Number.isFinite(gps.latitude) ? gps.latitude : null,
    lon: gps && Number.isFinite(gps.longitude) ? gps.longitude : null,
    heading: Number.isFinite(heading) ? heading : null,
    altitude: altitudeOf(tags),
  };
}

/** Detects the image type from magic bytes; returns a file extension or null. */
function imageExtension(buffer) {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.toString('latin1', 0, 8) === '\x89PNG\r\n\x1a\n') return 'png';
  if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

module.exports = { readPhotoMeta, exifDateToUtc, parseOffset, imageExtension };
