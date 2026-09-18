/** GET /api/locations/:id?scanId=... - dashboard figures for one location. */

import type { NextRequest } from 'next/server';
import { errorResponse, jsonError, jsonOk } from '@/lib/api/respond';
import { ancestryOf, indexForScan, summariseLocation } from '@/lib/mapintel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const scanId = request.nextUrl.searchParams.get('scanId');
    if (!scanId) return jsonError('bad-request', 'A "scanId" query parameter is required.', 400);

    const index = await indexForScan(scanId);
    if (!index) return jsonError('scan-not-found', 'That scan is no longer available.', 404);

    const summary = summariseLocation(index, id);
    if (!summary) return jsonError('location-not-found', 'That location is not part of this scan.', 404);

    return jsonOk({ ...summary, trail: ancestryOf(index, id) });
  } catch (error) {
    return errorResponse(error);
  }
}
