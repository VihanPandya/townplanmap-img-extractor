/**
 * GET /api/preview/:id?scanId=...
 *
 * A narrow image relay used only when a discovered image will not render
 * directly in the browser (hotlink protection, a missing CORS header on a
 * canvas path, mixed content). It is *not* a general proxy:
 *
 *  - the id must belong to an image already discovered in a stored scan, so no
 *    caller-supplied URL is ever fetched
 *  - the upstream request goes through the same SSRF-guarded fetcher
 *  - only image content types are passed back, with nosniff, and the response
 *    size is capped
 */

import type { NextRequest } from 'next/server';
import { errorResponse, jsonError } from '@/lib/api/respond';
import { getScanStore } from '@/lib/database/store';
import { safeFetch } from '@/lib/security/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_PREVIEW_BYTES = 6 * 1024 * 1024;

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const store = getScanStore();
    const scanId = request.nextUrl.searchParams.get('scanId');

    const image = scanId ? await store.image(scanId, id) : (await store.findImageAnywhere(id))?.image ?? null;
    if (!image) {
      return jsonError('image-not-found', 'That image is not part of a stored scan.', 404);
    }

    const response = await safeFetch(image.url, {
      accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*;q=0.8',
      referer: image.sourcePage,
      limits: { maxBytes: MAX_PREVIEW_BYTES, timeoutMs: 15_000, maxRedirects: 3 },
    });

    if (response.status >= 400) {
      return jsonError('upstream-error', `The image host responded with HTTP ${response.status}.`, 502);
    }

    const contentType = (response.contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (!contentType.startsWith('image/')) {
      return jsonError('not-an-image', 'The URL did not return image data.', 415);
    }

    return new Response(new Uint8Array(response.body), {
      status: 200,
      headers: {
        'content-type': contentType,
        'content-length': String(response.body.length),
        'cache-control': 'private, max-age=600',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
