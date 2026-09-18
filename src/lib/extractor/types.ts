import type { DiscoverySource } from '@/lib/types';

/** One image reference exactly as found in a document, before consolidation. */
export interface RawImageRef {
  originalUrl: string;
  resolvedUrl: string;
  sourceType: DiscoverySource;
  isLazyLoaded: boolean;
  altText: string | null;
  title: string | null;
  declaredWidth: number | null;
  declaredHeight: number | null;
  descriptor: string | null;
  elementPath: string | null;
  /** Nearby text (caption, heading, link target) used only for classification. */
  contextHint: string | null;
}

export interface PageExtraction {
  /** Base used for resolution, honouring any <base href>. */
  baseUrl: string;
  title: string | null;
  /** Same-document links, already absolute and fragment-free. */
  links: string[];
  images: RawImageRef[];
  /** Absolute URLs of linked stylesheets, for optional background-image scanning. */
  stylesheets: string[];
  /** True when the document told us not to index/follow. */
  metaNoFollow: boolean;
}
