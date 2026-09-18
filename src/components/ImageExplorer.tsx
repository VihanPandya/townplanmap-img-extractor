'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownAZ,
  ArrowUpAZ,
  CircleHelp,
  LayoutGrid,
  List,
  Moon,
  ScanSearch,
  Settings2,
  SlidersHorizontal,
  Sun,
  X,
} from 'lucide-react';
import { EmptyState, GallerySkeleton } from '@/components/EmptyState';
import { ExportMenu } from '@/components/ExportMenu';
import { FilterPanel } from '@/components/FilterPanel';
import { HelpDialog } from '@/components/HelpDialog';
import { ImageGrid } from '@/components/ImageGrid';
import { ImageViewer } from '@/components/ImageViewer';
import { ScanHistory } from '@/components/ScanHistory';
import { ScanProgress } from '@/components/ScanProgress';
import { SearchBar } from '@/components/SearchBar';
import { SelectionToolbar } from '@/components/SelectionToolbar';
import { SettingsDialog } from '@/components/SettingsDialog';
import { UrlInput } from '@/components/UrlInput';
import { Button, cx, IconButton } from '@/components/ui/primitives';
import { ToastProvider, useToast } from '@/components/ui/Toast';
import { ApiRequestError, downloadExport, fetchScanHistory } from '@/lib/client/api';
import {
  applyFilters,
  EMPTY_FILTERS,
  filtersAreActive,
  sortImages,
  type FilterState,
  type SortDirection,
  type SortKey,
  type ViewMode,
} from '@/lib/client/filters';
import { useScanSession } from '@/lib/client/useScanSession';
import { useTheme } from '@/lib/client/useTheme';
import { DEFAULT_SETTINGS, DEFAULT_TARGET_URL } from '@/lib/config';
import type { DiscoveredImage, ExportFormat, ImageCategory, ScanSettings, ScanSummary } from '@/lib/types';

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: 'discovered', label: 'Newest discovered' },
  { value: 'filename', label: 'Filename' },
  { value: 'dimensions', label: 'Dimensions' },
  { value: 'filesize', label: 'File size' },
  { value: 'type', label: 'Image type' },
  { value: 'sourcePage', label: 'Source page' },
  { value: 'category', label: 'Category' },
];

const VIEW_OPTIONS: Array<{ value: ViewMode; label: string; icon: React.ReactNode }> = [
  { value: 'grid', label: 'Grid view', icon: <LayoutGrid size={15} /> },
  { value: 'compact', label: 'Compact grid', icon: <LayoutGrid size={13} /> },
  { value: 'list', label: 'List view', icon: <List size={15} /> },
];

function Explorer() {
  const toast = useToast();
  const { theme, toggle: toggleTheme } = useTheme();
  const session = useScanSession();

  const [url, setUrl] = useState(DEFAULT_TARGET_URL);
  const [settings, setSettings] = useState<ScanSettings>(DEFAULT_SETTINGS);
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [sortKey, setSortKey] = useState<SortKey>('discovered');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [view, setView] = useState<ViewMode>('grid');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [categoryOverrides, setCategoryOverrides] = useState<Record<string, ImageCategory>>({});
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [history, setHistory] = useState<ScanSummary[]>([]);

  const { scan, images, scanId, live, starting, error } = session;

  // ------------------------------------------------------------- history
  // Refetched on mount and whenever the active scan changes identity or
  // settles, so a finished scan appears in the list without extra polling.
  useEffect(() => {
    let cancelled = false;
    fetchScanHistory().then(
      (scans) => {
        if (!cancelled) setHistory(scans);
      },
      () => {
        // History is a convenience; a failure here must not disturb the scan.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [scan?.id, scan?.status]);

  // Surface scan-level errors once, as a toast.
  useEffect(() => {
    if (!error) return;
    toast.show(error.message, 'error', error.detail ?? undefined);
    session.dismissError();
  }, [error, session, toast]);

  // ------------------------------------------------------- derived lists
  const filtered = useMemo(
    () => applyFilters(images, filters, categoryOverrides, selectedIds),
    [images, filters, categoryOverrides, selectedIds],
  );

  const visible = useMemo(
    () => sortImages(filtered, sortKey, sortDirection, categoryOverrides),
    [filtered, sortKey, sortDirection, categoryOverrides],
  );

  const viewerIndex = viewerId ? visible.findIndex((image) => image.id === viewerId) : -1;
  const viewerImage = viewerIndex >= 0 ? visible[viewerIndex]! : null;

  // ------------------------------------------------------------ actions
  const handleScan = useCallback(() => {
    setSelectedIds(new Set());
    setCategoryOverrides({});
    setFilters(EMPTY_FILTERS);
    setViewerId(null);
    void session.start(url, settings);
  }, [session, settings, url]);

  const copy = useCallback(
    async (text: string, what: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast.show(`${what} copied`, 'success');
      } catch {
        toast.show(`${what} could not be copied to the clipboard.`, 'error');
      }
    },
    [toast],
  );

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAllVisible = useCallback(() => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      const allSelected = visible.every((image) => next.has(image.id));
      for (const image of visible) {
        if (allSelected) next.delete(image.id);
        else next.add(image.id);
      }
      return next;
    });
  }, [visible]);

  const handleExport = useCallback(
    async (format: ExportFormat) => {
      if (!scanId) return;
      setExporting(true);
      try {
        const ids = selectedIds.size > 0 ? [...selectedIds] : visible.map((image) => image.id);
        const filename = await downloadExport(scanId, format, ids, categoryOverrides);
        toast.show(`Exported ${ids.length} record${ids.length === 1 ? '' : 's'}`, 'success', filename);
      } catch (cause) {
        toast.show(
          cause instanceof ApiRequestError ? cause.message : 'The export could not be produced.',
          'error',
        );
      } finally {
        setExporting(false);
      }
    },
    [categoryOverrides, scanId, selectedIds, toast, visible],
  );

  const openSelected = useCallback(() => {
    const chosen = images.filter((image) => selectedIds.has(image.id)).slice(0, 12);
    if (chosen.length < selectedIds.size) {
      toast.show('Opening the first 12 selected images', 'info', 'Browsers block large numbers of pop-ups.');
    }
    for (const image of chosen) window.open(image.url, '_blank', 'noopener,noreferrer');
  }, [images, selectedIds, toast]);

  const setOverride = useCallback((id: string, category: ImageCategory | null) => {
    setCategoryOverrides((previous) => {
      const next = { ...previous };
      if (category === null) delete next[id];
      else next[id] = category;
      return next;
    });
  }, []);

  const hiddenBelowMinimum = useMemo(
    () => (filters.showBelowMinimum ? 0 : images.filter((image) => image.belowMinimumSize).length),
    [images, filters.showBelowMinimum],
  );

  const hasScan = Boolean(scan);
  const showSkeleton = (starting || (live && images.length === 0)) && images.length === 0;
  const allVisibleSelected = visible.length > 0 && visible.every((image) => selectedIds.has(image.id));

  return (
    <div className="min-h-screen">
      {/* ------------------------------------------------------- header */}
      <header className="sticky top-0 z-30 border-b border-[var(--border)] bg-[var(--canvas)]/88 backdrop-blur-md">
        <div className="mx-auto max-w-[1600px] px-4 py-3 sm:px-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--accent)] text-[var(--accent-contrast)]">
                <ScanSearch size={18} />
              </span>
              <div className="min-w-0">
                <h1 className="truncate text-[15px] leading-tight font-semibold tracking-[-0.01em]">
                  TownPlanMap Image Explorer
                </h1>
                <p className="hidden truncate text-[12.5px] text-[var(--text-muted)] sm:block">
                  Discover, inspect and organise publicly available images from townplanmap.com.
                </p>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-0.5">
              <IconButton label="Crawl settings" onClick={() => setSettingsOpen(true)}>
                <Settings2 size={16} />
              </IconButton>
              <IconButton label="About this tool" onClick={() => setHelpOpen(true)}>
                <CircleHelp size={16} />
              </IconButton>
              <IconButton
                label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                onClick={toggleTheme}
              >
                {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
              </IconButton>
            </div>
          </div>

          <div className="mt-3">
            <UrlInput
              value={url}
              onChange={setUrl}
              onSubmit={handleScan}
              onStop={() => void session.stop()}
              busy={live}
              disabled={starting && !live}
            />
          </div>
        </div>
      </header>

      {/* --------------------------------------------------------- body */}
      <main className="mx-auto max-w-[1600px] px-4 pb-28 sm:px-6">
        {scan ? (
          <div className="pt-4">
            <ScanProgress
              scan={scan}
              onPause={() => void session.pause()}
              onResume={() => void session.resume()}
              onStop={() => void session.stop()}
            />
          </div>
        ) : null}

        {!hasScan && !starting ? (
          <>
            <EmptyState kind="idle" onPrimary={handleScan} primaryLabel="Start scan" />
            {history.length > 0 ? (
              <div className="mx-auto max-w-md pb-10">
                <ScanHistory scans={history} activeId={scanId} onOpen={(id) => void session.open(id)} />
              </div>
            ) : null}
          </>
        ) : (
          <div className="mt-4 grid gap-4 lg:grid-cols-[264px_minmax(0,1fr)]">
            {/* --------------------------------------------- sidebar */}
            <aside
              className={cx(
                'space-y-3 lg:sticky lg:top-[136px] lg:self-start',
                filtersOpen
                  ? 'fixed inset-0 z-40 overflow-y-auto bg-[var(--canvas)] p-4 lg:static lg:z-auto lg:bg-transparent lg:p-0'
                  : 'hidden lg:block',
              )}
            >
              {filtersOpen ? (
                <div className="mb-2 flex items-center justify-between lg:hidden">
                  <h2 className="text-sm font-semibold">Filters</h2>
                  <IconButton label="Close filters" onClick={() => setFiltersOpen(false)}>
                    <X size={16} />
                  </IconButton>
                </div>
              ) : null}

              <FilterPanel
                images={images}
                filters={filters}
                onChange={setFilters}
                categoryOverrides={categoryOverrides}
              />
              <ScanHistory scans={history} activeId={scanId} onOpen={(id) => void session.open(id)} />

              {filtersOpen ? (
                <Button
                  variant="primary"
                  className="w-full lg:hidden"
                  onClick={() => setFiltersOpen(false)}
                >
                  Show {visible.length} result{visible.length === 1 ? '' : 's'}
                </Button>
              ) : null}
            </aside>

            {/* ----------------------------------------------- gallery */}
            <section className="min-w-0">
              <div className="surface sticky top-[132px] z-20 mb-3 flex flex-wrap items-center gap-2 p-2">
                <Button
                  size="sm"
                  variant={filtersAreActive(filters) ? 'primary' : 'secondary'}
                  className="lg:hidden"
                  icon={<SlidersHorizontal size={13} />}
                  onClick={() => setFiltersOpen(true)}
                >
                  Filters
                </Button>

                <SearchBar
                  value={filters.search}
                  onChange={(search) => setFilters((previous) => ({ ...previous, search }))}
                  resultCount={visible.length}
                  totalCount={images.length}
                  className="min-w-[180px]"
                />

                <div className="flex items-center gap-1">
                  <label className="sr-only" htmlFor="sort-key">
                    Sort by
                  </label>
                  <select
                    id="sort-key"
                    value={sortKey}
                    onChange={(event) => setSortKey(event.target.value as SortKey)}
                    className="h-9 rounded-xl border border-[var(--border)] bg-[var(--panel-inset)] px-2.5 text-[12.5px] hover:border-[var(--border-strong)] focus:border-[var(--accent)] focus:outline-none"
                  >
                    {SORT_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <IconButton
                    label={sortDirection === 'asc' ? 'Sort ascending' : 'Sort descending'}
                    onClick={() => setSortDirection((previous) => (previous === 'asc' ? 'desc' : 'asc'))}
                  >
                    {sortDirection === 'asc' ? <ArrowUpAZ size={15} /> : <ArrowDownAZ size={15} />}
                  </IconButton>
                </div>

                <div className="flex items-center gap-0.5 rounded-xl border border-[var(--border)] p-0.5">
                  {VIEW_OPTIONS.map((option) => (
                    <IconButton
                      key={option.value}
                      label={option.label}
                      active={view === option.value}
                      className="h-8 w-8"
                      onClick={() => setView(option.value)}
                    >
                      {option.icon}
                    </IconButton>
                  ))}
                </div>

                <Button size="sm" variant="ghost" onClick={selectAllVisible} disabled={visible.length === 0}>
                  {allVisibleSelected ? 'Deselect all' : 'Select all'}
                </Button>

                <ExportMenu onExport={handleExport} busy={exporting} disabled={images.length === 0} size="sm" />
              </div>

              {showSkeleton ? (
                <GallerySkeleton />
              ) : scan?.status === 'failed' && images.length === 0 ? (
                <EmptyState
                  kind="error"
                  detail={scan.error ?? undefined}
                  onPrimary={handleScan}
                  primaryLabel="Try again"
                />
              ) : images.length === 0 && !live ? (
                <EmptyState kind="no-results" onPrimary={handleScan} primaryLabel="Scan again" />
              ) : visible.length === 0 ? (
                <EmptyState
                  kind="no-matches"
                  onPrimary={() => setFilters({ ...EMPTY_FILTERS })}
                  primaryLabel="Clear filters"
                />
              ) : (
                <>
                  <p className="mb-2 text-[12px] text-[var(--text-muted)]">
                    <span className="font-mono tabular-nums">{visible.length}</span> of{' '}
                    <span className="font-mono tabular-nums">{images.length}</span> unique image
                    {images.length === 1 ? '' : 's'}
                    {filters.search.trim() ? ` matching “${filters.search.trim()}”` : ''}
                    {live ? ' · still scanning…' : ''}
                    {hiddenBelowMinimum > 0 ? (
                      <>
                        {' · '}
                        <button
                          type="button"
                          onClick={() => setFilters((previous) => ({ ...previous, showBelowMinimum: true }))}
                          className="text-[var(--accent)] hover:underline"
                        >
                          {hiddenBelowMinimum} below the minimum size — show
                        </button>
                      </>
                    ) : null}
                  </p>
                  <ImageGrid
                    images={visible}
                    scanId={scanId ?? ''}
                    view={view}
                    selectedIds={selectedIds}
                    categoryOverrides={categoryOverrides}
                    onToggleSelect={toggleSelect}
                    onOpen={(image: DiscoveredImage) => setViewerId(image.id)}
                    onCopyUrl={(image: DiscoveredImage) => void copy(image.url, 'Image URL')}
                  />
                </>
              )}
            </section>
          </div>
        )}
      </main>

      <SelectionToolbar
        count={selectedIds.size}
        exporting={exporting}
        onCopyUrls={() =>
          void copy(
            images
              .filter((image) => selectedIds.has(image.id))
              .map((image) => image.url)
              .join('\n'),
            `${selectedIds.size} image URL${selectedIds.size === 1 ? '' : 's'}`,
          )
        }
        onOpenSelected={openSelected}
        onExport={handleExport}
        onClear={() => setSelectedIds(new Set())}
      />

      <ImageViewer
        image={viewerImage}
        scanId={scanId ?? ''}
        open={viewerImage !== null}
        onClose={() => setViewerId(null)}
        onNext={() => {
          const next = visible[viewerIndex + 1];
          if (next) setViewerId(next.id);
        }}
        onPrevious={() => {
          const previous = visible[viewerIndex - 1];
          if (previous) setViewerId(previous.id);
        }}
        hasNext={viewerIndex >= 0 && viewerIndex < visible.length - 1}
        hasPrevious={viewerIndex > 0}
        selected={viewerImage ? selectedIds.has(viewerImage.id) : false}
        onToggleSelect={toggleSelect}
        categoryOverrides={categoryOverrides}
        onOverrideCategory={setOverride}
        onCopy={(text, what) => void copy(text, what)}
        position={viewerIndex + 1}
        total={visible.length}
      />

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onApply={setSettings}
        locked={live}
      />
      <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />

      <footer className="border-t border-[var(--border)] px-4 py-5 text-center text-[11.5px] leading-relaxed text-[var(--text-faint)] sm:px-6">
        Only publicly accessible content is requested. The scanner respects robots.txt, does not execute
        page JavaScript and never attempts to bypass authentication, paywalls or access controls.
        <br />
        Exports contain references and metadata only — rights to the images remain with their owners.
      </footer>
    </div>
  );
}

export default function ImageExplorer() {
  return (
    <ToastProvider>
      <Explorer />
    </ToastProvider>
  );
}
