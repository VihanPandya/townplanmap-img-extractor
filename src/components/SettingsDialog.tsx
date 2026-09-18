'use client';

import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button, Toggle } from '@/components/ui/primitives';
import { DEFAULT_SETTINGS, SETTING_BOUNDS } from '@/lib/config';
import type { ScanSettings } from '@/lib/types';

function NumberField({
  label,
  hint,
  value,
  min,
  max,
  step = 1,
  suffix,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (next: number) => void;
}) {
  return (
    <label className="block py-2">
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <span className="font-mono text-[11px] text-[var(--text-faint)]">
          {min}–{max}
          {suffix ? ` ${suffix}` : ''}
        </span>
      </span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          if (Number.isFinite(parsed)) onChange(Math.min(max, Math.max(min, parsed)));
        }}
        className="mt-1.5 w-full rounded-lg border border-[var(--border)] bg-[var(--panel-inset)] px-3 py-2 font-mono text-sm tabular-nums hover:border-[var(--border-strong)] focus:border-[var(--accent)] focus:outline-none"
      />
      {hint ? <span className="mt-1 block text-xs leading-snug text-[var(--text-muted)]">{hint}</span> : null}
    </label>
  );
}

export function SettingsDialog({
  open,
  onClose,
  settings,
  onApply,
  locked,
}: {
  open: boolean;
  onClose: () => void;
  settings: ScanSettings;
  onApply: (next: ScanSettings) => void;
  locked: boolean;
}) {
  const [draft, setDraft] = useState<ScanSettings>(settings);
  const [wasOpen, setWasOpen] = useState(open);

  // Re-seed the form from the live settings each time the dialog is opened.
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) setDraft(settings);
  }

  const set = <K extends keyof ScanSettings>(key: K, value: ScanSettings[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Crawl settings"
      description="Applied to the next scan you start. Defaults are deliberately conservative."
      footer={
        <>
          <Button variant="ghost" icon={<RotateCcw size={13} />} size="sm" onClick={() => setDraft(DEFAULT_SETTINGS)}>
            Restore defaults
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            data-autofocus
            onClick={() => {
              onApply(draft);
              onClose();
            }}
          >
            Save settings
          </Button>
        </>
      }
    >
      <div className="px-5 py-3">
        {locked ? (
          <p className="mb-3 rounded-lg border border-[var(--warning)]/30 bg-[var(--warning-soft)] px-3 py-2 text-[12.5px] text-[var(--warning)]">
            A scan is running. New settings take effect the next time you start one.
          </p>
        ) : null}

        <div className="grid gap-x-5 sm:grid-cols-2">
          <NumberField
            label="Maximum pages"
            hint="Upper bound on pages fetched from the site."
            value={draft.maxPages}
            min={SETTING_BOUNDS.maxPages.min}
            max={SETTING_BOUNDS.maxPages.max}
            onChange={(value) => set('maxPages', value)}
          />
          <NumberField
            label="Maximum depth"
            hint="How many link hops away from the starting page to follow."
            value={draft.maxDepth}
            min={SETTING_BOUNDS.maxDepth.min}
            max={SETTING_BOUNDS.maxDepth.max}
            onChange={(value) => set('maxDepth', value)}
          />
          <NumberField
            label="Request delay"
            suffix="ms"
            hint="Pause between requests. A robots.txt Crawl-delay overrides this when it is longer."
            value={draft.requestDelayMs}
            min={SETTING_BOUNDS.requestDelayMs.min}
            max={SETTING_BOUNDS.requestDelayMs.max}
            step={50}
            onChange={(value) => set('requestDelayMs', value)}
          />
          <NumberField
            label="Concurrent requests"
            hint="Parallel page fetches. Keep this low to stay polite."
            value={draft.concurrency}
            min={SETTING_BOUNDS.concurrency.min}
            max={SETTING_BOUNDS.concurrency.max}
            onChange={(value) => set('concurrency', value)}
          />
          <NumberField
            label="Minimum image width"
            suffix="px"
            hint="Verified images narrower than this are hidden behind a filter, not discarded."
            value={draft.minImageWidth}
            min={SETTING_BOUNDS.minImageWidth.min}
            max={SETTING_BOUNDS.minImageWidth.max}
            step={10}
            onChange={(value) => set('minImageWidth', value)}
          />
          <NumberField
            label="Minimum image height"
            suffix="px"
            hint="Same rule applied to height."
            value={draft.minImageHeight}
            min={SETTING_BOUNDS.minImageHeight.min}
            max={SETTING_BOUNDS.minImageHeight.max}
            step={10}
            onChange={(value) => set('minImageHeight', value)}
          />
          <NumberField
            label="Maximum images"
            hint="Ceiling on unique assets collected in one scan."
            value={draft.maxImages}
            min={SETTING_BOUNDS.maxImages.min}
            max={SETTING_BOUNDS.maxImages.max}
            step={50}
            onChange={(value) => set('maxImages', value)}
          />
        </div>

        <hr className="my-3 border-[var(--border)]" />

        <div className="space-y-0.5">
          <Toggle
            checked={draft.respectRobots}
            onChange={(value) => set('respectRobots', value)}
            label="Respect robots.txt"
            description="Strongly recommended. Turning this off means the crawler stops honouring the site's stated crawl rules."
          />
          <Toggle
            checked={draft.verifyImages}
            onChange={(value) => set('verifyImages', value)}
            label="Verify images"
            description="Request each image to confirm it is retrievable and read its real dimensions. Without this, every asset stays 'not verified'."
          />
          <Toggle
            checked={draft.useSitemap}
            onChange={(value) => set('useSitemap', value)}
            label="Seed from sitemap"
            description="Use sitemaps advertised in robots.txt to find pages that are not linked from the home page."
          />
          <Toggle
            checked={draft.followStylesheets}
            onChange={(value) => set('followStylesheets', value)}
            label="Scan stylesheets"
            description="Fetch same-site CSS files and collect background-image references."
          />
          <Toggle
            checked={draft.includeSubdomains}
            onChange={(value) => set('includeSubdomains', value)}
            label="Include subdomains"
            description="Also crawl pages on subdomains of the target site."
          />
          <Toggle
            checked={draft.includeExternalImages}
            onChange={(value) => set('includeExternalImages', value)}
            label="Include external image domains"
            description="Keep images hosted on other domains, such as a CDN."
          />
        </div>

        {!draft.respectRobots ? (
          <p className="mt-3 rounded-lg border border-[var(--danger)]/30 bg-[var(--danger-soft)] px-3 py-2 text-[12px] text-[var(--danger)]">
            With robots.txt off, only scan sites you own or are explicitly authorised to crawl.
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
