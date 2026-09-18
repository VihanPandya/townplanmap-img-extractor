'use client';

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, Info, X } from 'lucide-react';
import { cx, IconButton } from './primitives';

type ToastTone = 'info' | 'success' | 'error';

interface ToastItem {
  id: number;
  message: string;
  detail?: string;
  tone: ToastTone;
}

interface ToastApi {
  show: (message: string, tone?: ToastTone, detail?: string) => void;
}

const ToastContext = createContext<ToastApi>({ show: () => undefined });

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setItems((previous) => previous.filter((item) => item.id !== id));
  }, []);

  const show = useCallback(
    (message: string, tone: ToastTone = 'info', detail?: string) => {
      const id = nextId.current;
      nextId.current += 1;
      setItems((previous) => [...previous.slice(-3), { id, message, tone, ...(detail ? { detail } : {}) }]);
      setTimeout(() => dismiss(id), tone === 'error' ? 7000 : 3200);
    },
    [dismiss],
  );

  const api = useMemo(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4 sm:right-4 sm:bottom-6 sm:left-auto sm:items-end"
        role="status"
        aria-live="polite"
      >
        {items.map((item) => (
          <div
            key={item.id}
            className={cx(
              'animate-fade-up pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-xl border px-3.5 py-2.5 shadow-[var(--shadow-float)] backdrop-blur',
              item.tone === 'error'
                ? 'border-[var(--danger)]/30 bg-[var(--danger-soft)] text-[var(--danger)]'
                : item.tone === 'success'
                  ? 'border-[var(--positive)]/30 bg-[var(--positive-soft)] text-[var(--positive)]'
                  : 'border-[var(--border)] bg-[var(--panel-raised)] text-[var(--text)]',
            )}
          >
            <span className="mt-0.5 shrink-0">
              {item.tone === 'error' ? (
                <AlertTriangle size={15} />
              ) : item.tone === 'success' ? (
                <Check size={15} />
              ) : (
                <Info size={15} />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] leading-snug font-medium">{item.message}</p>
              {item.detail ? <p className="mt-0.5 text-xs opacity-80">{item.detail}</p> : null}
            </div>
            <IconButton label="Dismiss" className="-mt-1 -mr-1 h-7 w-7" onClick={() => dismiss(item.id)}>
              <X size={13} />
            </IconButton>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
