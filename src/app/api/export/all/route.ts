/**
 * POST /api/export/all - the download centre's bundle.
 *
 * Produces the organised archive described in section 56:
 *
 *   <Location>_Map_Data/
 *     Images/<Village>/<Survey>.jpg
 *     KML/<Village>/<Survey>.kml
 *     metadata.json
 *
 * Three independent switches control what goes in: images, kml, metadata. KML
 * is generated only for parcels with usable source geometry; parcels without it
 * are recorded in metadata.json with the reason, never given a fabricated
 * boundary. One failed item never cancels the rest (section 68).
 */

import type { NextRequest } from 'next/server';
import { errorResponse, jsonError } from '@/lib/api/respond';
import { assertWithinZipLimits, ZipBuilder, ZipLimitError } from '@/lib/download/zip';
import { buildSingleKml, kmlFilename } from '@/lib/geo/kmlWriter';
import { ancestryOf, indexForScan } from '@/lib/mapintel';
import type { ParcelRecord } from '@/lib/mapintel/types';
import { safeFetch } from '@/lib/security/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_PARCELS = 2000;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

interface ExportAllRequest {
  scanId: string;
  locationId?: string;
  parcelIds?: string[];
  includeImages?: boolean;
  includeKml?: boolean;
  includeMetadata?: boolean;
  /** Required when includeImages is true: image bytes are being retrieved. */
  acknowledged?: boolean;
  basis?: string;
}

interface ManifestEntry {
  id: string;
  reference: string | null;
  name: string;
  locationTrail: string[];
  image: string | null;
  kml: string | null;
  sourcePage: string;
  sourceImage: string | null;
  geometrySource: string | null;
  geometryAvailable: boolean;
  geometryNote: string | null;
  imageAssociation: string | null;
  areaSquareMetres: number | null;
  areaBasis: string | null;
  status: 'complete' | 'partial' | 'failed';
  notes: string[];
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as ExportAllRequest;
    if (!body?.scanId) return jsonError('bad-request', 'A "scanId" is required.', 400);

    const includeImages = body.includeImages !== false;
    const includeKml = body.includeKml !== false;
    const includeMetadata = body.includeMetadata !== false;

    if (!includeImages && !includeKml && !includeMetadata) {
      return jsonError('bad-request', 'Select at least one of images, KML or metadata.', 400);
    }
    if (includeImages && body.acknowledged !== true) {
      return jsonError(
        'acknowledgement-required',
        'Confirm that you have the right to retrieve these images before downloading them.',
        403,
        'KML and metadata are generated from data already retrieved during the scan; image files are fetched from the source website.',
      );
    }

    const index = await indexForScan(body.scanId);
    if (!index) return jsonError('scan-not-found', 'That scan is no longer available.', 404);

    let parcels: ParcelRecord[] = index.parcels;
    if (Array.isArray(body.parcelIds) && body.parcelIds.length > 0) {
      const wanted = new Set(body.parcelIds);
      parcels = parcels.filter((parcel) => wanted.has(parcel.id));
    } else if (body.locationId) {
      const { collectDescendants } = await import('@/lib/mapintel');
      const ids = collectDescendants(index.locations, body.locationId);
      parcels = parcels.filter((parcel) => parcel.locationId && ids.has(parcel.locationId));
    }

    if (parcels.length === 0) {
      return jsonError('nothing-to-export', 'No land records matched that selection.', 400);
    }
    if (parcels.length > MAX_PARCELS) {
      return jsonError(
        'too-many',
        `A single export is limited to ${MAX_PARCELS} land records; ${parcels.length} were selected.`,
        400,
      );
    }
    try {
      assertWithinZipLimits(parcels.length * 2 + 1, 0);
    } catch (error) {
      if (error instanceof ZipLimitError) return jsonError('too-large', error.message, 400);
      throw error;
    }

    const locationName = body.locationId
      ? (index.locations.find((node) => node.id === body.locationId)?.name ?? index.host)
      : index.host;
    const folder = safeSegment(locationName) || 'Map_Data';
    const filename = `${folder}_Map_Data_${new Date().toISOString().slice(0, 10)}.zip`;

    const stream = buildBundle(parcels, {
      index,
      includeImages,
      includeKml,
      includeMetadata,
      rootFolder: `${folder}_Map_Data`,
      basis: typeof body.basis === 'string' ? body.basis.slice(0, 300) : null,
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

interface BundleOptions {
  index: NonNullable<Awaited<ReturnType<typeof indexForScan>>>;
  includeImages: boolean;
  includeKml: boolean;
  includeMetadata: boolean;
  rootFolder: string;
  basis: string | null;
}

function buildBundle(parcels: ParcelRecord[], options: BundleOptions): ReadableStream<Uint8Array> {
  const zip = new ZipBuilder();
  const manifest: ManifestEntry[] = [];
  let index = 0;
  let totalBytes = 0;
  let finished = false;

  const trailFor = (parcel: ParcelRecord): string[] =>
    parcel.locationId ? ancestryOf(options.index, parcel.locationId).map((node) => node.name) : parcel.folderPath;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;

      if (index >= parcels.length) {
        if (options.includeMetadata) {
          const json = Buffer.from(renderMetadata(manifest, options), 'utf8');
          controller.enqueue(
            zip.add({ name: `${options.rootFolder}/metadata.json`, data: json }),
          );
        }
        controller.enqueue(zip.end());
        controller.close();
        finished = true;
        return;
      }

      const parcel = parcels[index]!;
      index += 1;

      const trail = trailFor(parcel);
      const subfolder = trail.slice(1).map(safeSegment).filter(Boolean).join('/');
      const baseName = safeSegment(parcel.reference ?? parcel.name) || `record_${index}`;
      const notes: string[] = [];
      let imagePath: string | null = null;
      let kmlPath: string | null = null;

      // ---------------------------------------------------------- KML
      if (options.includeKml) {
        if (parcel.kmlAvailable && parcel.feature) {
          try {
            const kml = buildSingleKml(parcel.feature, {
              website: options.index.host,
              sourcePage: parcel.sourcePage,
              geometrySource: parcel.geometrySource,
              imageSource: parcel.images[0]?.url ?? null,
              retrievedAt: new Date().toISOString().slice(0, 10),
            });
            kmlPath = joinPath(options.rootFolder, 'KML', subfolder, kmlFilename(baseName, `record_${index}`));
            controller.enqueue(zip.add({ name: kmlPath, data: Buffer.from(kml, 'utf8') }));
          } catch (error) {
            notes.push(`KML could not be generated: ${error instanceof Error ? error.message : 'unknown error'}`);
            kmlPath = null;
          }
        } else {
          notes.push(
            parcel.geometryAvailability === 'image-only'
              ? 'No KML: the source published a map image for this record but no geographic coordinates.'
              : 'No KML: the source geometry could not be verified.',
          );
        }
      }

      // -------------------------------------------------------- image
      if (options.includeImages) {
        const best = parcel.images[0];
        if (!best) {
          notes.push('No image was associated with this record.');
        } else {
          try {
            const response = await safeFetch(best.url, {
              accept: 'image/*,*/*;q=0.8',
              referer: best.sourcePage,
              limits: { maxBytes: MAX_IMAGE_BYTES, timeoutMs: 45_000, maxRedirects: 4 },
            });
            if (response.status >= 400) {
              notes.push(`Image skipped: the server responded HTTP ${response.status}.`);
            } else if (response.truncated) {
              notes.push('Image skipped: it exceeded the per-file size limit.');
            } else if (totalBytes + response.body.length > MAX_TOTAL_BYTES) {
              notes.push('Image skipped: the archive reached its total size limit.');
            } else {
              const extension = extensionOf(best.url, best.format);
              imagePath = joinPath(options.rootFolder, 'Images', subfolder, `${baseName}${extension}`);
              controller.enqueue(zip.add({ name: imagePath, data: response.body }));
              totalBytes += response.body.length;
              if (best.confidence !== 'verified') {
                notes.push(
                  `Image association is "${best.confidence}": ${best.reason} Check it before relying on the pairing.`,
                );
              }
            }
          } catch (error) {
            notes.push(`Image skipped: ${error instanceof Error ? error.message : 'the request failed'}.`);
          }
        }
      }

      const wantedCount = (options.includeKml ? 1 : 0) + (options.includeImages ? 1 : 0);
      const gotCount = (kmlPath ? 1 : 0) + (imagePath ? 1 : 0);

      manifest.push({
        id: parcel.id,
        reference: parcel.reference,
        name: parcel.name,
        locationTrail: trail,
        image: imagePath,
        kml: kmlPath,
        sourcePage: parcel.sourcePage,
        sourceImage: parcel.images[0]?.url ?? null,
        geometrySource: parcel.geometrySource,
        geometryAvailable: parcel.kmlAvailable,
        geometryNote:
          parcel.geometryAvailability === 'available'
            ? null
            : parcel.geometryAvailability === 'image-only'
              ? 'Map image only; the source published no coordinates for this record.'
              : 'Geometry could not be verified.',
        imageAssociation: parcel.images[0]?.confidence ?? null,
        areaSquareMetres: parcel.areaSquareMetres,
        areaBasis: parcel.areaBasis,
        status: gotCount === wantedCount ? 'complete' : gotCount > 0 ? 'partial' : 'failed',
        notes,
      });
    },
    cancel() {
      finished = true;
    },
  });
}

function renderMetadata(entries: ManifestEntry[], options: BundleOptions): string {
  const payload = {
    tool: 'TownPlanMap Image Explorer - map intelligence export',
    exportedAt: new Date().toISOString(),
    source: {
      website: options.index.host,
      scannedUrl: options.index.scanUrl,
      scanId: options.index.scanId,
      extractionMethod: 'Public webpage and publicly exposed map data',
    },
    statedBasis: options.basis,
    contents: {
      records: entries.length,
      withKml: entries.filter((entry) => entry.kml).length,
      withImage: entries.filter((entry) => entry.image).length,
      complete: entries.filter((entry) => entry.status === 'complete').length,
      partial: entries.filter((entry) => entry.status === 'partial').length,
      failed: entries.filter((entry) => entry.status === 'failed').length,
    },
    accuracyNotice:
      'Map imagery and geographic boundaries are presented according to the source data available ' +
      'through the website. This dataset should not be treated as a legal land-survey document ' +
      'unless the authoritative source explicitly establishes that status.',
    coordinateSystem: 'EPSG:4326 (WGS 84). Coordinates transformed from another system are flagged per record.',
    maps: entries,
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function joinPath(...segments: Array<string | null>): string {
  return segments.filter((segment) => segment && segment.length > 0).join('/');
}

/** Filesystem-safe folder or file stem. */
function safeSegment(value: string): string {
  return value
    .replace(/[\\/]/g, '_')
    .replace(/[^\w\s.-]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .slice(0, 80);
}

function extensionOf(url: string, format: string | null): string {
  const match = /\.([a-z0-9]{2,5})(?:$|\?)/i.exec(url);
  if (match) return `.${match[1]!.toLowerCase()}`;
  if (format?.includes('/')) return `.${format.split('/')[1]!.replace('jpeg', 'jpg')}`;
  if (format) return `.${format}`;
  return '.img';
}
