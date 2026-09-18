/**
 * The city / village map intelligence module, end to end.
 *
 * A real scan of the fixture site produces the location hierarchy, parcels,
 * image associations and KML exports. The central rule under test throughout is
 * that nothing is invented: a record without source geometry never gains a
 * boundary, and a location name always traces back to something in the data.
 */
process.env.SCANNER_ALLOW_PRIVATE_HOSTS = '1';
delete process.env.HTTPS_PROXY;
delete process.env.https_proxy;
delete process.env.SCANNER_PROXY_URL;

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
// @ts-expect-error - plain JS fixture helper
import { startFixtureSite } from './fixture/site.mjs';
import { createScan } from '@/lib/scan/create';
import { getRun } from '@/lib/scan/engine';
import { getScanStore } from '@/lib/database/store';
import { ancestryOf, indexForRecord, searchIndex, summariseLocation } from '@/lib/mapintel';
import { areaOfFeature, classifyLocationKind, extractSurveyReference } from '@/lib/mapintel/build';
import { parseKml } from '@/lib/geo/parse';
import type { MapIntelIndex, ParcelRecord } from '@/lib/mapintel/types';
import { POST as exportKmlRoute } from '@/app/api/export/kml/route';
import { POST as exportAllRoute } from '@/app/api/export/all/route';
import { GET as parcelKmlRoute } from '@/app/api/parcels/[id]/kml/route';
import { NextRequest } from 'next/server';

let site: { origin: string; close: () => Promise<void> };
let index: MapIntelIndex;
let scanId: string;

before(async () => {
  site = await startFixtureSite();
  const created = await createScan({
    url: site.origin,
    settings: { maxPages: 25, maxDepth: 2, requestDelayMs: 0, concurrency: 2 },
  });
  scanId = created.scanId;
  await getRun(scanId)!.done;
  const record = await getScanStore().get(scanId);
  index = indexForRecord(record!);
});

after(async () => {
  await site?.close();
});

function parcelByReference(reference: string): ParcelRecord | undefined {
  return index.parcels.find((parcel) => parcel.reference === reference);
}

// -------------------------------------------------------------- extraction

test('survey references are read from the text the source wrote', () => {
  assert.equal(extractSurveyReference('Survey No. 125/2', {}), '125/2');
  assert.equal(extractSurveyReference('S.No 126/1/A', {}), '126/1/A');
  assert.equal(extractSurveyReference('Final Plot 118', {}), '118');
  assert.equal(extractSurveyReference('125/2', {}), '125/2');
  assert.equal(extractSurveyReference(null, { survey_no: '200/1' }), '200/1');
  // A property wins over parsing prose, because it is the source's own field.
  assert.equal(extractSurveyReference('Some plot', { survey_no: '77/3' }), '77/3');
  assert.equal(extractSurveyReference('An ordinary title', {}), null);
});

test('location kinds come from words the source used, never a guess', () => {
  assert.equal(classifyLocationKind('Bopal Village'), 'village');
  assert.equal(classifyLocationKind('Ahmedabad District'), 'district');
  assert.equal(classifyLocationKind('Daskroi Taluka'), 'taluka');
  // Nothing indicates a level, so it stays unknown rather than being invented.
  assert.equal(classifyLocationKind('Bopal'), 'unknown');
});

test('polygon area is computed from real coordinates', () => {
  const parsed = parseKml(
    `<kml><Document><Placemark><name>Square</name><Polygon><outerBoundaryIs><LinearRing><coordinates>
      72.0000,23.0000 72.0100,23.0000 72.0100,23.0100 72.0000,23.0100 72.0000,23.0000
    </coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></Document></kml>`,
    'x',
  );
  const area = areaOfFeature(parsed.features[0]!);
  assert.ok(area, 'a polygon must yield an area');
  // ~0.01 degree square near 23N is roughly 1.02 km x 1.11 km.
  assert.ok(area! > 1_000_000 && area! < 1_300_000, `area was ${area}`);

  // A point has no area, and none is fabricated for it.
  const point = parseKml(
    '<kml><Document><Placemark><Point><coordinates>72,23</coordinates></Point></Placemark></Document></kml>',
    'x',
  );
  assert.equal(areaOfFeature(point.features[0]!), null);
});

// --------------------------------------------------------------- hierarchy

test('the location hierarchy is discovered from the source data', () => {
  const names = index.locations.map((node) => node.name);
  assert.ok(names.includes('Ahmedabad'), `expected Ahmedabad among ${names.join(', ')}`);
  assert.ok(names.includes('Bopal'));
  assert.ok(names.includes('Shela'));

  const bopal = index.locations.find((node) => node.name === 'Bopal')!;
  const trail = ancestryOf(index, bopal.id).map((node) => node.name);
  assert.deepEqual(trail, ['Ahmedabad', 'Bopal'], 'district should contain the village');

  // The village attribute in the KML is what produced this, so it is recorded.
  assert.ok(bopal.evidence.includes('feature-property'));
  assert.equal(bopal.kind, 'village');
});

test('every location name traces back to evidence in the source', () => {
  for (const node of index.locations) {
    assert.ok(node.evidence.length > 0, `${node.name} has no recorded evidence`);
    assert.ok(node.sourceUrl.length > 0, `${node.name} has no source URL`);
  }
});

// ----------------------------------------------------------------- parcels

test('parcels are built from real placemarks with their attributes', () => {
  const parcel = parcelByReference('125/2');
  assert.ok(parcel, 'Survey 125/2 should have been discovered');
  assert.equal(parcel!.name, 'Survey No. 125/2');
  assert.equal(parcel!.geometryAvailability, 'available');
  assert.equal(parcel!.kmlAvailable, true);
  assert.equal(parcel!.feature?.geometry.type, 'Polygon');
  assert.equal(parcel!.properties['village'], 'Bopal');
  assert.equal(parcel!.properties['district'], 'Ahmedabad');
});

test('an area stated by the source is preferred over one computed from geometry', () => {
  const parcel = parcelByReference('125/2')!;
  // The KML says 2.34 hectares.
  assert.equal(parcel.areaBasis, 'source-attribute');
  assert.equal(parcel.areaSquareMetres, 23_400);

  // 126/1 has no area attribute, so it is computed and labelled as such.
  const computed = parcelByReference('126/1')!;
  assert.equal(computed.areaBasis, 'computed-from-geometry');
  assert.ok((computed.areaSquareMetres ?? 0) > 0);
});

test('a projected GeoJSON is transformed and flagged as transformed', () => {
  const parcel = parcelByReference('200/1');
  assert.ok(parcel, 'the projected parcel should have been discovered');
  assert.equal(parcel!.kmlAvailable, true);
  assert.equal(parcel!.feature?.transformed, true);
  assert.equal(parcel!.feature?.confidence, 'source-transformed');
  assert.equal(parcel!.feature?.sourceCrs, 'EPSG:3857');

  // Transformed coordinates must land in Gujarat, not at null island.
  const bbox = parcel!.feature!.bbox!;
  assert.ok(bbox.west > 72 && bbox.west < 73, `west was ${bbox.west}`);
  assert.ok(bbox.south > 22 && bbox.south < 24, `south was ${bbox.south}`);
});

test('a map image with no published coordinates is image-only and gets no KML', () => {
  const imageOnly = index.parcels.filter((parcel) => parcel.geometryAvailability === 'image-only');
  assert.ok(imageOnly.length > 0, 'the fixture has map images without geometry');
  for (const parcel of imageOnly) {
    assert.equal(parcel.kmlAvailable, false);
    assert.equal(parcel.feature, null);
    assert.equal(parcel.areaSquareMetres, null, 'no area may be invented from an image');
  }
});

// ------------------------------------------------------------ associations

test('a georeferenced overlay is a verified image association', () => {
  const parcel = parcelByReference('125/2')!;
  const overlay = parcel.images.find((image) => image.georeferenced);
  assert.ok(overlay, 'the GroundOverlay image should be linked to the parcel');
  assert.equal(overlay!.confidence, 'verified');
  assert.ok(overlay!.bbox, 'the overlay carries the bounds the source stated');
  assert.match(overlay!.reason, /georeferenced overlay/i);
});

test('an image naming the survey reference is verified, others are weaker', () => {
  const parcel = parcelByReference('126/1')!;
  const named = parcel.images.find((image) => image.url.includes('survey-126-1'));
  assert.ok(named, 'the matching image should be associated');
  assert.equal(named!.confidence, 'verified');
  assert.match(named!.reason, /contains the parcel reference/i);

  // Nothing is ever presented as exact without a reason recorded.
  for (const image of index.parcels.flatMap((entry) => entry.images)) {
    assert.ok(['verified', 'probable', 'unverified'].includes(image.confidence));
    assert.ok(image.reason.length > 0, 'every association states why');
  }
});

// -------------------------------------------------------------- dashboard

test('the location dashboard counts only what was actually found', () => {
  const ahmedabad = index.locations.find((node) => node.name === 'Ahmedabad')!;
  const summary = summariseLocation(index, ahmedabad.id)!;

  assert.ok(summary.counts.parcels >= 3, `expected the district's parcels, got ${summary.counts.parcels}`);
  assert.ok(summary.counts.kmlAvailable >= 3);
  assert.equal(
    summary.counts.kmlAvailable + summary.counts.imageOnly + summary.counts.unverified,
    summary.counts.parcels,
    'every parcel falls into exactly one availability state',
  );
  assert.ok(summary.bbox, 'a district with geometry has bounds');
  assert.ok(summary.children.some((child) => child.name === 'Bopal'));
});

test('search finds locations and survey references, including punctuation variants', () => {
  assert.ok(searchIndex(index, 'bopal').locations.length > 0);

  const exact = searchIndex(index, '125/2');
  assert.ok(exact.parcels.some((parcel) => parcel.reference === '125/2'));

  // "125-2" and "125 2" must reach the same record.
  assert.ok(searchIndex(index, '125-2').parcels.some((parcel) => parcel.reference === '125/2'));
  assert.equal(searchIndex(index, 'definitely-not-present').parcels.length, 0);
});

// ------------------------------------------------------------ KML exports

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('a single parcel exports to KML containing its real coordinates', async () => {
  const parcel = parcelByReference('125/2')!;
  const response = await parcelKmlRoute(
    new NextRequest(`http://localhost/api/parcels/${parcel.id}/kml?scanId=${scanId}`),
    { params: Promise.resolve({ id: parcel.id }) },
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /vnd\.google-earth\.kml/);
  assert.match(response.headers.get('content-disposition') ?? '', /Survey_No\._125_2\.kml|125_2\.kml/);

  const kml = await response.text();
  const reparsed = parseKml(kml, 'exported');
  assert.equal(reparsed.features.length, 1);
  assert.deepEqual(reparsed.features[0]!.geometry.coordinates, parcel.feature!.geometry.coordinates);
  assert.match(kml, /Geometry source/);
  assert.match(kml, /not a legal land-survey/i);
});

test('an image-only record is refused a KML, with the reason', async () => {
  const imageOnly = index.parcels.find((parcel) => parcel.geometryAvailability === 'image-only')!;
  const response = await parcelKmlRoute(
    new NextRequest(`http://localhost/api/parcels/${imageOnly.id}/kml?scanId=${scanId}`),
    { params: Promise.resolve({ id: imageOnly.id }) },
  );

  assert.equal(response.status, 404);
  const payload = (await response.json()) as { error: { code: string; message: string; detail?: string } };
  assert.equal(payload.error.code, 'no-geometry');
  assert.match(payload.error.message, /did not publish geographic coordinates/i);
  assert.match(payload.error.detail ?? '', /manufacture precision/i);
});

test('a combined KML preserves the district and village folders', async () => {
  const response = await exportKmlRoute(
    jsonRequest('http://localhost/api/export/kml', { scanId, mode: 'combined' }) as never,
  );
  assert.equal(response.status, 200);

  const kml = await response.text();
  const reparsed = parseKml(kml, 'exported');
  assert.ok(reparsed.features.length >= 3);

  const paths = new Set(reparsed.features.map((feature) => feature.folderPath.join('/')));
  assert.ok([...paths].some((value) => value.includes('Ahmedabad/Bopal')), `paths were ${[...paths].join(' | ')}`);
  assert.ok([...paths].some((value) => value.includes('Ahmedabad/Shela')));
});

test('individual KML export returns one file per parcel and lists what it skipped', async () => {
  const response = await exportKmlRoute(
    jsonRequest('http://localhost/api/export/kml', { scanId, mode: 'individual' }) as never,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');

  const dir = mkdtempSync(path.join(tmpdir(), 'kml-zip-'));
  try {
    const archive = path.join(dir, 'kml.zip');
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
    assert.match(execFileSync('unzip', ['-t', archive], { encoding: 'utf8' }), /No errors detected/);
    execFileSync('unzip', ['-q', '-o', archive, '-d', dir]);

    const listing = execFileSync('unzip', ['-l', archive], { encoding: 'utf8' });
    assert.match(listing, /125_2\.kml/);
    assert.match(listing, /126_1\.kml/);

    // Image-only records are named in SKIPPED.txt rather than silently missing.
    const skipped = readFileSync(path.join(dir, 'SKIPPED.txt'), 'utf8');
    assert.match(skipped, /no coordinates published|could not be verified/);
    assert.match(skipped, /would invent precision/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------- download centre

test('the bundle is organised into Images, KML and metadata.json', async () => {
  const response = await exportAllRoute(
    jsonRequest('http://localhost/api/export/all', {
      scanId,
      includeImages: true,
      includeKml: true,
      includeMetadata: true,
      acknowledged: true,
      basis: 'automated test',
    }) as never,
  );
  assert.equal(response.status, 200);

  const dir = mkdtempSync(path.join(tmpdir(), 'bundle-'));
  try {
    const archive = path.join(dir, 'bundle.zip');
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
    assert.match(execFileSync('unzip', ['-t', archive], { encoding: 'utf8' }), /No errors detected/);

    const listing = execFileSync('unzip', ['-l', archive], { encoding: 'utf8' });
    assert.match(listing, /_Map_Data\/KML\//, 'KML folder missing');
    assert.match(listing, /_Map_Data\/Images\//, 'Images folder missing');
    assert.match(listing, /metadata\.json/);
    // Village sub-folders keep the hierarchy.
    assert.match(listing, /KML\/Bopal\//);

    execFileSync('unzip', ['-q', '-o', archive, '-d', dir]);
    const root = listing.match(/(\S+_Map_Data)\//)![1]!;
    const metadata = JSON.parse(readFileSync(path.join(dir, root, 'metadata.json'), 'utf8')) as {
      statedBasis: string;
      accuracyNotice: string;
      coordinateSystem: string;
      contents: { records: number; withKml: number };
      maps: Array<{ reference: string | null; kml: string | null; geometryAvailable: boolean; geometryNote: string | null }>;
    };

    assert.equal(metadata.statedBasis, 'automated test');
    assert.match(metadata.accuracyNotice, /not be treated as a legal land-survey/i);
    assert.match(metadata.coordinateSystem, /EPSG:4326/);
    assert.ok(metadata.contents.withKml >= 3);

    const record = metadata.maps.find((entry) => entry.reference === '125/2')!;
    assert.ok(record.kml, 'the KML path is recorded');
    assert.equal(record.geometryAvailable, true);

    // Image-only records appear with an explanation and no KML path.
    const withoutGeometry = metadata.maps.find((entry) => !entry.geometryAvailable);
    assert.ok(withoutGeometry, 'records without geometry are still listed');
    assert.equal(withoutGeometry!.kml, null);
    assert.ok(withoutGeometry!.geometryNote, 'and carry a reason');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('downloading images requires the acknowledgement; KML and metadata do not', async () => {
  const refused = await exportAllRoute(
    jsonRequest('http://localhost/api/export/all', { scanId, includeImages: true }) as never,
  );
  assert.equal(refused.status, 403);

  // KML plus metadata is generated from data already retrieved, so it proceeds.
  const allowed = await exportAllRoute(
    jsonRequest('http://localhost/api/export/all', {
      scanId,
      includeImages: false,
      includeKml: true,
      includeMetadata: true,
    }) as never,
  );
  assert.equal(allowed.status, 200);
});
