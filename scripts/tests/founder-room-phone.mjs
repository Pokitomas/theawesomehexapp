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

const proof = {
  executablePath,
  directions: 0,
  persisted: false,
  overflow: null,
  errors: []
};
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
const browserErrors = [];
page.on('pageerror', error => browserErrors.push(error.message));
page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()); });

try {
  await page.goto('http://127.0.0.1:4174/founder/', { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Which future has gravity?' }).waitFor({ state: 'visible' });
  proof.directions = await page.locator('[data-direction]').count();
  if (proof.directions !== 3) throw new Error(`expected exactly three founder directions, got ${proof.directions}`);

  await page.locator('[data-direction="memory-social"] [data-reaction="pull"]').click();
  await page.locator('[data-direction="private-remix"] [data-reaction="steal"]').click();
  await page.locator('[data-direction="scene-social"] [data-reaction="push"]').click();
  await page.locator('#founder-note').fill('Memory is the social advantage; steal remix tools; keep scenes alive.');

  const beforeReload = await page.locator('#summary').innerText();
  proof.summary = beforeReload;
  if (!beforeReload.includes('social identity with memory: pull')) throw new Error(`missing memory reaction: ${beforeReload}`);
  if (!beforeReload.includes('private remixable life feed: steal')) throw new Error(`missing remix reaction: ${beforeReload}`);
  if (!beforeReload.includes('scene-first social world: push')) throw new Error(`missing scene reaction: ${beforeReload}`);

  await page.reload({ waitUntil: 'networkidle' });
  const note = await page.locator('#founder-note').inputValue();
  proof.note = note;
  proof.persisted = note === 'Memory is the social advantage; steal remix tools; keep scenes alive.';
  if (!proof.persisted) throw new Error(`founder note did not persist: ${note}`);
  proof.overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (proof.overflow > 1) throw new Error(`founder room overflows phone viewport by ${proof.overflow}px`);
  if (browserErrors.length) throw new Error(browserErrors.join(' | '));
} catch (error) {
  proof.errors.push(error instanceof Error ? error.message : String(error));
  proof.errors.push(...browserErrors);
  throw error;
} finally {
  try { await page.screenshot({ path: 'founder-room-phone.png', fullPage: true }); }
  catch (error) { proof.errors.push(`screenshot: ${error instanceof Error ? error.message : String(error)}`); }
  fs.writeFileSync('founder-room-proof.json', JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof, null, 2));
  await browser.close();
}
