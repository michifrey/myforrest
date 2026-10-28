/*
 * Coordinates as map.geo.admin.ch shows and reads them: Swiss LV95 and LV03, WGS84 in degrees and in degrees,
 * minutes and seconds, UTM and MGRS. `format(lat, lon)` gives every system for a place, `parse(text)` reads a typed
 * position in any of them. Runs in the browser (window.Coords, with window.mgrs from vendor/mgrs) and in Node.
 *
 * LV95 after swisstopo's approximate formulas (about 1 m, as src/lv95.js); LV03 is LV95 less 2 000 000 / 1 000 000
 * (the same approximation, without the reframe of swisstopo). UTM with the Krüger series on WGS84, MGRS with the
 * mgrs library of proj4js. The ideas and the list of formats follow the web-mapviewer of geo.admin.ch (BSD-3).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('mgrs'));
  else root.Coords = factory(root.mgrs);
}(typeof self !== 'undefined' ? self : this, (mgrs) => {
  'use strict';

  const RAD = Math.PI / 180;

  /** [E, N] in LV95 (m) for lat/lon in degrees (swisstopo's approximate formulas). */
  function toLv95(lat, lon) {
    const phi = (lat * 3600 - 169028.66) / 10000;
    const lambda = (lon * 3600 - 26782.5) / 10000;
    const e = 2600072.37 + 211455.93 * lambda - 10938.51 * lambda * phi - 0.36 * lambda * phi * phi - 44.54 * lambda ** 3;
    const n = 1200147.07 + 308807.95 * phi + 3745.25 * lambda * lambda + 76.63 * phi * phi - 194.56 * lambda * lambda * phi + 119.79 * phi ** 3;
    return [e, n];
  }

  /** [lat, lon] for LV95 E/N in metres. */
  function fromLv95(e, n) {
    const y = (e - 2600000) / 1000000;
    const x = (n - 1200000) / 1000000;
    const lambda = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y ** 3;
    const phi = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.014 * x ** 3;
    return [(phi * 100) / 36, (lambda * 100) / 36];
  }

  const inSwitzerland = (lat, lon) => lat >= 45.4 && lat <= 48.3 && lon >= 5.5 && lon <= 11.0;

  /* ---------- UTM (Krüger series, WGS84) ---------- */

  const A_ = 6378137;
  const F_ = 1 / 298.257223563;
  const K0 = 0.9996;
  const N_ = F_ / (2 - F_);
  const AA = (A_ / (1 + N_)) * (1 + (N_ ** 2) / 4 + (N_ ** 4) / 64);
  const ALPHA = [N_ / 2 - (2 / 3) * N_ ** 2 + (5 / 16) * N_ ** 3, (13 / 48) * N_ ** 2 - (3 / 5) * N_ ** 3, (61 / 240) * N_ ** 3];
  const E2 = (2 * Math.sqrt(N_)) / (1 + N_);

  /** UTM zone of a place, with the exceptions for south-west Norway and Svalbard. */
  function utmZone(lat, lon) {
    let zone = Math.floor((lon + 180) / 6) + 1;
    if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) zone = 32;
    if (lat >= 72 && lat < 84) {
      if (lon >= 0 && lon < 9) zone = 31; else if (lon >= 9 && lon < 21) zone = 33; else if (lon >= 21 && lon < 33) zone = 35; else if (lon >= 33 && lon < 42) zone = 37;
    }
    return Math.min(60, Math.max(1, zone));
  }

  /** { zone, band, easting, northing } (m) for lat/lon in degrees; null outside 80° S – 84° N. */
  function toUtm(lat, lon) {
    if (!(lat >= -80 && lat <= 84)) return null;
    const zone = utmZone(lat, lon);
    const phi = lat * RAD;
    const dl = (lon - (zone * 6 - 183)) * RAD;
    const s = Math.sin(phi);
    const t = Math.sinh(Math.atanh(s) - E2 * Math.atanh(E2 * s));
    const xi = Math.atan2(t, Math.cos(dl));
    const eta = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t));
    let x = eta;
    let y = xi;
    ALPHA.forEach((a, j) => {
      x += a * Math.cos(2 * (j + 1) * xi) * Math.sinh(2 * (j + 1) * eta);
      y += a * Math.sin(2 * (j + 1) * xi) * Math.cosh(2 * (j + 1) * eta);
    });
    return { zone, band: mgrs.getLetterDesignator(lat), easting: 500000 + K0 * AA * x, northing: (lat < 0 ? 10000000 : 0) + K0 * AA * y };
  }

  /* ---------- Formatting ---------- */

  /** 2600000.4 → «2'600'000» (Swiss thousands separator, as on map.geo.admin.ch). */
  const swiss = (v) => Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  function dms(v, pos, neg) {
    const a = Math.abs(v);
    let d = Math.floor(a);
    let m = Math.floor((a - d) * 60);
    let sec = Math.round(((a - d) * 60 - m) * 60 * 100) / 100;
    if (sec >= 60) { sec = 0; m += 1; }
    if (m >= 60) { m = 0; d += 1; }
    return `${d}° ${m}′ ${sec.toFixed(2)}″ ${v >= 0 ? pos : neg}`;
  }

  /**
   * Every system for a place: [{ key, label, text }]; LV95 and LV03 only in and around Switzerland.
   */
  function format(lat, lon) {
    const out = [];
    if (inSwitzerland(lat, lon)) {
      const [e, n] = toLv95(lat, lon);
      out.push({ key: 'lv95', label: 'CH1903+ / LV95', text: `${swiss(e)}, ${swiss(n)}` });
      out.push({ key: 'lv03', label: 'CH1903 / LV03', text: `${swiss(e - 2000000)}, ${swiss(n - 1000000)}` });
    }
    out.push({ key: 'wgs84', label: 'WGS 84 (Breite, Länge)', text: `${lat.toFixed(5)}, ${lon.toFixed(5)}` });
    out.push({ key: 'dms', label: 'WGS 84 (Grad, Minuten, Sekunden)', text: `${dms(lat, 'N', 'S')}, ${dms(lon, 'E', 'W')}` });
    const u = toUtm(lat, lon);
    if (u) out.push({ key: 'utm', label: 'UTM', text: `${u.zone}${u.band} ${Math.round(u.easting)} ${Math.round(u.northing)}` });
    if (u) {
      const m = mgrs.forward([lon, lat], 5);
      out.push({ key: 'mgrs', label: 'MGRS', text: m.replace(/^(\d{1,2}[A-Z])([A-Z]{2})(\d{5})(\d{5})$/, '$1 $2 $3 $4') });
    }
    return out;
  }

  /* ---------- Parsing ---------- */

  const CARD = '[NSEWO]';
  // One axis: an optional cardinal, degrees, optional minutes and seconds (marked or separated by spaces).
  const AXIS = new RegExp(`^(${CARD})?\\s*(\\d{1,3}(?:\\.\\d+)?)\\s*(?:°\\s*)?(?:(\\d{1,2}(?:\\.\\d+)?)\\s*['′’]?\\s*)?(?:(\\d{1,2}(?:\\.\\d+)?)\\s*(?:["″]|''|′′)?\\s*)?(${CARD})?$`, 'i');
  const MGRS = /^(\d{1,2}[C-HJ-NP-X])\s*([A-HJ-NP-Z]{2})\s*(\d{1,5})\s*(\d{1,5})$/i;

  function axis(text) {
    const m = AXIS.exec(text.trim());
    if (!m || (m[1] && m[5])) return null;
    const v = Number(m[2]) + (m[3] ? Number(m[3]) / 60 : 0) + (m[4] ? Number(m[4]) / 3600 : 0);
    const card = (m[1] || m[5] || '').toUpperCase();
    if ((m[3] && Number(m[3]) >= 60) || (m[4] && Number(m[4]) >= 60)) return null;
    return { v: card === 'S' || card === 'W' ? -v : v, card, marked: Boolean(m[3] || card || /°/.test(text)) };
  }

  /**
   * A typed position: { lat, lon, kind } (kind: 'lv95', 'lv03', 'wgs84', 'mgrs') or null. Swiss and decimal pairs
   * only within Switzerland (where the order can be guessed); MGRS anywhere.
   */
  function parse(text) {
    const raw = String(text || '').trim();
    if (!raw || raw.length > 80) return null;
    const g = MGRS.exec(raw.replace(/\s+/g, ' '));
    if (g && g[3].length === g[4].length) {
      try {
        const [lon, lat] = mgrs.toPoint(`${g[1]}${g[2]}${g[3]}${g[4]}`.toUpperCase());
        if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon, kind: 'mgrs' };
      } catch { /* not MGRS */ }
    }
    // Thousands separators between digits go: 2'600'000, or 2 600 000 when a space cannot be the gap between the
    // two numbers («683'000 248'000» keeps its space).
    const apostrophes = raw.replace(/(\d)['’](?=\d{3}(?!\d))/g, '$1');
    const text2 = (apostrophes.match(/-?\d+(?:\.\d+)?/g) || []).length === 2 ? apostrophes : raw.replace(/(\d)['’ ](?=\d{3}(?!\d))/g, '$1');
    // Two plain numbers: Swiss metres (LV95, LV03) or decimal degrees.
    const nums = text2.match(/-?\d+(?:\.\d+)?/g);
    if (nums?.length === 2 && /^[\s\d.,;/-]+$/.test(text2)) {
      let [a, b] = nums.map(Number);
      if (a > 1e6 && b > 1e6) {
        if (b > a) [a, b] = [b, a]; // E (2.4–2.9 million) is larger than N (1.0–1.3 million)
        const [lat, lon] = fromLv95(a, b);
        return inSwitzerland(lat, lon) ? { lat, lon, kind: 'lv95' } : null;
      }
      if (a > 1000 && b > 1000) {
        if (b > a) [a, b] = [b, a];
        const [lat, lon] = fromLv95(a + 2000000, b + 1000000);
        return inSwitzerland(lat, lon) ? { lat, lon, kind: 'lv03' } : null;
      }
      if (Math.abs(a) <= 90 && Math.abs(b) <= 180) {
        if (!inSwitzerland(a, b) && inSwitzerland(b, a)) [a, b] = [b, a]; // «8.4, 46.6»: longitude first
        return inSwitzerland(a, b) ? { lat: a, lon: b, kind: 'wgs84' } : null;
      }
      return null;
    }
    // Degrees with minutes, seconds or cardinals: two axes, split at a comma, slash or semicolon, after the
    // first cardinal, or between two groups of numbers.
    let parts = text2.split(/\s*[,;/]\s*/);
    if (parts.length !== 2) {
      const prefixed = new RegExp(`^${CARD}`, 'i').test(text2);
      const m = prefixed ? new RegExp(`^(${CARD}.*?)\\s+(${CARD}.+)$`, 'i').exec(text2) : new RegExp(`^(.*?${CARD})\\s+(.+)$`, 'i').exec(text2);
      parts = m ? [m[1], m[2]] : [];
    }
    if (parts.length !== 2) return null;
    const p = axis(parts[0]);
    const q = axis(parts[1]);
    if (!p || !q || !p.marked) return null;
    let lat = p.v;
    let lon = q.v;
    if (/[EWO]/.test(p.card) || /[NS]/.test(q.card)) [lat, lon] = [q.v, p.v];
    return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon, kind: 'wgs84' } : null;
  }

  return { toLv95, fromLv95, toUtm, format, parse, inSwitzerland };
}));
