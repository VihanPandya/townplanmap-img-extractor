import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { startFixtureSite } from './fixture/site.mjs';

/**
 * Browser walkthrough of the city / village map intelligence module.
 *
 * Needs a server running against a fresh build:
 *   npm run build
 *   SCANNER_ALLOW_PRIVATE_HOSTS=1 npx next start -p 3111
 *   npm run test:browser:maps
 */
const APP = process.env.APP_ORIGIN ?? 'http://127.0.0.1:3111';
const SHOTS = process.env.SCREENSHOT_DIR ?? 'screenshots';
mkdirSync(SHOTS, { recursive: true });
const site = await startFixtureSite();
const errors = [];
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--no-sandbox'],
});
const context = await browser.newContext({ viewport: { width: 1500, height: 980 }, acceptDownloads: true });
const page = await context.newPage();
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

const step = async (n, fn) => { try { await fn(); console.log('  ok -', n); } catch (e) { console.error('  FAIL -', n, '::', e.message.split('\n')[0]); process.exitCode = 1; } };

await page.goto(APP, { waitUntil: 'networkidle' });
await page.getByLabel('Website address to scan').fill(site.origin);
await page.getByRole('button', { name: 'Scan website' }).click();
await page.waitForFunction(() => document.body.innerText.includes('Finished.'), null, { timeout: 45000 });
await page.waitForTimeout(1200);

await step('the Cities & Villages tab opens', async () => {
  await page.getByRole('button', { name: /Cities & Villages/ }).click();
  await page.waitForTimeout(600);
  const t = await page.locator('body').innerText();
  if (!/select location/i.test(t)) throw new Error('location selector missing');
  if (!/not be treated as a legal land-survey/i.test(t)) throw new Error('accuracy notice missing');
});
await page.screenshot({ path: SHOTS + '/mi-01-select.png' });

await step('locations discovered from the source are listed', async () => {
  const t = await page.locator('body').innerText();
  if (!t.includes('Ahmedabad')) throw new Error('Ahmedabad not listed');
});

await step('opening a location shows the dashboard with real counts', async () => {
  await page.getByRole('button', { name: /Ahmedabad/ }).first().click();
  await page.waitForTimeout(1200);
  const t = (await page.locator('body').innerText()).toLowerCase();
  for (const label of ['maps available','land records','map images','kml available','image only']) {
    if (!t.includes(label)) throw new Error('dashboard missing: ' + label);
  }
});
await page.screenshot({ path: SHOTS + '/mi-02-dashboard.png' });

await step('the interactive map renders real geometry', async () => {
  const paths = await page.locator('svg[aria-label="Interactive parcel map"] path').count();
  if (paths < 2) throw new Error('expected polygons on the map, got ' + paths);
});

await step('clicking a parcel opens its details with honest fields', async () => {
  await page.locator('svg[aria-label="Interactive parcel map"] path').first().click();
  await page.waitForTimeout(600);
  const t = await page.locator('body').innerText();
  if (!/LAND MAP|Land map/i.test(t)) throw new Error('parcel panel missing');
  if (!/Parcel \/ survey reference/i.test(t)) throw new Error('reference row missing');
  if (!/Geometry/i.test(t)) throw new Error('geometry row missing');
  if (!/Not a legal land-survey|not be treated as a legal/i.test(t)) throw new Error('accuracy row missing');
});
await page.screenshot({ path: SHOTS + '/mi-03-parcel.png' });

await step('downloading one parcel KML yields a valid KML file', async () => {
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.getByRole('button', { name: 'Download KML' }).first().click(),
  ]);
  const dir = mkdtempSync(path.join(tmpdir(), 'kml-'));
  try {
    const f = path.join(dir, dl.suggestedFilename());
    await dl.saveAs(f);
    const kml = readFileSync(f, 'utf8');
    if (!kml.includes('<kml xmlns="http://www.opengis.net/kml/2.2">')) throw new Error('not a KML document');
    if (!/<coordinates>/.test(kml)) throw new Error('no coordinates in the KML');
    if (!/not a legal land-survey/i.test(kml)) throw new Error('provenance notice missing from KML');
    console.log('      (' + dl.suggestedFilename() + ')');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await step('the download centre states what is available', async () => {
  const t = (await page.locator('body').innerText()).toLowerCase();
  if (!t.includes('download centre')) throw new Error('download centre missing');
  if (!t.includes('records with source geometry')) throw new Error('KML availability not stated');
});
await page.screenshot({ path: SHOTS + '/mi-04-download.png' });

await step('combined KML export preserves village folders', async () => {
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 40000 }),
    page.getByRole('button', { name: /Download all KML/ }).click(),
  ]);
  const dir = mkdtempSync(path.join(tmpdir(), 'ckml-'));
  try {
    const f = path.join(dir, dl.suggestedFilename());
    await dl.saveAs(f);
    const kml = readFileSync(f, 'utf8');
    if (!/<Folder>/.test(kml)) throw new Error('no folders in the combined KML');
    if (!/<name>Bopal<\/name>/.test(kml)) throw new Error('village folder missing');
    console.log('      (' + dl.suggestedFilename() + ')');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await step('Download everything produces the organised bundle', async () => {
  await page.getByText('I have the right to retrieve these files.').click();
  await page.waitForTimeout(300);
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    page.getByRole('button', { name: /Download everything/ }).click(),
  ]);
  const dir = mkdtempSync(path.join(tmpdir(), 'bundle-'));
  try {
    const f = path.join(dir, dl.suggestedFilename());
    await dl.saveAs(f);
    if (!/No errors detected/.test(execFileSync('unzip', ['-t', f], { encoding: 'utf8' }))) throw new Error('bad zip');
    const listing = execFileSync('unzip', ['-l', f], { encoding: 'utf8' });
    for (const want of ['/KML/', '/Images/', 'metadata.json']) {
      if (!listing.includes(want)) throw new Error('bundle missing ' + want);
    }
    console.log('      (' + dl.suggestedFilename() + ')');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await step('search finds a survey number', async () => {
  await page.getByLabel('Search locations and survey references').fill('125/2');
  await page.waitForTimeout(800);
  const t = await page.locator('body').innerText();
  if (!/Matching land records/i.test(t)) throw new Error('parcel results not shown');
  if (!t.includes('125/2')) throw new Error('125/2 not found');
});
await page.screenshot({ path: SHOTS + '/mi-05-search.png' });

await step('mobile layout works', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(700);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 2) throw new Error('horizontal overflow of ' + overflow + 'px');
});
await page.screenshot({ path: SHOTS + '/mi-06-mobile.png' });

await step('no console errors', async () => {
  if (errors.length) throw new Error(errors.slice(0, 2).join(' | '));
});

await browser.close();
await site.close();
console.log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nALL MAP MODULE UI CHECKS PASSED');
