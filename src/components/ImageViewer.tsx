'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  FileText,
  Info,
  ShieldCheck,
  ShieldQuestion,
  SquareCheck,
} from 'lucide-react';
import { ImagePreview } from '@/components/ImagePreview';
import { Modal } from '@/components/ui/Modal';
import { Badge, Button, cx, IconButton } from '@/components/ui/primitives';
import {
  ALL_CATEGORIES,
  categoryLabel,
  discoveryLabel,
  effectiveCategory,
  formatKey,
  orientationLabel,
  statusLabel,
} from '@/lib/client/filters';
import type { DiscoveredImage, ImageCategory } from '@/lib/types';
import { formatBytes } from '@/lib/utils/text';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-[var(--border)] px-4 py-3 last:border-b-0">
      <dt className="text-[10px] font-semibold tracking-[0.08em] text-[var(--text-faint)] uppercase">
        {label}
      </dt>
      <dd className="mt-1 text-[13px] leading-relaxed break-words">{children}</dd>
    </div>
  );
}

export function ImageViewer({
  image,
  scanId,
  open,
  onClose,
  onNext,
  onPrevious,
  hasNext,
  hasPrevious,
  selected,
  onToggleSelect,
  categoryOverrides,
  onOverrideCategory,
  onCopy,
  position,
  total,
}: {
  image: DiscoveredImage | null;
  scanId: string;
  open: boolean;
  onClose: () => void;
  onNext: () => void;
  onPrevious: () => void;
  hasNext: boolean;
  hasPrevious: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  categoryOverrides: Record<string, ImageCategory>;
  onOverrideCategory: (id: string, category: ImageCategory | null) => void;
  onCopy: (text: string, what: string) => void;
  position: number;
  total: number;
}) {
  const [showPages, setShowPages] = useState(false);
  const [shownImageId, setShownImageId] = useState(image?.id ?? null);

  // Collapse the page list when a different asset is shown in the same modal.
  if (shownImageId !== (image?.id ?? null)) {
    setShownImageId(image?.id ?? null);
    setShowPages(false);
  }

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight' && hasNext) onNext();
      if (event.key === 'ArrowLeft' && hasPrevious) onPrevious();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [hasNext, hasPrevious, onNext, onPrevious, open]);

  const pages = useMemo(() => {
    if (!image) return [];
    const map = new Map<string, { url: string; label: string; title: string | null; methods: Set<string> }>();
    for (const reference of image.references) {
      const entry = map.get(reference.sourcePage) ?? {
        url: reference.sourcePage,
        label: reference.sourcePageLabel,
        title: reference.sourcePageTitle,
        methods: new Set<string>(),
      };
      entry.methods.add(reference.sourceType);
      map.set(reference.sourcePage, entry);
    }
    return [...map.values()];
  }, [image]);

  if (!image) return null;

  const category = effectiveCategory(image, categoryOverrides);
  const overridden = Boolean(categoryOverrides[image.id]);
  const statusTone =
    image.status === 'available'
      ? 'positive'
      : image.status === 'unavailable' || image.status === 'unsupported'
        ? 'danger'
        : image.status === 'unverified'
          ? 'neutral'
          : 'warning';

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="wide"
      title={image.filename}
      description={`${position} of ${total} in the current view`}
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <IconButton label="Previous image" onClick={onPrevious} disabled={!hasPrevious}>
              <ChevronLeft size={16} />
            </IconButton>
            <IconButton label="Next image" onClick={onNext} disabled={!hasNext}>
              <ChevronRight size={16} />
            </IconButton>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              size="sm"
              variant={selected ? 'primary' : 'secondary'}
              icon={<SquareCheck size={14} />}
              onClick={() => onToggleSelect(image.id)}
            >
              {selected ? 'Selected' : 'Select image'}
            </Button>
            <Button
              size="sm"
              icon={<Copy size={14} />}
              onClick={() => onCopy(image.url, 'Image URL')}
            >
              Copy image URL
            </Button>
            <Button
              size="sm"
              icon={<Copy size={14} />}
              onClick={() => onCopy(image.sourcePage, 'Source page URL')}
            >
              Copy source page
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon={<ExternalLink size={14} />}
              onClick={() => window.open(image.sourcePage, '_blank', 'noopener,noreferrer')}
            >
              Open source page
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={<ExternalLink size={14} />}
              onClick={() => window.open(image.url, '_blank', 'noopener,noreferrer')}
            >
              Open image
            </Button>
          </div>
        </div>
      }
    >
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="checkerboard relative flex min-h-[260px] items-center justify-center bg-[var(--panel-inset)] p-4 sm:min-h-[420px]">
          <ImagePreview
            image={image}
            scanId={scanId}
            eager
            fit="contain"
            className="flex max-h-[62vh] w-full items-center justify-center bg-transparent"
            imgClassName="max-h-[62vh] w-auto max-w-full"
          />
          {hasPrevious ? (
            <button
              type="button"
              onClick={onPrevious}
              aria-label="Previous image"
              className="absolute top-1/2 left-3 -translate-y-1/2 rounded-full bg-black/45 p-2 text-white backdrop-blur transition hover:bg-black/65"
            >
              <ChevronLeft size={18} />
            </button>
          ) : null}
          {hasNext ? (
            <button
              type="button"
              onClick={onNext}
              aria-label="Next image"
              className="absolute top-1/2 right-3 -translate-y-1/2 rounded-full bg-black/45 p-2 text-white backdrop-blur transition hover:bg-black/65"
            >
              <ChevronRight size={18} />
            </button>
          ) : null}
        </div>

        <aside className="min-w-0 border-t border-[var(--border)] lg:border-t-0 lg:border-l">
          <div className="border-b border-[var(--border)] px-4 py-3">
            <h3 className="text-[10px] font-semibold tracking-[0.1em] text-[var(--text-faint)] uppercase">
              Image details
            </h3>
          </div>

          <dl>
            <Row label="Filename">
              <span className="font-mono text-[12.5px]">{image.filename}</span>
            </Row>

            <Row label="Dimensions">
              {image.width && image.height ? (
                <span className="font-mono tabular-nums">
                  {image.width} × {image.height}
                  <span className="ml-2 text-[var(--text-muted)]">
                    {orientationLabel(image.orientation)}
                    {image.aspectRatio ? ` · ${image.aspectRatio.toFixed(3)}:1` : ''}
                  </span>
                </span>
              ) : (
                <span className="text-[var(--text-muted)]">
                  Not measured. The scanner only reports dimensions it read from the image itself.
                </span>
              )}
            </Row>

            <Row label="Format">
              <span className="flex flex-wrap items-center gap-2">
                <Badge>{formatKey(image).toUpperCase()}</Badge>
                <span className="font-mono text-[12px] text-[var(--text-muted)]">
                  {image.mimeType ?? 'MIME type not reported'}
                </span>
                {image.fileSize ? (
                  <span className="text-[12px] text-[var(--text-muted)]">{formatBytes(image.fileSize)}</span>
                ) : null}
              </span>
            </Row>

            <Row label="Image URL">
              <a
                href={image.url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-[12px] break-all text-[var(--accent)] hover:underline"
              >
                {image.url}
              </a>
              {image.originalUrl !== image.url ? (
                <p className="mt-1.5 text-[11.5px] text-[var(--text-faint)]">
                  As written in the markup:{' '}
                  <span className="font-mono break-all">{image.originalUrl}</span>
                </p>
              ) : null}
              {image.finalUrl ? (
                <p className="mt-1.5 text-[11.5px] text-[var(--text-faint)]">
                  Redirects to: <span className="font-mono break-all">{image.finalUrl}</span>
                </p>
              ) : null}
            </Row>

            <Row label="Source page">
              <button
                type="button"
                onClick={() => setShowPages((previous) => !previous)}
                className="text-left text-[13px] hover:underline"
              >
                {image.sourcePageLabel}
                {image.pageCount > 1 ? (
                  <span className="ml-1.5 text-[var(--accent)]">Found on {image.pageCount} pages</span>
                ) : null}
              </button>
              {showPages || image.pageCount === 1 ? (
                <ul className="mt-2 space-y-1.5">
                  {pages.map((page) => (
                    <li key={page.url} className="rounded-lg bg-[var(--panel-inset)] px-2.5 py-2">
                      <a
                        href={page.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block truncate font-mono text-[11.5px] text-[var(--accent)] hover:underline"
                        title={page.url}
                      >
                        {page.url}
                      </a>
                      {page.title ? (
                        <p className="mt-0.5 truncate text-[11.5px] text-[var(--text-muted)]">{page.title}</p>
                      ) : null}
                      <p className="mt-1 flex flex-wrap gap-1">
                        {[...page.methods].map((method) => (
                          <Badge key={method}>{discoveryLabel(method)}</Badge>
                        ))}
                      </p>
                    </li>
                  ))}
                </ul>
              ) : null}
            </Row>

            <Row label="Alt text">
              {image.altText ? (
                image.altText
              ) : (
                <span className="text-[var(--text-muted)]">No alt attribute was present on the markup.</span>
              )}
            </Row>

            {image.title ? <Row label="Title attribute">{image.title}</Row> : null}

            <Row label="Discovery method">
              <span className="flex flex-wrap gap-1">
                {image.sourceTypes.map((source) => (
                  <Badge key={source} tone="accent">
                    {discoveryLabel(source)}
                  </Badge>
                ))}
                {image.isLazyLoaded ? <Badge tone="warning">LAZY LOADED</Badge> : null}
              </span>
              <p className="mt-1.5 text-[11.5px] text-[var(--text-faint)]">
                {image.referenceCount} reference{image.referenceCount === 1 ? '' : 's'} across{' '}
                {image.pageCount} page{image.pageCount === 1 ? '' : 's'}.
              </p>
            </Row>

            <Row label="Detected category">
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={category}
                  onChange={(event) => {
                    const next = event.target.value as ImageCategory;
                    onOverrideCategory(image.id, next === image.category ? null : next);
                  }}
                  className="rounded-lg border border-[var(--border)] bg-[var(--panel-inset)] px-2.5 py-1.5 text-[13px] hover:border-[var(--border-strong)] focus:border-[var(--accent)] focus:outline-none"
                >
                  {ALL_CATEGORIES.map((value) => (
                    <option key={value} value={value}>
                      {categoryLabel(value)}
                    </option>
                  ))}
                </select>
                {overridden ? (
                  <button
                    type="button"
                    onClick={() => onOverrideCategory(image.id, null)}
                    className="text-[11.5px] text-[var(--accent)] hover:underline"
                  >
                    Reset to detected ({categoryLabel(image.category)})
                  </button>
                ) : (
                  <span className="text-[11.5px] text-[var(--text-faint)]">
                    {Math.round(image.categoryConfidence * 100)}% signal match
                  </span>
                )}
              </div>
              {image.categoryReasons.length > 0 && !overridden ? (
                <ul className="mt-2 space-y-1 text-[11.5px] text-[var(--text-muted)]">
                  {image.categoryReasons.map((reason) => (
                    <li key={reason} className="flex gap-1.5">
                      <Info size={11} className="mt-[3px] shrink-0 opacity-70" />
                      <span>{reason}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="mt-2 text-[11px] text-[var(--text-faint)]">
                Categories are heuristics based on observable metadata, not guaranteed facts. Change the
                value above if it is wrong — exports use your choice.
              </p>
            </Row>

            <Row label="Status">
              <span className="flex flex-wrap items-center gap-2">
                <Badge tone={statusTone}>
                  {image.status === 'available' ? <ShieldCheck size={9} /> : <ShieldQuestion size={9} />}
                  {statusLabel(image.status)}
                </Badge>
                {image.httpStatus ? (
                  <span className="font-mono text-[12px] text-[var(--text-muted)]">
                    HTTP {image.httpStatus}
                  </span>
                ) : null}
              </span>
              <p className="mt-1.5 text-[11.5px] text-[var(--text-muted)]">
                {image.status === 'available'
                  ? 'The scanner requested this URL and received image data.'
                  : image.status === 'unverified'
                    ? 'This reference was found in the page markup. The scanner did not request it, so availability is unknown.'
                    : (image.statusMessage ?? 'The scanner could not confirm this URL.')}
              </p>
              {image.isDuplicate ? (
                <p className="mt-1.5 text-[11.5px] text-[var(--accent)]">
                  Byte-identical to an image discovered earlier in this scan.
                </p>
              ) : null}
              {image.contentHash ? (
                <p className="mt-1.5 flex items-start gap-1.5 font-mono text-[10.5px] break-all text-[var(--text-faint)]">
                  <FileText size={11} className="mt-[2px] shrink-0" />
                  sha256:{image.contentHash.slice(0, 32)}…
                </p>
              ) : null}
            </Row>

            <Row label="Rights">
              <p className="text-[11.5px] text-[var(--text-muted)]">
                This tool lists references to publicly reachable images. It does not grant any right to
                reuse them — copyright stays with the original owner.
              </p>
            </Row>
          </dl>
        </aside>
      </div>
    </Modal>
  );
}

export { cx };
