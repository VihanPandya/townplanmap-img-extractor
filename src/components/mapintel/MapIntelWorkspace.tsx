'use client';

/**
 * The city / village map intelligence module.
 *
 * Workflow: select a location → see what was actually found → explore the
 * geometry → inspect a parcel → export KML → bulk download.
 *
 * Everything shown comes from the scan the user just ran. There is no built-in
 * list of cities or villages anywhere in this component.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Building2,
  ChevronRight,
  Layers,
  MapPinned,
  Search,
  ShieldAlert,
  Trees,
} from 'lucide-react';
import { MapCanvas } from './MapCanvas';
import { ParcelPanel } from './ParcelPanel';
import { DownloadCentre, type DownloadRequest } from './DownloadCentre';
import { Badge, Button, Checkbox, cx, Spinner } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/Toast';
import { ApiRequestError } from '@/lib/client/api';
import {
  downloadBundle,
  downloadKmlExport,
  downloadParcelKml,
  fetchLocation,
  fetchLocationMaps,
  formatArea,
  searchLocations,
  type LocationSearchResult,
} from '@/lib/client/mapintel';
import type { LocationNode, LocationSummary, ParcelRecord } from '@/lib/mapintel/types';

const KIND_ICON: Record<string, React.ReactNode> = {
  village: <Trees size={13} />,
  town: <Building2 size={13} />,
  city: <Building2 size={13} />,
};

export function MapIntelWorkspace({ scanId, live }: { scanId: string | null; live: boolean }) {
  const toast = useToast();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<LocationSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [summary, setSummary] = useState<(LocationSummary & { trail: LocationNode[] }) | null>(null);
  const [parcels, setParcels] = useState<ParcelRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedParcelId, setSelectedParcelId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'kml' | 'image-only'>('all');

  // ------------------------------------------------------------- searching
  useEffect(() => {
    if (!scanId || live) return;
    const controller = new AbortController();
    // The debounce timer and the promise are both callbacks, so no state is
    // set during the effect body itself; the spinner appears only once a
    // request is genuinely in flight.
    const timer = setTimeout(() => {
      setSearching(true);
      searchLocations(scanId, query, controller.signal)
        .then((found) => setResults(found))
        .catch((error) => {
          if (controller.signal.aborted) return;
          if (error instanceof ApiRequestError && error.status === 404) return;
          setResults({ locations: [], parcels: [], total: 0 });
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 160);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [scanId, query, live]);

  // ------------------------------------------------------------- selection
  const openLocation = useCallback(
    async (id: string) => {
      if (!scanId) return;
      setLoading(true);
      setLocationId(id);
      setSelectedParcelId(null);
      try {
        const [detail, maps] = await Promise.all([fetchLocation(scanId, id), fetchLocationMaps(scanId, id)]);
        setSummary(detail);
        setParcels(maps.parcels);
      } catch (error) {
        toast.show(
          error instanceof ApiRequestError ? error.message : 'That location could not be opened.',
          'error',
        );
        setSummary(null);
        setParcels([]);
      } finally {
        setLoading(false);
      }
    },
    [scanId, toast],
  );

  const visibleParcels = useMemo(() => {
    if (filter === 'kml') return parcels.filter((parcel) => parcel.kmlAvailable);
    if (filter === 'image-only') return parcels.filter((parcel) => !parcel.kmlAvailable);
    return parcels;
  }, [filter, parcels]);

  const selectedParcel = useMemo(
    () => parcels.find((parcel) => parcel.id === selectedParcelId) ?? null,
    [parcels, selectedParcelId],
  );

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // ------------------------------------------------------------- downloads
  const handleParcelKml = useCallback(
    async (parcel: ParcelRecord) => {
      if (!scanId) return;
      setBusy('parcel-kml');
      try {
        const filename = await downloadParcelKml(scanId, parcel.id);
        toast.show('KML downloaded', 'success', filename);
      } catch (error) {
        toast.show(
          error instanceof ApiRequestError ? error.message : 'The KML could not be produced.',
          'error',
          error instanceof ApiRequestError ? (error.detail ?? undefined) : undefined,
        );
      } finally {
        setBusy(null);
      }
    },
    [scanId, toast],
  );

  const handleKmlExport = useCallback(
    async (mode: 'combined' | 'individual') => {
      if (!scanId) return;
      setBusy(`kml-${mode}`);
      setProgress(`Preparing ${mode === 'combined' ? 'a combined KML' : 'one KML per land record'}…`);
      try {
        const ids = selectedIds.size > 0 ? [...selectedIds] : visibleParcels.map((parcel) => parcel.id);
        const outcome = await downloadKmlExport(scanId, { parcelIds: ids, mode });
        setProgress(
          outcome.skipped > 0
            ? `${outcome.filename} — ${outcome.skipped} record(s) had no usable geometry and were listed, not exported.`
            : `${outcome.filename} — complete.`,
        );
        toast.show('KML export ready', 'success', outcome.filename);
      } catch (error) {
        setProgress(null);
        toast.show(
          error instanceof ApiRequestError ? error.message : 'The export failed.',
          'error',
          error instanceof ApiRequestError ? (error.detail ?? undefined) : undefined,
        );
      } finally {
        setBusy(null);
      }
    },
    [scanId, selectedIds, toast, visibleParcels],
  );

  const handleBundle = useCallback(
    async (request: DownloadRequest) => {
      if (!scanId) return;
      setBusy('bundle');
      setProgress('Preparing download… images are fetched one at a time, so this can take a while.');
      try {
        const ids = selectedIds.size > 0 ? [...selectedIds] : visibleParcels.map((parcel) => parcel.id);
        const filename = await downloadBundle(scanId, {
          parcelIds: ids,
          ...request,
          acknowledged: true,
        });
        setProgress(`${filename} — complete. Check metadata.json for anything that was skipped.`);
        toast.show('Download ready', 'success', filename);
      } catch (error) {
        setProgress(null);
        toast.show(
          error instanceof ApiRequestError ? error.message : 'The download failed.',
          'error',
          error instanceof ApiRequestError ? (error.detail ?? undefined) : undefined,
        );
      } finally {
        setBusy(null);
      }
    },
    [scanId, selectedIds, toast, visibleParcels],
  );

  // ------------------------------------------------------------------ view
  if (!scanId) {
    return (
      <Placeholder
        title="Scan a website first"
        body="This module reads the locations, maps and land parcels out of a completed scan. Run a scan on the Website Scanner tab, then come back."
      />
    );
  }
  if (live) {
    return (
      <Placeholder
        title="Scan in progress"
        body="Locations and land records are derived once the scan finishes, so that counts reflect everything that was found rather than a moving total."
        spinner
      />
    );
  }

  return (
    <div className="space-y-4">
      <AccuracyNotice />

      <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
        {/* ---------------------------------------------- location picker */}
        <aside className="space-y-3">
          <section className="surface overflow-hidden">
            <header className="border-b border-[var(--border)] px-3 py-2.5">
              <h2 className="text-[12px] font-semibold">Select location</h2>
              <p className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">
                Discovered from the scanned site — nothing is pre-loaded.
              </p>
            </header>

            <div className="p-2">
              <div className="relative">
                <Search
                  size={14}
                  className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[var(--text-faint)]"
                />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search city, town, village or survey no."
                  aria-label="Search locations and survey references"
                  className="h-9 w-full rounded-lg border border-[var(--border)] bg-[var(--panel-inset)] pr-8 pl-8 text-[12.5px] placeholder:text-[var(--text-faint)] focus:border-[var(--accent)] focus:outline-none"
                />
                {searching ? (
                  <Spinner className="absolute top-1/2 right-2.5 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-faint)]" />
                ) : null}
              </div>
            </div>

            <div className="max-h-[420px] overflow-y-auto px-1.5 pb-2">
              {(results?.locations ?? []).map((node) => (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => void openLocation(node.id)}
                  className={cx(
                    'flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors',
                    node.id === locationId
                      ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                      : 'hover:bg-[var(--panel-inset)]',
                  )}
                >
                  <span className="mt-0.5 shrink-0 text-[var(--text-faint)]">
                    {KIND_ICON[node.kind] ?? <MapPinned size={13} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium">{node.name}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-[var(--text-muted)]">
                      {node.trail && node.trail.length > 1
                        ? node.trail.slice(0, -1).join(' → ')
                        : node.kind !== 'unknown'
                          ? node.kind
                          : 'level not stated by source'}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-[10.5px] text-[var(--text-faint)] tabular-nums">
                    {node.parcelCount}
                  </span>
                </button>
              ))}

              {results && results.locations.length === 0 ? (
                <p className="px-2.5 py-3 text-[12px] text-[var(--text-muted)]">
                  {query
                    ? 'No location matched. Try a survey number, or a different spelling.'
                    : 'The scan did not expose a location hierarchy. Land records may still be listed under the site itself.'}
                </p>
              ) : null}
            </div>
          </section>

          {results && results.parcels.length > 0 ? (
            <section className="surface overflow-hidden">
              <header className="border-b border-[var(--border)] px-3 py-2">
                <h2 className="text-[11px] font-semibold">
                  Matching land records ({results.parcels.length})
                </h2>
              </header>
              <ul className="max-h-56 overflow-y-auto p-1.5">
                {results.parcels.map((parcel) => (
                  <li key={parcel.id}>
                    <button
                      type="button"
                      onClick={() => {
                        if (parcel.locationId) void openLocation(parcel.locationId);
                        setSelectedParcelId(parcel.id);
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-[var(--panel-inset)]"
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
                        {parcel.reference ?? parcel.name}
                      </span>
                      {parcel.kmlAvailable ? (
                        <Badge tone="positive">KML</Badge>
                      ) : (
                        <Badge tone="warning">image</Badge>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </aside>

        {/* --------------------------------------------------- main column */}
        <div className="min-w-0 space-y-4">
          {loading ? (
            <Placeholder title="Loading location…" body="Reading the discovered land records." spinner />
          ) : !summary ? (
            <Placeholder
              title="Select a city, town or village"
              body="Pick a location on the left to see the maps, land records and geographic data the scan discovered for it."
            />
          ) : (
            <>
              <LocationDashboard summary={summary} />

              <section className="surface overflow-hidden">
                <header className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-3 py-2.5">
                  <Layers size={14} className="text-[var(--text-faint)]" />
                  <h2 className="text-[12.5px] font-semibold">Interactive map</h2>
                  <div className="ml-auto flex items-center gap-1">
                    {(['all', 'kml', 'image-only'] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setFilter(value)}
                        className={cx(
                          'rounded-md px-2 py-1 text-[11.5px] transition-colors',
                          filter === value
                            ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                            : 'text-[var(--text-muted)] hover:bg-[var(--panel-inset)]',
                        )}
                      >
                        {value === 'all' ? 'All' : value === 'kml' ? 'KML available' : 'Image only'}
                      </button>
                    ))}
                  </div>
                </header>

                <div className="p-3">
                  <MapCanvas
                    parcels={visibleParcels}
                    overlays={summary.overlays}
                    selectedId={selectedParcelId}
                    onSelect={setSelectedParcelId}
                    bbox={summary.bbox}
                    className="h-[420px] w-full"
                  />
                </div>
              </section>

              <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
                <ParcelList
                  parcels={visibleParcels}
                  selectedIds={selectedIds}
                  activeId={selectedParcelId}
                  onActivate={setSelectedParcelId}
                  onToggle={toggleSelect}
                  onBulk={(mode) => {
                    setSelectedIds((previous) => {
                      if (mode === 'clear') return new Set();
                      const next = new Set(previous);
                      const pool =
                        mode === 'all'
                          ? visibleParcels
                          : mode === 'kml'
                            ? visibleParcels.filter((parcel) => parcel.kmlAvailable)
                            : visibleParcels.filter((parcel) => parcel.images.length > 0);
                      for (const parcel of pool) next.add(parcel.id);
                      return next;
                    });
                  }}
                />

                {selectedParcel ? (
                  <ParcelPanel
                    parcel={selectedParcel}
                    scanId={scanId}
                    selected={selectedIds.has(selectedParcel.id)}
                    onToggleSelect={() => toggleSelect(selectedParcel.id)}
                    onDownloadKml={() => void handleParcelKml(selectedParcel)}
                    busy={busy === 'parcel-kml'}
                  />
                ) : (
                  <aside className="surface flex min-h-[220px] items-center justify-center px-6 text-center">
                    <p className="text-[12.5px] text-[var(--text-muted)]">
                      Select a land record on the map or in the list to inspect it.
                    </p>
                  </aside>
                )}
              </div>

              <DownloadCentre
                locationName={summary.location.name}
                parcels={visibleParcels}
                selectedIds={selectedIds}
                onDownloadBundle={handleBundle}
                onDownloadKml={(mode) => void handleKmlExport(mode)}
                busy={busy}
                progress={progress}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function LocationDashboard({ summary }: { summary: LocationSummary & { trail: LocationNode[] } }) {
  const { counts, location, trail } = summary;
  return (
    <section className="surface-raised overflow-hidden">
      <header className="border-b border-[var(--border)] px-4 py-3">
        <nav className="flex flex-wrap items-center gap-1 text-[11.5px] text-[var(--text-muted)]">
          {trail.map((node, index) => (
            <span key={node.id} className="flex items-center gap-1">
              {index > 0 ? <ChevronRight size={11} className="opacity-50" /> : null}
              <span className={index === trail.length - 1 ? 'text-[var(--text)]' : undefined}>{node.name}</span>
            </span>
          ))}
        </nav>
        <h2 className="mt-1 text-[18px] leading-tight font-semibold tracking-[-0.01em]">
          {location.name}
        </h2>
        <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-[var(--text-muted)]">
          {location.kind !== 'unknown' ? (
            <Badge>{location.kind}</Badge>
          ) : (
            <span>Administrative level not stated by the source</span>
          )}
          <span>· identified from {location.evidence.join(', ').replace(/-/g, ' ')}</span>
        </p>
      </header>

      <dl className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 lg:grid-cols-6">
        <Figure label="Maps available" value={counts.maps} />
        <Figure label="Land records" value={counts.parcels} />
        <Figure label="Map images" value={counts.images} />
        <Figure label="KML available" value={counts.kmlAvailable} tone="accent" />
        <Figure label="Image only" value={counts.imageOnly} tone={counts.imageOnly > 0 ? 'warning' : 'neutral'} />
        <Figure label="Other documents" value={counts.otherDocuments} />
      </dl>

      {summary.children.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-[var(--border)] px-4 py-2.5">
          <span className="text-[11px] text-[var(--text-faint)]">Within this location:</span>
          {summary.children.slice(0, 12).map((child) => (
            <Badge key={child.id}>
              {child.name} · {child.parcelCount}
            </Badge>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function Figure({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: number;
  tone?: 'neutral' | 'accent' | 'warning';
}) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-inset)] px-3 py-2.5">
      <dt className="text-[10px] font-semibold tracking-[0.08em] text-[var(--text-faint)] uppercase">
        {label}
      </dt>
      <dd
        className={cx(
          'mt-1 font-mono text-lg leading-none font-semibold tabular-nums',
          tone === 'accent' ? 'text-[var(--accent)]' : tone === 'warning' ? 'text-[var(--warning)]' : '',
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function ParcelList({
  parcels,
  selectedIds,
  activeId,
  onActivate,
  onToggle,
  onBulk,
}: {
  parcels: ParcelRecord[];
  selectedIds: ReadonlySet<string>;
  activeId: string | null;
  onActivate: (id: string) => void;
  onToggle: (id: string) => void;
  onBulk: (mode: 'all' | 'kml' | 'images' | 'clear') => void;
}) {
  return (
    <section className="surface overflow-hidden">
      <header className="flex flex-wrap items-center gap-1.5 border-b border-[var(--border)] px-3 py-2.5">
        <h2 className="mr-auto text-[12.5px] font-semibold">
          Land records <span className="font-mono text-[11px] text-[var(--text-faint)]">({parcels.length})</span>
        </h2>
        <Button size="sm" variant="ghost" onClick={() => onBulk('all')}>
          Select all
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onBulk('kml')}>
          Select KML-ready
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onBulk('clear')}>
          Clear
        </Button>
      </header>

      <ul className="max-h-[520px] overflow-y-auto">
        {parcels.map((parcel) => (
          <li key={parcel.id}>
            <div
              className={cx(
                'flex items-center gap-2 border-b border-[var(--border)] px-2.5 py-2 transition-colors last:border-b-0',
                parcel.id === activeId ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--panel-inset)]',
              )}
            >
              <span onClick={(event) => event.stopPropagation()}>
                <Checkbox checked={selectedIds.has(parcel.id)} onChange={() => onToggle(parcel.id)} label="" />
              </span>
              <button type="button" onClick={() => onActivate(parcel.id)} className="min-w-0 flex-1 text-left">
                <span className="block truncate font-mono text-[12.5px] font-medium">
                  {parcel.reference ?? parcel.name}
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-[var(--text-muted)]">
                  {parcel.folderPath.length > 0 ? parcel.folderPath.join(' → ') : parcel.name}
                  {parcel.areaSquareMetres !== null ? ` · ${formatArea(parcel.areaSquareMetres)}` : ''}
                </span>
              </button>
              {parcel.kmlAvailable ? <Badge tone="positive">KML</Badge> : <Badge tone="warning">image</Badge>}
            </div>
          </li>
        ))}
        {parcels.length === 0 ? (
          <li className="px-3 py-6 text-center text-[12.5px] text-[var(--text-muted)]">
            No land records match this filter.
          </li>
        ) : null}
      </ul>
    </section>
  );
}

function AccuracyNotice() {
  return (
    <p className="flex items-start gap-2 rounded-xl border border-[var(--warning)]/30 bg-[var(--warning-soft)] px-3.5 py-2.5 text-[12px] leading-relaxed text-[var(--warning)]">
      <ShieldAlert size={14} className="mt-0.5 shrink-0" />
      <span>
        Map imagery and geographic boundaries are presented according to the source data available
        through the website. The extracted data should not be treated as a legal land-survey
        document unless the authoritative source explicitly establishes that status.
      </span>
    </p>
  );
}

function Placeholder({ title, body, spinner }: { title: string; body: string; spinner?: boolean }) {
  return (
    <div className="surface flex min-h-[320px] flex-col items-center justify-center px-6 py-16 text-center">
      {spinner ? (
        <Spinner className="h-6 w-6 text-[var(--accent)]" />
      ) : (
        <MapPinned size={24} className="text-[var(--text-faint)]" />
      )}
      <h2 className="mt-3 text-[16px] font-semibold">{title}</h2>
      <p className="mt-1.5 max-w-md text-[13px] leading-relaxed text-[var(--text-muted)]">{body}</p>
    </div>
  );
}
