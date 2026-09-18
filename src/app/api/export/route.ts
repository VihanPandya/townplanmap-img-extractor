/**
 * POST /api/export - CSV / JSON / TXT export of discovered metadata.
 *
 * The response is metadata only. Image bytes are never packaged for download:
 * discovering a publicly reachable image does not grant any right to
 * redistribute it.
 */

import type { NextRequest } from 'next/server';
import { errorResponse, jsonError } from '@/lib/api/respond';
import { getScanStore } from '@/lib/database/store';
import { serializeExport } from '@/lib/export/serialize';
import type { ExportFormat, ExportRequest } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FORMATS = new Set<ExportFormat>(['csv', 'json', 'txt']);

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as ExportRequest;
    if (!body?.scanId) return jsonError('bad-request', 'A "scanId" is required.', 400);
    if (!FORMATS.has(body.format)) {
      return jsonError('bad-request', 'Format must be one of "csv", "json" or "txt".', 400);
    }

    const store = getScanStore();
    const record = await store.get(body.scanId);
    if (!record) {
      return jsonError('scan-not-found', 'That scan is no longer available, so it cannot be exported.', 404);
    }

    const all = [...record.images.values()].sort((a, b) => a.seq - b.seq);
    const selected =
      Array.isArray(body.imageIds) && body.imageIds.length > 0
        ? all.filter((image) => body.imageIds!.includes(image.id))
        : all;

    if (selected.length === 0) {
      return jsonError('empty-export', 'There are no images to export for that selection.', 400);
    }

    const payload = serializeExport(selected, body.format, {
      scanUrl: record.url,
      scanId: record.id,
      categoryOverrides: body.categoryOverrides,
    });

    return new Response(payload.body, {
      status: 200,
      headers: {
        'content-type': payload.contentType,
        'content-disposition': `attachment; filename="${payload.filename}"`,
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
