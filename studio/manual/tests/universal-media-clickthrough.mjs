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

function makeWav() {
  const sampleRate = 8000;
  const samples = Math.round(sampleRate * .25);
  const buffer = Buffer.alloc(44 + samples);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + samples, 4);
  buffer.write('WAVEfmt ', 8, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate, 28);
  buffer.writeUInt16LE(1, 32);
  buffer.writeUInt16LE(8, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(samples, 40);
  for (let index = 0; index < samples; index += 1) {
    buffer[44 + index] = Math.round(128 + Math.sin(index / sampleRate * Math.PI * 2 * 440) * 72);
  }
  return buffer;
}

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const unknown = Buffer.from([0, 255, 1, 2, 3, 0, 127, 128, 129, 13, 10, 0, 4, 5, 6, 7]);
const webm = Buffer.from(fs.readFileSync(new URL('./fixtures/future-video.webm.base64', import.meta.url), 'utf8').trim(), 'base64');
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF', 'utf8');
const wav = makeWav();

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

function recordByName(records, name) {
  return records.find(record => record.originalName === name);
}

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.documentElement.dataset.studioReady === 'yes', { timeout: 15000 });
await page.waitForFunction(() => document.documentElement.dataset.workspaceChrome === 'ready', { timeout: 15000 });
await page.waitForFunction(() => document.documentElement.dataset.mediaModes === 'ready', { timeout: 15000 });

const importInput = page.locator('#sidewaysImportFiles');
await importInput.setInputFiles([
  { name: 'red-circle.png', mimeType: '', buffer: png },
  { name: 'portrait-clip.webm', mimeType: '', buffer: webm },
  { name: 'tone.wav', mimeType: '', buffer: wav },
  { name: 'document.pdf', mimeType: '', buffer: pdf },
  { name: 'unknown-no-extension', mimeType: '', buffer: unknown }
]);
await page.waitForFunction(() => window.SidewaysCore?.state?.records?.length === 5, { timeout: 30000 });
await page.evaluate(() => window.SidewaysCore.routeTo('#/feed'));
await page.waitForURL(/#\/feed$/, { timeout: 10000 });

const imageCard = page.locator('#feed .post').filter({ hasText: 'red-circle.png' });
const videoCard = page.locator('#feed .post').filter({ hasText: 'portrait-clip.webm' });
const audioCard = page.locator('#feed .post').filter({ hasText: 'tone.wav' });
const pdfCard = page.locator('#feed .post').filter({ hasText: 'document.pdf' });
const binaryCard = page.locator('#feed .post').filter({ hasText: 'unknown-no-extension' });
for (const card of [imageCard, videoCard, audioCard, pdfCard, binaryCard]) await card.waitFor({ state: 'attached', timeout: 15000 });

const image = imageCard.locator('.universal-image');
await image.waitFor({ state: 'visible', timeout: 15000 });
await page.waitForFunction(() => document.querySelector('.universal-image')?.naturalWidth > 0, { timeout: 10000 });
const video = videoCard.locator('.universal-video');
if (await video.count() !== 1) throw new Error('video did not receive a video surface');
await page.waitForFunction(() => document.querySelector('.universal-video')?.readyState >= 1, { timeout: 10000 });
if (await audioCard.locator('.universal-audio audio').count() !== 1) throw new Error('audio did not receive an audio surface');
const pdfSurface = pdfCard.locator('.universal-file-surface.is-pdf');
if (await pdfSurface.count() !== 1 || !(await pdfSurface.getAttribute('href'))?.startsWith('blob:')) throw new Error('PDF did not receive an openable document surface');
await binaryCard.locator('.universal-file-surface').waitFor({ state: 'attached', timeout: 15000 });

const records = await readAll('records');
const imageRecord = recordByName(records, 'red-circle.png');
const videoRecord = recordByName(records, 'portrait-clip.webm');
const audioRecord = recordByName(records, 'tone.wav');
const pdfRecord = recordByName(records, 'document.pdf');
const binaryRecord = recordByName(records, 'unknown-no-extension');
if (!imageRecord || imageRecord.mediaKind !== 'image' || imageRecord.mime !== 'image/png' || !imageRecord.assetKey || imageRecord.text || !(imageRecord.width > 0) || !(imageRecord.height > 0)) {
  throw new Error(`MIME-less PNG was not normalized as image media: ${JSON.stringify(imageRecord)}`);
}
if (!videoRecord || videoRecord.mediaKind !== 'video' || videoRecord.mime !== 'video/webm' || !videoRecord.assetKey || videoRecord.text || videoRecord.width !== 90 || videoRecord.height !== 160 || !(videoRecord.duration > 0)) {
  throw new Error(`MIME-less WebM was not normalized as portrait video: ${JSON.stringify(videoRecord)}`);
}
if (!audioRecord || audioRecord.mediaKind !== 'audio' || audioRecord.mime !== 'audio/wav' || !audioRecord.assetKey || audioRecord.text || !(audioRecord.duration > 0)) {
  throw new Error(`MIME-less WAV was not normalized as playable audio: ${JSON.stringify(audioRecord)}`);
}
if (!pdfRecord || pdfRecord.mediaKind !== 'pdf' || pdfRecord.mime !== 'application/pdf' || !pdfRecord.assetKey || pdfRecord.text) {
  throw new Error(`MIME-less PDF was not normalized as PDF media: ${JSON.stringify(pdfRecord)}`);
}
if (!binaryRecord || binaryRecord.mediaKind !== 'binary' || binaryRecord.mime !== 'application/octet-stream' || !binaryRecord.assetKey || binaryRecord.text) {
  throw new Error(`unknown binary was not preserved honestly: ${JSON.stringify(binaryRecord)}`);
}

let blobs = await readAll('blobs');
if (blobs.length !== 5) throw new Error(`expected five stored media assets, found ${blobs.length}`);
const feedText = await page.locator('#feed').innerText();
for (const poison of ['IHDR', 'gAMA', 'cHRM', '�', '\u0000']) {
  if (feedText.includes(poison)) throw new Error(`binary gibberish reached the feed: ${poison}`);
}

const modes = page.locator('[data-feed-mode-rail]');
await modes.waitFor({ state: 'visible', timeout: 10000 });
if (await modes.locator('[data-feed-mode-button]').count() !== 3) throw new Error('Flow Stage Grid rail is incomplete');
const railInFilters = await page.evaluate(() => document.querySelector('.type-nav')?.contains(document.querySelector('[data-feed-mode-rail]')) || false);
if (!railInFilters) throw new Error('feed modes escaped the filter strip');

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
await page.waitForFunction(() => document.querySelector('.universal-video')?.readyState >= 1, { timeout: 10000 });

await page.screenshot({ path: 'manual-universal-media-grid.png', fullPage: true });
const deleteOrder = ['red-circle.png', 'portrait-clip.webm', 'tone.wav', 'document.pdf', 'unknown-no-extension'];
for (let index = 0; index < deleteOrder.length; index += 1) {
  const name = deleteOrder[index];
  const card = page.locator('#feed .post').filter({ hasText: name });
  await deleteCard(card);
  await page.waitForFunction(expected => window.SidewaysCore?.state?.records?.length === expected, deleteOrder.length - index - 1, { timeout: 15000 });
}
blobs = await readAll('blobs');
if (blobs.length) throw new Error(`deleted imported files left ${blobs.length} blobs behind`);

await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => document.documentElement.dataset.studioReady === 'yes', { timeout: 15000 });
if ((await readAll('records')).length || (await readAll('blobs')).length) throw new Error('deleted imported media returned after reload');
if (errors.length) throw new Error(errors.join(' | '));

await page.screenshot({ path: 'manual-universal-media-empty.png', fullPage: true });
console.log(JSON.stringify({
  media: {
    image: { mime: imageRecord.mime, width: imageRecord.width, height: imageRecord.height },
    video: { mime: videoRecord.mime, width: videoRecord.width, height: videoRecord.height, duration: videoRecord.duration, playback: true },
    audio: { mime: audioRecord.mime, duration: audioRecord.duration },
    pdf: { mime: pdfRecord.mime, surface: 'document-link' },
    binary: { mime: binaryRecord.mime }
  },
  stage,
  gridPersisted: true,
  importedDelete: true,
  blobsAfterDelete: 0,
  binaryGibberishVisible: false,
  screenshots: ['manual-universal-media-grid.png', 'manual-universal-media-empty.png']
}, null, 2));

await context.close();
await browser.close();
