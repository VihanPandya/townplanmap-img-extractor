/**
 * POST /api/download - retrieve selected assets as a ZIP archive.
 *
 * This is the one endpoint that returns file *contents* rather than references,
 * so it is deliberately the most constrained:
 *
 *  - only ids already present in a stored scan are fetched, never a
 *    caller-supplied URL, so it cannot be used as a general downloader
 *  - the caller must acknowledge they have the right to retrieve the files;
 *    the acknowledgement is recorded inside the archive's manifest
 *  - every fetch goes through the same SSRF-guarded client as the crawler
 *  - entry count, per-file size and total archive size are all capped
 *  - the archive streams, so a large selection never sits in server memory
 */

import type { NextRequest } from 'next/server';
import { errorResponse, jsonError } from '@/lib/api/respond';
import { getScanStore } from '@/lib/database/store';
import { assertWithinZipLimits, ZipBuilder, ZipLimitError } from '@/lib/download/zip';
import { safeFetch } from '@/lib/security/http';
import type { DiscoveredImage } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Caps. Generous enough for a real town-planning archive, bounded enough to be safe. */
const MAX_FILES = 500;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const FETCH_CONCURRENCY = 3;

interface DownloadRequest {
  scanId: string;
  imageIds?: string[];
  /** Must be true. The caller states they may retrieve these files. */
  acknowledged?: boolean;
  /** Optional free-text basis, recorded in the manifest. */
  basis?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as DownloadRequest;
    if (!body?.scanId) return jsonError('bad-request', 'A "scanId" is required.', 400);

    if (body.acknowledged !== true) {
      return jsonError(
        'acknowledgement-required',
        'Confirm that you have the right to retrieve these files before downloading them.',
        403,
        'This tool discovers publicly reachable files; that does not by itself grant permission to download or reuse them. Rights remain with the original owner.',
      );
    }

    const store = getScanStore();
    const record = await store.get(body.scanId);
    if (!record) {
      return jsonError('scan-not-found', 'That scan is no longer available, so its files cannot be fetched.', 404);
    }

    const all = [...record.images.values()].sort((a, b) => a.seq - b.seq);
    const requested =
      Array.isArray(body.imageIds) && body.imageIds.length > 0
        ? all.filter((asset) => body.imageIds!.includes(asset.id))
        : all;

    // Assets already known to be unretrievable are skipped rather than retried.
    const selected = requested.filter(
      (asset) => asset.status !== 'unavailable' && asset.status !== 'unsupported',
    );

    if (selected.length === 0) {
      return jsonError(
        'nothing-to-download',
        requested.length === 0
          ? 'No files matched that selection.'
          : 'None of the selected files could be retrieved when the site was scanned.',
        400,
      );
    }
    if (selected.length > MAX_FILES) {
      return jsonError(
        'too-many-files',
        `A single download is limited to ${MAX_FILES} files; ${selected.length} were selected.`,
        400,
      );
    }

    try {
      assertWithinZipLimits(selected.length, 0);
    } catch (error) {
      if (error instanceof ZipLimitError) return jsonError('too-large', error.message, 400);
      throw error;
    }

    const host = safeHost(record.url);
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `${host}-assets-${stamp}.zip`;

    const stream = buildArchive(selected, {
      scanUrl: record.url,
      scanId: record.id,
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

interface ManifestContext {
  scanUrl: string;
  scanId: string;
  basis: string | null;
}

interface ManifestRow {
  entry: string | null;
  url: string;
  sourcePage: string;
  bytes: number | null;
  status: string;
  note: string;
}

/**
 * Fetch the selected assets and emit ZIP bytes as they become available.
 *
 * Files are fetched a few at a time, but written to the archive strictly in
 * order so the central directory offsets stay correct.
 */
function buildArchive(assets: DiscoveredImage[], context: ManifestContext): ReadableStream<Uint8Array> {
  const zip = new ZipBuilder();
  const rows: ManifestRow[] = [];
  let totalBytes = 0;
  let index = 0;
  let finished = false;

  // A small look-ahead window: fetch ahead of the writer without unbounded work.
  const inflight = new Map<number, Promise<{ asset: DiscoveredImage; body: Buffer | null; note: string }>>();

  const fetchOne = async (asset: DiscoveredImage) => {
    try {
      const response = await safeFetch(asset.url, {
        accept: asset.assetKind === 'geo' ? '*/*' : 'image/*,*/*;q=0.8',
        referer: asset.sourcePage,
        limits: { maxBytes: MAX_FILE_BYTES, timeoutMs: 45_000, maxRedirects: 4 },
      });
      if (response.status >= 400) {
        return { asset, body: null, note: `skipped: HTTP ${response.status}` };
      }
      if (response.truncated) {
        return { asset, body: null, note: `skipped: larger than the ${MAX_FILE_BYTES / 1024 / 1024} MB per-file limit` };
      }
      return { asset, body: response.body, note: 'included' };
    } catch (error) {
      return {
        asset,
        body: null,
        note: `skipped: ${error instanceof Error ? error.message : 'request failed'}`,
      };
    }
  };

  const pump = () => {
    while (inflight.size < FETCH_CONCURRENCY && index + inflight.size < assets.length) {
      const next = index + inflight.size;
      inflight.set(next, fetchOne(assets[next]!));
    }
  };

  return new ReadableStream<Uint8Array>({
    start() {
      pump();
    },
    async pull(controller) {
      if (finished) return;

      if (index >= assets.length) {
        // Manifest last, so it records what actually made it in.
        const manifest = Buffer.from(renderManifest(rows, context, totalBytes), 'utf8');
        controller.enqueue(zip.add({ name: zip.reserveName('MANIFEST.csv', 'MANIFEST.csv'), data: manifest }));
        controller.enqueue(zip.end());
        controller.close();
        finished = true;
        return;
      }

      const pending = inflight.get(index);
      inflight.delete(index);
      const result = pending ? await pending : await fetchOne(assets[index]!);
      index += 1;
      pump();

      const { asset, body, note } = result;
      if (!body) {
        rows.push({
          entry: null,
          url: asset.url,
          sourcePage: asset.sourcePage,
          bytes: null,
          status: 'skipped',
          note,
        });
        return;
      }

      if (totalBytes + body.length > MAX_TOTAL_BYTES) {
        rows.push({
          entry: null,
          url: asset.url,
          sourcePage: asset.sourcePage,
          bytes: body.length,
          status: 'skipped',
          note: 'skipped: the archive reached its total size limit',
        });
        return;
      }

      const folder = asset.assetKind === 'geo' ? 'geo-data' : 'images';
      const entryName = zip.reserveName(`${folder}/${asset.filename}`, `${folder}/asset-${asset.seq}`);
      // reserveName keeps only the final segment, so the folder is re-applied.
      const name = `${folder}/${entryName}`;
      controller.enqueue(zip.add({ name, data: body }));
      totalBytes += body.length;
      rows.push({
        entry: name,
        url: asset.url,
        sourcePage: asset.sourcePage,
        bytes: body.length,
        status: 'included',
        note,
      });
    },
    cancel() {
      finished = true;
      inflight.clear();
    },
  });
}

function csvCell(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A record of where every file came from, and on what basis it was retrieved. */
function renderManifest(rows: ManifestRow[], context: ManifestContext, totalBytes: number): string {
  const included = rows.filter((row) => row.status === 'included').length;
  const header = [
    `# Retrieved by TownPlanMap Image Explorer on ${new Date().toISOString()}`,
    `# Scanned site: ${context.scanUrl}`,
    `# Scan id: ${context.scanId}`,
    `# Files included: ${included} of ${rows.length} selected (${totalBytes} bytes)`,
    `# Stated basis for retrieval: ${context.basis ?? 'the downloader confirmed they have the right to retrieve these files'}`,
    '# These files were downloaded from a publicly reachable website. Copyright and',
    '# licensing remain with the original owner; this manifest is not a licence.',
    '',
    ['Archive Entry', 'Source URL', 'Found On Page', 'Bytes', 'Status', 'Note'].join(','),
  ].join('\n');

  const body = rows
    .map((row) =>
      [
        csvCell(row.entry),
        csvCell(row.url),
        csvCell(row.sourcePage),
        csvCell(row.bytes),
        csvCell(row.status),
        csvCell(row.note),
      ].join(','),
    )
    .join('\r\n');

  return `${header}\r\n${body}\r\n`;
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').replace(/[^a-z0-9.-]/gi, '-');
  } catch {
    return 'site';
  }
}
