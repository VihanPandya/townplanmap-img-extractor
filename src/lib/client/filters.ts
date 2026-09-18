'use client';

/**
 * Client-side filtering, searching and sorting.
 *
 * All of it runs on the already-downloaded asset list, so it stays instant even
 * with a few thousand results.
 */

import type {
  AssetKind,
  DiscoveredImage,
  ImageCategory,
  ImageStatus,
  Orientation,
  SizeBucket,
} from '@/lib/types';
import { tokenize } from '@/lib/utils/text';

export type SortKey = 'discovered' | 'filename' | 'dimensions' | 'filesize' | 'type' | 'sourcePage' | 'category';
export type SortDirection = 'asc' | 'desc';
export type ViewMode = 'grid' | 'compact' | 'list';

export interface FilterState {
  search: string;
  /** Empty means both images and geographic data files. */
  kinds: AssetKind[];
  /** Lower-cased extensions, e.g. "jpg". Empty means "all". */
  types: string[];
  sizes: SizeBucket[];
  categories: ImageCategory[];
  orientations: Orientation[];
  statuses: ImageStatus[];
  sourcePages: string[];
  showDuplicates: boolean;
  showBelowMinimum: boolean;
  onlySelected: boolean;
}

export const EMPTY_FILTERS: FilterState = {
  search: '',
  kinds: [],
  types: [],
  sizes: [],
  categories: [],
  orientations: [],
  statuses: [],
  sourcePages: [],
  showDuplicates: true,
  showBelowMinimum: false,
  onlySelected: false,
};

export function filtersAreActive(filters: FilterState): boolean {
  return (
    filters.search.trim().length > 0 ||
    filters.kinds.length > 0 ||
    filters.types.length > 0 ||
    filters.sizes.length > 0 ||
    filters.categories.length > 0 ||
    filters.orientations.length > 0 ||
    filters.statuses.length > 0 ||
    filters.sourcePages.length > 0 ||
    !filters.showDuplicates ||
    filters.showBelowMinimum ||
    filters.onlySelected
  );
}

/** The format label shown in facet lists: real extension, or the MIME subtype. */
export function formatKey(image: DiscoveredImage): string {
  if (image.assetKind === 'geo' && image.geoFormat) return image.geoFormat;
  if (image.extension) return image.extension === 'jpeg' ? 'jpg' : image.extension;
  if (image.mimeType?.startsWith('image/')) {
    const subtype = image.mimeType.slice(6).replace('svg+xml', 'svg').replace('x-icon', 'ico');
    return subtype === 'jpeg' ? 'jpg' : subtype;
  }
  return 'other';
}

export function effectiveCategory(
  image: DiscoveredImage,
  overrides: Record<string, ImageCategory>,
): ImageCategory {
  return overrides[image.id] ?? image.category;
}

/** Tokenised haystack for search. Memoised by the caller via a WeakMap. */
const searchIndex = new WeakMap<DiscoveredImage, string>();

function haystack(image: DiscoveredImage): string {
  const cached = searchIndex.get(image);
  if (cached !== undefined) return cached;
  const value = [
    image.filename,
    image.altText ?? '',
    image.title ?? '',
    image.url,
    image.sourcePage,
    image.sourcePageTitle ?? '',
    image.sourcePageLabel,
    image.category,
    image.sourceTypes.join(' '),
  ]
    .join(' ')
    .toLowerCase();
  searchIndex.set(image, value);
  return value;
}

export function applyFilters(
  images: DiscoveredImage[],
  filters: FilterState,
  overrides: Record<string, ImageCategory>,
  selectedIds: ReadonlySet<string>,
): DiscoveredImage[] {
  const terms = tokenize(filters.search);
  const kindSet = new Set(filters.kinds);
  const typeSet = new Set(filters.types);
  const sizeSet = new Set(filters.sizes);
  const categorySet = new Set(filters.categories);
  const orientationSet = new Set(filters.orientations);
  const statusSet = new Set(filters.statuses);
  const pageSet = new Set(filters.sourcePages);

  return images.filter((image) => {
    if (kindSet.size > 0 && !kindSet.has(image.assetKind)) return false;
    if (!filters.showBelowMinimum && image.belowMinimumSize) return false;
    if (!filters.showDuplicates && image.isDuplicate) return false;
    if (filters.onlySelected && !selectedIds.has(image.id)) return false;
    if (typeSet.size > 0 && !typeSet.has(formatKey(image))) return false;
    if (sizeSet.size > 0 && !sizeSet.has(image.sizeBucket)) return false;
    if (categorySet.size > 0 && !categorySet.has(effectiveCategory(image, overrides))) return false;
    if (orientationSet.size > 0 && !orientationSet.has(image.orientation)) return false;
    if (statusSet.size > 0 && !statusSet.has(image.status)) return false;
    if (pageSet.size > 0 && !image.references.some((reference) => pageSet.has(reference.sourcePage))) {
      return false;
    }
    if (terms.length > 0) {
      const text = haystack(image);
      for (const term of terms) if (!text.includes(term)) return false;
    }
    return true;
  });
}

export function sortImages(
  images: DiscoveredImage[],
  key: SortKey,
  direction: SortDirection,
  overrides: Record<string, ImageCategory>,
): DiscoveredImage[] {
  const factor = direction === 'asc' ? 1 : -1;
  const sorted = [...images];

  sorted.sort((a, b) => {
    let result = 0;
    switch (key) {
      case 'filename':
        result = a.filename.localeCompare(b.filename, undefined, { numeric: true, sensitivity: 'base' });
        break;
      case 'dimensions': {
        const areaA = (a.width ?? 0) * (a.height ?? 0);
        const areaB = (b.width ?? 0) * (b.height ?? 0);
        result = areaA - areaB;
        break;
      }
      case 'filesize':
        result = (a.fileSize ?? -1) - (b.fileSize ?? -1);
        break;
      case 'type':
        result = formatKey(a).localeCompare(formatKey(b));
        break;
      case 'sourcePage':
        result = a.sourcePage.localeCompare(b.sourcePage);
        break;
      case 'category':
        result = effectiveCategory(a, overrides).localeCompare(effectiveCategory(b, overrides));
        break;
      case 'discovered':
      default:
        result = a.seq - b.seq;
        break;
    }
    // A stable tiebreak keeps the grid from reshuffling between polls.
    if (result === 0) result = a.seq - b.seq;
    return result * factor;
  });

  return sorted;
}

export interface Facet<T extends string> {
  value: T;
  label: string;
  count: number;
}

/** Build the counts shown next to each filter option, based on the full set. */
export function buildFacets(images: DiscoveredImage[], overrides: Record<string, ImageCategory>) {
  const types = new Map<string, number>();
  const sizes = new Map<SizeBucket, number>();
  const categories = new Map<ImageCategory, number>();
  const orientations = new Map<Orientation, number>();
  const statuses = new Map<ImageStatus, number>();
  const pages = new Map<string, { count: number; label: string }>();
  const kinds = new Map<AssetKind, number>();
  let belowMinimum = 0;
  let duplicates = 0;

  for (const image of images) {
    kinds.set(image.assetKind, (kinds.get(image.assetKind) ?? 0) + 1);
    types.set(formatKey(image), (types.get(formatKey(image)) ?? 0) + 1);
    sizes.set(image.sizeBucket, (sizes.get(image.sizeBucket) ?? 0) + 1);
    const category = effectiveCategory(image, overrides);
    categories.set(category, (categories.get(category) ?? 0) + 1);
    orientations.set(image.orientation, (orientations.get(image.orientation) ?? 0) + 1);
    statuses.set(image.status, (statuses.get(image.status) ?? 0) + 1);
    if (image.belowMinimumSize) belowMinimum += 1;
    if (image.isDuplicate) duplicates += 1;

    const seenPages = new Set<string>();
    for (const reference of image.references) {
      if (seenPages.has(reference.sourcePage)) continue;
      seenPages.add(reference.sourcePage);
      const entry = pages.get(reference.sourcePage) ?? { count: 0, label: reference.sourcePageLabel };
      entry.count += 1;
      pages.set(reference.sourcePage, entry);
    }
  }

  const toFacets = <T extends string>(map: Map<T, number>, label: (value: T) => string): Facet<T>[] =>
    [...map.entries()]
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([value, count]) => ({ value, label: label(value), count }));

  return {
    kinds: toFacets(kinds, (value) => (value === 'geo' ? 'Geographic data' : 'Images')),
    types: toFacets(types, (value) => value.toUpperCase()),
    sizes: toFacets(sizes, sizeLabel),
    categories: toFacets(categories, categoryLabel),
    orientations: toFacets(orientations, orientationLabel),
    statuses: toFacets(statuses, statusLabel),
    pages: [...pages.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 200)
      .map(([value, entry]) => ({ value, label: entry.label, count: entry.count })),
    belowMinimum,
    duplicates,
  };
}

export function sizeLabel(bucket: SizeBucket): string {
  switch (bucket) {
    case 'tiny':
      return 'Tiny (under 100 px)';
    case 'small':
      return 'Small (100–399 px)';
    case 'medium':
      return 'Medium (400–999 px)';
    case 'large':
      return 'Large (1000–1999 px)';
    case 'very-large':
      return 'Very large (2000 px +)';
    default:
      return 'Unknown size';
  }
}

export function categoryLabel(category: ImageCategory): string {
  switch (category) {
    case 'map':
      return 'Map';
    case 'logo':
      return 'Logo';
    case 'icon':
      return 'Icon';
    case 'photo':
      return 'Photo';
    case 'illustration':
      return 'Illustration';
    case 'thumbnail':
      return 'Thumbnail';
    case 'background':
      return 'Background';
    case 'screenshot':
      return 'Screenshot';
    default:
      return 'Unknown';
  }
}

export function orientationLabel(orientation: Orientation): string {
  switch (orientation) {
    case 'landscape':
      return 'Landscape';
    case 'portrait':
      return 'Portrait';
    case 'square':
      return 'Square';
    case 'panorama':
      return 'Panorama';
    default:
      return 'Unknown';
  }
}

export function statusLabel(status: ImageStatus): string {
  switch (status) {
    case 'available':
      return 'Available';
    case 'unavailable':
      return 'Unavailable';
    case 'redirected':
      return 'Redirected';
    case 'duplicate':
      return 'Duplicate';
    case 'unsupported':
      return 'Unsupported';
    default:
      return 'Not verified';
  }
}

export const ALL_CATEGORIES: ImageCategory[] = [
  'map',
  'photo',
  'logo',
  'icon',
  'illustration',
  'thumbnail',
  'background',
  'screenshot',
  'unknown',
];

export function discoveryLabel(source: string): string {
  switch (source) {
    case 'img':
      return 'IMG';
    case 'srcset':
      return 'SRCSET';
    case 'picture-source':
      return 'PICTURE';
    case 'lazy-attribute':
      return 'LAZY ATTR';
    case 'og-image':
      return 'OG IMAGE';
    case 'twitter-image':
      return 'TWITTER CARD';
    case 'schema-org':
      return 'JSON-LD';
    case 'link-icon':
      return 'SITE ICON';
    case 'css-inline':
      return 'CSS INLINE';
    case 'css-stylesheet':
      return 'CSS SHEET';
    case 'video-poster':
      return 'VIDEO POSTER';
    case 'svg-image':
      return 'SVG IMAGE';
    case 'input-image':
      return 'INPUT IMAGE';
    case 'anchor-href':
      return 'PAGE LINK';
    case 'data-attribute':
      return 'DATA ATTR';
    case 'map-embed':
      return 'MAP EMBED';
    default:
      return 'META';
  }
}
