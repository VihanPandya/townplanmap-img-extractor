/**
 * A small, dependency-free robots.txt implementation.
 *
 * Group selection follows the usual rules: the most specific matching
 * User-agent group wins, falling back to `*`. Path matching supports `*`
 * wildcards and `$` anchors, and the longest matching rule decides, with
 * Allow winning ties (as specified by Google's robots.txt draft).
 */

import { HttpFetchError, safeFetch, USER_AGENT } from '@/lib/security/http';
import type { RobotsInfo } from '@/lib/types';

const AGENT_TOKEN = 'townplanmapimageexplorer';

interface RobotsRule {
  allow: boolean;
  pattern: string;
  /** Specificity, used to break ties between competing rules. */
  length: number;
}

export class RobotsPolicy {
  private readonly rules: RobotsRule[];
  readonly crawlDelayMs: number | null;
  readonly sitemaps: string[];
  readonly info: RobotsInfo;

  private constructor(rules: RobotsRule[], crawlDelayMs: number | null, sitemaps: string[], info: RobotsInfo) {
    this.rules = rules;
    this.crawlDelayMs = crawlDelayMs;
    this.sitemaps = sitemaps;
    this.info = info;
  }

  /** A permissive policy, used when robots.txt is absent or unreadable. */
  static permissive(url: string, note: string, found: boolean, checked = true): RobotsPolicy {
    return new RobotsPolicy([], null, [], {
      checked,
      found,
      url,
      crawlDelayMs: null,
      disallowedPaths: 0,
      sitemaps: [],
      policy: checked ? 'respecting' : 'ignored-by-setting',
      note,
    });
  }

  static parse(text: string, url: string): RobotsPolicy {
    const groups = new Map<string, { rules: RobotsRule[]; crawlDelay: number | null }>();
    const sitemaps: string[] = [];
    let currentAgents: string[] = [];
    let expectingAgents = false;

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.split('#')[0]!.trim();
      if (!line) continue;
      const separator = line.indexOf(':');
      if (separator === -1) continue;
      const field = line.slice(0, separator).trim().toLowerCase();
      const value = line.slice(separator + 1).trim();

      if (field === 'user-agent') {
        if (!expectingAgents) {
          currentAgents = [];
          expectingAgents = true;
        }
        const agent = value.toLowerCase();
        currentAgents.push(agent);
        if (!groups.has(agent)) groups.set(agent, { rules: [], crawlDelay: null });
        continue;
      }

      expectingAgents = false;
      if (currentAgents.length === 0) {
        if (field === 'sitemap' && value) sitemaps.push(value);
        continue;
      }

      if (field === 'allow' || field === 'disallow') {
        for (const agent of currentAgents) {
          const group = groups.get(agent)!;
          // "Disallow:" with an empty value means "allow everything".
          if (field === 'disallow' && value === '') continue;
          group.rules.push({ allow: field === 'allow', pattern: value, length: value.length });
        }
      } else if (field === 'crawl-delay') {
        const seconds = Number(value.replace(',', '.'));
        if (Number.isFinite(seconds) && seconds >= 0) {
          for (const agent of currentAgents) groups.get(agent)!.crawlDelay = seconds * 1000;
        }
      } else if (field === 'sitemap' && value) {
        sitemaps.push(value);
      }
    }

    const selected = selectGroup(groups);
    const rules = selected?.rules ?? [];
    const crawlDelayMs = selected?.crawlDelay ?? null;

    return new RobotsPolicy(rules, crawlDelayMs, sitemaps, {
      checked: true,
      found: true,
      url,
      crawlDelayMs,
      disallowedPaths: rules.filter((rule) => !rule.allow).length,
      sitemaps,
      policy: 'respecting',
      note: null,
    });
  }

  /** True when our crawler is permitted to request this path. */
  isAllowed(pathWithQuery: string): boolean {
    let best: RobotsRule | null = null;
    for (const rule of this.rules) {
      if (!matchesPattern(pathWithQuery, rule.pattern)) continue;
      if (
        best === null ||
        rule.length > best.length ||
        (rule.length === best.length && rule.allow && !best.allow)
      ) {
        best = rule;
      }
    }
    return best ? best.allow : true;
  }

  isUrlAllowed(url: string): boolean {
    try {
      const parsed = new URL(url);
      return this.isAllowed(`${parsed.pathname}${parsed.search}`);
    } catch {
      return false;
    }
  }
}

function selectGroup(
  groups: Map<string, { rules: RobotsRule[]; crawlDelay: number | null }>,
): { rules: RobotsRule[]; crawlDelay: number | null } | null {
  let best: { agent: string; group: { rules: RobotsRule[]; crawlDelay: number | null } } | null = null;
  for (const [agent, group] of groups) {
    if (agent === '*') continue;
    if (!AGENT_TOKEN.includes(agent) && !USER_AGENT.toLowerCase().includes(agent)) continue;
    if (!best || agent.length > best.agent.length) best = { agent, group };
  }
  if (best) return best.group;
  return groups.get('*') ?? null;
}

/** robots.txt path matching: `*` matches any run of characters, `$` anchors the end. */
function matchesPattern(path: string, pattern: string): boolean {
  if (pattern === '') return false;
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const segments = body.split('*');

  let index = 0;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;
    if (segment === '') continue;
    if (i === 0) {
      if (!path.startsWith(segment)) return false;
      index = segment.length;
      continue;
    }
    const found = path.indexOf(segment, index);
    if (found === -1) return false;
    index = found + segment.length;
  }

  if (anchored) {
    const tail = segments[segments.length - 1]!;
    return tail === '' ? true : path.endsWith(tail) && path.length >= index;
  }
  return true;
}

export interface RobotsFetchResult {
  policy: RobotsPolicy;
  info: RobotsInfo;
}

/** Fetch and parse robots.txt for an origin. Never throws. */
export async function fetchRobots(origin: string, respect: boolean): Promise<RobotsFetchResult> {
  const robotsUrl = new URL('/robots.txt', origin).toString();

  if (!respect) {
    const policy = RobotsPolicy.permissive(robotsUrl, 'Robots rules were not applied because the setting is off.', false, false);
    return { policy, info: { ...policy.info, policy: 'ignored-by-setting' } };
  }

  try {
    const response = await safeFetch(robotsUrl, {
      accept: 'text/plain,*/*;q=0.5',
      limits: { maxBytes: 512 * 1024, timeoutMs: 10_000, maxRedirects: 3 },
    });

    if (response.status === 404 || response.status === 410) {
      const policy = RobotsPolicy.permissive(robotsUrl, 'No robots.txt was published, so no crawl rules apply.', false);
      return { policy, info: policy.info };
    }
    if (response.status >= 400) {
      // A 4xx/5xx robots.txt is treated as "no rules", matching common practice,
      // but the crawl stays conservative through its own limits.
      const policy = RobotsPolicy.permissive(
        robotsUrl,
        `robots.txt returned HTTP ${response.status}; the scanner continued with its own conservative limits.`,
        false,
      );
      return { policy, info: policy.info };
    }

    const policy = RobotsPolicy.parse(response.body.toString('utf8'), robotsUrl);
    return { policy, info: policy.info };
  } catch (error) {
    const reason = error instanceof HttpFetchError ? error.message : 'robots.txt could not be retrieved.';
    const policy = RobotsPolicy.permissive(robotsUrl, reason, false);
    return { policy, info: { ...policy.info, policy: 'unavailable' } };
  }
}
