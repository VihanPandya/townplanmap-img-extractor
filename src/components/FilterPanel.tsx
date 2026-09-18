'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, RotateCcw } from 'lucide-react';
import { Button, Checkbox, cx, Toggle } from '@/components/ui/primitives';
import {
  buildFacets,
  categoryLabel,
  EMPTY_FILTERS,
  filtersAreActive,
  orientationLabel,
  sizeLabel,
  statusLabel,
  type FilterState,
} from '@/lib/client/filters';
import type { DiscoveredImage, ImageCategory, ImageStatus, Orientation, SizeBucket } from '@/lib/types';

function Section({
  title,
  count,
  children,
  defaultOpen = true,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-[var(--border)] last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left transition-colors hover:bg-[var(--panel-inset)]"
      >
        <span className="text-[11px] font-semibold tracking-[0.08em] text-[var(--text-muted)] uppercase">
          {title}
        </span>
        <span className="flex items-center gap-1.5">
          {count ? (
            <span className="font-mono text-[10px] text-[var(--text-faint)] tabular-nums">{count}</span>
          ) : null}
          <ChevronDown
            size={14}
            className={cx('text-[var(--text-faint)] transition-transform', open && 'rotate-180')}
          />
        </span>
      </button>
      {open ? <div className="px-1.5 pb-2.5">{children}</div> : null}
    </div>
  );
}

export function FilterPanel({
  images,
  filters,
  onChange,
  categoryOverrides,
  className,
}: {
  images: DiscoveredImage[];
  filters: FilterState;
  onChange: (next: FilterState) => void;
  categoryOverrides: Record<string, ImageCategory>;
  className?: string;
}) {
  const facets = useMemo(() => buildFacets(images, categoryOverrides), [images, categoryOverrides]);
  const [pageQuery, setPageQuery] = useState('');

  const toggle = <T extends string>(key: keyof FilterState, value: T) => {
    const current = filters[key] as unknown as T[];
    const next = current.includes(value)
      ? current.filter((entry) => entry !== value)
      : [...current, value];
    onChange({ ...filters, [key]: next } as FilterState);
  };

  const visiblePages = useMemo(() => {
    const query = pageQuery.trim().toLowerCase();
    const list = query
      ? facets.pages.filter(
          (page) => page.label.toLowerCase().includes(query) || page.value.toLowerCase().includes(query),
        )
      : facets.pages;
    return list.slice(0, 40);
  }, [facets.pages, pageQuery]);

  const active = filtersAreActive(filters);

  return (
    <div className={cx('surface overflow-hidden', className)}>
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2.5">
        <h2 className="text-[12px] font-semibold">Filters</h2>
        {active ? (
          <Button
            size="sm"
            variant="ghost"
            icon={<RotateCcw size={12} />}
            onClick={() => onChange({ ...EMPTY_FILTERS, search: filters.search })}
          >
            Reset
          </Button>
        ) : null}
      </div>

      <Section title="File type" count={facets.types.length}>
        {facets.types.map((facet) => (
          <Checkbox
            key={facet.value}
            checked={filters.types.includes(facet.value)}
            onChange={() => toggle('types', facet.value)}
            label={facet.label}
            count={facet.count}
          />
        ))}
        {facets.types.length === 0 ? <p className="px-2 py-1 text-xs faint">No formats yet.</p> : null}
      </Section>

      <Section title="Dimensions">
        {facets.sizes.map((facet) => (
          <Checkbox
            key={facet.value}
            checked={filters.sizes.includes(facet.value as SizeBucket)}
            onChange={() => toggle('sizes', facet.value as SizeBucket)}
            label={sizeLabel(facet.value as SizeBucket)}
            count={facet.count}
          />
        ))}
      </Section>

      <Section title="Detected category">
        {facets.categories.map((facet) => (
          <Checkbox
            key={facet.value}
            checked={filters.categories.includes(facet.value as ImageCategory)}
            onChange={() => toggle('categories', facet.value as ImageCategory)}
            label={categoryLabel(facet.value as ImageCategory)}
            count={facet.count}
          />
        ))}
      </Section>

      <Section title="Orientation">
        {facets.orientations.map((facet) => (
          <Checkbox
            key={facet.value}
            checked={filters.orientations.includes(facet.value as Orientation)}
            onChange={() => toggle('orientations', facet.value as Orientation)}
            label={orientationLabel(facet.value as Orientation)}
            count={facet.count}
          />
        ))}
      </Section>

      <Section title="Status">
        {facets.statuses.map((facet) => (
          <Checkbox
            key={facet.value}
            checked={filters.statuses.includes(facet.value as ImageStatus)}
            onChange={() => toggle('statuses', facet.value as ImageStatus)}
            label={statusLabel(facet.value as ImageStatus)}
            count={facet.count}
          />
        ))}
      </Section>

      <Section title="Source page" count={facets.pages.length} defaultOpen={false}>
        <div className="px-2 pb-1.5">
          <input
            value={pageQuery}
            onChange={(event) => setPageQuery(event.target.value)}
            placeholder="Find a page…"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--panel-inset)] px-2.5 py-1.5 text-xs placeholder:text-[var(--text-faint)] focus:border-[var(--accent)] focus:outline-none"
          />
        </div>
        <div className="max-h-64 overflow-y-auto">
          {visiblePages.map((page) => (
            <Checkbox
              key={page.value}
              checked={filters.sourcePages.includes(page.value)}
              onChange={() => toggle('sourcePages', page.value)}
              label={<span title={page.value}>{page.label}</span>}
              count={page.count}
            />
          ))}
          {visiblePages.length === 0 ? (
            <p className="px-2 py-1 text-xs faint">No pages match that text.</p>
          ) : null}
        </div>
      </Section>

      <Section title="Refine">
        <div className="space-y-1 px-2">
          <Toggle
            checked={filters.showDuplicates}
            onChange={(value) => onChange({ ...filters, showDuplicates: value })}
            label="Show duplicates"
            description={`${facets.duplicates} byte-identical copies detected`}
          />
          <Toggle
            checked={filters.showBelowMinimum}
            onChange={(value) => onChange({ ...filters, showBelowMinimum: value })}
            label="Show assets below minimum size"
            description={`${facets.belowMinimum} hidden by the scan's minimum dimensions`}
          />
          <Toggle
            checked={filters.onlySelected}
            onChange={(value) => onChange({ ...filters, onlySelected: value })}
            label="Only selected images"
          />
        </div>
      </Section>
    </div>
  );
}
