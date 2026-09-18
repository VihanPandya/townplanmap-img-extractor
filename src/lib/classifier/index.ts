/**
 * Heuristic image classification.
 *
 * Everything here is a signal-weighted guess derived from observable facts
 * (filename, path, alt text, markup context, dimensions, discovery method).
 * No model is involved and the result is always surfaced to the user as a
 * *detected* category that they can override.
 */

import type { DiscoverySource, ImageCategory, Orientation, SizeBucket } from '@/lib/types';
import { tokenize } from '@/lib/utils/text';

export interface ClassificationInput {
  url: string;
  filename: string;
  extension: string | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  altText: string | null;
  title: string | null;
  sourceTypes: DiscoverySource[];
  contextHints: string[];
  pageUrl: string;
  pageTitle: string | null;
  declaredWidth: number | null;
  declaredHeight: number | null;
}

export interface Classification {
  category: ImageCategory;
  confidence: number;
  reasons: string[];
}

type Signal = { category: ImageCategory; weight: number; reason: string };

/** Words that suggest cartographic or town-planning imagery. */
const MAP_WORDS = [
  'map', 'maps', 'townplan', 'town', 'plan', 'tpscheme', 'tp', 'masterplan', 'layout',
  'cadastral', 'survey', 'zone', 'zoning', 'parcel', 'plot', 'gis', 'satellite', 'aerial',
  'topography', 'topo', 'contour', 'route', 'boundary', 'district', 'ward', 'sector',
  'landuse', 'scheme', 'blueprint', 'siteplan', 'floorplan', 'atlas', 'cartogram',
];

/** Keyword sets. Kept explicit so the reasoning shown to the user is honest. */
const KEYWORDS: Array<[category: ImageCategory, words: string[], weight: number]> = [
  ['map', MAP_WORDS, 3],
  ['logo', ['logo', 'logotype', 'brand', 'branding', 'wordmark', 'lockup', 'emblem', 'monogram'], 3],
  ['icon', ['icon', 'icons', 'favicon', 'sprite', 'glyph', 'symbol', 'pictogram', 'bullet', 'arrow', 'chevron', 'caret', 'badge'], 3],
  ['thumbnail', ['thumb', 'thumbs', 'thumbnail', 'preview', 'tiny', 'mini', 'small', 'crop'], 2],
  ['background', ['bg', 'background', 'backdrop', 'hero', 'banner', 'cover', 'pattern', 'texture', 'gradient', 'overlay', 'watermark'], 2],
  ['screenshot', ['screenshot', 'screenshots', 'screen', 'screengrab', 'capture', 'demo', 'ui'], 2],
  ['illustration', ['illustration', 'illustrations', 'vector', 'drawing', 'graphic', 'artwork', 'sketch', 'cartoon', 'doodle', 'shape', 'blob'], 2],
  ['photo', ['photo', 'photos', 'photograph', 'picture', 'gallery', 'dsc', 'dscn', 'img', 'image', 'portrait', 'team', 'staff', 'building', 'site', 'project'], 1],
];

const SOURCE_SIGNALS: Partial<Record<DiscoverySource, Signal>> = {
  'link-icon': { category: 'icon', weight: 6, reason: 'declared as a site icon via <link rel="icon">' },
  'og-image': { category: 'photo', weight: 2, reason: 'used as the Open Graph sharing image' },
  'twitter-image': { category: 'photo', weight: 2, reason: 'used as the Twitter/X card image' },
  'css-inline': { category: 'background', weight: 3, reason: 'referenced from a CSS background declaration' },
  'css-stylesheet': { category: 'background', weight: 3, reason: 'referenced from a stylesheet background declaration' },
  'video-poster': { category: 'thumbnail', weight: 3, reason: 'used as a video poster frame' },
  'input-image': { category: 'icon', weight: 2, reason: 'used as an image input control' },
};

export function classifyImage(input: ClassificationInput): Classification {
  const signals: Signal[] = [];

  const haystack = [
    input.filename,
    safePath(input.url),
    input.altText ?? '',
    input.title ?? '',
    input.contextHints.join(' '),
  ].join(' ');
  const tokens = new Set(tokenize(haystack));
  const pageTokens = new Set([...tokenize(safePath(input.pageUrl)), ...tokenize(input.pageTitle ?? '')]);

  let assetSuggestsMap = false;
  for (const [category, words, weight] of KEYWORDS) {
    const hits = words.filter((word) => tokens.has(word));
    if (hits.length > 0) {
      if (category === 'map') assetSuggestsMap = true;
      signals.push({
        category,
        weight: weight + Math.min(hits.length - 1, 2),
        reason: `filename, alt text or markup mentions ${hits.slice(0, 3).map((h) => `"${h}"`).join(', ')}`,
      });
    }
  }

  // The page's own subject reinforces a map reading, but never creates one on
  // its own: the target site is about maps, so every asset on it would
  // otherwise be labelled a map, which is exactly what must not happen.
  if (assetSuggestsMap) {
    const mapPageHits = MAP_WORDS.filter((word) => pageTokens.has(word));
    if (mapPageHits.length > 0) {
      signals.push({
        category: 'map',
        weight: 1 + Math.min(mapPageHits.length, 2),
        reason: `found on a page about ${mapPageHits.slice(0, 2).map((h) => `"${h}"`).join(', ')}`,
      });
    }
  }

  for (const source of input.sourceTypes) {
    const signal = SOURCE_SIGNALS[source];
    if (signal) signals.push(signal);
  }

  const width = input.width ?? input.declaredWidth;
  const height = input.height ?? input.declaredHeight;

  if (input.extension === 'ico' || input.mimeType === 'image/x-icon' || input.mimeType === 'image/vnd.microsoft.icon') {
    signals.push({ category: 'icon', weight: 6, reason: 'served as an .ico icon file' });
  }
  if (input.extension === 'svg' || input.mimeType === 'image/svg+xml') {
    const target: ImageCategory = width && width <= 64 ? 'icon' : 'illustration';
    signals.push({ category: target, weight: 2, reason: 'vector (SVG) asset' });
  }

  if (width && height) {
    const area = width * height;
    const ratio = width / height;
    if (width <= 48 && height <= 48) {
      signals.push({ category: 'icon', weight: 5, reason: `very small (${width}×${height})` });
    } else if (width <= 128 && height <= 128 && Math.abs(ratio - 1) < 0.25) {
      signals.push({ category: 'icon', weight: 3, reason: `small and square (${width}×${height})` });
    } else if (width <= 320 && height <= 320) {
      signals.push({ category: 'thumbnail', weight: 2, reason: `thumbnail-sized (${width}×${height})` });
    }
    if (ratio >= 3 && width >= 900) {
      signals.push({ category: 'background', weight: 2, reason: `very wide banner ratio (${ratio.toFixed(1)}:1)` });
    }
    if (area >= 1_000_000 && ratio > 0.5 && ratio < 2) {
      signals.push({ category: 'photo', weight: 1, reason: `large photographic dimensions (${width}×${height})` });
    }
    // Map exports are frequently large and close to square or landscape.
    if (area >= 400_000 && ratio > 0.6 && ratio < 2.2 && tokens.has('map')) {
      signals.push({ category: 'map', weight: 2, reason: 'large map-shaped raster' });
    }
  }

  if (input.extension === 'png' && width && width <= 64) {
    signals.push({ category: 'icon', weight: 1, reason: 'small PNG, typical of UI iconography' });
  }

  if (signals.length === 0) {
    return { category: 'unknown', confidence: 0, reasons: ['No distinguishing signals were found.'] };
  }

  const totals = new Map<ImageCategory, { weight: number; reasons: string[] }>();
  for (const signal of signals) {
    const entry = totals.get(signal.category) ?? { weight: 0, reasons: [] };
    entry.weight += signal.weight;
    if (!entry.reasons.includes(signal.reason)) entry.reasons.push(signal.reason);
    totals.set(signal.category, entry);
  }

  let best: { category: ImageCategory; weight: number; reasons: string[] } | null = null;
  let sum = 0;
  for (const [category, entry] of totals) {
    sum += entry.weight;
    if (!best || entry.weight > best.weight) best = { category, ...entry };
  }
  if (!best) return { category: 'unknown', confidence: 0, reasons: [] };

  const confidence = Math.min(0.95, Math.max(0.2, best.weight / Math.max(sum, 1)));
  return { category: best.category, confidence: Number(confidence.toFixed(2)), reasons: best.reasons.slice(0, 4) };
}

function safePath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname} ${parsed.search}`;
  } catch {
    return url;
  }
}

export function orientationOf(width: number | null, height: number | null): Orientation {
  if (!width || !height) return 'unknown';
  const ratio = width / height;
  if (ratio >= 2.4) return 'panorama';
  if (ratio > 1.08) return 'landscape';
  if (ratio < 0.92) return 'portrait';
  return 'square';
}

export function sizeBucketOf(width: number | null, height: number | null): SizeBucket {
  if (!width || !height) return 'unknown';
  const longest = Math.max(width, height);
  if (longest < 100) return 'tiny';
  if (longest < 400) return 'small';
  if (longest < 1000) return 'medium';
  if (longest < 2000) return 'large';
  return 'very-large';
}
