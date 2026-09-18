/**
 * Geometry parsing and coordinate transformation.
 *
 * The central rule under test is that geometry only ever comes from real source
 * coordinates, and that a coordinate system the tool cannot transform exactly
 * is refused rather than passed through as if it were degrees.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { describeCrs, normaliseCrs, positionToWgs84, CrsTransformError } from '@/lib/geo/crs';
import { parseGeoJson, parseGpx, parseKml, parseKmz } from '@/lib/geo/parse';
import { readZipEntries, ZipReadError } from '@/lib/geo/unzip';
import type { Position } from '@/lib/geo/types';

const AHMEDABAD_KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
<name>Ahmedabad villages</name>
<Folder><name>Village A</name>
  <Placemark>
    <name>Survey 125/2</name>
    <description>Agricultural land</description>
    <ExtendedData>
      <Data name="area_hectares"><value>2.34</value></Data>
      <Data name="village"><value>Example Village</value></Data>
    </ExtendedData>
    <Polygon><outerBoundaryIs><LinearRing><coordinates>
      72.571400,23.022500,0 72.572400,23.022500,0 72.572400,23.023500,0 72.571400,23.023500,0 72.571400,23.022500,0
    </coordinates></LinearRing></outerBoundaryIs></Polygon>
  </Placemark>
  <Placemark>
    <name>Survey 126/1</name>
    <Point><coordinates>72.5800,23.0300</coordinates></Point>
  </Placemark>
</Folder>
<GroundOverlay>
  <name>Village A scan</name>
  <Icon><href>https://example.test/scan.jpg</href></Icon>
  <LatLonBox><north>23.03</north><south>23.02</south><east>72.58</east><west>72.57</west><rotation>0</rotation></LatLonBox>
</GroundOverlay>
</Document></kml>`;

test('KML polygons, points, folders and extended data are parsed', () => {
  const result = parseKml(AHMEDABAD_KML, 'https://x.test/a.kml');

  assert.equal(result.documentName, 'Ahmedabad villages');
  assert.equal(result.features.length, 2);

  const polygon = result.features[0]!;
  assert.equal(polygon.name, 'Survey 125/2');
  assert.equal(polygon.description, 'Agricultural land');
  assert.equal(polygon.geometry.type, 'Polygon');
  assert.deepEqual(polygon.folderPath, ['Village A']);
  assert.equal(polygon.properties['area_hectares'], '2.34');
  assert.equal(polygon.properties['village'], 'Example Village');
  assert.equal(polygon.confidence, 'source');
  assert.equal(polygon.transformed, false);
  assert.equal(polygon.vertexCount, 5);

  const rings = polygon.geometry.coordinates as Position[][];
  assert.equal(rings[0]![0]![0], 72.5714);
  assert.equal(rings[0]![0]![1], 23.0225);
  // The ring must close.
  assert.deepEqual(rings[0]![0], rings[0]![rings[0]!.length - 1]);

  assert.ok(polygon.bbox);
  assert.equal(polygon.bbox!.west, 72.5714);
  assert.equal(polygon.bbox!.north, 23.0235);

  assert.equal(result.features[1]!.geometry.type, 'Point');
});

test('an unclosed KML ring is closed rather than rejected', () => {
  const open = AHMEDABAD_KML.replace(' 72.571400,23.022500,0\n    </coordinates>', '\n    </coordinates>');
  const result = parseKml(open, 'https://x.test/a.kml');
  const rings = result.features[0]!.geometry.coordinates as Position[][];
  assert.deepEqual(rings[0]![0], rings[0]![rings[0]!.length - 1]);
});

test('a GroundOverlay is captured with the bounds the source declared', () => {
  const result = parseKml(AHMEDABAD_KML, 'https://x.test/a.kml');
  assert.equal(result.overlays.length, 1);
  const overlay = result.overlays[0]!;
  assert.equal(overlay.href, 'https://example.test/scan.jpg');
  assert.deepEqual(overlay.bbox, { north: 23.03, south: 23.02, east: 72.58, west: 72.57 });
});

test('KMZ is unzipped and its KML parsed', () => {
  const inner = Buffer.from(AHMEDABAD_KML, 'utf8');
  const compressed = deflateRawSync(inner);
  const name = Buffer.from('doc.kml', 'utf8');

  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  let crc = 0xffffffff;
  for (const byte of inner) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(inner.length, 22);
  local.writeUInt16LE(name.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(inner.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);

  const directory = Buffer.concat([central, name]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(local.length + name.length + compressed.length, 16);

  const kmz = Buffer.concat([local, name, compressed, directory, end]);

  const entries = readZipEntries(kmz);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.name, 'doc.kml');

  const result = parseKmz(kmz, 'https://x.test/a.kmz');
  assert.equal(result.features.length, 2);
  assert.equal(result.features[0]!.name, 'Survey 125/2');
});

test('a malformed archive is reported, not thrown past the caller', () => {
  assert.throws(() => readZipEntries(Buffer.from('not a zip at all')), ZipReadError);
  const result = parseKmz(Buffer.from('not a zip at all'), 'https://x.test/a.kmz');
  assert.equal(result.features.length, 0);
  assert.ok(result.warnings.length > 0);
});

test('GeoJSON features and properties are parsed', () => {
  const result = parseGeoJson(
    JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { survey_no: '127/4', area: 1.2, village: 'Example' },
          geometry: {
            type: 'Polygon',
            coordinates: [[[72.57, 23.02], [72.58, 23.02], [72.58, 23.03], [72.57, 23.02]]],
          },
        },
      ],
    }),
    'https://x.test/a.geojson',
  );

  assert.equal(result.features.length, 1);
  assert.equal(result.features[0]!.name, '127/4');
  assert.equal(result.features[0]!.properties['area'], '1.2');
  assert.equal(result.features[0]!.confidence, 'source');
});

test('GPX waypoints and tracks are parsed', () => {
  const result = parseGpx(
    `<gpx><wpt lat="23.02" lon="72.57"><name>Corner</name></wpt>
     <trk><name>Boundary walk</name><trkseg>
       <trkpt lat="23.02" lon="72.57"/><trkpt lat="23.03" lon="72.58"/>
     </trkseg></trk></gpx>`,
    'https://x.test/a.gpx',
  );
  assert.equal(result.features.length, 2);
  assert.equal(result.features[0]!.geometry.type, 'Point');
  assert.equal(result.features[1]!.geometry.type, 'LineString');
});

// ------------------------------------------------------- coordinate systems

test('CRS identifiers are normalised across their many spellings', () => {
  assert.equal(normaliseCrs('EPSG:4326'), 'EPSG:4326');
  assert.equal(normaliseCrs('urn:ogc:def:crs:OGC:1.3:CRS84'), 'EPSG:4326');
  assert.equal(normaliseCrs('urn:ogc:def:crs:EPSG::32643'), 'EPSG:32643');
  assert.equal(normaliseCrs('WGS84'), 'EPSG:4326');
  assert.equal(normaliseCrs('EPSG:900913'), 'EPSG:3857');
  assert.equal(normaliseCrs('102100'), 'EPSG:3857');
  assert.equal(normaliseCrs(null), 'EPSG:4326');
});

test('Web Mercator transforms back to the degrees it came from', () => {
  // 72.5714E, 23.0225N forward-projected to EPSG:3857.
  const x = 8078611.3;
  const y = 2634739.9;
  const [longitude, latitude] = positionToWgs84([x, y] as Position, 'EPSG:3857');
  assert.ok(Math.abs(longitude - 72.5714) < 1e-4, `longitude was ${longitude}`);
  assert.ok(Math.abs(latitude - 23.0225) < 1e-4, `latitude was ${latitude}`);
});

test('UTM round-trips to the degrees it was projected from', () => {
  // 72.5714E, 23.0225N forward-projected to UTM zone 43N (EPSG:32643).
  const [longitude, latitude] = positionToWgs84([251102.5, 2548074.4] as Position, 'EPSG:32643');
  assert.ok(Math.abs(longitude - 72.5714) < 1e-5, `longitude was ${longitude}`);
  assert.ok(Math.abs(latitude - 23.0225) < 1e-5, `latitude was ${latitude}`);
});

test('a southern-hemisphere UTM zone applies the false northing', () => {
  // EPSG:32733 is zone 33S; the same northing must land south of the equator.
  const [, latitude] = positionToWgs84([500000, 7000000] as Position, 'EPSG:32733');
  assert.ok(latitude < 0, `expected a southern latitude, got ${latitude}`);
});

test('an untransformable CRS is refused, never passed through as degrees', () => {
  const support = describeCrs('EPSG:7755');
  assert.equal(support.supported, false);
  assert.match(support.reason ?? '', /cannot transform/i);

  assert.throws(() => positionToWgs84([500000, 2500000] as Position, 'EPSG:7755'), CrsTransformError);
});

test('GeoJSON declaring an untransformable CRS yields a warning and no features', () => {
  const result = parseGeoJson(
    JSON.stringify({
      type: 'FeatureCollection',
      crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::7755' } },
      features: [
        { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [500000, 2500000] } },
      ],
    }),
    'https://x.test/a.geojson',
  );
  assert.equal(result.features.length, 0, 'untransformable geometry must not be emitted');
  assert.ok(result.warnings.some((w) => /cannot transform/i.test(w)));
});

test('a transformed feature is labelled as transformed', () => {
  const result = parseGeoJson(
    JSON.stringify({
      type: 'FeatureCollection',
      crs: { type: 'name', properties: { name: 'EPSG:3857' } },
      features: [
        {
          type: 'Feature',
          properties: { name: 'Projected parcel' },
          geometry: {
            type: 'Polygon',
            coordinates: [[[8078622, 2634014], [8078722, 2634014], [8078722, 2634114], [8078622, 2634014]]],
          },
        },
      ],
    }),
    'https://x.test/a.geojson',
  );
  assert.equal(result.features.length, 1);
  assert.equal(result.features[0]!.transformed, true);
  assert.equal(result.features[0]!.confidence, 'source-transformed');
  const ring = (result.features[0]!.geometry.coordinates as Position[][])[0]!;
  assert.ok(Math.abs(ring[0]![0] - 72.5714) < 1e-3);
});

test('coordinates outside the valid range are dropped with a warning', () => {
  const bad = AHMEDABAD_KML.replace('72.571400,23.022500,0 72.572400', '999.9,555.5,0 72.572400');
  const result = parseKml(bad, 'https://x.test/a.kml');
  assert.ok(result.warnings.some((w) => /outside the valid longitude/i.test(w)));
});

// ----------------------------------------------------------- KML generation

test('a single-feature KML round-trips back to the same coordinates', async () => {
  const { buildSingleKml, kmlFilename, isExportable } = await import('@/lib/geo/kmlWriter');
  const source = parseKml(AHMEDABAD_KML, 'https://x.test/a.kml');
  const polygon = source.features[0]!;

  const kml = buildSingleKml(polygon, {
    website: 'townplanmap.com',
    sourcePage: 'https://x.test/villages',
    geometrySource: 'https://x.test/a.kml',
    retrievedAt: '2026-09-18',
  });

  assert.match(kml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(kml, /<kml xmlns="http:\/\/www\.opengis\.net\/kml\/2\.2">/);
  assert.match(kml, /<name>Survey 125\/2<\/name>/);
  assert.match(kml, /<outerBoundaryIs>/);
  assert.match(kml, /not a legal land-survey/i);
  assert.match(kml, /Geometry source: https:\/\/x\.test\/a\.kml/);

  // Re-parsing the generated file must yield the geometry it started from.
  const reparsed = parseKml(kml, 'generated');
  assert.equal(reparsed.features.length, 1);
  assert.deepEqual(reparsed.features[0]!.geometry.coordinates, polygon.geometry.coordinates);
  assert.equal(reparsed.features[0]!.name, 'Survey 125/2');
  assert.equal(reparsed.features[0]!.properties['area_hectares'], '2.34');

  assert.equal(kmlFilename('Survey 125/2', 'feature'), 'Survey_125_2.kml');
  assert.equal(kmlFilename(null, 'feature'), 'feature.kml');
  // Separators become underscores and the leading dots are stripped, so no
  // traversal survives into the archive.
  assert.equal(kmlFilename('../../etc/passwd', 'feature'), 'etc_passwd.kml');
  assert.equal(kmlFilename('   ', 'feature'), 'feature.kml');
  assert.equal(isExportable(polygon), true);
});

test('a combined KML nests folders and re-parses with its hierarchy intact', async () => {
  const { buildCombinedKml } = await import('@/lib/geo/kmlWriter');
  const source = parseKml(AHMEDABAD_KML, 'https://x.test/a.kml');

  const kml = buildCombinedKml('Ahmedabad village land maps', [
    { path: ['Ahmedabad', 'Village A'], features: [source.features[0]!] },
    { path: ['Ahmedabad', 'Village B'], features: [source.features[1]!] },
  ]);

  assert.match(kml, /<name>Ahmedabad<\/name>/);
  assert.match(kml, /<name>Village A<\/name>/);
  assert.match(kml, /<name>Village B<\/name>/);

  const reparsed = parseKml(kml, 'generated');
  assert.equal(reparsed.features.length, 2);
  const paths = reparsed.features.map((feature) => feature.folderPath.join('/')).sort();
  assert.deepEqual(paths, ['Ahmedabad/Village A', 'Ahmedabad/Village B']);
});

test('XML special characters in names and attributes are escaped', async () => {
  const { buildSingleKml, escapeXml } = await import('@/lib/geo/kmlWriter');
  assert.equal(escapeXml('a & b <c> "d"'), 'a &amp; b &lt;c&gt; &quot;d&quot;');

  const source = parseKml(AHMEDABAD_KML, 'https://x.test/a.kml');
  const feature = { ...source.features[0]!, name: 'Survey <125> & "2"' };
  const kml = buildSingleKml(feature);

  assert.ok(!/<name>Survey <125>/.test(kml), 'raw angle brackets must not reach the document');
  const reparsed = parseKml(kml, 'generated');
  assert.equal(reparsed.features[0]!.name, 'Survey <125> & "2"');
});

test('a feature without usable geometry cannot be exported', async () => {
  const { isExportable, buildSingleKml } = await import('@/lib/geo/kmlWriter');
  const source = parseKml(AHMEDABAD_KML, 'https://x.test/a.kml');
  const unusable = { ...source.features[0]!, confidence: 'unverified' as const };

  assert.equal(isExportable(unusable), false);
  assert.throws(() => buildSingleKml(unusable), /no usable source geometry/i);
});
