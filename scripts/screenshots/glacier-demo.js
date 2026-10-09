'use strict';
// The demo glacier for the screenshots (seed-gletscher.js, tiles.js, demo-server.js): a valley glacier flowing
// north, its outlines in three inventories (1850, 1973, 2016) and today's ice and proglacial lake for the map.
// Made up: the place is in the Alps, the glacier and its numbers are not real.

const NAME = 'Demo-Gletscher';
const HEAD = 46.566; // top of the ice
const LON0 = 8.4;
const ENDS = { 1850: 46.613, 1973: 46.606, 2016: 46.6, heute: 46.5962 };
const TIP = 0.0012; // how far the rounded tip reaches beyond the end (° latitude)

/** Outline ring [[lon, lat]…] of the glacier ending at `endLat`. */
function outline(endLat) {
  const left = [];
  const right = [];
  const n = 24;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const lat = HEAD + t * (endLat - HEAD);
    const hw = 0.0115 - 0.0062 * t; // half width (° longitude), narrowing towards the tongue
    const c = LON0 + 0.0016 * Math.sin(t * Math.PI);
    left.push([c - hw, lat]);
    right.push([c + hw, lat]);
  }
  const hw = 0.0115 - 0.0062;
  const tip = [];
  for (let k = 1; k < 8; k++) {
    const a = Math.PI - (k / 8) * Math.PI; // from the left edge round to the right
    tip.push([LON0 + hw * Math.cos(a), endLat + TIP * Math.sin(a)]);
  }
  const ring = [...left, ...tip, ...right.reverse()];
  ring.push(ring[0]);
  return ring.map(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6]);
}

function insideRing(ring, lat, lon) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const TODAY = outline(ENDS.heute);
const iceToday = (lat, lon) => insideRing(TODAY, lat, lon);
// The lake left by the tongue between the 2016 and today's ends.
const LAKE = { lat: 46.5986, lon: 8.4003, rLat: 0.0011, rLon: 0.0034 };
const inLake = (lat, lon) => ((lat - LAKE.lat) / LAKE.rLat) ** 2 + ((lon - LAKE.lon) / LAKE.rLon) ** 2 < 1;

/** Terrain (m a.s.l.): a valley rising to the south, steep walls east and west. */
function elevation(lat, lon) {
  const floor = 1700 + (46.63 - lat) * 18000;
  const d = Math.abs(lon - (LON0 + 0.0016 * Math.sin(Math.max(0, Math.min(1, (lat - HEAD) / (ENDS[1850] - HEAD))) * Math.PI)));
  return Math.round(floor + 1300 * Math.min(1, (Math.max(0, d - 0.006) / 0.02)) ** 1.3);
}

/** GeoJSON files of the three inventories: 1850 and 2016 with the year in the file name, 1973 as a property. */
function inventories() {
  const fc = (props, ring) => ({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [ring] } }] });
  return {
    'sgi_1850.geojson': fc({ name: NAME }, outline(ENDS[1850])),
    'sgi_1973.geojson': fc({ name: NAME, year: 1973 }, outline(ENDS[1973])),
    'sgi_2016.geojson': fc({ name: NAME, 'sgi-id': 'X00-00', year_acq: '2016-09-12' }, outline(ENDS[2016])),
  };
}

module.exports = { NAME, ENDS, outline, iceToday, inLake, elevation, inventories, LAKE };
