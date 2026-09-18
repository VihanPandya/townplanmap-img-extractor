'use client';

/**
 * The download centre (section 55).
 *
 * States exactly what is available before a large download starts, and keeps
 * the three kinds of output independent: metadata and KML are produced from
 * data already retrieved during the scan, while image files are fetched from
 * the source website and therefore need the same acknowledgement as anywhere
 * else in the application.
 */

import { useMemo, useState } from 'react';
import { Check, Download, FolderTree, Package, TriangleAlert } from 'lucide-react';
import { Badge, Button, Checkbox, cx, Spinner, Toggle } from '@/components/ui/primitives';
import type { ParcelRecord } from '@/lib/mapintel/types';

export interface DownloadRequest {
  includeImages: boolean;
  includeKml: boolean;
  includeMetadata: boolean;
  basis: string;
}

export function DownloadCentre({
  locationName,
  parcels,
  selectedIds,
  onDownloadBundle,
  onDownloadKml,
  busy,
  progress,
  className,
}: {
  locationName: string;
  parcels: ParcelRecord[];
  selectedIds: ReadonlySet<string>;
  onDownloadBundle: (request: DownloadRequest) => void;
  onDownloadKml: (mode: 'combined' | 'individual') => void;
  busy: string | null;
  progress: string | null;
  className?: string;
}) {
  const [includeImages, setIncludeImages] = useState(true);
  const [includeKml, setIncludeKml] = useState(true);
  const [includeMetadata, setIncludeMetadata] = useState(true);
  const [acknowledged, setAcknowledged] = useState(false);
  const [basis, setBasis] = useState('');

  // The selection when there is one, otherwise everything in view.
  const target = useMemo(
    () => (selectedIds.size > 0 ? parcels.filter((parcel) => selectedIds.has(parcel.id)) : parcels),
    [parcels, selectedIds],
  );

  const stats = useMemo(() => {
    const withKml = target.filter((parcel) => parcel.kmlAvailable).length;
    const withImage = target.filter((parcel) => parcel.images.length > 0).length;
    const imageOnly = target.filter((parcel) => parcel.geometryAvailability === 'image-only').length;
    const uncertain = target.filter((parcel) => parcel.geometryAvailability === 'unverified').length;
    return { total: target.length, withKml, withImage, imageOnly, uncertain };
  }, [target]);

  const needsAcknowledgement = includeImages && !acknowledged;
  const nothingSelected = !includeImages && !includeKml && !includeMetadata;

  return (
    <section className={cx('surface overflow-hidden', className)}>
      <header className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
        <Package size={15} className="text-[var(--text-faint)]" />
        <h2 className="text-[13px] font-semibold">Download centre</h2>
        <span className="ml-auto text-[12px] text-[var(--text-muted)]">{locationName}</span>
      </header>

      <div className="grid gap-3 px-4 py-3 sm:grid-cols-2 lg:grid-cols-4">
        <Figure label="Selected" value={stats.total} hint={selectedIds.size > 0 ? 'explicit selection' : 'all in view'} />
        <Figure label="Images" value={stats.withImage} hint="records with an associated image" tone="neutral" />
        <Figure label="KML" value={stats.withKml} hint="records with source geometry" tone="accent" />
        <Figure
          label="No geometry"
          value={stats.imageOnly + stats.uncertain}
          hint="image only or unverified"
          tone={stats.imageOnly + stats.uncertain > 0 ? 'warning' : 'neutral'}
        />
      </div>

      {stats.imageOnly + stats.uncertain > 0 ? (
        <p className="mx-4 mb-3 flex items-start gap-2 rounded-lg border border-[var(--warning)]/30 bg-[var(--warning-soft)] px-3 py-2 text-[12px] text-[var(--warning)]">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" />
          <span>
            {stats.imageOnly + stats.uncertain} of {stats.total} records have no usable source
            geometry. They are included as imagery and listed in the metadata with the reason, but
            no KML is produced for them.
          </span>
        </p>
      ) : null}

      <div className="space-y-0.5 border-t border-[var(--border)] px-4 py-2.5">
        <Toggle
          checked={includeKml}
          onChange={setIncludeKml}
          label="KML files"
          description={`${stats.withKml} file(s), generated from geometry already retrieved.`}
        />
        <Toggle
          checked={includeMetadata}
          onChange={setIncludeMetadata}
          label="metadata.json"
          description="Relationships between every image, KML and source URL, for later GIS use."
        />
        <Toggle
          checked={includeImages}
          onChange={setIncludeImages}
          label="Image files"
          description={`${stats.withImage} image(s), fetched from the source website during the download.`}
        />
      </div>

      {includeImages ? (
        <div className="mx-4 mb-3 rounded-xl border border-[var(--border)] bg-[var(--panel-inset)] p-3">
          <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
            Finding a file on a public website does not grant permission to download or reuse it.
            Copyright and the site&rsquo;s terms still apply.
          </p>
          <div className="mt-1.5">
            <Checkbox
              checked={acknowledged}
              onChange={setAcknowledged}
              label={
                <span className="text-[12.5px] font-medium whitespace-normal">
                  I have the right to retrieve these files.
                </span>
              }
            />
          </div>
          <input
            value={basis}
            onChange={(event) => setBasis(event.target.value)}
            placeholder="Basis (optional) — recorded in metadata.json"
            maxLength={300}
            className="mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2.5 py-1.5 text-[12.5px] placeholder:text-[var(--text-faint)] focus:border-[var(--accent)] focus:outline-none"
          />
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2 border-t border-[var(--border)] bg-[var(--panel-inset)] px-4 py-3">
        <Button
          size="sm"
          variant="secondary"
          icon={busy === 'kml-combined' ? <Spinner className="h-3.5 w-3.5" /> : <FolderTree size={13} />}
          disabled={stats.withKml === 0 || busy !== null}
          onClick={() => onDownloadKml('combined')}
          title={stats.withKml === 0 ? 'No record in this selection has source geometry' : undefined}
        >
          Download all KML (one file)
        </Button>
        <Button
          size="sm"
          variant="secondary"
          icon={busy === 'kml-individual' ? <Spinner className="h-3.5 w-3.5" /> : <Download size={13} />}
          disabled={stats.withKml === 0 || busy !== null}
          onClick={() => onDownloadKml('individual')}
        >
          One KML per land
        </Button>
        <Button
          size="sm"
          variant="primary"
          icon={busy === 'bundle' ? <Spinner className="h-3.5 w-3.5" /> : <Package size={13} />}
          disabled={nothingSelected || needsAcknowledgement || stats.total === 0 || busy !== null}
          onClick={() => onDownloadBundle({ includeImages, includeKml, includeMetadata, basis: basis.trim() })}
        >
          Download everything
        </Button>
      </div>

      {progress ? (
        <p className="flex items-center gap-2 border-t border-[var(--border)] px-4 py-2.5 text-[12px] text-[var(--text-muted)]">
          {busy ? <Spinner className="h-3.5 w-3.5" /> : <Check size={13} className="text-[var(--positive)]" />}
          {progress}
        </p>
      ) : null}
    </section>
  );
}

function Figure({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: number;
  hint: string;
  tone?: 'neutral' | 'accent' | 'warning';
}) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-inset)] px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold tracking-[0.08em] text-[var(--text-faint)] uppercase">
          {label}
        </span>
        {tone === 'accent' && value > 0 ? <Badge tone="positive">available</Badge> : null}
      </div>
      <div
        className={cx(
          'mt-1 font-mono text-lg leading-none font-semibold tabular-nums',
          tone === 'accent' ? 'text-[var(--accent)]' : tone === 'warning' ? 'text-[var(--warning)]' : '',
        )}
      >
        {value}
      </div>
      <div className="mt-1 text-[11px] text-[var(--text-faint)]">{hint}</div>
    </div>
  );
}
