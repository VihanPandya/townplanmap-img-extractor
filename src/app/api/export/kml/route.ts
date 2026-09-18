/**
 * POST /api/export/kml - KML for many parcels at once.
 *
 * `mode: "combined"` returns one document with folders (section 50);
 * `mode: "individual"` returns a ZIP of one file per parcel (section 49).
 * Parcels without usable source geometry are excluded and listed in the
 * response or the archive's SKIPPED.txt, never given an invented boundary.
 */

import type { NextRequest } from 'next/server';
import { errorResponse, jsonError } from '@/lib/api/respond';
import { ZipBuilder } from '@/lib/download/zip';
import { buildCombinedKml, buildSingleKml, kmlFilename, type KmlGroup } from '@/lib/geo/kmlWriter';
import { ancestryOf, collectDescendants, indexForScan } from '@/lib/mapintel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_PARCELS = 2000;

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      scanId?: string;
      parcelIds?: string[];
      locationId?: string;
      mode?: 'combined' | 'individual';
    };
    if (!body?.scanId) return jsonError('bad-request', 'A "scanId" is required.', 400);

    const index = await indexForScan(body.scanId);
    if (!index) return jsonError('scan-not-found', 'That scan is no longer available.', 404);

    let parcels = index.parcels;
    if (Array.isArray(body.parcelIds) && body.parcelIds.length > 0) {
      const wanted = new Set(body.parcelIds);
      parcels = parcels.filter((parcel) => wanted.has(parcel.id));
    } else if (body.locationId) {
      const ids = collectDescendants(index.locations, body.locationId);
      parcels = parcels.filter((parcel) => parcel.locationId && ids.has(parcel.locationId));
    }
    if (parcels.length > MAX_PARCELS) {
      return jsonError('too-many', `A single export is limited to ${MAX_PARCELS} records.`, 400);
    }

    const exportable = parcels.filter((parcel) => parcel.kmlAvailable && parcel.feature);
    const skipped = parcels.filter((parcel) => !parcel.kmlAvailable);

    if (exportable.length === 0) {
      return jsonError(
        'no-geometry',
        'None of the selected records has usable source geometry, so no KML can be produced.',
        400,
        `${skipped.length} record(s) are map imagery without published coordinates. Deriving boundaries from those images would manufacture precision the source never provided.`,
      );
    }

    const stamp = new Date().toISOString().slice(0, 10);
    const label = body.locationId
      ? (index.locations.find((node) => node.id === body.locationId)?.name ?? index.host)
      : index.host;
    const provenance = {
      website: index.host,
      retrievedAt: stamp,
    };

    // ------------------------------------------------------- combined
    if ((body.mode ?? 'combined') === 'combined') {
      const groups = new Map<string, KmlGroup>();
      for (const parcel of exportable) {
        const trail = parcel.locationId ? ancestryOf(index, parcel.locationId).map((node) => node.name) : [];
        const path = trail.length > 0 ? trail : parcel.folderPath;
        const key = path.join('/');
        const group = groups.get(key) ?? { path, features: [] };
        group.features.push(parcel.feature!);
        groups.set(key, group);
      }

      const kml = buildCombinedKml(`${label} land maps`, [...groups.values()], provenance);
      return new Response(kml, {
        status: 200,
        headers: {
          'content-type': 'application/vnd.google-earth.kml+xml; charset=utf-8',
          'content-disposition': `attachment; filename="${safeName(label)}_Land_Maps.kml"`,
          'cache-control': 'no-store',
          'x-skipped-records': String(skipped.length),
        },
      });
    }

    // ----------------------------------------------------- individual
    const zip = new ZipBuilder();
    const parts: Buffer[] = [];
    for (const parcel of exportable) {
      const kml = buildSingleKml(parcel.feature!, {
        ...provenance,
        sourcePage: parcel.sourcePage,
        geometrySource: parcel.geometrySource,
        imageSource: parcel.images[0]?.url ?? null,
      });
      const name = zip.reserveName(kmlFilename(parcel.reference ?? parcel.name, parcel.id), `${parcel.id}.kml`);
      parts.push(zip.add({ name, data: Buffer.from(kml, 'utf8') }));
    }

    if (skipped.length > 0) {
      const lines = [
        'These records were not exported because the source published no usable geometry for them.',
        'A boundary was not derived from their imagery, because that would invent precision.',
        '',
        ...skipped.map(
          (parcel) =>
            `${parcel.reference ?? parcel.name} - ${
              parcel.geometryAvailability === 'image-only'
                ? 'map image only, no coordinates published'
                : 'geometry could not be verified'
            } (${parcel.sourcePage})`,
        ),
        '',
      ];
      parts.push(zip.add({ name: 'SKIPPED.txt', data: Buffer.from(lines.join('\n'), 'utf8') }));
    }
    parts.push(zip.end());

    return new Response(new Uint8Array(Buffer.concat(parts)), {
      status: 200,
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${safeName(label)}_Selected_Land_Maps.zip"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-skipped-records': String(skipped.length),
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

function safeName(value: string): string {
  return (
    value
      .replace(/[\\/]/g, '_')
      .replace(/[^\w\s.-]/g, '')
      .replace(/\s+/g, '_')
      .slice(0, 80) || 'Location'
  );
}
