import fs from 'node:fs';
import { chromium } from 'playwright-core';

const url = process.argv[2];
if (!url) throw new Error('usage: node runtime-hardening-clickthrough.mjs <manual-url>');

const executablePath = [
  process.env.CHROME_BIN,
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean).find(path => fs.existsSync(path));
if (!executablePath) throw new Error('no Chromium found');

const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
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

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.documentElement.dataset.studioReady === 'yes', { timeout: 15000 });

const files = Array.from({ length: 16 }, (_, index) => ({
  name: `runtime-${String(index).padStart(2, '0')}.bin`,
  mimeType: '',
  buffer: Buffer.from([0, 255, index, 2, 3, 0, 127, 128, 129, index + 10])
}));
await page.locator('#sidewaysImportFiles').setInputFiles(files);
await page.waitForFunction(count => window.SidewaysCore?.state?.records?.length === count, files.length, { timeout: 30000 });


let ledger = await readAll('ledger');
const imports = ledger.filter(entry => entry.op === 'record.import');
if (imports.length !== files.length) throw new Error(`expected ${files.length} import receipts, found ${imports.length}`);
if (imports.some(entry => entry.schema !== 2 || entry.compatibility?.digestMode !== 'sha256-worker')) {
  throw new Error(`import receipts lost compatibility detail: ${JSON.stringify(imports)}`);
}

await page.evaluate(() => window.SidewaysCore.routeTo('#/feed'));
await page.waitForURL(/#\/feed$/);
await page.waitForFunction(() => document.querySelectorAll('#feed .post').length === 16);
await page.waitForTimeout(500);

const initialHydrated = await page.locator('#feed .post[data-universal-media="ready"]').count();
if (!initialHydrated || initialHydrated >= files.length) throw new Error(`viewport hydration loaded ${initialHydrated}/${files.length} records`);

const last = page.locator('#feed .post').last();
await last.scrollIntoViewIfNeeded();
await page.waitForFunction(() => document.querySelector('#feed .post:last-child')?.dataset.universalMedia === 'ready');
await page.waitForFunction(() => document.querySelector('#feed .post:first-child')?.dataset.universalMedia !== 'ready', { timeout: 10000 });

await page.evaluate(async () => {
  for (const record of [...window.SidewaysCore.state.records]) await window.SidewaysWorkspace.deleteEntry(record.id);
});
await page.waitForFunction(() => window.SidewaysCore?.state?.records?.length === 0, { timeout: 30000 });
if ((await readAll('blobs')).length) throw new Error('deletion left blobs behind');
ledger = await readAll('ledger');
const deletes = ledger.filter(entry => entry.op === 'record.delete');
if (deletes.length !== files.length || deletes.some(entry => entry.assetDeleted !== true)) {
  throw new Error(`delete tombstones are incomplete: ${JSON.stringify(deletes)}`);
}

await page.reload({ waitUntil: 'networkidle' });
if ((await readAll('ledger')).length !== files.length * 2) throw new Error('compatibility ledger did not survive reload');
if (errors.length) throw new Error(errors.join(' | '));

console.log(JSON.stringify({
  offThreadHashing: true,
  initialHydrated,
  totalRecords: files.length,
  viewportDehydration: true,
  importReceipts: imports.length,
  deleteTombstones: deletes.length,
  durableAfterReload: true
}, null, 2));

await context.close();
await browser.close();
