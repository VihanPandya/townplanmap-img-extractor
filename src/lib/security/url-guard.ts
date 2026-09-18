/**
 * URL validation for user supplied targets.
 *
 * Two layers:
 *  1. `parseTargetUrl` - purely syntactic. Protocol allowlist, no credentials,
 *     no exotic ports, sane length.
 *  2. `assertPublicHost` - resolves DNS and refuses any answer that points at a
 *     loopback, private, link-local, CGNAT, multicast or reserved address. The
 *     resolved addresses are returned so the caller can pin the connection to
 *     them (see `security/http.ts`), which closes the DNS-rebinding window.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { classifyHostname, classifyIp } from './ip';

export class UrlSecurityError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'UrlSecurityError';
    this.code = code;
  }
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const MAX_URL_LENGTH = 2048;

/**
 * Ports that are either well known non-HTTP services or classic SSRF pivots.
 * Everything else is allowed so that sites on :8080 etc. still work.
 */
const BLOCKED_PORTS = new Set([
  22, 23, 25, 53, 110, 135, 137, 138, 139, 143, 445, 465, 587, 593, 636, 993, 995, 1433, 1521, 2049,
  2375, 2376, 3306, 3389, 5432, 5672, 5900, 5984, 6379, 9200, 9300, 11211, 27017,
]);

/**
 * Set `SCANNER_ALLOW_PRIVATE_HOSTS=1` only for local development against a
 * fixture server. It disables the private-address guard and must never be set
 * in a deployment that accepts untrusted input.
 */
export function privateHostsAllowed(): boolean {
  return process.env.SCANNER_ALLOW_PRIVATE_HOSTS === '1';
}

/** Add a protocol when the user typed a bare host, then validate syntactically. */
export function parseTargetUrl(input: string): URL {
  const raw = (input ?? '').trim();
  if (!raw) {
    throw new UrlSecurityError('invalid-url', 'Enter a website address to scan.');
  }
  if (raw.length > MAX_URL_LENGTH) {
    throw new UrlSecurityError('invalid-url', 'That address is too long to be a valid URL.');
  }

  const withProtocol = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) ? raw : `https://${raw}`;

  let url: URL;
  try {
    url = new URL(withProtocol);
  } catch {
    throw new UrlSecurityError('invalid-url', `"${raw}" is not a valid web address.`);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new UrlSecurityError(
      'blocked-protocol',
      `Only http:// and https:// addresses can be scanned (got "${url.protocol}").`,
    );
  }
  if (url.username || url.password) {
    throw new UrlSecurityError(
      'blocked-credentials',
      'Addresses containing credentials are not accepted.',
    );
  }
  if (!url.hostname) {
    throw new UrlSecurityError('invalid-url', 'That address has no hostname.');
  }
  if (url.port) {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new UrlSecurityError('invalid-url', `Port "${url.port}" is not valid.`);
    }
    if (BLOCKED_PORTS.has(port)) {
      throw new UrlSecurityError(
        'blocked-port',
        `Port ${port} is not an allowed web port for scanning.`,
      );
    }
  }

  url.hash = '';
  return url;
}

export interface ResolvedHost {
  hostname: string;
  addresses: Array<{ address: string; family: 4 | 6 }>;
}

const resolveCache = new Map<string, { at: number; value: ResolvedHost }>();
const RESOLVE_TTL_MS = 60_000;

/**
 * Resolve a hostname and refuse anything that is not globally routable.
 * Returns every resolved address so callers can pin their connection.
 */
export async function assertPublicHost(hostname: string): Promise<ResolvedHost> {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();

  if (privateHostsAllowed()) {
    return { hostname: host, addresses: [] };
  }

  const cached = resolveCache.get(host);
  if (cached && Date.now() - cached.at < RESOLVE_TTL_MS) return cached.value;

  const hostVerdict = classifyHostname(host);
  if (hostVerdict.blocked) {
    throw new UrlSecurityError(
      'blocked-host',
      `"${hostname}" cannot be scanned: ${hostVerdict.reason}.`,
    );
  }

  // A literal IP needs no DNS, but still needs classifying.
  const literalFamily = detectIpLiteral(host);
  if (literalFamily) {
    const verdict = classifyIp(host, literalFamily);
    if (verdict.blocked) {
      throw new UrlSecurityError(
        'blocked-address',
        `"${hostname}" resolves to a ${verdict.reason}, which the scanner will not request.`,
      );
    }
    const value: ResolvedHost = { hostname: host, addresses: [{ address: host, family: literalFamily }] };
    resolveCache.set(host, { at: Date.now(), value });
    return value;
  }

  let records: Array<{ address: string; family: number }>;
  try {
    records = await dnsLookup(host, { all: true, verbatim: true });
  } catch {
    throw new UrlSecurityError('dns-failure', `The address "${hostname}" could not be resolved.`);
  }

  if (records.length === 0) {
    throw new UrlSecurityError('dns-failure', `The address "${hostname}" did not resolve to any host.`);
  }

  const addresses: ResolvedHost['addresses'] = [];
  for (const record of records) {
    const family = record.family === 6 ? 6 : 4;
    const verdict = classifyIp(record.address, family);
    if (verdict.blocked) {
      throw new UrlSecurityError(
        'blocked-address',
        `"${hostname}" resolves to ${record.address} (${verdict.reason}), which the scanner will not request.`,
      );
    }
    addresses.push({ address: record.address, family });
  }

  const value: ResolvedHost = { hostname: host, addresses };
  resolveCache.set(host, { at: Date.now(), value });
  return value;
}

function detectIpLiteral(host: string): 4 | 6 | null {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return 4;
  if (host.includes(':')) return 6;
  return null;
}

/** Full check used before every outbound request. */
export async function validateTarget(input: string | URL): Promise<{ url: URL; host: ResolvedHost }> {
  const url = input instanceof URL ? input : parseTargetUrl(input);
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new UrlSecurityError(
      'blocked-protocol',
      `Only http:// and https:// addresses can be requested (got "${url.protocol}").`,
    );
  }
  const host = await assertPublicHost(url.hostname);
  return { url, host };
}
