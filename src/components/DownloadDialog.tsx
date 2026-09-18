'use client';

import { useState } from 'react';
import { Download, TriangleAlert } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button, Checkbox, Spinner } from '@/components/ui/primitives';
import { formatBytes } from '@/lib/utils/text';
import type { DiscoveredImage } from '@/lib/types';

/**
 * Confirmation shown before any file contents are retrieved.
 *
 * Everywhere else the tool deals in references; this is the one action that
 * pulls down the files themselves, so the user states their basis for doing so
 * and that statement is written into the archive's manifest.
 */
export function DownloadDialog({
  open,
  onClose,
  assets,
  onConfirm,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  assets: DiscoveredImage[];
  onConfirm: (basis: string) => void;
  busy: boolean;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [basis, setBasis] = useState('');

  const retrievable = assets.filter(
    (asset) => asset.status !== 'unavailable' && asset.status !== 'unsupported',
  );
  const skipped = assets.length - retrievable.length;
  const geoCount = retrievable.filter((asset) => asset.assetKind === 'geo').length;
  const imageCount = retrievable.length - geoCount;

  // Only assets whose size is actually known contribute to the estimate.
  const known = retrievable.filter((asset) => asset.fileSize != null);
  const knownBytes = known.reduce((total, asset) => total + (asset.fileSize ?? 0), 0);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Download files"
      description={`${retrievable.length} file${retrievable.length === 1 ? '' : 's'} from this scan`}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!acknowledged || busy || retrievable.length === 0}
            icon={busy ? <Spinner className="h-3.5 w-3.5" /> : <Download size={14} />}
            onClick={() => onConfirm(basis.trim())}
          >
            {busy ? 'Preparing archive…' : 'Download ZIP'}
          </Button>
        </>
      }
    >
      <div className="space-y-4 px-5 py-4">
        <dl className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-inset)] px-3 py-2.5">
            <dt className="text-[10px] font-semibold tracking-[0.08em] text-[var(--text-faint)] uppercase">
              Images
            </dt>
            <dd className="mt-1 font-mono text-lg font-semibold tabular-nums">{imageCount}</dd>
          </div>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-inset)] px-3 py-2.5">
            <dt className="text-[10px] font-semibold tracking-[0.08em] text-[var(--text-faint)] uppercase">
              Geo data
            </dt>
            <dd className="mt-1 font-mono text-lg font-semibold text-[var(--accent)] tabular-nums">
              {geoCount}
            </dd>
          </div>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-inset)] px-3 py-2.5">
            <dt className="text-[10px] font-semibold tracking-[0.08em] text-[var(--text-faint)] uppercase">
              Approx. size
            </dt>
            <dd className="mt-1 font-mono text-lg font-semibold tabular-nums">
              {known.length > 0 ? formatBytes(knownBytes) : '—'}
            </dd>
          </div>
        </dl>

        {known.length < retrievable.length ? (
          <p className="text-[11.5px] text-[var(--text-faint)]">
            The size estimate covers the {known.length} file
            {known.length === 1 ? '' : 's'} whose length the server reported; the rest are unknown
            until they are fetched.
          </p>
        ) : null}

        {skipped > 0 ? (
          <p className="flex items-start gap-2 rounded-lg border border-[var(--warning)]/30 bg-[var(--warning-soft)] px-3 py-2 text-[12.5px] text-[var(--warning)]">
            <TriangleAlert size={14} className="mt-0.5 shrink-0" />
            <span>
              {skipped} selected file{skipped === 1 ? '' : 's'} could not be retrieved when the site
              was scanned, so {skipped === 1 ? 'it is' : 'they are'} excluded. The archive manifest
              lists {skipped === 1 ? 'it' : 'them'}.
            </span>
          </p>
        ) : null}

        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-inset)] p-3">
          <p className="text-[12.5px] leading-relaxed text-[var(--text-muted)]">
            Finding a file on a public website does not grant permission to download or reuse it.
            Copyright and licensing stay with the original owner, and the site&rsquo;s own terms
            still apply.
          </p>
          <div className="mt-2">
            <Checkbox
              checked={acknowledged}
              onChange={setAcknowledged}
              label={
                <span className="text-[13px] font-medium whitespace-normal">
                  I have the right to retrieve these files.
                </span>
              }
            />
          </div>
        </div>

        <label className="block">
          <span className="text-[12.5px] font-medium">Basis (optional)</span>
          <input
            value={basis}
            onChange={(event) => setBasis(event.target.value)}
            placeholder="e.g. I operate this site, or: public records under …"
            maxLength={300}
            className="mt-1.5 w-full rounded-lg border border-[var(--border)] bg-[var(--panel-inset)] px-3 py-2 text-[13px] placeholder:text-[var(--text-faint)] hover:border-[var(--border-strong)] focus:border-[var(--accent)] focus:outline-none"
          />
          <span className="mt-1 block text-[11.5px] text-[var(--text-faint)]">
            Recorded in MANIFEST.csv inside the archive, alongside every file&rsquo;s source URL.
          </span>
        </label>
      </div>
    </Modal>
  );
}
