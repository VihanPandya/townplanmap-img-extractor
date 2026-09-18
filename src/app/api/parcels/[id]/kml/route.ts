/**
 * GET /api/parcels/:id/kml?scanId=... - one KML file for one parcel.
 *
 * Refuses, with a reason, when the parcel has no usable source geometry. There
 * is deliberately no fallback that derives a boundary from an image.
 */

import type { NextRequest } from 'next/server';
import { errorResponse, jsonError } from '@/lib/api/respond';
import { buildSingleKml, kmlFilename } from '@/lib/geo/kmlWriter';
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

    const parcel = index.parcels.find((entry) => entry.id === id);
    if (!parcel) return jsonError('parcel-not-found', 'That parcel is not part of this scan.', 404);

    if (!parcel.kmlAvailable || !parcel.feature) {
      return jsonError(
        'no-geometry',
        parcel.geometryAvailability === 'image-only'
          ? 'This record is a map image. The source did not publish geographic coordinates for it, so no KML can be generated.'
          : 'The geometry for this parcel could not be verified, so no KML is offered.',
        404,
        'Producing a boundary from an image would manufacture precision the source never provided.',
      );
    }

    const kml = buildSingleKml(parcel.feature, {
      website: index.host,
      sourcePage: parcel.sourcePage,
      geometrySource: parcel.geometrySource,
      imageSource: parcel.images[0]?.url ?? null,
      retrievedAt: new Date().toISOString().slice(0, 10),
    });

    return new Response(kml, {
      status: 200,
      headers: {
        'content-type': 'application/vnd.google-earth.kml+xml; charset=utf-8',
        'content-disposition': `attachment; filename="${kmlFilename(parcel.reference ?? parcel.name, parcel.id)}"`,
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
