/**
 * POST /api/locations/search - find locations and parcels in a scan's model.
 *
 * Results come entirely from what the scan discovered; there is no built-in
 * gazetteer and no hard-coded list of cities or villages.
 */

import type { NextRequest } from 'next/server';
import { errorResponse, jsonError, jsonOk } from '@/lib/api/respond';
import { ancestryOf, indexForScan, searchIndex } from '@/lib/mapintel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { scanId?: string; query?: string; limit?: number };
    if (!body?.scanId) return jsonError('bad-request', 'A "scanId" is required.', 400);

    const index = await indexForScan(body.scanId);
    if (!index) return jsonError('scan-not-found', 'That scan is no longer available.', 404);

    const query = (body.query ?? '').trim();
    const limit = Math.min(Math.max(Number(body.limit) || 60, 1), 200);

    // An empty query lists the discovered roots, which is what the selector
    // shows before the user types anything. They are ordered by how much was
    // actually found under each, so a document title with a single feature does
    // not outrank a district with hundreds of land records.
    if (!query) {
      const roots = index.locations
        .filter((node) => node.parentId === null)
        .sort(
          (a, b) =>
            b.parcelCount - a.parcelCount ||
            b.geometryCount - a.geometryCount ||
            a.name.localeCompare(b.name),
        )
        .slice(0, limit);
      return jsonOk({
        locations: roots.map((node) => ({ ...node, trail: ancestryOf(index, node.id).map((n) => n.name) })),
        parcels: [],
        total: index.locations.length,
      });
    }

    const found = searchIndex(index, query, limit);
    return jsonOk({
      locations: found.locations
        .sort((a, b) => b.parcelCount - a.parcelCount || a.name.localeCompare(b.name))
        .map((node) => ({ ...node, trail: ancestryOf(index, node.id).map((n) => n.name) })),
      parcels: found.parcels.map((parcel) => ({
        id: parcel.id,
        reference: parcel.reference,
        name: parcel.name,
        locationId: parcel.locationId,
        kmlAvailable: parcel.kmlAvailable,
        geometryAvailability: parcel.geometryAvailability,
        imageCount: parcel.images.length,
      })),
      total: found.locations.length + found.parcels.length,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
