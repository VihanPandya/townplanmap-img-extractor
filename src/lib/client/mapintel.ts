'use client';

/** Client calls for the city / village map intelligence module. */

import { ApiRequestError } from '@/lib/client/api';
import type { LocationNode, LocationSummary, MapRecord, ParcelRecord } from '@/lib/mapintel/types';

interface ApiErrorBody {
  error?: { code?: string; message?: string; detail?: string };
}

async function readError(response: Response): Promise<never> {
  let payload: ApiErrorBody | null = null;
  try {
    payload = (await response.json()) as ApiErrorBody;
  } catch {
    // Fall through to a generic message.
  }
  throw new ApiRequestError(
    payload?.error?.code ?? 'request-failed',
    payload?.error?.message ?? `The request failed with HTTP ${response.status}.`,
    response.status,
    payload?.error?.detail ?? null,
  );
}

export interface LocationSearchResult {
  locations: Array<LocationNode & { trail?: string[] }>;
  parcels: Array<{
    id: string;
    reference: string | null;
    name: string;
    locationId: string | null;
    kmlAvailable: boolean;
    geometryAvailability: ParcelRecord['geometryAvailability'];
    imageCount: number;
  }>;
  total: number;
}

export async function searchLocations(
  scanId: string,
  query: string,
  signal?: AbortSignal,
): Promise<LocationSearchResult> {
  const response = await fetch('/api/locations/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scanId, query }),
    signal,
  });
  if (!response.ok) await readError(response);
  return (await response.json()) as LocationSearchResult;
}

export async function fetchLocation(
  scanId: string,
  locationId: string,
): Promise<LocationSummary & { trail: LocationNode[] }> {
  const response = await fetch(
    `/api/locations/${encodeURIComponent(locationId)}?scanId=${encodeURIComponent(scanId)}`,
    { cache: 'no-store' },
  );
  if (!response.ok) await readError(response);
  return (await response.json()) as LocationSummary & { trail: LocationNode[] };
}

export async function fetchLocationMaps(
  scanId: string,
  locationId: string,
): Promise<{ maps: MapRecord[]; parcels: ParcelRecord[] }> {
  const response = await fetch(
    `/api/locations/${encodeURIComponent(locationId)}/maps?scanId=${encodeURIComponent(scanId)}`,
    { cache: 'no-store' },
  );
  if (!response.ok) await readError(response);
  return (await response.json()) as { maps: MapRecord[]; parcels: ParcelRecord[] };
}

function triggerDownload(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function filenameFrom(response: Response, fallback: string): string {
  const match = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '');
  return match?.[1] ?? fallback;
}

/** One KML for one parcel. Fails loudly when the source has no geometry. */
export async function downloadParcelKml(scanId: string, parcelId: string): Promise<string> {
  const response = await fetch(
    `/api/parcels/${encodeURIComponent(parcelId)}/kml?scanId=${encodeURIComponent(scanId)}`,
  );
  if (!response.ok) await readError(response);
  const filename = filenameFrom(response, 'parcel.kml');
  triggerDownload(await response.blob(), filename);
  return filename;
}

export interface KmlExportOutcome {
  filename: string;
  /** Records excluded because the source published no usable geometry. */
  skipped: number;
}

export async function downloadKmlExport(
  scanId: string,
  options: { parcelIds?: string[]; locationId?: string; mode: 'combined' | 'individual' },
): Promise<KmlExportOutcome> {
  const response = await fetch('/api/export/kml', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scanId, ...options }),
  });
  if (!response.ok) await readError(response);

  const filename = filenameFrom(response, options.mode === 'combined' ? 'land-maps.kml' : 'land-maps.zip');
  triggerDownload(await response.blob(), filename);
  return { filename, skipped: Number(response.headers.get('x-skipped-records') ?? '0') };
}

export async function downloadBundle(
  scanId: string,
  options: {
    locationId?: string;
    parcelIds?: string[];
    includeImages: boolean;
    includeKml: boolean;
    includeMetadata: boolean;
    acknowledged: boolean;
    basis?: string;
  },
): Promise<string> {
  const response = await fetch('/api/export/all', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scanId, ...options }),
  });
  if (!response.ok) await readError(response);

  const filename = filenameFrom(response, 'map-data.zip');
  triggerDownload(await response.blob(), filename);
  return filename;
}

/** Square metres rendered in the unit a land record would use. */
export function formatArea(squareMetres: number | null): string {
  if (squareMetres === null || !Number.isFinite(squareMetres)) return 'Not available from source';
  if (squareMetres >= 10_000) return `${(squareMetres / 10_000).toFixed(2)} hectares`;
  return `${Math.round(squareMetres).toLocaleString()} m²`;
}

/** Coordinates are shown at the precision the source offered, not more. */
export function formatCoordinate(value: number): string {
  return value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}
