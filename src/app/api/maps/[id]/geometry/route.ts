/** GET /api/maps/:id/geometry?scanId=... - the map's geometry as GeoJSON. */

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

    const parcels = index.parcels.filter((parcel) => parcel.mapId === id && parcel.feature);
    if (parcels.length === 0) {
      return jsonError(
        'no-geometry',
        'This map has no source geometry, so there is nothing to return. Its imagery is still listed.',
        404,
      );
    }

    // GeoJSON is emitted in WGS84 only, which is what RFC 7946 requires.
    return jsonOk({
      type: 'FeatureCollection',
      features: parcels.map((parcel) => ({
        type: 'Feature',
        id: parcel.id,
        properties: {
          name: parcel.name,
          reference: parcel.reference,
          areaSquareMetres: parcel.areaSquareMetres,
          areaBasis: parcel.areaBasis,
          sourceCrs: parcel.feature!.sourceCrs,
          transformed: parcel.feature!.transformed,
          geometrySource: parcel.geometrySource,
          sourcePage: parcel.sourcePage,
          ...parcel.properties,
        },
        geometry: parcel.feature!.geometry,
      })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
