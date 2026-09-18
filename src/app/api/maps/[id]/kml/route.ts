/**
 * GET /api/maps/:id/kml?scanId=... - one KML document for a whole map,
 * with folders preserving the hierarchy the source expressed.
 */

import type { NextRequest } from 'next/server';
import { errorResponse, jsonError } from '@/lib/api/respond';
import { buildCombinedKml, type KmlGroup } from '@/lib/geo/kmlWriter';
import { ancestryOf, indexForScan } from '@/lib/mapintel';

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

    const exportable = index.parcels.filter((parcel) => parcel.mapId === id && parcel.kmlAvailable);
    if (exportable.length === 0) {
      return jsonError(
        'no-geometry',
        'No parcel in this map has usable source geometry, so no KML can be produced. ' +
          'Its imagery remains available as images.',
        404,
      );
    }

    const groups = new Map<string, KmlGroup>();
    for (const parcel of exportable) {
      const trail = parcel.locationId ? ancestryOf(index, parcel.locationId).map((node) => node.name) : [];
      const path = trail.length > 0 ? trail : parcel.folderPath;
      const key = path.join('/');
      const group = groups.get(key) ?? { path, features: [] };
      group.features.push(parcel.feature!);
      groups.set(key, group);
    }

    const kml = buildCombinedKml(map.name, [...groups.values()], {
      website: index.host,
      sourcePage: map.sourcePage,
      geometrySource: map.sourceUrl,
      retrievedAt: new Date().toISOString().slice(0, 10),
    });

    return new Response(kml, {
      status: 200,
      headers: {
        'content-type': 'application/vnd.google-earth.kml+xml; charset=utf-8',
        'content-disposition': `attachment; filename="${safeName(map.name)}.kml"`,
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

function safeName(name: string): string {
  return (
    name
      .replace(/[\\/]/g, '_')
      .replace(/[^\w\s.-]/g, '')
      .replace(/\s+/g, '_')
      .slice(0, 100) || 'map'
  );
}
