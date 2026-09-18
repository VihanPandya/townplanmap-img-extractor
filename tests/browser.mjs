/**
 * Browser walkthrough of the finished application.
 *
 * Requires a server already running against a fresh build:
 *   npm run build && SCANNER_ALLOW_PRIVATE_HOSTS=1 npx next start -p 3111
 *   npm run test:browser
 *
 * The private-host switch is needed only because the fixture site this drives
 * lives on 127.0.0.1. Screenshots land in ./screenshots.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startFixtureSite } from './fixture/site.mjs';

const APP = process.env.APP_ORIGIN ?? 'http://127.0.0.1:3111';
const SHOTS = process.env.SCREENSHOT_DIR ?? 'screenshots';
mkdirSync(SHOTS, { recursive: true });
const site = await startFixtureSite();
const errors = [];
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--no-sandbox'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 950 }, acceptDownloads: true });
const page = await context.newPage();
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
const failedRequests = [];
page.on('response', (r) => { if (r.status() >= 400) failedRequests.push(r.status() + ' ' + r.url()); });

const step = async (name, fn) => { try { await fn(); console.log('  ok -', name); } catch (e) { console.error('  FAIL -', name, '::', e.message); process.exitCode = 1; } };

await page.goto(APP, { waitUntil: 'networkidle' });

await step('header, subtitle and empty state render', async () => {
  await page.getByRole('heading', { name: 'TownPlanMap Image Explorer' }).waitFor({ timeout: 5000 });
  await page.getByText('Discover, inspect and organise publicly available images').waitFor();
  await page.getByRole('heading', { name: 'Discover website images' }).waitFor();
});
await page.screenshot({ path: SHOTS + '/01-empty-light.png' });

await step('dark mode toggles', async () => {
  await page.getByRole('button', { name: /Switch to dark mode/ }).click();
  await page.waitForTimeout(250);
  const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  if (theme !== 'dark') throw new Error('data-theme is ' + theme);
});
await page.screenshot({ path: SHOTS + '/02-empty-dark.png' });

await step('help dialog opens and closes', async () => {
  await page.getByRole('button', { name: 'About this tool' }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByText('What it will not do').waitFor();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
});

await step('settings dialog shows crawl limits', async () => {
  await page.getByRole('button', { name: 'Crawl settings' }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByText('Maximum pages').waitFor();
  await page.getByText('Respect robots.txt').waitFor();
});
await page.screenshot({ path: SHOTS + '/03-settings.png' });
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

await step('a scan runs and the gallery fills', async () => {
  const input = page.getByLabel('Website address to scan');
  await input.fill(site.origin);
  await page.getByRole('button', { name: 'Scan website' }).click();
  await page.getByText(/unique (image|asset)/).waitFor({ timeout: 30000 });
  await page.waitForFunction(() => document.body.innerText.includes('Finished.'), null, { timeout: 30000 });
});
await page.waitForTimeout(1200);
await page.screenshot({ path: SHOTS + '/04-results-dark.png', fullPage: false });

await step('progress dashboard reports real counts', async () => {
  // Several labels are upper-cased by CSS, so compare case-insensitively.
  const text = (await page.locator('body').innerText()).toLowerCase();
  for (const label of ['pages', 'references', 'unique', 'duplicates', 'verified', 'robots.txt']) {
    if (!text.includes(label)) throw new Error('missing dashboard stat: ' + label);
  }
  if (!text.includes('checked')) throw new Error('robots status not shown');
});

await step('image cards show metadata', async () => {
  const body = await page.locator('body').innerText();
  if (!body.includes('ahmedabad-town-plan-map.png')) throw new Error('map filename not in gallery');
  if (!body.includes('1600 × 1200')) throw new Error('dimensions not rendered');
});

await step('previews actually load pixels', async () => {
  const loaded = await page.evaluate(() =>
    [...document.querySelectorAll('img')].filter((i) => i.complete && i.naturalWidth > 0).length,
  );
  if (loaded < 3) throw new Error('only ' + loaded + ' images painted');
  console.log('      (' + loaded + ' previews painted)');
});

await step('search filters instantly', async () => {
  await page.getByLabel('Search discovered images').fill('ahmedabad');
  await page.waitForTimeout(400);
  const text = await page.locator('body').innerText();
  if (!/matching/.test(text)) throw new Error('match count not shown');
  const count = await page.locator('body').innerText();
  if (!count.includes('ahmedabad')) throw new Error('search term not echoed');
  await page.getByLabel('Search discovered images').fill('');
  await page.waitForTimeout(400);
});

await step('category filter narrows results', async () => {
  const before = await page.locator('body').innerText();
  const m = /(\d+) of (\d+) unique/.exec(before);
  await page.getByText('Map', { exact: true }).first().click();
  await page.waitForTimeout(400);
  const after = /(\d+) of (\d+) unique/.exec(await page.locator('body').innerText());
  if (!m || !after) throw new Error('result counter missing');
  if (Number(after[1]) >= Number(m[1])) throw new Error(`filter did not narrow (${m[1]} -> ${after[1]})`);
  console.log(`      (${m[1]} -> ${after[1]} after filtering to Map)`);
  await page.getByRole('button', { name: 'Reset' }).click();
  await page.waitForTimeout(400);
});
await page.screenshot({ path: SHOTS + '/05-filters.png' });

await step('image viewer opens with full details', async () => {
    // Exact filename: a prefix match would also hit the 300x225 responsive variant.
  await page.locator('button[aria-label="Inspect ahmedabad-town-plan-map.png"]').first().click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  const raw = await dialog.innerText();
  const text = raw.toLowerCase();
  for (const label of ['image details', 'dimensions', 'format', 'image url', 'source page', 'alt text', 'discovery method', 'detected category', 'status']) {
    if (!text.includes(label)) throw new Error('viewer missing section: ' + label);
  }
  if (!raw.includes('1600 × 1200')) throw new Error('viewer dimensions wrong');
  if (!text.includes('available')) throw new Error('viewer status missing');
});
await page.screenshot({ path: SHOTS + '/06-viewer.png' });

await step('category can be overridden by the user', async () => {
  const select = page.getByRole('dialog').locator('select');
  await select.selectOption('screenshot');
  await page.waitForTimeout(300);
  if (!(await page.getByRole('dialog').innerText()).includes('Reset to detected')) throw new Error('override not applied');
  await page.getByText('Reset to detected').click();
  await page.waitForTimeout(200);
});

await step('viewer navigates with arrow keys', async () => {
  const before = await page.getByRole('dialog').innerText();
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(350);
  const after = await page.getByRole('dialog').innerText();
  if (before === after) throw new Error('arrow key did not advance');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
});

await step('selection toolbar appears and exports', async () => {
  // The per-card checkbox reveals itself on hover, so hover the card first and
  // click the visible control rather than the screen-reader-only input.
  const firstCard = page.locator('button[aria-label^="Inspect "]').first();
  await firstCard.hover();
  await page.waitForTimeout(250);
  // Scoped to the card overlay - the sidebar filters also use checkbox labels.
  await page.locator('[data-selected] label').first().click();
  await page.waitForTimeout(400);
  await page.getByText(/image(s)? selected/).waitFor({ timeout: 5000 });
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    (async () => {
      await page.getByRole('button', { name: /Export metadata/ }).click();
      await page.waitForTimeout(200);
      await page.getByRole('menuitem', { name: /CSV/ }).click();
    })(),
  ]);
  const name = download.suggestedFilename();
  if (!name.endsWith('.csv')) throw new Error('unexpected download ' + name);
  console.log('      (downloaded ' + name + ')');
});
await page.screenshot({ path: SHOTS + '/07-selection.png' });

await step('list and compact views render', async () => {
  await page.getByRole('button', { name: 'List view' }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: SHOTS + '/08-list.png' });
  await page.getByRole('button', { name: 'Compact grid' }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: SHOTS + '/09-compact.png' });
  await page.getByRole('button', { name: 'Grid view' }).click();
  await page.waitForTimeout(400);
});

await step('KML/KMZ/GeoJSON files are discovered and shown as data tiles', async () => {
  const body = await page.locator('body').innerText();
  for (const name of ['ahmedabad-villages.kml', 'surat-tp-scheme.kmz', 'village-index.geojson']) {
    if (!body.includes(name)) throw new Error('missing geo file: ' + name);
  }
  if (!body.toLowerCase().includes('geographic data file')) throw new Error('no geo tile label rendered');
});

await step('village and town map images are discovered', async () => {
  const body = await page.locator('body').innerText();
  for (const name of ['village-boundary-map.png', 'town-plan-gandhinagar.png']) {
    if (!body.includes(name)) throw new Error('missing map image: ' + name);
  }
});

await step('the File kind filter isolates geographic data', async () => {
  const before = /(\d+) of (\d+) unique/.exec(await page.locator('body').innerText());
  await page.getByText('Geographic data', { exact: true }).first().click();
  await page.waitForTimeout(500);
  const after = /(\d+) of (\d+) unique/.exec(await page.locator('body').innerText());
  if (!before || !after) throw new Error('result counter missing');
  if (Number(after[1]) !== 5) throw new Error(`expected 5 geo assets, got ${after[1]}`);
  console.log(`      (${before[1]} -> ${after[1]} when filtered to Geographic data)`);
});
await page.screenshot({ path: SHOTS + '/12-geo-filtered.png' });

await step('a KML viewer reports no pixel dimensions rather than inventing them', async () => {
  await page.locator('button[aria-label="Inspect ahmedabad-villages.kml"]').first().click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  const text = await dialog.innerText();
  if (!/not applicable/i.test(text)) throw new Error('KML should report dimensions as not applicable');
  if (!text.includes('KML')) throw new Error('format badge missing');
});
await page.screenshot({ path: SHOTS + '/13-geo-viewer.png' });
await page.keyboard.press('Escape');
await page.waitForTimeout(400);

await step('downloading is gated behind an explicit acknowledgement', async () => {
  // Drop the selection left over from the export step, so the dialog acts on
  // the visible geo files rather than one stale card.
  const clear = page.getByRole('button', { name: 'Clear', exact: true });
  if (await clear.isVisible().catch(() => false)) {
    await clear.click();
    await page.waitForTimeout(300);
  }

  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  if (await dialog.getByRole('button', { name: /Download ZIP/ }).isEnabled()) {
    throw new Error('the ZIP button must start disabled');
  }
  if (!/does not grant permission/i.test(await dialog.innerText())) {
    throw new Error('the rights notice is missing');
  }
});
await page.screenshot({ path: SHOTS + '/14-download-dialog.png' });

await step('acknowledging produces a ZIP that system unzip verifies', async () => {
  const dialog = page.getByRole('dialog');
  await dialog.locator('label:has(input[type=checkbox])').first().click();
  await dialog.locator('input[placeholder^="e.g."]').fill('browser test run');
  await page.waitForTimeout(200);

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    dialog.getByRole('button', { name: /Download ZIP/ }).click(),
  ]);

  const dir = mkdtempSync(path.join(tmpdir(), 'ui-download-'));
  try {
    const archive = path.join(dir, download.suggestedFilename());
    await download.saveAs(archive);
    if (!/No errors detected/.test(execFileSync('unzip', ['-t', archive], { encoding: 'utf8' }))) {
      throw new Error('the archive failed CRC verification');
    }
    execFileSync('unzip', ['-q', '-o', archive, '-d', dir]);
    if (!readFileSync(path.join(dir, 'geo-data/ahmedabad-villages.kml'), 'utf8').includes('<kml')) {
      throw new Error('the KML did not survive the round trip');
    }
    if (!readFileSync(path.join(dir, 'MANIFEST.csv'), 'utf8').includes('browser test run')) {
      throw new Error('the stated basis was not recorded in the manifest');
    }
    console.log('      (' + download.suggestedFilename() + ', manifest records the stated basis)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await step('light mode renders results too', async () => {
  await page.getByRole('button', { name: /Switch to light mode/ }).click();
  await page.waitForTimeout(400);
});
await page.screenshot({ path: SHOTS + '/10-results-light.png' });

await step('mobile layout works', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: 'Filters' }).waitFor({ timeout: 4000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 2) throw new Error('horizontal overflow of ' + overflow + 'px');
});
await page.screenshot({ path: SHOTS + '/11-mobile.png', fullPage: false });

await step('no console errors were produced', async () => {
  // The fixture serves deliberate 404s (a missing image, a broken page); those
  // are the scanner working, not a client bug. Anything else is a real problem.
  const expected = /missing-image|\/broken|favicon\.ico$/;
  const unexpected = failedRequests.filter((entry) => !expected.test(entry));
  if (unexpected.length) throw new Error('unexpected failed requests: ' + unexpected.slice(0, 4).join(' | '));
  const real = errors.filter((e) => !/Failed to load resource/.test(e));
  if (real.length) throw new Error(real.slice(0, 3).join(' | '));
  console.log('      (expected fixture 404s: ' + failedRequests.length + ')');
});

await browser.close();
await site.close();
console.log(process.exitCode ? '\nSOME UI CHECKS FAILED' : '\nALL UI CHECKS PASSED');
