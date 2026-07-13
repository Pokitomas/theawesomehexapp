// Proves the consumer first run on a real iPhone viewport:
// cards appear immediately, a raw touch opens Reddit import, the import starts
// automatically, and the interface becomes quiet without reloading itself.

import fs from 'node:fs';
import { chromium } from 'playwright-core';

const url = process.argv[2];
if (!url) throw new Error('usage: node onboarding-clickthrough.mjs <manual-url>');

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
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1'
});
const page = await context.newPage();

async function touch(locator) {
  await locator.waitFor({ state: 'visible', timeout: 10000 });
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('touch target has no bounding box');
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

await page.addInitScript(() => {
  window.__sidewaysObserverFires = 0;
  const NativeObserver = window.MutationObserver;
  window.MutationObserver = class extends NativeObserver {
    constructor(callback) {
      super((...args) => {
        window.__sidewaysObserverFires += 1;
        return callback(...args);
      });
    }
  };
});

const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
let unexpectedLoads = 0;
page.on('load', () => { unexpectedLoads += 1; });

await page.goto(url, { waitUntil: 'networkidle' });
unexpectedLoads = 0;
await page.locator('#addView').waitFor({ state: 'visible', timeout: 10000 });
await page.locator('#importWorkbenchHost').waitFor({ state: 'visible', timeout: 10000 });
if (await page.locator('[data-studio-profile-setup]').count()) throw new Error('profile gate still exists');

const picker = page.locator('.source-card[data-platform="reddit"] [role="button"]').filter({ hasText: 'IMPORT REDDIT' });
const chooserPromise = page.waitForEvent('filechooser', { timeout: 10000 });
await touch(picker);
const chooser = await chooserPromise;
await chooser.setFiles({
  name: 'comments.csv',
  mimeType: 'text/csv',
  buffer: Buffer.from('body,subreddit,permalink,created_utc,author,id\n"touch path works",sideways,/r/sideways/comments/touch,1700000000,touch-test,touch-1\n')
});

await page.locator('.import-complete-panel h2').filter({ hasText: 'REDDIT' }).waitFor({ state: 'visible', timeout: 15000 });
const firesBeforeQuietWindow = await page.evaluate(() => window.__sidewaysObserverFires);
await page.waitForTimeout(2600);
const firesAfterQuietWindow = await page.evaluate(() => window.__sidewaysObserverFires);
const lateObserverFires = firesAfterQuietWindow - firesBeforeQuietWindow;
if (lateObserverFires !== 0) throw new Error(`DOM work did not quiesce: ${lateObserverFires} observer callback(s) after the retry ceiling`);
if (unexpectedLoads !== 0) throw new Error(`consumer journey caused ${unexpectedLoads} unexpected page load(s)`);
if (errors.length) throw new Error(errors.join(' | '));

await page.screenshot({ path: 'manual-onboarding-touch.png', fullPage: true });
console.log(JSON.stringify({
  touchJourney: 'IMPORT REDDIT → native picker → automatic import complete',
  profileGate: false,
  lateObserverFires,
  unexpectedLoads,
  screenshot: 'manual-onboarding-touch.png'
}, null, 2));

await context.close();
await browser.close();
