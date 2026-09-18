/**
 * GET /api/scan/:id/images
 *
 * Supports incremental polling: pass `?since=<cursor>` to receive only assets
 * discovered after the previous response, which is what lets the gallery fill
 * progressively without re-sending the whole set.
 */

import type { NextRequest } from 'next/server';
import { errorResponse, jsonError, jsonOk } from '@/lib/api/respond';
import { getScanStore } from '@/lib/database/store';
import type { ScanImagesPage } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_LIMIT = 1000;

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const store = getScanStore();
    const record = await store.get(id);
    if (!record) {
      return jsonError('scan-not-found', 'That scan is no longer available.', 404);
    }

    const params = request.nextUrl.searchParams;
    const since = Number(params.get('since') ?? '0');
    const limitRaw = Number(params.get('limit') ?? String(MAX_LIMIT));
    const includeBelowMinimum = params.get('includeBelowMinimum') !== 'false';

    const result = await store.images(id, {
      since: Number.isFinite(since) && since > 0 ? since : 0,
      limit: Number.isFinite(limitRaw) ? Math.min(Math.max(1, limitRaw), MAX_LIMIT) : MAX_LIMIT,
      includeBelowMinimum,
    });

    const payload: ScanImagesPage = {
      scanId: id,
      images: result.images,
      cursor: result.cursor,
      total: result.total,
      live: record.status === 'running' || record.status === 'paused' || record.status === 'queued' || record.status === 'stopping',
    };
    return jsonOk(payload);
  } catch (error) {
    return errorResponse(error);
  }
}
