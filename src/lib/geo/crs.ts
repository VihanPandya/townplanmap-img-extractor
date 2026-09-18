/**
 * Coordinate reference system handling.
 *
 * Section 48 of the brief is explicit: transform correctly, and do not silently
 * assume WGS84. So this module does three things and nothing else:
 *
 *  1. recognises the CRS a source declares,
 *  2. transforms the systems it can transform exactly (Web Mercator, UTM),
 *  3. *refuses* everything else, returning a reason instead of a number.
 *
 * A refusal is a feature. Passing projected metres through as if they were
 * degrees would place a parcel in the Gulf of Guinea while looking plausible in
 * a JSON file, so an unsupported CRS marks the geometry unusable rather than
 * producing coordinates nobody can trust.
 */

import type { Position } from './types';

export const WGS84 = 'EPSG:4326';

export interface CrsSupport {
  /** Normalised identifier, e.g. "EPSG:32643". */
  code: string;
  supported: boolean;
  /** True when the code already is WGS84 lon/lat. */
  isWgs84: boolean;
  /** Human readable name for the UI. */
  label: string;
  /** Why it cannot be used, when `supported` is false. */
  reason: string | null;
}

/**
 * Codes that are the same system under a different number. ESRI wrote Web
 * Mercator as 102100 and Google as 900913 long before 3857 was assigned.
 */
function applyAliases(code: string): string {
  if (code === 'EPSG:900913' || code === 'EPSG:102100' || code === 'EPSG:3785') return 'EPSG:3857';
  if (code === 'EPSG:4979' || code === 'EPSG:4327') return WGS84;
  return code;
}

/**
 * Normalise the many spellings a CRS appears as: "EPSG:4326",
 * "urn:ogc:def:crs:EPSG::4326", "urn:ogc:def:crs:OGC:1.3:CRS84", "WGS84".
 */
export function normaliseCrs(raw: string | null | undefined): string {
  const value = (raw ?? '').trim();
  if (!value) return WGS84;

  const urn = /urn:ogc:def:crs:([A-Za-z0-9]+):[^:]*:?([0-9A-Za-z]+)$/i.exec(value);
  if (urn) {
    const authority = urn[1]!.toUpperCase();
    const code = urn[2]!.toUpperCase();
    if (authority === 'OGC' && (code === 'CRS84' || code === '84')) return WGS84;
    return applyAliases(`${authority}:${code}`);
  }

  const epsg = /^(?:EPSG[:\s]*)?(\d{4,6})$/i.exec(value);
  if (epsg) return applyAliases(`EPSG:${epsg[1]}`);

  const upper = value.toUpperCase().replace(/\s+/g, '');
  if (upper === 'WGS84' || upper === 'CRS84' || upper === 'WGS1984' || upper === 'OGC:CRS84') return WGS84;

  return applyAliases(upper);
}

/** UTM zone from an EPSG code, or null when it is not a UTM code. */
function utmZoneOf(code: string): { zone: number; north: boolean } | null {
  const match = /^EPSG:(\d{5})$/.exec(code);
  if (!match) return null;
  const numeric = Number(match[1]);
  // WGS84 / UTM northern zones are 32601-32660, southern 32701-32760.
  if (numeric >= 32601 && numeric <= 32660) return { zone: numeric - 32600, north: true };
  if (numeric >= 32701 && numeric <= 32760) return { zone: numeric - 32700, north: false };
  return null;
}

export function describeCrs(raw: string | null | undefined): CrsSupport {
  const code = normaliseCrs(raw);

  if (code === WGS84) {
    return { code, supported: true, isWgs84: true, label: 'WGS 84 (EPSG:4326)', reason: null };
  }
  if (code === 'EPSG:3857') {
    return {
      code,
      supported: true,
      isWgs84: false,
      label: 'Web Mercator (EPSG:3857)',
      reason: null,
    };
  }
  const utm = utmZoneOf(code);
  if (utm) {
    return {
      code,
      supported: true,
      isWgs84: false,
      label: `WGS 84 / UTM zone ${utm.zone}${utm.north ? 'N' : 'S'} (${code})`,
      reason: null,
    };
  }

  return {
    code,
    supported: false,
    isWgs84: false,
    label: code,
    reason:
      `Coordinates are in ${code}, which this tool cannot transform exactly. ` +
      'They are left untransformed and the geometry is not offered for export, ' +
      'because reprojecting them incorrectly would move the boundary.',
  };
}

const EARTH_RADIUS = 6_378_137;

/** Web Mercator metres to WGS84 degrees. Exact inverse of the projection. */
function webMercatorToWgs84(x: number, y: number): [number, number] {
  const longitude = (x / EARTH_RADIUS) * (180 / Math.PI);
  const latitude = (Math.atan(Math.exp(y / EARTH_RADIUS)) * 2 - Math.PI / 2) * (180 / Math.PI);
  return [longitude, latitude];
}

// WGS84 ellipsoid constants for the UTM inverse.
const A = 6_378_137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const E1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
const K0 = 0.9996;

/**
 * Inverse UTM (Transverse Mercator) on the WGS84 ellipsoid.
 *
 * Standard series solution; accurate to a few millimetres inside a zone, which
 * is far finer than any cadastral source this will meet.
 */
function utmToWgs84(easting: number, northing: number, zone: number, north: boolean): [number, number] {
  const x = easting - 500_000;
  const y = north ? northing : northing - 10_000_000;

  const m = y / K0;
  const mu = m / (A * (1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 * E2 * E2) / 256));

  const phi1 =
    mu +
    ((3 * E1) / 2 - (27 * E1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * E1 ** 2) / 16 - (55 * E1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * E1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * E1 ** 4) / 512) * Math.sin(8 * mu);

  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const tanPhi1 = Math.tan(phi1);

  const ePrime2 = E2 / (1 - E2);
  const n1 = A / Math.sqrt(1 - E2 * sinPhi1 * sinPhi1);
  const t1 = tanPhi1 * tanPhi1;
  const c1 = ePrime2 * cosPhi1 * cosPhi1;
  const r1 = (A * (1 - E2)) / Math.pow(1 - E2 * sinPhi1 * sinPhi1, 1.5);
  const d = x / (n1 * K0);

  const latitude =
    phi1 -
    ((n1 * tanPhi1) / r1) *
      ((d * d) / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * ePrime2) * d ** 4) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * ePrime2 - 3 * c1 * c1) * d ** 6) / 720);

  const longitude =
    (d -
      ((1 + 2 * t1 + c1) * d ** 3) / 6 +
      ((5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * ePrime2 + 24 * t1 * t1) * d ** 5) / 120) /
    cosPhi1;

  const centralMeridian = (zone - 1) * 6 - 180 + 3;
  return [centralMeridian + longitude * (180 / Math.PI), latitude * (180 / Math.PI)];
}

export class CrsTransformError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CrsTransformError';
    this.code = code;
  }
}

/**
 * Convert one position into WGS84 lon/lat.
 * Throws for a CRS that cannot be transformed exactly — never guesses.
 */
export function positionToWgs84(position: Position, crs: string): Position {
  const support = describeCrs(crs);
  const [first, second, altitude] = position;

  if (support.isWgs84) return altitude === undefined ? [first, second] : [first, second, altitude];
  if (!support.supported) {
    throw new CrsTransformError(support.code, support.reason ?? `Cannot transform ${support.code}.`);
  }

  let converted: [number, number];
  if (support.code === 'EPSG:3857') {
    converted = webMercatorToWgs84(first, second);
  } else {
    const utm = utmZoneOf(support.code)!;
    converted = utmToWgs84(first, second, utm.zone, utm.north);
  }

  return altitude === undefined ? converted : [converted[0], converted[1], altitude];
}
