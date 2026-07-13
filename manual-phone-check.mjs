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

async function collectErrors(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  return errors;
}

const gateContext = await browser.newContext(iphone);
const page = await gateContext.newPage();
const gateErrors = await collectErrors(page);
await page.goto('http://127.0.0.1:4173/manual/?debug=1&test=1&autorun=1', { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.documentElement.dataset.gateMoved === 'yes', { timeout: 20000 });
const count = (await page.locator('#corpusStatus').textContent())?.trim();
const policy = (await page.locator('#debugPolicy').textContent()) || '';
const state = (await page.locator('#debugState').textContent()) || '';
const gate = Number((policy.match(/gate=([0-9.]+)/) || [])[1]);
if (count !== '20 THINGS') throw new Error(`expected 20 THINGS, got ${count}`);
if (!(gate > .05)) throw new Error(`gate did not visibly move: ${policy}`);
if (!/state=(saturation|deep_saturation)/.test(state)) throw new Error(`state did not change: ${state}`);
for (const label of ['ADD', 'KEEP', 'READ', 'SEND', 'MOVE GATE']) {
  if (!(await page.getByRole('button', { name: label, exact: true }).count())) throw new Error(`missing button ${label}`);
}
await page.evaluate(() => {
  if (window.SidewaysCore?.routeTo) window.SidewaysCore.routeTo('#/add');
  else location.hash = '#/add';
});
await page.locator('#addView').waitFor({ state: 'visible', timeout: 5000 });
await page.getByRole('button', { name: /^FILES \+/ }).waitFor({ state: 'visible', timeout: 10000 });
if (await page.getByRole('button', { name: /^FOLDER\b/ }).count()) throw new Error('unsupported iPhone folder picker still shown');
await page.locator('#importWorkbenchHost').waitFor({ state: 'visible', timeout: 10000 });
await page.getByRole('button', { name: /^PICK MORE FILES\b/ }).waitFor({ state: 'visible', timeout: 10000 });
if (await page.getByRole('button', { name: /^PICK FOLDER\b/ }).count()) throw new Error('import workbench exposed unsupported iPhone folder picker');
await page.screenshot({ path: 'manual-phone-gate.png', fullPage: true });
if (gateErrors.length) throw new Error(gateErrors.join(' | '));
await gateContext.close();

const onboardingContext = await browser.newContext(iphone);
const onboarding = await onboardingContext.newPage();
const onboardingErrors = await collectErrors(onboarding);
let unexpectedLoads = 0;
onboarding.on('load', () => { unexpectedLoads += 1; });
await onboarding.goto('http://127.0.0.1:4173/manual/', { waitUntil: 'networkidle' });
unexpectedLoads = 0;
await onboarding.locator('[data-studio-profile-setup]').waitFor({ state: 'visible', timeout: 10000 });
await onboarding.locator('input[name="name"]').fill('Kai');
await onboarding.locator('input[name="handle"]').fill('@sideways-test');
await onboarding.getByRole('button', { name: 'SAVE AND CHOOSE AN APP', exact: true }).tap();
await onboarding.locator('#addView').waitFor({ state: 'visible', timeout: 10000 });
await onboarding.locator('#importWorkbenchHost').waitFor({ state: 'visible', timeout: 10000 });
if (await onboarding.getByText('PUT IN A REAL EXPORT.', { exact: true }).count()) throw new Error('old developer copy still visible');
if ((await onboarding.locator('.source-card').count()) < 8) throw new Error('platform chooser did not render all source cards');
for (const source of ['Reddit', 'Instagram', 'TikTok', 'YouTube', 'Spotify', 'X / Twitter', 'Bookmarks', 'Anything else']) {
  await onboarding.getByRole('heading', { name: source, exact: true }).waitFor({ state: 'visible', timeout: 5000 });
}

const reddit = onboarding.locator('.source-card[data-platform="reddit"]');
const [chooser] = await Promise.all([
  onboarding.waitForEvent('filechooser'),
  reddit.getByRole('button', { name: 'I HAVE THE FILES', exact: true }).tap()
]);
await chooser.setFiles({
  name: 'comments.csv',
  mimeType: 'text/csv',
  buffer: Buffer.from('body,subreddit,permalink,created_utc,author,id\n"hello from reddit",sideways,/r/sideways/comments/1,1700000000,kai,abc123\n')
});
await onboarding.getByText('1 FILE READY', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
await onboarding.getByRole('button', { name: 'ADD TO MY FEED', exact: true }).tap();
await onboarding.getByRole('heading', { name: 'YOUR FEED HAS NEW MATERIAL', exact: true }).waitFor({ state: 'visible', timeout: 15000 });
await onboarding.getByRole('button', { name: 'OPEN MY FEED', exact: true }).waitFor({ state: 'visible', timeout: 5000 });
await onboarding.waitForTimeout(2500);
if (unexpectedLoads !== 0) throw new Error(`onboarding unexpectedly reloaded ${unexpectedLoads} times`);
const savedProfile = await onboarding.evaluate(() => JSON.parse(localStorage.getItem('sideways-local-profile-v1') || '{}'));
if (savedProfile.name !== 'Kai' || savedProfile.handle !== 'sideways-test') throw new Error(`local profile was not saved: ${JSON.stringify(savedProfile)}`);
await onboarding.screenshot({ path: 'manual-onboarding-phone.png', fullPage: true });
if (onboardingErrors.length) throw new Error(onboardingErrors.join(' | '));
await onboardingContext.close();

console.log(JSON.stringify({
  count,
  gate,
  state: state.split('\n').find(line => line.startsWith('state=')),
  iphonePicker: 'FILES +',
  importerPicker: 'PICK MORE FILES',
  onboarding: 'profile → Reddit file → import complete',
  automaticReloads: unexpectedLoads,
  screenshots: ['manual-phone-gate.png', 'manual-onboarding-phone.png']
}, null, 2));
await browser.close();
