'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, FileDown } from 'lucide-react';
import { Button, Spinner } from '@/components/ui/primitives';
import type { ExportFormat } from '@/lib/types';

const OPTIONS: Array<{ format: ExportFormat; title: string; detail: string }> = [
  { format: 'csv', title: 'CSV', detail: 'Spreadsheet columns: filename, URL, page, size, format, alt, category' },
  { format: 'json', title: 'JSON', detail: 'Complete structured dataset, including every reference' },
  { format: 'txt', title: 'TXT', detail: 'Plain list of image URLs, one per line' },
];

export function ExportMenu({
  onExport,
  busy,
  label = 'Export',
  icon,
  size = 'md',
  disabled,
}: {
  onExport: (format: ExportFormat) => void;
  busy?: boolean;
  label?: string;
  icon?: ReactNode;
  size?: 'sm' | 'md';
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <Button
        size={size}
        disabled={disabled || busy}
        onClick={() => setOpen((previous) => !previous)}
        aria-haspopup="menu"
        aria-expanded={open}
        icon={busy ? <Spinner className="h-3.5 w-3.5" /> : (icon ?? <FileDown size={14} />)}
      >
        {label}
        <ChevronDown size={13} className="opacity-60" />
      </Button>

      {open ? (
        <div
          role="menu"
          className="animate-fade-up absolute right-0 bottom-full z-50 mb-2 w-72 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel-raised)] shadow-[var(--shadow-float)]"
        >
          {OPTIONS.map((option) => (
            <button
              key={option.format}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onExport(option.format);
              }}
              className="block w-full border-b border-[var(--border)] px-3.5 py-2.5 text-left transition-colors last:border-b-0 hover:bg-[var(--panel-inset)]"
            >
              <span className="text-[13px] font-medium">{option.title}</span>
              <span className="mt-0.5 block text-[11.5px] leading-snug text-[var(--text-muted)]">
                {option.detail}
              </span>
            </button>
          ))}
          <p className="bg-[var(--panel-inset)] px-3.5 py-2 text-[11px] leading-snug text-[var(--text-faint)]">
            Exports contain references and metadata only — never the image files themselves.
          </p>
        </div>
      ) : null}
    </div>
  );
}
