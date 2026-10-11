/*
 * Light and shadow on the map for a sun position: which ground lies in the
 * shadow of the terrain (hills, ridges, mountains) and how steeply the sun
 * falls onto each slope, plus night and twilight.
 * Runs in the browser (window.Shade) and in Node (module.exports) for tests.
 *
 * Elevations come as a grid in Web Mercator pixels (e.g. Terrarium tiles,
 * decoded with `terrarium`). For each cell of the area asked for, a ray
 * walks towards the sun one cell at a time; the cell lies in the terrain's
 * shadow as soon as the ground along the ray rises above the ray. The ray
 * stops when it is higher than the highest point of the grid or leaves the
 * grid, so terrain outside the grid casts no shadow. Slopes facing away from
 * the sun lie in their own shadow. Earth curvature is ignored (a few metres
 * over the few kilometres of a grid).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Shade = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const RAD = Math.PI / 180;

  /** Elevation in metres from a Terrarium-encoded pixel. */
  const terrarium = (r, g, b) => r * 256 + g + b / 256 - 32768;

  /** Metres per pixel of a Web Mercator grid at zoom `z` (256-px tiles) and latitude. */
  const metresPerPixel = (lat, z) => (40075016.686 * Math.cos(lat * RAD)) / (256 * 2 ** z);

  /**
   * Light per cell, for the cells x0 ≤ x < x0 + w, y0 ≤ y < y0 + h of the grid
   * (row-major `elev`, width `gw`, height `gh`, north up, `cellM` metres):
   * 0 = in shadow (cast by the terrain or the slope faces away),
   * otherwise the beam on the slope relative to flat ground (1 = as flat,
   * > 1 facing the sun, < 1 turned away). All 0 while the sun is down.
   */
  function light({ elev, gw, gh, cellM, altitude, azimuth, x0 = 0, y0 = 0, w = gw, h = gh }) {
    const out = new Float32Array(w * h);
    if (altitude <= 0) return out;
    const tanAlt = Math.tan(altitude * RAD);
    const sinAlt = Math.sin(altitude * RAD);
    const cosAlt = Math.cos(altitude * RAD);
    const sx = Math.sin(azimuth * RAD); // towards the sun: east …
    const sy = -Math.cos(azimuth * RAD); // … and south (rows grow southwards)
    let top = -Infinity;
    for (let i = 0; i < elev.length; i++) if (elev[i] > top) top = elev[i];
    const rise = cellM * tanAlt; // the ray climbs this much per cell
    const at = (x, y) => elev[Math.min(gh - 1, Math.max(0, y)) * gw + Math.min(gw - 1, Math.max(0, x))];

    for (let j = 0; j < h; j++) {
      const y = y0 + j;
      for (let i = 0; i < w; i++) {
        const x = x0 + i;
        const z = elev[y * gw + x];
        // Slope from the neighbours (Horn would be smoother; central differences are enough here).
        const east = (at(x + 1, y) - at(x - 1, y)) / (2 * cellM);
        const north = (at(x, y - 1) - at(x, y + 1)) / (2 * cellM);
        // Cosine of the angle between the sun and the surface normal (−east, −north, 1)/n.
        const n = Math.sqrt(east * east + north * north + 1);
        const cosInc = (-east * sx * cosAlt + north * sy * cosAlt + sinAlt) / n;
        if (cosInc <= 0) continue; // the slope turns away from the sun
        let shadow = false;
        let px = x + 0.5; let py = y + 0.5; let ray = z;
        for (;;) {
          px += sx; py += sy; ray += rise;
          if (ray >= top || px < 0 || py < 0 || px >= gw || py >= gh) break;
          if (elev[(py | 0) * gw + (px | 0)] > ray) { shadow = true; break; }
        }
        if (!shadow) out[j * w + i] = cosInc / sinAlt;
      }
    }
    return out;
  }

  /**
   * Darkening for the map (0 = clear … 1 = black) from the sun's altitude at
   * a place: none by day, growing through civil and nautical twilight, full
   * night below −12°.
   */
  function night(altitude) {
    if (altitude >= 0) return 0;
    if (altitude <= -12) return 1;
    const x = -altitude / 12;
    return x * x * (3 - 2 * x);
  }

  return { terrarium, metresPerPixel, light, night };
}));
