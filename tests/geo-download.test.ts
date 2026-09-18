/**
 * Geographic-file discovery and the ZIP downloader.
 *
 * Runs the real pipeline against the fixture site, then extracts the produced
 * archive with the system `unzip` so the ZIP is validated by something other
 * than the code that wrote it.
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
import { geoFormatFromUrl, isGeoUrl, looksLikePage } from '@/lib/normalizer/url';
import { safeEntryName, uniqueName, ZipBuilder } from '@/lib/download/zip';
import { POST as downloadRoute } from '@/app/api/download/route';
import type { DiscoveredImage } from '@/lib/types';

let site: { origin: string; close: () => Promise<void> };
let assets: DiscoveredImage[];
let scanId: string;

before(async () => {
  site = await startFixtureSite();
  const created = await createScan({
    url: site.origin,
    settings: { maxPages: 20, maxDepth: 2, requestDelayMs: 0, concurrency: 2 },
  });
  scanId = created.scanId;
  await getRun(scanId)!.done;
  const record = await getScanStore().get(scanId);
  assets = [...record!.images.values()];
});

after(async () => {
  await site?.close();
});

function byName(name: string): DiscoveredImage | undefined {
  return assets.find((asset) => asset.filename === name);
}

// --------------------------------------------------------------- detection

test('geo formats are recognised from the URL, and non-geo files are not', () => {
  assert.equal(geoFormatFromUrl('https://x.test/a/villages.kml'), 'kml');
  assert.equal(geoFormatFromUrl('https://x.test/a/scheme.KMZ'), 'kmz');
  assert.equal(geoFormatFromUrl('https://x.test/a/index.geojson'), 'geojson');
  assert.equal(geoFormatFromUrl('https://x.test/a/track.gpx'), 'gpx');
  assert.equal(geoFormatFromUrl('https://x.test/a/boundaries-shp.zip'), 'shapefile-zip');

  assert.equal(geoFormatFromUrl('https://x.test/a/photo.jpg'), null);
  assert.equal(geoFormatFromUrl('https://x.test/a/brochure.pdf'), null);
  assert.equal(geoFormatFromUrl('https://x.test/a/archive.zip'), null, 'a plain zip is not assumed to be geo data');
  assert.equal(isGeoUrl('https://x.test/a/villages.kml'), true);
});

test('geo files are never queued as pages', () => {
  // Before this change a .kml link was crawled as HTML and silently dropped.
  for (const url of ['https://x.test/a.kml', 'https://x.test/a.kmz', 'https://x.test/a.geojson']) {
    assert.equal(looksLikePage(url), false, `${url} must not be treated as a page`);
  }
  assert.equal(looksLikePage('https://x.test/villages'), true);
});

// --------------------------------------------------------------- discovery

test('KML, KMZ and GeoJSON files are discovered from page links', () => {
  const geo = assets.filter((asset) => asset.assetKind === 'geo');
  const names = geo.map((asset) => asset.filename).sort();

  assert.deepEqual(names, [
    'ahmedabad-villages.kml',
    'broken-layer.kml',
    'gandhinagar-town-boundary.kml',
    'surat-tp-scheme.kmz',
    'village-index.geojson',
  ]);

  assert.equal(byName('ahmedabad-villages.kml')?.geoFormat, 'kml');
  assert.equal(byName('surat-tp-scheme.kmz')?.geoFormat, 'kmz');
  assert.equal(byName('village-index.geojson')?.geoFormat, 'geojson');
});

test('a geo file found in a data attribute merges with its anchor reference', () => {
  const villages = byName('ahmedabad-villages.kml');
  assert.ok(villages);
  // Linked once as an anchor and once via data-kml on the map widget.
  assert.ok(villages!.referenceCount >= 2, `expected multiple references, got ${villages!.referenceCount}`);
  assert.ok(villages!.sourceTypes.includes('anchor-href'));
  assert.ok(villages!.sourceTypes.includes('data-attribute'));
});

test('a PDF link is not collected as geo data', () => {
  assert.equal(
    assets.some((asset) => asset.filename.endsWith('.pdf')),
    false,
    'only geographic formats are picked up, not every downloadable file',
  );
});

test('geo files are verified, sized and categorised as maps', () => {
  const villages = byName('ahmedabad-villages.kml');
  assert.equal(villages?.status, 'available');
  assert.equal(villages?.category, 'map');
  assert.ok((villages?.fileSize ?? 0) > 0, 'a real byte size is reported');
  assert.ok(villages?.contentHash, 'a fully read file is hashed');
  assert.equal(villages?.width, null, 'a KML has no pixel dimensions and must not invent any');
  assert.equal(villages?.belowMinimumSize, false, 'the pixel minimum does not apply to data files');
  assert.match(villages!.categoryReasons.join(' '), /KML/);
});

test('a KML that is really an HTML error page is reported, not accepted', () => {
  const broken = byName('broken-layer.kml');
  assert.equal(broken?.status, 'unsupported');
  assert.match(broken?.statusMessage ?? '', /HTML page instead of the data file/);
});

test('a KMZ is confirmed to be a real zip archive', () => {
  const kmz = byName('surat-tp-scheme.kmz');
  assert.equal(kmz?.status, 'available');
  assert.ok((kmz?.fileSize ?? 0) > 0);
});

test('village and town map images are discovered alongside the data files', () => {
  const village = byName('village-boundary-map.png');
  const town = byName('town-plan-gandhinagar.png');
  assert.equal(village?.assetKind, 'image');
  assert.equal(village?.width, 1400);
  assert.equal(village?.category, 'map');
  assert.equal(town?.width, 1200);
  assert.equal(town?.category, 'map');
});

// ------------------------------------------------------------- zip internals

test('archive entry names cannot escape the extraction directory', () => {
  assert.equal(safeEntryName('../../etc/passwd', 'fallback'), 'passwd');
  assert.equal(safeEntryName('/absolute/path/file.kml', 'fallback'), 'file.kml');
  assert.equal(safeEntryName('..\\..\\windows\\system32\\evil.exe', 'fallback'), 'evil.exe');
  assert.equal(safeEntryName('....//....//x.png', 'fallback'), 'x.png');
  assert.equal(safeEntryName('', 'fallback'), 'fallback');
  assert.equal(safeEntryName('../..', 'fallback'), 'fallback');
  assert.equal(safeEntryName('a<b>c:d"e|f?g*h.png', 'fallback'), 'a_b_c_d_e_f_g_h.png');
});

test('duplicate names inside an archive are made unique', () => {
  const taken = new Set<string>();
  assert.equal(uniqueName('map.kml', taken), 'map.kml');
  assert.equal(uniqueName('map.kml', taken), 'map (2).kml');
  assert.equal(uniqueName('map.kml', taken), 'map (3).kml');
});

test('the zip writer produces an archive the system unzip accepts', () => {
  const zip = new ZipBuilder();
  const parts: Buffer[] = [];
  parts.push(zip.add({ name: 'one.txt', data: Buffer.from('hello zip') }));
  parts.push(zip.add({ name: 'nested/two.kml', data: Buffer.from('<kml/>') }));
  parts.push(zip.end());

  const dir = mkdtempSync(path.join(tmpdir(), 'zip-test-'));
  try {
    const archive = path.join(dir, 'out.zip');
    writeFileSync(archive, Buffer.concat(parts));

    // -t asks unzip to verify every CRC in the archive.
    const verified = execFileSync('unzip', ['-t', archive], { encoding: 'utf8' });
    assert.match(verified, /No errors detected/);

    execFileSync('unzip', ['-q', '-o', archive, '-d', dir]);
    assert.equal(readFileSync(path.join(dir, 'one.txt'), 'utf8'), 'hello zip');
    assert.equal(readFileSync(path.join(dir, 'nested/two.kml'), 'utf8'), '<kml/>');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- download

function downloadRequest(body: unknown): Request {
  return new Request('http://localhost/api/download', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('the downloader refuses without an explicit acknowledgement', async () => {
  const response = await downloadRoute(downloadRequest({ scanId }) as never);
  assert.equal(response.status, 403);
  const payload = (await response.json()) as { error: { code: string; message: string } };
  assert.equal(payload.error.code, 'acknowledgement-required');
  assert.match(payload.error.message, /right to retrieve/);
});

test('the downloader refuses an unknown scan', async () => {
  const response = await downloadRoute(
    downloadRequest({ scanId: 'scan_missing', acknowledged: true }) as never,
  );
  assert.equal(response.status, 404);
});

test('selected files come back as a valid zip with the real bytes', async () => {
  const wanted = assets.filter(
    (asset) =>
      asset.assetKind === 'geo' ||
      asset.filename === 'village-boundary-map.png' ||
      asset.filename === 'town-plan-gandhinagar.png',
  );
  assert.ok(wanted.length >= 6);

  const response = await downloadRoute(
    downloadRequest({
      scanId,
      acknowledged: true,
      basis: 'automated test',
      imageIds: wanted.map((asset) => asset.id),
    }) as never,
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.match(response.headers.get('content-disposition') ?? '', /attachment; filename=".*\.zip"/);

  const archiveBytes = Buffer.from(await response.arrayBuffer());
  const dir = mkdtempSync(path.join(tmpdir(), 'dl-test-'));
  try {
    const archive = path.join(dir, 'assets.zip');
    writeFileSync(archive, archiveBytes);

    assert.match(execFileSync('unzip', ['-t', archive], { encoding: 'utf8' }), /No errors detected/);
    execFileSync('unzip', ['-q', '-o', archive, '-d', dir]);

    // Geo files and images land in their own folders.
    const kmlText = readFileSync(path.join(dir, 'geo-data/ahmedabad-villages.kml'), 'utf8');
    assert.match(kmlText, /<kml/);
    assert.match(kmlText, /Ahmedabad villages/);

    const kmzBytes = readFileSync(path.join(dir, 'geo-data/surat-tp-scheme.kmz'));
    assert.equal(kmzBytes.subarray(0, 2).toString('latin1'), 'PK', 'the KMZ survived the round trip intact');

    const png = readFileSync(path.join(dir, 'images/village-boundary-map.png'));
    assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');

    // The manifest records provenance for every selected file.
    const manifest = readFileSync(path.join(dir, 'MANIFEST.csv'), 'utf8');
    assert.match(manifest, /Stated basis for retrieval: automated test/);
    assert.match(manifest, /not a licence/);
    assert.match(manifest, /ahmedabad-villages\.kml/);
    // The known-bad file was excluded up front rather than silently missing.
    assert.equal(
      manifest.includes('broken-layer.kml'),
      false,
      'assets that failed verification are not attempted',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a selection of only unretrievable files is refused with a clear reason', async () => {
  const broken = byName('broken-layer.kml');
  const missing = byName('missing-image.png');
  assert.ok(broken && missing);

  const response = await downloadRoute(
    downloadRequest({ scanId, acknowledged: true, imageIds: [broken!.id, missing!.id] }) as never,
  );
  assert.equal(response.status, 400);
  const payload = (await response.json()) as { error: { code: string; message: string } };
  assert.equal(payload.error.code, 'nothing-to-download');
  assert.match(payload.error.message, /None of the selected files could be retrieved/);
});
