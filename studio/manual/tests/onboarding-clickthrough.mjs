// Proves the consumer import path on a real iPhone viewport:
// launchpad → IMPORT → Reddit picker → completion, with no reload or late DOM churn.

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

async function waitForImportOutcome() {
  await page.waitForFunction(() => document.querySelector('.import-complete-panel, .import-error-panel'), { timeout: 15000 });
  const error = page.locator('.import-error-panel');
  if (await error.count()) throw new Error(`import error: ${(await error.innerText()).trim()}`);
  const panel = page.locator('.import-complete-panel');
  await panel.waitFor({ state: 'visible', timeout: 5000 });
  await panel.locator('.import-workbench-kicker').filter({ hasText: 'REDDIT' }).waitFor({ state: 'visible', timeout: 5000 });
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
await page.waitForFunction(() => document.documentElement.dataset.studioReady === 'yes', { timeout: 15000 });
await touch(page.locator('.studio-launch-button.is-import'));
await page.locator('#addView').waitFor({ state: 'visible', timeout: 10000 });
await page.locator('#importWorkbenchHost').waitFor({ state: 'visible', timeout: 10000 });
if (await page.locator('[data-studio-profile-setup]').count()) throw new Error('profile gate still exists');
if (await page.locator('[data-studio-intro]').count()) throw new Error('duplicate intro card still exists');
if ((await page.locator('.source-card').count()) !== 8) throw new Error('app chooser is incomplete');

const picker = page.locator('.source-card[data-platform="reddit"] [role="button"]').filter({ hasText: 'IMPORT REDDIT' });
const chooserPromise = page.waitForEvent('filechooser', { timeout: 10000 });
await touch(picker);
const chooser = await chooserPromise;
await chooser.setFiles({
  name: 'comments.csv',
  mimeType: 'text/csv',
  buffer: Buffer.from('body,subreddit,permalink,created_utc,author,id\n"touch path works",sideways,/r/sideways/comments/touch,1700000000,touch-test,touch-1\n')
});

await waitForImportOutcome();
if (await page.locator('.source-card').count()) throw new Error('app chooser remains visible behind completion');
const firesBeforeQuietWindow = await page.evaluate(() => window.__sidewaysObserverFires);
await page.waitForTimeout(2600);
const firesAfterQuietWindow = await page.evaluate(() => window.__sidewaysObserverFires);
const lateObserverFires = firesAfterQuietWindow - firesBeforeQuietWindow;
if (lateObserverFires !== 0) throw new Error(`DOM work did not quiesce: ${lateObserverFires} observer callback(s) after the retry ceiling`);
if (unexpectedLoads !== 0) throw new Error(`consumer journey caused ${unexpectedLoads} unexpected page load(s)`);
if (errors.length) throw new Error(errors.join(' | '));

await page.screenshot({ path: 'manual-onboarding-touch.png', fullPage: true });
console.log(JSON.stringify({
  touchJourney: 'IMPORT launchpad → Reddit picker → completion',
  profileGate: false,
  duplicateIntro: false,
  chooserBehindCompletion: false,
  lateObserverFires,
  unexpectedLoads,
  screenshot: 'manual-onboarding-touch.png'
}, null, 2));

await context.close();
await browser.close();
