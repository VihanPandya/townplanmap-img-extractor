'use client';

import { useMemo, useState } from 'react';
import { FileWarning, ImageOff, Layers, Map as MapIcon } from 'lucide-react';
import { previewUrl } from '@/lib/client/api';
import { cx } from '@/components/ui/primitives';
import type { DiscoveredImage } from '@/lib/types';

type LoadState = 'loading' | 'direct' | 'relayed' | 'failed';

/**
 * Renders a discovered asset.
 *
 * The browser first tries the original URL. If that fails (hotlink protection,
 * a blocked mixed-content request) it retries once through the server relay,
 * which reuses the same guarded fetcher. Only after both fail is the asset
 * shown as unavailable - the component never claims an image loaded when it
 * did not.
 */
export function ImagePreview({
  image,
  scanId,
  className,
  imgClassName,
  sizes,
  eager = false,
  fit = 'cover',
}: {
  image: DiscoveredImage;
  scanId: string;
  className?: string;
  imgClassName?: string;
  sizes?: string;
  eager?: boolean;
  fit?: 'cover' | 'contain';
}) {
  const [state, setState] = useState<LoadState>('loading');
  const [source, setSource] = useState(image.url);
  const [renderedUrl, setRenderedUrl] = useState(image.url);

  // When the viewer navigates to a different asset this component stays
  // mounted, so the load state is reset during render (React's documented
  // "adjusting state when a prop changes" pattern) rather than in an effect.
  if (renderedUrl !== image.url) {
    setRenderedUrl(image.url);
    setSource(image.url);
    setState('loading');
  }

  const knownBroken = image.status === 'unavailable' || image.status === 'unsupported';
  const aspect = useMemo(() => {
    if (image.width && image.height) return `${image.width} / ${image.height}`;
    return undefined;
  }, [image.width, image.height]);

  // A geographic data file has no rendering: showing a labelled tile is honest,
  // where an <img> would only ever produce a broken-image icon.
  if (image.assetKind === 'geo') {
    const usable = image.status === 'available' || image.status === 'redirected';
    return (
      <div
        className={cx(
          'flex flex-col items-center justify-center gap-1.5 bg-[var(--panel-inset)]',
          usable ? 'text-[var(--accent)]' : 'text-[var(--text-faint)]',
          className,
        )}
      >
        {image.geoFormat === 'kmz' || image.geoFormat === 'shapefile-zip' ? (
          <Layers size={22} />
        ) : (
          <MapIcon size={22} />
        )}
        <span className="font-mono text-[10px] font-semibold tracking-[0.08em] uppercase">
          {image.geoFormat ?? 'geo'}
        </span>
        <span className="px-2 text-center text-[10px] leading-tight text-[var(--text-faint)]">
          {usable ? 'Geographic data file' : 'Could not be retrieved'}
        </span>
      </div>
    );
  }

  if (knownBroken && state !== 'direct' && state !== 'relayed') {
    return (
      <div
        className={cx(
          'flex flex-col items-center justify-center gap-1.5 bg-[var(--panel-inset)] text-[var(--text-faint)]',
          className,
        )}
      >
        {image.status === 'unsupported' ? <FileWarning size={20} /> : <ImageOff size={20} />}
        <span className="px-2 text-center text-[11px] leading-tight">
          {image.status === 'unsupported' ? 'Not a readable image' : 'Could not be retrieved'}
        </span>
      </div>
    );
  }

  return (
    <div className={cx('checkerboard relative overflow-hidden', className)}>
      {state === 'loading' ? <div className="skeleton absolute inset-0" aria-hidden="true" /> : null}
      {state === 'failed' ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-[var(--panel-inset)] text-[var(--text-faint)]">
          <ImageOff size={20} />
          <span className="px-2 text-center text-[11px] leading-tight">Preview unavailable</span>
        </div>
      ) : (
        <img
          src={source}
          alt={image.altText ?? ''}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          referrerPolicy="no-referrer"
          {...(sizes ? { sizes } : {})}
          style={aspect && fit === 'contain' ? { aspectRatio: aspect } : undefined}
          className={cx(
            'h-full w-full transition-opacity duration-300',
            fit === 'cover' ? 'object-cover' : 'object-contain',
            state === 'loading' ? 'opacity-0' : 'opacity-100',
            imgClassName,
          )}
          onLoad={() => setState((previous) => (previous === 'loading' ? 'direct' : previous))}
          onError={() => {
            const relay = previewUrl(image, scanId);
            if (source !== relay) {
              setSource(relay);
              setState('loading');
            } else {
              setState('failed');
            }
          }}
        />
      )}
    </div>
  );
}
