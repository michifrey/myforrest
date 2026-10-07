'use strict';

/**
 * Swiss coordinates LV95 (CH1903+, EPSG:2056) from and to WGS84, using
 * swisstopo's approximate formulas ("Näherungsformeln für die Transformation
 * zwischen Schweizer Projektionskoordinaten und WGS84"). Accuracy about 1 m
 * within Switzerland, which matches GPS positions of photos.
 */

/** [E, N] in metres for latitude/longitude in degrees. */
function wgs84ToLv95(lat, lon) {
  const phi = (lat * 3600 - 169028.66) / 10000;
  const lambda = (lon * 3600 - 26782.5) / 10000;
  const e = 2600072.37
    + 211455.93 * lambda
    - 10938.51 * lambda * phi
    - 0.36 * lambda * phi * phi
    - 44.54 * lambda ** 3;
  const n = 1200147.07
    + 308807.95 * phi
    + 3745.25 * lambda * lambda
    + 76.63 * phi * phi
    - 194.56 * lambda * lambda * phi
    + 119.79 * phi ** 3;
  return [Math.round(e * 100) / 100, Math.round(n * 100) / 100];
}

/** [lat, lon] in degrees for LV95 E/N in metres. */
function lv95ToWgs84(e, n) {
  const y = (e - 2600000) / 1000000;
  const x = (n - 1200000) / 1000000;
  const lambda = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y ** 3;
  const phi = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.014 * x ** 3;
  return [(phi * 100) / 36, (lambda * 100) / 36];
}

/** Rough check whether a WGS84 position lies in the area LV95 is defined for (Switzerland and Liechtenstein, with margin). */
const inLv95Area = (lat, lon) => lat >= 45.4 && lat <= 48.3 && lon >= 5.5 && lon <= 11.0;

module.exports = { wgs84ToLv95, lv95ToWgs84, inLv95Area };
