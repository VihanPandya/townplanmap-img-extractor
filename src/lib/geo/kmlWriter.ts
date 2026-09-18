/**
 * KML generation.
 *
 * Only features carrying real source geometry reach this module — see
 * `isExportable`. There is no code path that turns an image into a polygon,
 * because the brief forbids it and the type system has no value to express it.
 *
 * Output targets KML 2.2, which is what Google Earth, QGIS and ArcGIS all read.
 */

import type { GeoFeature, Position } from './types';
import { WGS84 } from './crs';

/** Escape text for an XML text node or attribute value. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Whether a feature may be exported as KML.
 *
 * A feature whose coordinates could not be transformed into WGS84 is not
 * exportable: writing it into a KML file would assert a position the source
 * never gave.
 */
export function isExportable(feature: GeoFeature): boolean {
  if (feature.confidence === 'unverified') return false;
  if (feature.vertexCount === 0) return false;
  return feature.bbox !== null;
}

function formatPosition(position: Position): string {
  const [longitude, latitude, altitude] = position;
  return altitude === undefined
    ? `${longitude},${latitude}`
    : `${longitude},${latitude},${altitude}`;
}

function coordinatesBlock(positions: Position[], indent: string): string {
  return positions.map((position) => `${indent}${formatPosition(position)}`).join('\n');
}

function ringXml(ring: Position[], indent: string, inner: boolean): string {
  const tag = inner ? 'innerBoundaryIs' : 'outerBoundaryIs';
  return [
    `${indent}<${tag}>`,
    `${indent}  <LinearRing>`,
    `${indent}    <coordinates>`,
    coordinatesBlock(ring, `${indent}      `),
    `${indent}    </coordinates>`,
    `${indent}  </LinearRing>`,
    `${indent}</${tag}>`,
  ].join('\n');
}

function polygonXml(rings: Position[][], indent: string): string {
  const parts = rings.map((ring, index) => ringXml(ring, `${indent}  `, index > 0));
  return [`${indent}<Polygon>`, ...parts, `${indent}</Polygon>`].join('\n');
}

function geometryXml(feature: GeoFeature, indent: string): string {
  const { type, coordinates } = feature.geometry;

  switch (type) {
    case 'Point':
      return [
        `${indent}<Point>`,
        `${indent}  <coordinates>${formatPosition(coordinates as Position)}</coordinates>`,
        `${indent}</Point>`,
      ].join('\n');

    case 'MultiPoint':
      return [
        `${indent}<MultiGeometry>`,
        ...(coordinates as Position[]).map((position) =>
          [
            `${indent}  <Point>`,
            `${indent}    <coordinates>${formatPosition(position)}</coordinates>`,
            `${indent}  </Point>`,
          ].join('\n'),
        ),
        `${indent}</MultiGeometry>`,
      ].join('\n');

    case 'LineString':
      return [
        `${indent}<LineString>`,
        `${indent}  <coordinates>`,
        coordinatesBlock(coordinates as Position[], `${indent}    `),
        `${indent}  </coordinates>`,
        `${indent}</LineString>`,
      ].join('\n');

    case 'MultiLineString':
      return [
        `${indent}<MultiGeometry>`,
        ...(coordinates as Position[][]).map((line) =>
          [
            `${indent}  <LineString>`,
            `${indent}    <coordinates>`,
            coordinatesBlock(line, `${indent}      `),
            `${indent}    </coordinates>`,
            `${indent}  </LineString>`,
          ].join('\n'),
        ),
        `${indent}</MultiGeometry>`,
      ].join('\n');

    case 'Polygon':
      return polygonXml(coordinates as Position[][], indent);

    case 'MultiPolygon':
      return [
        `${indent}<MultiGeometry>`,
        ...(coordinates as Position[][][]).map((rings) => polygonXml(rings, `${indent}  `)),
        `${indent}</MultiGeometry>`,
      ].join('\n');

    default:
      return '';
  }
}

export interface KmlProvenance {
  /** Page the geometry file was discovered on. */
  sourcePage?: string | null;
  /** URL of the geometry file itself. */
  geometrySource?: string | null;
  /** URL of the associated map image, when one was associated. */
  imageSource?: string | null;
  /** Site the data came from. */
  website?: string | null;
  retrievedAt?: string;
}

/**
 * Description block for a placemark.
 *
 * Provenance travels inside the KML because the file outlives this tool: a
 * year from now, in QGIS, this is the only record of where the boundary
 * came from and what its limits are.
 */
function descriptionXml(feature: GeoFeature, provenance: KmlProvenance, indent: string): string {
  const lines: string[] = [];
  if (feature.description) lines.push(feature.description);

  const entries = Object.entries(feature.properties);
  if (entries.length > 0) {
    lines.push('', 'Attributes from the source:');
    for (const [key, value] of entries.slice(0, 40)) lines.push(`  ${key}: ${value}`);
  }

  lines.push('', 'Source');
  if (provenance.website) lines.push(`  Website: ${provenance.website}`);
  if (provenance.sourcePage) lines.push(`  Source page: ${provenance.sourcePage}`);
  if (provenance.geometrySource) lines.push(`  Geometry source: ${provenance.geometrySource}`);
  if (provenance.imageSource) lines.push(`  Map image: ${provenance.imageSource}`);
  lines.push(`  Coordinate system: ${feature.sourceCrs}${feature.transformed ? ` transformed to ${WGS84}` : ''}`);
  if (provenance.retrievedAt) lines.push(`  Retrieved: ${provenance.retrievedAt}`);

  lines.push(
    '',
    'This boundary reproduces the geometry published by the source website. It is',
    'not a legal land-survey document unless the authoritative source states that.',
  );

  return [
    `${indent}<description><![CDATA[`,
    lines.join('\n'),
    `${indent}]]></description>`,
  ].join('\n');
}

function placemarkXml(feature: GeoFeature, provenance: KmlProvenance, indent: string): string {
  const name = feature.name ?? 'Unnamed feature';
  const extended = Object.entries(feature.properties).slice(0, 40);

  return [
    `${indent}<Placemark>`,
    `${indent}  <name>${escapeXml(name)}</name>`,
    descriptionXml(feature, provenance, `${indent}  `),
    ...(extended.length > 0
      ? [
          `${indent}  <ExtendedData>`,
          ...extended.map(
            ([key, value]) =>
              `${indent}    <Data name="${escapeXml(key)}"><value>${escapeXml(value)}</value></Data>`,
          ),
          `${indent}  </ExtendedData>`,
        ]
      : []),
    geometryXml(feature, `${indent}  `),
    `${indent}</Placemark>`,
  ]
    .filter(Boolean)
    .join('\n');
}

function documentWrapper(name: string, body: string, note?: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    '  <Document>',
    `    <name>${escapeXml(name)}</name>`,
    ...(note ? [`    <description><![CDATA[${note}]]></description>`] : []),
    body,
    '  </Document>',
    '</kml>',
    '',
  ].join('\n');
}

/** One KML document for one feature. */
export function buildSingleKml(feature: GeoFeature, provenance: KmlProvenance = {}): string {
  if (!isExportable(feature)) {
    throw new Error('This feature has no usable source geometry, so no KML can be produced for it.');
  }
  return documentWrapper(feature.name ?? 'Feature', placemarkXml(feature, provenance, '    '));
}

export interface KmlGroup {
  /** Folder path, outermost first. An empty array puts features at the root. */
  path: string[];
  features: GeoFeature[];
}

/**
 * One KML document containing many features, preserving folder hierarchy.
 * Groups are nested so "Location → Village → Survey" survives into Google Earth.
 */
export function buildCombinedKml(
  documentName: string,
  groups: KmlGroup[],
  provenance: KmlProvenance = {},
): string {
  interface Node {
    children: Map<string, Node>;
    features: GeoFeature[];
  }
  const root: Node = { children: new Map(), features: [] };

  for (const group of groups) {
    let node = root;
    for (const segment of group.path) {
      let next = node.children.get(segment);
      if (!next) {
        next = { children: new Map(), features: [] };
        node.children.set(segment, next);
      }
      node = next;
    }
    for (const feature of group.features) {
      if (isExportable(feature)) node.features.push(feature);
    }
  }

  const render = (node: Node, indent: string): string => {
    const parts: string[] = [];
    for (const feature of node.features) parts.push(placemarkXml(feature, provenance, indent));
    for (const [name, child] of node.children) {
      parts.push(
        [
          `${indent}<Folder>`,
          `${indent}  <name>${escapeXml(name)}</name>`,
          render(child, `${indent}  `),
          `${indent}</Folder>`,
        ]
          .filter((line) => line.length > 0)
          .join('\n'),
      );
    }
    return parts.join('\n');
  };

  const note =
    'Generated from geometry published by the source website. Boundaries reproduce ' +
    'the source data and are not a legal land-survey record unless the authoritative ' +
    'source establishes that status.';

  return documentWrapper(documentName, render(root, '    '), note);
}

/** Filesystem-safe filename for a feature, e.g. "Survey 125/2" → "Survey_125_2.kml". */
export function kmlFilename(name: string | null, fallback: string): string {
  const base = (name ?? '').trim() || fallback;
  const safe = base
    .replace(/[\\/]/g, '_')
    .replace(/[^\w\s.-]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .slice(0, 120);
  return `${safe || fallback}.kml`;
}
