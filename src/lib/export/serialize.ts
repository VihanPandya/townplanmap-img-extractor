/**
 * Export serialisers.
 *
 * Exports contain *references and metadata only*. The application never bundles
 * image bytes into a download, because discovering an image says nothing about
 * whether the user has the right to redistribute it.
 */

import type { DiscoveredImage, ExportFormat, ImageCategory } from '@/lib/types';

export interface ExportOptions {
  scanUrl: string;
  scanId: string;
  categoryOverrides?: Record<string, ImageCategory>;
}

export interface ExportPayload {
  body: string;
  contentType: string;
  filename: string;
}

function effectiveCategory(image: DiscoveredImage, overrides?: Record<string, ImageCategory>): ImageCategory {
  return overrides?.[image.id] ?? image.category;
}

/** RFC 4180 quoting: wrap in quotes and double any embedded quote. */
function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function serializeExport(
  images: DiscoveredImage[],
  format: ExportFormat,
  options: ExportOptions,
): ExportPayload {
  const stamp = new Date().toISOString().slice(0, 10);
  const host = safeHost(options.scanUrl);
  const base = `image-references-${host}-${stamp}`;

  if (format === 'txt') {
    const lines = images.map((image) => image.url);
    return {
      body: `${lines.join('\n')}\n`,
      contentType: 'text/plain; charset=utf-8',
      filename: `${base}.txt`,
    };
  }

  if (format === 'csv') {
    const header = [
      'Filename',
      'Image URL',
      'Source Page',
      'Width',
      'Height',
      'Format',
      'Alt Text',
      'Category',
      'Discovery Method',
      'Status',
      'File Size (bytes)',
      'Pages Found On',
      'References',
      'Duplicate Of',
    ];
    const rows = images.map((image) =>
      [
        csvCell(image.filename),
        csvCell(image.url),
        csvCell(image.sourcePage),
        csvCell(image.width),
        csvCell(image.height),
        csvCell(image.mimeType ?? image.extension ?? ''),
        csvCell(image.altText ?? ''),
        csvCell(effectiveCategory(image, options.categoryOverrides)),
        csvCell(image.sourceTypes.join(' + ')),
        csvCell(image.status),
        csvCell(image.fileSize),
        csvCell(image.pageCount),
        csvCell(image.referenceCount),
        csvCell(image.duplicateOf ?? ''),
      ].join(','),
    );
    return {
      body: `${[header.join(','), ...rows].join('\r\n')}\r\n`,
      contentType: 'text/csv; charset=utf-8',
      filename: `${base}.csv`,
    };
  }

  const payload = {
    tool: 'TownPlanMap Image Explorer',
    exportedAt: new Date().toISOString(),
    scanId: options.scanId,
    scannedUrl: options.scanUrl,
    imageCount: images.length,
    notice:
      'These are references and metadata for publicly accessible images discovered on the scanned site. Rights to the images themselves remain with their owners.',
    images: images.map((image) => ({
      ...image,
      category: effectiveCategory(image, options.categoryOverrides),
      categoryWasOverridden: Boolean(options.categoryOverrides?.[image.id]),
    })),
  };

  return {
    body: `${JSON.stringify(payload, null, 2)}\n`,
    contentType: 'application/json; charset=utf-8',
    filename: `${base}.json`,
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').replace(/[^a-z0-9.-]/gi, '-');
  } catch {
    return 'site';
  }
}
