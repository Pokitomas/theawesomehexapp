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

const gateContext = await browser.newContext(iphone);
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
for (const label of ['ADD', 'KEEP', 'READ', 'SEND', 'MOVE GATE']) {
  if (!(await gatePage.getByRole('button', { name: label, exact: true }).count())) throw new Error(`missing button ${label}`);
}
await gatePage.evaluate(() => window.SidewaysCore?.routeTo?.('#/add'));
await gatePage.locator('#addView').waitFor({ state: 'visible', timeout: 5000 });
const coreFilesContract = await gatePage.locator('#addView').evaluate(node => node.textContent.includes('FILES +'));
if (!coreFilesContract) throw new Error('underlying FILES + compatibility contract disappeared');
await gatePage.locator('#importWorkbenchHost').waitFor({ state: 'visible', timeout: 10000 });
const visibleLegacyChildren = await gatePage.locator('#addView.studio-add-modern').evaluate(node => [...node.children].filter(child => !child.matches('[data-studio-intro], #importWorkbenchHost') && getComputedStyle(child).display !== 'none').length);
if (visibleLegacyChildren !== 0) throw new Error(`legacy ADD surface still visible: ${visibleLegacyChildren} child node(s)`);
if (gateErrors.length) throw new Error(gateErrors.join(' | '));
await gatePage.screenshot({ path: 'manual-phone-gate.png', fullPage: true });
await gateContext.close();

const consumerContext = await browser.newContext(iphone);
const consumer = await consumerContext.newPage();
const consumerErrors = collectErrors(consumer);
let loads = 0;
consumer.on('load', () => { loads += 1; });
await consumer.goto('http://127.0.0.1:4173/manual/', { waitUntil: 'networkidle' });
loads = 0;

await consumer.locator('#addView').waitFor({ state: 'visible', timeout: 10000 });
await consumer.locator('#importWorkbenchHost').waitFor({ state: 'visible', timeout: 10000 });
await consumer.locator('#sidewaysImportFiles[data-phone-ready="yes"]').waitFor({ state: 'attached', timeout: 10000 });
if ((await consumer.locator('.source-card').count()) !== 8) throw new Error('expected exactly eight app cards');
for (const id of ['instagram', 'reddit', 'tiktok', 'youtube', 'spotify', 'x', 'browser', 'anything']) {
  if ((await consumer.locator(`.source-card[data-platform="${id}"]`).count()) !== 1) throw new Error(`missing app card: ${id}`);
}
for (const forbidden of ['SAVE AND CHOOSE AN APP', 'I HAVE THE FILES', 'ADD TO MY FEED', 'PICK MORE FILES', 'PICK FOLDER']) {
  if (await consumer.getByText(forbidden, { exact: true }).count()) throw new Error(`old setup UI still visible: ${forbidden}`);
}
if (await consumer.locator('[data-studio-profile-setup]').count()) throw new Error('profile gate still exists');

const redditImport = consumer.locator('.source-card[data-platform="reddit"] [role="button"]').filter({ hasText: 'IMPORT REDDIT' });
const chooserPromise = consumer.waitForEvent('filechooser', { timeout: 10000 });
await touch(consumer, redditImport);
const chooser = await chooserPromise;
await chooser.setFiles({
  name: 'comments.csv',
  mimeType: 'text/csv',
  buffer: Buffer.from('body,subreddit,permalink,created_utc,author,id\n"hello from reddit",sideways,/r/sideways/comments/1,1700000000,kai,abc123\n')
});

await consumer.locator('.import-complete-panel h2').filter({ hasText: 'REDDIT' }).waitFor({ state: 'visible', timeout: 15000 });
await consumer.getByRole('button', { name: 'OPEN MY FEED', exact: true }).waitFor({ state: 'visible', timeout: 5000 });
await consumer.waitForTimeout(2500);
if (loads !== 0) throw new Error(`import triggered ${loads} automatic page load(s)`);
await consumer.screenshot({ path: 'manual-onboarding-phone.png', fullPage: true });

const expectedLoad = consumer.waitForEvent('load', { timeout: 15000 });
await touch(consumer, consumer.getByRole('button', { name: 'OPEN MY FEED', exact: true }));
await expectedLoad;
await consumer.waitForFunction(() => document.documentElement.dataset.studioReady === 'yes', { timeout: 15000 });
await consumer.locator('#feed').waitFor({ state: 'visible', timeout: 10000 });
const importedCount = (await consumer.locator('#corpusStatus').textContent())?.trim() || '';
if (!/^[1-9]\d* THING/.test(importedCount)) throw new Error(`imported feed did not load: ${importedCount}`);
if (consumerErrors.length) throw new Error(consumerErrors.join(' | '));
await consumerContext.close();

console.log(JSON.stringify({
  count,
  gate,
  state: state.split('\n').find(line => line.startsWith('state=')),
  visibleLegacyAddSurface: false,
  firstRun: 'app cards immediately visible',
  consumerJourney: 'IMPORT REDDIT → native picker → automatic import → feed',
  automaticReloads: 0,
  importedCount,
  screenshots: ['manual-phone-gate.png', 'manual-onboarding-phone.png']
}, null, 2));
await browser.close();
