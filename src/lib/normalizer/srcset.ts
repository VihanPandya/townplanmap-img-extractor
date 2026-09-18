/**
 * Parser for the `srcset` attribute.
 *
 * Handles the comma-inside-URL problem by scanning candidate by candidate
 * rather than splitting the whole string on commas.
 */

export interface SrcsetCandidate {
  url: string;
  /** Raw descriptor as written, e.g. "1280w" or "2x". Null when omitted. */
  descriptor: string | null;
  /** Width in px when the descriptor was a `w` descriptor. */
  width: number | null;
  /** Pixel density when the descriptor was an `x` descriptor. */
  density: number | null;
}

export function parseSrcset(value: string | null | undefined): SrcsetCandidate[] {
  if (!value) return [];
  const input = value.trim();
  const candidates: SrcsetCandidate[] = [];
  let index = 0;

  const isSpace = (char: string) => char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';

  while (index < input.length) {
    while (index < input.length && (isSpace(input[index]!) || input[index] === ',')) index += 1;
    if (index >= input.length) break;

    const urlStart = index;
    while (index < input.length && !isSpace(input[index]!)) index += 1;
    let url = input.slice(urlStart, index);

    // A URL may legally end with commas when no descriptor follows.
    let trailingComma = false;
    while (url.endsWith(',')) {
      url = url.slice(0, -1);
      trailingComma = true;
    }
    if (!url) continue;

    let descriptor: string | null = null;
    if (!trailingComma) {
      while (index < input.length && isSpace(input[index]!)) index += 1;
      const descStart = index;
      while (index < input.length && input[index] !== ',') index += 1;
      const raw = input.slice(descStart, index).trim();
      if (raw) descriptor = raw;
      if (input[index] === ',') index += 1;
    }

    const widthMatch = descriptor ? /^(\d+(?:\.\d+)?)w$/i.exec(descriptor) : null;
    const densityMatch = descriptor ? /^(\d+(?:\.\d+)?)x$/i.exec(descriptor) : null;

    candidates.push({
      url,
      descriptor,
      width: widthMatch ? Math.round(Number(widthMatch[1])) : null,
      density: densityMatch ? Number(densityMatch[1]) : null,
    });
  }

  return candidates;
}
