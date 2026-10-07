/*
 * Sun position, sunrise/sunset and clear-sky irradiance.
 * Runs in the browser (window.Sun) and in Node (module.exports) for tests.
 *
 * Position: NOAA's low-precision solar coordinates (≈0.01° until 2050) with
 * atmospheric refraction. Irradiance: clear-sky model with Kasten–Young air
 * mass and Meinel's beam attenuation, plus an isotropic diffuse part; on a
 * slope the beam uses the angle of incidence. No clouds, no terrain horizon.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Sun = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const RAD = Math.PI / 180;
  const DEG = 180 / Math.PI;
  const mod = (a, n) => ((a % n) + n) % n;

  /** Sun altitude and azimuth (° from north, clockwise) for a time (ms or Date) and place. */
  function position(time, lat, lon) {
    const n = +time / 86400000 + 2440587.5 - 2451545.0;
    const L = mod(280.460 + 0.9856474 * n, 360);
    const g = mod(357.528 + 0.9856003 * n, 360) * RAD;
    const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
    const eps = (23.439 - 0.0000004 * n) * RAD;
    const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
    const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
    const gmst = mod(18.697374558 + 24.06570982441908 * n, 24) * 15;
    const H = (gmst + lon) * RAD - ra;
    const phi = lat * RAD;
    let alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H)) * DEG;
    const az = mod(Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(H)) * DEG, 360);
    if (alt > -1.5) alt += 1.02 / Math.tan((alt + 10.3 / (alt + 5.11)) * RAD) / 60; // refraction (Sæmundsson)
    return { altitude: alt, azimuth: az, declination: dec * DEG };
  }

  /**
   * Sunrise, sunset and solar noon within the 24 h starting at `dayStart`
   * (ms, e.g. local midnight). Rise/set are when the sun's upper limb
   * touches the horizon (−0.833° incl. refraction, already in `position`
   * up to the disc radius: −0.27°). Null in polar day or night.
   */
  function times(dayStart, lat, lon) {
    const step = 60000;
    const alt = (t) => position(t, lat, lon).altitude + 0.27;
    let rise = null; let set = null; let noon = dayStart; let max = -90;
    let prev = alt(dayStart);
    for (let t = dayStart + step; t <= dayStart + 86400000; t += step) {
      const a = alt(t);
      if (prev < 0 && a >= 0 && rise === null) rise = t - step * (a / (a - prev));
      if (prev >= 0 && a < 0) set = t - step * (a / (a - prev));
      if (a - 0.27 > max) { max = a - 0.27; noon = t; }
      prev = a;
    }
    return { sunrise: rise, sunset: set, solarNoon: noon, maxAltitude: max };
  }

  /** Clear-sky irradiance (W/m²) for a sun altitude, day of year and site elevation (m). */
  function clearSky(altitude, dayOfYear, elevation = 0) {
    if (altitude <= 0) return { dni: 0, dhi: 0, ghi: 0 };
    const zen = 90 - altitude;
    const i0 = 1361 * (1 + 0.033 * Math.cos((2 * Math.PI * dayOfYear) / 365));
    const am = (1 / (Math.cos(zen * RAD) + 0.50572 * (96.07995 - zen) ** -1.6364)) * Math.exp(-(elevation || 0) / 8434);
    const dni = i0 * 0.7 ** (am ** 0.678);
    const dhi = 0.1 * dni;
    return { dni, dhi, ghi: dni * Math.sin(altitude * RAD) + dhi };
  }

  /** Irradiance on a slope (tilt °, aspect ° from north) for given sun and clear-sky values. */
  function onSlope(sun, irr, slope = 0, aspect = 180) {
    if (sun.altitude <= 0) return 0;
    const beta = (slope || 0) * RAD;
    const zen = (90 - sun.altitude) * RAD;
    const cosInc = Math.cos(zen) * Math.cos(beta) +
      Math.sin(zen) * Math.sin(beta) * Math.cos((sun.azimuth - (aspect ?? 180)) * RAD);
    return irr.dni * Math.max(0, cosInc) + irr.dhi * (1 + Math.cos(beta)) / 2;
  }

  const dayOfYear = (t) => {
    const d = new Date(t);
    return Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) + 1;
  };

  /**
   * Course of a day in `stepMin` steps from `dayStart`: sun position and
   * clear-sky irradiance on flat ground and on the given slope, plus daily
   * totals in kWh/m².
   */
  function day(dayStart, lat, lon, { elevation = 0, slope = 0, aspect = 180, stepMin = 10 } = {}) {
    const doy = dayOfYear(dayStart + 43200000);
    const samples = [];
    let flat = 0; let tilted = 0;
    for (let m = 0; m <= 1440; m += stepMin) {
      const t = dayStart + m * 60000;
      const sun = position(t, lat, lon);
      const irr = clearSky(sun.altitude, doy, elevation);
      const s = { t, minute: m, altitude: sun.altitude, azimuth: sun.azimuth, ghi: irr.ghi, slope: onSlope(sun, irr, slope, aspect) };
      samples.push(s);
      if (m < 1440) { flat += s.ghi; tilted += s.slope; }
    }
    const kwh = (sum) => Math.round((sum * stepMin) / 60 / 10) / 100; // W·h → kWh, 2 decimals
    return { samples, totalFlat: kwh(flat), totalSlope: kwh(tilted), ...times(dayStart, lat, lon) };
  }

  /** Destination point (lat, lon) at `distance` metres and `bearing` ° from a start point. */
  function destination(lat, lon, bearing, distance) {
    const R = 6371000;
    const d = distance / R;
    const b = bearing * RAD;
    const p1 = lat * RAD;
    const l1 = lon * RAD;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
    const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return [p2 * DEG, l2 * DEG];
  }

  const COMPASS = ['N', 'NNO', 'NO', 'ONO', 'O', 'OSO', 'SO', 'SSO', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const compass = (az) => COMPASS[Math.round(mod(az, 360) / 22.5) % 16];

  return { position, times, clearSky, onSlope, day, destination, compass, dayOfYear };
}));
