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

const founderUrl = process.env.FOUNDER_TEST_URL || 'http://127.0.0.1:4174/founder/';
const proof = {
  executablePath,
  founderUrl,
  branches: 0,
  persisted: false,
  pushed: false,
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

const intention = 'make some actual site about something idk completely different but make it alive';

try {
  await page.goto(founderUrl, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Make something true.' }).waitFor({ state: 'visible' });
  await page.locator('#founder-intention').fill(intention);
  await page.getByRole('button', { name: 'Show different directions' }).click();

  proof.branches = await page.locator('[data-branch]').count();
  if (proof.branches !== 6) throw new Error(`expected six open branches, got ${proof.branches}`);

  await page.locator('[data-branch="missing-capability"] button').click();
  const selected = await page.locator('[data-branch="missing-capability"]').getAttribute('aria-pressed');
  if (selected !== 'true') throw new Error('missing-capability branch was not selected');

  await page.getByRole('button', { name: 'Use this direction', exact: true }).click();
  const status = await page.locator('#room-status').innerText();
  proof.status = status;
  proof.pushed = status.includes('No execution authority has been granted');
  if (!proof.pushed) throw new Error(`Founder did not preserve the push boundary: ${status}`);

  const preview = await page.locator('#turn-preview').innerText();
  if (!preview.includes('"push_state": "pushed-objective-only"')) throw new Error('turn receipt missing pushed state');
  if (!preview.includes('"user_workflow_requires_git": false')) throw new Error('turn receipt requires Git');

  const shared = await page.evaluate(() => JSON.parse(localStorage.getItem('archie:shared-task:v2') || '{}'));
  if (!shared.text || shared.route !== 'maker') throw new Error('selected Founder direction was not handed to the shared build task');

  await page.reload({ waitUntil: 'networkidle' });
  const restoredIntention = await page.locator('#founder-intention').inputValue();
  const restoredSelected = await page.locator('[data-branch="missing-capability"]').getAttribute('aria-pressed');
  proof.persisted = restoredIntention === intention && restoredSelected === 'true';
  if (!proof.persisted) throw new Error('Founder turn did not survive reload');

  proof.overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (proof.overflow > 1) throw new Error(`Founder overflows phone viewport by ${proof.overflow}px`);
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
