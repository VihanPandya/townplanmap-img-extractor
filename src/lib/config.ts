import type { ScanSettings } from '@/lib/types';

/** The site the tool ships pointed at. Editable by the user at any time. */
export const DEFAULT_TARGET_URL = 'https://townplanmap.com';

/** Conservative defaults - deliberately gentle on the site being scanned. */
export const DEFAULT_SETTINGS: ScanSettings = {
  maxPages: 100,
  maxDepth: 3,
  requestDelayMs: 500,
  includeSubdomains: false,
  includeExternalImages: false,
  minImageWidth: 100,
  minImageHeight: 100,
  verifyImages: true,
  followStylesheets: true,
  useSitemap: true,
  respectRobots: true,
  maxImages: 1500,
  concurrency: 3,
};

/** Hard ceilings. User settings are clamped to these before a scan starts. */
export const SETTING_BOUNDS = {
  maxPages: { min: 1, max: 500 },
  maxDepth: { min: 0, max: 8 },
  requestDelayMs: { min: 0, max: 10_000 },
  minImageWidth: { min: 0, max: 5000 },
  minImageHeight: { min: 0, max: 5000 },
  maxImages: { min: 10, max: 5000 },
  concurrency: { min: 1, max: 8 },
} as const;

/** Stylesheets fetched per scan when background-image scanning is enabled. */
export const MAX_STYLESHEETS_PER_SCAN = 25;

/** Concurrent image verification requests. */
export const VERIFY_CONCURRENCY = 4;

function clampNumber(value: unknown, fallback: number, bounds: { min: number; max: number }): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(parsed)));
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

/** Validate and clamp partial settings coming from the client. */
export function normaliseSettings(input: Partial<ScanSettings> | undefined): ScanSettings {
  const source = input ?? {};
  return {
    maxPages: clampNumber(source.maxPages, DEFAULT_SETTINGS.maxPages, SETTING_BOUNDS.maxPages),
    maxDepth: clampNumber(source.maxDepth, DEFAULT_SETTINGS.maxDepth, SETTING_BOUNDS.maxDepth),
    requestDelayMs: clampNumber(source.requestDelayMs, DEFAULT_SETTINGS.requestDelayMs, SETTING_BOUNDS.requestDelayMs),
    includeSubdomains: asBoolean(source.includeSubdomains, DEFAULT_SETTINGS.includeSubdomains),
    includeExternalImages: asBoolean(source.includeExternalImages, DEFAULT_SETTINGS.includeExternalImages),
    minImageWidth: clampNumber(source.minImageWidth, DEFAULT_SETTINGS.minImageWidth, SETTING_BOUNDS.minImageWidth),
    minImageHeight: clampNumber(source.minImageHeight, DEFAULT_SETTINGS.minImageHeight, SETTING_BOUNDS.minImageHeight),
    verifyImages: asBoolean(source.verifyImages, DEFAULT_SETTINGS.verifyImages),
    followStylesheets: asBoolean(source.followStylesheets, DEFAULT_SETTINGS.followStylesheets),
    useSitemap: asBoolean(source.useSitemap, DEFAULT_SETTINGS.useSitemap),
    respectRobots: asBoolean(source.respectRobots, DEFAULT_SETTINGS.respectRobots),
    maxImages: clampNumber(source.maxImages, DEFAULT_SETTINGS.maxImages, SETTING_BOUNDS.maxImages),
    concurrency: clampNumber(source.concurrency, DEFAULT_SETTINGS.concurrency, SETTING_BOUNDS.concurrency),
  };
}
