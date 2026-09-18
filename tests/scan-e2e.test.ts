/**
 * End-to-end exercise of the scan engine against a local fixture site.
 *
 * This drives the real code path — robots, sitemap seeding, crawl, extraction,
 * normalisation, consolidation, verification and content-hash deduplication —
 * and asserts on the resulting asset set.
 *
 * The fixture is on 127.0.0.1, which the SSRF guard blocks by design, so the
 * test sets SCANNER_ALLOW_PRIVATE_HOSTS=1. That switch exists only for local
 * fixtures and is off in every other situation.
 */
process.env.SCANNER_ALLOW_PRIVATE_HOSTS = '1';
delete process.env.HTTPS_PROXY;
delete process.env.https_proxy;
delete process.env.SCANNER_PROXY_URL;

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error - plain JS fixture helper
import { startFixtureSite } from './fixture/site.mjs';
import { createScan } from '@/lib/scan/create';
import { getRun } from '@/lib/scan/engine';
import { getScanStore } from '@/lib/database/store';
import type { DiscoveredImage } from '@/lib/types';

let site: { origin: string; close: () => Promise<void> };

before(async () => {
  site = await startFixtureSite();
});

after(async () => {
  await site?.close();
});

async function runScan(overrides: Record<string, unknown> = {}) {
  const created = await createScan({
    url: site.origin,
    settings: { maxPages: 20, maxDepth: 2, requestDelayMs: 0, concurrency: 2, ...overrides },
  });
  const run = getRun(created.scanId);
  assert.ok(run, 'the engine should register the run');
  await run!.done;
  const record = await getScanStore().get(created.scanId);
  assert.ok(record, 'the scan record should still be stored');
  return { record: record!, scanId: created.scanId };
}

function byFilename(images: DiscoveredImage[], name: string): DiscoveredImage | undefined {
  return images.find((image) => image.filename === name);
}

test('a full scan discovers assets through every supported reference type', async () => {
  const { record } = await runScan();
  const images = [...record.images.values()];
  const urls = images.map((image) => image.url);

  assert.equal(record.status, 'completed', record.error ?? '');
  assert.ok(record.progress.pagesScanned >= 3, `expected several pages, got ${record.progress.pagesScanned}`);

  const expectations: Array<[label: string, path: string]> = [
    ['<img src>', '/img/gallery-photo.png'],
    ['srcset candidate', '/img/ahmedabad-town-plan-map-300x225.png'],
    ['picture source', '/img/ahmedabad-town-plan-map.png'],
    ['lazy data-src', '/img/lazy-parcel-plan.png'],
    ['og:image', '/img/og-share-card.png'],
    ['link rel=icon', '/favicon.ico'],
    ['inline style background', '/img/hero-banner.png'],
    ['style block background', '/img/css-texture.png'],
    ['external stylesheet background', '/img/sheet-background.png'],
    ['video poster', '/img/poster-frame.png'],
    ['JSON-LD image', '/img/schema-thumb.png'],
    ['JSON-LD ImageObject logo', '/img/site-logo.svg'],
  ];

  for (const [label, path] of expectations) {
    assert.ok(
      urls.some((url) => url.endsWith(path)),
      `${label} (${path}) should have been discovered`,
    );
  }
});

test('relative URLs resolve and tracking parameters collapse onto one asset', async () => {
  const { record } = await runScan();
  const images = [...record.images.values()];

  // "img/gallery-photo.png" (document-relative) must resolve to the same asset
  // as "/img/gallery-photo.png" (root-relative) on the gallery page.
  const gallery = images.filter((image) => image.url.endsWith('/img/gallery-photo.png'));
  assert.equal(gallery.length, 1, 'the two spellings must consolidate into one asset');
  assert.ok(gallery[0]!.pageCount >= 2, 'it is referenced from both the home page and the gallery');

  // ?utm_source=…&v=3 is a tracking + cache-buster pair, so it is the same asset.
  const maps = images.filter((image) => image.url.includes('ahmedabad-town-plan-map.png'));
  assert.equal(maps.length, 1, `tracking parameters must not create a second asset (got ${maps.length})`);
  assert.ok(maps[0]!.referenceCount >= 3, 'all spellings are recorded as references');
});

test('verification reports real dimensions, formats and statuses', async () => {
  const { record } = await runScan();
  const images = [...record.images.values()];

  const map = byFilename(images, 'ahmedabad-town-plan-map.png');
  assert.equal(map?.width, 1600);
  assert.equal(map?.height, 1200);
  assert.equal(map?.mimeType, 'image/png');
  assert.equal(map?.status, 'available');
  assert.equal(map?.orientation, 'landscape');
  assert.equal(map?.sizeBucket, 'large');
  assert.ok((map?.fileSize ?? 0) > 0);

  const missing = byFilename(images, 'missing-image.png');
  assert.equal(missing?.status, 'unavailable');
  assert.equal(missing?.httpStatus, 404);
  assert.match(missing?.statusMessage ?? '', /does not exist/);

  const notAnImage = images.find((image) => image.url.endsWith('/not-really-an-image'));
  assert.equal(notAnImage?.status, 'unsupported');

  const redirected = images.find((image) => image.url.endsWith('/img/redirect-to-map'));
  assert.equal(redirected?.status, 'redirected');
  assert.ok(redirected?.finalUrl?.endsWith('/img/ahmedabad-town-plan-map.png'));

  const banner = byFilename(images, 'hero-banner.png');
  assert.equal(banner?.orientation, 'panorama');
});

test('byte-identical images are marked as duplicates of the first one seen', async () => {
  const { record } = await runScan();
  const images = [...record.images.values()];

  const original = byFilename(images, 'gallery-photo.png');
  const copy = byFilename(images, 'duplicate-copy.png');
  assert.ok(original && copy);
  assert.ok(original!.contentHash, 'a fully read body should produce a hash');
  assert.equal(original!.contentHash, copy!.contentHash);

  const duplicates = [original!, copy!].filter((image) => image.isDuplicate);
  assert.equal(duplicates.length, 1, 'exactly one of the pair is flagged');
  assert.equal(duplicates[0]!.duplicateOf, duplicates[0] === copy ? original!.id : copy!.id);
});

test('robots.txt is honoured and reported', async () => {
  const { record } = await runScan();

  assert.equal(record.robots?.found, true);
  assert.equal(record.robots?.policy, 'respecting');
  assert.ok(record.robots!.disallowedPaths >= 1);

  const visited = record.pages.map((page) => page.url);
  assert.ok(!visited.some((url) => url.includes('/private/')), 'the disallowed path must not be fetched');

  const images = [...record.images.values()];
  assert.ok(
    !images.some((image) => image.url.includes('should-never-be-seen')),
    'no asset from a disallowed page may appear',
  );
});

test('external images and non-page links are excluded by default', async () => {
  const { record } = await runScan();
  const images = [...record.images.values()];

  assert.ok(
    !images.some((image) => image.url.includes('cdn.example.invalid')),
    'external image hosts are off by default',
  );
  assert.ok(
    !record.pages.some((page) => page.url.includes('cdn.example.invalid')),
    'external pages are never crawled',
  );
  assert.ok(
    !record.pages.some((page) => page.url.endsWith('.pdf')),
    'non-HTML links are not queued as pages',
  );
});

test('HTTP errors become readable issues without failing the scan', async () => {
  const { record } = await runScan();

  assert.equal(record.status, 'completed');
  const forbidden = record.issues.find((issue) => issue.url?.endsWith('/forbidden'));
  assert.ok(forbidden, 'the 403 page should be reported');
  assert.match(forbidden!.detail, /403/);
  assert.match(forbidden!.detail, /did not permit/);
});

test('classification identifies maps, logos and icons from observable signals', async () => {
  const { record } = await runScan();
  const images = [...record.images.values()];

  assert.equal(byFilename(images, 'ahmedabad-town-plan-map.png')?.category, 'map');
  assert.equal(byFilename(images, 'site-logo.svg')?.category, 'logo');
  assert.equal(byFilename(images, 'icon-pin.png')?.category, 'icon');
  assert.equal(byFilename(images, 'favicon.ico')?.category, 'icon');

  const map = byFilename(images, 'ahmedabad-town-plan-map.png');
  assert.ok((map?.categoryReasons.length ?? 0) > 0, 'a classification must explain itself');
  assert.ok((map?.categoryConfidence ?? 0) > 0);

  // Being found on a map-themed page must not, by itself, make an asset a map.
  // Both of these sit on /maps/ahmedabad but carry no map signal of their own.
  // ("redirect-to-map" is excluded on purpose: its own name does say "map".)
  for (const filename of ['missing-image.png', 'not-really-an-image']) {
    const asset = images.find((image) => image.filename === filename);
    assert.ok(asset, `${filename} should have been discovered`);
    assert.notEqual(asset!.category, 'map', `${filename} must not be classified as a map`);
  }
});

test('minimum dimensions flag small assets instead of discarding them', async () => {
  const { record } = await runScan({ minImageWidth: 100, minImageHeight: 100 });
  const images = [...record.images.values()];

  const icon = byFilename(images, 'icon-pin.png');
  assert.ok(icon, 'the small icon is still collected');
  assert.equal(icon!.belowMinimumSize, true, 'and flagged as below the minimum');

  const map = byFilename(images, 'ahmedabad-town-plan-map.png');
  assert.equal(map!.belowMinimumSize, false);

  const filtered = await getScanStore().images(record.id, { includeBelowMinimum: false });
  assert.ok(
    !filtered.images.some((image) => image.filename === 'icon-pin.png'),
    'the store can exclude them on request',
  );
});

test('verification can be turned off, and status stays honest about it', async () => {
  const { record } = await runScan({ verifyImages: false });
  const images = [...record.images.values()];

  assert.ok(images.length > 0);
  for (const image of images) {
    assert.equal(image.status, 'unverified', `${image.filename} must not claim to be available`);
    assert.equal(image.width, null);
    assert.equal(image.contentHash, null);
  }
});

test('the image limit is enforced and reported', async () => {
  // 10 is the lowest value the settings validator accepts; the fixture has more
  // assets than that, so the ceiling genuinely bites.
  const { record } = await runScan({ maxImages: 10 });
  assert.ok(record.images.size <= 10, `expected at most 10 assets, got ${record.images.size}`);
  assert.ok(record.issues.some((issue) => issue.title === 'Image limit reached'));
});

test('out-of-range settings are clamped rather than obeyed blindly', async () => {
  const { record } = await runScan({ maxPages: 99999, maxDepth: -5, concurrency: 1000, requestDelayMs: -1 });
  assert.equal(record.settings.maxPages, 500);
  assert.equal(record.settings.maxDepth, 0);
  assert.equal(record.settings.concurrency, 8);
  assert.equal(record.settings.requestDelayMs, 0);
  // maxDepth 0 means the start page only.
  assert.ok(record.pages.filter((page) => page.status === 'ok').length >= 1);
});

test('a second scan of the same site is independent of the first', async () => {
  const first = await runScan();
  const second = await runScan();
  assert.notEqual(first.scanId, second.scanId);
  assert.equal(first.record.images.size, second.record.images.size);
});
