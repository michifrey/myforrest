/*
 * Links in the format of map.geo.admin.ch, so maps can be passed back and forth: the `layers` parameter
 * (`id[@key=value…][,visible][,opacity]`, separated by `;`, `,f` for a hidden layer, external services as
 * `WMS|url|layer`, `WMTS|url|layer`, `KML|url`, `GPX|url`), `bgLayer`, `center` in LV95 and the zoom `z` of the LV95
 * pyramid. Runs in the browser (window.GeoadminLink) and in Node.
 *
 * Syntax after the web-mapviewer of geo.admin.ch (router/storeSync/layersParamParser.js, BSD-3) and its ADR
 * «URL param structure»; the zoom after its LV95 resolutions (650 … 0.1 m per pixel for z 0 … 13).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./coords.js'));
  else root.GeoadminLink = factory(root.Coords);
}(typeof self !== 'undefined' ? self : this, (Coords) => {
  'use strict';

  const BASE = 'https://map.geo.admin.ch/#/map';
  const EXTERNAL = ['WMS', 'WMTS', 'KML', 'GPX', 'GEOJSON', 'COG'];
  const LV95_RESOLUTIONS = [650, 500, 250, 100, 50, 20, 10, 5, 2.5, 2, 1, 0.5, 0.25, 0.1];
  const MERCATOR_RES_Z0 = 156543.03392804097; // m per pixel at zoom 0 on the equator (256-px tiles)

  // The separators inside a layer: percent-encoded once more than the rest of the address.
  const encodePart = (s) => String(s).replace(/,/g, '%2C').replace(/;/g, '%3B').replace(/@/g, '%40').replace(/\|/g, '%7C');
  const decodePart = (s) => String(s).replace(/%2C/gi, ',').replace(/%3B/gi, ';').replace(/%40/gi, '@').replace(/%7C/gi, '|');
  const isNumber = (v) => v !== '' && v !== undefined && v !== null && Number.isFinite(Number(v));

  /**
   * The `layers` parameter → [{ id, visible, opacity, params, external }]: `external` { type, url, name } for
   * services outside geo.admin.ch (name null for KML and GPX), `params` the `@key=value` attributes (year as a
   * number, `@year=none` as null).
   */
  function parseLayers(value) {
    if (!value) return [];
    return String(value).split(';').filter(Boolean).map((item) => {
      const [idWithParams, visible, opacity] = item.split(',');
      const [rawId, ...rest] = idWithParams.split('@');
      const params = {};
      for (const p of rest) {
        const [k, v = ''] = p.split('=');
        const val = decodePart(v);
        params[k] = k === 'year' && val.toLowerCase() === 'none' ? null
          : val === 'true' || val === 'false' ? val === 'true'
            : k !== 'features' && isNumber(val) ? Number(val) : val;
      }
      const [type, url, name] = rawId.split('|');
      const external = EXTERNAL.includes(type) && url
        ? { type, url: decodeURIComponent(decodePart(url)), name: name ? decodeURIComponent(decodePart(name)) : null } : null;
      return {
        id: external ? (external.name || external.url) : decodePart(rawId),
        visible: !visible || visible === 't',
        opacity: isNumber(opacity) ? Math.max(0, Math.min(1, Number(opacity))) : null,
        params,
        external,
      };
    });
  }

  /** [{ id, visible, opacity, params, external }] → the `layers` parameter (opacity only when not 1). */
  function layersParam(list) {
    return list.map((l) => {
      let s = l.external
        ? [l.external.type, encodeURIComponent(l.external.url), ...(l.external.name ? [encodeURIComponent(l.external.name)] : [])].map(encodePart).join('|')
        : encodePart(l.id);
      for (const [k, v] of Object.entries(l.params || {})) s += `@${k}${v === null ? '=none' : v === undefined || v === '' ? '' : `=${encodePart(v)}`}`;
      const hidden = l.visible === false;
      const opacity = Number.isFinite(l.opacity) && l.opacity !== 1 ? Math.round(l.opacity * 100) / 100 : null;
      if (hidden) s += ',f';
      if (opacity !== null) s += `${hidden ? '' : ','},${opacity}`;
      return s;
    }).join(';');
  }

  /** Swiss zoom z (fractional) → metres per pixel, between the steps of the LV95 pyramid. */
  function resolutionOf(z) {
    const k = Math.max(0, Math.min(LV95_RESOLUTIONS.length - 1, z));
    const i = Math.min(LV95_RESOLUTIONS.length - 2, Math.floor(k));
    const f = k - i;
    return LV95_RESOLUTIONS[i] * (LV95_RESOLUTIONS[i + 1] / LV95_RESOLUTIONS[i]) ** f;
  }
  /** Swiss zoom → Web Mercator zoom at a latitude, and back (same metres per pixel on the ground). */
  const toMercatorZoom = (z, lat) => Math.log2((MERCATOR_RES_Z0 * Math.cos((lat * Math.PI) / 180)) / resolutionOf(z));
  function toSwissZoom(zoom, lat) {
    const res = (MERCATOR_RES_Z0 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
    if (res >= LV95_RESOLUTIONS[0]) return 0;
    for (let i = 0; i < LV95_RESOLUTIONS.length - 1; i++) {
      const [a, b] = [LV95_RESOLUTIONS[i], LV95_RESOLUTIONS[i + 1]];
      if (res <= a && res >= b) return Math.round((i + Math.log(res / a) / Math.log(b / a)) * 100) / 100;
    }
    return LV95_RESOLUTIONS.length - 1;
  }

  /**
   * A link of map.geo.admin.ch (or only its query) → { lat, lon, zoom (Web Mercator), layers, bgLayer, topic, lang };
   * missing parts are null.
   */
  function read(link) {
    const s = String(link || '');
    const q = new URLSearchParams(s.includes('?') ? s.slice(s.indexOf('?') + 1) : s.replace(/^#/, ''));
    const out = { lat: null, lon: null, zoom: null, layers: parseLayers(q.get('layers')), bgLayer: q.get('bgLayer'), topic: q.get('topic'), lang: q.get('lang') };
    const c = (q.get('center') || '').split(',').map(Number);
    if (c.length === 2 && c.every(Number.isFinite)) {
      // LV95 (the current viewer) or LV03 (old links).
      const [lat, lon] = c[0] > 1e6 ? Coords.fromLv95(c[0], c[1]) : Coords.fromLv95(c[0] + 2000000, c[1] + 1000000);
      if (Coords.inSwitzerland(lat, lon)) Object.assign(out, { lat, lon });
    }
    // Old links: E and N as separate parameters (LV03 or LV95).
    if (out.lat === null && isNumber(q.get('E')) && isNumber(q.get('N'))) {
      const e = Number(q.get('E')); const n = Number(q.get('N'));
      const [lat, lon] = e > 1e6 ? Coords.fromLv95(e, n) : Coords.fromLv95(e + 2000000, n + 1000000);
      if (Coords.inSwitzerland(lat, lon)) Object.assign(out, { lat, lon });
    }
    const z = Number(q.get('z') ?? q.get('zoom'));
    if (q.has('z') || q.has('zoom')) out.zoom = Number.isFinite(z) && out.lat !== null ? toMercatorZoom(z, out.lat) : null;
    return out;
  }

  /** The link to the same view on map.geo.admin.ch: { lat, lon, zoom (Web Mercator), layers, bgLayer }. */
  function link({ lat, lon, zoom, layers = [], bgLayer = 'ch.swisstopo.pixelkarte-farbe', lang = 'de' }) {
    const [e, n] = Coords.toLv95(lat, lon);
    const parts = [`lang=${lang}`, `center=${e.toFixed(2)},${n.toFixed(2)}`, `z=${toSwissZoom(zoom, lat)}`];
    if (layers.length) parts.push(`layers=${encodeURIComponent(layersParam(layers)).replace(/%3B/g, ';').replace(/%2C/g, ',').replace(/%40/g, '@').replace(/%3D/g, '=').replace(/%7C/g, '|')}`);
    if (bgLayer) parts.push(`bgLayer=${bgLayer}`);
    return `${BASE}?${parts.join('&')}`;
  }

  return { parseLayers, layersParam, read, link, toMercatorZoom, toSwissZoom, resolutionOf };
}));
