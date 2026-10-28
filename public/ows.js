/*
 * Other map services as layers, as the import of map.geo.admin.ch does it: from the address of a WMS or WMTS the
 * address of its capabilities, and from the capabilities the layers and, for WMTS, a tile address Leaflet can use
 * (Web Mercator tile sets only). The browser reads the capabilities itself, so the server never fetches addresses
 * people type in. Runs in the browser (window.Ows) and in Node for the tests.
 *
 * Guessing the service from its address after the web-mapviewer of geo.admin.ch (ImportCatalogue/utils.js, BSD-3).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Ows = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const decode = (s) => String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&').trim();
  /** The text of the first child <tag> (any namespace prefix) directly in `xml`, else null. */
  const text = (xml, tag) => {
    const m = new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`).exec(xml);
    return m ? decode(m[1]) : null;
  };
  const all = (xml, tag) => [...xml.matchAll(new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'g'))].map((m) => m[1]);
  const attr = (tagXml, name) => {
    const m = new RegExp(`\\b(?:[\\w-]+:)?${name}\\s*=\\s*"([^"]*)"`).exec(tagXml);
    return m ? decode(m[1]) : null;
  };

  const isWmts = (url) => /wmts/i.test(url);
  const isWms = (url) => /(wms|map=|\.map)/i.test(url);

  /** The capabilities address of a service address: WMTS if the address says so, else WMS (the usual case). */
  function capabilitiesUrl(raw) {
    const url = new URL(String(raw).trim());
    if (!/^https?:$/.test(url.protocol)) throw new Error('Nur http- und https-Adressen');
    const has = (k) => [...url.searchParams.keys()].some((x) => x.toLowerCase() === k);
    if (isWmts(url.href) && !isWms(url.href.replace(/wmts/ig, ''))) {
      if (!/\.xml$/i.test(url.pathname) && !has('request')) {
        url.searchParams.set('SERVICE', 'WMTS');
        url.searchParams.set('REQUEST', 'GetCapabilities');
      }
      return { type: 'WMTS', url: url.href };
    }
    if (!has('service')) url.searchParams.set('SERVICE', 'WMS');
    if (!has('request')) url.searchParams.set('REQUEST', 'GetCapabilities');
    if (!has('version')) url.searchParams.set('VERSION', '1.3.0');
    return { type: 'WMS', url: url.href };
  }

  /* ---------- WMS ---------- */

  /**
   * Layers of a WMS: every <Layer> with a <Name>, its title and abstract, whether it answers GetFeatureInfo, the
   * legend, and the service address for GetMap (OnlineResource of GetMap, else the address it came from).
   */
  function parseWms(xml, from) {
    const service = text(text(xml, 'Service') || '', 'Title');
    const getMap = /<GetMap\b[\s\S]*?<OnlineResource\b([^>]*)>/.exec(xml);
    let base = getMap ? attr(getMap[1], 'href') : null;
    if (!base) { const u = new URL(from); for (const k of [...u.searchParams.keys()]) if (/^(service|request|version)$/i.test(k)) u.searchParams.delete(k); base = u.href; }
    const layers = [];
    // Each <Layer …> start: its own Name/Title up to the next <Layer, so nested groups do not mix.
    const starts = [...xml.matchAll(/<Layer\b([^>]*)>/g)];
    starts.forEach((m, i) => {
      const own = xml.slice(m.index + m[0].length, starts[i + 1]?.index ?? xml.length);
      const name = text(own.split(/<Style\b/)[0], 'Name');
      if (!name) return;
      const legend = /<LegendURL\b[\s\S]*?<OnlineResource\b([^>]*)>/.exec(own);
      const box = /<EX_GeographicBoundingBox>([\s\S]*?)<\/EX_GeographicBoundingBox>/.exec(own);
      const bbox = box ? ['westBoundLongitude', 'southBoundLatitude', 'eastBoundLongitude', 'northBoundLatitude'].map((k) => Number(text(box[1], k))) : null;
      const time = /<Dimension\b[^>]*name="time"[^>]*>([^<]*)</i.exec(own);
      layers.push({
        name, title: text(own.split(/<Style\b/)[0], 'Title') || name, abstract: text(own.split(/<Style\b/)[0], 'Abstract'),
        queryable: attr(m[1], 'queryable') === '1', legend: legend ? attr(legend[1], 'href') : null,
        bbox: bbox && bbox.every(Number.isFinite) ? bbox : null,
        time: time ? time[1].split(',').map((s) => s.trim()).filter(Boolean) : null,
      });
    });
    return { type: 'WMS', title: service || new URL(from).hostname, url: base, layers };
  }

  /* ---------- WMTS ---------- */

  const MERCATOR = /(3857|900913|GoogleMapsCompatible|WebMercator)/i;

  /**
   * Tile sets of a WMTS in Web Mercator: id → the TileMatrix identifier for zoom z as a template (`{z}` or a
   * prefix such as `EPSG:3857:{z}`), and the first and last zoom.
   */
  function mercatorSets(xml) {
    const sets = {};
    const contents = /<Contents>([\s\S]*)<\/Contents>/.exec(xml)?.[1] || xml;
    for (const block of all(contents, 'TileMatrixSet')) {
      const id = text(block, 'Identifier');
      if (!id || !(MERCATOR.test(text(block, 'SupportedCRS') || '') || MERCATOR.test(text(block, 'WellKnownScaleSet') || '') || MERCATOR.test(id))) continue;
      const ids = all(block, 'TileMatrix').map((m) => text(m, 'Identifier')).filter((x) => x !== null);
      if (!ids.length) continue;
      // Numbers 0, 1, 2 … or a common prefix and then the zoom.
      const prefix = ids[0].replace(/\d+$/, '');
      const zooms = ids.map((x) => (x.startsWith(prefix) && /^\d+$/.test(x.slice(prefix.length)) ? Number(x.slice(prefix.length)) : NaN));
      if (zooms.some((z) => !Number.isFinite(z))) continue;
      sets[id] = { matrix: `${prefix}{z}`, minZoom: Math.min(...zooms), maxZoom: Math.max(...zooms) };
    }
    return sets;
  }

  /**
   * Layers of a WMTS that come in Web Mercator: [{ name, title, abstract, template, minZoom, maxZoom, legend, time }],
   * the template with Leaflet's {z}/{x}/{y}; from ResourceURL, else as GetTile request (KVP).
   */
  function parseWmts(xml, from) {
    const sets = mercatorSets(xml);
    const kvp = /<ows:Operation\b[^>]*name="GetTile"[\s\S]*?<ows:Get\b([^>]*)>/.exec(xml);
    const kvpBase = kvp ? attr(kvp[1], 'href') : null;
    const service = text(text(xml, 'ServiceIdentification') || '', 'Title');
    const contents = /<Contents>([\s\S]*)<\/Contents>/.exec(xml)?.[1] || '';
    const layers = [];
    for (const block of all(contents, 'Layer')) {
      const name = text(block, 'Identifier');
      if (!name) continue;
      const setId = all(block, 'TileMatrixSetLink').map((l) => text(l, 'TileMatrixSet')).find((id) => sets[id]);
      if (!setId) continue;
      const set = sets[setId];
      const styles = all(block, 'Style');
      const style = (styles.find((s) => /isDefault="true"/.test(s)) && text(styles.find((s) => /isDefault="true"/.test(s)), 'Identifier')) || (styles[0] && text(styles[0], 'Identifier')) || 'default';
      const legend = /<LegendURL\b([^>]*)>/.exec(block);
      const format = text(block, 'Format') || 'image/png';
      // Dimensions (Time …): their default value in the address.
      const dims = all(block, 'Dimension').map((d) => ({ id: text(d, 'Identifier'), value: text(d, 'Default') || text(d, 'Value') }));
      const values = all(block, 'Dimension').filter((d) => /Time/i.test(text(d, 'Identifier') || '')).flatMap((d) => all(d, 'Value').map(decode));
      const res = [...block.matchAll(/<ResourceURL\b([^>]*)\/?>/g)].map((m) => ({ type: attr(m[1], 'resourceType'), template: attr(m[1], 'template') }))
        .find((r) => r.type === 'tile' && r.template);
      let template = null;
      if (res) {
        template = res.template.replace(/\{TileMatrixSet\}/gi, setId).replace(/\{TileMatrix\}/gi, set.matrix)
          .replace(/\{TileRow\}/gi, '{y}').replace(/\{TileCol\}/gi, '{x}').replace(/\{Style\}/gi, style);
        for (const d of dims) if (d.id) template = template.replace(new RegExp(`\\{${d.id}\\}`, 'gi'), d.id.toLowerCase() === 'time' ? '{time}' : d.value || '');
      } else if (kvpBase) {
        const u = new URL(kvpBase, from);
        const q = new URLSearchParams({ SERVICE: 'WMTS', REQUEST: 'GetTile', VERSION: '1.0.0', LAYER: name, STYLE: style, FORMAT: format, TILEMATRIXSET: setId });
        template = `${u.origin}${u.pathname}?${u.searchParams.toString() ? `${u.searchParams}&` : ''}${q}&TILEMATRIX=${set.matrix}&TILEROW={y}&TILECOL={x}`;
      }
      if (!template) continue;
      const time = dims.find((d) => /time/i.test(d.id || ''));
      layers.push({
        name, title: text(block, 'Title') || name, abstract: text(block, 'Abstract'), template, minZoom: set.minZoom, maxZoom: set.maxZoom,
        legend: legend ? attr(legend[1], 'href') : null, timeDefault: time?.value || null, time: values.length ? values : null,
      });
    }
    return { type: 'WMTS', title: service || new URL(from).hostname, url: from, layers };
  }

  /** Capabilities of either kind → { type, title, url, layers }; throws for anything else. */
  function parseCapabilities(xml, from) {
    if (/<(WMT_MS_Capabilities|WMS_Capabilities)\b/.test(xml)) return parseWms(xml, from);
    if (/<Capabilities\b/.test(xml) && /TileMatrixSet/.test(xml)) return parseWmts(xml, from);
    if (/ServiceException|ExceptionReport/.test(xml)) throw new Error(text(xml, 'ServiceException') || text(xml, 'ExceptionText') || 'Der Dienst meldet einen Fehler');
    throw new Error('Keine WMS- oder WMTS-Capabilities');
  }

  /** A WMTS tile address for a time value (`{time}` replaced). */
  const tileUrl = (layer, time) => layer.template.replace(/\{time\}/g, encodeURIComponent(time || layer.timeDefault || 'current'));

  /**
   * Services offered in the panel: a selection for forest, nature and hazards from the list of external providers of
   * the web-mapviewer of geo.admin.ch (external-providers.json, BSD-3). Any other address can be typed in.
   */
  const PROVIDERS = [
    ['Waldgrenzen (Nutzungsplanung, geodienste.ch)', 'https://geodienste.ch/db/npl_waldgrenzen/deu'],
    ['Waldabstandslinien (geodienste.ch)', 'https://geodienste.ch/db/npl_waldabstandslinien/deu'],
    ['Naturereigniskataster (geodienste.ch)', 'https://geodienste.ch/db/naturereigniskataster/deu'],
    ['Gefahrenkarten (geodienste.ch)', 'https://geodienste.ch/db/gefahrenkarten/deu'],
    ['Biodiversitätsförderflächen (geodienste.ch)', 'https://geodienste.ch/db/lwb_biodiversitaetsfoerderflaechen/deu'],
    ['Fruchtfolgeflächen (geodienste.ch)', 'https://geodienste.ch/db/fruchtfolgeflaechen/deu'],
    ['Grundwasservorkommen (geodienste.ch)', 'https://geodienste.ch/db/grundwasservorkommen/deu'],
    ['Gewässerraum (geodienste.ch)', 'https://geodienste.ch/db/gewaesserraum/deu'],
    ['Kanton Solothurn (WMS)', 'https://geo.so.ch/api/wms'],
    ['Kanton Solothurn (WMTS)', 'https://geo.so.ch/api/wmts/1.0.0/WMTSCapabilities.xml'],
    ['Kanton Basel-Landschaft (WMS)', 'https://geowms.bl.ch/'],
    ['Kanton Jura (WMS)', 'https://geoservices.jura.ch/wms/'],
    ['Kanton Waadt (WMS)', 'https://www.ogc.vd.ch/public/services/OGC/wmsVD/Mapserver/Wmsserver'],
    ['Swiss Data Cube (WMTS)', 'https://geoserver.swissdatacube.org/geoserver/gwc/service/wmts?REQUEST=GetCapabilities'],
    ['Ökosysteme Europas (EEA)', 'https://bio.discomap.eea.europa.eu/arcgis/services/Ecosystem/Ecosystems/MapServer/WMSServer'],
    ['Corine Land Cover 2012 (EEA)', 'https://copernicus.discomap.eea.europa.eu/arcgis/services/Corine/CLC2012_WM/MapServer/WMSServer'],
  ];

  return { capabilitiesUrl, parseCapabilities, parseWms, parseWmts, tileUrl, PROVIDERS };
}));
