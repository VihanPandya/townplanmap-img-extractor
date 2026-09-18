/**
 * Scan storage.
 *
 * The application ships with an in-process store: scan results live in memory
 * for a bounded time and a bounded count, which is the right default for a
 * tool that produces disposable, per-session results.
 *
 * `ScanStore` is deliberately a narrow interface so a persistent adapter (for
 * example PostgreSQL, keyed on scan id) can be dropped in without touching the
 * crawler or the API routes.
 */

import type { GeoParseResult } from '@/lib/geo/types';
import type {
  CrawledPage,
  DiscoveredImage,
  ScanDetail,
  ScanIssue,
  ScanSummary,
} from '@/lib/types';

/** Mutable server-side state for one scan. */
export interface ScanRecord extends Omit<ScanDetail, 'imageCount' | 'issueCount' | 'cursor'> {
  /** Canonical URL -> asset. The insertion order is the discovery order. */
  images: Map<string, DiscoveredImage>;
  /** Image id -> canonical URL, for O(1) lookup by id. */
  idIndex: Map<string, string>;
  /** Geometry parsed from each geographic asset, keyed by that asset's id. */
  geometry: Map<string, GeoParseResult>;
  seq: number;
  updatedAt: number;
}

export interface ImageQuery {
  /** Only return assets whose seq is greater than this. */
  since?: number;
  limit?: number;
  includeBelowMinimum?: boolean;
}

export interface ScanStore {
  create(record: ScanRecord): Promise<void>;
  get(scanId: string): Promise<ScanRecord | null>;
  list(limit: number): Promise<ScanSummary[]>;
  images(scanId: string, query: ImageQuery): Promise<{ images: DiscoveredImage[]; total: number; cursor: number }>;
  image(scanId: string, imageId: string): Promise<DiscoveredImage | null>;
  findImageAnywhere(imageId: string): Promise<{ scanId: string; image: DiscoveredImage } | null>;
  touch(scanId: string): Promise<void>;
  remove(scanId: string): Promise<void>;
}

const MAX_SCANS = 12;
const SCAN_TTL_MS = 2 * 60 * 60 * 1000;

class MemoryScanStore implements ScanStore {
  private readonly scans = new Map<string, ScanRecord>();

  async create(record: ScanRecord): Promise<void> {
    this.evict();
    this.scans.set(record.id, record);
  }

  async get(scanId: string): Promise<ScanRecord | null> {
    const record = this.scans.get(scanId);
    if (!record) return null;
    if (Date.now() - record.updatedAt > SCAN_TTL_MS && isFinished(record)) {
      this.scans.delete(scanId);
      return null;
    }
    return record;
  }

  async list(limit: number): Promise<ScanSummary[]> {
    return [...this.scans.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit)
      .map(toSummary);
  }

  async images(scanId: string, query: ImageQuery): Promise<{ images: DiscoveredImage[]; total: number; cursor: number }> {
    const record = await this.get(scanId);
    if (!record) return { images: [], total: 0, cursor: 0 };

    const since = query.since ?? 0;
    const includeBelow = query.includeBelowMinimum ?? true;
    const all = [...record.images.values()];
    const eligible = includeBelow ? all : all.filter((image) => !image.belowMinimumSize);
    const selected = eligible.filter((image) => image.seq > since).sort((a, b) => a.seq - b.seq);
    const limited = query.limit ? selected.slice(0, query.limit) : selected;

    return { images: limited, total: eligible.length, cursor: record.seq };
  }

  async image(scanId: string, imageId: string): Promise<DiscoveredImage | null> {
    const record = await this.get(scanId);
    if (!record) return null;
    const key = record.idIndex.get(imageId);
    return key ? (record.images.get(key) ?? null) : null;
  }

  async findImageAnywhere(imageId: string): Promise<{ scanId: string; image: DiscoveredImage } | null> {
    for (const record of this.scans.values()) {
      const key = record.idIndex.get(imageId);
      if (!key) continue;
      const image = record.images.get(key);
      if (image) return { scanId: record.id, image };
    }
    return null;
  }

  async touch(scanId: string): Promise<void> {
    const record = this.scans.get(scanId);
    if (record) record.updatedAt = Date.now();
  }

  async remove(scanId: string): Promise<void> {
    this.scans.delete(scanId);
  }

  /** Drop finished scans that are old, then the oldest scan if still over budget. */
  private evict(): void {
    const now = Date.now();
    for (const [id, record] of this.scans) {
      if (isFinished(record) && now - record.updatedAt > SCAN_TTL_MS) this.scans.delete(id);
    }
    while (this.scans.size >= MAX_SCANS) {
      let oldest: ScanRecord | null = null;
      for (const record of this.scans.values()) {
        if (!isFinished(record)) continue;
        if (!oldest || record.startedAt < oldest.startedAt) oldest = record;
      }
      if (!oldest) break;
      this.scans.delete(oldest.id);
    }
  }
}

function isFinished(record: ScanRecord): boolean {
  return record.status === 'completed' || record.status === 'stopped' || record.status === 'failed';
}

export function toSummary(record: ScanRecord): ScanSummary {
  return {
    id: record.id,
    url: record.url,
    origin: record.origin,
    host: record.host,
    status: record.status,
    settings: record.settings,
    robots: record.robots,
    progress: record.progress,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    error: record.error,
    imageCount: record.images.size,
    issueCount: record.issues.length,
  };
}

export function toDetail(record: ScanRecord): ScanDetail {
  return {
    ...toSummary(record),
    pages: record.pages.slice(-300),
    issues: record.issues.slice(-120),
    cursor: record.seq,
  };
}

export function addPage(record: ScanRecord, page: CrawledPage): void {
  record.pages.push(page);
  if (record.pages.length > 1000) record.pages.splice(0, record.pages.length - 1000);
  record.updatedAt = Date.now();
}

export function addIssue(record: ScanRecord, issue: ScanIssue): void {
  record.issues.push(issue);
  if (record.issues.length > 400) record.issues.splice(0, record.issues.length - 400);
  record.updatedAt = Date.now();
}

/**
 * Next.js reloads server modules in development, so the store is parked on
 * globalThis to keep running scans addressable across recompiles.
 */
const globalRef = globalThis as typeof globalThis & { __imageScanStore?: ScanStore };

export function getScanStore(): ScanStore {
  if (!globalRef.__imageScanStore) {
    globalRef.__imageScanStore = new MemoryScanStore();
  }
  return globalRef.__imageScanStore;
}
