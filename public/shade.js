/*
 * Light and shadow on the map for a sun position: which ground lies in the
 * shadow of the terrain (hills, ridges, mountains) and how steeply the sun
 * falls onto each slope, plus night and twilight.
 * Runs in the browser (window.Shade) and in Node (module.exports) for tests.
 *
 * Elevations come as a grid in Web Mercator pixels (e.g. Terrarium tiles,
 * decoded with `terrarium`). For each cell of the area asked for, a ray
 * walks towards the sun one cell at a time; the cell lies in the terrain's
 * shadow as soon as the ground along the ray rises above the ray (gradually,
 * over the width of the sun's disc: the half shadow). Beyond the
 * fine grid the ray goes on through an optional coarse grid of the wider
 * surroundings (`far`), so distant ridges and mountains shade too when the
 * sun is low. The ray stops when it is higher than the highest point of the
 * grids or leaves them. Distant ground sinks with the Earth's curvature
 * (with standard refraction). Slopes facing away from the sun lie in their
 * own shadow.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Shade = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const RAD = Math.PI / 180;
  const EARTH_R = 6371000;
  const REFRACTION_K = 0.13;
  const SUN_HALF_TAN = Math.tan(0.267 * RAD); // the sun's radius as seen from Earth
  /** How much the ground at distance d (m) sinks below the tangent plane, as seen through the air. */
  const drop = (d) => ((d * d) / (2 * EARTH_R)) * (1 - REFRACTION_K);
  const maxOf = (a) => { let m = -Infinity; for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i]; return m; };

  /** Elevation in metres from a Terrarium-encoded pixel. */
  const terrarium = (r, g, b) => r * 256 + g + b / 256 - 32768;

  /** Metres per pixel of a Web Mercator grid at zoom `z` (256-px tiles) and latitude. */
  const metresPerPixel = (lat, z) => (40075016.686 * Math.cos(lat * RAD)) / (256 * 2 ** z);

  /**
   * Light per cell, for the cells x0 ≤ x < x0 + w, y0 ≤ y < y0 + h of the grid
   * (row-major `elev`, width `gw`, height `gh`, north up, `cellM` metres):
   * the beam on the slope relative to flat ground in full sun (1 = as flat,
   * > 1 facing the sun, < 1 turned away, 0 = in shadow or facing away). At the
   * edge of a shadow it falls off smoothly with the part of the sun's disc
   * (0.53°) still above the terrain, widened by one cell so the edges do not
   * show the grid. All 0 while the sun is down.
   * `far` (optional): `{ elev, gw, gh, scale, ox, oy }`, a coarser grid around
   * it, `scale` fine cells per coarse cell, the fine grid's corner at coarse
   * cell coordinates (ox, oy).
   */
  function light({ elev, gw, gh, cellM, altitude, azimuth, x0 = 0, y0 = 0, w = gw, h = gh, far = null }) {
    const out = new Float32Array(w * h);
    if (altitude <= 0) return out;
    const tanAlt = Math.tan(altitude * RAD);
    const sinAlt = Math.sin(altitude * RAD);
    const cosAlt = Math.cos(altitude * RAD);
    const sx = Math.sin(azimuth * RAD); // towards the sun: east …
    const sy = -Math.cos(azimuth * RAD); // … and south (rows grow southwards)
    const top = maxOf(elev);
    const farTop = far ? maxOf(far.elev) : -Infinity;
    const rise = cellM * tanAlt; // the ray climbs this much per cell
    const farCellM = far ? cellM * far.scale : 0;
    /** Ground between the cell centres (bilinear), so shadows follow the terrain instead of the grid. */
    const bilinear = (e, ew, eh, qx, qy) => {
      const fx = Math.max(0, Math.min(ew - 1.001, qx - 0.5)); const fy = Math.max(0, Math.min(eh - 1.001, qy - 0.5));
      const i = fx | 0; const j = fy | 0; const u = fx - i; const v = fy - j; const r = j * ew + i;
      return (e[r] * (1 - u) + e[r + 1] * u) * (1 - v) + (e[r + ew] * (1 - u) + e[r + ew + 1] * u) * v;
    };
    const at = (x, y) => elev[Math.min(gh - 1, Math.max(0, y)) * gw + Math.min(gw - 1, Math.max(0, x))];
    // Half the height over which the ground at distance d hides the sun's disc gradually: sun radius plus half a cell.
    const half = (d, cell) => d * SUN_HALF_TAN + cell * tanAlt * 0.5;

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
        let sun = 1; // part of the sun's disc above the terrain
        const see = (ground, ray, hw) => {
          const f = 0.5 - (ground - ray) / (2 * hw);
          if (f < sun) sun = f < 0 ? 0 : f;
        };
        let px = x + 0.5; let py = y + 0.5; let ray = z; let steps = 0;
        let inside = true;
        for (;;) {
          px += sx; py += sy; ray += rise; steps++;
          if (px < 0 || py < 0 || px >= gw || py >= gh) { inside = false; break; }
          const hw = half(steps * cellM, cellM);
          if (ray - hw >= top) {
            if (!far || ray >= farTop) break;
            // Nothing here reaches the ray any more: jump to the edge of the fine grid.
            const k = Math.ceil(Math.min(sx > 0 ? (gw - px) / sx : sx < 0 ? -px / sx : Infinity, sy > 0 ? (gh - py) / sy : sy < 0 ? -py / sy : Infinity)) - 1;
            if (k > 0) { px += k * sx; py += k * sy; ray += k * rise; steps += k; }
            continue;
          }
          see(bilinear(elev, gw, gh, px, py) - drop(steps * cellM), ray, hw);
          if (sun === 0) break;
        }
        if (sun > 0 && !inside && far && ray < farTop) {
          // On through the wider surroundings, a coarse cell at a time.
          let qx = far.ox + px / far.scale; let qy = far.oy + py / far.scale;
          let dist = steps * cellM;
          for (;;) {
            qx += sx; qy += sy; dist += farCellM; ray += rise * far.scale;
            if (qx < 0 || qy < 0 || qx >= far.gw || qy >= far.gh) break;
            const hw = half(dist, farCellM);
            if (ray - hw >= farTop) break;
            see(bilinear(far.elev, far.gw, far.gh, qx, qy) - drop(dist), ray, hw);
            if (sun === 0) break;
          }
        }
        out[j * w + i] = sun * cosInc / sinAlt;
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
