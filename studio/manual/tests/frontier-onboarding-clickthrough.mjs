import fs from 'node:fs';
import { chromium } from 'playwright-core';

const url = process.argv[2];
if (!url) throw new Error('usage: node frontier-onboarding-clickthrough.mjs <manual-url>');

const executablePath = [
  process.env.CHROME_BIN,
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean).find(path => fs.existsSync(path));
if (!executablePath) throw new Error('no Chromium found');

const fixture = Array.from({ length: 9 }, (_, index) => ({
  id: `proof-${index + 1}`,
  type: index % 3 === 0 ? 'forum' : 'social',
  source: 'Frontier proof',
  published: new Date(Date.now() - index * 60_000).toISOString(),
  author: {
    name: ['Mara', 'Niko', 'June'][index % 3],
    handle: `@proof${index % 3}`,
    url: '',
    avatar: ''
  },
  title: `Proof post ${index + 1}`,
  text: `This is temporary proof content number ${index + 1}.`,
  summary: `This is temporary proof content number ${index + 1}.`,
  tags: ['frontier-proof']
}));

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
let starterRequests = 0;
let fileChoosers = 0;
page.on('filechooser', () => { fileChoosers += 1; });

async function touch(locator) {
  await locator.waitFor({ state: 'visible', timeout: 15000 });
  await locator.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
  await page.waitForTimeout(60);
  const box = await locator.boundingBox();
  if (!box) throw new Error('touch target has no box');
  const clear = await locator.evaluate(node => {
    const rect = node.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hit === node || node.contains(hit);
  });
  if (!clear) throw new Error('touch target is physically obstructed');
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

await page.route('**/api/profile**', async route => {
  const request = route.request();
  if (request.method() === 'GET') {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ available: true, handle: 'kai' }) });
    return;
  }
  const body = request.postDataJSON();
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ profile: { id: 'proof-profile', name: body.name, handle: body.handle, bio: body.bio, accent: body.accent } })
  });
});

await page.route('**/.well-known/sideways-remote.json', async route => {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      protocol: 'sideways-universal-remote/1',
      session: 'Pokitomas/theawesomehexapp:proof',
      live: true,
      messages: '/api/remote?public=1',
      state: '/api/remote/state?public=1',
      snapshot: './remote-snapshot.json',
      terminal: '#live-work'
    })
  });
});

await page.route('**/api/remote/state**', async route => {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      state: {
        protocol_version: 1,
        session: 'Pokitomas/theawesomehexapp:proof',
        generation: 1,
        decision: 'proceed',
        head_sha: 'proof-head-123456789',
        claims: [{ scope: 'repo:branch:proof', holder: 'principal-proof', expires_at: new Date(Date.now() + 300000).toISOString() }],
        blocker_count: 0,
        terminal: false,
        summary: 'The profile-first social feed is being proven on a phone.',
        updated_at: new Date().toISOString(),
        updated_by: 'principal-proof',
        messages: [{
          id: 'proof-work-1',
          issuer: 'principal-proof',
          issued_at: new Date().toISOString(),
          head_sha: 'proof-head-123456789',
          summary: 'Nine temporary posts are exercising the real feed and will be removed.',
          visibility: 'public'
        }]
      }
    })
  });
});

await page.route('**/api/starter', async route => {
  starterRequests += 1;
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: 99, items: fixture }) });
});

const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.documentElement.dataset.frontier === 'ready', { timeout: 15000 });

const dialog = page.locator('[data-frontier-profile]');
await dialog.waitFor({ state: 'visible', timeout: 10000 });
const closeBox = await dialog.locator('.frontier-close').boundingBox();
if (!closeBox || closeBox.x + closeBox.width > 390 || closeBox.width < 42 || closeBox.height < 42) {
  throw new Error(`profile close is clipped or undersized: ${JSON.stringify(closeBox)}`);
}
await page.screenshot({ path: 'frontier-profile-proof.png', fullPage: false });

await dialog.locator('input[name="name"]').fill('Kai');
await dialog.locator('input[name="handle"]').fill('@kai');
await dialog.locator('textarea[name="bio"]').fill('building a nicer internet');
await dialog.getByRole('button', { name: 'Make my profile' }).click();
await dialog.getByText('Want a running start?').waitFor({ state: 'visible', timeout: 10000 });
await page.screenshot({ path: 'frontier-starter-proof.png', fullPage: false });
await dialog.getByRole('button', { name: 'Make it alive' }).click();
await dialog.waitFor({ state: 'detached', timeout: 15000 });

await page.waitForFunction(expected => document.querySelectorAll('#feed .post').length === expected, fixture.length, { timeout: 15000 });
await page.waitForFunction(() => [...document.querySelectorAll('#feed .post')].every(card => card.querySelector('[data-action-id="post.like"]') && card.querySelector('[data-action-id="post.reply"]') && card.querySelector('[data-action-id="post.remix"]')), { timeout: 10000 });

for (let index = 0; index < fixture.length; index += 1) {
  const card = page.locator('#feed .post').nth(index);
  await card.scrollIntoViewIfNeeded();
  await page.waitForFunction(position => document.querySelectorAll('#feed .post')[position]?.innerText.includes('Proof post') || document.querySelectorAll('#feed .post')[position]?.innerText.includes('temporary proof content'), index, { timeout: 5000 });
}
await page.evaluate(() => scrollTo(0, 0));
await page.waitForTimeout(120);

const first = page.locator('#feed .post').first();
for (const label of ['Like', 'Reply', 'Remix', 'Save', 'Share']) {
  if (!(await first.getByRole('button', { name: label, exact: true }).count())) throw new Error(`missing ${label} action`);
}
await first.getByRole('button', { name: 'Like', exact: true }).click();
await first.getByRole('button', { name: 'Liked', exact: true }).waitFor({ state: 'visible' });
await first.getByRole('button', { name: 'Remix', exact: true }).click();
const composer = page.locator('[data-workspace-composer]');
await composer.waitFor({ state: 'visible', timeout: 10000 });
const remixText = await composer.locator('textarea').inputValue();
if (!/^↳ Proof post \d+/.test(remixText)) throw new Error(`remix did not carry source: ${remixText}`);
await composer.getByRole('button', { name: 'Close' }).click();

await page.screenshot({ path: 'frontier-phone-proof.png', fullPage: false });

const live = page.locator('[data-sideways-remote-launch]');
await touch(live);
const liveDialog = page.locator('[data-sideways-remote-terminal]');
await liveDialog.waitFor({ state: 'visible', timeout: 10000 });
await liveDialog.locator('[data-remote-summary]').getByText('The profile-first social feed is being proven on a phone.', { exact: true }).waitFor({ state: 'visible' });
const machineState = await liveDialog.locator('[data-sideways-remote-state]').textContent();
if (!machineState?.includes('proof-head-123456789')) throw new Error('machine-readable live state is missing the exact head');
await page.screenshot({ path: 'frontier-live-work-proof.png', fullPage: false });
await liveDialog.getByRole('button', { name: 'Close live work' }).click();

const removeProofPosts = () => page.evaluate(async () => {
  const records = (await window.SidewaysWorkspace.listRecords()).filter(record => String(record.nativeId || '').startsWith('starter:proof-'));
  for (const record of records) await window.SidewaysWorkspace.deleteEntry(record.id);
  const remaining = (await window.SidewaysWorkspace.listRecords()).filter(record => String(record.nativeId || '').startsWith('starter:proof-'));
  return { inserted: records.length, remaining: remaining.length };
});

const cleanup = await removeProofPosts();
if (cleanup.inserted !== fixture.length || cleanup.remaining !== 0) throw new Error(`fixture cleanup failed: ${JSON.stringify(cleanup)}`);
await page.waitForFunction(() => document.querySelectorAll('#feed .post').length === 0, { timeout: 15000 });
await page.evaluate(() => localStorage.removeItem('sideways-starter-pack-v1'));
const instantStarter = page.locator('.studio-launch-button.is-import');
await touch(instantStarter);
await page.waitForFunction(expected => document.querySelectorAll('#feed .post').length === expected, fixture.length, { timeout: 15000 });
const instantCleanup = await removeProofPosts();
if (instantCleanup.inserted !== fixture.length || instantCleanup.remaining !== 0) throw new Error(`instant starter cleanup failed: ${JSON.stringify(instantCleanup)}`);
if (starterRequests !== 2) throw new Error(`starter endpoint should be called by both onboarding and the empty-state button, saw ${starterRequests}`);
if (fileChoosers !== 0) throw new Error(`instant starter opened ${fileChoosers} file chooser(s)`);
if (errors.length) throw new Error(errors.join(' | '));

console.log(JSON.stringify({
  profileBackend: 'intercepted and persisted locally',
  starterButton: 'one tap from onboarding and the empty feed',
  starterRequests,
  fileChoosers,
  temporaryPostsInserted: cleanup.inserted,
  temporaryPostsRemaining: cleanup.remaining,
  socialActions: ['Like', 'Reply', 'Remix', 'Save', 'Share'],
  closeTarget: closeBox,
  screenshots: ['frontier-profile-proof.png', 'frontier-starter-proof.png', 'frontier-phone-proof.png', 'frontier-live-work-proof.png']
}, null, 2));

await context.close();
await browser.close();
