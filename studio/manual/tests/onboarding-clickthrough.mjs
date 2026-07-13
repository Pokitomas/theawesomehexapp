// Adapted from the parallel #42 collaboration test for the actual Sideways UI.
// Proves real iPhone touch taps land and the app becomes quiet after bounded setup work.

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

const profile = page.locator('[data-studio-profile-setup]');
await profile.waitFor({ state: 'visible', timeout: 10000 });
await profile.locator('input[name="name"]').fill('Touch Test');
await profile.locator('input[name="handle"]').fill('@touch-test');
await profile.getByRole('button', { name: 'SAVE AND CHOOSE AN APP', exact: true }).tap({ timeout: 3000 });

await page.locator('#addView').waitFor({ state: 'visible', timeout: 10000 });
await page.locator('#importWorkbenchHost').waitFor({ state: 'visible', timeout: 10000 });
const reddit = page.locator('.source-card[data-platform="reddit"]');
await reddit.waitFor({ state: 'visible', timeout: 5000 });

const [chooser] = await Promise.all([
  page.waitForEvent('filechooser'),
  reddit.getByRole('button', { name: 'I HAVE THE FILES', exact: true }).tap({ timeout: 3000 })
]);
await chooser.setFiles({
  name: 'comments.csv',
  mimeType: 'text/csv',
  buffer: Buffer.from('body,subreddit,permalink,created_utc,author,id\n"touch path works",sideways,/r/sideways/comments/touch,1700000000,touch-test,touch-1\n')
});

await page.getByText('1 FILE READY', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
await page.getByRole('button', { name: 'ADD TO MY FEED', exact: true }).tap({ timeout: 3000 });
await page.getByRole('heading', { name: 'YOUR FEED HAS NEW MATERIAL', exact: true }).waitFor({ state: 'visible', timeout: 15000 });

const firesBeforeQuietWindow = await page.evaluate(() => window.__sidewaysObserverFires);
await page.waitForTimeout(2600);
const firesAfterQuietWindow = await page.evaluate(() => window.__sidewaysObserverFires);
const lateObserverFires = firesAfterQuietWindow - firesBeforeQuietWindow;
if (lateObserverFires !== 0) throw new Error(`DOM work did not quiesce: ${lateObserverFires} observer callback(s) after the retry ceiling`);
if (unexpectedLoads !== 0) throw new Error(`touch journey caused ${unexpectedLoads} unexpected page load(s)`);
if (errors.length) throw new Error(errors.join(' | '));

await page.screenshot({ path: 'manual-onboarding-touch.png', fullPage: true });
console.log(JSON.stringify({
  touchJourney: 'profile → Reddit picker → import complete',
  lateObserverFires,
  unexpectedLoads,
  screenshot: 'manual-onboarding-touch.png'
}, null, 2));

await context.close();
await browser.close();
