/**
 * Shared domain types for the image explorer.
 *
 * These types are used verbatim across the crawler, the API routes and the
 * React client, so they must stay serialisable (no class instances, no Dates).
 */

/** How an image reference was discovered inside a page. */
export type DiscoverySource =
  | 'img'
  | 'srcset'
  | 'picture-source'
  | 'lazy-attribute'
  | 'og-image'
  | 'twitter-image'
  | 'schema-org'
  | 'link-icon'
  | 'css-inline'
  | 'css-stylesheet'
  | 'video-poster'
  | 'svg-image'
  | 'input-image'
  | 'meta-other'
  | 'anchor-href'
  | 'data-attribute'
  | 'map-embed';

/**
 * What kind of file an asset is.
 *
 * The pipeline (normalise, deduplicate, verify, classify, export, select,
 * download) is identical for both; only the preview and the verification
 * content-type check differ.
 */
export type AssetKind = 'image' | 'geo';

/** Geographic data formats the scanner recognises. */
export type GeoFormat = 'kml' | 'kmz' | 'geojson' | 'gpx' | 'gml' | 'shapefile-zip' | 'topojson';

/** Heuristic classification bucket. Never presented as a guaranteed fact. */
export type ImageCategory =
  | 'map'
  | 'logo'
  | 'icon'
  | 'photo'
  | 'illustration'
  | 'thumbnail'
  | 'background'
  | 'screenshot'
  | 'unknown';

/** Result of attempting to verify that an image URL is actually retrievable. */
export type ImageStatus =
  | 'available'
  | 'unavailable'
  | 'redirected'
  | 'duplicate'
  | 'unsupported'
  | 'unverified';

export type Orientation = 'landscape' | 'portrait' | 'square' | 'panorama' | 'unknown';

export type SizeBucket = 'tiny' | 'small' | 'medium' | 'large' | 'very-large' | 'unknown';

export type ScanStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'stopping'
  | 'completed'
  | 'stopped'
  | 'failed';

export type ScanPhase =
  | 'idle'
  | 'validating'
  | 'robots'
  | 'crawling'
  | 'extracting'
  | 'verifying'
  | 'deduplicating'
  | 'done';

/** A single place an image was referenced from. Many of these map to one image. */
export interface ImageReference {
  /** Page the reference was found on. */
  sourcePage: string;
  /** Human readable trail for the source page, e.g. "example.com → maps → ahmedabad". */
  sourcePageLabel: string;
  /** Title of the page, when the page provided one. */
  sourcePageTitle: string | null;
  /** The URL exactly as it appeared in the markup, before resolution. */
  originalUrl: string;
  /** How this particular reference was found. */
  sourceType: DiscoverySource;
  /** True when the reference came from a lazy-loading attribute. */
  isLazyLoaded: boolean;
  /** alt text of the referencing element, if any. */
  altText: string | null;
  /** title attribute of the referencing element, if any. */
  title: string | null;
  /** Intrinsic width declared in markup (width attribute), if any. */
  declaredWidth: number | null;
  /** Intrinsic height declared in markup (height attribute), if any. */
  declaredHeight: number | null;
  /** srcset descriptor for this candidate, e.g. "2x" or "1280w". */
  descriptor: string | null;
  /** CSS selector-ish breadcrumb of the element, for context. */
  elementPath: string | null;
}

/** A unique image asset, consolidated from one or more references. */
export interface DiscoveredImage {
  id: string;
  /** Image or geographic-data file. Defaults to 'image'. */
  assetKind: AssetKind;
  /** Set only when assetKind is 'geo'. */
  geoFormat: GeoFormat | null;
  /** Features parsed out of a geographic file. Null when it was not parsed. */
  featureCount: number | null;
  /** Problems encountered while reading the geometry, shown verbatim. */
  geometryWarnings: string[];
  /** Canonical, absolute, de-tracked URL used as the identity of the asset. */
  url: string;
  /** The first raw URL seen for this asset, preserved verbatim. */
  originalUrl: string;
  /** Canonical form used for duplicate detection. */
  canonicalUrl: string;
  /** The page this image was first discovered on. */
  sourcePage: string;
  sourcePageLabel: string;
  sourcePageTitle: string | null;
  /** Every place this image was referenced from. */
  references: ImageReference[];
  /** Distinct source pages this image appears on. */
  pageCount: number;
  /** Number of raw references consolidated into this asset. */
  referenceCount: number;

  filename: string;
  extension: string | null;
  mimeType: string | null;

  width: number | null;
  height: number | null;
  aspectRatio: number | null;
  orientation: Orientation;
  sizeBucket: SizeBucket;
  /** Bytes, when the server learned the real size. */
  fileSize: number | null;

  altText: string | null;
  title: string | null;

  /** Discovery methods across all references, most significant first. */
  sourceTypes: DiscoverySource[];
  isLazyLoaded: boolean;

  /** Heuristic category and why it was chosen. Always shown as "detected". */
  category: ImageCategory;
  categoryConfidence: number;
  categoryReasons: string[];

  status: ImageStatus;
  /** HTTP status of the verification request, when one was made. */
  httpStatus: number | null;
  /** Final URL after redirects, when it differed from the requested URL. */
  finalUrl: string | null;
  /** Human readable reason the asset could not be verified. */
  statusMessage: string | null;
  /** True when this asset was folded into another asset by content hash. */
  isDuplicate: boolean;
  /** id of the asset this one duplicates, when isDuplicate is true. */
  duplicateOf: string | null;
  /** sha-256 of the full response body, only set when the whole body was read. */
  contentHash: string | null;
  /** Group key shared by responsive variants of the same underlying artwork. */
  variantGroup: string | null;
  /** True when verified dimensions fall below the scan's minimum size setting. */
  belowMinimumSize: boolean;

  /** ms timestamp the asset was first discovered, used for "newest" sorting. */
  discoveredAt: number;
  /** Monotonic sequence number, used for stable incremental fetching. */
  seq: number;
}

/** A page the crawler visited (or tried to). */
export interface CrawledPage {
  url: string;
  label: string;
  title: string | null;
  depth: number;
  status: 'ok' | 'error' | 'skipped';
  httpStatus: number | null;
  imageRefs: number;
  error: string | null;
  fetchedAt: number;
  durationMs: number;
}

/** A user facing problem encountered during a scan. */
export interface ScanIssue {
  id: string;
  kind:
    | 'network'
    | 'http'
    | 'robots'
    | 'invalid-url'
    | 'blocked'
    | 'limit'
    | 'timeout'
    | 'parse'
    | 'image';
  url: string | null;
  title: string;
  detail: string;
  httpStatus: number | null;
  at: number;
}

/** Everything the user can tune before starting a crawl. */
export interface ScanSettings {
  maxPages: number;
  maxDepth: number;
  requestDelayMs: number;
  includeSubdomains: boolean;
  includeExternalImages: boolean;
  minImageWidth: number;
  minImageHeight: number;
  /** Ask the server to fetch each image to confirm it exists and read its size. */
  verifyImages: boolean;
  /** Parse same-origin stylesheets for background-image references. */
  followStylesheets: boolean;
  /** Seed the crawl from sitemaps advertised in robots.txt. */
  useSitemap: boolean;
  /** Obey robots.txt disallow rules. Enabled by default and strongly recommended. */
  respectRobots: boolean;
  /** Hard ceiling on unique assets, protects the browser and the server. */
  maxImages: number;
  /** Simultaneous outbound requests. */
  concurrency: number;
}

export interface RobotsInfo {
  checked: boolean;
  found: boolean;
  url: string;
  /** Crawl-delay advertised for our user-agent, in ms. */
  crawlDelayMs: number | null;
  disallowedPaths: number;
  sitemaps: string[];
  policy: 'respecting' | 'ignored-by-setting' | 'unavailable';
  note: string | null;
}

export interface ScanProgress {
  phase: ScanPhase;
  /** 0..1, best effort. */
  fraction: number;
  currentUrl: string | null;
  message: string;
  pagesScanned: number;
  pagesQueued: number;
  pagesFailed: number;
  maxPages: number;
  references: number;
  uniqueImages: number;
  duplicates: number;
  verified: number;
  bytesFetched: number;
}

export interface ScanSummary {
  id: string;
  url: string;
  origin: string;
  host: string;
  status: ScanStatus;
  settings: ScanSettings;
  robots: RobotsInfo | null;
  progress: ScanProgress;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  /** Number of images currently stored for this scan. */
  imageCount: number;
  issueCount: number;
}

/** Full scan record returned by GET /api/scan/:id. */
export interface ScanDetail extends ScanSummary {
  pages: CrawledPage[];
  issues: ScanIssue[];
  /** Highest seq assigned so far; clients use it as an incremental cursor. */
  cursor: number;
}

export interface ScanImagesPage {
  scanId: string;
  images: DiscoveredImage[];
  cursor: number;
  total: number;
  /** True while the scan is still producing results. */
  live: boolean;
}

export interface CreateScanRequest {
  url: string;
  settings?: Partial<ScanSettings>;
}

export interface CreateScanResponse {
  scanId: string;
  status: ScanStatus;
  url: string;
}

export type ExportFormat = 'csv' | 'json' | 'txt';

export interface ExportRequest {
  scanId: string;
  format: ExportFormat;
  /** When provided, only these image ids are exported. */
  imageIds?: string[];
  /** Optional user category overrides, applied to the exported rows. */
  categoryOverrides?: Record<string, ImageCategory>;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    detail?: string;
    httpStatus?: number;
  };
}
