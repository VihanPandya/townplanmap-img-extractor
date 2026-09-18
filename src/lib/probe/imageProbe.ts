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
import type { ImageStatus } from '@/lib/types';

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
