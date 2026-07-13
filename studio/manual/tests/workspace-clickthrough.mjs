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

async function corpusRecords() {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('sideways-manual-corpus-v1');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('records', 'readonly');
      const all = tx.objectStore('records').getAll();
      all.onerror = () => reject(all.error);
      all.onsuccess = () => resolve(all.result);
      tx.oncomplete = () => db.close();
    };
  }));
}

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.documentElement.dataset.studioReady === 'yes', { timeout: 15000 });

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

const chooserPromise = page.waitForEvent('filechooser', { timeout: 10000 });
await touch(composer.locator('[data-action-id="post.attach"]'));
const chooser = await chooserPromise;
await chooser.setFiles({
  name: 'tiny.png',
  mimeType: 'image/png',
  buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
});
await composer.locator('.workspace-image-preview img').waitFor({ state: 'visible', timeout: 10000 });
await touch(composer.locator('[data-action-id="post.publish"]'));
await composer.waitFor({ state: 'hidden', timeout: 10000 });

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
await touch(composer.locator('[data-action-id="post.publish"]'));
await composer.waitFor({ state: 'hidden', timeout: 10000 });
await page.locator('#feed .post').filter({ hasText: 'A lived system with one real content model.' }).waitFor({ state: 'visible', timeout: 15000 });

await touch(page.locator('#navPlaces[data-action-id="nav.places"]'));
await page.waitForURL(/#\/places$/, { timeout: 10000 });
const places = page.locator('#workspacePlacesView');
await places.waitFor({ state: 'visible', timeout: 10000 });
await places.getByText('Kitchen table', { exact: true }).waitFor({ state: 'visible', timeout: 5000 });
await places.getByText('1 item', { exact: true }).waitFor({ state: 'visible', timeout: 5000 });

const contracts = await page.evaluate(() => window.SidewaysActions.actionContract());
const ids = new Set(contracts.map(item => item.id));
for (const id of ['nav.places', 'post.publish', 'post.edit', 'post.delete', 'places.save', 'places.locate']) {
  if (!ids.has(id)) throw new Error(`missing workspace action contract: ${id}`);
}
for (const id of ['post.mood', 'post.style', 'post.react', 'post.remix', 'profile.random']) {
  if (ids.has(id)) throw new Error(`retired action contract remains: ${id}`);
}

await touch(page.locator('#navFeed[data-action-id="nav.feed"]'));
await page.waitForURL(/#\/feed$/, { timeout: 10000 });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => document.documentElement.dataset.studioReady === 'yes', { timeout: 15000 });
await page.locator('#feed .post').filter({ hasText: 'A lived system with one real content model.' }).waitFor({ state: 'visible', timeout: 15000 });
const savedProfile = await page.evaluate(() => window.SidewaysWorkspace.profile());
if (savedProfile.name !== 'KAI' || savedProfile.handle !== 'sideways' || savedProfile.bio !== 'Building a personal internet.') {
  throw new Error(`profile did not persist: ${JSON.stringify(savedProfile)}`);
}
records = await corpusRecords();
record = records.find(item => item.nativeId?.startsWith('sideways:workspace:'));
if (!record || record.text !== 'A lived system with one real content model.') throw new Error('canonical edit did not persist');
const savedPlaces = await page.evaluate(() => window.SidewaysWorkspace.listPlaces());
if (savedPlaces.length !== 1 || savedPlaces[0].name !== 'Kitchen table') throw new Error(`place did not persist: ${JSON.stringify(savedPlaces)}`);
const outbox = await page.evaluate(() => window.SidewaysWorkspace.outboxCount());
if (!(outbox > 0)) throw new Error('action outbox did not record the journey');

const uncontracted = await page.locator('button:not([data-action-id]), [role="button"]:not([data-action-id])').evaluateAll(nodes => nodes
  .filter(node => node.getClientRects().length > 0)
  .filter(node => getComputedStyle(node).visibility !== 'hidden')
  .filter(node => !node.closest('[hidden], dialog:not([open])'))
  .filter(node => !node.closest('#debugPanel') && !node.matches('.type-nav button') && !node.matches('.actions > button'))
  .map(node => node.textContent.trim() || node.getAttribute('aria-label') || node.outerHTML.slice(0, 80)));
if (uncontracted.length) throw new Error(`visible uncontracted workspace controls: ${uncontracted.join(' | ')}`);
if (errors.length) throw new Error(errors.join(' | '));

await page.screenshot({ path: 'manual-workspace-phone.png', fullPage: true });
console.log(JSON.stringify({
  profile: savedProfile,
  canonicalPosts: records.filter(item => item.nativeId?.startsWith('sideways:workspace:')).length,
  place: savedPlaces[0],
  imageAsset: Boolean(record.assetKey),
  edited: true,
  outbox,
  visibleUncontractedControls: 0,
  actionContracts: contracts.length,
  retiredSocialAssets: true,
  screenshot: 'manual-workspace-phone.png'
}, null, 2));

await context.close();
await browser.close();
