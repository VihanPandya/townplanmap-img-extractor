/**
 * Minimal sitemap reader used to seed the crawl frontier.
 *
 * Sitemaps are parsed as text with a bounded regex rather than a full XML
 * parser: we only need <loc> values, and the input is untrusted.
 */

import { safeFetch } from '@/lib/security/http';
import { canonicalPageUrl, looksLikePage } from '@/lib/normalizer/url';

const LOC_PATTERN = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
const MAX_URLS = 300;
const MAX_INDEX_FOLLOW = 3;

export interface SitemapResult {
  urls: string[];
  fetched: string[];
  error: string | null;
}

export async function collectSitemapUrls(sitemapUrls: string[], signal?: AbortSignal): Promise<SitemapResult> {
  const urls: string[] = [];
  const seen = new Set<string>();
  const fetched: string[] = [];
  const queue = [...sitemapUrls].slice(0, MAX_INDEX_FOLLOW + 1);
  let error: string | null = null;
  let indexFollows = 0;

  while (queue.length > 0 && urls.length < MAX_URLS) {
    if (signal?.aborted) break;
    const next = queue.shift()!;
    if (fetched.includes(next)) continue;

    try {
      const response = await safeFetch(next, {
        accept: 'application/xml,text/xml,*/*;q=0.5',
        limits: { maxBytes: 2 * 1024 * 1024, timeoutMs: 12_000, maxRedirects: 3 },
        signal,
      });
      fetched.push(next);
      if (response.status >= 400) continue;

      const text = response.body.toString('utf8');
      const isIndex = /<sitemapindex/i.test(text);
      LOC_PATTERN.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = LOC_PATTERN.exec(text)) !== null) {
        const raw = decodeXmlEntities(match[1]!.trim());
        if (isIndex) {
          if (indexFollows < MAX_INDEX_FOLLOW && !queue.includes(raw)) {
            queue.push(raw);
            indexFollows += 1;
          }
          continue;
        }
        if (!looksLikePage(raw)) continue;
        const canonical = canonicalPageUrl(raw);
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        urls.push(raw);
        if (urls.length >= MAX_URLS) break;
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'The sitemap could not be read.';
    }
  }

  return { urls, fetched, error };
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
