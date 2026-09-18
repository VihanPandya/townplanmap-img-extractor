/**
 * The only outbound HTTP client in the application.
 *
 * Everything the crawler touches goes through `safeFetch`, which enforces:
 *  - http/https only, on every redirect hop
 *  - DNS resolution pinned and re-validated at connect time (anti-rebinding)
 *  - connect / headers / body timeouts
 *  - a bounded redirect chain
 *  - a hard cap on the number of decompressed bytes read, so a compressed
 *    response cannot expand into unbounded memory
 *  - no JavaScript is ever executed; responses are treated as inert bytes
 */

import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { createBrotliDecompress, createUnzip } from 'node:zlib';
import { Agent, ProxyAgent, request, type Dispatcher } from 'undici';
import { classifyIp } from './ip';
import { parseTargetUrl, privateHostsAllowed, UrlSecurityError } from './url-guard';

export const USER_AGENT =
  'TownPlanMapImageExplorer/1.0 (+website image discovery; respects robots.txt)';

export interface FetchLimits {
  /** Whole-request budget in ms. */
  timeoutMs: number;
  /** Maximum decompressed bytes to read before aborting. */
  maxBytes: number;
  /** Maximum redirect hops to follow. */
  maxRedirects: number;
}

export const DEFAULT_PAGE_LIMITS: FetchLimits = {
  timeoutMs: 15_000,
  maxBytes: 3 * 1024 * 1024,
  maxRedirects: 5,
};

export const DEFAULT_ASSET_LIMITS: FetchLimits = {
  timeoutMs: 15_000,
  maxBytes: 8 * 1024 * 1024,
  maxRedirects: 4,
};

export class HttpFetchError extends Error {
  readonly code: string;
  readonly httpStatus: number | null;

  constructor(code: string, message: string, httpStatus: number | null = null) {
    super(message);
    this.name = 'HttpFetchError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/**
 * DNS lookup that re-checks the address at connection time. Because undici
 * connects to exactly the address this returns, a name that resolved to a
 * public address a moment ago cannot be swapped for a private one.
 */
function guardedLookup(
  hostname: string,
  options: Parameters<typeof dnsLookup>[1],
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
): void {
  const opts = (typeof options === 'object' && options !== null ? options : {}) as {
    all?: boolean;
    family?: number;
  };
  dnsLookup(hostname, { ...opts, all: true, verbatim: true }, (err, addresses) => {
    if (err) {
      callback(err, []);
      return;
    }
    const list = (Array.isArray(addresses) ? addresses : [addresses]) as LookupAddress[];
    const safe: LookupAddress[] = [];
    for (const entry of list) {
      const family = entry.family === 6 ? 6 : 4;
      const verdict = classifyIp(entry.address, family);
      if (!verdict.blocked) safe.push({ address: entry.address, family });
    }
    if (safe.length === 0) {
      const blocked: NodeJS.ErrnoException = new Error(
        `Refusing to connect to ${hostname}: it resolves only to non-public addresses.`,
      );
      blocked.code = 'EBLOCKEDADDRESS';
      callback(blocked, []);
      return;
    }
    if (opts.all) {
      callback(null, safe);
    } else {
      const first = safe[0]!;
      callback(null, first.address, first.family);
    }
  });
}

let dispatcher: Dispatcher | null = null;

/**
 * A forward proxy can be supplied for environments with no direct egress.
 * Note: when a proxy is used the proxy performs DNS, so the connect-time
 * address pinning above does not apply; the pre-flight check in
 * `validateTarget` is then the only address-level defence.
 */
function proxyUrl(): string | null {
  return (
    process.env.SCANNER_PROXY_URL ||
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    null
  );
}

export function getDispatcher(): Dispatcher {
  if (dispatcher) return dispatcher;
  const proxy = proxyUrl();
  const shared = {
    connect: {
      timeout: 10_000,
      ...(proxy ? {} : { lookup: guardedLookup }),
    },
    headersTimeout: 15_000,
    bodyTimeout: 20_000,
    connections: 24,
    pipelining: 1,
    maxResponseSize: 32 * 1024 * 1024,
  } as const;

  dispatcher = proxy
    ? new ProxyAgent({ uri: proxy, ...shared })
    : new Agent(shared);
  return dispatcher;
}

export interface SafeResponse {
  url: string;
  requestedUrl: string;
  status: number;
  headers: Record<string, string>;
  contentType: string | null;
  /** Decompressed bytes actually read (never more than `limits.maxBytes`). */
  body: Buffer;
  /** True when the body was cut short because it hit the byte cap. */
  truncated: boolean;
  redirected: boolean;
  redirectChain: string[];
  /** Value of the content-length header, when the server sent one. */
  declaredLength: number | null;
}

export interface SafeFetchOptions {
  method?: 'GET' | 'HEAD';
  limits?: Partial<FetchLimits>;
  accept?: string;
  referer?: string;
  /**
   * Called with each chunk as it arrives. Return `false` to stop reading early
   * (used by the image prober once it has parsed the header bytes).
   */
  onChunk?: (chunk: Buffer, total: number) => boolean | void;
  signal?: AbortSignal;
}

function headerValue(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

/**
 * Perform a request with every guard applied. Redirects are followed manually
 * so each hop is re-validated against the protocol and address rules.
 */
export async function safeFetch(target: string | URL, options: SafeFetchOptions = {}): Promise<SafeResponse> {
  const limits: FetchLimits = {
    ...DEFAULT_PAGE_LIMITS,
    ...options.limits,
  };
  const method = options.method ?? 'GET';
  const requestedUrl = target instanceof URL ? target.toString() : target;

  const deadline = Date.now() + limits.timeoutMs;
  const redirectChain: string[] = [];

  let current = target instanceof URL ? new URL(target.toString()) : parseTargetUrl(target);
  await assertRequestable(current);

  for (let hop = 0; hop <= limits.maxRedirects; hop += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new HttpFetchError('timeout', 'The request took too long and was stopped.');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    const onExternalAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onExternalAbort, { once: true });

    let response: Dispatcher.ResponseData;
    try {
      response = await request(current, {
        method,
        dispatcher: getDispatcher(),
        // Redirects are followed by hand below so every hop is re-validated.
        signal: controller.signal,
        headers: {
          'user-agent': USER_AGENT,
          accept: options.accept ?? 'text/html,application/xhtml+xml,*/*;q=0.8',
          'accept-language': 'en',
          'accept-encoding': 'gzip, deflate, br',
          ...(options.referer ? { referer: options.referer } : {}),
        },
      });
    } catch (error) {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onExternalAbort);
      throw toFetchError(error, current);
    }

    const status = response.statusCode;
    const location = headerValue(response.headers.location as string | string[] | undefined);

    absorbErrors(response.body as unknown as DestroyableStream);

    if (status >= 300 && status < 400 && location) {
      // Drain and discard the redirect body before moving on.
      response.body.destroy();
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onExternalAbort);

      if (hop === limits.maxRedirects) {
        throw new HttpFetchError(
          'too-many-redirects',
          `This address redirected more than ${limits.maxRedirects} times, so the scanner stopped following it.`,
          status,
        );
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new HttpFetchError('bad-redirect', 'The server sent a redirect the scanner could not read.', status);
      }
      next.hash = '';
      await assertRequestable(next);
      redirectChain.push(next.toString());
      current = next;
      continue;
    }

    try {
      const encoding = headerValue(response.headers['content-encoding'] as string | string[] | undefined);
      const { body, truncated } = await readLimited(
        decompress(response.body, encoding, limits.maxBytes),
        limits.maxBytes,
        options.onChunk,
        response.body,
      );
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(response.headers)) {
        const flat = headerValue(value as string | string[] | undefined);
        if (flat !== null) headers[key.toLowerCase()] = flat;
      }
      const declaredRaw = headers['content-length'];
      const declaredLength = declaredRaw !== undefined && /^\d+$/.test(declaredRaw) ? Number(declaredRaw) : null;

      return {
        url: current.toString(),
        requestedUrl,
        status,
        headers,
        contentType: headers['content-type'] ?? null,
        body,
        truncated,
        redirected: redirectChain.length > 0,
        redirectChain,
        declaredLength,
      };
    } catch (error) {
      throw toFetchError(error, current);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  throw new HttpFetchError('too-many-redirects', 'This address redirected too many times.');
}

async function assertRequestable(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlSecurityError(
      'blocked-protocol',
      `The scanner only follows http:// and https:// links (got "${url.protocol}").`,
    );
  }
  if (url.username || url.password) {
    throw new UrlSecurityError('blocked-credentials', 'Addresses containing credentials are not followed.');
  }
  if (privateHostsAllowed()) return;
  const { assertPublicHost } = await import('./url-guard');
  await assertPublicHost(url.hostname);
}

type DestroyableStream = NodeJS.ReadableStream & { destroy: (error?: Error) => void };

/**
 * Destroying an undici body mid-stream makes it emit an abort error. That is
 * expected here - the prober stops reading as soon as it has the header bytes -
 * so a listener is attached to keep it from becoming an unhandled 'error'.
 * The async iterator still surfaces genuine read failures to the caller.
 */
function absorbErrors<T extends DestroyableStream>(stream: T): T {
  (stream as NodeJS.EventEmitter).on('error', () => undefined);
  return stream;
}

/**
 * Wrap a response body in a decompressor when the server compressed it.
 *
 * `undici.request` hands back the raw bytes, so this is where `content-encoding`
 * is undone. `maxOutputLength` caps the *decompressed* size inside zlib itself,
 * which is the first line of defence against a decompression bomb; the byte
 * counting in `readLimited` is the second.
 */
function decompress(body: DestroyableStream, encoding: string | null, maxBytes: number): DestroyableStream {
  const codings = (encoding ?? '')
    .toLowerCase()
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const applied = codings[codings.length - 1];
  if (!applied || applied === 'identity') return body;

  const options = { maxOutputLength: maxBytes };
  const transform =
    applied === 'br'
      ? createBrotliDecompress(options)
      : applied === 'gzip' || applied === 'x-gzip' || applied === 'deflate' || applied === 'x-deflate'
        ? createUnzip(options)
        : null;
  if (!transform) return body;

  absorbErrors(transform as unknown as DestroyableStream);
  body.pipe(transform);
  return transform as unknown as DestroyableStream;
}

/** True for the errors that mean "the cap was reached", not "the data is bad". */
function isSizeLimitError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ERR_BUFFER_TOO_LARGE' || code === 'ERR_STREAM_PREMATURE_CLOSE';
}

/**
 * Read a response body, counting decompressed bytes and stopping at the cap.
 * This is what keeps an oversized or bomb-like response from exhausting memory.
 */
async function readLimited(
  stream: DestroyableStream,
  maxBytes: number,
  onChunk?: SafeFetchOptions['onChunk'],
  source?: DestroyableStream,
): Promise<{ body: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;

  try {
    for await (const piece of stream as AsyncIterable<Buffer | string>) {
      const chunk = typeof piece === 'string' ? Buffer.from(piece, 'utf8') : Buffer.from(piece);
      const room = maxBytes - total;
      if (room <= 0) {
        truncated = true;
        break;
      }
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
      chunks.push(slice);
      total += slice.length;
      if (slice.length < chunk.length) truncated = true;

      if (onChunk) {
        const keepGoing = onChunk(slice, total);
        if (keepGoing === false) {
          truncated = true;
          break;
        }
      }
      if (total >= maxBytes) {
        truncated = true;
        break;
      }
    }
  } catch (error) {
    // Hitting the decompression cap is an expected outcome, not a failure:
    // keep whatever was read and report it as truncated.
    if (!isSizeLimitError(error) || chunks.length === 0) throw error;
    truncated = true;
  } finally {
    stream.destroy();
    source?.destroy();
  }

  return { body: Buffer.concat(chunks), truncated };
}

function toFetchError(error: unknown, url: URL): Error {
  if (error instanceof UrlSecurityError || error instanceof HttpFetchError) return error;
  const err = error as NodeJS.ErrnoException & { name?: string };
  const code = err?.code ?? '';
  if (err?.name === 'AbortError' || code === 'UND_ERR_ABORTED' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
    return new HttpFetchError('timeout', `${url.host} did not respond in time.`);
  }
  if (code === 'EBLOCKEDADDRESS') {
    return new UrlSecurityError('blocked-address', err.message);
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new HttpFetchError('dns', `The address "${url.host}" could not be resolved.`);
  }
  if (code === 'ECONNREFUSED') {
    return new HttpFetchError('refused', `${url.host} refused the connection.`);
  }
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') {
    return new HttpFetchError('reset', `The connection to ${url.host} was closed unexpectedly.`);
  }
  if (code === 'CERT_HAS_EXPIRED' || code?.startsWith('ERR_TLS') || code === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
    return new HttpFetchError('tls', `${url.host} presented a certificate the scanner could not verify.`);
  }
  if (code === 'UND_ERR_RESPONSE_SIZE_EXCEEDED') {
    return new HttpFetchError('too-large', 'The response was larger than the scanner will download.');
  }
  return new HttpFetchError('network', err?.message || `The request to ${url.host} failed.`);
}
