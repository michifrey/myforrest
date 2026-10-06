'use strict';

const attr = (attrs, name) => {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`));
  return m ? Number(m[1]) : NaN;
};

/**
 * Extracts timestamped points from a GPX file (e.g. exported from Strava,
 * Komoot or a sports watch). Points without a <time> are skipped.
 * Returns [{lat, lon, time}] sorted by time (ms since epoch, UTC).
 */
function parseGpx(xml) {
  const points = [];
  const re = /<(trkpt|rtept|wpt)\b([^>]*)>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(xml))) {
    const lat = attr(m[2], 'lat');
    const lon = attr(m[2], 'lon');
    const timeMatch = m[3].match(/<time>\s*([^<]+?)\s*<\/time>/);
    if (!timeMatch || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const time = Date.parse(timeMatch[1]);
    if (Number.isFinite(time)) points.push({ lat, lon, time });
  }
  return points.sort((a, b) => a.time - b.time);
}

module.exports = { parseGpx };
