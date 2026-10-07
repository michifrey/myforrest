'use strict';

/*
 * WGS84 ↔ UTM (transverse Mercator, Snyder's series; sub-metre accuracy
 * within a zone). Sentinel-2 tiles are delivered in UTM (EPSG:326xx/327xx).
 */

const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const EP2 = E2 / (1 - E2);
const K0 = 0.9996;
const RAD = Math.PI / 180;

const meridianArc = (phi) => A * (
  (1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256) * phi
  - ((3 * E2) / 8 + (3 * E2 ** 2) / 32 + (45 * E2 ** 3) / 1024) * Math.sin(2 * phi)
  + ((15 * E2 ** 2) / 256 + (45 * E2 ** 3) / 1024) * Math.sin(4 * phi)
  - ((35 * E2 ** 3) / 3072) * Math.sin(6 * phi));

const zoneOf = (lon) => Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));

/** Projects lat/lon (°) into UTM `zone` (default: the zone of `lon`). Returns { x, y, zone, south }. */
function utmFromLatLon(lat, lon, zone = zoneOf(lon), south = lat < 0) {
  const phi = lat * RAD;
  const lam0 = ((zone - 1) * 6 - 180 + 3) * RAD;
  const sin = Math.sin(phi);
  const cos = Math.cos(phi);
  const tan = Math.tan(phi);
  const N = A / Math.sqrt(1 - E2 * sin * sin);
  const T = tan * tan;
  const C = EP2 * cos * cos;
  const Aa = cos * (lon * RAD - lam0);
  const M = meridianArc(phi);
  const x = K0 * N * (Aa + ((1 - T + C) * Aa ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * EP2) * Aa ** 5) / 120) + 500000;
  let y = K0 * (M + N * tan * (Aa ** 2 / 2 + ((5 - T + 9 * C + 4 * C * C) * Aa ** 4) / 24
    + ((61 - 58 * T + T * T + 600 * C - 330 * EP2) * Aa ** 6) / 720));
  if (south) y += 10000000;
  return { x, y, zone, south };
}

/** Inverse of utmFromLatLon. */
function latLonFromUtm(x, y, zone, south = false) {
  const M = (south ? y - 10000000 : y) / K0;
  const mu = M / (A * (1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const phi1 = mu + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu)
    + ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu)
    + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) + ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const sin = Math.sin(phi1);
  const cos = Math.cos(phi1);
  const tan = Math.tan(phi1);
  const C1 = EP2 * cos * cos;
  const T1 = tan * tan;
  const N1 = A / Math.sqrt(1 - E2 * sin * sin);
  const R1 = (A * (1 - E2)) / (1 - E2 * sin * sin) ** 1.5;
  const D = (x - 500000) / (N1 * K0);
  const lat = phi1 - ((N1 * tan) / R1) * (D * D / 2 - ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D ** 4) / 24
    + ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D ** 6) / 720);
  const lon = (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D ** 5) / 120) / cos;
  return { lat: lat / RAD, lon: ((zone - 1) * 6 - 180 + 3) + lon / RAD };
}

module.exports = { utmFromLatLon, latLonFromUtm, zoneOf };
