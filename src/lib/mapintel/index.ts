/**
 * Cached access to the derived map model.
 *
 * Building the index walks every feature of every geographic file in a scan, so
 * the result is memoised per scan and invalidated when the scan changes.
 */

import { getScanStore, type ScanRecord } from '@/lib/database/store';
import { buildMapIntelIndex } from './build';
import type { LocationNode, LocationSummary, MapIntelIndex, ParcelRecord } from './types';
import { mergeBbox } from './build';

interface CacheEntry {
  index: MapIntelIndex;
  /** The record's updatedAt when the index was built. */
  builtFrom: number;
}

const globalRef = globalThis as typeof globalThis & { __mapIntelCache?: Map<string, CacheEntry> };

function cache(): Map<string, CacheEntry> {
  if (!globalRef.__mapIntelCache) globalRef.__mapIntelCache = new Map();
  return globalRef.__mapIntelCache;
}

export function indexForRecord(record: ScanRecord): MapIntelIndex {
  const entry = cache().get(record.id);
  if (entry && entry.builtFrom === record.updatedAt) return entry.index;

  const index = buildMapIntelIndex(record);
  cache().set(record.id, { index, builtFrom: record.updatedAt });

  // Keep the cache small; scans themselves are already bounded by the store.
  if (cache().size > 12) {
    const oldest = [...cache().entries()].sort((a, b) => a[1].index.builtAt - b[1].index.builtAt)[0];
    if (oldest) cache().delete(oldest[0]);
  }
  return index;
}

export async function indexForScan(scanId: string): Promise<MapIntelIndex | null> {
  const record = await getScanStore().get(scanId);
  return record ? indexForRecord(record) : null;
}

/** Everything the location dashboard needs, computed from the real records. */
export function summariseLocation(index: MapIntelIndex, locationId: string): LocationSummary | null {
  const location = index.locations.find((node) => node.id === locationId);
  if (!location) return null;

  const descendantIds = collectDescendants(index.locations, locationId);
  const maps = index.maps.filter((map) => map.locationId && descendantIds.has(map.locationId));
  const parcels = index.parcels.filter((parcel) => parcel.locationId && descendantIds.has(parcel.locationId));

  let bbox = null;
  for (const map of maps) bbox = mergeBbox(bbox, map.bbox);

  const imageIds = new Set<string>();
  for (const parcel of parcels) for (const image of parcel.images) imageIds.add(image.imageId);

  const overlayHrefs = new Set(
    parcels.flatMap((parcel) => parcel.images.filter((image) => image.georeferenced).map((image) => image.url)),
  );

  return {
    location,
    children: index.locations.filter((node) => node.parentId === locationId),
    maps,
    counts: {
      maps: maps.length,
      parcels: parcels.length,
      images: imageIds.size,
      kmlAvailable: parcels.filter((parcel) => parcel.kmlAvailable).length,
      imageOnly: parcels.filter((parcel) => parcel.geometryAvailability === 'image-only').length,
      unverified: parcels.filter((parcel) => parcel.geometryAvailability === 'unverified').length,
      otherDocuments: index.otherDocumentCount,
    },
    bbox,
    overlays: index.overlays.filter((overlay) => overlayHrefs.has(overlay.href) || overlayHrefs.size === 0),
  };
}

export function collectDescendants(locations: LocationNode[], rootId: string): Set<string> {
  const byParent = new Map<string | null, LocationNode[]>();
  for (const node of locations) {
    const list = byParent.get(node.parentId) ?? [];
    list.push(node);
    byParent.set(node.parentId, list);
  }
  const ids = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of byParent.get(current) ?? []) {
      if (ids.has(child.id)) continue;
      ids.add(child.id);
      queue.push(child.id);
    }
  }
  return ids;
}

/** Ancestors of a location, outermost first — the breadcrumb trail. */
export function ancestryOf(index: MapIntelIndex, locationId: string): LocationNode[] {
  const byId = new Map(index.locations.map((node) => [node.id, node]));
  const trail: LocationNode[] = [];
  let current = byId.get(locationId);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    trail.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return trail;
}

/** Free-text search across locations, parcels and references (§65). */
export function searchIndex(
  index: MapIntelIndex,
  query: string,
  limit = 60,
): { locations: LocationNode[]; parcels: ParcelRecord[] } {
  const needle = query.trim().toLowerCase();
  if (!needle) return { locations: [], parcels: [] };
  const compact = needle.replace(/[^\w]/g, '');

  const locations = index.locations
    .filter((node) => node.name.toLowerCase().includes(needle))
    .slice(0, limit);

  const parcels = index.parcels
    .filter((parcel) => {
      const haystack = `${parcel.reference ?? ''} ${parcel.name} ${Object.values(parcel.properties).join(' ')}`
        .toLowerCase();
      if (haystack.includes(needle)) return true;
      // "125/2" should also match a reference written "125-2" or "125 2".
      return compact.length >= 3 && haystack.replace(/[^\w]/g, '').includes(compact);
    })
    .slice(0, limit);

  return { locations, parcels };
}
