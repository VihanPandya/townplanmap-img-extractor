'use client';

import { useState, type FormEvent } from 'react';
import { Globe, Radar, Square } from 'lucide-react';
import { Button, Spinner, TextInput } from '@/components/ui/primitives';

/**
 * The target field. Validation is intentionally light here - the server does
 * the authoritative check - but obvious mistakes are caught before a request.
 */
export function UrlInput({
  value,
  onChange,
  onSubmit,
  onStop,
  busy,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  busy: boolean;
  disabled?: boolean;
}) {
  const [touched, setTouched] = useState(false);
  const [lastValue, setLastValue] = useState(value);

  const trimmed = value.trim();
  const problem = !trimmed
    ? 'Enter a website address to scan.'
    : /^(file|ftp|data|javascript|about|blob):/i.test(trimmed)
      ? 'Only http:// and https:// addresses can be scanned.'
      : null;

  // Clearing the field also clears the validation message.
  if (lastValue !== value) {
    setLastValue(value);
    if (!value) setTouched(false);
  }

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (problem) return;
    onSubmit();
  };

  return (
    <form onSubmit={handleSubmit} className="w-full">
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Globe
            size={16}
            className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-[var(--text-faint)]"
          />
          <TextInput
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onBlur={() => setTouched(true)}
            placeholder="https://townplanmap.com"
            spellCheck={false}
            autoComplete="url"
            inputMode="url"
            aria-label="Website address to scan"
            aria-invalid={touched && problem ? true : undefined}
            disabled={disabled}
            className="h-12 pl-10 text-[15px]"
          />
        </div>

        {busy ? (
          <Button type="button" size="lg" variant="danger" icon={<Square size={15} />} onClick={onStop}>
            Stop scan
          </Button>
        ) : (
          <Button
            type="submit"
            size="lg"
            variant="primary"
            disabled={disabled}
            icon={disabled ? <Spinner className="h-4 w-4" /> : <Radar size={16} />}
            className="sm:min-w-[160px]"
          >
            Scan website
          </Button>
        )}
      </div>

      {touched && problem ? (
        <p className="mt-2 text-[12.5px] text-[var(--danger)]" role="alert">
          {problem}
        </p>
      ) : null}
    </form>
  );
}
