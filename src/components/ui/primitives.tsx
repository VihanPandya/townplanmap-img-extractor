'use client';

import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--accent)] text-[var(--accent-contrast)] hover:brightness-110 active:brightness-95 shadow-sm',
  secondary:
    'bg-[var(--panel-raised)] text-[var(--text)] border border-[var(--border-strong)] hover:border-[var(--accent)] hover:text-[var(--accent)]',
  ghost: 'text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--panel-inset)]',
  subtle: 'bg-[var(--panel-inset)] text-[var(--text)] hover:bg-[var(--canvas-subtle)] border border-[var(--border)]',
  danger: 'bg-[var(--danger-soft)] text-[var(--danger)] border border-[var(--danger)]/30 hover:brightness-105',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-lg',
  md: 'h-10 px-4 text-sm gap-2 rounded-xl',
  lg: 'h-12 px-6 text-[15px] gap-2 rounded-xl',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cx(
        'inline-flex items-center justify-center font-medium whitespace-nowrap transition-[background-color,color,border-color,filter,box-shadow] duration-150',
        'disabled:cursor-not-allowed disabled:opacity-45',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, active, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cx(
        'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-colors duration-150',
        active
          ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
          : 'border-transparent text-[var(--text-muted)] hover:border-[var(--border)] hover:bg-[var(--panel-inset)] hover:text-[var(--text)]',
        'disabled:cursor-not-allowed disabled:opacity-45',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextInput({ className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={cx(
          'w-full rounded-xl border border-[var(--border)] bg-[var(--panel-inset)] px-3.5 py-2.5 text-sm',
          'placeholder:text-[var(--text-faint)] transition-colors duration-150',
          'hover:border-[var(--border-strong)] focus:border-[var(--accent)] focus:bg-[var(--panel)] focus:outline-none',
          className,
        )}
        {...rest}
      />
    );
  },
);

export function Badge({
  children,
  tone = 'neutral',
  className,
  title,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'positive' | 'warning' | 'danger';
  className?: string;
  title?: string;
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-[var(--panel-inset)] text-[var(--text-muted)] border-[var(--border)]',
    accent: 'bg-[var(--accent-soft)] text-[var(--accent)] border-[var(--accent)]/25',
    positive: 'bg-[var(--positive-soft)] text-[var(--positive)] border-[var(--positive)]/25',
    warning: 'bg-[var(--warning-soft)] text-[var(--warning)] border-[var(--warning)]/25',
    danger: 'bg-[var(--danger-soft)] text-[var(--danger)] border-[var(--danger)]/25',
  };
  return (
    <span
      title={title}
      className={cx(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.04em] uppercase',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={cx(
        'flex cursor-pointer items-start gap-3 py-1.5',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={cx(
          'mt-0.5 h-5 w-9 shrink-0 rounded-full border transition-colors duration-200',
          checked
            ? 'border-[var(--accent)] bg-[var(--accent)]'
            : 'border-[var(--border-strong)] bg-[var(--panel-inset)]',
        )}
      >
        <span
          className={cx(
            'block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200',
            checked ? 'translate-x-[18px]' : 'translate-x-[2px]',
          )}
        />
      </button>
      <span className="min-w-0">
        <span className="block text-sm leading-tight font-medium">{label}</span>
        {description ? (
          <span className="mt-0.5 block text-xs leading-snug text-[var(--text-muted)]">{description}</span>
        ) : null}
      </span>
    </label>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  count,
  indeterminate,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: ReactNode;
  count?: number;
  indeterminate?: boolean;
}) {
  return (
    <label className="group flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-[var(--panel-inset)]">
      <span
        className={cx(
          'flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors duration-150',
          checked || indeterminate
            ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-contrast)]'
            : 'border-[var(--border-strong)] bg-[var(--panel)] group-hover:border-[var(--accent)]',
        )}
      >
        <input
          type="checkbox"
          className="sr-only"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
        {indeterminate && !checked ? (
          <span className="block h-0.5 w-2 rounded-full bg-current" />
        ) : checked ? (
          <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden="true">
            <path
              d="M2.5 6.2 4.8 8.5 9.5 3.8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : null}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px]">{label}</span>
      {count !== undefined ? (
        <span className="shrink-0 font-mono text-[11px] text-[var(--text-faint)] tabular-nums">{count}</span>
      ) : null}
    </label>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx('animate-spin', className)} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" fill="none" opacity="0.2" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

export function StatTile({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: 'neutral' | 'accent';
}) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-inset)] px-3 py-2.5">
      <div className="text-[10px] font-semibold tracking-[0.08em] text-[var(--text-faint)] uppercase">
        {label}
      </div>
      <div
        className={cx(
          'mt-1 font-mono text-lg leading-none font-semibold tabular-nums',
          tone === 'accent' ? 'text-[var(--accent)]' : 'text-[var(--text)]',
        )}
      >
        {value}
      </div>
      {hint ? <div className="mt-1 truncate text-[11px] text-[var(--text-faint)]">{hint}</div> : null}
    </div>
  );
}
