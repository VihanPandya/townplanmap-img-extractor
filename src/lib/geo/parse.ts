/**
 * Parsers that turn a real geographic file into `GeoFeature`s.
 *
 * KML, KMZ, GeoJSON and GPX are handled. Every feature that comes out of here
 * carries coordinates that were present in the source document; there is no
 * path in this module that invents, interpolates or estimates a position.
 *
 * XML is parsed with cheerio in XML mode, which builds an inert tree. No
 * entities are expanded from external sources and nothing is executed.
 */

import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { createHash } from 'node:crypto';
import { CrsTransformError, describeCrs, normaliseCrs, positionToWgs84, WGS84 } from './crs';
import { findKmlInKmz, ZipReadError } from './unzip';
import {
  computeBbox,
  countVertices,
  decimalsOf,
  isPlausibleWgs84,
  limitPrecision,
  type GeoFeature,
  type GeoParseResult,
  type Geometry,
  type GeometryType,
  type GroundOverlay,
  type Position,
} from './types';

const MAX_FEATURES = 5000;
const MAX_VERTICES_PER_FEATURE = 100_000;

function featureId(seed: string): string {
  return `feat_${createHash('sha1').update(seed).digest('hex').slice(0, 16)}`;
}

/**
 * Parse a KML coordinate string.
 *
 * KML gives positions as `lon,lat[,alt]` separated by whitespace, and files in
 * the wild use newlines, tabs and irregular spacing freely.
 */
function parseKmlCoordinates(text: string): { positions: Position[]; decimals: number } {
  const positions: Position[] = [];
  let decimals = 0;

  for (const token of text.trim().split(/\s+/)) {
    if (!token) continue;
    const parts = token.split(',');
    if (parts.length < 2) continue;
    const longitude = Number(parts[0]);
    const latitude = Number(parts[1]);
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) continue;

    decimals = Math.max(decimals, decimalsOf(parts[0]!), decimalsOf(parts[1]!));
    const altitude = parts[2] !== undefined ? Number(parts[2]) : undefined;
    positions.push(
      altitude !== undefined && Number.isFinite(altitude)
        ? [longitude, latitude, altitude]
        : [longitude, latitude],
    );
    if (positions.length > MAX_VERTICES_PER_FEATURE) break;
  }

  return { positions, decimals: decimals || 6 };
}

interface ParseContext {
  crs: string;
  warnings: string[];
  transformed: boolean;
}

/** Apply the source CRS, recording a warning rather than guessing on failure. */
function toWgs84(positions: Position[], context: ParseContext, decimals: number): Position[] | null {
  const support = describeCrs(context.crs);
  if (support.isWgs84) {
    const usable = positions.filter((position) => isPlausibleWgs84(position[0], position[1]));
    if (usable.length !== positions.length) {
      context.warnings.push(
        'Some coordinates fell outside the valid longitude/latitude range and were dropped. ' +
          'That usually means the file is in a projected system it did not declare.',
      );
    }
    return usable.length > 0 ? usable : null;
  }

  try {
    const converted = positions.map((position) => {
      const [longitude, latitude, altitude] = positionToWgs84(position, context.crs);
      const rounded: Position =
        altitude === undefined
          ? [limitPrecision(longitude, decimals), limitPrecision(latitude, decimals)]
          : [limitPrecision(longitude, decimals), limitPrecision(latitude, decimals), altitude];
      return rounded;
    });
    context.transformed = true;
    return converted;
  } catch (error) {
    if (error instanceof CrsTransformError && !context.warnings.some((w) => w.includes(error.code))) {
      context.warnings.push(error.message);
    }
    return null;
  }
}

function makeFeature(
  seed: string,
  name: string | null,
  description: string | null,
  type: GeometryType,
  coordinates: unknown,
  properties: Record<string, string>,
  context: ParseContext,
  folderPath: string[],
): GeoFeature {
  const geometry: Geometry = { type, coordinates };
  return {
    id: featureId(seed),
    name,
    description,
    geometry,
    properties,
    sourceCrs: context.crs,
    transformed: context.transformed,
    confidence: context.transformed ? 'source-transformed' : 'source',
    bbox: computeBbox(geometry),
    vertexCount: countVertices(geometry),
    folderPath,
  };
}

// ----------------------------------------------------------------- KML

export function parseKml(xml: string, sourceUrl: string): GeoParseResult {
  const $ = cheerio.load(xml, { xml: { xmlMode: true, decodeEntities: true } });
  const warnings: string[] = [];
  const features: GeoFeature[] = [];
  const overlays: GroundOverlay[] = [];

  // KML is defined in WGS84; a file claiming otherwise is not valid KML.
  const baseCrs = WGS84;
  const documentName = text($('Document > name').first()) ?? text($('kml > name').first());

  /** Folder names enclosing a placemark, outermost first. */
  const folderNameOf = (node: AnyNode): string[] => {
    const path: string[] = [];
    let current: AnyNode | null = node.parent as AnyNode | null;
    while (current) {
      const element = current as Element;
      if (element.tagName?.toLowerCase() === 'folder') {
        const label = text($(element).children('name').first());
        if (label) path.unshift(label);
      }
      current = (element.parent ?? null) as AnyNode | null;
    }
    return path;
  };

  $('Placemark').each((index, node) => {
    if (features.length >= MAX_FEATURES) return;
    const placemark = $(node);
    const name = text(placemark.children('name').first());
    const description = text(placemark.children('description').first());

    const properties: Record<string, string> = {};
    placemark.find('ExtendedData Data').each((_, data) => {
      const key = $(data).attr('name');
      const value = text($(data).children('value').first());
      if (key && value) properties[key] = value;
    });
    placemark.find('ExtendedData SimpleData').each((_, data) => {
      const key = $(data).attr('name');
      const value = text($(data));
      if (key && value) properties[key] = value;
    });

    const folderPath = folderNameOf(node);
    const context: ParseContext = { crs: baseCrs, warnings, transformed: false };

    // Polygons first: a Placemark with a Polygon is the case that matters.
    const polygons: Position[][][] = [];
    placemark.find('Polygon').each((_, polygonNode) => {
      const polygon = $(polygonNode);
      const rings: Position[][] = [];

      const outer = polygon.find('outerBoundaryIs LinearRing coordinates').first();
      if (outer.length > 0) {
        const { positions, decimals } = parseKmlCoordinates(outer.text());
        const ring = toWgs84(positions, context, decimals);
        if (ring && ring.length >= 4) rings.push(closeRing(ring));
      }
      polygon.find('innerBoundaryIs LinearRing coordinates').each((_, innerNode) => {
        const { positions, decimals } = parseKmlCoordinates($(innerNode).text());
        const ring = toWgs84(positions, context, decimals);
        if (ring && ring.length >= 4) rings.push(closeRing(ring));
      });

      if (rings.length > 0) polygons.push(rings);
    });

    if (polygons.length === 1) {
      features.push(
        makeFeature(`${sourceUrl}#poly${index}`, name, description, 'Polygon', polygons[0], properties, context, folderPath),
      );
      return;
    }
    if (polygons.length > 1) {
      features.push(
        makeFeature(`${sourceUrl}#multipoly${index}`, name, description, 'MultiPolygon', polygons, properties, context, folderPath),
      );
      return;
    }

    const lines: Position[][] = [];
    placemark.find('LineString coordinates').each((_, lineNode) => {
      const { positions, decimals } = parseKmlCoordinates($(lineNode).text());
      const line = toWgs84(positions, context, decimals);
      if (line && line.length >= 2) lines.push(line);
    });
    if (lines.length === 1) {
      features.push(
        makeFeature(`${sourceUrl}#line${index}`, name, description, 'LineString', lines[0], properties, context, folderPath),
      );
      return;
    }
    if (lines.length > 1) {
      features.push(
        makeFeature(`${sourceUrl}#multiline${index}`, name, description, 'MultiLineString', lines, properties, context, folderPath),
      );
      return;
    }

    const points: Position[] = [];
    placemark.find('Point coordinates').each((_, pointNode) => {
      const { positions, decimals } = parseKmlCoordinates($(pointNode).text());
      const converted = toWgs84(positions, context, decimals);
      if (converted && converted[0]) points.push(converted[0]);
    });
    if (points.length === 1) {
      features.push(
        makeFeature(`${sourceUrl}#point${index}`, name, description, 'Point', points[0], properties, context, folderPath),
      );
    } else if (points.length > 1) {
      features.push(
        makeFeature(`${sourceUrl}#multipoint${index}`, name, description, 'MultiPoint', points, properties, context, folderPath),
      );
    }
  });

  // GroundOverlay is the only honest basis for placing an image on a map: the
  // source itself states the bounds.
  $('GroundOverlay').each((index, node) => {
    const overlay = $(node);
    const href = text(overlay.find('Icon > href').first());
    const box = overlay.find('LatLonBox').first();
    if (!href || box.length === 0) return;

    const north = Number(text(box.children('north').first()));
    const south = Number(text(box.children('south').first()));
    const east = Number(text(box.children('east').first()));
    const west = Number(text(box.children('west').first()));
    if (![north, south, east, west].every(Number.isFinite)) return;
    if (!isPlausibleWgs84(west, south) || !isPlausibleWgs84(east, north)) return;

    const rotationText = text(box.children('rotation').first());
    overlays.push({
      id: featureId(`${sourceUrl}#overlay${index}`),
      name: text(overlay.children('name').first()),
      href,
      bbox: { north, south, east, west },
      rotation: rotationText !== null && Number.isFinite(Number(rotationText)) ? Number(rotationText) : null,
    });
  });

  return { features, documentName, sourceCrs: baseCrs, warnings, overlays };
}

export function parseKmz(buffer: Buffer, sourceUrl: string): GeoParseResult {
  try {
    const found = findKmlInKmz(buffer);
    if (!found) {
      return {
        features: [],
        documentName: null,
        sourceCrs: WGS84,
        warnings: ['The KMZ archive contained no KML document.'],
        overlays: [],
      };
    }
    const result = parseKml(found.xml, `${sourceUrl}!${found.name}`);
    return { ...result, documentName: result.documentName ?? found.name };
  } catch (error) {
    return {
      features: [],
      documentName: null,
      sourceCrs: WGS84,
      warnings: [error instanceof ZipReadError ? error.message : 'The KMZ archive could not be read.'],
      overlays: [],
    };
  }
}

// ------------------------------------------------------------- GeoJSON

interface GeoJsonNode {
  type?: string;
  crs?: { type?: string; properties?: { name?: string; href?: string } };
  features?: unknown[];
  geometry?: { type?: string; coordinates?: unknown };
  properties?: Record<string, unknown>;
  coordinates?: unknown;
  geometries?: unknown[];
  id?: string | number;
}

export function parseGeoJson(raw: string, sourceUrl: string): GeoParseResult {
  let parsed: GeoJsonNode;
  try {
    parsed = JSON.parse(raw) as GeoJsonNode;
  } catch {
    return {
      features: [],
      documentName: null,
      sourceCrs: WGS84,
      warnings: ['The file is not valid JSON.'],
      overlays: [],
    };
  }

  const warnings: string[] = [];
  // RFC 7946 fixes GeoJSON at WGS84, but the older spec allowed a crs member
  // and real-world exports still carry it, so it is honoured when present.
  const declared = parsed.crs?.properties?.name ?? parsed.crs?.properties?.href ?? null;
  const crs = normaliseCrs(declared);
  const support = describeCrs(crs);
  if (declared && !support.supported) warnings.push(support.reason!);

  const features: GeoFeature[] = [];
  const nodes: GeoJsonNode[] = Array.isArray(parsed.features)
    ? (parsed.features as GeoJsonNode[])
    : parsed.type === 'Feature'
      ? [parsed]
      : parsed.geometry || parsed.coordinates
        ? [parsed]
        : [];

  nodes.forEach((node, index) => {
    if (features.length >= MAX_FEATURES) return;
    const geometry = node.geometry ?? (node.coordinates ? { type: node.type, coordinates: node.coordinates } : null);
    if (!geometry?.type || geometry.coordinates === undefined) return;

    const type = geometry.type as GeometryType;
    if (!['Point', 'LineString', 'Polygon', 'MultiPolygon', 'MultiLineString', 'MultiPoint'].includes(type)) {
      return;
    }

    const context: ParseContext = { crs, warnings, transformed: false };
    const converted = convertNested(geometry.coordinates, context);
    if (converted === null) return;

    const properties: Record<string, string> = {};
    for (const [key, value] of Object.entries(node.properties ?? {})) {
      if (value === null || value === undefined) continue;
      if (typeof value === 'object') continue;
      properties[key] = String(value);
    }

    const name =
      pickString(properties, ['name', 'Name', 'NAME', 'title', 'label', 'survey_no', 'survey', 'parcel']) ?? null;

    features.push(
      makeFeature(
        `${sourceUrl}#${node.id ?? index}`,
        name,
        pickString(properties, ['description', 'Description', 'desc', 'remarks']) ?? null,
        type,
        converted,
        properties,
        context,
        [],
      ),
    );
  });

  return { features, documentName: null, sourceCrs: crs, warnings, overlays: [] };
}

/** Transform an arbitrarily nested coordinate array, preserving its shape. */
function convertNested(coordinates: unknown, context: ParseContext): unknown {
  if (!Array.isArray(coordinates)) return null;
  if (typeof coordinates[0] === 'number') {
    const position = coordinates as Position;
    const converted = toWgs84([position], context, 7);
    return converted?.[0] ?? null;
  }
  const out: unknown[] = [];
  for (const child of coordinates) {
    const converted = convertNested(child, context);
    if (converted === null) return null;
    out.push(converted);
  }
  return out;
}

function pickString(properties: Record<string, string>, keys: string[]): string | null {
  for (const key of keys) {
    const value = properties[key];
    if (value && value.trim()) return value.trim();
  }
  return null;
}

// ----------------------------------------------------------------- GPX

export function parseGpx(xml: string, sourceUrl: string): GeoParseResult {
  const $ = cheerio.load(xml, { xml: { xmlMode: true, decodeEntities: true } });
  const features: GeoFeature[] = [];
  const warnings: string[] = [];
  const context: ParseContext = { crs: WGS84, warnings, transformed: false };

  $('wpt').each((index, node) => {
    const point = $(node);
    const longitude = Number(point.attr('lon'));
    const latitude = Number(point.attr('lat'));
    if (!isPlausibleWgs84(longitude, latitude)) return;
    features.push(
      makeFeature(
        `${sourceUrl}#wpt${index}`,
        text(point.children('name').first()),
        text(point.children('desc').first()),
        'Point',
        [longitude, latitude],
        {},
        context,
        [],
      ),
    );
  });

  $('trk, rte').each((index, node) => {
    const positions: Position[] = [];
    $(node)
      .find('trkpt, rtept')
      .each((_, pointNode) => {
        const longitude = Number($(pointNode).attr('lon'));
        const latitude = Number($(pointNode).attr('lat'));
        if (isPlausibleWgs84(longitude, latitude)) positions.push([longitude, latitude]);
      });
    if (positions.length < 2) return;
    features.push(
      makeFeature(
        `${sourceUrl}#trk${index}`,
        text($(node).children('name').first()),
        text($(node).children('desc').first()),
        'LineString',
        positions,
        {},
        context,
        [],
      ),
    );
  });

  return { features, documentName: text($('gpx > metadata > name').first()), sourceCrs: WGS84, warnings, overlays: [] };
}

// ----------------------------------------------------------------- misc

function text(node: { length: number; text(): string }): string | null {
  if (node.length === 0) return null;
  const value = node.text().replace(/\s+/g, ' ').trim();
  return value.length > 0 ? value.slice(0, 2000) : null;
}

/** A KML LinearRing must close; sources sometimes omit the repeated vertex. */
function closeRing(ring: Position[]): Position[] {
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (first[0] === last[0] && first[1] === last[1]) return ring;
  return [...ring, first];
}

/** Dispatch on the geographic format the scanner already identified. */
export function parseGeoSource(
  format: string,
  body: Buffer,
  sourceUrl: string,
): GeoParseResult {
  switch (format) {
    case 'kml':
      return parseKml(body.toString('utf8'), sourceUrl);
    case 'kmz':
      return parseKmz(body, sourceUrl);
    case 'geojson':
    case 'topojson':
      return parseGeoJson(body.toString('utf8'), sourceUrl);
    case 'gpx':
      return parseGpx(body.toString('utf8'), sourceUrl);
    default:
      return {
        features: [],
        documentName: null,
        sourceCrs: WGS84,
        warnings: [`${format.toUpperCase()} geometry cannot be read by this tool yet.`],
        overlays: [],
      };
  }
}
