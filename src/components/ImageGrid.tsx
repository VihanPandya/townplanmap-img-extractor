'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ImageCard } from '@/components/ImageCard';
import type { ViewMode } from '@/lib/client/filters';
import type { DiscoveredImage, ImageCategory } from '@/lib/types';

/**
 * A windowed grid.
 *
 * Only the rows intersecting the viewport (plus a small overscan) are mounted,
 * so a scan returning several thousand references still scrolls smoothly and
 * only the visible previews are ever requested from the network.
 */

interface Metrics {
  columns: number;
  rowHeight: number;
  gap: number;
}

const MIN_COLUMN_WIDTH: Record<ViewMode, number> = { grid: 232, compact: 150, list: 0 };
const ROW_HEIGHT: Record<ViewMode, (columnWidth: number) => number> = {
  // 4:3 preview + metadata block
  grid: (width) => Math.round(width * 0.75) + 96,
  // square preview + condensed metadata
  compact: (width) => Math.round(width) + 54,
  list: () => 62,
};
const GAP: Record<ViewMode, number> = { grid: 14, compact: 10, list: 6 };
const OVERSCAN_ROWS = 3;

export function ImageGrid({
  images,
  scanId,
  view,
  selectedIds,
  categoryOverrides,
  onToggleSelect,
  onOpen,
  onCopyUrl,
}: {
  images: DiscoveredImage[];
  scanId: string;
  view: ViewMode;
  selectedIds: ReadonlySet<string>;
  categoryOverrides: Record<string, ImageCategory>;
  onToggleSelect: (id: string, shiftKey: boolean) => void;
  onOpen: (image: DiscoveredImage) => void;
  onCopyUrl: (image: DiscoveredImage) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [range, setRange] = useState({ start: 0, end: 40 });

  // Track the container width so the column count follows the layout, not a
  // breakpoint guess.
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    setWidth(element.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  const metrics: Metrics = useMemo(() => {
    const gap = GAP[view];
    if (view === 'list') return { columns: 1, rowHeight: ROW_HEIGHT.list(0) + gap, gap };
    const usable = Math.max(width, 240);
    const columns = Math.max(1, Math.floor((usable + gap) / (MIN_COLUMN_WIDTH[view] + gap)));
    const columnWidth = (usable - gap * (columns - 1)) / columns;
    return { columns, rowHeight: ROW_HEIGHT[view](columnWidth) + gap, gap };
  }, [view, width]);

  const rowCount = Math.ceil(images.length / metrics.columns);
  const totalHeight = Math.max(0, rowCount * metrics.rowHeight - metrics.gap);

  const recalculate = useCallback(() => {
    const element = containerRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    // Distance the grid has already scrolled past the top of the viewport.
    const scrolledPast = Math.max(0, -rect.top);
    const firstRow = Math.max(0, Math.floor(scrolledPast / metrics.rowHeight) - OVERSCAN_ROWS);
    const visibleRows = Math.ceil(viewportHeight / metrics.rowHeight) + OVERSCAN_ROWS * 2;
    const start = firstRow * metrics.columns;
    const end = Math.min(images.length, (firstRow + visibleRows) * metrics.columns);
    setRange((previous) => (previous.start === start && previous.end === end ? previous : { start, end }));
  }, [images.length, metrics.columns, metrics.rowHeight]);

  useEffect(() => {
    recalculate();
    const onScroll = () => recalculate();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [recalculate]);

  const visible = images.slice(range.start, range.end);
  const topSpacer = Math.floor(range.start / metrics.columns) * metrics.rowHeight;

  return (
    <div ref={containerRef} className="relative w-full" style={{ height: totalHeight }}>
      <div
        style={{
          transform: `translateY(${topSpacer}px)`,
          display: 'grid',
          gridTemplateColumns: `repeat(${metrics.columns}, minmax(0, 1fr))`,
          gap: `${metrics.gap}px`,
          alignContent: 'start',
        }}
      >
        {visible.map((image) => (
          <div key={image.id} style={{ height: metrics.rowHeight - metrics.gap }}>
            <ImageCard
              image={image}
              scanId={scanId}
              view={view}
              selected={selectedIds.has(image.id)}
              categoryOverrides={categoryOverrides}
              onToggleSelect={onToggleSelect}
              onOpen={onOpen}
              onCopyUrl={onCopyUrl}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
