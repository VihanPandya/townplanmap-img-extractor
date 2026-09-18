/**
 * Extract `url(...)` references from CSS text.
 *
 * The CSS is never executed - it is scanned with a tolerant regex that copes
 * with quoted and unquoted forms, `image-set()` and multiple backgrounds.
 */

const URL_PATTERN = /url\(\s*(?:'([^']*)'|"([^"]*)"|([^)'"]+))\s*\)/gi;

export interface CssImageRef {
  url: string;
  /** The declaration the URL appeared in, used as a classification hint. */
  context: string | null;
}

const IMAGE_PROPERTY = /(background(?:-image)?|border-image(?:-source)?|list-style(?:-image)?|mask(?:-image)?|content|cursor|src)\s*:/i;

export function extractCssUrls(css: string, limit = 400): CssImageRef[] {
  const out: CssImageRef[] = [];
  const seen = new Set<string>();

  URL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_PATTERN.exec(css)) !== null) {
    if (out.length >= limit) break;
    const raw = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!raw || raw.startsWith('#')) continue;
    if (/^data:/i.test(raw) || /^blob:/i.test(raw) || /^about:/i.test(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);

    // Look back a little to find which property this belonged to.
    const lookBehind = css.slice(Math.max(0, match.index - 120), match.index);
    const property = IMAGE_PROPERTY.exec(lookBehind);
    const selector = findSelector(css, match.index);
    const context = [property?.[1]?.toLowerCase() ?? null, selector].filter(Boolean).join(' ') || null;

    out.push({ url: raw, context });
  }

  return out;
}

/** Best-effort selector text for the rule containing `index`. */
function findSelector(css: string, index: number): string | null {
  const open = css.lastIndexOf('{', index);
  if (open === -1) return null;
  const prevClose = Math.max(css.lastIndexOf('}', open), css.lastIndexOf(';', open));
  const selector = css.slice(prevClose + 1, open).replace(/\s+/g, ' ').trim();
  if (!selector || selector.length > 160) return null;
  return selector;
}

/** `@import` targets, so a single level of imported sheets can be followed. */
export function extractCssImports(css: string): string[] {
  const out: string[] = [];
  const pattern = /@import\s+(?:url\(\s*)?(?:'([^']+)'|"([^"]+)"|([^\s);]+))/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(css)) !== null) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? '').trim().replace(/\)$/, '');
    if (raw && !/^data:/i.test(raw)) out.push(raw);
  }
  return out;
}
