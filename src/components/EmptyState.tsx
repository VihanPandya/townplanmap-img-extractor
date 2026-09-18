'use client';

import { ImageOff, Radar, SearchX, ServerCrash } from 'lucide-react';
import { Button } from '@/components/ui/primitives';

export function EmptyState({
  kind,
  onPrimary,
  primaryLabel,
  detail,
  title,
}: {
  kind: 'idle' | 'no-results' | 'no-matches' | 'error';
  onPrimary?: () => void;
  primaryLabel?: string;
  detail?: string;
  title?: string;
}) {
  const content = {
    idle: {
      icon: <Radar size={26} />,
      heading: 'Discover website images',
      body: 'Enter a website URL above to find publicly accessible images and visual assets.',
    },
    'no-results': {
      icon: <ImageOff size={26} />,
      heading: 'No images found',
      body: 'The scanner did not discover qualifying image assets on the scanned pages.',
    },
    'no-matches': {
      icon: <SearchX size={26} />,
      heading: 'Nothing matches those filters',
      body: 'Try a different search term, or clear some filters to widen the results.',
    },
    error: {
      icon: <ServerCrash size={26} />,
      heading: 'The scan could not be completed',
      body: 'Check the address and try again.',
    },
  }[kind];

  return (
    <div className="flex min-h-[320px] flex-col items-center justify-center px-6 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--panel-inset)] text-[var(--text-faint)]">
        {content.icon}
      </div>
      <h2 className="mt-4 text-[17px] font-semibold">{title ?? content.heading}</h2>
      <p className="mt-1.5 max-w-sm text-[13.5px] leading-relaxed text-[var(--text-muted)]">
        {detail ?? content.body}
      </p>
      {onPrimary && primaryLabel ? (
        <Button variant="primary" className="mt-5" onClick={onPrimary}>
          {primaryLabel}
        </Button>
      ) : null}
    </div>
  );
}

/** Placeholder tiles shown while the first assets of a scan arrive. */
export function GallerySkeleton({ count = 12 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="overflow-hidden rounded-xl border border-[var(--border)]">
          <div className="skeleton aspect-[4/3] w-full" />
          <div className="space-y-2 p-2.5">
            <div className="skeleton h-3 w-3/4 rounded" />
            <div className="skeleton h-2.5 w-1/2 rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}
