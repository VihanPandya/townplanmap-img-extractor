# TownPlanMap Image Explorer

A website asset discovery and inspection tool. Enter a website address; the
server crawls the pages it is permitted to fetch, extracts every image reference
and geographic data file it can find in the returned HTML and CSS, verifies which
of those are actually retrievable, consolidates duplicates, and presents the
result as a searchable, filterable gallery.

Both raster imagery (village and town plan maps, photos, logos, icons) and the
geographic data published alongside it (**KML, KMZ, GeoJSON, GPX, GML, zipped
shapefiles**) travel through the same pipeline, and either can be exported as
metadata or downloaded as a ZIP archive.

It ships pointed at `https://townplanmap.com`, but the target is editable and the
application is entirely dynamic — no image URLs, filenames, counts or categories
are hard-coded anywhere.

---

## Quick start

Requires **Node 22.6 or newer** (Next.js itself needs 20.9+; the test runner
uses native TypeScript type stripping, which landed in 22.6).

```bash
npm install
npm run dev          # http://localhost:3000
```

```bash
npm run build && npm start     # production
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build and server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (flat config); `npm run lint:fix` to autofix |
| `npm test` | 61 unit + end-to-end tests against a local fixture site |
| `npm run test:browser` | Browser walkthrough (needs a running server — see below) |

---

## How a scan works

```
  validate URL ──► robots.txt ──► sitemap seed ──► crawl ──► extract
                                                               │
       gallery ◄── deduplicate ◄── verify ◄── classify ◄── normalise
```

1. **Validate.** The address is parsed, restricted to `http(s)`, and its hostname
   is resolved. Anything that is not a globally routable address is refused.
2. **robots.txt.** Fetched and parsed before any page request. Disallow rules are
   obeyed, and a `Crawl-delay` longer than the configured delay wins.
3. **Seed.** Sitemaps advertised in robots.txt are read to find pages that are not
   linked from the entry page.
4. **Crawl.** A breadth-first frontier bounded by max pages, max depth, a request
   delay and a concurrency limit. URLs are normalised, fragments dropped and
   already-seen pages skipped, so the crawl cannot loop.
5. **Extract.** Each page is parsed into an inert DOM (cheerio — no scripts run)
   and scanned for every reference type listed below.
6. **Normalise.** Relative URLs are resolved against the page, honouring
   `<base href>`. The original string is always preserved alongside the resolved
   one.
7. **Verify.** Each unique asset is requested once, with the read stopping as soon
   as the dimensions are known. This is where width, height, MIME type, byte size
   and availability come from.
8. **Deduplicate.** By canonical URL, then by SHA-256 of the response body.
9. **Classify.** A weighted heuristic over observable signals, with the reasoning
   shown to the user and overridable by them.

Results stream to the browser while the crawl is still running: the client polls
with a cursor and receives only assets discovered since its last request.

### Where geographic data files are found

KML and KMZ are almost never image elements: they are plain "Download KML"
anchors, map-widget data attributes (`data-kml`, `data-layer`, `data-geojson`)
or layer URLs passed as query parameters to an embedded map viewer. All three
are covered. A file is only treated as geographic data when its extension says
so, so an ordinary `.zip` is left alone while `boundaries-shp.zip` is not.

Geographic files are verified by content, not just by name: a KMZ must really be
a zip, a GeoJSON must really be JSON, and a `.kml` that turns out to be an HTML
error page is reported as `Unsupported` rather than quietly accepted.

### Where images are found

`<img src>` · `srcset` candidates · `<picture><source>` · lazy-loading attributes
(`data-src`, `data-original`, `data-lazy-src`, `data-srcset` and ~20 more, each
probed rather than assumed) · `og:image` / `og:image:url` / `og:image:secure_url` ·
`twitter:image` · JSON-LD and `ImageObject` metadata · `<link rel="icon">` and
friends · inline `style="background-image:url(…)"` · `<style>` blocks ·
same-origin stylesheets · `<video poster>` · `<image>` inside inline SVG ·
`<input type="image">`.

### Duplicate detection

| Layer | Basis | Confidence |
| --- | --- | --- |
| URL identity | Canonical URL — tracking and cache-buster parameters removed, query ordered | Exact |
| Content identity | SHA-256 of the full response body, when the body was read in full | Exact |
| Variant grouping | Responsive derivatives (`photo-300x200.jpg`, `photo@2x.jpg`, `photo.jpg?w=300`) | Related, never hidden |

Perceptual hashing is deliberately **not** claimed: without decoding image pixels
server-side it cannot be done honestly, so related-but-different renditions are
grouped and labelled as variants instead of being silently merged.

---

## Honesty rules the code follows

These are the constraints that shaped the implementation, not aspirations:

- **Availability is never inferred from a URL appearing in HTML.** An asset the
  scanner did not request keeps the status `Not verified`. Dimensions are only
  reported when they were read from the image's own bytes.
- **Categories are labelled "detected", with their reasoning shown**, and the user
  can override any of them. Overrides flow through to exports.
- **Exports contain references and metadata only.** The separate *download*
  action is the one path that retrieves file contents, and it is opt-in: it
  refuses to run without an explicit statement that you have the right to
  retrieve the files, and records that statement in the archive's manifest
  alongside every file's source URL. Discovering a publicly reachable file
  grants no right to redistribute it.
- **No JavaScript from scanned pages is executed**, on the server or in the client.
  Client-rendered images are therefore genuinely out of reach, and the tool does
  not pretend otherwise.
- **Nothing is bypassed.** No authentication, paywalls, access controls or
  anti-bot measures. A 401/403 is reported as a result, not worked around.

---

## Security

The application accepts user-supplied URLs, so the outbound path is the attack
surface. Every request in the app — pages, stylesheets, images, robots.txt,
sitemaps and the preview relay — goes through one guarded fetcher
(`src/lib/security/http.ts`).

| Threat | Mitigation |
| --- | --- |
| SSRF to loopback / private / link-local / CGNAT / multicast / reserved ranges | Hostname resolved and every returned address classified before the request; IPv4, IPv6, IPv4-mapped and NAT64-embedded forms all covered |
| Cloud metadata endpoints (`169.254.169.254`, `metadata.google.internal`) | Blocked by both address range and hostname pattern |
| DNS rebinding | The connect-time DNS lookup is re-validated inside the dispatcher, so the socket can only reach an address that passed the check |
| Non-HTTP protocol handlers (`file:`, `ftp:`, `gopher:`, `javascript:`, `data:`) | Protocol allowlist, applied again on every redirect hop |
| Credentials in URLs | Rejected |
| SSRF pivots to non-web services | Port denylist (SSH, SMB, Redis, Postgres, Docker, …) |
| Redirect loops | Manual redirect following with a hop limit; each hop re-validated |
| Oversized responses / decompression bombs | Byte cap enforced on *decompressed* output, both inside zlib (`maxOutputLength`) and while reading the stream |
| Slowloris / hanging hosts | Connect, headers, body and whole-request timeouts |
| Malicious HTML | Parsed into an inert DOM; no scripts, no styles resolved, no subresource loads |
| Open image proxy | The preview relay accepts only ids already present in a stored scan — never a caller-supplied URL — and returns image content types with `nosniff` |
| Bulk download abuse | The download route likewise fetches only ids from a stored scan, requires an explicit acknowledgement, and caps file count, per-file size and total archive size |
| Zip-slip on extraction | Archive entry names keep only the final path segment, with traversal, absolute paths, control characters and reserved characters stripped |

### The one escape hatch

`SCANNER_ALLOW_PRIVATE_HOSTS=1` disables the private-address guard. It exists so
the test suite can scan a fixture server on `127.0.0.1`. It is off unless
explicitly set, and must never be set in a deployment that accepts untrusted
input. See `.env.example`.

`SCANNER_PROXY_URL` (falling back to `HTTPS_PROXY`) routes scanner traffic
through a forward proxy for environments without direct egress. Note the
trade-off documented in `.env.example`: with a proxy, DNS happens at the proxy,
so connect-time address pinning no longer applies.

---

## Architecture

```
src/
  app/
    api/scan/                POST start · GET history
    api/scan/[id]/           GET status, pages, issues · DELETE stop
    api/scan/[id]/control/   POST pause | resume | stop
    api/scan/[id]/images/    GET assets, incremental via ?since=<cursor>
    api/image/[id]/          GET one asset with every reference
    api/export/              POST csv | json | txt
    api/preview/[id]/        GET guarded image relay (fallback preview only)
    api/download/            POST selected assets as a streamed ZIP archive
  components/                UrlInput, ScanProgress, FilterPanel, SearchBar,
                             ImageGrid, ImageCard, ImageViewer, SelectionToolbar,
                             ExportMenu, ScanHistory, EmptyState, dialogs, ui/
  lib/
    security/                url-guard, ip classification, guarded HTTP client
    crawler/                 robots.txt engine, sitemap reader
    extractor/               HTML, CSS and JSON-LD extraction
    normalizer/              URL resolution/canonicalisation, srcset parser
    deduplicator/            URL, content-hash and variant grouping
    classifier/              weighted heuristic classification
    probe/                   image verification (dimensions, status, hash)
    scan/                    the engine that ties it together
    database/                ScanStore interface + in-memory implementation
    export/                  CSV / JSON / TXT serialisers
    download/                dependency-free streaming ZIP writer
    client/                  typed API client, scan session hook, filter logic
tests/                       unit, end-to-end and browser suites + fixture site
```

**Storage.** Scan results live in an in-process store with a bounded count and a
TTL, which suits disposable per-session results. `ScanStore`
(`src/lib/database/store.ts`) is a narrow interface — `create`, `get`, `list`,
`images`, `image`, `touch`, `remove` — so a PostgreSQL adapter can be substituted
without touching the crawler, the engine or the API routes.

**Performance.** The gallery is windowed: only the rows intersecting the viewport
are mounted, previews load lazily, and full-resolution images are never all held
in memory. Filtering, searching and sorting run client-side over the already
downloaded set, so they are instant.

---

## Settings

Defaults are deliberately conservative and every value is clamped server-side.

| Setting | Default | Range |
| --- | --- | --- |
| Maximum pages | 100 | 1 – 500 |
| Maximum depth | 3 | 0 – 8 |
| Request delay | 500 ms | 0 – 10 000 ms |
| Concurrent requests | 3 | 1 – 8 |
| Minimum image width / height | 100 px | 0 – 5000 px |
| Maximum images | 1500 | 10 – 5000 |
| Respect robots.txt | on | |
| Verify images | on | |
| Seed from sitemap | on | |
| Scan stylesheets | on | |
| Include subdomains | off | |
| Include external image domains | off | |

Minimum dimensions filter the gallery rather than discarding data: assets below
the threshold are collected, flagged, and reachable behind a one-click "show".

---

## Testing

```bash
npm test          # 45 tests, no network access required
```

The suite runs against a local fixture site (`tests/fixture/site.mjs`) that
deliberately exercises the awkward cases: every reference type, document-relative
and root-relative spellings of one asset, tracking parameters, a responsive
variant set, a byte-identical duplicate under a second name, a 404 image, a 403
page, a redirect, an image served as `text/plain`, a gzipped HTML response, a
robots.txt disallow, an external host and a sitemap.

The ZIP writer is validated by extracting its output with the system `unzip`,
including a CRC check (`unzip -t`), rather than by the code that wrote it.

Coverage includes: IPv4/IPv6/hostname SSRF classification, protocol and port
rejection, geographic format detection, KML/KMZ/GeoJSON discovery and content
verification, zip-slip resistance, the download acknowledgement gate, `srcset` parsing (including commas inside URLs), URL resolution and
canonicalisation, robots.txt group selection and wildcard/anchor matching, CSS
and JSON-LD extraction, variant grouping, the full scan pipeline, verification
statuses, content-hash deduplication, crawl limits and clamping, stop-preserves-
results, cursor paging, and CSV/JSON/TXT export shape and quoting.

`npm run test:browser` additionally drives the finished UI in Chromium — scan,
progress dashboard, search, filters, viewer, category override, selection, CSV
download, KML/KMZ discovery, the file-kind filter, the download acknowledgement
gate and a real ZIP round trip, all three view modes, both themes and a 390 px
mobile viewport — and asserts no console errors. It needs a running server:

```bash
npm run build
SCANNER_ALLOW_PRIVATE_HOSTS=1 npx next start -p 3111
npm run test:browser
```

---

## Known limits

- **Client-rendered images are not discovered.** The scanner reads server-returned
  markup only, by design — executing untrusted page JavaScript on the server is
  not a trade worth making.
- **Content hashes are only computed for bodies read in full** (up to ~2 MB).
  Larger assets are verified and measured but not hash-deduplicated, and report
  `contentHash: null` rather than a partial digest presented as a full one.
- **Scan history is in-memory**, so it does not survive a server restart and is
  not shared between instances. The store interface is where persistence would go.
- **Downloads are capped** at 500 files, 64 MB per file and 1 GB per archive, and
  the archive is stored (not deflated) since image data is already compressed.
  Assets that failed verification are never re-attempted; they are listed in the
  manifest as skipped, with the reason.
