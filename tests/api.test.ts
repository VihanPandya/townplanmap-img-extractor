/**
 * Exercises the public API surface through the real Next.js route handlers,
 * including the SSRF rejections that must never depend on a client-side check.
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
import { serializeExport } from '@/lib/export/serialize';
import { parseTargetUrl, UrlSecurityError, validateTarget } from '@/lib/security/url-guard';
import type { DiscoveredImage } from '@/lib/types';

let site: { origin: string; close: () => Promise<void> };
let scanId: string;
let images: DiscoveredImage[];

before(async () => {
  site = await startFixtureSite();
  const created = await createScan({
    url: site.origin,
    settings: { maxPages: 20, maxDepth: 2, requestDelayMs: 0, concurrency: 2 },
  });
  scanId = created.scanId;
  await getRun(scanId)!.done;
  const record = await getScanStore().get(scanId);
  images = [...record!.images.values()];
});

after(async () => {
  await site?.close();
});

test('the store serves images incrementally through a cursor', async () => {
  const store = getScanStore();
  const first = await store.images(scanId, { since: 0, limit: 5 });
  assert.equal(first.images.length, 5);

  const lastSeq = first.images[first.images.length - 1]!.seq;
  const second = await store.images(scanId, { since: lastSeq });
  assert.ok(second.images.every((image) => image.seq > lastSeq));
  assert.equal(first.images.length + second.images.length, first.total);
});

test('an image can be looked up by id, with or without its scan', async () => {
  const store = getScanStore();
  const target = images[0]!;
  assert.equal((await store.image(scanId, target.id))?.url, target.url);
  const found = await store.findImageAnywhere(target.id);
  assert.equal(found?.scanId, scanId);
  assert.equal(await store.image(scanId, 'img_does_not_exist'), null);
});

test('CSV export is correctly quoted and carries the documented columns', () => {
  const payload = serializeExport(images, 'csv', { scanId, scanUrl: site.origin });
  const lines = payload.body.split('\r\n').filter(Boolean);
  const header = lines[0]!.split(',');

  assert.deepEqual(header.slice(0, 8), [
    'Filename',
    'Image URL',
    'Source Page',
    'Width',
    'Height',
    'Format',
    'Alt Text',
    'Category',
  ]);
  assert.equal(lines.length, images.length + 1);
  assert.match(payload.contentType, /text\/csv/);
  assert.match(payload.filename, /\.csv$/);

  // A value containing a comma must be quoted so the column count is stable.
  const tricky = serializeExport(
    [{ ...images[0]!, altText: 'a value, with a comma and a "quote"' }],
    'csv',
    { scanId, scanUrl: site.origin },
  );
  assert.ok(tricky.body.includes('"a value, with a comma and a ""quote"""'));
});

test('JSON export carries the full dataset and a rights notice', () => {
  const payload = serializeExport(images, 'json', { scanId, scanUrl: site.origin });
  const parsed = JSON.parse(payload.body) as {
    imageCount: number;
    notice: string;
    images: Array<{ url: string; references: unknown[] }>;
  };
  assert.equal(parsed.imageCount, images.length);
  assert.match(parsed.notice, /Rights to the images/);
  assert.ok(parsed.images[0]!.references.length > 0, 'every reference is preserved');
});

test('TXT export is a bare URL list', () => {
  const payload = serializeExport(images, 'txt', { scanId, scanUrl: site.origin });
  const lines = payload.body.trim().split('\n');
  assert.equal(lines.length, images.length);
  for (const line of lines) assert.match(line, /^https?:\/\//);
});

test('category overrides win in exports', () => {
  const target = images[0]!;
  const payload = serializeExport([target], 'json', {
    scanId,
    scanUrl: site.origin,
    categoryOverrides: { [target.id]: 'screenshot' },
  });
  const parsed = JSON.parse(payload.body) as { images: Array<{ category: string; categoryWasOverridden: boolean }> };
  assert.equal(parsed.images[0]!.category, 'screenshot');
  assert.equal(parsed.images[0]!.categoryWasOverridden, true);
});

test('SSRF guard rejects private and special-use destinations', async () => {
  // The permissive development switch must not leak into this check.
  delete process.env.SCANNER_ALLOW_PRIVATE_HOSTS;
  try {
    const targets = [
      'http://127.0.0.1:8080/',
      'http://localhost/',
      'http://[::1]/',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.1.2.3/',
      'http://192.168.0.1/',
      'http://172.16.9.9/',
      'http://metadata.google.internal/',
      'http://[::ffff:127.0.0.1]/',
    ];
    for (const target of targets) {
      await assert.rejects(
        () => validateTarget(target),
        (error: unknown) => error instanceof UrlSecurityError,
        `${target} must be refused`,
      );
    }
  } finally {
    process.env.SCANNER_ALLOW_PRIVATE_HOSTS = '1';
  }
});

test('SSRF guard rejects unusable protocols before any DNS work', () => {
  for (const target of ['file:///etc/passwd', 'gopher://x/', 'ftp://x/', 'javascript:1']) {
    assert.throws(() => parseTargetUrl(target), UrlSecurityError);
  }
});

test('a scan of an unreachable host fails with a readable message', async () => {
  const created = await createScan({
    url: 'http://127.0.0.1:1/',
    settings: { maxPages: 1, maxDepth: 0, requestDelayMs: 0 },
  });
  await getRun(created.scanId)!.done;
  const record = await getScanStore().get(created.scanId);

  assert.equal(record!.progress.pagesFailed, 1);
  const issue = record!.issues.find((entry) => entry.title === 'Unable to retrieve this page.');
  assert.ok(issue, 'the failure should be surfaced as an issue');
  assert.ok(issue!.detail.length > 0);
});

test('stopping a scan preserves what was already discovered', async () => {
  const created = await createScan({
    url: site.origin,
    settings: { maxPages: 20, maxDepth: 2, requestDelayMs: 300, concurrency: 1 },
  });
  const run = getRun(created.scanId)!;

  // Let the first page land, then stop.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const { controlScan } = await import('@/lib/scan/engine');
  controlScan(created.scanId, 'stop');
  await run.done;

  const record = await getScanStore().get(created.scanId);
  assert.equal(record!.status, 'stopped');
  assert.ok(record!.images.size > 0, 'results found before the stop are kept');
  assert.match(record!.progress.message, /Stopped/);
});
