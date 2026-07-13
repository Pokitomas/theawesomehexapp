import fs from 'node:fs';
import { chromium } from 'playwright-core';

const url = process.argv[2];
if (!url) throw new Error('usage: node universal-media-clickthrough.mjs <manual-url>');

const executablePath = [
  process.env.CHROME_BIN,
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean).find(path => fs.existsSync(path));
if (!executablePath) throw new Error('no Chromium found');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const unknown = Buffer.from([0, 255, 1, 2, 3, 0, 127, 128, 129, 13, 10, 0, 4, 5, 6, 7]);

const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1'
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

async function readAll(storeName) {
  return page.evaluate(store => new Promise((resolve, reject) => {
    const request = indexedDB.open('sideways-manual-corpus-v1');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(store, 'readonly');
      const rows = tx.objectStore(store).getAll();
      rows.onerror = () => reject(rows.error);
      rows.onsuccess = () => resolve(rows.result);
      tx.oncomplete = () => db.close();
    };
  }), storeName);
}

async function touch(locator) {
  await locator.waitFor({ state: 'visible', timeout: 15000 });
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('no touch box');
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

async function deleteCard(card) {
  const dialogPromise = page.waitForEvent('dialog');
  const tapPromise = touch(card.locator('[data-action-id="post.delete"]'));
  const dialog = await dialogPromise;
  if (!dialog.message().includes('Delete this item from this device?')) throw new Error(`wrong delete prompt: ${dialog.message()}`);
  await dialog.accept();
  await tapPromise;
  await card.waitFor({ state: 'detached', timeout: 15000 });
}

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.documentElement.dataset.studioReady === 'yes', { timeout: 15000 });
await page.waitForFunction(() => document.documentElement.dataset.workspaceChrome === 'ready', { timeout: 15000 });
await page.waitForFunction(() => document.documentElement.dataset.mediaModes === 'ready', { timeout: 15000 });

const importInput = page.locator('#sidewaysImportFiles');
await importInput.setInputFiles([
  { name: 'red-circle.png', mimeType: '', buffer: png },
  { name: 'unknown-no-extension', mimeType: '', buffer: unknown }
]);
await page.waitForFunction(() => window.SidewaysCore?.state?.records?.length === 2, { timeout: 20000 });
await page.evaluate(() => window.SidewaysCore.routeTo('#/feed'));
await page.waitForURL(/#\/feed$/, { timeout: 10000 });

const imageCard = page.locator('#feed .post').filter({ hasText: 'red-circle.png' });
const binaryCard = page.locator('#feed .post').filter({ hasText: 'unknown-no-extension' });
await imageCard.waitFor({ state: 'visible', timeout: 15000 });
await binaryCard.waitFor({ state: 'visible', timeout: 15000 });
const image = imageCard.locator('.universal-image');
await image.waitFor({ state: 'visible', timeout: 15000 });
await page.waitForFunction(() => document.querySelector('.universal-image')?.naturalWidth > 0, { timeout: 10000 });
await binaryCard.locator('.universal-file-surface').waitFor({ state: 'visible', timeout: 15000 });

const records = await readAll('records');
const imageRecord = records.find(record => record.originalName === 'red-circle.png');
const binaryRecord = records.find(record => record.originalName === 'unknown-no-extension');
if (!imageRecord || imageRecord.mediaKind !== 'image' || imageRecord.mime !== 'image/png' || !imageRecord.assetKey || imageRecord.text || !(imageRecord.width > 0) || !(imageRecord.height > 0)) {
  throw new Error(`MIME-less PNG was not normalized as image media: ${JSON.stringify(imageRecord)}`);
}
if (!binaryRecord || binaryRecord.mediaKind !== 'binary' || binaryRecord.mime !== 'application/octet-stream' || !binaryRecord.assetKey || binaryRecord.text) {
  throw new Error(`unknown binary was not preserved honestly: ${JSON.stringify(binaryRecord)}`);
}

let blobs = await readAll('blobs');
if (blobs.length !== 2) throw new Error(`expected two stored binary assets, found ${blobs.length}`);
const feedText = await page.locator('#feed').innerText();
for (const poison of ['IHDR', 'gAMA', 'cHRM', '�', '\u0000']) {
  if (feedText.includes(poison)) throw new Error(`binary gibberish reached the feed: ${poison}`);
}

const modes = page.locator('[data-feed-mode-rail]');
await modes.waitFor({ state: 'visible', timeout: 10000 });
if (await modes.locator('[data-feed-mode-button]').count() !== 3) throw new Error('Flow Stage Grid rail is incomplete');
if (!(await page.locator('.type-nav').evaluate((nav, rail) => nav.contains(rail), await modes.elementHandle()))) throw new Error('feed modes escaped the filter strip');

await touch(modes.locator('[data-feed-mode-button="stage"]'));
await page.waitForFunction(() => document.documentElement.dataset.feedMode === 'stage');
const stage = await page.evaluate(() => ({
  scrollSnap: getComputedStyle(document.getElementById('feed')).scrollSnapType,
  height: document.getElementById('feed').getBoundingClientRect().height,
  visualHeight: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--future-visual-height')),
  chromeHeight: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--future-chrome-height'))
}));
if (!stage.scrollSnap.includes('y') || stage.height <= 200 || stage.height > stage.visualHeight + 2) throw new Error(`Stage geometry is not viewport-aware: ${JSON.stringify(stage)}`);

await touch(modes.locator('[data-feed-mode-button="grid"]'));
await page.waitForFunction(() => document.documentElement.dataset.feedMode === 'grid');
const gridDisplay = await page.evaluate(() => getComputedStyle(document.getElementById('feed')).display);
if (gridDisplay !== 'grid') throw new Error(`Grid mode did not become a grid: ${gridDisplay}`);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => document.documentElement.dataset.mediaModes === 'ready', { timeout: 15000 });
if (await page.evaluate(() => document.documentElement.dataset.feedMode) !== 'grid') throw new Error('feed mode did not persist across reload');

await page.screenshot({ path: 'manual-universal-media-grid.png', fullPage: true });
const imageCardReloaded = page.locator('#feed .post').filter({ hasText: 'red-circle.png' });
await deleteCard(imageCardReloaded);
blobs = await readAll('blobs');
if (blobs.some(blob => blob.key === imageRecord.assetKey)) throw new Error('deleted imported image left its blob behind');

const binaryCardReloaded = page.locator('#feed .post').filter({ hasText: 'unknown-no-extension' });
await deleteCard(binaryCardReloaded);
await page.waitForFunction(() => window.SidewaysCore?.state?.records?.length === 0, { timeout: 15000 });
blobs = await readAll('blobs');
if (blobs.length) throw new Error(`deleted imported files left ${blobs.length} blobs behind`);

await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => document.documentElement.dataset.studioReady === 'yes', { timeout: 15000 });
if ((await readAll('records')).length || (await readAll('blobs')).length) throw new Error('deleted imported media returned after reload');
if (errors.length) throw new Error(errors.join(' | '));

await page.screenshot({ path: 'manual-universal-media-empty.png', fullPage: true });
console.log(JSON.stringify({
  mimeLessPng: { mediaKind: imageRecord.mediaKind, mime: imageRecord.mime, width: imageRecord.width, height: imageRecord.height },
  unknownBinary: { mediaKind: binaryRecord.mediaKind, mime: binaryRecord.mime },
  stage,
  gridPersisted: true,
  importedDelete: true,
  blobsAfterDelete: 0,
  binaryGibberishVisible: false,
  screenshots: ['manual-universal-media-grid.png', 'manual-universal-media-empty.png']
}, null, 2));

await context.close();
await browser.close();
