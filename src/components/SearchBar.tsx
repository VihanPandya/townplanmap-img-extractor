'use client';

import { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { cx } from '@/components/ui/primitives';

/**
 * Instant client-side search. The input is debounced so typing never blocks
 * rendering of a large result set.
 */
export function SearchBar({
  value,
  onChange,
  resultCount,
  totalCount,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  resultCount: number;
  totalCount: number;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [committed, setCommitted] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  // Accept an externally cleared search (for example "Reset filters") without
  // an effect that would fight the debounce below.
  if (committed !== value) {
    setCommitted(value);
    setDraft(value);
  }

  useEffect(() => {
    if (draft === value) return;
    const timer = setTimeout(() => onChange(draft), 140);
    return () => clearTimeout(timer);
  }, [draft, onChange, value]);

  // "/" focuses search, the way developer tools behave.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(input|textarea|select)$/i.test(target.tagName)) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <div className={cx('relative flex-1', className)}>
      <Search
        size={15}
        className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[var(--text-faint)]"
      />
      <input
        ref={inputRef}
        type="search"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Search filename, alt text, title or page URL…"
        aria-label="Search discovered images"
        className="h-9 w-full rounded-xl border border-[var(--border)] bg-[var(--panel-inset)] pr-20 pl-9 text-[13px] transition-colors placeholder:text-[var(--text-faint)] hover:border-[var(--border-strong)] focus:border-[var(--accent)] focus:bg-[var(--panel)] focus:outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      <div className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1">
        {draft ? (
          <>
            <span className="font-mono text-[10.5px] text-[var(--text-faint)] tabular-nums">
              {resultCount}/{totalCount}
            </span>
            <button
              type="button"
              onClick={() => {
                setDraft('');
                onChange('');
                inputRef.current?.focus();
              }}
              aria-label="Clear search"
              className="rounded-md p-1 text-[var(--text-faint)] transition hover:bg-[var(--panel)] hover:text-[var(--text)]"
            >
              <X size={13} />
            </button>
          </>
        ) : (
          <kbd className="hidden rounded border border-[var(--border)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-faint)] sm:block">
            /
          </kbd>
        )}
      </div>
    </div>
  );
}
