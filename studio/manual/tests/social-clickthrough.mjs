import fs from 'node:fs';
import { chromium } from 'playwright-core';

const url = process.argv[2];
if (!url) throw new Error('usage: node social-clickthrough.mjs <manual-url>');

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
      if (attempt < 3) await page.waitForTimeout(150);
    }
  }
  throw lastError;
}

async function openDock(actionId) {
  await touch(page.locator(`[data-os-dock] [data-action-id="${actionId}"]`));
}

async function openCreate(kind) {
  await openDock('nav.create');
  const sheet = page.locator('[data-os-create]');
  await sheet.waitFor({ state: 'visible', timeout: 10000 });
  await touch(sheet.locator(`[data-action-id="create.${kind}"]`));
}

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.documentElement.dataset.studioReady === 'yes' && window.SidewaysShell && window.SidewaysSocial, { timeout: 15000 });
await page.waitForFunction(() => window.SidewaysWorkspace && typeof window.SidewaysWorkspace.exportSnapshot === 'function', { timeout: 15000 });

for (const phrase of ['YOUR STUFF. ONE FEED.', 'BRING YOUR INTERNET', 'YOUR STUFF, RECOMPOSED', 'YOUR INTERNET, YOUR WAY']) {
  if ((await page.getByText(phrase, { exact: false }).count()) > 0) throw new Error(`editorial copy returned: ${phrase}`);
}

const dock = page.locator('[data-os-dock]');
const dockIds = await dock.locator('[data-action-id]').evaluateAll(nodes => nodes.map(node => node.dataset.actionId));
if (dockIds.join('|') !== 'nav.feed|nav.places|nav.create|nav.me') throw new Error(`wrong dock topology: ${dockIds.join('|')}`);
if (await page.locator('[data-os-dock] [data-action-id="nav.saved"], [data-os-dock] [data-action-id="nav.import"]').count()) throw new Error('deleted top-level tab returned');

const visual = await page.evaluate(() => {
  const dockStyle = getComputedStyle(document.querySelector('[data-os-dock]'));
  const mainStyle = getComputedStyle(document.querySelector('main'));
  return {
    dockPosition: dockStyle.position,
    dockBlur: dockStyle.backdropFilter || dockStyle.webkitBackdropFilter,
    mainBorder: parseFloat(mainStyle.borderTopWidth),
    oldPaper: getComputedStyle(document.documentElement).getPropertyValue('--studio-paper').trim()
  };
});
if (visual.dockPosition !== 'fixed') throw new Error(`dock is not spatially anchored: ${visual.dockPosition}`);
if (!visual.dockBlur || visual.dockBlur === 'none') throw new Error('dock has no material physics');
if (visual.mainBorder > 1.1) throw new Error(`main window border is too heavy: ${visual.mainBorder}`);
if (visual.oldPaper) throw new Error('old beige visual token still exists');

await openDock('nav.me');
const meView = page.locator('#osMeView');
await meView.waitFor({ state: 'visible', timeout: 10000 });
await touch(meView.locator('[data-action-id="profile.open"]'));
const profile = page.locator('[data-social-profile]');
await profile.waitFor({ state: 'visible', timeout: 10000 });
await profile.locator('input[name="socialName"]').fill('KAI');
await profile.locator('input[name="socialHandle"]').fill('@sideways');
await touch(profile.locator('[data-action-id="profile.avatar"][data-value="✦"]'));
await touch(profile.locator('[data-action-id="profile.color"][data-value="#7c6df2"]'));
await touch(profile.locator('[data-action-id="profile.save"]'));
await profile.waitFor({ state: 'hidden', timeout: 5000 });

await openDock('nav.places');
const placesView = page.locator('#osPlacesView');
await placesView.waitFor({ state: 'visible', timeout: 10000 });
await touch(placesView.locator('[data-action-id="place.create"]'));
const placeDialog = page.locator('.os-small-sheet[open]');
await placeDialog.waitFor({ state: 'visible', timeout: 5000 });
await placeDialog.locator('input[name="placeName"]').fill('Field Notes');
await touch(placeDialog.locator('[data-action-id="place.create"]'));
await placeDialog.waitFor({ state: 'hidden', timeout: 5000 });
const fieldPlace = placesView.locator('[data-place-id]').filter({ hasText: 'Field Notes' });
await fieldPlace.waitFor({ state: 'visible', timeout: 10000 });

await openCreate('post');
let composer = page.locator('[data-social-composer]');
await composer.waitFor({ state: 'visible', timeout: 10000 });
await composer.locator('.social-composer-author').filter({ hasText: 'KAI' }).waitFor({ state: 'visible', timeout: 5000 });
await composer.locator('.social-composer-text').fill('THE WINDOW IS THE PLACE');
await touch(composer.locator('[data-action-id="post.style"][data-value="MONO"]'));
await touch(composer.locator('[data-action-id="post.place"]').filter({ hasText: 'Field Notes' }));
await composer.getByText('Saved', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });

const draftCount = await page.evaluate(async () => (await window.SidewaysWorkspace.listDrafts()).length);
if (draftCount !== 1) throw new Error(`draft autosave is not durable: ${draftCount}`);

const chooserPromise = page.waitForEvent('filechooser', { timeout: 10000 });
await touch(composer.locator('[data-action-id="post.attach"]'));
const chooser = await chooserPromise;
await chooser.setFiles({
  name: 'tiny.png',
  mimeType: 'image/png',
  buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
});
await composer.locator('.social-image-preview img').waitFor({ state: 'visible', timeout: 10000 });
await touch(composer.locator('[data-action-id="post.publish"]'));
await composer.waitFor({ state: 'hidden', timeout: 10000 });

let first = page.locator('[data-social-post]').filter({ has: page.locator('.social-post-text', { hasText: 'THE WINDOW IS THE PLACE' }) });
await first.waitFor({ state: 'visible', timeout: 10000 });
if ((await first.locator('.social-post-image').count()) !== 1) throw new Error('photo post did not render');
if (!(await first.getByText('KAI', { exact: true }).count())) throw new Error('profile name did not reach the post');
if (await first.locator('[data-action-id="post.react"], [data-action-id="post.save"]').count()) throw new Error('fake self-social actions returned');

await touch(first.locator('[data-action-id="post.later"]'));
await page.locator('[data-os-toast]').filter({ hasText: 'Moved to Later' }).waitFor({ state: 'visible', timeout: 5000 });

await openDock('nav.places');
const laterPlace = placesView.locator('[data-place-id="later"]');
await laterPlace.waitFor({ state: 'visible', timeout: 10000 });
await touch(laterPlace.locator('[data-action-id="place.open"]'));
first = page.locator('[data-social-post]').filter({ has: page.locator('.social-post-text', { hasText: 'THE WINDOW IS THE PLACE' }) });
await first.waitFor({ state: 'visible', timeout: 10000 });
if ((await first.getAttribute('data-place-id')) !== 'later') throw new Error('Later did not become a real location');

await touch(first.locator('[data-action-id="post.more"]'));
let menu = page.locator('.os-small-sheet[open]');
await menu.waitFor({ state: 'visible', timeout: 5000 });
await touch(menu.locator('[data-action-id="post.edit"]'));
composer = page.locator('[data-social-composer]');
await composer.waitFor({ state: 'visible', timeout: 10000 });
await composer.locator('.social-composer-text').fill('THE WINDOW BECAME A ROOM');
await touch(composer.locator('[data-action-id="post.place"]').filter({ hasText: 'Later' }));
await touch(composer.locator('[data-action-id="post.update"]'));
await composer.waitFor({ state: 'hidden', timeout: 10000 });
first = page.locator('[data-social-post]').filter({ has: page.locator('.social-post-text', { hasText: 'THE WINDOW BECAME A ROOM' }) });
await first.waitFor({ state: 'visible', timeout: 10000 });

await touch(first.locator('[data-action-id="post.remix"]'));
composer = page.locator('[data-social-composer]');
await composer.waitFor({ state: 'visible', timeout: 10000 });
await composer.locator('.social-remix-preview').waitFor({ state: 'visible', timeout: 5000 });
await composer.locator('.social-composer-text').fill('ROOM TWO');
await touch(composer.locator('[data-action-id="post.publish"]'));
await page.waitForFunction(() => document.querySelectorAll('[data-social-post]').length === 2, { timeout: 10000 });

first = page.locator('[data-social-post]').filter({ has: page.locator('.social-post-text', { hasText: 'THE WINDOW BECAME A ROOM' }) });
await touch(first.locator('[data-action-id="post.more"]'));
menu = page.locator('.os-small-sheet[open]');
await menu.waitFor({ state: 'visible', timeout: 5000 });
await touch(menu.locator('[data-action-id="post.archive"]'));
await page.waitForFunction(() => document.querySelectorAll('[data-social-post]').length === 1, { timeout: 10000 });
const undoToast = page.locator('[data-os-toast]').filter({ hasText: 'Archived' });
await undoToast.waitFor({ state: 'visible', timeout: 5000 });
await touch(undoToast.locator('[data-action-id="undo.last"]'));
await page.waitForFunction(() => document.querySelectorAll('[data-social-post]').length === 2, { timeout: 10000 });

const contract = await page.evaluate(() => window.SidewaysSocial.actionContract());
if (!Array.isArray(contract) || contract.length < 45) throw new Error(`action contract too small: ${contract?.length}`);
const byId = new Map(contract.map(item => [item.id, item]));
for (const id of ['nav.places', 'nav.create', 'post.publish', 'post.update', 'post.move', 'post.later', 'post.archive', 'undo.last']) {
  if (!byId.has(id)) throw new Error(`missing action contract: ${id}`);
  if (!byId.get(id).command) throw new Error(`action lacks backend command: ${id}`);
}
for (const removed of ['nav.saved', 'nav.import', 'post.react', 'post.save']) {
  if (byId.has(removed)) throw new Error(`deleted action returned: ${removed}`);
}
if (!byId.get('post.move').undoable || !byId.get('post.archive').undoable) throw new Error('durable moves are not declared undoable');

const results = await page.evaluate(() => window.SidewaysSocial.results());
if (!results['post.style']?.values?.MONO) throw new Error('action results did not learn the selected look');

const snapshot = await page.evaluate(() => window.SidewaysWorkspace.exportSnapshot());
if (!snapshot || JSON.stringify(snapshot).length < 80) throw new Error('workspace snapshot is empty');
const draftsAfterPublish = await page.evaluate(async () => (await window.SidewaysWorkspace.listDrafts()).length);
if (draftsAfterPublish !== 0) throw new Error(`published drafts were not atomically cleared: ${draftsAfterPublish}`);

await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => window.SidewaysWorkspace && document.querySelectorAll('[data-social-post]').length === 2, { timeout: 15000 });
const savedProfile = await page.evaluate(() => window.SidewaysSocial.profile());
if (savedProfile.name !== 'KAI' || savedProfile.handle !== 'sideways' || savedProfile.avatar !== '✦') throw new Error(`profile did not persist: ${JSON.stringify(savedProfile)}`);
const activePlace = await page.evaluate(() => window.SidewaysWorkspace.getActivePlace());
if (activePlace !== 'later') throw new Error(`active location did not persist: ${activePlace}`);

const uncontracted = await page.locator('button:not([data-action-id]), [role="button"]:not([data-action-id])').evaluateAll(nodes => nodes
  .filter(node => node.getClientRects().length > 0)
  .filter(node => getComputedStyle(node).visibility !== 'hidden')
  .filter(node => !node.closest('[hidden], dialog:not([open])'))
  .filter(node => !node.closest('#debugPanel') && !node.matches('.type-nav button') && !node.matches('.actions button'))
  .map(node => node.textContent.trim() || node.getAttribute('aria-label') || node.outerHTML.slice(0, 80)));
if (uncontracted.length) throw new Error(`visible uncontracted product controls: ${uncontracted.join(' | ')}`);
if (errors.length) throw new Error(errors.join(' | '));

await page.screenshot({ path: 'manual-os-phone.png', fullPage: true });
await page.setViewportSize({ width: 1280, height: 900 });
await page.waitForTimeout(350);
await page.screenshot({ path: 'manual-os-desktop.png', fullPage: true });

console.log(JSON.stringify({
  topology: ['Feed', 'Places', 'Create', 'Me'],
  profile: savedProfile,
  customPlace: 'Field Notes',
  activePlace,
  draftsAtomic: true,
  posts: 2,
  photo: true,
  edit: true,
  remix: true,
  archiveUndo: true,
  oldSocialActions: false,
  actionContracts: contract.length,
  visual,
  screenshots: ['manual-os-phone.png', 'manual-os-desktop.png']
}, null, 2));

await context.close();
await browser.close();
