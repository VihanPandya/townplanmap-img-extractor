/** GET /api/locations/:id/maps?scanId=... - maps and parcels under a location. */

import type { NextRequest } from 'next/server';
import { errorResponse, jsonError, jsonOk } from '@/lib/api/respond';
import { collectDescendants, indexForScan } from '@/lib/mapintel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const params = request.nextUrl.searchParams;
    const scanId = params.get('scanId');
    if (!scanId) return jsonError('bad-request', 'A "scanId" query parameter is required.', 400);

    const index = await indexForScan(scanId);
    if (!index) return jsonError('scan-not-found', 'That scan is no longer available.', 404);
    if (!index.locations.some((node) => node.id === id)) {
      return jsonError('location-not-found', 'That location is not part of this scan.', 404);
    }

    const ids = collectDescendants(index.locations, id);
    const maps = index.maps.filter((map) => map.locationId && ids.has(map.locationId));
    const parcels = index.parcels.filter((parcel) => parcel.locationId && ids.has(parcel.locationId));

    return jsonOk({ locationId: id, maps, parcels });
  } catch (error) {
    return errorResponse(error);
  }
}
