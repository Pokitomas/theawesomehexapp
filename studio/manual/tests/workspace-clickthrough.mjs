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

const browser = await chromium.launch({
  headless: true,
  executablePath,
  args: ['--no-sandbox', '--disable-dev-shm-usage']
});
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
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

async function touch(locator) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await locator.waitFor({ state: 'visible', timeout: 12000 });
      await locator.scrollIntoViewIfNeeded();
      const box = await locator.boundingBox();
      if (!box) throw new Error('touch target has no bounding box');
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await page.waitForTimeout(120);
    }
  }
  throw lastError;
}

async function readAll(databaseName, storeName) {
  return page.evaluate(({ databaseName, storeName }) => new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(storeName, 'readonly');
      const all = transaction.objectStore(storeName).getAll();
      all.onerror = () => reject(all.error);
      all.onsuccess = () => resolve(all.result);
      transaction.oncomplete = () => db.close();
    };
  }), { databaseName, storeName });
}

const corpusRecords = () => readAll('sideways-manual-corpus-v1', 'records');
const corpusBlobs = () => readAll('sideways-manual-corpus-v1', 'blobs');
const workspaceEvents = () => readAll('sideways-workspace-v1', 'events');

async function waitForOwnedCount(expected) {
  await page.waitForFunction(count => window.SidewaysWorkspace.ownedEntries().then(records => records.length === count), expected, { timeout: 15000 });
}

async function attachTinyImage(composer, name) {
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 10000 });
  await touch(composer.locator('[data-action-id="post.attach"]'));
  const chooser = await chooserPromise;
  await chooser.setFiles({ name, mimeType: 'image/png', buffer: tinyPng });
  await composer.locator('.workspace-image-preview img').waitFor({ state: 'visible', timeout: 10000 });
}

async function openNewComposer() {
  await touch(page.locator('[data-workspace-new][data-action-id="feed.post"]'));
  const composer = page.locator('[data-workspace-composer]');
  await composer.waitFor({ state: 'visible', timeout: 10000 });
  return composer;
}

async function publishComposer(composer) {
  await touch(composer.locator('[data-action-id="post.publish"]'));
  await composer.waitFor({ state: 'hidden', timeout: 10000 });
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
        type: 'social',
        title: 'Imported witness',
        summary: 'This imported item must survive deleting every authored post.',
        text: 'This imported item must survive deleting every authored post.',
        body: [],
        source: 'Test import',
        sourceUrl: '',
        outboundUrl: '',
        author: { name: 'Archive', handle: '', url: '', avatar: '' },
        published: now,
        addedAt: now,
        updatedAt: now,
        originalName: 'Imported witness',
        mime: 'text/plain',
        size: 62,
        hash: `test-import-witness:${Date.now()}`,
        assetKey: '',
        mediaKind: '',
        width: 0,
        height: 0,
        nativeId: `reddit:witness:${Date.now()}`,
        links: [],
        tags: ['test:imported-witness'],
        rank: {}
      });
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('witness transaction aborted'));
    };
  }));

  await page.evaluate(() => new Promise(resolve => {
    const timer = setTimeout(() => resolve({ timedOut: true }), 3000);
    window.addEventListener('sideways:corpusrefresh', event => {
      clearTimeout(timer);
      resolve(event.detail || {});
    }, { once: true });
    window.dispatchEvent(new CustomEvent('sideways:importcomplete', { detail: { source: 'destructive-flow-witness' } }));
  }));
}

async function deletePost(text, decision = 'accept') {
  const card = page.locator('#feed .post').filter({ hasText: text });
  await card.waitFor({ state: 'visible', timeout: 15000 });
  const dialogPromise = page.waitForEvent('dialog', { timeout: 10000 });
  const tapPromise = touch(card.locator('[data-action-id="post.delete"]'));
  const dialog = await dialogPromise;
  if (!dialog.message().includes('Delete this post from this device?')) throw new Error(`unexpected delete confirmation: ${dialog.message()}`);
  if (decision === 'dismiss') await dialog.dismiss();
  else await dialog.accept();
  await tapPromise;

  if (decision === 'dismiss') {
    await card.waitFor({ state: 'visible', timeout: 5000 });
    return;
  }
  await page.waitForFunction(value => ![...document.querySelectorAll('#feed .post')].some(node => node.textContent.includes(value)), text, { timeout: 15000 });
}

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.documentElement.dataset.studioReady === 'yes', { timeout: 15000 });
await page.waitForFunction(() => document.documentElement.dataset.workspaceChrome === 'ready', { timeout: 15000 });

const chromePlacement = await page.evaluate(() => {
  const commandbar = document.querySelector('[data-workspace-commandbar]');
  const titleActions = document.querySelector('[data-workspace-title-actions]');
  const newButton = document.querySelector('[data-workspace-new]');
  const nav = document.querySelector('[data-workspace-nav]');
  const profile = document.getElementById('navProfile');
  const post = document.querySelector('#feed .post');
  return {
    newInCommandbar: Boolean(commandbar && newButton && commandbar.contains(newButton)),
    navInCommandbar: Boolean(commandbar && nav && commandbar.contains(nav)),
    profileInTitlebar: Boolean(titleActions && profile && titleActions.contains(profile)),
    mobileLabelsVisible: newButton ? getComputedStyle(newButton.querySelector('.workspace-button-label')).display !== 'none' : false,
    postRadius: post ? parseFloat(getComputedStyle(post).borderRadius) : 0
  };
});
if (!chromePlacement.newInCommandbar || !chromePlacement.navInCommandbar || !chromePlacement.profileInTitlebar || !chromePlacement.mobileLabelsVisible) {
  throw new Error(`workspace controls are not in the operating-system chrome: ${JSON.stringify(chromePlacement)}`);
}
if (chromePlacement.postRadius > 8) throw new Error(`cards regressed to rounded dashboard styling: ${chromePlacement.postRadius}`);

for (const selector of ['.social-post-card', '.social-option-grid', '[data-action-id="post.mood"]', '[data-action-id="post.style"]', '[data-action-id="post.react"]', '[data-action-id="post.remix"]']) {
  if (await page.locator(selector).count()) throw new Error(`retired social control returned: ${selector}`);
}
for (const file of ['social.js', 'social.css']) {
  const response = await page.request.get(new URL(file, url).href);
  if (response.ok()) throw new Error(`retired asset is still served: ${file}`);
}

const me = page.locator('#navProfile[data-action-id="profile.open"]');
await touch(me);
const profile = page.locator('[data-workspace-profile-dialog]');
await profile.waitFor({ state: 'visible', timeout: 10000 });
await profile.locator('input[name="workspaceName"]').fill('KAI');
await profile.locator('input[name="workspaceHandle"]').fill('@sideways');
await profile.locator('textarea[name="workspaceBio"]').fill('Building a personal internet.');
await touch(profile.locator('[data-action-id="profile.accent"]').nth(2));
await touch(profile.locator('[data-action-id="profile.save"]'));
await profile.waitFor({ state: 'hidden', timeout: 5000 });

await touch(page.locator('.studio-launch-button.is-post'));
const composer = page.locator('[data-workspace-composer]');
await composer.waitFor({ state: 'visible', timeout: 10000 });
await composer.locator('.workspace-composer-text').fill('A lived system, not a retro costume.');

await touch(composer.locator('[data-action-id="composer.place"]'));
const picker = page.locator('[data-workspace-place-picker]');
await picker.waitFor({ state: 'visible', timeout: 5000 });
await touch(picker.locator('[data-action-id="places.create"]'));
const placeEditor = page.locator('[data-workspace-place-editor]');
await placeEditor.waitFor({ state: 'visible', timeout: 5000 });
await placeEditor.locator('input[name="placeName"]').fill('Kitchen table');
await placeEditor.locator('textarea[name="placeDetail"]').fill('Where the app became real.');
await touch(placeEditor.locator('[data-action-id="places.locate"]'));
await placeEditor.locator('input[name="placeLatitude"]').waitFor({ state: 'visible' });
await page.waitForFunction(() => document.querySelector('input[name="placeLatitude"]')?.value.length > 0, { timeout: 10000 });
await touch(placeEditor.locator('[data-action-id="places.save"]'));
await placeEditor.waitFor({ state: 'hidden', timeout: 5000 });

await attachTinyImage(composer, 'first-transparent.png');
await publishComposer(composer);

const authored = page.locator('#feed .post').filter({ hasText: 'A lived system, not a retro costume.' });
await authored.waitFor({ state: 'visible', timeout: 15000 });
await authored.locator('[data-workspace-post-controls]').waitFor({ state: 'visible', timeout: 10000 });
if (!(await authored.getByText('Kitchen table', { exact: true }).count())) throw new Error('place did not reach the canonical feed card');

let records = await corpusRecords();
let record = records.find(item => item.nativeId?.startsWith('sideways:workspace:'));
if (!record) throw new Error('authored post did not enter the canonical corpus');
if (!record.tags?.some(tag => tag.startsWith('place:'))) throw new Error('canonical post is missing its place tag');
if (!record.assetKey) throw new Error('canonical post is missing its image asset key');
if (record.author?.name !== 'KAI' || record.author?.handle !== '@sideways') throw new Error(`profile did not reach canonical record: ${JSON.stringify(record.author)}`);

await touch(authored.locator('[data-action-id="post.edit"]'));
await composer.waitFor({ state: 'visible', timeout: 10000 });
await composer.locator('.workspace-composer-text').fill('A lived system with one real content model.');
await publishComposer(composer);
await page.locator('#feed .post').filter({ hasText: 'A lived system with one real content model.' }).waitFor({ state: 'visible', timeout: 15000 });

let secondComposer = await openNewComposer();
await secondComposer.locator('.workspace-composer-text').fill('Second post: text only, deliberately disposable.');
await publishComposer(secondComposer);
await page.locator('#feed .post').filter({ hasText: 'Second post: text only, deliberately disposable.' }).waitFor({ state: 'visible', timeout: 15000 });

let thirdComposer = await openNewComposer();
await thirdComposer.locator('.workspace-composer-text').fill('Third post returns to the Kitchen table.');
await touch(thirdComposer.locator('[data-action-id="composer.place"]'));
const secondPicker = page.locator('[data-workspace-place-picker]');
await secondPicker.waitFor({ state: 'visible', timeout: 5000 });
await touch(secondPicker.locator('[data-action-id="places.use"]').filter({ hasText: 'Kitchen table' }));
await attachTinyImage(thirdComposer, 'third-transparent.png');
await publishComposer(thirdComposer);
await page.locator('#feed .post').filter({ hasText: 'Third post returns to the Kitchen table.' }).waitFor({ state: 'visible', timeout: 15000 });

await waitForOwnedCount(3);
records = await corpusRecords();
let authoredRecords = records.filter(item => item.nativeId?.startsWith('sideways:workspace:'));
if (authoredRecords.length !== 3) throw new Error(`expected three authored records, found ${authoredRecords.length}`);
let blobs = await corpusBlobs();
if (blobs.length !== 2) throw new Error(`expected two authored image blobs, found ${blobs.length}`);

await touch(page.locator('#navPlaces[data-action-id="nav.places"]'));
await page.waitForURL(/#\/places$/, { timeout: 10000 });
const places = page.locator('#workspacePlacesView');
await places.waitFor({ state: 'visible', timeout: 10000 });
await places.getByText('Kitchen table', { exact: true }).waitFor({ state: 'visible', timeout: 5000 });
await places.getByText('2 items', { exact: true }).waitFor({ state: 'visible', timeout: 5000 });

const contracts = await page.evaluate(() => window.SidewaysActions.actionContract());
const ids = new Set(contracts.map(item => item.id));
for (const id of ['nav.places', 'post.publish', 'post.edit', 'post.delete', 'record.source', 'record.author', 'record.open', 'record.save', 'record.collect', 'record.share', 'places.save', 'places.locate']) {
  if (!ids.has(id)) throw new Error(`missing workspace action contract: ${id}`);
}
for (const id of ['post.mood', 'post.style', 'post.react', 'post.remix', 'profile.random']) {
  if (ids.has(id)) throw new Error(`retired action contract remains: ${id}`);
}

await touch(page.locator('#navFeed[data-action-id="nav.feed"]'));
await page.waitForURL(/#\/feed$/, { timeout: 10000 });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => document.documentElement.dataset.studioReady === 'yes', { timeout: 15000 });
await page.waitForFunction(() => document.documentElement.dataset.workspaceChrome === 'ready', { timeout: 15000 });
for (const text of [
  'A lived system with one real content model.',
  'Second post: text only, deliberately disposable.',
  'Third post returns to the Kitchen table.'
]) {
  await page.locator('#feed .post').filter({ hasText: text }).waitFor({ state: 'visible', timeout: 15000 });
}

const savedProfile = await page.evaluate(() => window.SidewaysWorkspace.profile());
if (savedProfile.name !== 'KAI' || savedProfile.handle !== 'sideways' || savedProfile.bio !== 'Building a personal internet.') {
  throw new Error(`profile did not persist: ${JSON.stringify(savedProfile)}`);
}
records = await corpusRecords();
record = records.find(item => item.nativeId?.startsWith('sideways:workspace:') && item.text === 'A lived system with one real content model.');
if (!record) throw new Error('canonical edit did not persist');
const savedPlaces = await page.evaluate(() => window.SidewaysWorkspace.listPlaces());
if (savedPlaces.length !== 1 || savedPlaces[0].name !== 'Kitchen table') throw new Error(`place did not persist: ${JSON.stringify(savedPlaces)}`);

await page.screenshot({ path: 'manual-workspace-populated.png', fullPage: true });
await seedImportedWitness();
await page.locator('#feed .post').filter({ hasText: 'Imported witness' }).waitFor({ state: 'visible', timeout: 15000 });

await deletePost('Second post: text only, deliberately disposable.', 'dismiss');
await waitForOwnedCount(3);
await deletePost('Second post: text only, deliberately disposable.');
await waitForOwnedCount(2);
blobs = await corpusBlobs();
if (blobs.length !== 2) throw new Error('deleting a text-only post unexpectedly changed image blobs');

await deletePost('A lived system with one real content model.');
await waitForOwnedCount(1);
blobs = await corpusBlobs();
if (blobs.length !== 1) throw new Error(`first image blob leaked or over-deleted: ${blobs.length}`);

await deletePost('Third post returns to the Kitchen table.');
await waitForOwnedCount(0);
blobs = await corpusBlobs();
if (blobs.length !== 0) throw new Error(`authored image blobs survived deleting every post: ${blobs.length}`);

records = await corpusRecords();
authoredRecords = records.filter(item => item.nativeId?.startsWith('sideways:workspace:'));
if (authoredRecords.length) throw new Error(`authored records survived destructive flow: ${authoredRecords.length}`);
const witness = records.find(item => item.tags?.includes('test:imported-witness'));
if (!witness) throw new Error('deleting authored posts also deleted imported library material');
await page.locator('#feed .post').filter({ hasText: 'Imported witness' }).waitFor({ state: 'visible', timeout: 15000 });
if (await page.locator('[data-workspace-post-controls]').count()) throw new Error('owned controls survived after every authored post was deleted');

await touch(page.locator('#navPlaces[data-action-id="nav.places"]'));
await page.waitForURL(/#\/places$/, { timeout: 10000 });
await places.getByText('0 items', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });

await touch(page.locator('#navFeed[data-action-id="nav.feed"]'));
await page.waitForURL(/#\/feed$/, { timeout: 10000 });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => document.documentElement.dataset.studioReady === 'yes', { timeout: 15000 });
await page.waitForFunction(() => document.documentElement.dataset.workspaceChrome === 'ready', { timeout: 15000 });
await waitForOwnedCount(0);
await page.locator('#feed .post').filter({ hasText: 'Imported witness' }).waitFor({ state: 'visible', timeout: 15000 });
if (await page.locator('#feed .post').filter({ hasText: 'A lived system with one real content model.' }).count()) throw new Error('deleted post returned after reload');

let events = [];
for (let attempt = 0; attempt < 30; attempt += 1) {
  events = await workspaceEvents();
  const deleteResults = events.filter(event => event.actionId === 'post.delete' && event.phase !== 'start');
  if (deleteResults.length >= 4) break;
  await page.waitForTimeout(100);
}
const deleteResults = events.filter(event => event.actionId === 'post.delete' && event.phase !== 'start');
const cancelledDeletes = deleteResults.filter(event => event.phase === 'cancelled').length;
const successfulDeletes = deleteResults.filter(event => event.phase === 'success').length;
if (cancelledDeletes !== 1) throw new Error(`cancelled delete lifecycle is dishonest: ${JSON.stringify(deleteResults)}`);
if (successfulDeletes !== 3) throw new Error(`expected three successful delete lifecycles: ${JSON.stringify(deleteResults)}`);

const outbox = await page.evaluate(() => window.SidewaysWorkspace.outboxCount());
if (!(outbox > 0)) throw new Error('action outbox did not record the destructive journey');

const uncontracted = await page.locator('button:not([data-action-id]), [role="button"]:not([data-action-id])').evaluateAll(nodes => nodes
  .filter(node => node.getClientRects().length > 0)
  .filter(node => getComputedStyle(node).visibility !== 'hidden')
  .filter(node => !node.closest('[hidden], dialog:not([open])'))
  .filter(node => !node.closest('#debugPanel') && !node.matches('.type-nav button') && !node.matches('.actions > button'))
  .map(node => `${node.tagName.toLowerCase()}#${node.id}.${node.className} :: ${node.textContent.trim() || node.getAttribute('aria-label') || node.outerHTML.slice(0, 80)}`));
if (uncontracted.length) throw new Error(`visible uncontracted workspace controls: ${uncontracted.join(' | ')}`);
if (errors.length) throw new Error(errors.join(' | '));

await page.screenshot({ path: 'manual-workspace-phone.png', fullPage: true });
console.log(JSON.stringify({
  profile: savedProfile,
  createdPosts: 3,
  deletedPosts: successfulDeletes,
  cancelledDeletes,
  authoredPostsAfterReload: 0,
  remainingAuthoredBlobs: blobs.length,
  importedWitnessSurvived: Boolean(witness),
  placeAfterDeletes: { ...savedPlaces[0], items: 0 },
  chromePlacement,
  outbox,
  visibleUncontractedControls: 0,
  actionContracts: contracts.length,
  retiredSocialAssets: true,
  screenshots: ['manual-workspace-populated.png', 'manual-workspace-phone.png']
}, null, 2));

await context.close();
await browser.close();
