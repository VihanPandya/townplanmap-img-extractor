/**
 * IP address classification used by the SSRF guard.
 *
 * Anything that is not a globally routable unicast address is refused, so the
 * default answer for an address we do not recognise is "block".
 */

export interface IpVerdict {
  blocked: boolean;
  /** Short reason suitable for showing to the user. */
  reason: string | null;
}

const ALLOWED = { blocked: false, reason: null } as const;

function block(reason: string): IpVerdict {
  return { blocked: true, reason };
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

function inCidr(ipInt: number, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split('/');
  const baseInt = ipv4ToInt(base ?? '');
  const bits = Number(bitsRaw);
  if (baseInt === null || !Number.isFinite(bits)) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

/** Non-routable / special-use IPv4 blocks (RFC 1918, 5735, 6598, 3927, ...). */
const IPV4_BLOCKS: Array<[cidr: string, reason: string]> = [
  ['0.0.0.0/8', 'unspecified address block'],
  ['10.0.0.0/8', 'private network (RFC 1918)'],
  ['100.64.0.0/10', 'carrier-grade NAT (RFC 6598)'],
  ['127.0.0.0/8', 'loopback address'],
  ['169.254.0.0/16', 'link-local / cloud metadata address'],
  ['172.16.0.0/12', 'private network (RFC 1918)'],
  ['192.0.0.0/24', 'IETF protocol assignments'],
  ['192.0.2.0/24', 'documentation range'],
  ['192.88.99.0/24', 'deprecated 6to4 relay anycast'],
  ['192.168.0.0/16', 'private network (RFC 1918)'],
  ['198.18.0.0/15', 'benchmarking range'],
  ['198.51.100.0/24', 'documentation range'],
  ['203.0.113.0/24', 'documentation range'],
  ['224.0.0.0/4', 'multicast range'],
  ['240.0.0.0/4', 'reserved range'],
];

export function classifyIpv4(ip: string): IpVerdict {
  const value = ipv4ToInt(ip);
  if (value === null) return block('not a valid IPv4 address');
  if (value === 0xffffffff) return block('broadcast address');
  for (const [cidr, reason] of IPV4_BLOCKS) {
    if (inCidr(value, cidr)) return block(reason);
  }
  return ALLOWED;
}

/** Expand an IPv6 address to its 8 groups of 16 bits. */
function expandIpv6(ip: string): number[] | null {
  let address = ip.trim();
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
  const zone = address.indexOf('%');
  if (zone !== -1) address = address.slice(0, zone);

  // IPv4-mapped / IPv4-compatible tails such as ::ffff:127.0.0.1
  let tail: number[] = [];
  const lastColon = address.lastIndexOf(':');
  const maybeV4 = address.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    const v4 = ipv4ToInt(maybeV4);
    if (v4 === null) return null;
    tail = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
    address = address.slice(0, lastColon + 1) + '0:0';
  }

  const halves = address.split('::');
  if (halves.length > 2) return null;

  const parse = (chunk: string): number[] | null => {
    if (!chunk) return [];
    const out: number[] = [];
    for (const group of chunk.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };

  if (halves.length === 1) {
    const groups = parse(halves[0] ?? '');
    if (!groups || groups.length !== 8) return null;
    return tail.length ? [...groups.slice(0, 6), ...tail] : groups;
  }

  const head = parse(halves[0] ?? '');
  const rest = parse(halves[1] ?? '');
  if (!head || !rest) return null;
  const fill = 8 - head.length - rest.length;
  if (fill < 0) return null;
  const groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  return tail.length ? [...groups.slice(0, 6), ...tail] : groups;
}

export function classifyIpv6(ip: string): IpVerdict {
  const groups = expandIpv6(ip);
  if (!groups) return block('not a valid IPv6 address');

  const isZero = groups.every((g) => g === 0);
  if (isZero) return block('unspecified address');
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) {
    return block('loopback address');
  }

  const first = groups[0] ?? 0;
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-translated - defer to IPv4 rules.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const a = groups[6] ?? 0;
    const b = groups[7] ?? 0;
    const v4 = `${(a >> 8) & 0xff}.${a & 0xff}.${(b >> 8) & 0xff}.${b & 0xff}`;
    const verdict = classifyIpv4(v4);
    return verdict.blocked ? block(`IPv4-mapped ${verdict.reason}`) : ALLOWED;
  }
  // NAT64 well-known prefix 64:ff9b::/96 wraps an IPv4 destination.
  if (first === 0x0064 && groups[1] === 0xff9b) {
    const a = groups[6] ?? 0;
    const b = groups[7] ?? 0;
    const v4 = `${(a >> 8) & 0xff}.${a & 0xff}.${(b >> 8) & 0xff}.${b & 0xff}`;
    const verdict = classifyIpv4(v4);
    return verdict.blocked ? block(`NAT64-embedded ${verdict.reason}`) : ALLOWED;
  }

  if ((first & 0xfe00) === 0xfc00) return block('unique local address (fc00::/7)');
  if ((first & 0xffc0) === 0xfe80) return block('link-local address (fe80::/10)');
  if ((first & 0xff00) === 0xff00) return block('multicast address');
  if (first === 0x2001 && ((groups[1] ?? 0) & 0xff00) === 0x0000) {
    return block('IETF special-purpose range (2001::/23)');
  }
  if (first === 0x2002) return block('deprecated 6to4 range');
  if (first === 0x0100 && (groups[1] ?? 0) === 0) return block('discard-only range');

  return ALLOWED;
}

export function classifyIp(ip: string, family: 4 | 6): IpVerdict {
  return family === 4 ? classifyIpv4(ip) : classifyIpv6(ip);
}

/** Hostnames that should never be resolved at all. */
const BLOCKED_HOSTNAME_PATTERNS: Array<[RegExp, string]> = [
  [/^localhost$/i, 'localhost is not a public host'],
  [/\.localhost$/i, 'localhost is not a public host'],
  [/^ip6-\w+$/i, 'loopback alias'],
  [/\.local$/i, 'mDNS / local network name'],
  [/\.internal$/i, 'internal network name'],
  [/\.intranet$/i, 'internal network name'],
  [/\.lan$/i, 'local network name'],
  [/\.home$/i, 'local network name'],
  [/\.corp$/i, 'internal network name'],
  [/\.private$/i, 'internal network name'],
  [/^metadata(\.google\.internal)?$/i, 'cloud metadata endpoint'],
  [/^instance-data(\..*)?$/i, 'cloud metadata endpoint'],
];

export function classifyHostname(hostname: string): IpVerdict {
  const host = hostname.replace(/\.$/, '');
  if (!host) return block('empty hostname');
  for (const [pattern, reason] of BLOCKED_HOSTNAME_PATTERNS) {
    if (pattern.test(host)) return block(reason);
  }
  return ALLOWED;
}
