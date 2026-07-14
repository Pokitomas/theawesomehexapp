import fs from 'node:fs';
import { chromium } from 'playwright-core';

const url = process.argv[2];
if (!url) throw new Error('usage: node remote-terminal-clickthrough.mjs <manual-url>');

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
await context.addInitScript(() => {
  localStorage.setItem('sideways-workspace-profile-v1', JSON.stringify({
    name: 'Kai', handle: 'kai', bio: 'building a nicer internet', accent: '#335cff'
  }));
});

const page = await context.newPage();
const errors = [];
let remoteReads = 0;
let remoteWrites = 0;
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

const projection = {
  state: {
    session: 'theawesomehexapp/universal-remote',
    generation: 4,
    decision: 'proceed',
    head_sha: 'f'.repeat(40),
    blocking: false,
    blocker_count: 0,
    claims: [{ scope: 'repo:branch:agent/frontier', holder: 'principal-7', expires_at: '2026-07-14T20:00:00.000Z' }],
    terminal: false,
    terminal_receipt: null,
    updated_at: new Date().toISOString()
  },
  messages: [
    {
      id: 'public-1', session: 'theawesomehexapp/universal-remote', generation: 4,
      issuer: 'principal-7', issued_at: new Date(Date.now() - 60_000).toISOString(),
      head_sha: 'f'.repeat(40), scope: ['repo:write'], visibility: 'public',
      payload: { action: 'Rebuilding the social feed around the universal remote.' }
    },
    {
      id: 'public-2', session: 'theawesomehexapp/universal-remote', generation: 4,
      issuer: 'ci-2', issued_at: new Date().toISOString(), head_sha: 'f'.repeat(40),
      scope: ['ci:read'], visibility: 'public', payload: { summary: 'Phone proof is running.' }
    }
  ],
  next_cursor: 'cursor-2'
};

await page.route('**/api/remote/state**', async route => {
  const request = route.request();
  if (request.method() !== 'GET') {
    remoteWrites += 1;
    await route.fulfill({ status: 405, contentType: 'application/json', body: JSON.stringify({ error: 'read only' }) });
    return;
  }
  remoteReads += 1;
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(projection) });
});

async function touch(locator) {
  await locator.waitFor({ state: 'visible', timeout: 15000 });
  const box = await locator.boundingBox();
  if (!box) throw new Error('touch target has no box');
  const clear = await locator.evaluate(node => {
    const rect = node.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hit === node || node.contains(hit);
  });
  if (!clear) throw new Error('touch target is physically obstructed');
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  return box;
}

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => document.documentElement.dataset.frontier === 'ready', { timeout: 15000 });
await page.waitForFunction(() => Boolean(window.SidewaysRemoteTerminal), { timeout: 10000 });

const discovery = await page.locator('link[data-sideways-remote-state]').getAttribute('href');
if (!discovery || !discovery.includes('/api/remote/state') || !discovery.includes('public=1')) {
  throw new Error(`machine discovery link is invalid: ${discovery}`);
}

const open = page.locator('[data-remote-open]');
const openBox = await touch(open);
if (openBox.width < 44 || openBox.height < 36 || openBox.x < 0 || openBox.x + openBox.width > 390) {
  throw new Error(`live terminal target is clipped or undersized: ${JSON.stringify(openBox)}`);
}

const terminal = page.locator('[data-remote-terminal]');
await terminal.waitFor({ state: 'visible', timeout: 10000 });
await terminal.getByText('moving', { exact: true }).waitFor({ state: 'visible' });
const renderedHead = await terminal.locator('[data-remote-head]').textContent();
if (renderedHead !== 'fffffffff') throw new Error(`head summary is wrong: ${renderedHead}`);
await terminal.getByText('Phone proof is running.', { exact: true }).waitFor({ state: 'visible' });

const terminalBox = await terminal.boundingBox();
if (!terminalBox || terminalBox.x < 0 || terminalBox.y < 0 || terminalBox.x + terminalBox.width > 390 || terminalBox.y + terminalBox.height > 844) {
  throw new Error(`terminal escapes phone viewport: ${JSON.stringify(terminalBox)}`);
}
await page.screenshot({ path: 'remote-terminal-phone-proof.png', fullPage: false });

await touch(terminal.getByRole('button', { name: 'Refresh', exact: true }));
await page.waitForFunction(() => document.documentElement.dataset.remoteDecision === 'proceed');
if (remoteReads < 2) throw new Error(`refresh did not read live state again: ${remoteReads}`);
if (remoteWrites !== 0) throw new Error(`browser attempted ${remoteWrites} remote write(s)`);

const exposed = await page.evaluate(() => ({
  html: document.documentElement.outerHTML,
  storage: Object.keys(localStorage).map(key => `${key}:${localStorage.getItem(key)}`).join('\n'),
  endpoint: window.SidewaysRemoteTerminal.endpoint()
}));
if (/REMOTE_ROOT_KEY|x-remote-signature|REMOTE_KEY_/i.test(`${exposed.html}\n${exposed.storage}`)) {
  throw new Error('browser surface exposed remote credentials or signature material');
}
if (!exposed.endpoint.includes('/api/remote/state')) throw new Error(`program endpoint missing: ${exposed.endpoint}`);

await touch(terminal.getByRole('button', { name: 'Close live work' }));
await terminal.waitFor({ state: 'hidden', timeout: 5000 });
if (errors.length) throw new Error(errors.join(' | '));

console.log(JSON.stringify({
  discovery,
  endpoint: exposed.endpoint,
  remoteReads,
  remoteWrites,
  state: 'moving',
  generation: 4,
  head: renderedHead,
  claimCount: 1,
  terminalBox,
  openBox,
  screenshot: 'remote-terminal-phone-proof.png'
}, null, 2));

await context.close();
await browser.close();
