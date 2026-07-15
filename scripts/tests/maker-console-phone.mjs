import fs from 'node:fs';
import { chromium } from 'playwright-core';

const executablePath = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean).find(value => fs.existsSync(value));
if (!executablePath) throw new Error('no Chromium found');
const proof = {
  executablePath,
  viewport: '390x844',
  executionTruthVisible: false,
  liveState: false,
  issueBridge: false,
  persisted: false,
  degraded: false,
  expectedOfflineErrors: 0,
  overflow: null,
  errors: []
};
const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
const apiRoutes = [];
await context.route(url => {
  const matched = url.hostname === 'api.github.com' && url.pathname === '/repos/Pokitomas/theawesomehexapp/commits/main';
  if (matched) apiRoutes.push(url.toString());
  return matched;
}, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sha: '634a511f68e80db708d890a86f757332819f1e5c' }) }));
await context.route(url => {
  const matched = url.hostname === 'api.github.com' && url.pathname === '/repos/Pokitomas/theawesomehexapp/issues';
  if (matched) apiRoutes.push(url.toString());
  return matched;
}, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
  { number: 293, title: 'Autonomous Maker', updated_at: '2026-07-15T05:02:00Z', html_url: 'https://github.com/Pokitomas/theawesomehexapp/pull/293', pull_request: {} },
  { number: 291, title: 'Integration coordinator', updated_at: '2026-07-15T05:01:00Z', html_url: 'https://github.com/Pokitomas/theawesomehexapp/issues/291' },
  { number: 290, title: 'Discovery import', updated_at: '2026-07-15T05:00:00Z', html_url: 'https://github.com/Pokitomas/theawesomehexapp/pull/290', pull_request: {} }
]) }));
await context.route(url => {
  const matched = url.hostname === 'api.github.com' && url.pathname === '/repos/Pokitomas/theawesomehexapp/actions/runs';
  if (matched) apiRoutes.push(url.toString());
  return matched;
}, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ workflow_runs: [
  { id: 3, name: 'Verify Maker runtimes', status: 'in_progress', conclusion: null, event: 'pull_request', head_branch: 'maker/issue-289', head_sha: 'abcdef1234567890', created_at: '2026-07-15T05:03:00Z', html_url: 'https://github.com/Pokitomas/theawesomehexapp/actions/runs/3' },
  { id: 2, name: 'Repository gate', status: 'completed', conclusion: 'success', event: 'pull_request', head_branch: 'maker/issue-289', head_sha: 'abcdef1234567890', created_at: '2026-07-15T05:02:00Z', html_url: 'https://github.com/Pokitomas/theawesomehexapp/actions/runs/2' }
] }) }));
await context.route(url => url.hostname === 'github.com' && url.pathname === '/Pokitomas/theawesomehexapp/issues/new', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>GitHub task bridge</title><h1>Task bridge received</h1>' }));
const page = await context.newPage();
const browserErrors = [];
const unexpectedBrowserErrors = () => browserErrors.filter(message => !/ERR_INTERNET_DISCONNECTED/.test(message));
page.on('pageerror', error => browserErrors.push(error.message));
page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()); });
try {
  await page.goto('http://127.0.0.1:4175/maker/', { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Build software.' }).waitFor({ state: 'visible' });
  proof.executionTruthVisible = await page.locator('text=Task author only').count() > 0
    && await page.locator('text=One leased branch').count() > 0
    && (await page.locator('#tool-state').innerText()).includes('rollback');
  if (!proof.executionTruthVisible) throw new Error('execution truth is not visible');
  await page.waitForFunction(() => document.querySelector('#repo-head')?.textContent === '634a511f68e8');
  proof.liveState = await page.locator('#open-issues').innerText() === '1'
    && await page.locator('#open-prs').innerText() === '2'
    && await page.locator('#running-workflows').innerText() === '1'
    && await page.locator('#active-work .operation-row').count() === 3
    && await page.locator('#workflow-runs .operation-row').count() === 2
    && apiRoutes.length >= 3;
  if (!proof.liveState) throw new Error('mocked repository execution state did not render completely');
  await page.locator('[data-mode="explore"]').click();
  await page.locator('#maker-base').fill('36666d4288fca28a0a76324f6cb7906050d7e11e');
  await page.locator('#maker-backend').selectOption('native');
  await page.locator('#maker-request').fill('Build a repository-general repair engine with an exact branch lease.');
  await page.locator('#maker-protect').fill('Keep credentials server-side and require human merge approval.');
  await page.locator('#maker-proof').fill('Run a failing fixture, diagnose it, repair it, verify it, and emit a receipt.');
  if (!/blocked until checkpoint admission/.test(await page.locator('#backend-state').innerText())) throw new Error('native backend did not expose admission block');
  const bridgeHref = await page.locator('#send-command').getAttribute('href');
  if (!bridgeHref) throw new Error('maker did not generate a GitHub task bridge');
  const bridge = new URL(bridgeHref);
  if (bridge.pathname !== '/Pokitomas/theawesomehexapp/issues/new') throw new Error(`unexpected bridge target ${bridgeHref}`);
  const body = bridge.searchParams.get('body') || '';
  if (!body.includes('The browser did not execute code')) throw new Error('bridge lost execution boundary');
  if (!body.includes('36666d4288fca28a0a76324f6cb7906050d7e11e')) throw new Error('bridge lost exact base');
  const popupPromise = context.waitForEvent('page');
  await page.locator('#send-command').click();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');
  proof.issueBridge = popup.url().startsWith('https://github.com/Pokitomas/theawesomehexapp/issues/new?');
  await popup.close();
  await page.reload({ waitUntil: 'networkidle' });
  proof.persisted = (await page.locator('#maker-request').inputValue()).startsWith('Build a repository-general repair engine')
    && await page.locator('#maker-base').inputValue() === '36666d4288fca28a0a76324f6cb7906050d7e11e'
    && await page.locator('#maker-backend').inputValue() === 'native'
    && await page.locator('[data-mode="explore"]').getAttribute('aria-pressed') === 'true';
  if (!proof.persisted) throw new Error('engineering task did not survive phone reload');
  if (browserErrors.length) throw new Error(`unexpected browser errors before degraded-state test: ${browserErrors.join(' | ')}`);
  await context.unrouteAll({ behavior: 'wait' });
  await context.setOffline(true);
  await page.locator('#refresh-state').click();
  await page.waitForTimeout(150);
  proof.degraded = /offline|unavailable/i.test(await page.locator('#state-status').innerText());
  if (!proof.degraded) throw new Error('offline state was not reported');
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
