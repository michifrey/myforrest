'use strict';

// Drawing on the map with KML export (public/draw.js) and KML colours and KMZ files as layers (public/filelayer.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const Draw = require('../public/draw.js');
const FileLayer = require('../public/filelayer.js');

/** A ZIP as a KMZ is one: [name, content, deflate?]. */
function zip(files) {
  const parts = [];
  const dir = [];
  let offset = 0;
  for (const [name, content, deflate] of files) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(content);
    const packed = deflate ? zlib.deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    dir.push(central, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(dir);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

const DRAWING = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { name: 'Windwurf <Nord> & Süd', description: 'Fichten, Februar', stroke: '#27ae60', 'stroke-width': 3, fill: '#27ae60', 'fill-opacity': 0.3 }, geometry: { type: 'Polygon', coordinates: [[[8.565, 47.374], [8.567, 47.374], [8.567, 47.373], [8.565, 47.374]]] } },
    { type: 'Feature', properties: { name: 'Rückegasse', stroke: '#2980b9', 'stroke-width': 3 }, geometry: { type: 'LineString', coordinates: [[8.564, 47.372], [8.5655, 47.3727]] } },
    { type: 'Feature', properties: { name: 'Käfernest', 'marker-color': '#c0392b', stroke: '#c0392b' }, geometry: { type: 'Point', coordinates: [8.5662, 47.3734] } },
  ],
};

test('Drawing: the KML colour is aabbggrr, with the opacity in front', () => {
  assert.equal(Draw.kmlColour('#27ae60'), 'ff60ae27');
  assert.equal(Draw.kmlColour('#c0392b', 0.3), '4d2b39c0');
  assert.deepEqual(FileLayer.kmlColour('4d2b39c0'), ['#c0392b', 0.3]);
});

test('Drawing: the export as KML reads back as the same objects, names, notes and colours', () => {
  const kml = Draw.toKml(DRAWING, 'Windwurf');
  assert.match(kml, /^<\?xml/);
  assert.match(kml, /<name>Windwurf &lt;Nord&gt; &amp; Süd<\/name>/, 'names are escaped');
  const back = FileLayer.toGeoJson(kml, 'zeichnung.kml');
  assert.equal(back.name, 'Windwurf');
  assert.deepEqual(back.collection.features.map((f) => f.geometry.type), ['Polygon', 'LineString', 'Point']);
  const [area, line, point] = back.collection.features;
  assert.equal(area.properties.name, 'Windwurf <Nord> & Süd');
  assert.equal(area.properties.description, 'Fichten, Februar');
  assert.deepEqual(area.geometry.coordinates, DRAWING.features[0].geometry.coordinates);
  assert.equal(area.properties.stroke, '#27ae60');
  assert.equal(area.properties.fill, '#27ae60');
  assert.equal(area.properties['fill-opacity'], 0.3);
  assert.equal(line.properties.stroke, '#2980b9');
  assert.equal(line.properties['stroke-width'], 3);
  assert.equal(point.properties['marker-color'], '#c0392b');
});

test('Files: shared KML styles and style maps give their colours to the placemarks', () => {
  const kml = `<kml><Document><Style id="wald"><LineStyle><color>ff0000ff</color><width>4</width></LineStyle><PolyStyle><color>66ff0000</color><fill>1</fill></PolyStyle></Style>
<StyleMap id="wald-map"><Pair><key>normal</key><styleUrl>#wald</styleUrl></Pair><Pair><key>highlight</key><styleUrl>#andere</styleUrl></Pair></StyleMap>
<Placemark><name>Fläche</name><styleUrl>#wald-map</styleUrl><Polygon><outerBoundaryIs><LinearRing><coordinates>8,47 8.1,47 8.1,47.1 8,47</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
<Placemark><name>Ohne Füllung</name><Style><LineStyle><color>ff00ff00</color></LineStyle><PolyStyle><fill>0</fill></PolyStyle></Style><Polygon><outerBoundaryIs><LinearRing><coordinates>8,47 8.1,47 8.1,47.1 8,47</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
<Placemark><name>Ohne Stil</name><Point><coordinates>8,47</coordinates></Point></Placemark></Document></kml>`;
  const [a, b, c] = FileLayer.toGeoJson(kml, 'stile.kml').collection.features.map((f) => f.properties);
  assert.deepEqual([a.stroke, a['stroke-width'], a.fill, a['fill-opacity']], ['#ff0000', 4, '#0000ff', 0.4]);
  assert.deepEqual([b.stroke, b['fill-opacity']], ['#00ff00', 0]);
  assert.equal(c.stroke, undefined);
});

test('Files: a KMZ is read from its doc.kml (stored or deflated), with pictures and other files beside it', async () => {
  const kml = Draw.toKml(DRAWING, 'Aus der KMZ');
  for (const deflate of [false, true]) {
    const kmz = zip([['files/foto.jpg', 'jpeg', false], ['andere.kml', '<kml><Document><Placemark><Point><coordinates>7,46</coordinates></Point></Placemark></Document></kml>', deflate], ['doc.kml', kml, deflate]]);
    const r = await FileLayer.read(kmz, 'windwurf.kmz');
    assert.equal(r.format, 'KMZ');
    assert.equal(r.name, 'Aus der KMZ');
    assert.equal(r.collection.features.length, 3);
  }
  // Without doc.kml: the first KML at the top level.
  const r = await FileLayer.read(zip([['ordner/tief.kml', '<kml/>', true], ['oben.kml', kml, true]]), 'x.kmz');
  assert.equal(r.collection.features.length, 3);
  await assert.rejects(FileLayer.read(zip([['bild.png', 'png', false]]), 'leer.kmz'), /Keine KML-Datei/);
  await assert.rejects(FileLayer.read(Buffer.from('PK kaputt'), 'kaputt.kmz'), /KMZ/);
  // Plain text files go through as before.
  const g = await FileLayer.read(Buffer.from(JSON.stringify(DRAWING)), 'z.geojson');
  assert.equal(g.format, 'GeoJSON');
});
