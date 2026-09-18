/**
 * Geographic types.
 *
 * A `GeoFeature` only ever exists because coordinates were parsed out of a real
 * source file. Nothing here is derived from an image, a pixel measurement or a
 * guess — see `geometryConfidence` for how that distinction is recorded.
 */

export type GeometryType = 'Point' | 'LineString' | 'Polygon' | 'MultiPolygon' | 'MultiLineString' | 'MultiPoint';

/** [longitude, latitude] and optionally altitude, in that order (GeoJSON order). */
export type Position = [number, number] | [number, number, number];

export interface Geometry {
  type: GeometryType;
  /**
   * Coordinates in the nesting the type implies:
   *  Point            Position
   *  LineString       Position[]
   *  Polygon          Position[][]   (ring 0 is the outer boundary)
   *  MultiPolygon     Position[][][]
   */
  coordinates: unknown;
}

/**
 * How trustworthy the geometry is.
 *
 * `source` is the only value that means "this came from real vector data".
 * There is deliberately no value meaning "traced from an image": the spec
 * forbids manufacturing geometry that way, so the code cannot express it.
 */
export type GeometryConfidence = 'source' | 'source-transformed' | 'unverified';

/** How confident the link between an image and a parcel is. */
export type AssociationConfidence = 'verified' | 'probable' | 'unverified';

export interface BoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface GeoFeature {
  id: string;
  /** Placemark name / feature title exactly as the source gave it. */
  name: string | null;
  /** Description or free text from the source, untouched. */
  description: string | null;
  geometry: Geometry;
  /** Every property the source carried, unmodified. */
  properties: Record<string, string>;
  /** The coordinate reference system the source declared or implied. */
  sourceCrs: string;
  /** True when coordinates were converted into WGS84 from another system. */
  transformed: boolean;
  confidence: GeometryConfidence;
  bbox: BoundingBox | null;
  vertexCount: number;
  /** Folder path inside the source document, when it had folders. */
  folderPath: string[];
}

export interface GeoParseResult {
  features: GeoFeature[];
  /** Name of the source document, when it declared one. */
  documentName: string | null;
  sourceCrs: string;
  /** Problems worth telling the user about, rather than silently dropping. */
  warnings: string[];
  /** Image overlays with real geographic bounds, as KML GroundOverlay provides. */
  overlays: GroundOverlay[];
}

/** A map image the source explicitly georeferenced. */
export interface GroundOverlay {
  id: string;
  name: string | null;
  /** The image URL exactly as the source gave it. */
  href: string;
  /** Bounds from the source. This is the only basis for an honest overlay. */
  bbox: BoundingBox;
  rotation: number | null;
}

/** Longitude/latitude sanity, used to reject nonsense rather than plot it. */
export function isPlausibleWgs84(longitude: number, latitude: number): boolean {
  return (
    Number.isFinite(longitude) &&
    Number.isFinite(latitude) &&
    longitude >= -180 &&
    longitude <= 180 &&
    latitude >= -90 &&
    latitude <= 90
  );
}

/** Walk every position in a geometry, whatever its nesting depth. */
export function forEachPosition(coordinates: unknown, visit: (position: Position) => void): void {
  if (!Array.isArray(coordinates)) return;
  if (typeof coordinates[0] === 'number') {
    visit(coordinates as Position);
    return;
  }
  for (const child of coordinates) forEachPosition(child, visit);
}

export function computeBbox(geometry: Geometry): BoundingBox | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  let seen = 0;

  forEachPosition(geometry.coordinates, ([longitude, latitude]) => {
    seen += 1;
    if (longitude < west) west = longitude;
    if (longitude > east) east = longitude;
    if (latitude < south) south = latitude;
    if (latitude > north) north = latitude;
  });

  if (seen === 0) return null;
  return { west, south, east, north };
}

export function countVertices(geometry: Geometry): number {
  let count = 0;
  forEachPosition(geometry.coordinates, () => {
    count += 1;
  });
  return count;
}

/**
 * Round to the precision the source actually offered.
 *
 * Re-serialising a transformed coordinate can produce 15 decimal places from an
 * input that had 6, which would imply sub-micron accuracy the source never had.
 */
export function limitPrecision(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Decimal places present in the source, capped at a sane maximum. */
export function decimalsOf(raw: string): number {
  const match = /\.(\d+)/.exec(raw);
  return match ? Math.min(match[1]!.length, 9) : 0;
}
