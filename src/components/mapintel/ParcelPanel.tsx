'use client';

/**
 * The land map detail panel (sections 44 and 53).
 *
 * Every field is either a value the source provided or an explicit
 * "Not available from source". Nothing is inferred to fill a gap.
 */

import { Download, ExternalLink, Image as ImageIcon, Info, MapPin, ShieldAlert } from 'lucide-react';
import { Badge, Button, cx } from '@/components/ui/primitives';
import { formatArea, formatCoordinate } from '@/lib/client/mapintel';
import type { ParcelRecord } from '@/lib/mapintel/types';
import { formatBytes } from '@/lib/utils/text';

const NOT_AVAILABLE = <span className="text-[var(--text-faint)] italic">Not available from source</span>;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-[var(--border)] px-4 py-2.5 last:border-b-0">
      <dt className="text-[10px] font-semibold tracking-[0.08em] text-[var(--text-faint)] uppercase">{label}</dt>
      <dd className="mt-1 text-[13px] leading-relaxed break-words">{children}</dd>
    </div>
  );
}

export function ParcelPanel({
  parcel,
  scanId,
  selected,
  onToggleSelect,
  onDownloadKml,
  busy,
  className,
}: {
  parcel: ParcelRecord;
  scanId: string;
  selected: boolean;
  onToggleSelect: () => void;
  onDownloadKml: () => void;
  busy: boolean;
  className?: string;
}) {
  const feature = parcel.feature;
  const bestImage = parcel.images[0] ?? null;

  const availabilityBadge =
    parcel.geometryAvailability === 'available' ? (
      <Badge tone="positive">KML available</Badge>
    ) : parcel.geometryAvailability === 'image-only' ? (
      <Badge tone="warning">Image only · KML unavailable</Badge>
    ) : (
      <Badge tone="danger">Geometry could not be verified</Badge>
    );

  return (
    <aside className={cx('surface overflow-hidden', className)}>
      <header className="flex items-start justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-[10px] font-semibold tracking-[0.1em] text-[var(--text-faint)] uppercase">
            Land map
          </h3>
          <p className="mt-0.5 truncate text-[14px] font-semibold">{parcel.reference ?? parcel.name}</p>
        </div>
        {availabilityBadge}
      </header>

      <dl>
        <Row label="Parcel / survey reference">
          {parcel.reference ? <span className="font-mono">{parcel.reference}</span> : NOT_AVAILABLE}
          {parcel.name !== parcel.reference ? (
            <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">{parcel.name}</p>
          ) : null}
        </Row>

        <Row label="Location">
          {parcel.folderPath.length > 0 || Object.keys(parcel.properties).length > 0 ? (
            <div className="space-y-0.5">
              {parcel.folderPath.length > 0 ? <p>{parcel.folderPath.join(' → ')}</p> : null}
              {['village', 'town', 'city', 'taluka', 'district', 'state'].map((key) => {
                const value = parcel.properties[key] ?? parcel.properties[`${key}_name`];
                if (!value) return null;
                return (
                  <p key={key} className="text-[12.5px]">
                    <span className="text-[var(--text-faint)] capitalize">{key}: </span>
                    {value}
                  </p>
                );
              })}
            </div>
          ) : (
            NOT_AVAILABLE
          )}
        </Row>

        <Row label="Area">
          {parcel.areaSquareMetres !== null ? (
            <>
              <span className="font-mono">{formatArea(parcel.areaSquareMetres)}</span>
              <p className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">
                {parcel.areaBasis === 'source-attribute'
                  ? 'Stated by the source.'
                  : 'Computed from the source geometry, so it may differ slightly from the official record.'}
              </p>
            </>
          ) : (
            NOT_AVAILABLE
          )}
        </Row>

        <Row label="Geometry">
          {feature ? (
            <>
              <span className="font-mono">{feature.geometry.type}</span>
              <p className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">
                {feature.vertexCount} vertices · {feature.sourceCrs}
                {feature.transformed ? ' → EPSG:4326 (transformed)' : ' (as published)'}
              </p>
              {feature.bbox ? (
                <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[11px] text-[var(--text-muted)]">
                  <span>N {formatCoordinate(feature.bbox.north)}</span>
                  <span>S {formatCoordinate(feature.bbox.south)}</span>
                  <span>E {formatCoordinate(feature.bbox.east)}</span>
                  <span>W {formatCoordinate(feature.bbox.west)}</span>
                </div>
              ) : null}
            </>
          ) : (
            <>
              {NOT_AVAILABLE}
              <p className="mt-1 text-[11.5px] text-[var(--text-muted)]">
                The source published a map image for this record but no geographic coordinates. A
                boundary is not derived from the image.
              </p>
            </>
          )}
        </Row>

        <Row label="Map image">
          {bestImage ? (
            <div className="space-y-1.5">
              <a
                href={bestImage.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block font-mono text-[11.5px] break-all text-[var(--accent)] hover:underline"
              >
                {bestImage.url}
              </a>
              <p className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-[var(--text-muted)]">
                {bestImage.width && bestImage.height ? (
                  <span className="font-mono">
                    {bestImage.width} × {bestImage.height}
                  </span>
                ) : (
                  <span>Dimensions not measured</span>
                )}
                {bestImage.fileSize ? <span>· {formatBytes(bestImage.fileSize)}</span> : null}
                {bestImage.georeferenced ? <Badge tone="positive">georeferenced</Badge> : null}
              </p>
              <p className="flex items-start gap-1.5 text-[11.5px] text-[var(--text-muted)]">
                <Info size={11} className="mt-[3px] shrink-0 opacity-70" />
                <span>
                  Association:{' '}
                  <strong
                    className={
                      bestImage.confidence === 'verified'
                        ? 'text-[var(--positive)]'
                        : bestImage.confidence === 'probable'
                          ? 'text-[var(--warning)]'
                          : 'text-[var(--text-faint)]'
                    }
                  >
                    {bestImage.confidence}
                  </strong>
                  {' — '}
                  {bestImage.reason}
                </span>
              </p>
              {parcel.images.length > 1 ? (
                <p className="text-[11.5px] text-[var(--text-faint)]">
                  {parcel.images.length - 1} other image
                  {parcel.images.length === 2 ? '' : 's'} on the same page.
                </p>
              ) : null}
            </div>
          ) : (
            NOT_AVAILABLE
          )}
        </Row>

        {Object.keys(parcel.properties).length > 0 ? (
          <Row label="Source attributes">
            <div className="space-y-0.5 font-mono text-[11.5px]">
              {Object.entries(parcel.properties)
                .slice(0, 18)
                .map(([key, value]) => (
                  <p key={key}>
                    <span className="text-[var(--text-faint)]">{key}: </span>
                    {value}
                  </p>
                ))}
            </div>
          </Row>
        ) : null}

        <Row label="Source">
          <div className="space-y-1 text-[11.5px]">
            <p>
              <span className="text-[var(--text-faint)]">Source page: </span>
              <a
                href={parcel.sourcePage}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono break-all text-[var(--accent)] hover:underline"
              >
                {parcel.sourcePage}
              </a>
            </p>
            {parcel.geometrySource ? (
              <p>
                <span className="text-[var(--text-faint)]">Geometry source: </span>
                <a
                  href={parcel.geometrySource}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono break-all text-[var(--accent)] hover:underline"
                >
                  {parcel.geometrySource}
                </a>
              </p>
            ) : null}
            <p className="text-[var(--text-muted)]">
              Extraction method: public webpage and publicly exposed map data.
            </p>
          </div>
        </Row>

        <Row label="Accuracy">
          <p className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-[var(--text-muted)]">
            <ShieldAlert size={12} className="mt-[3px] shrink-0 text-[var(--warning)]" />
            <span>
              Map imagery and geographic boundaries are presented according to the source data
              available through the website. This should not be treated as a legal land-survey
              document unless the authoritative source explicitly establishes that status.
            </span>
          </p>
        </Row>
      </dl>

      <footer className="flex flex-wrap gap-2 border-t border-[var(--border)] bg-[var(--panel-inset)] px-4 py-3">
        <Button
          size="sm"
          variant={parcel.kmlAvailable ? 'primary' : 'secondary'}
          icon={<Download size={13} />}
          disabled={!parcel.kmlAvailable || busy}
          onClick={onDownloadKml}
          title={
            parcel.kmlAvailable
              ? 'Download this parcel as KML'
              : 'No KML: the source published no usable geometry for this record'
          }
        >
          Download KML
        </Button>
        <Button size="sm" variant={selected ? 'primary' : 'secondary'} onClick={onToggleSelect}>
          {selected ? 'Selected' : 'Select'}
        </Button>
        {bestImage ? (
          <Button
            size="sm"
            icon={<ImageIcon size={13} />}
            onClick={() => window.open(bestImage.url, '_blank', 'noopener,noreferrer')}
          >
            Open image
          </Button>
        ) : null}
        <Button
          size="sm"
          icon={<ExternalLink size={13} />}
          onClick={() => window.open(parcel.sourcePage, '_blank', 'noopener,noreferrer')}
        >
          Open source
        </Button>
      </footer>

      {!parcel.kmlAvailable ? (
        <p className="flex items-start gap-1.5 border-t border-[var(--border)] px-4 py-2.5 text-[11.5px] text-[var(--text-muted)]">
          <MapPin size={12} className="mt-[2px] shrink-0 text-[var(--warning)]" />
          <span>
            KML is unavailable for this record because the source did not publish coordinates for
            it. Producing one from the image would invent a precision the source never provided.
          </span>
        </p>
      ) : null}

      <span className="sr-only">{scanId}</span>
    </aside>
  );
}
