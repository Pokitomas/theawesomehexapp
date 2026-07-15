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
  viewport: '390x844',
  liveState: false,
  issueBridge: false,
  persisted: false,
  degraded: false,
  expectedOfflineErrors: 0,
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

const apiRoutes = [];
const commitRoute = async route => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ sha: '634a511f68e80db708d890a86f757332819f1e5c' })
});
const issuesRoute = async route => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify([
    { number: 218, title: 'Phone maker console', html_url: 'https://github.com/Pokitomas/theawesomehexapp/issues/218' },
    { number: 217, title: 'Replay repair', html_url: 'https://github.com/Pokitomas/theawesomehexapp/pull/217', pull_request: {} },
    { number: 216, title: 'Terminal drain', html_url: 'https://github.com/Pokitomas/theawesomehexapp/pull/216', pull_request: {} },
    { number: 215, title: 'Generation termination', html_url: 'https://github.com/Pokitomas/theawesomehexapp/issues/215' }
  ])
});
await context.route(url => {
  const matched = url.hostname === 'api.github.com' && url.pathname === '/repos/Pokitomas/theawesomehexapp/commits/main';
  if (matched) apiRoutes.push(url.toString());
  return matched;
}, commitRoute);
await context.route(url => {
  const matched = url.hostname === 'api.github.com' && url.pathname === '/repos/Pokitomas/theawesomehexapp/issues';
  if (matched) apiRoutes.push(url.toString());
  return matched;
}, issuesRoute);
await context.route(url => url.hostname === 'github.com' && url.pathname === '/Pokitomas/theawesomehexapp/issues/new', route => route.fulfill({
  status: 200,
  contentType: 'text/html',
  body: '<!doctype html><title>GitHub issue bridge</title><h1>Issue bridge received</h1>'
}));

const page = await context.newPage();
const browserErrors = [];
const unexpectedBrowserErrors = () => browserErrors.filter(message => !/ERR_INTERNET_DISCONNECTED/.test(message));
page.on('pageerror', error => browserErrors.push(error.message));
page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()); });

try {
  await page.goto('http://127.0.0.1:4175/maker/', { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Tell the machine what should exist.' }).waitFor({ state: 'visible' });

  await page.waitForFunction(() => document.querySelector('#repo-head')?.textContent === '634a511f68e8');
  proof.liveState =
    await page.locator('#open-issues').innerText() === '2'
    && await page.locator('#open-prs').innerText() === '2'
    && apiRoutes.length >= 2;
  if (!proof.liveState) throw new Error('mocked public repository state did not render exactly');

  await page.locator('[data-mode="explore"]').click();
  await page.locator('#maker-request').fill('Make Sideways feel like entering a living scene instead of operating a tool.');
  await page.locator('#maker-protect').fill('Keep private imports private and require my merge approval.');
  await page.locator('#maker-proof').fill('Show me a runnable phone world and the exact before/after journey.');

  const bridgeHref = await page.locator('#send-command').getAttribute('href');
  if (!bridgeHref) throw new Error('maker did not generate a GitHub issue bridge');
  const bridge = new URL(bridgeHref);
  if (bridge.origin !== 'https://github.com' || bridge.pathname !== '/Pokitomas/theawesomehexapp/issues/new') {
    throw new Error(`unexpected bridge target ${bridgeHref}`);
  }
  if (!bridge.searchParams.get('title')?.startsWith('[maker:explore]')) throw new Error('bridge title does not preserve mode');
  if (!bridge.searchParams.get('body')?.includes('Keep private imports private')) throw new Error('bridge body lost protected reality');

  const popupPromise = context.waitForEvent('page');
  await page.locator('#send-command').click();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');
  proof.bridgeUrl = popup.url();
  proof.issueBridge = proof.bridgeUrl.startsWith('https://github.com/Pokitomas/theawesomehexapp/issues/new?');
  if (!proof.issueBridge) throw new Error(`issue bridge did not open: ${proof.bridgeUrl}`);
  await popup.close();

  await page.reload({ waitUntil: 'networkidle' });
  const persistedRequest = await page.locator('#maker-request').inputValue();
  const explorePressed = await page.locator('[data-mode="explore"]').getAttribute('aria-pressed');
  proof.persisted = persistedRequest.startsWith('Make Sideways feel like entering a living scene') && explorePressed === 'true';
  if (!proof.persisted) throw new Error('founder command did not survive phone reload');

  if (browserErrors.length) throw new Error(`unexpected browser errors before degraded-state test: ${browserErrors.join(' | ')}`);
  await context.unrouteAll({ behavior: 'wait' });
  await context.setOffline(true);
  await page.locator('#refresh-state').click();
  await page.waitForTimeout(150);
  const degradedStatus = await page.locator('#state-status').innerText();
  proof.degraded = /offline|unavailable/i.test(degradedStatus);
  if (!proof.degraded) throw new Error(`offline state was not reported: ${degradedStatus}`);
  proof.expectedOfflineErrors = browserErrors.filter(message => /ERR_INTERNET_DISCONNECTED/.test(message)).length;

  proof.overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (proof.overflow > 1) throw new Error(`maker console overflows phone viewport by ${proof.overflow}px`);
  if (unexpectedBrowserErrors().length) throw new Error(unexpectedBrowserErrors().join(' | '));
} catch (error) {
  proof.errors.push(error instanceof Error ? error.message : String(error));
  proof.errors.push(...unexpectedBrowserErrors());
  throw error;
} finally {
  try { await page.screenshot({ path: 'maker-console-phone.png', fullPage: true }); }
  catch (error) { proof.errors.push(`screenshot: ${error instanceof Error ? error.message : String(error)}`); }
  fs.writeFileSync('maker-console-proof.json', `${JSON.stringify(proof, null, 2)}\n`);
  console.log(JSON.stringify(proof, null, 2));
  await browser.close();
}
