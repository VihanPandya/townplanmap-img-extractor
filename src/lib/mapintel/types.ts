/**
 * The city / village map intelligence model.
 *
 * Every record here is derived from something actually observed during a scan:
 * a breadcrumb in the markup, a folder inside a KML, a Placemark name, an image
 * URL. Nothing invents an administrative name, a boundary or an area.
 *
 * The shape follows section 70 of the brief: Location, Map, Parcel, Image,
 * Export, related by id.
 */

import type { AssociationConfidence, BoundingBox, GeoFeature, GroundOverlay } from '@/lib/geo/types';

export type LocationKind =
  | 'country'
  | 'state'
  | 'district'
  | 'taluka'
  | 'city'
  | 'town'
  | 'village'
  | 'locality'
  | 'map-area'
  | 'unknown';

/** Where a location name came from. Recorded so the user can judge it. */
export type LocationEvidence =
  | 'breadcrumb'
  | 'json-ld'
  | 'url-path'
  | 'page-title'
  | 'kml-folder'
  | 'kml-document'
  | 'feature-property';

export interface LocationNode {
  id: string;
  name: string;
  kind: LocationKind;
  /** Parent location id, or null at the root. */
  parentId: string | null;
  /** Page or file this name was read from. */
  sourceUrl: string;
  /** How the name was obtained; never inferred beyond these. */
  evidence: LocationEvidence[];
  /** Depth in the discovered hierarchy, 0 at the root. */
  depth: number;
  /** Counts rolled up from descendants, computed from real records. */
  mapCount: number;
  parcelCount: number;
  imageCount: number;
  geometryCount: number;
}

/** A source document that carries maps: a KML/KMZ/GeoJSON file, or a page. */
export interface MapRecord {
  id: string;
  locationId: string | null;
  name: string;
  /** 'geometry' when backed by a data file, 'imagery' when images only. */
  mapKind: 'geometry' | 'imagery';
  /** The scan asset this map came from, when it was a file. */
  assetId: string | null;
  sourcePage: string;
  sourceUrl: string | null;
  format: string | null;
  parcelCount: number;
  imageCount: number;
  /** Bounds covering every parcel in this map, when geometry exists. */
  bbox: BoundingBox | null;
  /** Coordinate system the source declared. */
  sourceCrs: string | null;
  warnings: string[];
}

/** What can actually be produced for a parcel. Drives §51's three states. */
export type GeometryAvailability = 'available' | 'image-only' | 'unverified';

export interface ParcelImageLink {
  /** Scan asset id of the image. */
  imageId: string;
  url: string;
  width: number | null;
  height: number | null;
  format: string | null;
  fileSize: number | null;
  sourcePage: string;
  confidence: AssociationConfidence;
  /** Why the association was made, shown to the user verbatim. */
  reason: string;
  /** True when the source georeferenced this image (KML GroundOverlay). */
  georeferenced: boolean;
  bbox: BoundingBox | null;
}

export interface ParcelRecord {
  id: string;
  mapId: string;
  locationId: string | null;
  /** Survey / parcel reference exactly as the source wrote it. */
  reference: string | null;
  name: string;
  /** Every attribute the source carried, unmodified. */
  properties: Record<string, string>;
  /** Null when the source gave no usable geometry. */
  feature: GeoFeature | null;
  geometryAvailability: GeometryAvailability;
  /** True when a KML can be produced from real coordinates. */
  kmlAvailable: boolean;
  /** Area in square metres, only when the source stated it or geometry allows. */
  areaSquareMetres: number | null;
  /** How the area was obtained. Null when there is no area. */
  areaBasis: 'source-attribute' | 'computed-from-geometry' | null;
  images: ParcelImageLink[];
  folderPath: string[];
  sourcePage: string;
  geometrySource: string | null;
}

export interface LocationSummary {
  location: LocationNode;
  /** Direct children, for the hierarchy view. */
  children: LocationNode[];
  maps: MapRecord[];
  counts: {
    maps: number;
    parcels: number;
    images: number;
    kmlAvailable: number;
    imageOnly: number;
    unverified: number;
    otherDocuments: number;
  };
  bbox: BoundingBox | null;
  /** Georeferenced overlays covering this location, from the source. */
  overlays: GroundOverlay[];
}

/** The whole derived model for one scan. */
export interface MapIntelIndex {
  scanId: string;
  scanUrl: string;
  host: string;
  builtAt: number;
  locations: LocationNode[];
  maps: MapRecord[];
  parcels: ParcelRecord[];
  overlays: GroundOverlay[];
  /** Assets that are neither imagery nor geometry, e.g. PDFs seen on pages. */
  otherDocumentCount: number;
  warnings: string[];
}
