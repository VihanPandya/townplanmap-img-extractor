'use client';

import { History, Loader2 } from 'lucide-react';
import { cx } from '@/components/ui/primitives';
import type { ScanSummary } from '@/lib/types';

function relativeTime(timestamp: number): string {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Recent scans held by the server. Results live in temporary storage, so this
 * list is honest about the fact that older scans expire.
 */
export function ScanHistory({
  scans,
  activeId,
  onOpen,
  className,
}: {
  scans: ScanSummary[];
  activeId: string | null;
  onOpen: (scanId: string) => void;
  className?: string;
}) {
  if (scans.length === 0) return null;

  return (
    <div className={cx('surface overflow-hidden', className)}>
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2.5">
        <History size={13} className="text-[var(--text-faint)]" />
        <h2 className="text-[12px] font-semibold">Recent scans</h2>
      </div>
      <ul className="max-h-72 overflow-y-auto p-1.5">
        {scans.map((scan) => {
          const live = scan.status === 'running' || scan.status === 'paused' || scan.status === 'stopping';
          return (
            <li key={scan.id}>
              <button
                type="button"
                onClick={() => onOpen(scan.id)}
                className={cx(
                  'w-full rounded-lg px-2.5 py-2 text-left transition-colors',
                  scan.id === activeId
                    ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                    : 'hover:bg-[var(--panel-inset)]',
                )}
              >
                <span className="flex items-center gap-1.5">
                  {live ? <Loader2 size={11} className="shrink-0 animate-spin" /> : null}
                  <span className="truncate text-[12.5px] font-medium">{scan.host}</span>
                </span>
                <span className="mt-0.5 flex items-center justify-between gap-2 text-[11px] text-[var(--text-muted)]">
                  <span>
                    {scan.imageCount} image{scan.imageCount === 1 ? '' : 's'} · {scan.progress.pagesScanned} page
                    {scan.progress.pagesScanned === 1 ? '' : 's'}
                  </span>
                  <span className="shrink-0 text-[var(--text-faint)]">{relativeTime(scan.startedAt)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="border-t border-[var(--border)] px-3 py-2 text-[11px] leading-snug text-[var(--text-faint)]">
        Results are held in temporary storage and expire; re-run a scan to refresh it.
      </p>
    </div>
  );
}
