/**
 * HTML image + link extraction.
 *
 * Parsing is done with cheerio, which builds an inert DOM: no scripts run, no
 * network requests are triggered and no styles are resolved. Everything below
 * is pure string inspection of that tree.
 */

import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { extractCssUrls } from './css';
import { extractJsonLdImages } from './jsonld';
import type { PageExtraction, RawImageRef } from './types';
import { parseSrcset } from '@/lib/normalizer/srcset';
import { isFetchableUrlCandidate, looksLikePage, resolveUrl } from '@/lib/normalizer/url';
import type { DiscoverySource } from '@/lib/types';
import { cleanText } from '@/lib/utils/text';

/**
 * Attributes commonly used by lazy-loading libraries to hold the real source.
 * The extractor never assumes any of these exist - each is probed individually.
 */
const LAZY_SRC_ATTRIBUTES = [
  'data-src',
  'data-original',
  'data-lazy-src',
  'data-lazy',
  'data-echo',
  'data-url',
  'data-image',
  'data-img',
  'data-image-src',
  'data-full-src',
  'data-large',
  'data-large-file',
  'data-large_image',
  'data-medium-file',
  'data-hi-res-src',
  'data-thumb',
  'data-thumbnail',
  'data-poster',
  'data-bg',
  'data-background',
  'data-background-image',
  'data-bg-src',
  'data-defer-src',
  'data-cfsrc',
  'data-srcset-fallback',
];

const LAZY_SRCSET_ATTRIBUTES = ['data-srcset', 'data-lazy-srcset', 'data-original-set', 'data-responsive'];

const ICON_REL_VALUES = new Set([
  'icon',
  'shortcut icon',
  'apple-touch-icon',
  'apple-touch-icon-precomposed',
  'mask-icon',
  'fluid-icon',
  'apple-touch-startup-image',
]);

const META_IMAGE_KEYS: Array<[key: string, source: DiscoverySource]> = [
  ['og:image', 'og-image'],
  ['og:image:url', 'og-image'],
  ['og:image:secure_url', 'og-image'],
  ['twitter:image', 'twitter-image'],
  ['twitter:image:src', 'twitter-image'],
  ['twitter:image0', 'twitter-image'],
  ['msapplication-tileimage', 'meta-other'],
  ['thumbnail', 'meta-other'],
  ['image', 'meta-other'],
  ['vk:image', 'meta-other'],
];

const MAX_REFS_PER_PAGE = 2000;
const MAX_LINKS_PER_PAGE = 500;

export function extractFromHtml(html: string, pageUrl: string): PageExtraction {
  const $ = cheerio.load(html, { xml: false });

  // <base href> changes how every relative URL on the page resolves.
  const baseHref = $('base[href]').first().attr('href');
  let baseUrl = pageUrl;
  if (baseHref) {
    const resolved = resolveUrl(baseHref, pageUrl);
    if (resolved) baseUrl = resolved.resolved;
  }

  const images: RawImageRef[] = [];
  const seen = new Set<string>();

  const add = (
    raw: string | undefined | null,
    sourceType: DiscoverySource,
    extra: Partial<RawImageRef> = {},
  ): void => {
    if (images.length >= MAX_REFS_PER_PAGE) return;
    const value = (raw ?? '').trim();
    if (!value || !isFetchableUrlCandidate(value)) return;
    const resolved = resolveUrl(value, baseUrl);
    if (!resolved) return;
    const key = `${sourceType}|${resolved.resolved}|${extra.descriptor ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    images.push({
      originalUrl: resolved.original,
      resolvedUrl: resolved.resolved,
      sourceType,
      isLazyLoaded: false,
      altText: null,
      title: null,
      declaredWidth: null,
      declaredHeight: null,
      descriptor: null,
      elementPath: null,
      contextHint: null,
      ...extra,
    });
  };

  // ---------------------------------------------------------------- <img>
  $('img').each((_, node) => {
    const el = $(node);
    const alt = cleanText(el.attr('alt'));
    const title = cleanText(el.attr('title'));
    const path = describeElement($, node);
    const context = contextFor($, node);
    const declaredWidth = numericAttr(el.attr('width'));
    const declaredHeight = numericAttr(el.attr('height'));
    const shared = {
      altText: alt,
      title,
      declaredWidth,
      declaredHeight,
      elementPath: path,
      contextHint: context,
    };

    add(el.attr('src'), 'img', shared);

    for (const candidate of parseSrcset(el.attr('srcset'))) {
      add(candidate.url, 'srcset', {
        ...shared,
        descriptor: candidate.descriptor,
        declaredWidth: candidate.width ?? declaredWidth,
      });
    }

    for (const attribute of LAZY_SRC_ATTRIBUTES) {
      const value = el.attr(attribute);
      if (value) add(value, 'lazy-attribute', { ...shared, isLazyLoaded: true });
    }
    for (const attribute of LAZY_SRCSET_ATTRIBUTES) {
      for (const candidate of parseSrcset(el.attr(attribute))) {
        add(candidate.url, 'lazy-attribute', {
          ...shared,
          isLazyLoaded: true,
          descriptor: candidate.descriptor,
          declaredWidth: candidate.width ?? declaredWidth,
        });
      }
    }
  });

  // ------------------------------------------------- <picture> / <source>
  $('picture source, source[srcset], source[src]').each((_, node) => {
    const el = $(node);
    const type = el.attr('type');
    if (type && !type.toLowerCase().startsWith('image/')) return;
    const parentImg = el.closest('picture').find('img').first();
    const shared = {
      altText: cleanText(parentImg.attr('alt')),
      title: cleanText(parentImg.attr('title')),
      elementPath: describeElement($, node),
      contextHint: contextFor($, node),
    };
    for (const candidate of parseSrcset(el.attr('srcset'))) {
      add(candidate.url, 'picture-source', {
        ...shared,
        descriptor: candidate.descriptor,
        declaredWidth: candidate.width,
      });
    }
    const src = el.attr('src');
    if (src) add(src, 'picture-source', shared);
    for (const attribute of LAZY_SRCSET_ATTRIBUTES) {
      for (const candidate of parseSrcset(el.attr(attribute))) {
        add(candidate.url, 'lazy-attribute', {
          ...shared,
          isLazyLoaded: true,
          descriptor: candidate.descriptor,
          declaredWidth: candidate.width,
        });
      }
    }
  });

  // ------------------------------------- lazy attributes on other elements
  const lazySelector = [...LAZY_SRC_ATTRIBUTES, ...LAZY_SRCSET_ATTRIBUTES]
    .map((attribute) => `[${attribute}]`)
    .join(',');
  $(lazySelector).each((_, node) => {
    if (isTag(node) && (node.tagName === 'img' || node.tagName === 'source')) return;
    const el = $(node);
    const shared = {
      isLazyLoaded: true,
      altText: cleanText(el.attr('alt') ?? el.attr('aria-label')),
      title: cleanText(el.attr('title')),
      elementPath: describeElement($, node),
      contextHint: contextFor($, node),
    };
    for (const attribute of LAZY_SRC_ATTRIBUTES) {
      const value = el.attr(attribute);
      if (value && !value.includes(',')) add(value, 'lazy-attribute', shared);
    }
    for (const attribute of LAZY_SRCSET_ATTRIBUTES) {
      for (const candidate of parseSrcset(el.attr(attribute))) {
        add(candidate.url, 'lazy-attribute', { ...shared, descriptor: candidate.descriptor });
      }
    }
  });

  // ------------------------------------------------------- meta / social
  $('meta').each((_, node) => {
    const el = $(node);
    const name = (el.attr('property') ?? el.attr('name') ?? el.attr('itemprop') ?? '').toLowerCase();
    if (!name) return;
    const content = el.attr('content');
    if (!content) return;
    for (const [key, source] of META_IMAGE_KEYS) {
      if (name === key) {
        add(content, source, { altText: null, contextHint: `meta ${name}` });
        break;
      }
    }
  });

  // --------------------------------------------------------- <link> icons
  $('link[rel]').each((_, node) => {
    const el = $(node);
    const rel = (el.attr('rel') ?? '').toLowerCase().trim();
    const href = el.attr('href');
    if (!href) return;
    if (ICON_REL_VALUES.has(rel) || rel.split(/\s+/).some((token) => ICON_REL_VALUES.has(token))) {
      const sizes = el.attr('sizes');
      const parsed = sizes ? /^(\d+)x(\d+)$/i.exec(sizes.trim()) : null;
      add(href, 'link-icon', {
        contextHint: `link rel=${rel}`,
        declaredWidth: parsed ? Number(parsed[1]) : null,
        declaredHeight: parsed ? Number(parsed[2]) : null,
        elementPath: `link[rel="${rel}"]`,
      });
    } else if (rel === 'image_src') {
      add(href, 'meta-other', { contextHint: 'link rel=image_src' });
    }
  });

  // ------------------------------------------------- inline style + <style>
  $('[style]').each((_, node) => {
    const style = $(node).attr('style');
    if (!style || !style.includes('url(')) return;
    const path = describeElement($, node);
    for (const ref of extractCssUrls(style, 12)) {
      add(ref.url, 'css-inline', {
        elementPath: path,
        contextHint: ref.context ?? 'inline style',
      });
    }
  });

  $('style').each((_, node) => {
    const css = $(node).text();
    if (!css || !css.includes('url(')) return;
    for (const ref of extractCssUrls(css, 120)) {
      add(ref.url, 'css-inline', { contextHint: ref.context ?? 'style block', elementPath: 'style' });
    }
  });

  // ------------------------------------------------------------- JSON-LD
  $('script[type="application/ld+json"]').each((_, node) => {
    const raw = $(node).text();
    if (!raw || raw.length > 400_000) return;
    for (const item of extractJsonLdImages(raw)) {
      add(item.url, 'schema-org', {
        contextHint: `json-ld ${item.nodeType ?? item.key}`,
        elementPath: 'script[type="application/ld+json"]',
      });
    }
  });

  // ------------------------------------------------ posters, svg, inputs
  $('video[poster]').each((_, node) => {
    add($(node).attr('poster'), 'video-poster', {
      elementPath: describeElement($, node),
      contextHint: 'video poster',
    });
  });
  $('image[href], image[xlink\\:href]').each((_, node) => {
    const el = $(node);
    add(el.attr('href') ?? el.attr('xlink:href'), 'svg-image', {
      elementPath: describeElement($, node),
      contextHint: 'svg image',
    });
  });
  $('input[type="image"][src]').each((_, node) => {
    const el = $(node);
    add(el.attr('src'), 'input-image', {
      altText: cleanText(el.attr('alt')),
      elementPath: describeElement($, node),
    });
  });
  $('object[type^="image/"][data]').each((_, node) => {
    add($(node).attr('data'), 'meta-other', { elementPath: describeElement($, node) });
  });

  // --------------------------------------------------------------- links
  const links: string[] = [];
  const linkSeen = new Set<string>();
  $('a[href]').each((_, node) => {
    if (links.length >= MAX_LINKS_PER_PAGE) return;
    const rel = ($(node).attr('rel') ?? '').toLowerCase();
    if (rel.includes('nofollow')) return;
    const href = $(node).attr('href');
    if (!href) return;
    const resolved = resolveUrl(href, baseUrl);
    if (!resolved || linkSeen.has(resolved.resolved)) return;
    if (!looksLikePage(resolved.resolved)) return;
    linkSeen.add(resolved.resolved);
    links.push(resolved.resolved);
  });

  // ---------------------------------------------------------- stylesheets
  const stylesheets: string[] = [];
  $('link[rel~="stylesheet"][href]').each((_, node) => {
    const href = $(node).attr('href');
    if (!href) return;
    const resolved = resolveUrl(href, baseUrl);
    if (resolved && !stylesheets.includes(resolved.resolved)) stylesheets.push(resolved.resolved);
  });

  const robotsMeta = ($('meta[name="robots"]').attr('content') ?? '').toLowerCase();

  return {
    baseUrl,
    title: cleanText($('title').first().text()),
    links,
    images,
    stylesheets,
    metaNoFollow: robotsMeta.includes('nofollow') || robotsMeta.includes('none'),
  };
}

function isTag(node: AnyNode): node is Element {
  return node.type === 'tag' || node.type === 'script' || node.type === 'style';
}

function numericAttr(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^(\d+)(px)?$/i.exec(value.trim());
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** A short "section.hero > img.logo" breadcrumb for the details panel. */
function describeElement($: cheerio.CheerioAPI, node: AnyNode): string | null {
  if (!isTag(node)) return null;
  const parts: string[] = [];
  let current: AnyNode | null = node;
  let depth = 0;
  while (current && isTag(current) && depth < 3) {
    const el: Element = current;
    const id = el.attribs?.['id'];
    const className = el.attribs?.['class'];
    let descriptor = el.tagName;
    if (id) descriptor += `#${id}`;
    else if (className) {
      const first = className.split(/\s+/).filter(Boolean)[0];
      if (first) descriptor += `.${first}`;
    }
    parts.unshift(descriptor);
    current = el.parent as AnyNode | null;
    depth += 1;
  }
  const path = parts.join(' > ');
  return path.length > 0 ? path.slice(0, 160) : null;
}

/** Caption / heading / link text near an element, used only as a classifier hint. */
function contextFor($: cheerio.CheerioAPI, node: AnyNode): string | null {
  if (!isTag(node)) return null;
  const el = $(node);
  const pieces: Array<string | null> = [];

  const figure = el.closest('figure');
  if (figure.length > 0) pieces.push(cleanText(figure.find('figcaption').first().text()));

  const anchor = el.closest('a');
  if (anchor.length > 0) pieces.push(cleanText(anchor.attr('href')));

  const section = el.closest('section, article, header, footer, nav, aside, main');
  if (section.length > 0) {
    const tag = (section.get(0) as Element | undefined)?.tagName;
    if (tag) pieces.push(tag);
    const heading = section.find('h1, h2, h3').first();
    if (heading.length > 0) pieces.push(cleanText(heading.text()));
  }

  const parentClass = el.parent().attr('class');
  if (parentClass) pieces.push(parentClass.slice(0, 120));

  const joined = pieces.filter(Boolean).join(' | ');
  return joined.length > 0 ? joined.slice(0, 300) : null;
}
