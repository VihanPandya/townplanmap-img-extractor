'use client';

import { memo } from 'react';
import { Copy, Files, Layers, Link2Off, ShieldCheck } from 'lucide-react';
import { ImagePreview } from '@/components/ImagePreview';
import { Badge, Checkbox, cx } from '@/components/ui/primitives';
import { categoryLabel, discoveryLabel, effectiveCategory, formatKey } from '@/lib/client/filters';
import type { DiscoveredImage, ImageCategory } from '@/lib/types';
import { formatBytes } from '@/lib/utils/text';

export interface ImageCardProps {
  image: DiscoveredImage;
  scanId: string;
  selected: boolean;
  categoryOverrides: Record<string, ImageCategory>;
  onToggleSelect: (id: string, shiftKey: boolean) => void;
  onOpen: (image: DiscoveredImage) => void;
  onCopyUrl: (image: DiscoveredImage) => void;
  view: 'grid' | 'compact' | 'list';
}

function dimensionText(image: DiscoveredImage): string {
  if (image.width && image.height) return `${image.width} × ${image.height}`;
  const declared = image.references.find((reference) => reference.declaredWidth && reference.declaredHeight);
  if (declared?.declaredWidth && declared.declaredHeight) {
    return `${declared.declaredWidth} × ${declared.declaredHeight} (declared)`;
  }
  return 'Size unknown';
}

function StatusDot({ image }: { image: DiscoveredImage }) {
  const map: Record<string, { tone: string; label: string }> = {
    available: { tone: 'bg-[var(--positive)]', label: 'Verified as publicly accessible' },
    redirected: { tone: 'bg-[var(--warning)]', label: 'Redirected to another URL' },
    duplicate: { tone: 'bg-[var(--accent)]', label: 'Identical bytes to another asset' },
    unavailable: { tone: 'bg-[var(--danger)]', label: image.statusMessage ?? 'Could not be retrieved' },
    unsupported: { tone: 'bg-[var(--danger)]', label: 'Not a readable image format' },
    unverified: { tone: 'bg-[var(--text-faint)]', label: 'Reference found, not verified' },
  };
  const entry = map[image.status] ?? map['unverified']!;
  return <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', entry.tone)} title={entry.label} />;
}

export const ImageCard = memo(function ImageCard({
  image,
  scanId,
  selected,
  categoryOverrides,
  onToggleSelect,
  onOpen,
  onCopyUrl,
  view,
}: ImageCardProps) {
  const category = effectiveCategory(image, categoryOverrides);
  const format = formatKey(image).toUpperCase();

  if (view === 'list') {
    return (
      <div
        className={cx(
          'group flex items-center gap-3 rounded-xl border px-2.5 py-2 transition-colors duration-150',
          selected
            ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
            : 'border-[var(--border)] bg-[var(--panel)] hover:border-[var(--border-strong)]',
        )}
      >
        <span onClick={(event) => event.stopPropagation()}>
          <Checkbox checked={selected} onChange={() => onToggleSelect(image.id, false)} label="" />
        </span>
        <button
          type="button"
          onClick={() => onOpen(image)}
          className="h-11 w-11 shrink-0 overflow-hidden rounded-lg border border-[var(--border)]"
          aria-label={`Inspect ${image.filename}`}
        >
          <ImagePreview image={image} scanId={scanId} className="h-full w-full" />
        </button>
        <button
          type="button"
          onClick={() => onOpen(image)}
          className="min-w-0 flex-1 text-left"
        >
          <span className="flex items-center gap-1.5">
            <StatusDot image={image} />
            <span className="truncate text-[13px] font-medium">{image.filename}</span>
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-[var(--text-muted)]">
            {image.sourcePageLabel}
          </span>
        </button>
        <span className="hidden shrink-0 font-mono text-[11px] text-[var(--text-muted)] tabular-nums sm:block">
          {dimensionText(image)}
        </span>
        <Badge className="hidden shrink-0 md:inline-flex">{format}</Badge>
        <Badge tone={category === 'map' ? 'accent' : 'neutral'} className="hidden shrink-0 lg:inline-flex">
          {categoryLabel(category)}
        </Badge>
        <button
          type="button"
          onClick={() => onCopyUrl(image)}
          className="shrink-0 rounded-lg p-1.5 text-[var(--text-faint)] opacity-0 transition hover:bg-[var(--panel-inset)] hover:text-[var(--text)] group-hover:opacity-100 focus-visible:opacity-100"
          aria-label={`Copy URL for ${image.filename}`}
        >
          <Copy size={14} />
        </button>
      </div>
    );
  }

  const compact = view === 'compact';

  return (
    <div
      className={cx(
        'group relative flex h-full flex-col overflow-hidden rounded-xl border bg-[var(--panel)] transition-[border-color,box-shadow,transform] duration-150',
        selected
          ? 'border-[var(--accent)] shadow-[0_0_0_1px_var(--accent)]'
          : 'border-[var(--border)] hover:border-[var(--border-strong)] hover:shadow-[var(--shadow-card)]',
      )}
    >
      <button
        type="button"
        onClick={() => onOpen(image)}
        className={cx('relative block w-full overflow-hidden', compact ? 'aspect-square' : 'aspect-[4/3]')}
        aria-label={`Inspect ${image.filename}`}
      >
        <ImagePreview image={image} scanId={scanId} className="h-full w-full" />

        <span className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-1 p-1.5">
          <span className="flex flex-wrap gap-1">
            {image.isDuplicate ? (
              <Badge tone="accent" title="Identical bytes to an earlier asset">
                <Files size={9} /> dup
              </Badge>
            ) : null}
            {image.pageCount > 1 ? (
              <Badge title={`Referenced on ${image.pageCount} pages`}>
                <Layers size={9} /> {image.pageCount}
              </Badge>
            ) : null}
          </span>
          <span className="flex gap-1">
            {image.status === 'available' ? (
              <Badge tone="positive" title="Verified as publicly accessible">
                <ShieldCheck size={9} />
              </Badge>
            ) : image.status === 'unavailable' || image.status === 'unsupported' ? (
              <Badge tone="danger" title={image.statusMessage ?? 'Could not be retrieved'}>
                <Link2Off size={9} />
              </Badge>
            ) : null}
          </span>
        </span>
      </button>

      <span
        className="absolute top-1.5 left-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 data-[selected=true]:opacity-100"
        data-selected={selected}
        onClick={(event) => event.stopPropagation()}
      >
        <span className="flex items-center rounded-lg bg-[var(--panel)]/92 p-0.5 backdrop-blur">
          <Checkbox
            checked={selected}
            onChange={() => onToggleSelect(image.id, false)}
            label={<span className="sr-only">{`Select ${image.filename}`}</span>}
          />
        </span>
      </span>

      <div className={cx('flex min-w-0 flex-1 flex-col gap-1 border-t border-[var(--border)]', compact ? 'p-2' : 'p-2.5')}>
        <div className="flex items-center gap-1.5">
          <StatusDot image={image} />
          <span className="truncate text-[12.5px] font-medium" title={image.filename}>
            {image.filename}
          </span>
        </div>

        <div className="flex items-center gap-1.5 font-mono text-[11px] text-[var(--text-muted)] tabular-nums">
          <span className="truncate">{dimensionText(image)}</span>
          <span className="text-[var(--text-faint)]">·</span>
          <span>{format}</span>
          {image.fileSize ? (
            <>
              <span className="text-[var(--text-faint)]">·</span>
              <span>{formatBytes(image.fileSize)}</span>
            </>
          ) : null}
        </div>

        {!compact ? (
          <>
            <div className="truncate text-[11px] text-[var(--text-faint)]" title={image.sourcePage}>
              {image.sourcePageLabel}
            </div>
            <div className="mt-auto flex items-center justify-between gap-1 pt-1.5">
              <div className="flex min-w-0 gap-1">
                <Badge tone={category === 'map' ? 'accent' : 'neutral'}>{categoryLabel(category)}</Badge>
                <Badge className="hidden sm:inline-flex" title="How this reference was discovered">
                  {discoveryLabel(image.sourceTypes[0] ?? 'img')}
                </Badge>
              </div>
              <button
                type="button"
                onClick={() => onCopyUrl(image)}
                className="shrink-0 rounded-lg p-1.5 text-[var(--text-faint)] transition hover:bg-[var(--panel-inset)] hover:text-[var(--text)]"
                aria-label={`Copy URL for ${image.filename}`}
              >
                <Copy size={13} />
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
});
