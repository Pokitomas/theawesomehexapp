import fs from 'node:fs';
import { chromium } from 'playwright-core';

const url = process.argv[2];
if (!url) throw new Error('usage: node survival-ledger-clickthrough.mjs <manual-url>');
const executablePath = [process.env.CHROME_BIN, process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean).find(path => fs.existsSync(path));
if (!executablePath) throw new Error('no Chromium found');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

async function corpus(store) {
  return page.evaluate(store => new Promise((resolve, reject) => {
    const request = indexedDB.open('sideways-manual-corpus-v1');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(store, 'readonly');
      const get = tx.objectStore(store).getAll();
      get.onerror = () => reject(get.error);
      get.onsuccess = () => resolve(get.result);
      tx.oncomplete = () => db.close();
    };
  }), store);
}

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.SidewaysImportWorkbench && window.SidewaysWorkspace?.survival, { timeout: 20000 });
await page.locator('#sidewaysImportFiles').setInputFiles({ name: 'rescue.png', mimeType: '', buffer: png });
await page.waitForFunction(() => window.SidewaysCore?.state?.records?.length === 1, { timeout: 20000 });
const record = (await corpus('records'))[0];
if (!record?.assetKey) throw new Error('imported witness has no asset');

const mirror = await page.evaluate(() => window.SidewaysWorkspace.survival.mirrorAll());
if (!['ready', 'unavailable'].includes(mirror.status)) throw new Error(`unexpected mirror result ${JSON.stringify(mirror)}`);
if (mirror.status === 'ready') {
  const mirroredSize = await page.evaluate(async assetKey => {
    const root = await navigator.storage.getDirectory();
    const vault = await root.getDirectoryHandle('sideways-vault');
    const assets = await vault.getDirectoryHandle('assets');
    const name = `${encodeURIComponent(String(assetKey)).replaceAll('%', '_').slice(0, 220)}.bin`;
    return (await (await assets.getFileHandle(name)).getFile()).size;
  }, record.assetKey);
  if (mirroredSize !== png.length) throw new Error(`mirror size mismatch ${mirroredSize}`);
}

const ark = await page.evaluate(async () => {
  const result = await window.SidewaysWorkspace.survival.exportArk({ download: false });
  window.__ark = result.blob;
  return { size: result.blob.size, head: await result.blob.slice(0, 32).text(), records: result.manifest.records.length, assets: result.manifest.assets.length };
});
if (!ark.head.startsWith('SIDEWAYS-ARK/1\n') || ark.records !== 1 || ark.assets !== 1 || ark.size <= png.length) throw new Error(`bad Ark ${JSON.stringify(ark)}`);

await page.evaluate(id => window.SidewaysWorkspace.deleteEntry(id), record.id);
await page.waitForFunction(() => window.SidewaysCore?.state?.records?.length === 0, { timeout: 15000 });
if ((await corpus('blobs')).length) throw new Error('delete left the canonical blob behind');

const restored = await page.evaluate(() => window.SidewaysWorkspace.survival.restoreArk(window.__ark));
if (restored.added !== 1 || restored.assets !== 1) throw new Error(`restore failed ${JSON.stringify(restored)}`);
await page.waitForFunction(() => window.SidewaysCore?.state?.records?.length === 1, { timeout: 15000 });
const audit = await page.evaluate(() => window.SidewaysWorkspace.survival.audit());
if (audit.records !== 1 || audit.assets !== 1 || audit.missingAssets.length || audit.orphanAssets.length) throw new Error(`audit failed ${JSON.stringify(audit)}`);

const ledger = await corpus('ledger');
for (const op of ['survival.mirror.checkpoint', 'survival.ark.export', 'survival.ark.restore', 'survival.audit']) {
  if (op === 'survival.mirror.checkpoint' && mirror.status === 'unavailable') continue;
  if (!ledger.some(entry => entry.op === op)) throw new Error(`ledger missing ${op}`);
}

await page.evaluate(() => window.SidewaysCore.routeTo('#/add'));
await page.waitForFunction(() => !document.getElementById('addView')?.hidden, { timeout: 10000 });
const vault = page.locator('section[data-survival-vault]');
await vault.waitFor({ state: 'visible', timeout: 10000 });
if (await vault.locator('[data-action-id^="vault."]').count() !== 4) throw new Error('vault rail is incomplete');
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
if (overflow > 1) throw new Error(`horizontal overflow ${overflow}`);
if (errors.length) throw new Error(errors.join(' | '));

await page.screenshot({ path: 'manual-survival-ledger.png', fullPage: true });
console.log(JSON.stringify({ mirror: mirror.status, ark, restored, audit, ledgerOps: [...new Set(ledger.map(entry => entry.op))].filter(op => op.startsWith('survival.')), horizontalOverflow: overflow }, null, 2));
await context.close();
await browser.close();
