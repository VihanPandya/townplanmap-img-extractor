'use client';

/**
 * Interactive geometry viewer.
 *
 * Renders real source geometry in Web Mercator with zoom, pan and click
 * selection. There is deliberately no third-party basemap by default: this
 * application never silently sends the coordinates of someone's land records to
 * a tile provider. A basemap can be switched on when a tile URL is configured,
 * and the UI says plainly when none is.
 *
 * An image overlay is only ever drawn from bounds the source itself published
 * (a KML GroundOverlay). Nothing here aligns an image by eye.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Crosshair, Layers, Maximize2, Minus, Plus } from 'lucide-react';
import { cx, IconButton } from '@/components/ui/primitives';
import type { BoundingBox, GroundOverlay, Position } from '@/lib/geo/types';
import type { ParcelRecord } from '@/lib/mapintel/types';

/** Web Mercator, purely for screen layout — never written back to a file. */
function project(longitude: number, latitude: number): { x: number; y: number } {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  return {
    x: (longitude + 180) / 360,
    y: (1 - Math.log(Math.tan((clamped * Math.PI) / 180) + 1 / Math.cos((clamped * Math.PI) / 180)) / Math.PI) / 2,
  };
}

interface View {
  /** Projected centre. */
  cx: number;
  cy: number;
  /** Projected units per pixel; smaller means more zoomed in. */
  scale: number;
}

function ringsOf(parcel: ParcelRecord): Position[][] {
  const feature = parcel.feature;
  if (!feature) return [];
  const { type, coordinates } = feature.geometry;
  switch (type) {
    case 'Polygon':
      return coordinates as Position[][];
    case 'MultiPolygon':
      return (coordinates as Position[][][]).flat();
    case 'LineString':
      return [coordinates as Position[]];
    case 'MultiLineString':
      return coordinates as Position[][];
    case 'Point':
      return [[coordinates as Position]];
    case 'MultiPoint':
      return [(coordinates as Position[])];
    default:
      return [];
  }
}

export function MapCanvas({
  parcels,
  overlays,
  selectedId,
  onSelect,
  bbox,
  className,
}: {
  parcels: ParcelRecord[];
  overlays: GroundOverlay[];
  selectedId: string | null;
  onSelect: (parcelId: string) => void;
  bbox: BoundingBox | null;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 520 });
  const [view, setView] = useState<View | null>(null);
  const [showOverlays, setShowOverlays] = useState(true);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const dragRef = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);

  const drawable = useMemo(() => parcels.filter((parcel) => parcel.feature !== null), [parcels]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setSize({ width: Math.max(200, rect.width), height: Math.max(240, rect.height) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /** Fit the view to a bounding box with a small margin. */
  const fitTo = useCallback(
    (box: BoundingBox | null) => {
      if (!box) return;
      const topLeft = project(box.west, box.north);
      const bottomRight = project(box.east, box.south);
      const spanX = Math.max(Math.abs(bottomRight.x - topLeft.x), 1e-7);
      const spanY = Math.max(Math.abs(bottomRight.y - topLeft.y), 1e-7);
      const scale = Math.max(spanX / size.width, spanY / size.height) * 1.25;
      setView({ cx: (topLeft.x + bottomRight.x) / 2, cy: (topLeft.y + bottomRight.y) / 2, scale });
    },
    [size.height, size.width],
  );

  const [fittedKey, setFittedKey] = useState<string | null>(null);
  const boxKey = bbox ? `${bbox.west},${bbox.south},${bbox.east},${bbox.north}` : null;
  // Re-fit when the data changes, without an effect that would fight panning.
  if (boxKey !== fittedKey) {
    setFittedKey(boxKey);
    if (bbox) fitTo(bbox);
  }

  const toScreen = useCallback(
    (longitude: number, latitude: number) => {
      if (!view) return { x: 0, y: 0 };
      const point = project(longitude, latitude);
      return {
        x: (point.x - view.cx) / view.scale + size.width / 2,
        y: (point.y - view.cy) / view.scale + size.height / 2,
      };
    },
    [size.height, size.width, view],
  );

  const zoomBy = useCallback((factor: number) => {
    setView((previous) => (previous ? { ...previous, scale: previous.scale * factor } : previous));
  }, []);

  const onWheel = useCallback((event: React.WheelEvent) => {
    event.preventDefault();
    setView((previous) =>
      previous ? { ...previous, scale: previous.scale * (event.deltaY > 0 ? 1.15 : 0.87) } : previous,
    );
  }, []);

  const onPointerDown = (event: React.PointerEvent) => {
    if (!view) return;
    (event.target as Element).setPointerCapture?.(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, cx: view.cx, cy: view.cy };
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || !view) return;
    setView({
      ...view,
      cx: drag.cx - (event.clientX - drag.x) * view.scale,
      cy: drag.cy - (event.clientY - drag.y) * view.scale,
    });
  };

  const endDrag = (event: React.PointerEvent) => {
    (event.target as Element).releasePointerCapture?.(event.pointerId);
    dragRef.current = null;
  };

  if (!view || drawable.length === 0) {
    return (
      <div
        ref={containerRef}
        className={cx(
          'flex min-h-[320px] flex-col items-center justify-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--panel-inset)] px-6 text-center',
          className,
        )}
      >
        <Crosshair size={22} className="text-[var(--text-faint)]" />
        <p className="text-[13px] font-medium">No geometry to display</p>
        <p className="max-w-sm text-[12px] leading-relaxed text-[var(--text-muted)]">
          The source published map imagery for this selection but no geographic coordinates. Images
          remain available in the land map gallery.
        </p>
      </div>
    );
  }

  const visibleOverlays = showOverlays ? overlays : [];

  return (
    <div
      ref={containerRef}
      className={cx('relative overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel-inset)]', className)}
    >
      <svg
        width={size.width}
        height={size.height}
        className="block touch-none select-none"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        role="application"
        aria-label="Interactive parcel map"
      >
        {/* Georeferenced imagery, positioned by the source's own bounds. */}
        {visibleOverlays.map((overlay) => {
          const topLeft = toScreen(overlay.bbox.west, overlay.bbox.north);
          const bottomRight = toScreen(overlay.bbox.east, overlay.bbox.south);
          const width = bottomRight.x - topLeft.x;
          const height = bottomRight.y - topLeft.y;
          if (width <= 0 || height <= 0) return null;
          return (
            <image
              key={overlay.id}
              href={overlay.href}
              x={topLeft.x}
              y={topLeft.y}
              width={width}
              height={height}
              opacity={0.75}
              preserveAspectRatio="none"
            />
          );
        })}

        {drawable.map((parcel) => {
          const rings = ringsOf(parcel);
          const isSelected = parcel.id === selectedId;
          const isHovered = parcel.id === hoverId;
          const isPoint = parcel.feature?.geometry.type === 'Point' || parcel.feature?.geometry.type === 'MultiPoint';

          if (isPoint) {
            return rings.flat().map((position, index) => {
              const point = toScreen(position[0], position[1]);
              return (
                <circle
                  key={`${parcel.id}-${index}`}
                  cx={point.x}
                  cy={point.y}
                  r={isSelected ? 7 : 5}
                  className="cursor-pointer"
                  fill={isSelected ? 'var(--accent)' : 'var(--positive)'}
                  stroke="white"
                  strokeWidth={1.5}
                  onClick={() => onSelect(parcel.id)}
                  onMouseEnter={() => setHoverId(parcel.id)}
                  onMouseLeave={() => setHoverId(null)}
                >
                  <title>{parcel.reference ?? parcel.name}</title>
                </circle>
              );
            });
          }

          const path = rings
            .map(
              (ring) =>
                `M ${ring
                  .map((position) => {
                    const point = toScreen(position[0], position[1]);
                    return `${point.x.toFixed(1)},${point.y.toFixed(1)}`;
                  })
                  .join(' L ')} Z`,
            )
            .join(' ');

          return (
            <path
              key={parcel.id}
              d={path}
              className="cursor-pointer transition-[fill-opacity]"
              fill={isSelected ? 'var(--accent)' : 'var(--positive)'}
              fillOpacity={isSelected ? 0.4 : isHovered ? 0.3 : 0.16}
              stroke={isSelected ? 'var(--accent)' : 'var(--positive)'}
              strokeWidth={isSelected ? 2.5 : 1.5}
              onClick={() => onSelect(parcel.id)}
              onMouseEnter={() => setHoverId(parcel.id)}
              onMouseLeave={() => setHoverId(null)}
            >
              <title>{parcel.reference ?? parcel.name}</title>
            </path>
          );
        })}
      </svg>

      <div className="absolute top-2.5 right-2.5 flex flex-col gap-1 rounded-lg border border-[var(--border)] bg-[var(--panel)]/92 p-1 backdrop-blur">
        <IconButton label="Zoom in" className="h-7 w-7" onClick={() => zoomBy(0.8)}>
          <Plus size={14} />
        </IconButton>
        <IconButton label="Zoom out" className="h-7 w-7" onClick={() => zoomBy(1.25)}>
          <Minus size={14} />
        </IconButton>
        <IconButton label="Fit to data" className="h-7 w-7" onClick={() => fitTo(bbox)}>
          <Maximize2 size={13} />
        </IconButton>
        {overlays.length > 0 ? (
          <IconButton
            label={showOverlays ? 'Hide image overlay' : 'Show image overlay'}
            className="h-7 w-7"
            active={showOverlays}
            onClick={() => setShowOverlays((previous) => !previous)}
          >
            <Layers size={13} />
          </IconButton>
        ) : null}
      </div>

      <p className="absolute bottom-2 left-2.5 rounded-md bg-[var(--panel)]/88 px-2 py-1 text-[10.5px] text-[var(--text-muted)] backdrop-blur">
        {drawable.length} feature{drawable.length === 1 ? '' : 's'} · source geometry, WGS 84
        {overlays.length > 0 ? ` · ${overlays.length} georeferenced overlay${overlays.length === 1 ? '' : 's'}` : ''}
        {' · no basemap configured'}
      </p>
    </div>
  );
}
