/**
 * Image verification.
 *
 * The prober performs a single bounded GET per asset and reports only what it
 * actually observed. If verification is turned off, or a request fails, the
 * asset keeps the honest status "unverified" - availability is never inferred
 * from the fact that a URL appeared in some HTML.
 *
 * To keep bandwidth sane the body is read incrementally: as soon as enough
 * header bytes have arrived for `image-size` to report dimensions, the read
 * stops unless the response is small enough to hash in full.
 */

import { createHash } from 'node:crypto';
import { imageSize } from 'image-size';
import { HttpFetchError, safeFetch } from '@/lib/security/http';
import { UrlSecurityError } from '@/lib/security/url-guard';
import { parseGeoSource } from '@/lib/geo/parse';
import type { GeoParseResult } from '@/lib/geo/types';
import type { GeoFormat, ImageStatus } from '@/lib/types';

/** Bytes that are usually plenty to reach the dimension headers. */
const HEADER_PROBE_BYTES = 96 * 1024;
/** Responses at or below this size are read in full so an exact hash is possible. */
const FULL_READ_LIMIT = 2 * 1024 * 1024;

export interface ProbeResult {
  status: ImageStatus;
  httpStatus: number | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  fileSize: number | null;
  finalUrl: string | null;
  redirected: boolean;
  /** SHA-256 of the complete body. Null when the body was not read in full. */
  contentHash: string | null;
  bytesRead: number;
  message: string | null;
}

const IMAGE_MIME = /^image\//i;

export async function probeImage(url: string, referer?: string): Promise<ProbeResult> {
  const hash = createHash('sha256');
  let bytesRead = 0;
  let dimensions: { width: number; height: number; type?: string } | null = null;
  let header = Buffer.alloc(0);
  let expectedSize: number | null = null;
  let stoppedEarly = false;

  try {
    const response = await safeFetch(url, {
      accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      ...(referer ? { referer } : {}),
      limits: { maxBytes: 12 * 1024 * 1024, timeoutMs: 20_000, maxRedirects: 4 },
      onChunk: (chunk, total) => {
        bytesRead = total;
        hash.update(chunk);
        if (!dimensions && header.length < HEADER_PROBE_BYTES) {
          header = header.length === 0 ? Buffer.from(chunk) : Buffer.concat([header, chunk]);
          dimensions = tryMeasure(header);
        }
        // Stop as soon as dimensions are known and the file is clearly too big
        // to be worth downloading purely for a hash.
        if (dimensions && expectedSize !== null && expectedSize > FULL_READ_LIMIT) {
          stoppedEarly = true;
          return false;
        }
        if (dimensions && expectedSize === null && total > FULL_READ_LIMIT) {
          stoppedEarly = true;
          return false;
        }
        return true;
      },
    });

    expectedSize = response.declaredLength;
    const contentType = normaliseMime(response.contentType);

    if (response.status >= 400) {
      return {
        status: 'unavailable',
        httpStatus: response.status,
        mimeType: contentType,
        width: null,
        height: null,
        fileSize: null,
        finalUrl: response.url,
        redirected: response.redirected,
        contentHash: null,
        bytesRead,
        message: describeHttpStatus(response.status),
      };
    }

    if (!dimensions && response.body.length > 0) {
      dimensions = tryMeasure(response.body);
    }

    const looksLikeImage = contentType ? IMAGE_MIME.test(contentType) : dimensions !== null;
    if (!looksLikeImage) {
      return {
        status: 'unsupported',
        httpStatus: response.status,
        mimeType: contentType,
        width: null,
        height: null,
        fileSize: response.declaredLength,
        finalUrl: response.url,
        redirected: response.redirected,
        contentHash: null,
        bytesRead,
        message: contentType
          ? `The server returned "${contentType}", which is not an image type the scanner can read.`
          : 'The response did not contain data the scanner recognises as an image.',
      };
    }

    const complete = !response.truncated && !stoppedEarly;
    const fileSize = complete ? bytesRead : response.declaredLength;

    return {
      status: response.redirected ? 'redirected' : 'available',
      httpStatus: response.status,
      mimeType: contentType ?? mimeFromType(dimensions?.type),
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      fileSize,
      finalUrl: response.url,
      redirected: response.redirected,
      contentHash: complete ? hash.digest('hex') : null,
      bytesRead,
      message: response.redirected ? `Redirected to ${response.url}` : null,
    };
  } catch (error) {
    return {
      status: 'unavailable',
      httpStatus: error instanceof HttpFetchError ? error.httpStatus : null,
      mimeType: null,
      width: null,
      height: null,
      fileSize: null,
      finalUrl: null,
      redirected: false,
      contentHash: null,
      bytesRead,
      message: describeError(error),
    };
  }
}

function tryMeasure(buffer: Buffer): { width: number; height: number; type?: string } | null {
  if (buffer.length < 16) return null;
  try {
    const result = imageSize(buffer);
    if (!result?.width || !result?.height) return null;
    return { width: result.width, height: result.height, type: result.type };
  } catch {
    return null;
  }
}

function normaliseMime(contentType: string | null): string | null {
  if (!contentType) return null;
  const base = contentType.split(';')[0]?.trim().toLowerCase();
  return base && base.length > 0 ? base : null;
}

function mimeFromType(type: string | undefined): string | null {
  if (!type) return null;
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    avif: 'image/avif',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    tiff: 'image/tiff',
    heif: 'image/heif',
  };
  return map[type.toLowerCase()] ?? `image/${type.toLowerCase()}`;
}

export function describeHttpStatus(status: number): string {
  switch (status) {
    case 401:
      return 'This resource requires authentication, so the scanner did not retrieve it.';
    case 402:
      return 'This resource is behind a payment requirement and was not retrieved.';
    case 403:
      return 'The server did not permit the scanner to retrieve this resource.';
    case 404:
      return 'The server reported that this resource does not exist.';
    case 410:
      return 'The server reported that this resource has been removed.';
    case 429:
      return 'The server asked the scanner to slow down (rate limited).';
    case 451:
      return 'The server reported this resource is unavailable for legal reasons.';
    case 500:
    case 502:
    case 503:
    case 504:
      return 'The server reported an error while serving this resource.';
    default:
      return `The server responded with HTTP ${status}.`;
  }
}

export function describeError(error: unknown): string {
  if (error instanceof UrlSecurityError) return error.message;
  if (error instanceof HttpFetchError) return error.message;
  if (error instanceof Error) return error.message;
  return 'The request failed for an unknown reason.';
}


/**
 * Content types a geographic data file may legitimately arrive as. Many servers
 * send KML as generic XML, or KMZ as a plain zip, so the check is deliberately
 * permissive - the extension already told us what we asked for.
 */
const GEO_CONTENT_TYPES = [
  /^application\/vnd\.google-earth/i,
  /^application\/(geo\+)?json/i,
  /^application\/(x-)?zip/i,
  /^application\/(xml|octet-stream|gpx\+xml|gml\+xml)/i,
  /^text\/(xml|plain|json)/i,
];

/** Magic bytes, used to confirm what a server actually sent. */
function sniffGeo(body: Buffer, format: GeoFormat): { ok: boolean; note: string | null } {
  if (body.length === 0) return { ok: false, note: 'The server returned an empty file.' };
  const head = body.subarray(0, 512);
  const isZip = head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07);
  const text = head.toString('utf8').trimStart();

  if (format === 'kmz' || format === 'shapefile-zip') {
    return isZip
      ? { ok: true, note: null }
      : { ok: false, note: 'The server did not return a zip archive for this file.' };
  }
  if (format === 'geojson' || format === 'topojson') {
    return text.startsWith('{') || text.startsWith('[')
      ? { ok: true, note: null }
      : { ok: false, note: 'The response was not JSON.' };
  }
  // KML, GPX and GML are all XML documents.
  if (text.startsWith('<?xml') || text.startsWith('<')) {
    const expected = format === 'kml' ? /<kml/i : format === 'gpx' ? /<gpx/i : /<[a-z]*:?(FeatureCollection|gml)/i;
    return expected.test(head.toString('utf8'))
      ? { ok: true, note: null }
      : { ok: true, note: `The file is XML but no <${format}> root element was seen in its first bytes.` };
  }
  return { ok: false, note: 'The response did not look like a geographic data file.' };
}

export interface GeoProbeResult extends Omit<ProbeResult, 'width' | 'height'> {
  width: null;
  height: null;
  /** Geometry parsed from the same response, so the file is fetched once. */
  parsed: GeoParseResult | null;
}

/**
 * Verify a geographic data file. Same guarantees as `probeImage`: only what was
 * actually observed is reported, and a file that cannot be retrieved says so.
 */
export async function probeGeoFile(url: string, format: GeoFormat, referer?: string): Promise<GeoProbeResult> {
  const hash = createHash('sha256');
  let bytesRead = 0;
  let head = Buffer.alloc(0);

  try {
    const response = await safeFetch(url, {
      accept: 'application/vnd.google-earth.kml+xml,application/geo+json,application/xml,*/*;q=0.8',
      ...(referer ? { referer } : {}),
      limits: { maxBytes: 24 * 1024 * 1024, timeoutMs: 30_000, maxRedirects: 4 },
      onChunk: (chunk, total) => {
        bytesRead = total;
        hash.update(chunk);
        if (head.length < 512) {
          head = head.length === 0 ? Buffer.from(chunk) : Buffer.concat([head, chunk]);
        }
        return true;
      },
    });

    const contentType = normaliseMime(response.contentType);

    if (response.status >= 400) {
      return {
        status: 'unavailable',
        httpStatus: response.status,
        mimeType: contentType,
        width: null,
        height: null,
        fileSize: null,
        finalUrl: response.url,
        redirected: response.redirected,
        contentHash: null,
        bytesRead,
        parsed: null,
        message: describeHttpStatus(response.status),
      };
    }

    // An HTML response here almost always means a login wall or an error page
    // dressed up as a 200, so it is reported rather than saved as "geo data".
    if (contentType && /^text\/html/i.test(contentType)) {
      return {
        status: 'unsupported',
        httpStatus: response.status,
        mimeType: contentType,
        width: null,
        height: null,
        fileSize: response.declaredLength,
        finalUrl: response.url,
        redirected: response.redirected,
        contentHash: null,
        bytesRead,
        parsed: null,
        message: 'The server returned an HTML page instead of the data file.',
      };
    }

    const typeLooksRight = !contentType || GEO_CONTENT_TYPES.some((pattern) => pattern.test(contentType));
    const sniffed = sniffGeo(response.truncated ? head : response.body, format);

    if (!sniffed.ok) {
      return {
        status: 'unsupported',
        httpStatus: response.status,
        mimeType: contentType,
        width: null,
        height: null,
        fileSize: response.declaredLength,
        finalUrl: response.url,
        redirected: response.redirected,
        contentHash: null,
        bytesRead,
        parsed: null,
        message: sniffed.note,
      };
    }

    const complete = !response.truncated;

    // Geometry is only parsed from a complete body: a truncated file would
    // yield a partial boundary, which is worse than none at all.
    let parsed: GeoParseResult | null = null;
    if (complete) {
      try {
        parsed = parseGeoSource(format, response.body, url);
      } catch {
        parsed = null;
      }
    }

    const notes = [
      sniffed.note,
      parsed && parsed.warnings.length > 0 ? parsed.warnings[0]! : null,
      typeLooksRight ? null : `Served as "${contentType}", which is unusual for ${format.toUpperCase()}.`,
      response.redirected ? `Redirected to ${response.url}` : null,
    ].filter(Boolean);

    return {
      status: response.redirected ? 'redirected' : 'available',
      httpStatus: response.status,
      mimeType: contentType,
      width: null,
      height: null,
      fileSize: complete ? bytesRead : response.declaredLength,
      finalUrl: response.url,
      redirected: response.redirected,
      contentHash: complete ? hash.digest('hex') : null,
      bytesRead,
      parsed,
      message: notes.length > 0 ? notes.join(' ') : null,
    };
  } catch (error) {
    return {
      status: 'unavailable',
      httpStatus: error instanceof HttpFetchError ? error.httpStatus : null,
      mimeType: null,
      width: null,
      height: null,
      fileSize: null,
      finalUrl: null,
      redirected: false,
      contentHash: null,
      bytesRead,
      parsed: null,
      message: describeError(error),
    };
  }
}
