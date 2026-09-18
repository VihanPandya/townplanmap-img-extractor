/**
 * GET    /api/scan/:id - scan status, pages, issues
 * DELETE /api/scan/:id - stop a running scan (results are preserved)
 */

import type { NextRequest } from 'next/server';
import { errorResponse, jsonError, jsonOk } from '@/lib/api/respond';
import { getScanStore, toDetail } from '@/lib/database/store';
import { controlScan } from '@/lib/scan/engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const record = await getScanStore().get(id);
    if (!record) {
      return jsonError(
        'scan-not-found',
        'That scan is no longer available. Scan results are kept temporarily; run the scan again to see them.',
        404,
      );
    }
    return jsonOk(toDetail(record));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const record = await getScanStore().get(id);
    if (!record) return jsonError('scan-not-found', 'That scan is no longer available.', 404);
    controlScan(id, 'stop');
    return jsonOk({ scanId: id, status: record.status });
  } catch (error) {
    return errorResponse(error);
  }
}
