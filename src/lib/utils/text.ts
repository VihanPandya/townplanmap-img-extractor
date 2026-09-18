/** Collapse whitespace and trim; returns null for empty results. */
export function cleanText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text.slice(0, 500) : null;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Split a path-ish string into searchable tokens, e.g. "ahmedabad-tp-map" → [ahmedabad, tp, map]. */
export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/%[0-9a-f]{2}/gi, ' ')
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}
