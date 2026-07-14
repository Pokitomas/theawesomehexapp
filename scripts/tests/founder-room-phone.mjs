import fs from 'node:fs';
import { chromium } from 'playwright-core';

const executablePath = [
  process.env.CHROME_BIN,
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
  hasTouch: true
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

await page.goto('http://127.0.0.1:4174/founder/', { waitUntil: 'networkidle' });
await page.getByRole('heading', { name: 'Which future has gravity?' }).waitFor({ state: 'visible' });
if ((await page.locator('[data-direction]').count()) !== 3) throw new Error('expected exactly three founder directions');

await page.locator('[data-direction="memory-social"] [data-reaction="pull"]').click();
await page.locator('[data-direction="private-remix"] [data-reaction="steal"]').click();
await page.locator('[data-direction="scene-social"] [data-reaction="push"]').click();
await page.locator('#founder-note').fill('Memory is the social advantage; steal remix tools; keep scenes alive.');

const beforeReload = await page.locator('#summary').innerText();
if (!beforeReload.includes('social identity with memory: pull')) throw new Error(`missing memory reaction: ${beforeReload}`);
if (!beforeReload.includes('private remixable life feed: steal')) throw new Error(`missing remix reaction: ${beforeReload}`);
if (!beforeReload.includes('scene-first social world: push')) throw new Error(`missing scene reaction: ${beforeReload}`);

await page.reload({ waitUntil: 'networkidle' });
const note = await page.locator('#founder-note').inputValue();
if (note !== 'Memory is the social advantage; steal remix tools; keep scenes alive.') throw new Error(`founder note did not persist: ${note}`);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
if (overflow > 1) throw new Error(`founder room overflows phone viewport by ${overflow}px`);
if (errors.length) throw new Error(errors.join(' | '));

await page.screenshot({ path: 'founder-room-phone.png', fullPage: true });
console.log(JSON.stringify({
  directions: 3,
  persisted: true,
  overflow,
  screenshot: 'founder-room-phone.png'
}, null, 2));
await browser.close();
