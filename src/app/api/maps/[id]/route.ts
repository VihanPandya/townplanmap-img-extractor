/** GET /api/maps/:id?scanId=... - one map and every parcel inside it. */

import type { NextRequest } from 'next/server';
import { errorResponse, jsonError, jsonOk } from '@/lib/api/respond';
import { indexForScan } from '@/lib/mapintel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const scanId = request.nextUrl.searchParams.get('scanId');
    if (!scanId) return jsonError('bad-request', 'A "scanId" query parameter is required.', 400);

    const index = await indexForScan(scanId);
    if (!index) return jsonError('scan-not-found', 'That scan is no longer available.', 404);

    const map = index.maps.find((entry) => entry.id === id);
    if (!map) return jsonError('map-not-found', 'That map is not part of this scan.', 404);

    return jsonOk({ map, parcels: index.parcels.filter((parcel) => parcel.mapId === id) });
  } catch (error) {
    return errorResponse(error);
  }
}
