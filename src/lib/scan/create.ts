/**
 * Scan creation: validate the target, build the record, hand it to the engine.
 */

import { normaliseSettings } from '@/lib/config';
import { getScanStore, type ScanRecord } from '@/lib/database/store';
import { canonicalPageUrl } from '@/lib/normalizer/url';
import { parseTargetUrl, UrlSecurityError, validateTarget } from '@/lib/security/url-guard';
import { startScan } from '@/lib/scan/engine';
import type { CreateScanResponse, ScanSettings } from '@/lib/types';
import { newScanId } from '@/lib/utils/id';

export interface CreateScanInput {
  url: string;
  settings?: Partial<ScanSettings>;
}

export async function createScan(input: CreateScanInput): Promise<CreateScanResponse> {
  const parsed = parseTargetUrl(input.url);
  // Resolve DNS and refuse non-public destinations before anything is queued.
  await validateTarget(parsed);

  const settings = normaliseSettings(input.settings);
  const startUrl = canonicalPageUrl(parsed.toString());
  const now = Date.now();

  const record: ScanRecord = {
    id: newScanId(),
    url: startUrl,
    origin: parsed.origin,
    host: parsed.hostname,
    status: 'queued',
    settings,
    robots: null,
    progress: {
      phase: 'validating',
      fraction: 0,
      currentUrl: null,
      message: 'Connecting to the website…',
      pagesScanned: 0,
      pagesQueued: 1,
      pagesFailed: 0,
      maxPages: settings.maxPages,
      references: 0,
      uniqueImages: 0,
      duplicates: 0,
      verified: 0,
      bytesFetched: 0,
    },
    startedAt: now,
    finishedAt: null,
    error: null,
    pages: [],
    issues: [],
    images: new Map(),
    idIndex: new Map(),
    geometry: new Map(),
    seq: 0,
    updatedAt: now,
  };

  await getScanStore().create(record);
  startScan(record);

  return { scanId: record.id, status: 'running', url: startUrl };
}

export { UrlSecurityError };
