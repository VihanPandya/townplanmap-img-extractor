'use client';

import { Copy, Download, ExternalLink, FileDown, X } from 'lucide-react';
import { Button } from '@/components/ui/primitives';
import { ExportMenu } from '@/components/ExportMenu';
import type { ExportFormat } from '@/lib/types';

/**
 * Appears only when something is selected. Selection is kept in a Set on the
 * parent, so it survives filtering and re-sorting.
 */
export function SelectionToolbar({
  count,
  onCopyUrls,
  onOpenSelected,
  onExport,
  onDownload,
  onClear,
  exporting,
}: {
  count: number;
  onCopyUrls: () => void;
  onOpenSelected: () => void;
  onExport: (format: ExportFormat) => void;
  onDownload: () => void;
  onClear: () => void;
  exporting: boolean;
}) {
  if (count === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
      <div className="animate-fade-up pointer-events-auto flex w-full max-w-3xl flex-wrap items-center gap-2 rounded-2xl border border-[var(--border-strong)] bg-[var(--panel-raised)]/96 px-3 py-2.5 shadow-[var(--shadow-float)] backdrop-blur-md">
        <span className="mr-auto pl-1 text-[13px] font-medium">
          <span className="font-mono tabular-nums">{count}</span>{' '}
          image{count === 1 ? '' : 's'} selected
        </span>
        <Button size="sm" icon={<Copy size={13} />} onClick={onCopyUrls}>
          Copy URLs
        </Button>
        <Button size="sm" icon={<ExternalLink size={13} />} onClick={onOpenSelected}>
          Open selected
        </Button>
        <ExportMenu
          onExport={onExport}
          busy={exporting}
          label="Export metadata"
          icon={<FileDown size={13} />}
          size="sm"
        />
        <Button size="sm" variant="primary" icon={<Download size={13} />} onClick={onDownload}>
          Download files
        </Button>
        <Button size="sm" variant="ghost" icon={<X size={13} />} onClick={onClear}>
          Clear
        </Button>
      </div>
    </div>
  );
}
