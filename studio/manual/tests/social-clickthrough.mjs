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
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

async function touch(locator) {
  await locator.waitFor({ state: 'visible', timeout: 12000 });
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('touch target has no bounding box');
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.documentElement.dataset.studioReady === 'yes', { timeout: 15000 });

for (const phrase of ['YOUR STUFF. ONE FEED.', 'BRING YOUR INTERNET', 'YOUR STUFF, RECOMPOSED', 'YOUR INTERNET, YOUR WAY']) {
  if ((await page.getByText(phrase, { exact: false }).count()) > 0) throw new Error(`editorial copy returned: ${phrase}`);
}

await touch(page.locator('.studio-launch-button.is-post'));
const composer = page.locator('[data-social-composer]');
await composer.waitFor({ state: 'visible', timeout: 10000 });
await touch(composer.locator('.social-composer-author'));

const profile = page.locator('[data-social-profile]');
await profile.waitFor({ state: 'visible', timeout: 10000 });
await profile.locator('input[name="socialName"]').fill('KAI');
await profile.locator('input[name="socialHandle"]').fill('@sideways');
await touch(profile.locator('[data-action-id="profile.avatar"][data-value="🪩"]'));
await touch(profile.locator('[data-action-id="profile.color"][data-value="#9278ff"]'));
await touch(profile.locator('[data-action-id="profile.save"]'));
await profile.waitFor({ state: 'hidden', timeout: 5000 });

await composer.locator('.social-composer-text').fill('HELLO FROM SIDEWAYS');
await touch(composer.locator('[data-action-id="post.mood"][data-value="LOL"]'));
await touch(composer.locator('[data-action-id="post.style"][data-value="CHAOS"]'));

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

const first = page.locator('[data-social-post]').filter({ hasText: 'HELLO FROM SIDEWAYS' });
await first.waitFor({ state: 'visible', timeout: 10000 });
if ((await first.locator('.social-post-image').count()) !== 1) throw new Error('photo post did not render');
if (!(await first.getByText('KAI', { exact: true }).count())) throw new Error('profile name did not reach the post');
if (!(await first.getByText('@sideways', { exact: true }).count())) throw new Error('profile handle did not reach the post');

await touch(first.locator('[data-action-id="post.react"]').filter({ hasText: '😂' }));
await first.getByText('😂 1', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
await touch(first.locator('[data-action-id="post.save"]'));
await first.getByText('SAVED', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });

await touch(first.locator('[data-action-id="post.remix"]'));
await composer.waitFor({ state: 'visible', timeout: 10000 });
await composer.locator('.social-remix-preview').waitFor({ state: 'visible', timeout: 5000 });
await composer.locator('.social-composer-text').fill('SECOND POST');
await touch(composer.locator('[data-action-id="post.publish"]'));
await page.waitForFunction(() => document.querySelectorAll('[data-social-post]').length === 2, { timeout: 10000 });

const contract = await page.evaluate(() => window.SidewaysSocial.actionContract());
if (!Array.isArray(contract) || contract.length < 30) throw new Error(`action contract too small: ${contract?.length}`);
const ids = new Set(contract.map(item => item.id));
for (const id of ['profile.save', 'post.publish', 'post.react', 'post.remix', 'post.save', 'post.share', 'post.delete']) {
  if (!ids.has(id)) throw new Error(`missing action contract: ${id}`);
}

const results = await page.evaluate(() => window.SidewaysSocial.results());
if (!results['post.mood']?.values?.LOL) throw new Error('action results did not learn the selected mood');
if (!results['post.style']?.values?.CHAOS) throw new Error('action results did not learn the selected style');

await page.reload({ waitUntil: 'networkidle' });
await page.waitForFunction(() => document.querySelectorAll('[data-social-post]').length === 2, { timeout: 15000 });
const storedPosts = await page.evaluate(() => window.SidewaysSocial.posts());
if (storedPosts.length !== 2) throw new Error(`expected two persisted posts, got ${storedPosts.length}`);
if ((await page.locator('.social-post-text').filter({ hasText: 'HELLO FROM SIDEWAYS' }).count()) !== 1) throw new Error('first post did not persist');
if ((await page.locator('.social-post-text').filter({ hasText: 'SECOND POST' }).count()) !== 1) throw new Error('remix did not persist');
const savedProfile = await page.evaluate(() => window.SidewaysSocial.profile());
if (savedProfile.name !== 'KAI' || savedProfile.handle !== 'sideways' || savedProfile.avatar !== '🪩') {
  throw new Error(`profile did not persist: ${JSON.stringify(savedProfile)}`);
}

const uncontracted = await page.locator('button:not([data-action-id]), [role="button"]:not([data-action-id])').evaluateAll(nodes => nodes
  .filter(node => !node.closest('#debugPanel') && !node.matches('.type-nav button') && !node.matches('.actions button'))
  .map(node => node.textContent.trim() || node.getAttribute('aria-label') || node.outerHTML.slice(0, 80)));
if (uncontracted.length) throw new Error(`uncontracted product controls: ${uncontracted.join(' | ')}`);
if (errors.length) throw new Error(errors.join(' | '));

await page.screenshot({ path: 'manual-social-phone.png', fullPage: true });
console.log(JSON.stringify({
  profile: savedProfile,
  posts: storedPosts.length,
  photo: true,
  reaction: '😂 1',
  remix: true,
  persisted: true,
  actionContracts: contract.length,
  learnedMood: results['post.mood'].values,
  learnedStyle: results['post.style'].values,
  screenshot: 'manual-social-phone.png'
}, null, 2));

await context.close();
await browser.close();
