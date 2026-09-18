/**
 * The scan engine.
 *
 * Responsibilities, in order:
 *   validate → robots → (sitemap seed) → breadth-first crawl → extract →
 *   normalise → consolidate → verify → content-hash dedupe → finish
 *
 * The crawl and the image verification run as two cooperating worker pools so
 * the gallery receives real metadata while pages are still being fetched.
 * Every mutation lands on the shared `ScanRecord`, which the API routes read.
 */

import { MAX_STYLESHEETS_PER_SCAN, VERIFY_CONCURRENCY } from '@/lib/config';
import { classifyImage, orientationOf, sizeBucketOf } from '@/lib/classifier';
import { dedupeKey, markContentDuplicates, variantGroupKey } from '@/lib/deduplicator';
import { extractCssUrls } from '@/lib/extractor/css';
import { extractFromHtml } from '@/lib/extractor/html';
import type { RawImageRef } from '@/lib/extractor/types';
import { fetchRobots, RobotsPolicy } from '@/lib/crawler/robots';
import { collectSitemapUrls } from '@/lib/crawler/sitemap';
import {
  canonicalPageUrl,
  canonicalUrl,
  extensionFromUrl,
  filenameFromUrl,
  isSameSite,
  looksLikePage,
  pageLabel,
  resolveUrl,
} from '@/lib/normalizer/url';
import { probeImage } from '@/lib/probe/imageProbe';
import { HttpFetchError, safeFetch } from '@/lib/security/http';
import { UrlSecurityError, validateTarget } from '@/lib/security/url-guard';
import { addIssue, addPage, getScanStore, type ScanRecord } from '@/lib/database/store';
import type {
  CrawledPage,
  DiscoveredImage,
  ImageReference,
  ScanIssue,
  ScanStatus,
} from '@/lib/types';
import { mapWithConcurrency, sleep } from '@/lib/utils/async';
import { imageIdFor, issueId } from '@/lib/utils/id';
import { cleanText } from '@/lib/utils/text';

export type ControlState = 'running' | 'paused' | 'stopping';

/** Live handle for a scan in flight. Not serialisable, never leaves the server. */
export interface ScanRun {
  id: string;
  record: ScanRecord;
  controller: AbortController;
  state: ControlState;
  /** Resolved once the run has fully settled. */
  done: Promise<void>;
}

const globalRef = globalThis as typeof globalThis & { __imageScanRuns?: Map<string, ScanRun> };

function runs(): Map<string, ScanRun> {
  if (!globalRef.__imageScanRuns) globalRef.__imageScanRuns = new Map();
  return globalRef.__imageScanRuns;
}

export function getRun(scanId: string): ScanRun | undefined {
  return runs().get(scanId);
}

/**
 * Read the control state through a call so the compiler does not narrow it:
 * `run.state` is mutated by the control API while these loops are suspended.
 */
function stateOf(run: ScanRun): ControlState {
  return run.state;
}

export function controlScan(scanId: string, action: 'pause' | 'resume' | 'stop'): ScanStatus | null {
  const run = runs().get(scanId);
  if (!run) return null;
  if (action === 'pause' && run.state === 'running') {
    run.state = 'paused';
    run.record.status = 'paused';
    run.record.progress.message = 'Paused. Results discovered so far are kept.';
  } else if (action === 'resume' && run.state === 'paused') {
    run.state = 'running';
    run.record.status = 'running';
    run.record.progress.message = 'Resuming crawl…';
  } else if (action === 'stop' && run.state !== 'stopping') {
    run.state = 'stopping';
    run.record.status = 'stopping';
    run.record.progress.message = 'Stopping. Results discovered so far are kept.';
    run.controller.abort();
  }
  run.record.updatedAt = Date.now();
  return run.record.status;
}

interface QueueItem {
  url: string;
  depth: number;
  referer: string | null;
}

/** Start a scan. Returns as soon as the run is registered; work continues async. */
export function startScan(record: ScanRecord): ScanRun {
  const controller = new AbortController();
  const run: ScanRun = {
    id: record.id,
    record,
    controller,
    state: 'running',
    done: Promise.resolve(),
  };
  runs().set(record.id, run);
  run.done = execute(run).finally(() => {
    // Keep the handle briefly so a final control call resolves cleanly.
    setTimeout(() => runs().delete(record.id), 30_000);
  });
  return run;
}

async function execute(run: ScanRun): Promise<void> {
  const { record } = run;
  const store = getScanStore();
  const settings = record.settings;

  try {
    record.status = 'running';
    record.progress.phase = 'robots';
    record.progress.message = 'Checking robots.txt…';

    const { policy, info } = await fetchRobots(record.origin, settings.respectRobots);
    record.robots = info;
    if (info.note) {
      pushIssue(record, {
        kind: 'robots',
        url: info.url,
        title: 'Robots.txt',
        detail: info.note,
        httpStatus: null,
      });
    }

    const startUrl = record.url;
    if (settings.respectRobots && !policy.isUrlAllowed(startUrl)) {
      record.status = 'failed';
      record.error = 'This site’s robots.txt does not allow the scanner to request the starting page, so the scan was not run.';
      record.progress.phase = 'done';
      record.progress.message = record.error;
      record.finishedAt = Date.now();
      pushIssue(record, {
        kind: 'robots',
        url: startUrl,
        title: 'Blocked by robots.txt',
        detail: record.error,
        httpStatus: null,
      });
      await store.touch(record.id);
      return;
    }

    // Effective delay honours a Crawl-delay directive when it asks for more.
    const delayMs = Math.max(settings.requestDelayMs, Math.min(policy.crawlDelayMs ?? 0, 5000));

    const seen = new Set<string>([canonicalPageUrl(startUrl)]);
    const queue: QueueItem[] = [{ url: startUrl, depth: 0, referer: null }];

    if (settings.useSitemap && policy.sitemaps.length > 0) {
      record.progress.message = 'Reading sitemap…';
      const sitemap = await collectSitemapUrls(policy.sitemaps, run.controller.signal);
      for (const url of sitemap.urls) {
        if (queue.length + 1 >= settings.maxPages) break;
        const canonical = canonicalPageUrl(url);
        if (seen.has(canonical)) continue;
        if (!isSameSite(url, record.origin, settings.includeSubdomains)) continue;
        if (settings.respectRobots && !policy.isUrlAllowed(url)) continue;
        seen.add(canonical);
        queue.push({ url, depth: 1, referer: startUrl });
      }
    }

    record.progress.phase = 'crawling';
    record.progress.message = 'Crawling pages…';

    const verifyQueue: DiscoveredImage[] = [];
    const stylesheetsSeen = new Set<string>();
    let stylesheetBudget = MAX_STYLESHEETS_PER_SCAN;
    let lastRequestAt = 0;

    // The verifier keeps draining until the crawl is genuinely finished. It
    // must not key off the frontier length: a crawl that stops early (image
    // limit, stop request) leaves URLs queued that nobody will ever fetch.
    let crawling = true;
    const verifier = settings.verifyImages
      ? runVerifier(run, verifyQueue, () => crawling)
      : Promise.resolve();

    // ------------------------------------------------------------- crawl
    const crawlWorker = async (): Promise<void> => {
      for (;;) {
        if (stateOf(run) === 'stopping') return;
        while (stateOf(run) === 'paused') {
          await sleep(200);
          if (stateOf(run) === 'stopping') return;
        }
        if (record.pages.filter((page) => page.status === 'ok').length >= settings.maxPages) return;
        if (record.images.size >= settings.maxImages) return;

        const item = queue.shift();
        if (item === undefined) return;

        // Throttle: shared across workers so the site sees a steady rate.
        const now = Date.now();
        const wait = lastRequestAt + delayMs - now;
        lastRequestAt = Math.max(now, lastRequestAt) + delayMs;
        if (wait > 0) await sleep(wait, run.controller.signal);
        if (stateOf(run) === 'stopping') return;

        record.progress.currentUrl = item.url;
        record.progress.pagesQueued = queue.length;
        await crawlOne(run, item, policy, seen, queue, verifyQueue, stylesheetsSeen, () => {
          const available = stylesheetBudget;
          stylesheetBudget = Math.max(0, stylesheetBudget - 1);
          return available > 0;
        });
        record.updatedAt = Date.now();
      }
    };

    const workerCount = Math.max(1, Math.min(settings.concurrency, 6));
    try {
      await Promise.all(Array.from({ length: workerCount }, crawlWorker));
    } finally {
      crawling = false;
    }

    record.progress.phase = settings.verifyImages ? 'verifying' : 'deduplicating';
    record.progress.currentUrl = null;
    record.progress.message = settings.verifyImages
      ? 'Verifying image references…'
      : 'Consolidating duplicates…';
    await verifier;

    // Anything still pending (queued after the verifier finished) is drained here.
    if (settings.verifyImages && verifyQueue.length > 0 && stateOf(run) !== 'stopping') {
      await mapWithConcurrency(verifyQueue.splice(0), VERIFY_CONCURRENCY, (image) =>
        verifyOne(run, image),
      );
    }

    record.progress.phase = 'deduplicating';
    record.progress.message = 'Consolidating duplicates…';
    const contentDuplicates = markContentDuplicates([...record.images.values()]);
    record.progress.duplicates = countDuplicates(record);
    void contentDuplicates;

    record.status = stateOf(run) === 'stopping' ? 'stopped' : 'completed';
    record.progress.phase = 'done';
    record.progress.fraction = 1;
    record.progress.currentUrl = null;
    record.progress.message =
      record.status === 'stopped'
        ? `Stopped. ${record.images.size} unique images kept from ${record.progress.pagesScanned} pages.`
        : `Finished. ${record.images.size} unique images from ${record.progress.pagesScanned} pages.`;
    record.finishedAt = Date.now();
    record.updatedAt = Date.now();
    await store.touch(record.id);
  } catch (error) {
    record.status = 'failed';
    record.error = error instanceof Error ? error.message : 'The scan failed unexpectedly.';
    record.progress.phase = 'done';
    record.progress.message = record.error;
    record.finishedAt = Date.now();
    record.updatedAt = Date.now();
    pushIssue(record, {
      kind: 'network',
      url: record.url,
      title: 'Scan failed',
      detail: record.error,
      httpStatus: null,
    });
  }
}

async function crawlOne(
  run: ScanRun,
  item: QueueItem,
  policy: RobotsPolicy,
  seen: Set<string>,
  queue: QueueItem[],
  verifyQueue: DiscoveredImage[],
  stylesheetsSeen: Set<string>,
  takeStylesheetBudget: () => boolean,
): Promise<void> {
  const { record } = run;
  const settings = record.settings;
  const startedAt = Date.now();

  const page: CrawledPage = {
    url: item.url,
    label: pageLabel(item.url),
    title: null,
    depth: item.depth,
    status: 'ok',
    httpStatus: null,
    imageRefs: 0,
    error: null,
    fetchedAt: startedAt,
    durationMs: 0,
  };

  try {
    await validateTarget(item.url);

    const response = await safeFetch(item.url, {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      ...(item.referer ? { referer: item.referer } : {}),
      limits: { maxBytes: 3 * 1024 * 1024, timeoutMs: 20_000, maxRedirects: 5 },
      signal: run.controller.signal,
    });

    page.httpStatus = response.status;
    record.progress.bytesFetched += response.body.length;

    if (response.status >= 400) {
      page.status = 'error';
      page.error = `HTTP ${response.status}`;
      record.progress.pagesFailed += 1;
      pushIssue(record, {
        kind: 'http',
        url: item.url,
        title: 'Unable to retrieve this page.',
        detail: httpDetail(response.status),
        httpStatus: response.status,
      });
      return;
    }

    const contentType = (response.contentType ?? '').toLowerCase();
    if (contentType && !/text\/html|application\/xhtml|text\/plain|application\/xml/.test(contentType)) {
      page.status = 'skipped';
      page.error = `Not an HTML page (${contentType.split(';')[0]})`;
      return;
    }

    const html = response.body.toString('utf8');
    const extraction = extractFromHtml(html, response.url);
    page.title = extraction.title;
    page.imageRefs = extraction.images.length;
    record.progress.pagesScanned += 1;

    // -------------------------------------------------- record the images
    ingestRefs(run, extraction.images, response.url, extraction.title, verifyQueue);

    // ------------------------------------------- same-origin stylesheets
    if (settings.followStylesheets && stateOf(run) !== 'stopping') {
      for (const href of extraction.stylesheets) {
        if (record.images.size >= settings.maxImages) break;
        if (stylesheetsSeen.has(href)) continue;
        if (!isSameSite(href, record.origin, true)) continue;
        if (settings.respectRobots && !policy.isUrlAllowed(href)) continue;
        if (!takeStylesheetBudget()) break;
        stylesheetsSeen.add(href);
        await ingestStylesheet(run, href, response.url, extraction.title, verifyQueue);
      }
    }

    // ------------------------------------------------------------ links
    if (!extraction.metaNoFollow && item.depth < settings.maxDepth) {
      for (const link of extraction.links) {
        if (queue.length + record.progress.pagesScanned >= settings.maxPages * 2) break;
        if (!looksLikePage(link)) continue;
        if (!isSameSite(link, record.origin, settings.includeSubdomains)) continue;
        const canonical = canonicalPageUrl(link);
        if (seen.has(canonical)) continue;
        if (settings.respectRobots && !policy.isUrlAllowed(link)) continue;
        seen.add(canonical);
        queue.push({ url: link, depth: item.depth + 1, referer: response.url });
      }
    }

    record.progress.pagesQueued = queue.length;
    updateFraction(record);
  } catch (error) {
    if (stateOf(run) === 'stopping') return;
    page.status = 'error';
    page.error = error instanceof Error ? error.message : 'Request failed';
    record.progress.pagesFailed += 1;
    pushIssue(record, {
      kind: error instanceof UrlSecurityError ? 'blocked' : error instanceof HttpFetchError ? kindForHttpError(error) : 'network',
      url: item.url,
      title: 'Unable to retrieve this page.',
      detail: page.error,
      httpStatus: error instanceof HttpFetchError ? error.httpStatus : null,
    });
  } finally {
    page.durationMs = Date.now() - startedAt;
    addPage(record, page);
  }
}

async function ingestStylesheet(
  run: ScanRun,
  href: string,
  sourcePage: string,
  pageTitle: string | null,
  verifyQueue: DiscoveredImage[],
): Promise<void> {
  const { record } = run;
  try {
    const response = await safeFetch(href, {
      accept: 'text/css,*/*;q=0.5',
      referer: sourcePage,
      limits: { maxBytes: 1.5 * 1024 * 1024, timeoutMs: 12_000, maxRedirects: 3 },
      signal: run.controller.signal,
    });
    if (response.status >= 400) return;
    record.progress.bytesFetched += response.body.length;

    const css = response.body.toString('utf8');
    const refs: RawImageRef[] = [];
    for (const found of extractCssUrls(css, 200)) {
      const resolved = resolveUrl(found.url, response.url);
      if (!resolved) continue;
      refs.push({
        originalUrl: resolved.original,
        resolvedUrl: resolved.resolved,
        sourceType: 'css-stylesheet',
        isLazyLoaded: false,
        altText: null,
        title: null,
        declaredWidth: null,
        declaredHeight: null,
        descriptor: null,
        elementPath: found.context,
        contextHint: `stylesheet ${filenameFromUrl(href)}${found.context ? ` | ${found.context}` : ''}`,
      });
    }
    ingestRefs(run, refs, sourcePage, pageTitle, verifyQueue);
  } catch {
    // A stylesheet that cannot be read simply yields no background images.
  }
}

/** Convert raw references into consolidated assets on the record. */
function ingestRefs(
  run: ScanRun,
  refs: RawImageRef[],
  sourcePage: string,
  pageTitle: string | null,
  verifyQueue: DiscoveredImage[],
): void {
  const { record } = run;
  const settings = record.settings;
  const label = pageLabel(sourcePage);

  for (const ref of refs) {
    record.progress.references += 1;

    if (!settings.includeExternalImages && !isSameSite(ref.resolvedUrl, record.origin, true)) {
      continue;
    }
    if (record.images.size >= settings.maxImages) {
      if (!record.issues.some((issue) => issue.kind === 'limit' && issue.title === 'Image limit reached')) {
        pushIssue(record, {
          kind: 'limit',
          url: null,
          title: 'Image limit reached',
          detail: `The scan stopped collecting new assets at ${settings.maxImages}. Raise "Maximum images" in settings to collect more.`,
          httpStatus: null,
        });
      }
      return;
    }

    const key = dedupeKey(ref.resolvedUrl);
    const reference: ImageReference = {
      sourcePage,
      sourcePageLabel: label,
      sourcePageTitle: pageTitle,
      originalUrl: ref.originalUrl,
      sourceType: ref.sourceType,
      isLazyLoaded: ref.isLazyLoaded,
      altText: ref.altText,
      title: ref.title,
      declaredWidth: ref.declaredWidth,
      declaredHeight: ref.declaredHeight,
      descriptor: ref.descriptor,
      elementPath: ref.elementPath,
    };

    const existing = record.images.get(key);
    if (existing) {
      mergeReference(existing, reference, ref.contextHint);
      continue;
    }

    record.seq += 1;
    const canonical = canonicalUrl(ref.resolvedUrl);
    const id = imageIdFor(record.id, canonical);
    const extension = extensionFromUrl(ref.resolvedUrl);
    const width = ref.declaredWidth;
    const height = ref.declaredHeight;

    const classification = classifyImage({
      url: ref.resolvedUrl,
      filename: filenameFromUrl(ref.resolvedUrl),
      extension,
      mimeType: null,
      width: null,
      height: null,
      altText: ref.altText,
      title: ref.title,
      sourceTypes: [ref.sourceType],
      contextHints: ref.contextHint ? [ref.contextHint] : [],
      pageUrl: sourcePage,
      pageTitle,
      declaredWidth: width,
      declaredHeight: height,
    });

    const image: DiscoveredImage = {
      id,
      url: ref.resolvedUrl,
      originalUrl: ref.originalUrl,
      canonicalUrl: canonical,
      sourcePage,
      sourcePageLabel: label,
      sourcePageTitle: pageTitle,
      references: [reference],
      pageCount: 1,
      referenceCount: 1,
      filename: filenameFromUrl(ref.resolvedUrl),
      extension,
      mimeType: null,
      width: null,
      height: null,
      aspectRatio: null,
      orientation: 'unknown',
      sizeBucket: 'unknown',
      fileSize: null,
      altText: ref.altText,
      title: ref.title,
      sourceTypes: [ref.sourceType],
      isLazyLoaded: ref.isLazyLoaded,
      category: classification.category,
      categoryConfidence: classification.confidence,
      categoryReasons: classification.reasons,
      status: 'unverified',
      httpStatus: null,
      finalUrl: null,
      statusMessage: null,
      isDuplicate: false,
      duplicateOf: null,
      contentHash: null,
      variantGroup: variantGroupKey(ref.resolvedUrl),
      belowMinimumSize: false,
      discoveredAt: Date.now(),
      seq: record.seq,
    };

    // Context hints are needed again when the classifier re-runs post-verification.
    contextHints.set(image, ref.contextHint ? [ref.contextHint] : []);

    record.images.set(key, image);
    record.idIndex.set(id, key);
    record.progress.uniqueImages = record.images.size;
    if (record.settings.verifyImages) verifyQueue.push(image);
  }

  record.progress.duplicates = Math.max(0, record.progress.references - record.progress.uniqueImages);
  updateFraction(record);
}

/**
 * Classification hints kept out of the serialised asset to keep payloads small.
 * A WeakMap means the hints disappear together with the scan record they belong
 * to, so nothing accumulates between scans.
 */
const contextHints = new WeakMap<DiscoveredImage, string[]>();

function mergeReference(image: DiscoveredImage, reference: ImageReference, hint: string | null): void {
  const duplicateReference = image.references.some(
    (existing) =>
      existing.sourcePage === reference.sourcePage &&
      existing.sourceType === reference.sourceType &&
      existing.descriptor === reference.descriptor &&
      existing.elementPath === reference.elementPath,
  );
  if (!duplicateReference) {
    if (image.references.length < 60) image.references.push(reference);
    image.referenceCount += 1;
  }

  const pages = new Set(image.references.map((entry) => entry.sourcePage));
  pages.add(reference.sourcePage);
  image.pageCount = pages.size;

  if (!image.altText && reference.altText) image.altText = reference.altText;
  if (!image.title && reference.title) image.title = reference.title;
  if (!image.sourceTypes.includes(reference.sourceType)) image.sourceTypes.push(reference.sourceType);
  if (reference.isLazyLoaded) image.isLazyLoaded = true;

  if (hint) {
    const hints = contextHints.get(image) ?? [];
    if (hints.length < 8 && !hints.includes(hint)) {
      hints.push(hint);
      contextHints.set(image, hints);
    }
  }
}

/** Background pool that verifies assets as they are discovered. */
async function runVerifier(
  run: ScanRun,
  queue: DiscoveredImage[],
  stillCrawling: () => boolean,
): Promise<void> {
  const workers = Array.from({ length: VERIFY_CONCURRENCY }, async () => {
    for (;;) {
      if (stateOf(run) === 'stopping') return;
      const image = queue.shift();
      if (!image) {
        if (!stillCrawling()) return;
        await sleep(120);
        continue;
      }
      await verifyOne(run, image);
    }
  });
  await Promise.all(workers);
}

async function verifyOne(run: ScanRun, image: DiscoveredImage): Promise<void> {
  const { record } = run;
  if (stateOf(run) === 'stopping') return;

  const result = await probeImage(image.url, image.sourcePage);
  record.progress.verified += 1;
  record.progress.bytesFetched += result.bytesRead;

  image.status = result.status;
  image.httpStatus = result.httpStatus;
  image.statusMessage = result.message;
  image.finalUrl = result.finalUrl && result.finalUrl !== image.url ? result.finalUrl : null;
  image.contentHash = result.contentHash;
  if (result.mimeType) image.mimeType = result.mimeType;
  if (result.fileSize != null) image.fileSize = result.fileSize;

  if (result.width && result.height) {
    image.width = result.width;
    image.height = result.height;
    image.aspectRatio = Number((result.width / result.height).toFixed(4));
    image.orientation = orientationOf(result.width, result.height);
    image.sizeBucket = sizeBucketOf(result.width, result.height);
    image.belowMinimumSize =
      result.width < record.settings.minImageWidth || result.height < record.settings.minImageHeight;
  }

  if (result.status === 'unavailable' && result.message) {
    pushIssue(record, {
      kind: 'image',
      url: image.url,
      title: 'Image unavailable',
      detail: result.message,
      httpStatus: result.httpStatus,
    });
  }

  // Re-classify now that the real format and dimensions are known.
  const classification = classifyImage({
    url: image.url,
    filename: image.filename,
    extension: image.extension,
    mimeType: image.mimeType,
    width: image.width,
    height: image.height,
    altText: image.altText,
    title: image.title,
    sourceTypes: image.sourceTypes,
    contextHints: contextHints.get(image) ?? [],
    pageUrl: image.sourcePage,
    pageTitle: image.sourcePageTitle,
    declaredWidth: image.references[0]?.declaredWidth ?? null,
    declaredHeight: image.references[0]?.declaredHeight ?? null,
  });
  image.category = classification.category;
  image.categoryConfidence = classification.confidence;
  image.categoryReasons = classification.reasons;

  record.updatedAt = Date.now();
  updateFraction(record);
}

function countDuplicates(record: ScanRecord): number {
  let count = 0;
  for (const image of record.images.values()) if (image.isDuplicate) count += 1;
  return count + Math.max(0, record.progress.references - record.progress.uniqueImages);
}

function updateFraction(record: ScanRecord): void {
  const pageShare = Math.min(1, record.progress.pagesScanned / Math.max(1, record.settings.maxPages));
  const verifyShare = record.settings.verifyImages
    ? Math.min(1, record.progress.verified / Math.max(1, record.progress.uniqueImages))
    : 1;
  const value = record.progress.phase === 'crawling' ? pageShare * 0.7 + verifyShare * 0.2 : 0.9;
  record.progress.fraction = Math.max(record.progress.fraction, Math.min(0.98, value));
}

function pushIssue(record: ScanRecord, issue: Omit<ScanIssue, 'id' | 'at'>): void {
  addIssue(record, { ...issue, id: issueId(), at: Date.now() });
}

function kindForHttpError(error: HttpFetchError): ScanIssue['kind'] {
  if (error.code === 'timeout') return 'timeout';
  if (error.code === 'too-large') return 'limit';
  return 'network';
}

function httpDetail(status: number): string {
  if (status === 403) return 'HTTP status: 403\nThe page did not permit the scanner to retrieve its contents.';
  if (status === 401) return 'HTTP status: 401\nThis page requires authentication, which the scanner does not attempt.';
  if (status === 404) return 'HTTP status: 404\nThe server reported that this page does not exist.';
  if (status === 429) return 'HTTP status: 429\nThe server asked the scanner to slow down. Increase the request delay and try again.';
  return `HTTP status: ${status}\nThe server did not return the page contents.`;
}

export function titleOf(value: string | null | undefined): string | null {
  return cleanText(value);
}
