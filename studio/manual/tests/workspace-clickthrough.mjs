import fs from 'node:fs';
import { chromium } from 'playwright-core';

const url = process.argv[2];
if (!url) throw new Error('usage: node workspace-clickthrough.mjs <manual-url>');

const executablePath = [
  process.env.CHROME_BIN,
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean).find(path => fs.existsSync(path));
if (!executablePath) throw new Error('no Chromium found');

const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
  permissions: ['geolocation'],
  geolocation: { latitude: 34.0522, longitude: -118.2437 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1'
});
const page = await context.newPage();
const errors = [];
const actionEvents = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
await page.exposeFunction('recordWorkspaceAction', detail => actionEvents.push(detail));
await page.addInitScript(() => {
  window.addEventListener('sideways:action', event => window.recordWorkspaceAction(structuredClone(event.detail)));
});

async function touch(locator) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await locator.waitFor({ state: 'visible', timeout: 12000 });
      await locator.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
      await page.waitForTimeout(50);
      const box = await locator.boundingBox();
      if (!box) throw new Error('touch target has no bounding box');
      const obstruction = await locator.evaluate(node => {
        const rect = node.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        return hit && hit !== node && !node.contains(hit) ? hit.closest('[data-workspace-commandbar]')?.getAttribute('data-workspace-commandbar') || hit.tagName : '';
      });
      if (obstruction) throw new Error(`touch target is obstructed by ${obstruction}`);
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await page.waitForTimeout(120);
    }
  }
  throw lastError;
}

async function readAll(storeName) {
  return page.evaluate(store => new Promise((resolve, reject) => {
    const request = indexedDB.open('sideways-manual-corpus-v1');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(store, 'readonly');
      const all = transaction.objectStore(store).getAll();
      all.onerror = () => reject(all.error);
      all.onsuccess = () => resolve(all.result);
      transaction.oncomplete = () => db.close();
    };
  }), storeName);
}

async function waitForOwnedCount(expected) {
  await page.waitForFunction(count => window.SidewaysWorkspace.ownedEntries().then(records => records.length === count), expected, { timeout: 15000 });
}

async function seedImportedWitness() {
  await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('sideways-manual-corpus-v1');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('records', 'readwrite');
      const now = new Date().toISOString();
      transaction.objectStore('records').add({
        type: 'social', title: 'Imported witness', summary: 'Imported material survives authored deletion.',
        text: 'Imported material survives authored deletion.', body: [], source: 'Test import', sourceUrl: '', outboundUrl: '',
        author: { name: 'Archive', handle: '', url: '', avatar: '' }, published: now, addedAt: now, updatedAt: now,
        originalName: 'Imported witness', mime: 'text/plain', size: 45, hash: `test-import-witness:${Date.now()}`,
        assetKey: '', mediaKind: '', mediaConfidence: 'fixture', width: 0, height: 0,
        nativeId: `reddit:witness:${Date.now()}`, links: [], tags: ['test:imported-witness'], rank: {},
        compatibility: { sourceMime: 'text/plain', canonicalMime: 'text/plain', fixture: true }
      });
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('witness transaction aborted'));
    };
  }));
  await page.evaluate(() => new Promise(resolve => {
    const timer = setTimeout(resolve, 3000);
    window.addEventListener('sideways:corpusrefresh', event => { clearTimeout(timer); resolve(event.detail); }, { once: true });
    window.dispatchEvent(new CustomEvent('sideways:importcomplete', { detail: { source: 'workspace-ledger-witness' } }));
  }));
}

async function openComposer() {
  await touch(page.locator('[data-workspace-new][data-action-id="feed.post"]'));
  const composer = page.locator('[data-workspace-composer]');
  await composer.waitFor({ state: 'visible', timeout: 10000 });
  return composer;
}

async function attachImage(composer, name) {
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 10000 });
  await touch(composer.locator('[data-action-id="post.attach"]'));
  const chooser = await chooserPromise;
  await chooser.setFiles({ name, mimeType: 'image/png', buffer: tinyPng });
  await composer.locator('.workspace-image-preview img').waitFor({ state: 'visible', timeout: 10000 });
}

async function publish(text, { image = '', place = false } = {}) {
  const composer = await openComposer();
  await composer.locator('.workspace-composer-text').fill(text);
  if (place) {
    await touch(composer.locator('[data-action-id="composer.place"]'));
    const picker = page.locator('[data-workspace-place-picker]');
    await picker.waitFor({ state: 'visible', timeout: 5000 });
    if (!(await picker.locator('[data-action-id="places.use"]').count())) {
      await touch(picker.locator('[data-action-id="places.create"]'));
      const editor = page.locator('[data-workspace-place-editor]');
      await editor.waitFor({ state: 'visible', timeout: 5000 });
      await editor.locator('input[name="placeName"]').fill('Kitchen table');
      await editor.locator('textarea[name="placeDetail"]').fill('Where the runtime became real.');
      await touch(editor.locator('[data-action-id="places.save"]'));
      await editor.waitFor({ state: 'hidden', timeout: 5000 });
    } else {
      await touch(picker.locator('[data-action-id="places.use"]').filter({ hasText: 'Kitchen table' }));
    }
  }
  if (image) await attachImage(composer, image);
  await touch(composer.locator('[data-action-id="post.publish"]'));
  await composer.waitFor({ state: 'hidden', timeout: 10000 });
  await page.locator('#feed .post').filter({ hasText: text }).waitFor({ state: 'visible', timeout: 15000 });
}

async function deletePost(text, decision = 'accept') {
  const card = page.locator('#feed .post').filter({ hasText: text });
  await card.waitFor({ state: 'visible', timeout: 15000 });
  const dialogPromise = page.waitForEvent('dialog', { timeout: 10000 });
  const tapPromise = touch(card.locator('[data-action-id="post.delete"]'));
  const dialog = await dialogPromise;
  if (!dialog.message().includes('Delete this post from this device?')) throw new Error(`unexpected delete prompt: ${dialog.message()}`);
  if (decision === 'dismiss') await dialog.dismiss();
  else await dialog.accept();
  await tapPromise;
  if (decision === 'dismiss') await card.waitFor({ state: 'visible', timeout: 5000 });
  else await card.waitFor({ state: 'detached', timeout: 15000 });
}

await page.addInitScript(() => {
  localStorage.setItem('sideways-workspace-profile-v1', JSON.stringify({
    name: 'Proof User', handle: 'proof', bio: '', accent: '#335cff'
  }));
});

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.documentElement.dataset.studioReady === 'yes', { timeout: 15000 });
await page.waitForFunction(() => document.documentElement.dataset.workspaceChrome === 'ready', { timeout: 15000 });

const chromePlacement = await page.evaluate(() => {
  const commandbar = document.querySelector('[data-workspace-commandbar]');
  const titleActions = document.querySelector('[data-workspace-title-actions]');
  const newButton = document.querySelector('[data-workspace-new]');
  const nav = document.querySelector('[data-workspace-nav]');
  const profile = document.getElementById('navProfile');
  return {
    newInCommandbar: Boolean(commandbar?.contains(newButton)),
    navInCommandbar: Boolean(commandbar?.contains(nav)),
    profileInTitlebar: Boolean(titleActions?.contains(profile)),
    newCount: document.querySelectorAll('[data-workspace-new]').length,
    navCount: document.querySelectorAll('[data-workspace-nav]').length
  };
});
if (!chromePlacement.newInCommandbar || !chromePlacement.navInCommandbar || !chromePlacement.profileInTitlebar || chromePlacement.newCount !== 1 || chromePlacement.navCount !== 1) {
  throw new Error(`workspace chrome contract failed: ${JSON.stringify(chromePlacement)}`);
}
for (const file of ['social.js', 'social.css', 'workspace-sync.js']) {
  const response = await page.request.get(new URL(file, url).href);
  if (response.ok()) throw new Error(`retired asset is still served: ${file}`);
}

await seedImportedWitness();
await publish('First authored record with durable media.', { image: 'first.png', place: true });
await publish('Second authored record: text only.');
await publish('Third authored record with another asset.', { image: 'third.png', place: true });
await waitForOwnedCount(3);

let records = await readAll('records');
let authored = records.filter(record => String(record.nativeId || '').startsWith('sideways:workspace:'));
let blobs = await readAll('blobs');
if (authored.length !== 3 || blobs.length !== 2) throw new Error(`authored corpus mismatch: records=${authored.length} blobs=${blobs.length}`);
if (!records.some(record => record.tags?.includes('test:imported-witness'))) throw new Error('imported witness did not enter the feed');
await page.screenshot({ path: 'manual-workspace-populated.png', fullPage: true });

await deletePost('First authored record with durable media.', 'dismiss');
await deletePost('Second authored record: text only.');
await deletePost('First authored record with durable media.');
await deletePost('Third authored record with another asset.');
await waitForOwnedCount(0);

const deleteResults = actionEvents.filter(event => event.actionId === 'post.delete' && event.phase !== 'start');
const cancelledDeletes = deleteResults.filter(event => event.phase === 'cancelled').length;
const successfulDeletes = deleteResults.filter(event => event.phase === 'success').length;
if (cancelledDeletes !== 1 || successfulDeletes !== 3) throw new Error(`delete action truth failed: ${JSON.stringify(deleteResults)}`);

records = await readAll('records');
blobs = await readAll('blobs');
let ledger = await readAll('ledger');
const tombstones = ledger.filter(entry => entry.op === 'record.delete' && entry.source === 'workspace');
if (records.filter(record => String(record.nativeId || '').startsWith('sideways:workspace:')).length) throw new Error('authored records survived deletion');
if (!records.some(record => record.tags?.includes('test:imported-witness'))) throw new Error('authored deletion removed imported material');
if (blobs.length) throw new Error(`authored blobs survived deletion: ${blobs.length}`);
if (tombstones.length !== 3) throw new Error(`expected three atomic delete tombstones, found ${tombstones.length}`);
if (typeof await page.evaluate(() => window.SidewaysWorkspace.outboxCount) !== 'undefined') throw new Error('retired outbox API returned');

await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => document.documentElement.dataset.studioReady === 'yes', { timeout: 15000 });
await page.waitForFunction(() => document.documentElement.dataset.workspaceChrome === 'ready', { timeout: 15000 });
await waitForOwnedCount(0);
records = await readAll('records');
ledger = await readAll('ledger');
if (!records.some(record => record.tags?.includes('test:imported-witness'))) throw new Error('imported witness did not survive reload');
if (ledger.filter(entry => entry.op === 'record.delete' && entry.source === 'workspace').length !== 3) throw new Error('delete ledger did not survive reload');

const uncontracted = await page.locator('button:not([data-action-id]), [role="button"]:not([data-action-id])').evaluateAll(nodes => nodes
  .filter(node => node.getClientRects().length > 0)
  .filter(node => getComputedStyle(node).visibility !== 'hidden')
  .filter(node => !node.closest('[hidden], dialog:not([open])'))
  .filter(node => !node.closest('#debugPanel') && !node.matches('.type-nav button') && !node.matches('.actions > button'))
  .map(node => `${node.tagName.toLowerCase()}#${node.id}.${node.className}`));
if (uncontracted.length) throw new Error(`visible uncontracted controls: ${uncontracted.join(' | ')}`);
if (errors.length) throw new Error(errors.join(' | '));

await page.screenshot({ path: 'manual-workspace-phone.png', fullPage: true });
console.log(JSON.stringify({
  createdPosts: 3,
  deletedPosts: successfulDeletes,
  cancelledDeletes,
  authoredPostsAfterReload: 0,
  remainingAuthoredBlobs: 0,
  importedWitnessSurvived: true,
  compatibilityLedger: { entries: ledger.length, deleteTombstones: 3, survivedReload: true },
  retiredOutbox: true,
  chromePlacement,
  visibleUncontractedControls: 0,
  screenshots: ['manual-workspace-populated.png', 'manual-workspace-phone.png']
}, null, 2));

await context.close();
await browser.close();
