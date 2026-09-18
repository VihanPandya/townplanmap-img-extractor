import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSrcset } from '@/lib/normalizer/srcset';
import {
  canonicalPageUrl,
  canonicalUrl,
  extensionFromUrl,
  filenameFromUrl,
  isSameSite,
  looksLikePage,
  pageLabel,
  resolveUrl,
} from '@/lib/normalizer/url';
import { RobotsPolicy } from '@/lib/crawler/robots';
import { extractCssUrls } from '@/lib/extractor/css';
import { extractJsonLdImages } from '@/lib/extractor/jsonld';
import { variantGroupKey } from '@/lib/deduplicator';

test('parseSrcset handles descriptors, whitespace and commas inside URLs', () => {
  const parsed = parseSrcset(
    '  /a-320.jpg 320w ,\n /a-640.jpg 640w, https://cdn.example.com/x,y/a@2x.png 2x , /plain.jpg ',
  );
  assert.deepEqual(
    parsed.map((candidate) => candidate.url),
    ['/a-320.jpg', '/a-640.jpg', 'https://cdn.example.com/x,y/a@2x.png', '/plain.jpg'],
  );
  assert.equal(parsed[0]?.width, 320);
  assert.equal(parsed[2]?.density, 2);
  assert.equal(parsed[3]?.descriptor, null);
});

test('parseSrcset copes with empty and malformed input', () => {
  assert.deepEqual(parseSrcset(''), []);
  assert.deepEqual(parseSrcset(null), []);
  assert.deepEqual(parseSrcset(undefined), []);
  assert.equal(parseSrcset(',,,').length, 0);
});

test('resolveUrl handles relative, dotted, protocol-relative and absolute forms', () => {
  const base = 'https://townplanmap.com/maps/ahmedabad/';
  assert.equal(resolveUrl('/images/photo.jpg', base)?.resolved, 'https://townplanmap.com/images/photo.jpg');
  assert.equal(resolveUrl('./photo.jpg', base)?.resolved, 'https://townplanmap.com/maps/ahmedabad/photo.jpg');
  assert.equal(resolveUrl('../assets/p.png', base)?.resolved, 'https://townplanmap.com/maps/assets/p.png');
  assert.equal(resolveUrl('//cdn.example.com/a.webp', base)?.resolved, 'https://cdn.example.com/a.webp');
  assert.equal(resolveUrl('https://cdn.example.com/a.webp', base)?.resolved, 'https://cdn.example.com/a.webp');
  // Non-fetchable schemes are refused rather than resolved.
  assert.equal(resolveUrl('data:image/png;base64,iVBOR', base), null);
  assert.equal(resolveUrl('javascript:void(0)', base), null);
  assert.equal(resolveUrl('#anchor', base), null);
});

test('resolveUrl preserves the original string separately', () => {
  const result = resolveUrl('  ../a.png ', 'https://x.test/b/c/');
  assert.equal(result?.original, '../a.png');
  assert.equal(result?.resolved, 'https://x.test/b/a.png');
});

test('canonicalUrl removes tracking and cache-buster params and orders the rest', () => {
  assert.equal(
    canonicalUrl('https://x.test/a.jpg?utm_source=news&b=2&a=1&fbclid=zz&v=99'),
    'https://x.test/a.jpg?a=1&b=2',
  );
  // Genuinely different resources are never collapsed.
  assert.notEqual(canonicalUrl('https://x.test/a.jpg?id=1'), canonicalUrl('https://x.test/a.jpg?id=2'));
  assert.equal(canonicalUrl('https://X.TEST:443/a.jpg#frag'), 'https://x.test/a.jpg');
});

test('canonicalPageUrl folds index files and trailing slashes', () => {
  assert.equal(canonicalPageUrl('https://x.test/a/index.html'), 'https://x.test/a');
  assert.equal(canonicalPageUrl('https://x.test/a/'), 'https://x.test/a');
  assert.equal(canonicalPageUrl('https://x.test/'), 'https://x.test/');
});

test('filename and extension extraction', () => {
  assert.equal(filenameFromUrl('https://x.test/a/b/map%20one.jpg?q=1'), 'map one.jpg');
  assert.equal(extensionFromUrl('https://x.test/a.JPEG'), 'jpeg');
  assert.equal(extensionFromUrl('https://x.test/a.php'), null);
  assert.equal(extensionFromUrl('https://x.test/noext'), null);
});

test('same-site and page detection', () => {
  assert.equal(isSameSite('https://townplanmap.com/a', 'https://townplanmap.com', false), true);
  assert.equal(isSameSite('https://cdn.townplanmap.com/a', 'https://townplanmap.com', false), false);
  assert.equal(isSameSite('https://cdn.townplanmap.com/a', 'https://townplanmap.com', true), true);
  assert.equal(isSameSite('https://evil.test/a', 'https://townplanmap.com', true), false);

  assert.equal(looksLikePage('https://x.test/about'), true);
  assert.equal(looksLikePage('https://x.test/a.pdf'), false);
  assert.equal(looksLikePage('https://x.test/a.jpg'), false);
  assert.equal(looksLikePage('https://x.test/a.html'), true);
});

test('pageLabel builds a readable trail', () => {
  assert.equal(pageLabel('https://www.townplanmap.com/maps/ahmedabad-tp'), 'townplanmap.com → maps → ahmedabad tp');
  assert.equal(pageLabel('https://townplanmap.com/'), 'townplanmap.com');
});

test('robots.txt group selection, wildcards and anchors', () => {
  const policy = RobotsPolicy.parse(
    [
      'User-agent: *',
      'Disallow: /private/',
      'Disallow: /*.json$',
      'Allow: /private/public-file.html',
      'Crawl-delay: 2',
      '',
      'User-agent: BadBot',
      'Disallow: /',
      '',
      'Sitemap: https://x.test/sitemap.xml',
    ].join('\n'),
    'https://x.test/robots.txt',
  );

  assert.equal(policy.isAllowed('/'), true);
  assert.equal(policy.isAllowed('/private/secret.html'), false);
  // The longer Allow rule wins over the shorter Disallow.
  assert.equal(policy.isAllowed('/private/public-file.html'), true);
  assert.equal(policy.isAllowed('/data/feed.json'), false);
  assert.equal(policy.isAllowed('/data/feed.json?x=1'), true, '$ anchors to the end of the path');
  assert.equal(policy.crawlDelayMs, 2000);
  assert.deepEqual(policy.sitemaps, ['https://x.test/sitemap.xml']);
});

test('an empty Disallow means everything is allowed', () => {
  const policy = RobotsPolicy.parse('User-agent: *\nDisallow:', 'https://x.test/robots.txt');
  assert.equal(policy.isAllowed('/anything'), true);
});

test('comments and blank robots.txt are handled', () => {
  const policy = RobotsPolicy.parse('# just a comment\n\n', 'https://x.test/robots.txt');
  assert.equal(policy.isAllowed('/anything'), true);
  assert.equal(policy.isUrlAllowed('https://x.test/a/b?c=d'), true);
});

test('CSS url() extraction covers quoting styles and skips data URIs', () => {
  const found = extractCssUrls(`
    .hero { background-image: url('/img/hero.jpg'); }
    .b { background: url("/img/b.png") no-repeat; }
    .c { background: url(/img/c.webp); }
    .d { background-image: url(data:image/gif;base64,R0lGOD); }
  `);
  assert.deepEqual(
    found.map((entry) => entry.url),
    ['/img/hero.jpg', '/img/b.png', '/img/c.webp'],
  );
  assert.match(found[0]?.context ?? '', /background-image/);
});

test('JSON-LD walker finds image fields and ImageObject urls', () => {
  const images = extractJsonLdImages(
    JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Article',
      image: ['https://x.test/a.jpg', 'https://x.test/b.jpg'],
      publisher: { '@type': 'Organization', logo: { '@type': 'ImageObject', url: 'https://x.test/logo.png' } },
    }),
  );
  const urls = images.map((entry) => entry.url);
  assert.ok(urls.includes('https://x.test/a.jpg'));
  assert.ok(urls.includes('https://x.test/b.jpg'));
  assert.ok(urls.includes('https://x.test/logo.png'));
});

test('malformed JSON-LD yields nothing rather than throwing', () => {
  assert.deepEqual(extractJsonLdImages('{ not json'), []);
});

test('variant grouping recognises responsive derivatives', () => {
  const full = variantGroupKey('https://x.test/wp/photo.jpg');
  const small = variantGroupKey('https://x.test/wp/photo-300x200.jpg');
  const retina = variantGroupKey('https://x.test/wp/photo@2x.jpg');
  const resized = variantGroupKey('https://x.test/wp/photo.jpg?w=300');

  assert.equal(full, null, 'a plain filename is not a derivative');
  assert.equal(small, retina);
  assert.equal(small, resized);
});
