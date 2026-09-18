import { createHash, randomUUID } from 'node:crypto';

export function newScanId(): string {
  return `scan_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/** Deterministic id for an asset, so the same URL keeps the same id within a scan. */
export function imageIdFor(scanId: string, canonicalUrl: string): string {
  const digest = createHash('sha1').update(`${scanId}|${canonicalUrl}`).digest('hex');
  return `img_${digest.slice(0, 20)}`;
}

export function issueId(): string {
  return `iss_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}
