import fs from 'node:fs';
import { chromium } from 'playwright-core';

const url = process.argv[2];
if (!url) throw new Error('usage: node social-spine-clickthrough.mjs <manual-url>');
const executablePath = [process.env.CHROME_BIN, process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean).find(path => fs.existsSync(path));
if (!executablePath) throw new Error('no Chromium found');
const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const shellAction = (page, id) => page.locator(`section[data-social-spine] [data-action-id="${id}"]`);

function errors(page) {
  const list = [];
  page.on('pageerror', error => list.push(error.message));
  page.on('console', message => { if (message.type() === 'error') list.push(message.text()); });
  return list;
}

async function contextFor(localName, localHandle) {
  const context = await browser.newContext(phone);
  await context.addInitScript(({ localName, localHandle }) => {
    localStorage.setItem('sideways-workspace-profile-v1', JSON.stringify({ name: localName, handle: localHandle, bio: 'Local-only preference', accent: '#335cff' }));
  }, { localName, localHandle });
  const page = await context.newPage();
  const pageErrors = errors(page);
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.SidewaysSocial?.available() === true, { timeout: 20000 });
  await page.locator('section[data-social-spine]').waitFor({ state: 'visible', timeout: 10000 });
  return { context, page, pageErrors };
}

async function join(page, { name, handle, password }) {
  await shellAction(page, 'social.join').click();
  const dialog = page.locator('[data-social-account="register"]');
  await dialog.waitFor({ state: 'visible' });
  await dialog.locator('input[name="name"]').fill(name);
  await dialog.locator('input[name="handle"]').fill(handle);
  await dialog.locator('input[name="password"]').fill(password);
  await dialog.locator('button.social-primary').filter({ hasText: 'Join' }).click();
  await page.locator('section[data-social-spine]').getByText(`@${handle}`, { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
}

async function publicPost(page, text) {
  await shellAction(page, 'social.post').click();
  const dialog = page.locator('[data-social-composer]');
  await dialog.waitFor({ state: 'visible' });
  await dialog.locator('textarea[name="text"]').fill(text);
  await dialog.locator('button.social-primary').filter({ hasText: 'Publish' }).click();
  await page.getByText(text, { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
}

async function networkRecords(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('sideways-manual-corpus-v1');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('records', 'readonly');
      const all = tx.objectStore('records').getAll();
      all.onerror = () => reject(all.error);
      all.onsuccess = () => resolve(all.result.filter(record => String(record.nativeId || '').startsWith('network:')));
      tx.oncomplete = () => db.close();
    };
  }));
}

const alice = await contextFor('Local Alice', 'local-alice');
const bob = await contextFor('Local Bob', 'local-bob');
await join(alice.page, { name: 'Alice Public', handle: 'alice', password: 'correct horse battery staple' });
await publicPost(alice.page, 'hello from alice public');
await alice.page.screenshot({ path: 'social-alice-post.png', fullPage: false });

await join(bob.page, { name: 'Bob Public', handle: 'bob', password: 'another excellent password' });
await shellAction(bob.page, 'social.discover').click();
const aliceCard = bob.page.locator('#feed .post', { hasText: 'hello from alice public' });
await aliceCard.waitFor({ state: 'visible', timeout: 15000 });
await aliceCard.getByRole('button', { name: 'Follow @alice', exact: true }).click();
await shellAction(bob.page, 'social.feed').click();
await bob.page.locator('#feed .post', { hasText: 'hello from alice public' }).waitFor({ state: 'visible', timeout: 15000 });

const followingCard = bob.page.locator('#feed .post', { hasText: 'hello from alice public' });
await followingCard.getByRole('button', { name: /^Reply/ }).click();
const replyDialog = bob.page.locator('[data-social-composer]');
await replyDialog.waitFor({ state: 'visible' });
await replyDialog.locator('textarea[name="text"]').fill('bob replies as a real post');
await replyDialog.locator('button.social-primary').filter({ hasText: 'Reply' }).click();
await bob.page.getByText('bob replies as a real post', { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
await bob.page.screenshot({ path: 'social-bob-following-reply.png', fullPage: false });

await shellAction(alice.page, 'social.discover').click();
const bobReply = alice.page.locator('#feed .post', { hasText: 'bob replies as a real post' });
await bobReply.waitFor({ state: 'visible', timeout: 15000 });
await bobReply.getByRole('button', { name: /^Like/ }).click();
await alice.page.screenshot({ path: 'social-alice-like.png', fullPage: false });

await shellAction(bob.page, 'social.discover').click();
const likedReply = bob.page.locator('#feed .post', { hasText: 'bob replies as a real post' });
await likedReply.waitFor({ state: 'visible', timeout: 15000 });
await likedReply.getByRole('button', { name: 'Like 1', exact: true }).waitFor({ state: 'visible', timeout: 10000 });

const aliceRecords = await networkRecords(alice.page);
const bobRecords = await networkRecords(bob.page);
for (const [owner, records] of [['alice', aliceRecords], ['bob', bobRecords]]) {
  if (records.length !== 2) throw new Error(`${owner} expected two projected network records, saw ${records.length}`);
  for (const record of records) {
    if (record.type !== 'social' || !record.social?.postId || !record.author?.handle || !record.rank || !String(record.nativeId).startsWith('network:')) {
      throw new Error(`${owner} received an invalid network projection: ${JSON.stringify(record)}`);
    }
  }
}
const replyRecord = bobRecords.find(record => record.text === 'bob replies as a real post');
if (!replyRecord?.social?.replyTo || replyRecord.social.likeCount !== 1) throw new Error(`reply did not remain first-class with server facts: ${JSON.stringify(replyRecord)}`);
const localProfiles = await Promise.all([alice.page, bob.page].map(page => page.evaluate(() => JSON.parse(localStorage.getItem('sideways-workspace-profile-v1')))));
if (localProfiles[0].handle !== 'local-alice' || localProfiles[1].handle !== 'local-bob') throw new Error(`public identity overwrote local preferences: ${JSON.stringify(localProfiles)}`);
const sessions = await Promise.all([alice.page, bob.page].map(page => page.evaluate(() => window.SidewaysSocial.account()?.handle)));
if (sessions[0] !== 'alice' || sessions[1] !== 'bob') throw new Error(`session isolation failed: ${sessions}`);
for (const entry of [alice, bob]) {
  const overflow = await entry.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 1) throw new Error(`phone overflow ${overflow}`);
  if (entry.pageErrors.length) throw new Error(entry.pageErrors.join(' | '));
}

console.log(JSON.stringify({
  sessions,
  localProfiles: localProfiles.map(profile => profile.handle),
  projectedRecords: { alice: aliceRecords.length, bob: bobRecords.length },
  reply: { replyTo: replyRecord.social.replyTo, likeCount: replyRecord.social.likeCount },
  screenshots: ['social-alice-post.png', 'social-bob-following-reply.png', 'social-alice-like.png']
}, null, 2));
await alice.context.close();
await bob.context.close();
await browser.close();
