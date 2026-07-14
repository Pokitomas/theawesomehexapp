import fs from 'node:fs';
import { chromium } from 'playwright-core';

const url = process.argv[2];
if (!url) throw new Error('usage: node social-spine-clickthrough.mjs <manual-url>');
const executablePath = [process.env.CHROME_BIN, process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean).find(fs.existsSync);
if (!executablePath) throw new Error('no Chromium found');

const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];
const contexts = [];

async function makePage(localProfile) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1'
  });
  contexts.push(context);
  await context.addInitScript(profile => localStorage.setItem('sideways-workspace-profile-v1', JSON.stringify(profile)), localProfile);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/social\.js|social\.css|workspace-sync\.js/.test(text)) return;
    errors.push(text);
  });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.SidewaysNetwork && document.documentElement.dataset.sidewaysNetwork, { timeout: 20000 });
  return page;
}

async function touch(page, locator) {
  await locator.waitFor({ state: 'visible', timeout: 15000 });
  await locator.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
  await page.waitForTimeout(50);
  const box = await locator.boundingBox();
  if (!box) throw new Error('touch target has no box');
  const clear = await locator.evaluate(node => {
    const rect = node.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hit === node || node.contains(hit);
  });
  if (!clear) throw new Error(`touch target is physically obstructed: ${await locator.getAttribute('aria-label') || await locator.textContent()}`);
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

async function signup(page, { email, password, handle, displayName, bio }) {
  await touch(page, page.locator('[data-sideways-account-launch]'));
  const dialog = page.locator('[data-network-account-dialog]');
  await dialog.waitFor({ state: 'visible', timeout: 10000 });
  await dialog.getByLabel('Email').fill(email);
  await dialog.getByLabel('Password').fill(password);
  await dialog.getByLabel('Handle').fill(handle);
  await dialog.getByLabel('Display name').fill(displayName);
  await dialog.getByLabel('Bio').fill(bio);
  await touch(page, dialog.getByRole('button', { name: 'Create account', exact: true }));
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForFunction(expected => window.SidewaysNetwork.profile.identity()?.handle === expected, handle, { timeout: 10000 });
}

async function login(page, { email, password, handle }) {
  await touch(page, page.locator('[data-sideways-account-launch]'));
  const dialog = page.locator('[data-network-account-dialog]');
  await dialog.getByRole('button', { name: 'I already have an account', exact: true }).click();
  await dialog.getByLabel('Email').fill(email);
  await dialog.getByLabel('Password').fill(password);
  await touch(page, dialog.getByRole('button', { name: 'Log in', exact: true }));
  await dialog.waitFor({ state: 'detached', timeout: 15000 });
  await page.waitForFunction(expected => window.SidewaysNetwork.profile.identity()?.handle === expected, handle, { timeout: 10000 });
}

async function follow(page, handle) {
  await touch(page, page.locator('[data-sideways-account-launch]'));
  const dialog = page.locator('[data-network-account-dialog]');
  await dialog.getByLabel('Find a handle to follow').fill(handle);
  await touch(page, dialog.getByRole('button', { name: 'Follow', exact: true }));
  await dialog.getByText(`Following @${handle}.`, { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
}

async function publicPost(page, text) {
  await touch(page, page.locator('[data-workspace-new]'));
  const composer = page.locator('[data-workspace-composer]');
  await composer.waitFor({ state: 'visible', timeout: 10000 });
  const publicToggle = composer.getByLabel('Publish publicly');
  if (!await publicToggle.isChecked()) await publicToggle.check();
  await composer.getByLabel('Post text').fill(text);
  await touch(page, composer.getByRole('button', { name: 'Publish', exact: true }));
  await composer.waitFor({ state: 'hidden', timeout: 15000 });
  await page.getByText(text, { exact: true }).first().waitFor({ state: 'visible', timeout: 15000 });
}

async function sync(page) {
  const result = await page.evaluate(() => window.SidewaysNetwork.sync.following());
  await page.waitForTimeout(200);
  return result;
}

const alice = { email: 'alice@example.test', password: 'correct horse battery', handle: 'alice', displayName: 'Alice', bio: 'public Alice' };
const bob = { email: 'bob@example.test', password: 'another correct horse', handle: 'bob', displayName: 'Bob', bio: 'public Bob' };
const privateText = 'PRIVATE LOCAL NOTE MUST NEVER CROSS DEVICES';
const publicText = 'PUBLIC NETWORK POST FROM ALICE';
const replyText = '@alice PUBLIC REPLY FROM BOB';

try {
  const pageA = await makePage({ name: 'Alice local', handle: 'alice-local', bio: 'private device profile', accent: '#335cff' });
  await signup(pageA, alice);
  await pageA.evaluate(text => window.SidewaysWorkspace.publishEntry({ text }), privateText);
  await pageA.waitForFunction(text => document.body.innerText.includes(text), privateText, { timeout: 10000 });
  await publicPost(pageA, publicText);
  const alicePublic = await pageA.evaluate(() => window.SidewaysNetwork.feeds.userPosts(window.SidewaysNetwork.profile.identity().id));
  if (alicePublic.items.length !== 1 || alicePublic.items[0].body !== publicText) throw new Error(`Alice public post missing: ${JSON.stringify(alicePublic)}`);
  const rootPostId = alicePublic.items[0].id;
  await pageA.screenshot({ path: 'social-spine-alice-published.png', fullPage: false });

  const pageB = await makePage({ name: 'Bob local', handle: 'bob-local', bio: 'different private device', accent: '#2f7d64' });
  await signup(pageB, bob);
  await follow(pageB, 'alice');
  await sync(pageB);
  await pageB.getByText(publicText, { exact: true }).first().waitFor({ state: 'visible', timeout: 15000 });
  if (await pageB.getByText(privateText, { exact: true }).count()) throw new Error('Alice private local record leaked into Bob feed');

  const rootCard = pageB.locator('#feed .post').filter({ hasText: publicText }).first();
  await rootCard.waitFor({ state: 'visible', timeout: 10000 });
  await touch(pageB, rootCard.getByRole('button', { name: 'Reply', exact: true }));
  const replyComposer = pageB.locator('[data-workspace-composer]');
  await replyComposer.waitFor({ state: 'visible', timeout: 10000 });
  await replyComposer.getByLabel('Post text').fill(replyText);
  await touch(pageB, replyComposer.getByRole('button', { name: 'Publish', exact: true }));
  await replyComposer.waitFor({ state: 'hidden', timeout: 15000 });
  await sync(pageB);
  const refreshedRoot = pageB.locator('#feed .post').filter({ hasText: publicText }).first();
  await touch(pageB, refreshedRoot.getByRole('button', { name: 'Like', exact: true }));
  await refreshedRoot.getByRole('button', { name: 'Liked', exact: true }).waitFor({ state: 'visible', timeout: 10000 });

  const thread = await pageA.evaluate(id => window.SidewaysNetwork.posts.thread(id), rootPostId);
  if (thread.replies.length !== 1 || thread.replies[0].body !== replyText) throw new Error(`reply thread failed: ${JSON.stringify(thread)}`);
  const root = await pageA.evaluate(id => window.SidewaysNetwork.posts.get(id), rootPostId);
  if (root.post.engagement.likes !== 1) throw new Error(`like did not reach authority: ${JSON.stringify(root)}`);
  await pageB.screenshot({ path: 'social-spine-bob-interaction.png', fullPage: false });

  await pageA.evaluate(() => window.SidewaysNetwork.session.logout());
  await contexts[0].close();
  const pageA2 = await makePage({ name: 'Fresh local browser', handle: 'fresh-local', bio: '', accent: '#6554c0' });
  await login(pageA2, alice);
  const restored = await pageA2.evaluate(async () => ({ me: await window.SidewaysNetwork.session.refresh(), posts: await window.SidewaysNetwork.feeds.userPosts(window.SidewaysNetwork.profile.identity().id), local: await window.SidewaysWorkspace.listRecords() }));
  if (restored.me.user.handle !== 'alice' || restored.posts.items[0]?.body !== publicText) throw new Error(`public state did not return on fresh browser: ${JSON.stringify(restored)}`);
  if (restored.local.some(record => record.text === privateText)) throw new Error('private local record magically transferred to fresh browser');
  await pageA2.screenshot({ path: 'social-spine-fresh-login.png', fullPage: false });

  const events = await (await fetch(new URL('/__test/events', url))).json();
  for (const type of ['account.created', 'follow.created', 'post.created', 'reaction.created']) if (!events.events.some(event => event.type === type)) throw new Error(`missing event ${type}`);
  if (events.events.filter(event => event.type === 'post.created').length !== 2) throw new Error('expected public post and first-class reply events');

  for (const page of [pageB, pageA2]) {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 1) throw new Error(`phone horizontal overflow ${overflow}`);
  }
  if (errors.length) throw new Error(errors.join(' | '));
  console.log(JSON.stringify({ accounts: 2, follows: 1, publicPosts: 2, replies: 1, likes: 1, freshLogin: true, privateLeak: false, eventTypes: [...new Set(events.events.map(event => event.type))] }));
} finally {
  for (const context of contexts) await context.close().catch(() => {});
  await browser.close();
}
