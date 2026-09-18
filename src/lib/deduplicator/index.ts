/**
 * Duplicate detection.
 *
 * Three independent layers, applied in order of confidence:
 *
 *  1. URL identity - the canonical URL (tracking and cache-buster parameters
 *     removed, parameters ordered) is the primary key. Two references with the
 *     same canonical URL are the same asset, full stop.
 *  2. Content identity - when the prober was able to read a whole response
 *     body, its SHA-256 is compared. Identical bytes served from two different
 *     URLs are marked as duplicates of the first asset seen.
 *  3. Variant grouping - responsive derivatives (`photo-300x200.jpg`,
 *     `photo@2x.jpg`, `photo.jpg?w=300`) are grouped so the gallery can offer a
 *     "responsive variants" view. These are *related*, not identical, so they
 *     are never silently hidden.
 */

import { canonicalUrl, filenameFromUrl } from '@/lib/normalizer/url';
import type { DiscoveredImage } from '@/lib/types';

/** Suffixes WordPress, Shopify and friends append to resized derivatives. */
const RESPONSIVE_SUFFIX = /[-_@]((\d{2,5})x(\d{2,5})|\d{1,2}x|scaled|thumb(nail)?|small|medium|large|mobile|desktop|retina|\d{2,5}w)$/i;

/** Query parameters used by image CDNs to request a resize of the same artwork. */
const RESIZE_PARAMS = new Set(['w', 'h', 'width', 'height', 'size', 'resize', 'fit', 'q', 'quality', 'dpr', 'format', 'fm', 'auto', 'crop']);

export function dedupeKey(url: string): string {
  return canonicalUrl(url);
}

/**
 * Key shared by responsive derivatives of the same artwork.
 * Returns null when the URL shows no sign of being a derivative.
 */
export function variantGroupKey(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const filename = filenameFromUrl(url);
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';

  let normalisedStem = stem;
  let changed = false;
  // Strip repeated suffixes: "photo-1024x768-300x200" collapses fully.
  for (let i = 0; i < 3; i += 1) {
    const next = normalisedStem.replace(RESPONSIVE_SUFFIX, '');
    if (next === normalisedStem) break;
    normalisedStem = next;
    changed = true;
  }

  const hadResizeParams = [...parsed.searchParams.keys()].some((key) => RESIZE_PARAMS.has(key.toLowerCase()));
  if (!changed && !hadResizeParams) return null;

  const directory = parsed.pathname.slice(0, parsed.pathname.lastIndexOf('/') + 1);
  // Different raster formats of the same artwork share a group; SVG does not.
  const formatClass = extension === 'svg' ? 'svg' : 'raster';
  return `${parsed.host}${directory}${normalisedStem}#${formatClass}`;
}

export interface DedupeStats {
  references: number;
  unique: number;
  duplicates: number;
  byContentHash: number;
  variantGroups: number;
}

/**
 * Mark content-hash duplicates across an already URL-deduplicated set.
 * The earliest discovered asset in each hash group is kept as the original.
 */
export function markContentDuplicates(images: DiscoveredImage[]): number {
  const byHash = new Map<string, DiscoveredImage>();
  let marked = 0;

  const ordered = [...images].sort((a, b) => a.seq - b.seq);
  for (const image of ordered) {
    if (!image.contentHash) continue;
    const existing = byHash.get(image.contentHash);
    if (!existing) {
      byHash.set(image.contentHash, image);
      continue;
    }
    if (image.id === existing.id || image.isDuplicate) continue;
    image.isDuplicate = true;
    image.duplicateOf = existing.id;
    if (image.status === 'available') image.status = 'duplicate';
    marked += 1;
  }

  return marked;
}

export function computeStats(images: DiscoveredImage[]): DedupeStats {
  let references = 0;
  let duplicates = 0;
  const groups = new Set<string>();
  let byContentHash = 0;

  for (const image of images) {
    references += image.referenceCount;
    if (image.isDuplicate) {
      duplicates += 1;
      if (image.contentHash) byContentHash += 1;
    }
    if (image.variantGroup) groups.add(image.variantGroup);
  }

  return {
    references,
    unique: images.length,
    duplicates,
    byContentHash,
    variantGroups: groups.size,
  };
}
