'use strict';

// Coordinates as map.geo.admin.ch shows and reads them (public/coords.js); the UTM values are from pyproj (EPSG:326xx).

const test = require('node:test');
const assert = require('node:assert/strict');
const Coords = require('../public/coords.js');

test('UTM with the Krüger series matches pyproj to the centimetre, zone exceptions included', () => {
  for (const [lat, lon, zone, band, e, n] of [
    [47.3779, 8.5403, 32, 'T', 465298.26, 5247262.6],
    [46.9466, 7.4446, 32, 'T', 381633.02, 5200404.13],
    [-33.8568, 151.2153, 56, 'H', 334900.57, 6252288.75],
    [60.39, 5.32, 32, 'V', 297230.22, 6700510.18], // Bergen: zone 32, not 31
  ]) {
    const u = Coords.toUtm(lat, lon);
    assert.deepEqual([u.zone, u.band], [zone, band]);
    assert.ok(Math.abs(u.easting - e) < 0.02 && Math.abs(u.northing - n) < 0.02, `${lat}, ${lon}: ${u.easting} ${u.northing}`);
  }
  assert.equal(Coords.toUtm(85, 0), null);
});

test('one place in every system, LV95 and LV03 only in Switzerland', () => {
  const f = Object.fromEntries(Coords.format(47.3779, 8.5403).map((x) => [x.key, x.text]));
  assert.deepEqual(f, {
    lv95: "2'683'197, 1'248'035", lv03: "683'197, 248'035", wgs84: '47.37790, 8.54030',
    dms: '47° 22′ 40.44″ N, 8° 32′ 25.08″ E', utm: '32T 465298 5247263', mgrs: '32T MT 65298 47262',
  });
  assert.deepEqual(Coords.format(-33.8568, 151.2153).map((x) => x.key), ['wgs84', 'dms', 'utm', 'mgrs']);
});

test('typed positions in any system: decimal degrees, degrees with minutes and seconds, LV95, LV03, MGRS', () => {
  const near = (r, lat, lon, kind, tol = 0.0005) => {
    assert.ok(r, 'parsed');
    assert.equal(r.kind, kind);
    assert.ok(Math.abs(r.lat - lat) < tol && Math.abs(r.lon - lon) < tol, `${r.lat}, ${r.lon}`);
  };
  near(Coords.parse('47.3779, 8.5403'), 47.3779, 8.5403, 'wgs84');
  near(Coords.parse('8.5403 47.3779'), 47.3779, 8.5403, 'wgs84', 1e-9); // longitude first
  near(Coords.parse("2'683'197 1'248'035"), 47.3779, 8.5403, 'lv95');
  near(Coords.parse('1248035, 2683197'), 47.3779, 8.5403, 'lv95'); // north first
  near(Coords.parse("683'197 / 248'035"), 47.3779, 8.5403, 'lv03');
  near(Coords.parse("683'197 248'035"), 47.3779, 8.5403, 'lv03');
  near(Coords.parse('2 683 197 1 248 035'), 47.3779, 8.5403, 'lv95');
  near(Coords.parse('47°22′40.44″N 8°32′25.08″E'), 47.3779, 8.5403, 'wgs84');
  near(Coords.parse('N 47° 22.674 E 8° 32.418'), 47.3779, 8.5403, 'wgs84');
  near(Coords.parse('47 22 40 N, 8 32 25 E'), 47.3778, 8.5403, 'wgs84');
  near(Coords.parse('32T MT 65298 47262'), 47.3779, 8.5403, 'mgrs');
  near(Coords.parse('32TMT6529847262'), 47.3779, 8.5403, 'mgrs');
  for (const t of ['Zürich', '46.6, 8.4, 3', '0 0', '', '47° 70′ N, 8° E', '3000 Bern']) assert.equal(Coords.parse(t), null, t);
});
