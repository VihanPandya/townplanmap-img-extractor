'use client';

/** Typed wrappers around the scan API, with readable errors for the UI. */

import type {
  ApiError,
  CreateScanResponse,
  DiscoveredImage,
  ExportFormat,
  ImageCategory,
  ScanDetail,
  ScanImagesPage,
  ScanSettings,
  ScanSummary,
} from '@/lib/types';

export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: string | null;

  constructor(code: string, message: string, status: number, detail: string | null = null) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

async function readError(response: Response): Promise<never> {
  let payload: ApiError | null = null;
  try {
    payload = (await response.json()) as ApiError;
  } catch {
    /* fall through to a generic message */
  }
  throw new ApiRequestError(
    payload?.error?.code ?? 'request-failed',
    payload?.error?.message ?? `The request failed with HTTP ${response.status}.`,
    response.status,
    payload?.error?.detail ?? null,
  );
}

export async function startScan(
  url: string,
  settings: Partial<ScanSettings>,
  signal?: AbortSignal,
): Promise<CreateScanResponse> {
  const response = await fetch('/api/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, settings }),
    signal,
  });
  if (!response.ok) await readError(response);
  return (await response.json()) as CreateScanResponse;
}

export async function fetchScan(scanId: string, signal?: AbortSignal): Promise<ScanDetail> {
  const response = await fetch(`/api/scan/${encodeURIComponent(scanId)}`, { signal, cache: 'no-store' });
  if (!response.ok) await readError(response);
  return (await response.json()) as ScanDetail;
}

export async function fetchScanImages(
  scanId: string,
  since: number,
  signal?: AbortSignal,
): Promise<ScanImagesPage> {
  const response = await fetch(
    `/api/scan/${encodeURIComponent(scanId)}/images?since=${since}`,
    { signal, cache: 'no-store' },
  );
  if (!response.ok) await readError(response);
  return (await response.json()) as ScanImagesPage;
}

export async function controlScan(
  scanId: string,
  action: 'pause' | 'resume' | 'stop',
): Promise<void> {
  const response = await fetch(`/api/scan/${encodeURIComponent(scanId)}/control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  if (!response.ok) await readError(response);
}

export async function fetchScanHistory(signal?: AbortSignal): Promise<ScanSummary[]> {
  const response = await fetch('/api/scan', { signal, cache: 'no-store' });
  if (!response.ok) await readError(response);
  const payload = (await response.json()) as { scans: ScanSummary[] };
  return payload.scans;
}

export async function fetchImage(imageId: string, scanId: string): Promise<DiscoveredImage> {
  const response = await fetch(
    `/api/image/${encodeURIComponent(imageId)}?scanId=${encodeURIComponent(scanId)}`,
    { cache: 'no-store' },
  );
  if (!response.ok) await readError(response);
  const payload = (await response.json()) as { image: DiscoveredImage };
  return payload.image;
}

/** Ask the server for an export and hand the file to the browser. */
export async function downloadExport(
  scanId: string,
  format: ExportFormat,
  imageIds: string[] | null,
  categoryOverrides: Record<string, ImageCategory>,
): Promise<string> {
  const response = await fetch('/api/export', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      scanId,
      format,
      ...(imageIds && imageIds.length > 0 ? { imageIds } : {}),
      categoryOverrides,
    }),
  });
  if (!response.ok) await readError(response);

  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(disposition);
  const filename = match?.[1] ?? `image-references.${format}`;

  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next tick so the download has certainly started.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  return filename;
}

/** The server-side relay, used only when a direct <img> load fails. */
export function previewUrl(image: DiscoveredImage, scanId: string): string {
  return `/api/preview/${encodeURIComponent(image.id)}?scanId=${encodeURIComponent(scanId)}`;
}
