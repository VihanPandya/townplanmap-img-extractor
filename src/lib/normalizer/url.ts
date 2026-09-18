import type { GeoFormat } from '@/lib/types';

/**
 * URL resolution and canonicalisation.
 *
 * `resolveUrl` turns whatever appeared in the markup into an absolute URL.
 * `canonicalUrl` produces the identity key used for duplicate detection: it
 * removes only parameters that are known to be irrelevant to the bytes served,
 * so two genuinely different images are never collapsed together.
 */

/** Query parameters that never change which bytes a server returns. */
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_reader',
  'utm_name',
  'gclid',
  'gbraid',
  'wbraid',
  'dclid',
  'fbclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'ttclid',
  'twclid',
  'yclid',
  '_ga',
  '_gl',
  'ref_src',
  'ref_url',
  'spm',
  'scm',
  'from_source',
  'wpmp_switcher',
  'hsa_acc',
  'hsa_cam',
  'hsa_grp',
  'hsa_ad',
]);

/**
 * Cache-busting parameters. They do change the URL string but not the asset,
 * so they are dropped for identity purposes while the original URL is kept.
 */
const CACHE_BUSTER_PARAMS = new Set(['v', 'ver', 'version', 'rev', 'cb', '_', 'ts', 'timestamp', 'nocache']);

const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' };

const INDEX_FILES = /\/(index|default|home)\.(html?|php|aspx?|jsp)$/i;

export interface ResolveResult {
  /** Absolute URL, fragment removed. */
  resolved: string;
  /** The string exactly as it appeared in the document. */
  original: string;
}

/** True for values that are not fetchable URLs (data:, blob:, javascript:, ...). */
export function isFetchableUrlCandidate(raw: string): boolean {
  const value = raw.trim();
  if (!value) return false;
  if (value.startsWith('#')) return false;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value);
  if (scheme) {
    const protocol = `${scheme[1]!.toLowerCase()}:`;
    return protocol === 'http:' || protocol === 'https:';
  }
  return true;
}

/** Resolve a possibly relative URL against a base. Returns null when unusable. */
export function resolveUrl(raw: string, base: string): ResolveResult | null {
  const original = raw.trim();
  if (!isFetchableUrlCandidate(original)) return null;
  try {
    const url = new URL(original, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return { resolved: url.toString(), original };
  } catch {
    return null;
  }
}

export interface CanonicalOptions {
  /** Also strip version-style cache busters. Defaults to true. */
  stripCacheBusters?: boolean;
}

/** Identity form of a URL, used as the deduplication key. */
export function canonicalUrl(input: string, options: CanonicalOptions = {}): string {
  const stripCacheBusters = options.stripCacheBusters ?? true;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return input;
  }

  url.hash = '';
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.port && DEFAULT_PORTS[url.protocol] === url.port) url.port = '';

  const params = url.searchParams;
  const drop: string[] = [];
  for (const key of params.keys()) {
    const lower = key.toLowerCase();
    if (TRACKING_PARAMS.has(lower) || lower.startsWith('utm_')) drop.push(key);
    else if (stripCacheBusters && CACHE_BUSTER_PARAMS.has(lower)) drop.push(key);
  }
  for (const key of drop) params.delete(key);

  // Stable parameter order so ?a=1&b=2 and ?b=2&a=1 collapse together.
  const entries = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const sorted = new URLSearchParams();
  for (const [key, value] of entries) sorted.append(key, value);
  url.search = sorted.toString();

  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/{2,}/g, '/');
  }

  return url.toString();
}

/** Canonical form for a *page*, which additionally folds index files and trailing slashes. */
export function canonicalPageUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(canonicalUrl(input));
  } catch {
    return input;
  }
  url.pathname = url.pathname.replace(INDEX_FILES, '/');
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }
  if (url.pathname === '') url.pathname = '/';
  return url.toString();
}

/** Filename portion of a URL path, decoded when possible. */
export function filenameFromUrl(input: string): string {
  try {
    const url = new URL(input);
    const segments = url.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (!last) return url.hostname;
    try {
      return decodeURIComponent(last);
    } catch {
      return last;
    }
  } catch {
    return input.split('/').pop() || input;
  }
}

const KNOWN_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'svg',
  'avif',
  'bmp',
  'ico',
  'tif',
  'tiff',
  'jfif',
  'apng',
  'heic',
  'heif',
]);

/** Lower-cased extension taken from the path, or null when there isn't a plausible one. */
export function extensionFromUrl(input: string): string | null {
  const filename = filenameFromUrl(input);
  const match = /\.([a-z0-9]{2,5})$/i.exec(filename);
  if (!match) return null;
  const ext = match[1]!.toLowerCase();
  return KNOWN_EXTENSIONS.has(ext) ? ext : null;
}

/** True when two URLs share a registrable-ish origin, honouring a subdomain policy. */
export function isSameSite(candidate: string, origin: string, includeSubdomains: boolean): boolean {
  try {
    const a = new URL(candidate);
    const b = new URL(origin);
    if (a.hostname === b.hostname) return true;
    if (!includeSubdomains) return false;
    const base = registrableSuffix(b.hostname);
    return a.hostname === base || a.hostname.endsWith(`.${base}`);
  } catch {
    return false;
  }
}

/** Naive eTLD+1: good enough to treat www.example.com and example.com as one site. */
export function registrableSuffix(hostname: string): string {
  const parts = hostname.toLowerCase().split('.');
  if (parts.length <= 2) return parts.join('.');
  const twoLevelTlds = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'in']);
  const last = parts[parts.length - 1]!;
  const secondLast = parts[parts.length - 2]!;
  if (last.length === 2 && twoLevelTlds.has(secondLast) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

/** "example.com → maps → ahmedabad" style trail for display. */
export function pageLabel(input: string): string {
  try {
    const url = new URL(input);
    const segments = url.pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => {
        let text = segment;
        try {
          text = decodeURIComponent(segment);
        } catch {
          /* keep raw segment */
        }
        return text.replace(/\.(html?|php|aspx?|jsp)$/i, '').replace(/[-_+]+/g, ' ').trim();
      })
      .filter(Boolean);
    const host = url.hostname.replace(/^www\./, '');
    if (segments.length === 0) return host;
    return [host, ...segments.slice(0, 4)].join(' → ');
  } catch {
    return input;
  }
}

/**
 * Geographic data formats, mapped from their file extension.
 *
 * These are not images, but they are exactly the artefact a town-planning site
 * publishes alongside its map imagery, so they travel through the same
 * discovery pipeline.
 */
const GEO_EXTENSIONS: Record<string, GeoFormat> = {
  kml: 'kml',
  kmz: 'kmz',
  geojson: 'geojson',
  gpx: 'gpx',
  gml: 'gml',
  topojson: 'topojson',
};

/** Geographic format implied by a URL's path, or null when it is not one. */
export function geoFormatFromUrl(input: string): GeoFormat | null {
  const filename = filenameFromUrl(input);
  const match = /\.([a-z0-9]{2,8})$/i.exec(filename);
  if (!match) return null;
  const extension = match[1]!.toLowerCase();
  const direct = GEO_EXTENSIONS[extension];
  if (direct) return direct;
  // A zipped shapefile is conventionally named "<something>-shp.zip" or "shapefile.zip".
  if (extension === 'zip' && /(^|[-_.])(shp|shape|shapefile|gis)([-_.]|$)/i.test(filename)) {
    return 'shapefile-zip';
  }
  return null;
}

export function isGeoUrl(input: string): boolean {
  return geoFormatFromUrl(input) !== null;
}

/** File extensions that are certainly not HTML pages, so they are never queued as pages. */
const NON_PAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico', 'tif', 'tiff', 'heic',
  'pdf', 'zip', 'rar', '7z', 'gz', 'tar', 'bz2', 'dmg', 'exe', 'msi', 'apk',
  'mp3', 'mp4', 'avi', 'mov', 'wmv', 'webm', 'ogg', 'wav', 'flac', 'm4a', 'mkv',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'rtf',
  'css', 'js', 'mjs', 'json', 'xml', 'rss', 'atom', 'woff', 'woff2', 'ttf', 'eot', 'map',
  // Geographic data files: discovered as assets, never crawled as pages.
  'kml', 'kmz', 'geojson', 'gpx', 'gml', 'topojson',
]);

export function looksLikePage(input: string): boolean {
  try {
    const url = new URL(input);
    // Up to 8 characters so longer data extensions ("geojson", "topojson")
    // are recognised rather than falling through as if they were pages.
    const match = /\.([a-z0-9]{1,8})$/i.exec(url.pathname);
    if (!match) return true;
    return !NON_PAGE_EXTENSIONS.has(match[1]!.toLowerCase());
  } catch {
    return false;
  }
}
