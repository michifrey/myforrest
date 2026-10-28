'use strict';

// Other map services and files as layers (public/ows.js, public/filelayer.js), with capabilities in the format of
// real services (WMS 1.3.0, WMTS 1.0.0 with ResourceURL and with KVP only).

const test = require('node:test');
const assert = require('node:assert/strict');
const Ows = require('../public/ows.js');
const FileLayer = require('../public/filelayer.js');

const WMS = `<?xml version="1.0"?>
<WMS_Capabilities version="1.3.0" xmlns="http://www.opengis.net/wms" xmlns:xlink="http://www.w3.org/1999/xlink">
<Service><Name>WMS</Name><Title>Waldgrenzen (geodienste.ch)</Title></Service>
<Capability><Request><GetCapabilities/><GetMap><Format>image/png</Format><DCPType><HTTP><Get><OnlineResource xlink:href="https://geodienste.ch/db/npl_waldgrenzen/deu?"/></Get></HTTP></DCPType></GetMap></Request>
<Layer><Title>Nutzungsplanung</Title>
  <Layer queryable="1"><Name>waldgrenzen</Name><Title>Statische Waldgrenzen</Title><Abstract>Rechtskräftige Waldgrenzen &amp; Abstände</Abstract>
    <EX_GeographicBoundingBox><westBoundLongitude>5.9</westBoundLongitude><eastBoundLongitude>10.5</eastBoundLongitude><southBoundLatitude>45.8</southBoundLatitude><northBoundLatitude>47.8</northBoundLatitude></EX_GeographicBoundingBox>
    <Style><Name>default</Name><Title>Standard</Title><LegendURL><OnlineResource xlink:href="https://geodienste.ch/legend/waldgrenzen.png"/></LegendURL></Style>
  </Layer>
  <Layer><Name>waldabstand</Name><Title>Waldabstandslinien</Title><Dimension name="time" units="ISO8601">2020,2024</Dimension></Layer>
</Layer></Capability></WMS_Capabilities>`;

const WMTS = `<?xml version="1.0"?>
<Capabilities xmlns="http://www.opengis.net/wmts/1.0" xmlns:ows="http://www.opengis.net/ows/1.1" version="1.0.0">
<ows:ServiceIdentification><ows:Title>Geodaten Solothurn</ows:Title></ows:ServiceIdentification>
<Contents>
  <Layer><ows:Title>Orthofoto 2023</ows:Title><ows:Identifier>ch.so.agi.orthofoto_2023</ows:Identifier>
    <Style isDefault="true"><ows:Identifier>default</ows:Identifier></Style><Format>image/jpeg</Format>
    <Dimension><ows:Identifier>Time</ows:Identifier><Default>2023</Default><Value>2023</Value><Value>2021</Value></Dimension>
    <TileMatrixSetLink><TileMatrixSet>2056</TileMatrixSet></TileMatrixSetLink>
    <TileMatrixSetLink><TileMatrixSet>3857</TileMatrixSet></TileMatrixSetLink>
    <ResourceURL format="image/jpeg" resourceType="tile" template="https://geo.so.ch/api/wmts/1.0.0/ch.so.agi.orthofoto_2023/{Style}/{Time}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.jpeg"/>
  </Layer>
  <Layer><ows:Title>Nur LV95</ows:Title><ows:Identifier>nur_lv95</ows:Identifier>
    <TileMatrixSetLink><TileMatrixSet>2056</TileMatrixSet></TileMatrixSetLink>
    <ResourceURL format="image/png" resourceType="tile" template="https://x/{TileMatrix}/{TileRow}/{TileCol}.png"/>
  </Layer>
  <TileMatrixSet><ows:Identifier>2056</ows:Identifier><ows:SupportedCRS>urn:ogc:def:crs:EPSG::2056</ows:SupportedCRS><TileMatrix><ows:Identifier>0</ows:Identifier></TileMatrix></TileMatrixSet>
  <TileMatrixSet><ows:Identifier>3857</ows:Identifier><ows:SupportedCRS>urn:ogc:def:crs:EPSG::3857</ows:SupportedCRS>
    <TileMatrix><ows:Identifier>EPSG:3857:6</ows:Identifier></TileMatrix><TileMatrix><ows:Identifier>EPSG:3857:7</ows:Identifier></TileMatrix><TileMatrix><ows:Identifier>EPSG:3857:18</ows:Identifier></TileMatrix>
  </TileMatrixSet>
</Contents></Capabilities>`;

const WMTS_KVP = `<Capabilities xmlns:ows="http://www.opengis.net/ows/1.1"><ows:OperationsMetadata>
<ows:Operation name="GetTile"><ows:DCP><ows:HTTP><ows:Get xlink:href="https://wmts.example/service?token=1"/></ows:HTTP></ows:DCP></ows:Operation></ows:OperationsMetadata>
<Contents><Layer><ows:Title>Karte</ows:Title><ows:Identifier>karte</ows:Identifier><Format>image/png</Format>
<TileMatrixSetLink><TileMatrixSet>GoogleMapsCompatible</TileMatrixSet></TileMatrixSetLink></Layer>
<TileMatrixSet><ows:Identifier>GoogleMapsCompatible</ows:Identifier><WellKnownScaleSet>urn:ogc:def:wkss:OGC:1.0:GoogleMapsCompatible</WellKnownScaleSet>
<TileMatrix><ows:Identifier>0</ows:Identifier></TileMatrix><TileMatrix><ows:Identifier>19</ows:Identifier></TileMatrix></TileMatrixSet></Contents></Capabilities>`;

test('the capabilities address of a service: WMS by default, WMTS when the address says so', () => {
  assert.deepEqual(Ows.capabilitiesUrl('https://geodienste.ch/db/npl_waldgrenzen/deu'), { type: 'WMS', url: 'https://geodienste.ch/db/npl_waldgrenzen/deu?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0' });
  assert.equal(Ows.capabilitiesUrl('https://geowms.bl.ch/?SERVICE=WMS&version=1.1.1&REQUEST=GetCapabilities').url, 'https://geowms.bl.ch/?SERVICE=WMS&version=1.1.1&REQUEST=GetCapabilities', 'kept as given');
  assert.deepEqual(Ows.capabilitiesUrl('https://geo.so.ch/api/wmts/1.0.0/WMTSCapabilities.xml'), { type: 'WMTS', url: 'https://geo.so.ch/api/wmts/1.0.0/WMTSCapabilities.xml' });
  assert.equal(Ows.capabilitiesUrl('https://services.geo.sg.ch/wss/service/SG00014_WMTS/guest?').url, 'https://services.geo.sg.ch/wss/service/SG00014_WMTS/guest?SERVICE=WMTS&REQUEST=GetCapabilities');
  assert.throws(() => Ows.capabilitiesUrl('file:///etc/passwd'), /http/);
  assert.throws(() => Ows.capabilitiesUrl('keine adresse'));
});

test('WMS: named layers with title, abstract, legend, area and time; the GetMap address', () => {
  const c = Ows.parseCapabilities(WMS, 'https://geodienste.ch/db/npl_waldgrenzen/deu?SERVICE=WMS&REQUEST=GetCapabilities');
  assert.deepEqual([c.type, c.title, c.url], ['WMS', 'Waldgrenzen (geodienste.ch)', 'https://geodienste.ch/db/npl_waldgrenzen/deu?']);
  assert.deepEqual(c.layers.map((l) => [l.name, l.title, l.queryable]), [['waldgrenzen', 'Statische Waldgrenzen', true], ['waldabstand', 'Waldabstandslinien', false]]);
  assert.equal(c.layers[0].abstract, 'Rechtskräftige Waldgrenzen & Abstände');
  assert.equal(c.layers[0].legend, 'https://geodienste.ch/legend/waldgrenzen.png');
  assert.deepEqual(c.layers[0].bbox, [5.9, 45.8, 10.5, 47.8]);
  assert.deepEqual(c.layers[1].time, ['2020', '2024']);
});

test('WMTS: only Web Mercator tile sets, the tile address with Leaflet placeholders, time; KVP when there is no ResourceURL', () => {
  const c = Ows.parseCapabilities(WMTS, 'https://geo.so.ch/api/wmts/1.0.0/WMTSCapabilities.xml');
  assert.deepEqual(c.layers.map((l) => l.name), ['ch.so.agi.orthofoto_2023'], 'the layer only in LV95 is left out');
  const l = c.layers[0];
  assert.equal(l.template, 'https://geo.so.ch/api/wmts/1.0.0/ch.so.agi.orthofoto_2023/default/{time}/3857/EPSG:3857:{z}/{y}/{x}.jpeg');
  assert.deepEqual([l.minZoom, l.maxZoom, l.timeDefault, l.time], [6, 18, '2023', ['2023', '2021']]);
  assert.equal(Ows.tileUrl(l, '2021'), 'https://geo.so.ch/api/wmts/1.0.0/ch.so.agi.orthofoto_2023/default/2021/3857/EPSG:3857:{z}/{y}/{x}.jpeg');
  const k = Ows.parseCapabilities(WMTS_KVP, 'https://wmts.example/service?SERVICE=WMTS&REQUEST=GetCapabilities').layers[0];
  assert.equal(k.template, 'https://wmts.example/service?token=1&SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=karte&STYLE=default&FORMAT=image%2Fpng&TILEMATRIXSET=GoogleMapsCompatible&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}');
  assert.throws(() => Ows.parseCapabilities('<ServiceExceptionReport><ServiceException>Layer unbekannt</ServiceException></ServiceExceptionReport>', 'https://x/'), /Layer unbekannt/);
  assert.throws(() => Ows.parseCapabilities('<html></html>', 'https://x/'), /Keine/);
});

test('files as a layer: KML with points, lines, polygons with holes and tracks; GPX; GeoJSON', () => {
  const kml = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2"><Document><name>Windwurf Sihlwald</name>
    <Placemark><name>Wurzelteller</name><description><![CDATA[<b>Fichte</b>, 2025]]></description><Point><coordinates>8.55,47.25,600</coordinates></Point></Placemark>
    <Placemark><name>Fläche</name><Polygon><outerBoundaryIs><LinearRing><coordinates>8.5,47.2 8.6,47.2 8.6,47.3 8.5,47.2</coordinates></LinearRing></outerBoundaryIs>
      <innerBoundaryIs><LinearRing><coordinates>8.55,47.22 8.56,47.22 8.56,47.23 8.55,47.22</coordinates></LinearRing></innerBoundaryIs></Polygon></Placemark>
    <Placemark><name>Weg</name><MultiGeometry><LineString><coordinates>8.5,47.2 8.51,47.21</coordinates></LineString><Point><coordinates>8.51,47.21</coordinates></Point></MultiGeometry></Placemark>
    <Placemark><gx:Track><gx:coord>8.5 47.2 500</gx:coord><gx:coord>8.52 47.22 510</gx:coord></gx:Track></Placemark>
    <Placemark><name>leer</name></Placemark></Document></kml>`;
  const k = FileLayer.toGeoJson(kml, 'sihlwald.kml');
  assert.deepEqual([k.name, k.format, k.collection.features.length], ['Windwurf Sihlwald', 'KML', 4]);
  assert.deepEqual(k.collection.features[0], { type: 'Feature', properties: { name: 'Wurzelteller', description: 'Fichte, 2025' }, geometry: { type: 'Point', coordinates: [8.55, 47.25] } });
  assert.equal(k.collection.features[1].geometry.coordinates.length, 2, 'outer ring and hole');
  assert.equal(k.collection.features[2].geometry.type, 'GeometryCollection');
  assert.deepEqual(k.collection.features[3].geometry, { type: 'LineString', coordinates: [[8.5, 47.2], [8.52, 47.22]] });
  assert.deepEqual(k.bbox, [8.5, 47.2, 8.6, 47.3]);

  const gpx = `<gpx version="1.1"><metadata><name>Runde</name></metadata><wpt lat="47.3" lon="8.5"><name>Quelle</name></wpt><wpt lat="47.31" lon="8.51"/>
    <trk><name>Lauf</name><trkseg><trkpt lat="47.3" lon="8.5"/><trkpt lat="47.31" lon="8.51"/></trkseg></trk><rte><rtept lat="47.3" lon="8.5"/><rtept lat="47.32" lon="8.52"/></rte></gpx>`;
  const g = FileLayer.toGeoJson(gpx, 'runde.gpx');
  assert.deepEqual(g.collection.features.map((f) => [f.geometry.type, f.properties.name]), [['Point', 'Quelle'], ['Point', null], ['LineString', 'Lauf'], ['LineString', null]]);
  assert.equal(g.name, 'Runde');

  const j = FileLayer.toGeoJson(JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { art: 'Eiche' }, geometry: { type: 'Point', coordinates: [8, 47] } }, { type: 'Feature', geometry: null }] }), 'baeume.geojson');
  assert.deepEqual([j.format, j.name, j.collection.features.length], ['GeoJSON', 'baeume', 1]);
  assert.throws(() => FileLayer.toGeoJson('hallo', 'x.txt'), /Unbekanntes Format/);
  assert.throws(() => FileLayer.toGeoJson('<kml><Document></Document></kml>', 'x.kml'), /Keine Punkte/);
});
