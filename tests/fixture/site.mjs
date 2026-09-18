/**
 * A small fixture website used by the end-to-end test.
 *
 * It deliberately exercises every discovery path the extractor claims to
 * support, plus the awkward cases: duplicate references, a redirect, a 404, a
 * 403, an image served under the wrong content type, and a page disallowed by
 * robots.txt.
 */
import { createServer } from 'node:http';
import { deflateRawSync, gzipSync } from 'node:zlib';

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
  '/img/village-boundary-map.png': pngOfSize(1400, 1000),
  '/img/survey-125-2.png': pngOfSize(2048, 1536),
  '/img/survey-126-1.png': pngOfSize(1024, 768),
  '/img/town-plan-gandhinagar.png': pngOfSize(1200, 900),
};

function kml(name) {
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${name}</name>
<Placemark><name>${name} boundary</name><Point><coordinates>72.5714,23.0225,0</coordinates></Point></Placemark>
</Document></kml>`,
  );
}

/** A real (single-entry, stored) zip so KMZ sniffing is genuinely exercised. */
function kmz(name) {
  const inner = kml(name);
  const entryName = Buffer.from('doc.kml', 'utf8');
  const table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  let crc = 0xffffffff;
  for (const byte of inner) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(inner.length, 18);
  local.writeUInt32LE(inner.length, 22);
  local.writeUInt16LE(entryName.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(inner.length, 20);
  central.writeUInt32LE(inner.length, 24);
  central.writeUInt16LE(entryName.length, 28);
  central.writeUInt32LE(0, 42);

  const directory = Buffer.concat([central, entryName]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(local.length + entryName.length + inner.length, 16);

  return Buffer.concat([local, entryName, inner, directory, end]);
}

function villageKml() {
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
<name>Ahmedabad district</name>
<Folder><name>Bopal</name>
  <Placemark>
    <name>Survey No. 125/2</name>
    <description>Agricultural land</description>
    <ExtendedData>
      <Data name="village"><value>Bopal</value></Data>
      <Data name="district"><value>Ahmedabad</value></Data>
      <Data name="area_hectares"><value>2.34</value></Data>
    </ExtendedData>
    <Polygon><outerBoundaryIs><LinearRing><coordinates>
      72.4500,23.0300,0 72.4520,23.0300,0 72.4520,23.0320,0 72.4500,23.0320,0 72.4500,23.0300,0
    </coordinates></LinearRing></outerBoundaryIs></Polygon>
  </Placemark>
  <Placemark>
    <name>Survey No. 126/1</name>
    <ExtendedData><Data name="village"><value>Bopal</value></Data><Data name="district"><value>Ahmedabad</value></Data></ExtendedData>
    <Polygon><outerBoundaryIs><LinearRing><coordinates>
      72.4530,23.0300,0 72.4550,23.0300,0 72.4550,23.0320,0 72.4530,23.0320,0 72.4530,23.0300,0
    </coordinates></LinearRing></outerBoundaryIs></Polygon>
  </Placemark>
</Folder>
<Folder><name>Shela</name>
  <Placemark>
    <name>Survey No. 127/4</name>
    <ExtendedData><Data name="village"><value>Shela</value></Data><Data name="district"><value>Ahmedabad</value></Data></ExtendedData>
    <Point><coordinates>72.4700,23.0200</coordinates></Point>
  </Placemark>
</Folder>
<GroundOverlay>
  <name>Bopal scanned sheet</name>
  <Icon><href>http://GEO_HOST/img/survey-125-2.png</href></Icon>
  <LatLonBox><north>23.0320</north><south>23.0300</south><east>72.4520</east><west>72.4500</west></LatLonBox>
</GroundOverlay>
</Document></kml>`);
}

/** A projected GeoJSON, so CRS transformation is exercised end to end. */
function projectedGeoJson() {
  return Buffer.from(JSON.stringify({
    type: 'FeatureCollection',
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3857' } },
    features: [{
      type: 'Feature',
      properties: { survey_no: '200/1', village: 'Sanand', district: 'Ahmedabad' },
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [8065000, 2632000], [8065200, 2632000], [8065200, 2632200], [8065000, 2632200], [8065000, 2632000],
        ]],
      },
    }],
  }));
}

const GEO_FILES = {
  '/data/ahmedabad-district-villages.kml': { body: villageKml(), type: 'application/vnd.google-earth.kml+xml', rewriteHost: true },
  '/data/sanand-projected.geojson': { body: projectedGeoJson(), type: 'application/geo+json' },
  '/data/ahmedabad-villages.kml': { body: kml('Ahmedabad villages'), type: 'application/vnd.google-earth.kml+xml' },
  '/data/gandhinagar-town-boundary.kml': { body: kml('Gandhinagar town'), type: 'text/xml' },
  '/data/surat-tp-scheme.kmz': { body: kmz('Surat TP scheme'), type: 'application/vnd.google-earth.kmz' },
  '/data/village-index.geojson': {
    body: Buffer.from(JSON.stringify({ type: 'FeatureCollection', features: [] })),
    type: 'application/geo+json',
  },
  // Served as an HTML error page despite the .kml name - must be reported, not saved.
  '/data/broken-layer.kml': { body: Buffer.from('<html><body>Not found</body></html>'), type: 'text/html' },
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
  <a href="/villages">Villages</a>
  <a href="/records/ahmedabad">Ahmedabad land records</a>
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

  '/villages': `<!doctype html><html><head><title>Village and town boundaries</title></head><body>
<h1>Village and town boundaries</h1>
<img src="/img/village-boundary-map.png" alt="Village boundary map for Ahmedabad district">
<img src="/img/town-plan-gandhinagar.png" alt="Gandhinagar town planning map">
<ul>
  <li><a href="/data/ahmedabad-villages.kml">Download Ahmedabad villages (KML)</a></li>
  <li><a href="/data/gandhinagar-town-boundary.kml">Gandhinagar town boundary KML</a></li>
  <li><a href="/data/surat-tp-scheme.kmz">Surat TP scheme (KMZ)</a></li>
  <li><a href="/data/village-index.geojson">Village index GeoJSON</a></li>
  <li><a href="/data/broken-layer.kml">Broken layer</a></li>
  <li><a href="/brochure.pdf">Brochure (PDF, not geo)</a></li>
</ul>
<div data-kml="/data/ahmedabad-villages.kml" class="map-widget">Interactive map</div>
<a href="/">Home</a>
</body></html>`,

  '/records/ahmedabad': `<!doctype html><html><head><title>Ahmedabad land records</title></head><body>
<h1>Ahmedabad district land records</h1>
<img src="/img/survey-125-2.png" alt="Survey No. 125/2 village map, Bopal">
<img src="/img/survey-126-1.png" alt="Survey 126/1 parcel map, Bopal">
<ul>
  <li><a href="/data/ahmedabad-district-villages.kml">Ahmedabad district villages (KML)</a></li>
  <li><a href="/data/sanand-projected.geojson">Sanand parcels (projected GeoJSON)</a></li>
</ul>
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
        `<?xml version="1.0"?><urlset><url><loc>http://${host}/gallery</loc></url><url><loc>http://${host}/maps/ahmedabad</loc></url><url><loc>http://${host}/villages</loc></url></urlset>`,
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

    const geo = GEO_FILES[pathname];
    if (geo) {
      const payload = geo.rewriteHost
        ? Buffer.from(geo.body.toString('utf8').replaceAll('GEO_HOST', host), 'utf8')
        : geo.body;
      response.writeHead(200, { 'content-type': geo.type, 'content-length': payload.length });
      response.end(payload);
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
