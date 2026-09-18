/**
 * Builds the location / map / parcel model from a completed scan.
 *
 * The rules this module follows, in order of importance:
 *
 *  - A parcel exists because a Placemark or Feature existed in a real file.
 *  - A location name exists because it was read from a breadcrumb, a KML
 *    folder, a URL path segment or a feature attribute. Administrative levels
 *    are only labelled when the source said so; otherwise the kind is
 *    'unknown' rather than a guess.
 *  - An area is reported only when the source stated it, or when real geometry
 *    allows it to be computed — and which of the two is always recorded.
 *  - An image is linked to a parcel with an explicit confidence, never
 *    presented as exact when it was inferred.
 */

import { createHash } from 'node:crypto';
import { describeCrs } from '@/lib/geo/crs';
import { isExportable } from '@/lib/geo/kmlWriter';
import type { BoundingBox, GeoFeature, GeoParseResult } from '@/lib/geo/types';
import type { ScanRecord } from '@/lib/database/store';
import type { DiscoveredImage } from '@/lib/types';
import { tokenize } from '@/lib/utils/text';
import type {
  GeometryAvailability,
  LocationEvidence,
  LocationKind,
  LocationNode,
  MapIntelIndex,
  MapRecord,
  ParcelImageLink,
  ParcelRecord,
} from './types';

function idOf(prefix: string, seed: string): string {
  return `${prefix}_${createHash('sha1').update(seed).digest('hex').slice(0, 16)}`;
}

/**
 * Survey / parcel references as Indian land records write them:
 * "125/2", "Survey No. 125/2", "S.No 125/2/A", "TP 42 FP 118".
 * Only matched against text the source actually provided.
 */
const SURVEY_PATTERNS: RegExp[] = [
  // "Survey 125/2", "Survey No. 125/2", "Survey Number 125/2", "Sy No 125/2".
  /\b(?:survey|sy)\b\.?\s*(?:no\.?|number)?\s*[:.]?\s*(\d+[\w/-]*)/i,
  // "S.No 126/1/A", "S No. 126/1".
  /\bs\.?\s*no\.?\s*[:.]?\s*(\d+[\w/-]*)/i,
  /\b(?:final\s*plot|f\.?\s*p\.?)\s*(?:no\.?|number)?\s*[:.]?\s*(\d+[\w/-]*)/i,
  /\b(?:block|khasra|gat|hissa)\s*(?:no\.?|number)?\s*[:.]?\s*(\d+[\w/-]*)/i,
  // A bare reference that is nothing but the number itself.
  /^(\d{1,5}(?:\/\d{1,4})+(?:\/[A-Za-z])?)$/,
];

/** Property keys that commonly hold a survey reference. */
const REFERENCE_KEYS = [
  'survey_no', 'surveyno', 'survey', 'survey_number', 'sno', 's_no',
  'parcel', 'parcel_id', 'parcelid', 'plot', 'plot_no', 'final_plot',
  'fp_no', 'khasra', 'gat_no', 'block_no', 'reference', 'ref',
];

export function extractSurveyReference(
  name: string | null,
  properties: Record<string, string>,
): string | null {
  for (const key of Object.keys(properties)) {
    if (!REFERENCE_KEYS.includes(key.toLowerCase().replace(/\s+/g, '_'))) continue;
    const value = properties[key]?.trim();
    if (value) return value;
  }
  const text = (name ?? '').trim();
  if (!text) return null;
  for (const pattern of SURVEY_PATTERNS) {
    const match = pattern.exec(text);
    if (match?.[1]) return match[1];
  }
  return null;
}

/** Property keys that commonly hold a place name. */
const PLACE_KEYS: Array<[keys: string[], kind: LocationKind]> = [
  [['village', 'village_name', 'vill', 'gram'], 'village'],
  [['town', 'town_name', 'nagar'], 'town'],
  [['city', 'city_name'], 'city'],
  [['taluka', 'tehsil', 'taluk', 'mandal', 'block'], 'taluka'],
  [['district', 'dist', 'district_name'], 'district'],
  [['state', 'state_name'], 'state'],
  [['locality', 'ward', 'sector', 'area'], 'locality'],
];

/** Words that, when a source uses them, indicate an administrative level. */
const KIND_WORDS: Array<[words: string[], kind: LocationKind]> = [
  [['village', 'gram', 'gaon'], 'village'],
  [['town', 'nagar'], 'town'],
  [['city', 'municipal', 'corporation', 'mahanagar'], 'city'],
  [['taluka', 'tehsil', 'taluk', 'mandal'], 'taluka'],
  [['district', 'dist', 'jilla'], 'district'],
  [['state'], 'state'],
  [['locality', 'ward', 'sector'], 'locality'],
  [['tp', 'scheme', 'survey', 'map'], 'map-area'],
];

/**
 * Classify a location name from words the source itself used.
 * Returns 'unknown' rather than guessing, which the UI shows as-is.
 */
export function classifyLocationKind(name: string, hint?: string | null): LocationKind {
  const tokens = new Set([...tokenize(name), ...tokenize(hint ?? '')]);
  for (const [words, kind] of KIND_WORDS) {
    if (words.some((word) => tokens.has(word))) return kind;
  }
  return 'unknown';
}

interface LocationBuilder {
  node: LocationNode;
  children: Map<string, LocationBuilder>;
}

class LocationTree {
  private readonly roots = new Map<string, LocationBuilder>();
  private readonly index = new Map<string, LocationBuilder>();

  /** Insert a path of names, returning the id of its deepest node. */
  insert(
    path: Array<{ name: string; kind?: LocationKind; evidence: LocationEvidence }>,
    sourceUrl: string,
  ): string | null {
    let level = this.roots;
    let parentId: string | null = null;
    let depth = 0;
    let lastId: string | null = null;

    for (const step of path) {
      const name = step.name.trim();
      if (!name || name.length > 120) continue;
      const key = name.toLowerCase();

      let builder = level.get(key);
      if (!builder) {
        const id = idOf('loc', `${parentId ?? 'root'}|${key}`);
        builder = {
          node: {
            id,
            name,
            kind: step.kind ?? classifyLocationKind(name),
            parentId,
            sourceUrl,
            evidence: [step.evidence],
            depth,
            mapCount: 0,
            parcelCount: 0,
            imageCount: 0,
            geometryCount: 0,
          },
          children: new Map(),
        };
        level.set(key, builder);
        this.index.set(id, builder);
      } else if (!builder.node.evidence.includes(step.evidence)) {
        builder.node.evidence.push(step.evidence);
      }

      // A later, better-evidenced classification wins over 'unknown'.
      if (step.kind && builder.node.kind === 'unknown') builder.node.kind = step.kind;

      parentId = builder.node.id;
      lastId = builder.node.id;
      level = builder.children;
      depth += 1;
    }

    return lastId;
  }

  get(id: string): LocationBuilder | undefined {
    return this.index.get(id);
  }

  /** Roll a count up from a node to every ancestor. */
  bump(id: string | null, field: 'mapCount' | 'parcelCount' | 'imageCount' | 'geometryCount', by = 1): void {
    let current = id ? this.index.get(id) : undefined;
    const seen = new Set<string>();
    while (current && !seen.has(current.node.id)) {
      seen.add(current.node.id);
      current.node[field] += by;
      current = current.node.parentId ? this.index.get(current.node.parentId) : undefined;
    }
  }

  all(): LocationNode[] {
    return [...this.index.values()].map((builder) => builder.node);
  }
}

/** Ring area via the spherical excess approximation, in square metres. */
function ringArea(ring: Array<[number, number] | [number, number, number]>): number {
  if (ring.length < 4) return 0;
  const radius = 6_378_137;
  let total = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [lon1, lat1] = ring[i]!;
    const [lon2, lat2] = ring[i + 1]!;
    total +=
      ((lon2 - lon1) * (Math.PI / 180)) *
      (2 + Math.sin(lat1 * (Math.PI / 180)) + Math.sin(lat2 * (Math.PI / 180)));
  }
  return Math.abs((total * radius * radius) / 2);
}

/** Area from real geometry, or null when the geometry is not a polygon. */
export function areaOfFeature(feature: GeoFeature): number | null {
  const { type, coordinates } = feature.geometry;
  type Ring = Array<[number, number] | [number, number, number]>;

  if (type === 'Polygon') {
    const rings = coordinates as Ring[];
    if (rings.length === 0) return null;
    const outer = ringArea(rings[0]!);
    const holes = rings.slice(1).reduce((sum, ring) => sum + ringArea(ring), 0);
    return Math.max(0, outer - holes);
  }
  if (type === 'MultiPolygon') {
    const polygons = coordinates as Ring[][];
    let total = 0;
    for (const rings of polygons) {
      if (rings.length === 0) continue;
      total += ringArea(rings[0]!) - rings.slice(1).reduce((sum, ring) => sum + ringArea(ring), 0);
    }
    return total > 0 ? total : null;
  }
  return null;
}

/** Area stated by the source, converted to square metres where the unit is clear. */
function statedArea(properties: Record<string, string>): number | null {
  const entries = Object.entries(properties);
  for (const [key, raw] of entries) {
    const lowerKey = key.toLowerCase();
    if (!/area|extent|acre|hectare|sqm|sq_m/.test(lowerKey)) continue;
    const value = Number(String(raw).replace(/[^\d.]/g, ''));
    if (!Number.isFinite(value) || value <= 0) continue;

    const unitText = `${lowerKey} ${String(raw).toLowerCase()}`;
    if (/hectare|\bha\b/.test(unitText)) return value * 10_000;
    if (/acre/.test(unitText)) return value * 4046.8564224;
    if (/sq\.?\s*(m|metre|meter)|sqm|sq_m/.test(unitText)) return value;
    // An unlabelled number is not converted: the unit is unknown.
    return null;
  }
  return null;
}

function mergeBbox(a: BoundingBox | null, b: BoundingBox | null): BoundingBox | null {
  if (!a) return b;
  if (!b) return a;
  return {
    west: Math.min(a.west, b.west),
    south: Math.min(a.south, b.south),
    east: Math.max(a.east, b.east),
    north: Math.max(a.north, b.north),
  };
}

/**
 * Link images to a parcel, recording how sure the link is.
 *
 * verified  - the source itself ties them together (a georeferenced overlay, or
 *             the parcel reference appearing in the image URL).
 * probable  - same page, and the filename or alt text shares the parcel's or
 *             location's distinctive words.
 * unverified- nothing beyond both being on the same page.
 */
function associateImages(
  parcel: { reference: string | null; name: string; sourcePage: string; folderPath: string[] },
  images: DiscoveredImage[],
  overlays: GeoParseResult['overlays'],
): ParcelImageLink[] {
  const links: ParcelImageLink[] = [];
  const referenceTokens = new Set(tokenize(`${parcel.reference ?? ''} ${parcel.name}`));
  const locationTokens = new Set(parcel.folderPath.flatMap((segment) => tokenize(segment)));
  const referenceCompact = (parcel.reference ?? '').replace(/[^\w]/g, '').toLowerCase();

  for (const image of images) {
    if (image.assetKind !== 'image') continue;

    const overlay = overlays.find((entry) => entry.href === image.url || image.url.endsWith(entry.href));
    const haystack = `${image.filename} ${image.altText ?? ''} ${image.title ?? ''}`.toLowerCase();
    const compact = haystack.replace(/[^\w]/g, '');
    const imageTokens = new Set(tokenize(haystack));

    let confidence: ParcelImageLink['confidence'];
    let reason: string;

    if (overlay) {
      confidence = 'verified';
      reason = 'The source publishes this image as a georeferenced overlay for this area.';
    } else if (referenceCompact.length >= 3 && compact.includes(referenceCompact)) {
      confidence = 'verified';
      reason = `The image filename or alt text contains the parcel reference "${parcel.reference}".`;
    } else if (
      image.sourcePage === parcel.sourcePage &&
      [...referenceTokens].some((token) => token.length > 2 && imageTokens.has(token))
    ) {
      confidence = 'probable';
      reason = 'Found on the same page, and the image text shares wording with the parcel name.';
    } else if (
      image.sourcePage === parcel.sourcePage &&
      [...locationTokens].some((token) => token.length > 3 && imageTokens.has(token))
    ) {
      confidence = 'probable';
      reason = 'Found on the same page, and the image text mentions the same place.';
    } else if (image.sourcePage === parcel.sourcePage) {
      confidence = 'unverified';
      reason = 'Found on the same page as the geometry, with nothing further tying them together.';
    } else {
      continue;
    }

    links.push({
      imageId: image.id,
      url: image.url,
      width: image.width,
      height: image.height,
      format: image.extension ?? image.mimeType,
      fileSize: image.fileSize,
      sourcePage: image.sourcePage,
      confidence,
      reason,
      georeferenced: Boolean(overlay),
      bbox: overlay?.bbox ?? null,
    });
  }

  // Strongest association first, then largest image.
  const rank = { verified: 0, probable: 1, unverified: 2 } as const;
  links.sort(
    (a, b) =>
      rank[a.confidence] - rank[b.confidence] ||
      (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0),
  );
  return links.slice(0, 12);
}

/** Location path implied by a page URL, e.g. /maps/gujarat/ahmedabad → two levels. */
function pathFromUrl(pageUrl: string): string[] {
  try {
    const url = new URL(pageUrl);
    return url.pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => {
        let text = segment;
        try {
          text = decodeURIComponent(segment);
        } catch {
          /* keep the raw segment */
        }
        return text.replace(/\.(html?|php|aspx?|jsp)$/i, '').replace(/[-_+]+/g, ' ').trim();
      })
      .filter((segment) => segment.length > 1 && segment.length < 60)
      .slice(0, 5);
  } catch {
    return [];
  }
}

/**
 * Build the whole model. Pure: takes a scan record, returns an index.
 */
export function buildMapIntelIndex(record: ScanRecord): MapIntelIndex {
  const tree = new LocationTree();
  const maps: MapRecord[] = [];
  const parcels: ParcelRecord[] = [];
  const warnings: string[] = [];
  const allOverlays: GeoParseResult['overlays'] = [];

  const assets = [...record.images.values()];
  const imagesByPage = new Map<string, DiscoveredImage[]>();
  for (const asset of assets) {
    if (asset.assetKind !== 'image') continue;
    for (const reference of asset.references) {
      const list = imagesByPage.get(reference.sourcePage) ?? [];
      if (!list.includes(asset)) list.push(asset);
      imagesByPage.set(reference.sourcePage, list);
    }
  }

  const pageTitles = new Map(record.pages.map((page) => [page.url, page.title] as const));

  // ------------------------------------------------- geometry-backed maps
  for (const asset of assets) {
    if (asset.assetKind !== 'geo') continue;
    const parsed = record.geometry.get(asset.id);

    const urlPath = pathFromUrl(asset.sourcePage);
    const baseLocationPath = urlPath.map((name) => ({
      name,
      evidence: 'url-path' as LocationEvidence,
    }));

    if (!parsed || parsed.features.length === 0) {
      // A geographic file that produced no features is still a map worth
      // listing, so the user can see it exists and why it yielded nothing.
      const locationId = tree.insert(baseLocationPath, asset.sourcePage);
      const mapId = idOf('map', asset.url);
      maps.push({
        id: mapId,
        locationId,
        name: asset.filename,
        mapKind: 'geometry',
        assetId: asset.id,
        sourcePage: asset.sourcePage,
        sourceUrl: asset.url,
        format: asset.geoFormat,
        parcelCount: 0,
        imageCount: 0,
        bbox: null,
        sourceCrs: null,
        warnings: asset.geometryWarnings.length > 0 ? asset.geometryWarnings : ['No features could be read from this file.'],
      });
      tree.bump(locationId, 'mapCount');
      continue;
    }

    allOverlays.push(...parsed.overlays);
    const crs = describeCrs(parsed.sourceCrs);
    if (!crs.supported && !warnings.includes(crs.reason!)) warnings.push(crs.reason!);

    const mapId = idOf('map', asset.url);
    let mapBbox: BoundingBox | null = null;
    let mapParcels = 0;
    let mapImages = 0;

    // The document name is a location name when the source gave one.
    const documentPath = parsed.documentName
      ? [{ name: parsed.documentName, evidence: 'kml-document' as LocationEvidence }]
      : [];

    for (const feature of parsed.features) {
      const folderPath = feature.folderPath.map((name) => ({
        name,
        evidence: 'kml-folder' as LocationEvidence,
      }));

      // A feature attribute naming a place is the strongest location evidence.
      const attributePath: Array<{ name: string; kind: LocationKind; evidence: LocationEvidence }> = [];
      for (const [keys, kind] of PLACE_KEYS) {
        for (const [key, value] of Object.entries(feature.properties)) {
          if (!keys.includes(key.toLowerCase().replace(/\s+/g, '_'))) continue;
          const name = value.trim();
          if (name && !attributePath.some((entry) => entry.name.toLowerCase() === name.toLowerCase())) {
            attributePath.push({ name, kind, evidence: 'feature-property' });
          }
        }
      }
      // Broadest administrative level first.
      const order: LocationKind[] = ['state', 'district', 'taluka', 'city', 'town', 'village', 'locality'];
      attributePath.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));

      const locationPath =
        attributePath.length > 0
          ? attributePath
          : folderPath.length > 0
            ? [...documentPath, ...folderPath]
            : documentPath.length > 0
              ? documentPath
              : baseLocationPath;

      const locationId = tree.insert(locationPath, asset.sourcePage);

      const reference = extractSurveyReference(feature.name, feature.properties);
      const exportable = isExportable(feature);
      const availability: GeometryAvailability = exportable ? 'available' : 'unverified';

      const geometryArea = exportable ? areaOfFeature(feature) : null;
      const sourceArea = statedArea(feature.properties);
      const area = sourceArea ?? geometryArea;
      const areaBasis = sourceArea !== null ? 'source-attribute' : geometryArea !== null ? 'computed-from-geometry' : null;

      const parcelName = feature.name ?? reference ?? `Feature ${parcels.length + 1}`;
      const candidateImages = imagesByPage.get(asset.sourcePage) ?? [];
      const images = associateImages(
        { reference, name: parcelName, sourcePage: asset.sourcePage, folderPath: feature.folderPath },
        candidateImages,
        parsed.overlays,
      );

      parcels.push({
        id: idOf('parcel', `${asset.url}#${feature.id}`),
        mapId,
        locationId,
        reference,
        name: parcelName,
        properties: feature.properties,
        feature,
        geometryAvailability: availability,
        kmlAvailable: exportable,
        areaSquareMetres: area,
        areaBasis,
        images,
        folderPath: feature.folderPath,
        sourcePage: asset.sourcePage,
        geometrySource: asset.url,
      });

      mapParcels += 1;
      mapImages += images.length;
      mapBbox = mergeBbox(mapBbox, feature.bbox);

      tree.bump(locationId, 'parcelCount');
      if (exportable) tree.bump(locationId, 'geometryCount');
      if (images.length > 0) tree.bump(locationId, 'imageCount', images.length);
    }

    const mapLocationId =
      parcels.find((parcel) => parcel.mapId === mapId)?.locationId ?? tree.insert(baseLocationPath, asset.sourcePage);

    maps.push({
      id: mapId,
      locationId: mapLocationId,
      name: parsed.documentName ?? asset.filename,
      mapKind: 'geometry',
      assetId: asset.id,
      sourcePage: asset.sourcePage,
      sourceUrl: asset.url,
      format: asset.geoFormat,
      parcelCount: mapParcels,
      imageCount: mapImages,
      bbox: mapBbox,
      sourceCrs: parsed.sourceCrs,
      warnings: parsed.warnings.slice(0, 4),
    });
    tree.bump(mapLocationId, 'mapCount');
  }

  // ------------------------------------------------------- imagery-only maps
  // Pages carrying map-looking images but no geometry are still map areas the
  // user may want, and must be clearly marked as image-only.
  const geometryPages = new Set(maps.map((map) => map.sourcePage));
  for (const [pageUrl, pageImages] of imagesByPage) {
    if (geometryPages.has(pageUrl)) continue;
    const mapImages = pageImages.filter((image) => image.category === 'map');
    if (mapImages.length === 0) continue;

    const locationId = tree.insert(
      pathFromUrl(pageUrl).map((name) => ({ name, evidence: 'url-path' as LocationEvidence })),
      pageUrl,
    );
    const mapId = idOf('map', `imagery|${pageUrl}`);
    maps.push({
      id: mapId,
      locationId,
      name: pageTitles.get(pageUrl) ?? pageUrl,
      mapKind: 'imagery',
      assetId: null,
      sourcePage: pageUrl,
      sourceUrl: null,
      format: null,
      parcelCount: mapImages.length,
      imageCount: mapImages.length,
      bbox: null,
      sourceCrs: null,
      warnings: [],
    });
    tree.bump(locationId, 'mapCount');

    for (const image of mapImages) {
      parcels.push({
        id: idOf('parcel', `imagery|${image.url}`),
        mapId,
        locationId,
        reference: extractSurveyReference(image.altText ?? image.filename, {}),
        name: image.altText ?? image.filename,
        properties: {},
        feature: null,
        geometryAvailability: 'image-only',
        kmlAvailable: false,
        areaSquareMetres: null,
        areaBasis: null,
        images: [
          {
            imageId: image.id,
            url: image.url,
            width: image.width,
            height: image.height,
            format: image.extension ?? image.mimeType,
            fileSize: image.fileSize,
            sourcePage: image.sourcePage,
            confidence: 'verified',
            reason: 'This record is the image itself; no separate association was needed.',
            georeferenced: false,
            bbox: null,
          },
        ],
        folderPath: [],
        sourcePage: pageUrl,
        geometrySource: null,
      });
      tree.bump(locationId, 'parcelCount');
      tree.bump(locationId, 'imageCount');
    }
  }

  const otherDocumentCount = assets.filter(
    (asset) => asset.assetKind === 'image' && asset.category !== 'map' && asset.status === 'available',
  ).length;

  return {
    scanId: record.id,
    scanUrl: record.url,
    host: record.host,
    builtAt: Date.now(),
    locations: tree.all(),
    maps,
    parcels,
    overlays: allOverlays,
    otherDocumentCount,
    warnings,
  };
}

export { mergeBbox };
