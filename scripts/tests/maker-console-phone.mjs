import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { createOperatorRuntimeReceipt } from '../maker-archie-operator.mjs';

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
  archieDefaultTruth: false,
  archieLocalHit: false,
  archiePlannerHit: false,
  archieEscalation: false,
  archiePackCommand: false,
  archieSyncState: false,
  archieRejections: false,
  archieNamespaceIsolated: false,
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
const runtimeNow = Date.now();
const localReceipt = createOperatorRuntimeReceipt({
  route: { sparse: 'hit', planner: 'not-needed', selected: 'sparse-specialist', confidence: 0.94, margin: 0.45 },
  budget: { decision: 'local-first', charged_credits: 0, usage_evidence: 'observed' },
  teacher: { state: 'not-called', reason: 'sparse specialist admitted' },
  learning: { lesson: 'already-stored', retraining: 'not-needed' },
  corpus: { health: 'healthy', pack: 'verified', pack_digest: 'a'.repeat(64) },
  sync: { state: 'locked', generation: 3 },
  compute: { selected: 'local-cpu', gpu: 'unavailable', linux: 'unavailable', storage: 'unavailable', ladder: [{ kind: 'local_cpu', state: 'available', evidence: 'observed receipt' }] },
  blockers: ['GPU not observed.', 'Linux worker not observed.', 'Persistent storage unavailable.']
}, { clock: () => runtimeNow });
const plannerReceipt = createOperatorRuntimeReceipt({
  route: { sparse: 'miss', planner: 'hit', selected: 'cpu-planner', confidence: 0.84, margin: 0.29 },
  budget: { decision: 'local-first', charged_credits: 0, usage_evidence: 'observed' },
  teacher: { state: 'not-called', reason: 'CPU planner admitted' },
  learning: { lesson: 'stored', retraining: 'complete' },
  corpus: { health: 'healthy', pack: 'verified', pack_digest: 'b'.repeat(64) },
  sync: { state: 'locked', generation: 4 },
  compute: { selected: 'local-cpu', gpu: 'unavailable', linux: 'unavailable', storage: 'available', ladder: [{ kind: 'local_cpu', state: 'available', evidence: 'observed receipt' }] },
  blockers: ['Burst GPU unavailable because no adapter was observed.']
}, { clock: () => runtimeNow });
const escalationReceipt = createOperatorRuntimeReceipt({
  route: { sparse: 'miss', planner: 'miss', selected: 'teacher', confidence: 0.21, margin: 0.03 },
  budget: { decision: 'teacher-approved', charged_credits: 17, usage_evidence: 'provider-reported' },
  teacher: { state: 'called', reason: 'local confidence below escalation threshold' },
  learning: { lesson: 'stored', retraining: 'pending' },
  corpus: { health: 'healthy', pack: 'verified', pack_digest: 'c'.repeat(64) },
  sync: { state: 'error', generation: 5, error: 'relay unavailable' },
  compute: { selected: 'local-cpu', gpu: 'unavailable', linux: 'unavailable', storage: 'available', ladder: [{ kind: 'local_cpu', state: 'available', evidence: 'observed receipt' }] },
  blockers: ['Teacher route requires configured provider authority.', 'Encrypted relay unavailable.']
}, { clock: () => runtimeNow });
const staleReceipt = createOperatorRuntimeReceipt({}, { clock: () => runtimeNow - 10 * 60_000, ttl_ms: 60_000 });
const wrongNamespaceReceipt = createOperatorRuntimeReceipt({}, { clock: () => runtimeNow, namespace: 'other' });
const browserErrors = [];
const unexpectedBrowserErrors = () => browserErrors.filter(message => !/ERR_INTERNET_DISCONNECTED/.test(message));
page.on('pageerror', error => browserErrors.push(error.message));
page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()); });
const openDetails = async label => {
  const summary = page.locator('details > summary').filter({ hasText: label }).first();
  const details = summary.locator('..');
  if (await details.getAttribute('open') === null) await summary.click();
};
try {
  await page.goto('http://127.0.0.1:4175/maker/', { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Build software.' }).waitFor({ state: 'visible' });
  await openDetails('Repository, proof, and execution controls');
  await openDetails('Live public repository state');
  await openDetails('Observed Archie runtime receipt');
  await page.waitForFunction(() => document.querySelector('#archie-compute')?.textContent.includes('unavailable until observed'));
  proof.executionTruthVisible = await page.locator('text=Task author only').count() > 0
    && /required before first write/i.test(await page.locator('#lease-state').innerText())
    && (await page.locator('#tool-state').innerText()).includes('rollback');
  if (!proof.executionTruthVisible) throw new Error('execution truth is not visible after opening advanced controls');
  proof.archieDefaultTruth = await page.locator('#archie-sparse').innerText() === 'Unobserved'
    && /unavailable until observed/i.test(await page.locator('#archie-compute').innerText())
    && await page.locator('text=Training complete').count() === 0
    && await page.locator('text=GPU available').count() === 0;
  if (!proof.archieDefaultTruth) throw new Error('Archie default surface claimed unobserved execution');
  const applyArchie = async receipt => {
    await page.locator('#archie-receipt-input').fill(JSON.stringify(receipt));
    await page.locator('#archie-apply').click();
    await page.waitForTimeout(50);
  };
  await applyArchie(localReceipt);
  proof.archieLocalHit = await page.locator('#archie-sparse').innerText() === 'hit'
    && await page.locator('#archie-route').innerText() === 'sparse-specialist'
    && /locked.*relay plaintext authority: none/i.test(await page.locator('#archie-sync').innerText())
    && await page.locator('#archie-storage').innerText() === 'unavailable';
  if (!proof.archieLocalHit) throw new Error('Archie local specialist receipt did not render truthfully');
  await applyArchie(plannerReceipt);
  proof.archiePlannerHit = await page.locator('#archie-planner').innerText() === 'hit'
    && await page.locator('#archie-route').innerText() === 'cpu-planner'
    && /0\.84 \/ 0\.29/.test(await page.locator('#archie-confidence').innerText());
  if (!proof.archiePlannerHit) throw new Error('Archie CPU planner receipt did not render truthfully');
  await applyArchie(escalationReceipt);
  proof.archieEscalation = /called.*local confidence/i.test(await page.locator('#archie-teacher').innerText())
    && /stored \/ pending/i.test(await page.locator('#archie-learning').innerText())
    && /17 credits/.test(await page.locator('#archie-budget').innerText());
  proof.archieSyncState = /error.*relay unavailable.*relay plaintext authority: none/i.test(await page.locator('#archie-sync').innerText());
  if (!proof.archieEscalation || !proof.archieSyncState) throw new Error('Archie escalation or sync error timeline did not render');
  await page.locator('#archie-export-pack').click();
  await page.waitForFunction(() => document.querySelector('#archie-command-preview')?.textContent.includes('export_pack'));
  proof.archiePackCommand = /"execution_claimed": false/.test(await page.locator('#archie-command-preview').textContent())
    && /does not claim execution/i.test(await page.locator('#archie-status').innerText());
  if (!proof.archiePackCommand) throw new Error('Archie pack command claimed execution');
  await applyArchie(staleReceipt);
  const staleRejected = /stale/i.test(await page.locator('#archie-status').innerText()) && await page.locator('#archie-sparse').innerText() === 'Unobserved';
  await applyArchie(wrongNamespaceReceipt);
  const namespaceRejected = /namespace/i.test(await page.locator('#archie-status').innerText()) && await page.locator('#archie-sparse').innerText() === 'Unobserved';
  const secretReceipt = structuredClone(localReceipt);
  secretReceipt.payload = { ...secretReceipt.payload, api_key: 'sk-123456789012345678901' };
  await applyArchie(secretReceipt);
  const secretRejected = /secret/i.test(await page.locator('#archie-status').innerText()) && await page.locator('#archie-sparse').innerText() === 'Unobserved';
  proof.archieRejections = staleRejected && namespaceRejected && secretRejected;
  proof.archieNamespaceIsolated = Object.keys(await page.evaluate(() => Object.fromEntries(Array.from({ length: localStorage.length }, (_, index) => { const key = localStorage.key(index); return [key, localStorage.getItem(key)]; })))).every(key => ['maker:engineering:task:v2', 'maker:archie:receipt:v1'].includes(key));
  if (!proof.archieRejections || !proof.archieNamespaceIsolated) throw new Error('Archie stale/secret/namespace rejection or storage isolation failed');
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
  await openDetails('Live public repository state');
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
