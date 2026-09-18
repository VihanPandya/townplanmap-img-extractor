'use client';

import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cx, IconButton } from './primitives';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** `wide` is used by the image viewer, `panel` by settings and help. */
  size?: 'panel' | 'wide';
  labelledBy?: string;
}

/**
 * A focus-trapped dialog. Escape closes, focus is restored to the trigger and
 * the page behind is inert while it is open.
 */
export function Modal({ open, onClose, title, description, children, footer, size = 'panel' }: ModalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!open) return;
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = containerRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose, open],
  );

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleKeyDown, true);

    const timer = window.setTimeout(() => {
      const target = containerRef.current?.querySelector<HTMLElement>('[data-autofocus]');
      (target ?? containerRef.current)?.focus();
    }, 20);

    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', handleKeyDown, true);
      window.clearTimeout(timer);
      restoreRef.current?.focus?.();
    };
  }, [handleKeyDown, open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-black/55 p-0 backdrop-blur-[2px] sm:items-center sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cx(
          'animate-fade-up flex max-h-[94vh] w-full flex-col overflow-hidden rounded-t-2xl bg-[var(--panel)] shadow-[var(--shadow-float)] outline-none sm:rounded-2xl',
          size === 'wide' ? 'sm:max-w-6xl' : 'sm:max-w-xl',
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold">{title}</h2>
            {description ? (
              <p className="mt-0.5 text-[13px] text-[var(--text-muted)]">{description}</p>
            ) : null}
          </div>
          <IconButton label="Close" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>

        {footer ? (
          <footer className="flex items-center justify-end gap-2 border-t border-[var(--border)] bg-[var(--panel-inset)] px-5 py-3">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}
