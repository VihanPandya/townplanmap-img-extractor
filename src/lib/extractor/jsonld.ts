/**
 * Pull image URLs out of JSON-LD / structured metadata.
 *
 * The JSON is parsed, never evaluated, and the walk is depth- and size-bounded
 * so a hostile document cannot make the extractor spin.
 */

const IMAGE_KEYS = new Set([
  'image',
  'images',
  'logo',
  'thumbnail',
  'thumbnailurl',
  'contenturl',
  'primaryimageofpage',
  'photo',
  'screenshot',
  'icon',
]);

const MAX_DEPTH = 8;
const MAX_RESULTS = 200;

export interface JsonLdImage {
  url: string;
  /** The @type of the enclosing node, when present - a useful classification hint. */
  nodeType: string | null;
  key: string;
}

export function extractJsonLdImages(raw: string): JsonLdImage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const out: JsonLdImage[] = [];
  walk(parsed, null, null, 0, out);
  return out;
}

function walk(node: unknown, key: string | null, nodeType: string | null, depth: number, out: JsonLdImage[]): void {
  if (out.length >= MAX_RESULTS || depth > MAX_DEPTH || node == null) return;

  if (typeof node === 'string') {
    if (key && IMAGE_KEYS.has(key) && looksLikeUrl(node)) {
      out.push({ url: node, nodeType, key });
    }
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) walk(item, key, nodeType, depth + 1, out);
    return;
  }

  if (typeof node === 'object') {
    const record = node as Record<string, unknown>;
    const typeValue = record['@type'];
    const currentType =
      typeof typeValue === 'string'
        ? typeValue
        : Array.isArray(typeValue) && typeof typeValue[0] === 'string'
          ? (typeValue[0] as string)
          : nodeType;

    // An ImageObject carries its URL in `url`, which is not otherwise an image key.
    if (typeof currentType === 'string' && /imageobject/i.test(currentType)) {
      const url = record['url'] ?? record['contentUrl'];
      if (typeof url === 'string' && looksLikeUrl(url)) {
        out.push({ url, nodeType: currentType, key: key ?? 'ImageObject' });
      }
    }

    for (const [childKey, value] of Object.entries(record)) {
      if (childKey.startsWith('@') && childKey !== '@graph') continue;
      walk(value, childKey.toLowerCase(), currentType, depth + 1, out);
    }
  }
}

function looksLikeUrl(value: string): boolean {
  const text = value.trim();
  if (!text || text.length > 2048) return false;
  return /^(https?:)?\/\//i.test(text) || text.startsWith('/') || /^[\w./-]+\.(jpe?g|png|webp|gif|svg|avif)$/i.test(text);
}
