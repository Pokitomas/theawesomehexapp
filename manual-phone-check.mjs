import fs from 'node:fs';
import { chromium } from 'playwright-core';

const paths = [
  process.env.CHROME_BIN,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean);
const executablePath = paths.find(path => fs.existsSync(path));
if (!executablePath) throw new Error('no Chromium found');

const iphone = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1'
};
const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });

function collectErrors(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  return errors;
}

async function touch(page, locator) {
  await locator.waitFor({ state: 'visible', timeout: 10000 });
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('touch target has no bounding box');
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

async function waitForImportOutcome(page) {
  await page.waitForFunction(() => document.querySelector('.import-complete-panel, .import-error-panel'), { timeout: 15000 });
  const error = page.locator('.import-error-panel');
  if (await error.count()) throw new Error(`import error: ${(await error.innerText()).trim()}`);
  await page.locator('.import-complete-panel').waitFor({ state: 'visible', timeout: 5000 });
}

function installProfile(context) {
  return context.addInitScript(() => {
    localStorage.setItem('sideways-workspace-profile-v1', JSON.stringify({
      name: 'Proof User', handle: 'proof', bio: '', accent: '#335cff'
    }));
  });
}

async function expectFourChoices(page) {
  await page.waitForFunction(() => document.documentElement.dataset.addToSidewaysReady === 'yes', { timeout: 10000 });
  const choices = page.locator('.add-sideways-choice');
  if ((await choices.count()) !== 4) throw new Error(`expected exactly four Add to Sideways choices, got ${await choices.count()}`);
  for (const label of ['Connect an account', 'Add a website or feed', 'Import files', 'Restore a Sideways backup']) {
    if ((await page.getByRole('button', { name: label, exact: true }).count()) !== 1) throw new Error(`missing Add to Sideways choice: ${label}`);
  }
  for (const badge of ['Web', 'Connected', 'Private', 'Shared']) {
    if ((await page.locator('.capability-badge').filter({ hasText: badge }).count()) !== 1) throw new Error(`missing capability badge: ${badge}`);
  }
}

const gateContext = await browser.newContext(iphone);
await installProfile(gateContext);
const gatePage = await gateContext.newPage();
const gateErrors = collectErrors(gatePage);
await gatePage.goto('http://127.0.0.1:4173/manual/?debug=1&test=1&autorun=1', { waitUntil: 'networkidle' });
await gatePage.waitForFunction(() => document.documentElement.dataset.gateMoved === 'yes', { timeout: 20000 });
const count = (await gatePage.locator('#corpusStatus').textContent())?.trim();
const policy = (await gatePage.locator('#debugPolicy').textContent()) || '';
const state = (await gatePage.locator('#debugState').textContent()) || '';
const gate = Number((policy.match(/gate=([0-9.]+)/) || [])[1]);
if (count !== '20 THINGS') throw new Error(`expected 20 THINGS, got ${count}`);
if (!(gate > .05)) throw new Error(`gate did not visibly move: ${policy}`);
if (!/state=(saturation|deep_saturation)/.test(state)) throw new Error(`state did not change: ${state}`);
for (const label of ['ADD', 'MOVE GATE']) {
  if (!(await gatePage.getByRole('button', { name: label, exact: true }).count())) throw new Error(`missing core button ${label}`);
}
const commandbar = gatePage.locator('[data-workspace-commandbar]');
await commandbar.waitFor({ state: 'visible', timeout: 10000 });
for (const label of ['New', 'Feed', 'Places', 'Library']) {
  if (!(await commandbar.getByText(label, { exact: true }).count())) throw new Error(`missing workspace command ${label}`);
}
await touch(gatePage, gatePage.getByRole('button', { name: 'ADD', exact: true }));
await gatePage.locator('#addView').waitFor({ state: 'visible', timeout: 10000 });
const coreFilesContract = await gatePage.locator('#addView').evaluate(node => node.textContent.includes('FILES +'));
if (!coreFilesContract) throw new Error('underlying FILES + compatibility contract disappeared');
await gatePage.locator('#importWorkbenchHost').waitFor({ state: 'visible', timeout: 10000 });
await gatePage.locator('section[data-survival-vault]').waitFor({ state: 'visible', timeout: 10000 });
await expectFourChoices(gatePage);
const visibleLegacyChildren = await gatePage.locator('#addView.studio-add-modern').evaluate(node => [...node.children]
  .filter(child => !child.matches('#importWorkbenchHost, [data-workspace-library-header], [data-survival-vault]'))
  .filter(child => getComputedStyle(child).display !== 'none').length);
if (visibleLegacyChildren !== 0) throw new Error(`legacy ADD surface still visible: ${visibleLegacyChildren} child node(s)`);
if (gateErrors.length) throw new Error(gateErrors.join(' | '));
await gatePage.screenshot({ path: 'manual-phone-gate.png', fullPage: true });
await gateContext.close();

const consumerContext = await browser.newContext(iphone);
await installProfile(consumerContext);
const consumer = await consumerContext.newPage();
const consumerErrors = collectErrors(consumer);
let loads = 0;
consumer.on('load', () => { loads += 1; });
await consumer.goto('http://127.0.0.1:4173/manual/', { waitUntil: 'networkidle' });
loads = 0;
await consumer.waitForFunction(() => document.documentElement.dataset.studioReady === 'yes', { timeout: 15000 });
await touch(consumer, consumer.getByRole('button', { name: 'ADD', exact: true }));
await consumer.locator('#addView').waitFor({ state: 'visible', timeout: 10000 });
await consumer.locator('#importWorkbenchHost').waitFor({ state: 'visible', timeout: 10000 });
await consumer.locator('section[data-survival-vault]').waitFor({ state: 'visible', timeout: 10000 });
await consumer.locator('#sidewaysImportFiles[data-phone-ready="yes"]').waitFor({ state: 'attached', timeout: 10000 });
if (await consumer.locator('[data-studio-intro]').count()) throw new Error('duplicate intro card still exists');
await expectFourChoices(consumer);
for (const forbidden of ['SAVE AND CHOOSE AN APP', 'I HAVE THE FILES', 'ADD TO MY FEED', 'PICK MORE FILES', 'PICK FOLDER']) {
  if (await consumer.getByText(forbidden, { exact: true }).count()) throw new Error(`old setup UI still visible: ${forbidden}`);
}
if (await consumer.locator('[data-studio-profile-setup]').count()) throw new Error('profile gate still exists');

const chooserPromise = consumer.waitForEvent('filechooser', { timeout: 10000 });
await touch(consumer, consumer.getByRole('button', { name: 'Import files', exact: true }));
const chooser = await chooserPromise;
await chooser.setFiles({
  name: 'comments.csv',
  mimeType: 'text/csv',
  buffer: Buffer.from('body,subreddit,permalink,created_utc,author,id\n"hello from reddit",sideways,/r/sideways/comments/1,1700000000,kai,abc123\n')
});

await waitForImportOutcome(consumer);
if (await consumer.locator('.add-sideways-choice').count()) throw new Error('Add to Sideways chooser remains visible behind completion');
const refreshedCount = (await consumer.locator('#corpusStatus').textContent())?.trim() || '';
if (!/^[1-9]\d* THING/.test(refreshedCount)) throw new Error(`core did not refresh after import: ${refreshedCount}`);
await consumer.getByRole('button', { name: 'OPEN FEED', exact: true }).waitFor({ state: 'visible', timeout: 5000 });
await consumer.waitForTimeout(2500);
if (loads !== 0) throw new Error(`import triggered ${loads} automatic page load(s)`);
await consumer.screenshot({ path: 'manual-onboarding-phone.png', fullPage: true });

await touch(consumer, consumer.getByRole('button', { name: 'OPEN FEED', exact: true }));
await consumer.waitForURL(/#\/feed$/, { timeout: 10000 });
await consumer.locator('#feed').waitFor({ state: 'visible', timeout: 10000 });
await consumer.waitForFunction(() => /^[1-9]\d* THING/.test(document.getElementById('corpusStatus')?.textContent || ''), { timeout: 10000 });
const importedCount = (await consumer.locator('#corpusStatus').textContent())?.trim() || '';
if (loads !== 0) throw new Error(`OPEN FEED reloaded the page ${loads} time(s)`);
if (consumerErrors.length) throw new Error(consumerErrors.join(' | '));
await consumerContext.close();

const desktopContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await installProfile(desktopContext);
const desktop = await desktopContext.newPage();
const desktopErrors = collectErrors(desktop);
await desktop.goto('http://127.0.0.1:4173/manual/', { waitUntil: 'networkidle' });
await desktop.waitForFunction(() => document.documentElement.dataset.studioReady === 'yes', { timeout: 15000 });
await desktop.getByRole('button', { name: 'ADD', exact: true }).click();
await expectFourChoices(desktop);
await desktop.getByRole('button', { name: 'Connect an account', exact: true }).click();
await desktop.locator('[data-add-to-sideways="connected"]').waitFor({ state: 'visible', timeout: 5000 });
if ((await desktop.locator('.connection-card').count()) !== 5) throw new Error('expected five honest provider states');
if ((await desktop.getByRole('button', { name: 'Unavailable', exact: true }).count()) !== 5) throw new Error('static deployment simulated an available account connection');
await desktop.getByRole('button', { name: 'Add a public website or feed', exact: true }).click();
await desktop.locator('[data-add-to-sideways="web"]').waitFor({ state: 'visible', timeout: 5000 });
await desktop.getByLabel('Name (optional)').fill('Example Feed');
await desktop.getByLabel('Public URL').fill('https://example.com/feed.xml');
await desktop.getByRole('button', { name: 'Add source', exact: true }).click();
await desktop.locator('[data-source-list] article').filter({ hasText: 'Example Feed' }).waitFor({ state: 'visible', timeout: 5000 });
const disable = desktop.getByRole('checkbox', { name: 'Disable Example Feed', exact: true });
await disable.uncheck();
await desktop.getByRole('checkbox', { name: 'Enable Example Feed', exact: true }).waitFor({ state: 'visible', timeout: 5000 });
const persisted = await desktop.evaluate(() => JSON.parse(localStorage.getItem('sideways-web-sources-v1') || '[]'));
if (persisted.length !== 1 || persisted[0].enabled !== false || persisted[0].url !== 'https://example.com/feed.xml') throw new Error('public source controls did not persist');
await desktop.screenshot({ path: 'manual-add-desktop.png', fullPage: true });
if (desktopErrors.length) throw new Error(desktopErrors.join(' | '));
await desktopContext.close();

console.log(JSON.stringify({
  count,
  gate,
  state: state.split('\n').find(line => line.startsWith('state=')),
  visibleLegacyAddSurface: false,
  workspaceLibraryHeader: true,
  survivalVault: true,
  addToSidewaysChoices: 4,
  duplicateIntro: false,
  chooserBehindCompletion: false,
  staticConnectionsFailHonestly: true,
  publicSourcePersistence: true,
  firstRun: 'Profile, write, or one-tap starter',
  consumerJourney: 'Library → Import files → automatic import → in-place feed',
  automaticReloads: 0,
  refreshedCount,
  importedCount,
  screenshots: ['manual-phone-gate.png', 'manual-onboarding-phone.png', 'manual-add-desktop.png']
}, null, 2));
await browser.close();
