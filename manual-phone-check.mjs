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
const desktop = { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 };
const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });

function collectErrors(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  return errors;
}

async function touch(page, locator) {
  await locator.waitFor({ state: 'visible', timeout: 10000 });
  await locator.tap({ timeout: 10000 });
}

function assertNoAutomaticNavigation(navigations, operation) {
  if (!navigations.length) return;
  throw new Error(`${operation} triggered ${navigations.length} automatic main-frame navigation(s): ${navigations.join(', ')}`);
}

async function openAdd(page, mobile = false) {
  const add = page.getByRole('button', { name: 'ADD', exact: true });
  if (mobile) await touch(page, add); else await add.click();
  await page.locator('#addView').waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('#importWorkbenchHost').waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('section[data-survival-vault]').waitFor({ state: 'visible', timeout: 10000 });
}

async function assertFourChoices(page) {
  const labels = ['Connect an account', 'Add a website or feed', 'Import files', 'Restore a Sideways backup'];
  const choices = page.locator('.add-sideways-choice');
  if (await choices.count() !== 4) throw new Error(`expected four Add to Sideways choices, got ${await choices.count()}`);
  for (const label of labels) await page.getByRole('heading', { name: label, exact: true }).waitFor({ state: 'visible', timeout: 5000 });
  for (const forbidden of ['corpus', 'projection', 'relational-mode', 'Maker', 'weave', 'lasso', 'protocol']) {
    const text = (await page.locator('#importWorkbenchHost').innerText()).toLowerCase();
    if (text.includes(forbidden.toLowerCase())) throw new Error(`ordinary Add surface exposes internal vocabulary: ${forbidden}`);
  }
}

async function returnHome(page) {
  const addAnother = page.getByRole('button', { name: 'Add something else', exact: true });
  if (await addAnother.count()) await addAnother.click();
  else await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.locator('.add-sideways-choice').first().waitFor({ state: 'visible', timeout: 5000 });
}

const phoneContext = await browser.newContext(iphone);
await phoneContext.addInitScript(() => {
  localStorage.setItem('sideways-workspace-profile-v1', JSON.stringify({ name: 'Proof User', handle: 'proof', bio: '', accent: '#335cff' }));
});
const phone = await phoneContext.newPage();
const phoneErrors = collectErrors(phone);
const phoneNavigations = [];
phone.on('request', request => {
  if (request.isNavigationRequest() && request.frame() === phone.mainFrame()) phoneNavigations.push(request.url());
});
await phone.goto('http://127.0.0.1:4173/manual/', { waitUntil: 'networkidle' });
await phone.waitForFunction(() => document.documentElement.dataset.studioReady === 'yes', { timeout: 15000 });
phoneNavigations.length = 0;
await openAdd(phone, true);
await assertFourChoices(phone);
await phone.locator('#sidewaysImportFiles[data-phone-ready="yes"]').waitFor({ state: 'attached', timeout: 10000 });

const visibleLegacyChildren = await phone.locator('#addView.studio-add-modern').evaluate(node => [...node.children]
  .filter(child => !child.matches('#importWorkbenchHost, [data-workspace-library-header], [data-survival-vault]'))
  .filter(child => getComputedStyle(child).display !== 'none').length);
if (visibleLegacyChildren !== 0) throw new Error(`legacy ADD surface still visible: ${visibleLegacyChildren} child node(s)`);

await touch(phone, phone.locator('.add-sideways-choice[data-choice="connect"] button'));
await phone.getByRole('heading', { name: 'Connect an account', exact: true }).waitFor({ state: 'visible' });
const unavailable = phone.getByRole('button', { name: 'Unavailable', exact: true });
if (await unavailable.count() !== 5) throw new Error(`static connection fallback expected five unavailable providers, got ${await unavailable.count()}`);
if (!/cannot hold account tokens/i.test(await phone.locator('#importWorkbenchHost').innerText())) throw new Error('static token boundary is not explained');
await returnHome(phone);

await touch(phone, phone.locator('.add-sideways-choice[data-choice="web"] button'));
await phone.locator('input[name="sourceURL"]').fill('https://example.com/feed.xml');
await phone.getByRole('button', { name: 'Add source', exact: true }).click();
await phone.locator('.capability-web').waitFor({ state: 'visible' });
if (!/not Private until you explicitly save/i.test(await phone.locator('#importWorkbenchHost').innerText())) throw new Error('public/private boundary is missing');
await returnHome(phone);
await touch(phone, phone.locator('.add-sideways-choice[data-choice="web"] button'));
await phone.locator('.source-list article').waitFor({ state: 'visible' });
await phone.getByRole('button', { name: 'Turn off', exact: true }).click();
await phone.getByRole('button', { name: 'Turn on', exact: true }).waitFor({ state: 'visible' });
await phone.getByRole('button', { name: 'Turn on', exact: true }).click();
await phone.getByRole('button', { name: 'Remove', exact: true }).click();
if (await phone.locator('.source-list article').count()) throw new Error('source removal did not update the collection');
await returnHome(phone);

await touch(phone, phone.locator('.add-sideways-choice[data-choice="files"] button'));
await phone.locator('.add-sideways-dropzone').waitFor({ state: 'visible' });
const chooserPromise = phone.waitForEvent('filechooser', { timeout: 10000 });
await touch(phone, phone.getByRole('button', { name: 'Choose files', exact: true }));
const chooser = await chooserPromise;
await chooser.setFiles({
  name: 'comments.csv',
  mimeType: 'text/csv',
  buffer: Buffer.from('body,subreddit,permalink,created_utc,author,id\n"hello from reddit",sideways,/r/sideways/comments/1,1700000000,kai,abc123\n')
});
await phone.locator('.import-complete-panel .capability-private').waitFor({ state: 'visible', timeout: 15000 });
if (!/Private on this device/i.test(await phone.locator('.import-complete-panel').innerText())) throw new Error('file result did not state private ownership');
assertNoAutomaticNavigation(phoneNavigations, 'file import');

const ark = await phone.evaluate(async () => {
  const result = await window.SidewaysSurvival.exportArk({ download: false });
  const bytes = new Uint8Array(await result.blob.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return { name: result.filename, base64: btoa(binary) };
});
await returnHome(phone);
await touch(phone, phone.locator('.add-sideways-choice[data-choice="restore"] button'));
const restoreChooserPromise = phone.waitForEvent('filechooser', { timeout: 10000 });
await touch(phone, phone.getByRole('button', { name: 'Choose backup', exact: true }));
const restoreChooser = await restoreChooserPromise;
await restoreChooser.setFiles({ name: ark.name, mimeType: 'application/x-sideways-ark', buffer: Buffer.from(ark.base64, 'base64') });
await phone.locator('.import-complete-panel .capability-private').waitFor({ state: 'visible', timeout: 15000 });
if (!/restored transactionally/i.test(await phone.locator('.import-complete-panel').innerText())) throw new Error('Ark restore did not reach committed result');
assertNoAutomaticNavigation(phoneNavigations, 'Ark restore');
if (phoneErrors.length) throw new Error(phoneErrors.join(' | '));
await phone.screenshot({ path: 'add-to-sideways-phone.png', fullPage: true });
await phoneContext.close();

const desktopContext = await browser.newContext(desktop);
await desktopContext.addInitScript(() => {
  localStorage.setItem('sideways-workspace-profile-v1', JSON.stringify({ name: 'Proof User', handle: 'proof', bio: '', accent: '#335cff' }));
});
const desktopPage = await desktopContext.newPage();
const desktopErrors = collectErrors(desktopPage);
await desktopPage.goto('http://127.0.0.1:4173/manual/', { waitUntil: 'networkidle' });
await desktopPage.waitForFunction(() => document.documentElement.dataset.studioReady === 'yes', { timeout: 15000 });
await openAdd(desktopPage);
await assertFourChoices(desktopPage);
const first = await desktopPage.locator('.add-sideways-choice').nth(0).boundingBox();
const second = await desktopPage.locator('.add-sideways-choice').nth(1).boundingBox();
if (!first || !second || Math.abs(first.y - second.y) > 4 || second.x <= first.x) throw new Error('desktop Add choices did not form the expected two-column row');
await desktopPage.locator('.add-sideways-choice[data-choice="files"] button').click();
await desktopPage.locator('.add-sideways-dropzone').waitFor({ state: 'visible' });
if (desktopErrors.length) throw new Error(desktopErrors.join(' | '));
await desktopPage.screenshot({ path: 'add-to-sideways-desktop.png', fullPage: true });
await desktopContext.close();

console.log(JSON.stringify({
  schema: 'sideways-add-journey-receipt/v1',
  phone: { viewport: '390x844', choices: 4, staticConnections: 'unavailable-honest', sourceControls: true, fileImport: 'private', arkRestore: 'transactional', automaticReloads: phoneNavigations.length },
  desktop: { viewport: '1280x900', choices: 4, twoColumn: true, dropzone: true },
  screenshots: ['add-to-sideways-phone.png', 'add-to-sideways-desktop.png']
}, null, 2));
await browser.close();
