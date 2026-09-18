/**
 * A small fixture website used by the end-to-end test.
 *
 * It deliberately exercises every discovery path the extractor claims to
 * support, plus the awkward cases: duplicate references, a redirect, a 404, a
 * 403, an image served under the wrong content type, and a page disallowed by
 * robots.txt.
 */
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';

/** Minimal valid images, generated rather than stored as binary fixtures. */
function pngOfSize(width, height) {
  // A real PNG header the `image-size` library can parse, followed by a
  // single IDAT chunk. Only the header matters for dimension detection.
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // colour type RGBA
  const ihdr = chunk('IHDR', ihdrData);
  const idat = chunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01]));
  const iend = chunk('IEND', Buffer.alloc(0));
  return Buffer.concat([signature, ihdr, idat, iend]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])) >>> 0, 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

function svg(width, height) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#456"/></svg>`,
  );
}

const IMAGES = {
  '/img/ahmedabad-town-plan-map.png': pngOfSize(1600, 1200),
  '/img/ahmedabad-town-plan-map-300x225.png': pngOfSize(300, 225),
  '/img/hero-banner.png': pngOfSize(1920, 480),
  '/img/site-logo.svg': svg(160, 48),
  '/img/icon-pin.png': pngOfSize(24, 24),
  '/img/lazy-parcel-plan.png': pngOfSize(1024, 768),
  '/img/og-share-card.png': pngOfSize(1200, 630),
  '/img/gallery-photo.png': pngOfSize(800, 600),
  '/img/css-texture.png': pngOfSize(512, 512),
  '/img/sheet-background.png': pngOfSize(1440, 900),
  '/img/poster-frame.png': pngOfSize(640, 360),
  '/img/schema-thumb.png': pngOfSize(400, 400),
  '/img/duplicate-copy.png': pngOfSize(800, 600), // byte-identical to gallery-photo
  '/favicon.ico': pngOfSize(32, 32),
};

const PAGES = {
  '/': `<!doctype html><html><head>
<title>TownPlanMap fixture — home</title>
<base href="/">
<meta property="og:image" content="/img/og-share-card.png">
<meta name="twitter:image" content="https://EXTERNAL_HOST/img/external-card.png">
<link rel="icon" href="/favicon.ico">
<link rel="stylesheet" href="/styles/site.css">
<style>.texture { background-image: url('/img/css-texture.png'); }</style>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"WebPage","image":"/img/schema-thumb.png",
 "publisher":{"@type":"Organization","logo":{"@type":"ImageObject","url":"/img/site-logo.svg"}}}
</script>
</head><body>
<header class="site-header"><img src="/img/site-logo.svg" alt="TownPlanMap logo" width="160" height="48"></header>
<section class="hero" style="background-image:url(/img/hero-banner.png)">
  <h1>Town planning maps</h1>
</section>
<figure>
  <img src="img/gallery-photo.png" alt="Survey team on site" width="800" height="600">
  <figcaption>Field survey</figcaption>
</figure>
<img src="/img/icon-pin.png" alt="" width="24" height="24">
<img data-src="/img/lazy-parcel-plan.png" data-srcset="/img/lazy-parcel-plan.png 1024w" alt="Parcel plan" class="lazyload">
<video poster="/img/poster-frame.png"></video>
<nav>
  <a href="/maps/ahmedabad">Ahmedabad</a>
  <a href="/gallery">Gallery</a>
  <a href="/broken">Broken page</a>
  <a href="/forbidden">Forbidden page</a>
  <a href="/private/secret">Disallowed page</a>
  <a href="https://EXTERNAL_HOST/other">External site</a>
  <a href="/brochure.pdf">Brochure</a>
</nav>
</body></html>`,

  '/maps/ahmedabad': `<!doctype html><html><head>
<title>Ahmedabad town planning scheme map</title>
<meta property="og:image" content="/img/og-share-card.png">
</head><body>
<h1>Ahmedabad TP scheme</h1>
<picture>
  <source type="image/png" srcset="/img/ahmedabad-town-plan-map-300x225.png 300w, /img/ahmedabad-town-plan-map.png 1600w">
  <img src="/img/ahmedabad-town-plan-map.png" alt="Ahmedabad town plan map" title="TP scheme 42">
</picture>
<img srcset="/img/ahmedabad-town-plan-map-300x225.png 300w, /img/ahmedabad-town-plan-map.png 1600w"
     src="/img/ahmedabad-town-plan-map.png" alt="Ahmedabad town plan map">
<img src="/img/ahmedabad-town-plan-map.png?utm_source=newsletter&v=3" alt="Same map with tracking parameters">
<img src="/img/missing-image.png" alt="This one does not exist">
<img src="/not-really-an-image" alt="Served as text/plain">
<img src="/img/redirect-to-map" alt="Redirected map">
<a href="/">Home</a>
</body></html>`,

  '/gallery': `<!doctype html><html><head><title>Gallery</title></head><body>
<h1>Gallery</h1>
<img src="/img/gallery-photo.png" alt="Survey team on site">
<img src="/img/duplicate-copy.png" alt="Same photo under a different name">
<a href="/">Home</a>
</body></html>`,

  '/private/secret': `<!doctype html><html><head><title>Disallowed</title></head><body>
<img src="/img/should-never-be-seen.png" alt="Must not be discovered">
</body></html>`,
};

const CSS = `
@media screen {
  .sheet-bg { background-image: url("/img/sheet-background.png"); }
  .inline-data { background-image: url(data:image/gif;base64,R0lGODlhAQABAAAAACw=); }
}
`;

export function startFixtureSite() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const pathname = url.pathname;
    const host = request.headers.host ?? 'localhost';

    if (pathname === '/robots.txt') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('User-agent: *\nDisallow: /private/\nCrawl-delay: 0\nSitemap: http://' + host + '/sitemap.xml\n');
      return;
    }

    if (pathname === '/sitemap.xml') {
      response.writeHead(200, { 'content-type': 'application/xml' });
      response.end(
        `<?xml version="1.0"?><urlset><url><loc>http://${host}/gallery</loc></url><url><loc>http://${host}/maps/ahmedabad</loc></url></urlset>`,
      );
      return;
    }

    if (pathname === '/img/redirect-to-map') {
      response.writeHead(302, { location: '/img/ahmedabad-town-plan-map.png' });
      response.end();
      return;
    }

    if (pathname === '/not-really-an-image') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('definitely not an image');
      return;
    }

    if (pathname === '/forbidden') {
      response.writeHead(403, { 'content-type': 'text/html' });
      response.end('<h1>Forbidden</h1>');
      return;
    }

    if (pathname === '/styles/site.css') {
      response.writeHead(200, { 'content-type': 'text/css' });
      response.end(CSS);
      return;
    }

    const image = IMAGES[pathname];
    if (image) {
      const type = pathname.endsWith('.svg')
        ? 'image/svg+xml'
        : pathname.endsWith('.ico')
          ? 'image/x-icon'
          : 'image/png';
      response.writeHead(200, { 'content-type': type, 'content-length': image.length });
      response.end(image);
      return;
    }

    const page = PAGES[pathname] ?? PAGES[pathname.replace(/\/$/, '')];
    if (page) {
      // Served gzipped so the decompressed byte accounting is exercised too.
      const body = gzipSync(Buffer.from(page.replaceAll('EXTERNAL_HOST', 'cdn.example.invalid'), 'utf8'));
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-encoding': 'gzip',
      });
      response.end(body);
      return;
    }

    response.writeHead(404, { 'content-type': 'text/html' });
    response.end('<h1>Not found</h1>');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
