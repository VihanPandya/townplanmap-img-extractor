'use client';

import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  CircleDashed,
  Loader2,
  Pause,
  Play,
  Square,
} from 'lucide-react';
import { Badge, Button, cx, StatTile } from '@/components/ui/primitives';
import type { ScanDetail, ScanPhase } from '@/lib/types';
import { formatBytes } from '@/lib/utils/text';

const STEPS: Array<{ phase: ScanPhase; label: string }> = [
  { phase: 'validating', label: 'Website connected' },
  { phase: 'robots', label: 'Robots.txt checked' },
  { phase: 'crawling', label: 'Pages discovered and parsed' },
  { phase: 'verifying', label: 'Image references verified' },
  { phase: 'deduplicating', label: 'Duplicates consolidated' },
];

const PHASE_ORDER: ScanPhase[] = ['idle', 'validating', 'robots', 'crawling', 'verifying', 'deduplicating', 'done'];

function stepState(step: ScanPhase, current: ScanPhase): 'done' | 'active' | 'pending' {
  const currentIndex = PHASE_ORDER.indexOf(current);
  const stepIndex = PHASE_ORDER.indexOf(step);
  if (current === 'done') return 'done';
  if (stepIndex < currentIndex) return 'done';
  if (stepIndex === currentIndex) return 'active';
  return 'pending';
}

export function ScanProgress({
  scan,
  onPause,
  onResume,
  onStop,
}: {
  scan: ScanDetail;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}) {
  const [showIssues, setShowIssues] = useState(false);
  const live = scan.status === 'running' || scan.status === 'paused' || scan.status === 'stopping';
  const progress = scan.progress;

  const percent = Math.round((scan.status === 'completed' || scan.status === 'stopped' ? 1 : progress.fraction) * 100);

  const recentIssues = useMemo(() => [...scan.issues].reverse().slice(0, 25), [scan.issues]);

  return (
    <section className="surface-raised overflow-hidden" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {live && scan.status !== 'paused' ? (
            <Loader2 size={15} className="shrink-0 animate-spin text-[var(--accent)]" />
          ) : scan.status === 'failed' ? (
            <AlertTriangle size={15} className="shrink-0 text-[var(--danger)]" />
          ) : (
            <Check size={15} className="shrink-0 text-[var(--positive)]" />
          )}
          <div className="min-w-0">
            <h2 className="truncate text-[13.5px] font-semibold">
              {scan.status === 'running'
                ? 'Scan in progress'
                : scan.status === 'paused'
                  ? 'Scan paused'
                  : scan.status === 'stopping'
                    ? 'Stopping scan'
                    : scan.status === 'stopped'
                      ? 'Scan stopped'
                      : scan.status === 'failed'
                        ? 'Scan failed'
                        : 'Scan complete'}
            </h2>
            <p className="truncate text-[12px] text-[var(--text-muted)]" title={progress.currentUrl ?? scan.url}>
              {progress.message}
            </p>
          </div>
        </div>

        {live ? (
          <div className="flex items-center gap-2">
            {scan.status === 'paused' ? (
              <Button size="sm" icon={<Play size={13} />} onClick={onResume}>
                Resume
              </Button>
            ) : (
              <Button size="sm" icon={<Pause size={13} />} onClick={onPause} disabled={scan.status === 'stopping'}>
                Pause
              </Button>
            )}
            <Button size="sm" variant="danger" icon={<Square size={12} />} onClick={onStop}>
              Stop
            </Button>
          </div>
        ) : null}
      </div>

      <div className="h-1 w-full bg-[var(--panel-inset)]">
        <div
          className={cx(
            'h-full rounded-r-full bg-[var(--accent)] transition-[width] duration-500 ease-out',
            live && scan.status !== 'paused' && 'animate-pulse',
          )}
          style={{ width: `${Math.max(2, percent)}%` }}
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Scan progress"
        />
      </div>

      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
        <ol className="space-y-1.5">
          {STEPS.map((step) => {
            const state = stepState(step.phase, progress.phase);
            return (
              <li key={step.phase} className="flex items-center gap-2 text-[12.5px]">
                {state === 'done' ? (
                  <Check size={13} className="shrink-0 text-[var(--positive)]" />
                ) : state === 'active' ? (
                  <Loader2 size={13} className="shrink-0 animate-spin text-[var(--accent)]" />
                ) : (
                  <CircleDashed size={13} className="shrink-0 text-[var(--text-faint)]" />
                )}
                <span className={state === 'pending' ? 'text-[var(--text-faint)]' : undefined}>{step.label}</span>
              </li>
            );
          })}
        </ol>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
          <StatTile
            label="Pages"
            value={`${progress.pagesScanned}/${progress.maxPages}`}
            hint={progress.pagesQueued > 0 ? `${progress.pagesQueued} queued` : 'queue empty'}
          />
          <StatTile label="References" value={progress.references} hint="raw image references" />
          <StatTile label="Unique" value={progress.uniqueImages} tone="accent" hint="after URL dedupe" />
          <StatTile label="Duplicates" value={progress.duplicates} hint="repeat references" />
          <StatTile
            label="Verified"
            value={progress.verified}
            hint={`${formatBytes(progress.bytesFetched)} fetched`}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-[var(--border)] px-4 py-2.5 text-[12px]">
        <span className="flex items-center gap-1.5">
          <span className="text-[var(--text-faint)]">Domain</span>
          <span className="font-mono">{scan.host}</span>
        </span>

        {scan.robots ? (
          <span className="flex items-center gap-1.5" title={scan.robots.note ?? undefined}>
            <span className="text-[var(--text-faint)]">Robots.txt</span>
            {scan.robots.found ? (
              <Badge tone="positive">
                <Check size={9} /> checked
              </Badge>
            ) : (
              <Badge>not published</Badge>
            )}
            <span className="text-[var(--text-muted)]">
              {scan.robots.policy === 'respecting'
                ? `respecting applicable rules${scan.robots.disallowedPaths > 0 ? ` (${scan.robots.disallowedPaths} disallowed paths)` : ''}`
                : scan.robots.policy === 'ignored-by-setting'
                  ? 'rules not applied by setting'
                  : 'rules unavailable'}
            </span>
          </span>
        ) : null}

        {scan.robots?.crawlDelayMs ? (
          <span className="flex items-center gap-1.5">
            <span className="text-[var(--text-faint)]">Crawl-delay</span>
            <span className="font-mono">{scan.robots.crawlDelayMs} ms</span>
          </span>
        ) : null}

        {progress.pagesFailed > 0 || scan.issues.length > 0 ? (
          <button
            type="button"
            onClick={() => setShowIssues((previous) => !previous)}
            className="ml-auto flex items-center gap-1.5 text-[var(--warning)] hover:underline"
            aria-expanded={showIssues}
          >
            <AlertTriangle size={12} />
            {scan.issues.length} issue{scan.issues.length === 1 ? '' : 's'}
            <ChevronDown size={12} className={cx('transition-transform', showIssues && 'rotate-180')} />
          </button>
        ) : null}
      </div>

      {showIssues ? (
        <ul className="max-h-64 space-y-1.5 overflow-y-auto border-t border-[var(--border)] bg-[var(--panel-inset)] p-3">
          {recentIssues.map((issue) => (
            <li key={issue.id} className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2">
              <div className="flex items-start justify-between gap-2">
                <span className="text-[12.5px] font-medium">{issue.title}</span>
                <Badge tone={issue.kind === 'robots' ? 'accent' : 'warning'}>{issue.kind}</Badge>
              </div>
              {issue.url ? (
                <p className="mt-0.5 truncate font-mono text-[11px] text-[var(--text-faint)]" title={issue.url}>
                  {issue.url}
                </p>
              ) : null}
              <p className="mt-1 text-[11.5px] whitespace-pre-line text-[var(--text-muted)]">{issue.detail}</p>
            </li>
          ))}
          {recentIssues.length === 0 ? (
            <li className="px-1 py-2 text-[12px] text-[var(--text-muted)]">No issues were recorded.</li>
          ) : null}
        </ul>
      ) : null}
    </section>
  );
}
