import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { createOperatorRuntimeReceipt } from '../maker-archie-operator.mjs';

const executablePath = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean).find(value => fs.existsSync(value));
if (!executablePath) throw new Error('no Chromium found');
const proof = {
  executablePath, viewport: '390x844', executionTruthVisible: false, crossRepositoryRouting: false,
  liveState: false, timeline: false, issueBridge: false, longReceiptFallback: false,
  interventions: false, persisted: false, degraded: false, secretRejected: false,
  expectedOfflineErrors: 0, overflow: null, archieDefaultTruth: false, archieLocalHit: false,
  archiePlannerHit: false, archieEscalation: false, archiePackCommand: false,
  archieRejections: false, archieNamespaceIsolated: false, errors: []
};
const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
const apiRoutes = [];
const control = 'Pokitomas/theawesomehexapp';
await context.route(url => url.hostname === 'api.github.com' && /^\/repos\/(?:Pokitomas\/theawesomehexapp|acme\/widgets)\/commits\/main$/.test(url.pathname), route => {
  apiRoutes.push(route.request().url());
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sha: '634a511f68e80db708d890a86f757332819f1e5c' }) });
});
await context.route(url => url.hostname === 'api.github.com' && url.pathname === `/repos/${control}/issues` && url.searchParams.get('state') === 'open', route => {
  apiRoutes.push(route.request().url());
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
    { number: 293, title: 'Autonomous Maker', updated_at: '2026-07-15T05:02:00Z', html_url: `https://github.com/${control}/pull/293`, pull_request: {} },
    { number: 291, title: '[maker:repair] Integration coordinator', updated_at: '2026-07-15T05:01:00Z', html_url: `https://github.com/${control}/issues/291` },
    { number: 290, title: 'Discovery import', updated_at: '2026-07-15T05:00:00Z', html_url: `https://github.com/${control}/pull/290`, pull_request: {} }
  ]) });
});
await context.route(url => url.hostname === 'api.github.com' && url.pathname === `/repos/${control}/actions/runs`, route => {
  apiRoutes.push(route.request().url());
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ workflow_runs: [
    { id: 3, name: 'Verify Maker runtimes', status: 'in_progress', conclusion: null, event: 'pull_request', head_branch: 'maker/issue-291', head_sha: 'abcdef1234567890', created_at: '2026-07-15T05:03:00Z', html_url: `https://github.com/${control}/actions/runs/3` },
    { id: 2, name: 'Repository gate', status: 'completed', conclusion: 'success', event: 'pull_request', head_branch: 'maker/issue-291', head_sha: 'abcdef1234567890', created_at: '2026-07-15T05:02:00Z', html_url: `https://github.com/${control}/actions/runs/2` }
  ] }) });
});
await context.route(url => url.hostname === 'api.github.com' && url.pathname === `/repos/${control}/issues/291/comments`, route => {
  apiRoutes.push(route.request().url());
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
    { id: 7, body: '<!-- sideways-native-worker:v1 -->\n**branch:** maker/issue-291\n**base_sha:** abcdef1234567890\n**run:** https://github.com/Pokitomas/theawesomehexapp/actions/runs/3', html_url: `https://github.com/${control}/issues/291#issuecomment-7` }
  ]) });
});
await context.route(url => url.hostname === 'github.com' && url.pathname === `/${control}/issues/new`, route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>GitHub control task</title><h1>Control task received</h1>' }));

const page = await context.newPage();
const runtimeNow = Date.now();
const localReceipt = createOperatorRuntimeReceipt({
  route: { sparse: 'hit', planner: 'not-needed', selected: 'sparse-specialist', confidence: 0.94, margin: 0.45 },
  budget: { decision: 'local-first', charged_credits: 0, usage_evidence: 'observed' },
  teacher: { state: 'not-called', reason: 'sparse specialist admitted' }, learning: { lesson: 'already-stored', retraining: 'not-needed' },
  corpus: { health: 'healthy', pack: 'verified', pack_digest: 'a'.repeat(64) }, sync: { state: 'locked', generation: 3 },
  compute: { selected: 'local-cpu', gpu: 'unavailable', linux: 'unavailable', storage: 'unavailable', ladder: [{ kind: 'local_cpu', state: 'available', evidence: 'observed receipt' }] },
  blockers: ['GPU not observed.', 'Linux worker not observed.', 'Persistent storage unavailable.']
}, { clock: () => runtimeNow });
const plannerReceipt = createOperatorRuntimeReceipt({
  route: { sparse: 'miss', planner: 'hit', selected: 'cpu-planner', confidence: 0.84, margin: 0.29 },
  budget: { decision: 'local-first', charged_credits: 0, usage_evidence: 'observed' }, teacher: { state: 'not-called', reason: 'CPU planner admitted' },
  learning: { lesson: 'stored', retraining: 'complete' }, corpus: { health: 'healthy', pack: 'verified', pack_digest: 'b'.repeat(64) }, sync: { state: 'locked', generation: 4 },
  compute: { selected: 'local-cpu', gpu: 'unavailable', linux: 'unavailable', storage: 'available', ladder: [{ kind: 'local_cpu', state: 'available', evidence: 'observed receipt' }] }, blockers: []
}, { clock: () => runtimeNow });
const escalationReceipt = createOperatorRuntimeReceipt({
  route: { sparse: 'miss', planner: 'miss', selected: 'teacher', confidence: 0.21, margin: 0.03 },
  budget: { decision: 'teacher-approved', charged_credits: 17, usage_evidence: 'provider-reported' }, teacher: { state: 'called', reason: 'local confidence below escalation threshold' },
  learning: { lesson: 'stored', retraining: 'pending' }, corpus: { health: 'healthy', pack: 'verified', pack_digest: 'c'.repeat(64) }, sync: { state: 'error', generation: 5, error: 'relay unavailable' },
  compute: { selected: 'local-cpu', gpu: 'unavailable', linux: 'unavailable', storage: 'available', ladder: [{ kind: 'local_cpu', state: 'available', evidence: 'observed receipt' }] }, blockers: ['Teacher route requires configured provider authority.']
}, { clock: () => runtimeNow });
const staleReceipt = createOperatorRuntimeReceipt({}, { clock: () => runtimeNow - 10 * 60_000, ttl_ms: 60_000 });
const wrongNamespaceReceipt = createOperatorRuntimeReceipt({}, { clock: () => runtimeNow, namespace: 'other' });
const browserErrors = [];
const unexpectedBrowserErrors = () => browserErrors.filter(message => !/ERR_INTERNET_DISCONNECTED/.test(message));
page.on('pageerror', error => browserErrors.push(error.message));
page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()); });
try {
  await page.goto('http://127.0.0.1:4175/maker/', { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Build software.' }).waitFor({ state: 'visible' });
  proof.executionTruthVisible = await page.locator('text=Task author and observer only').count() > 0
    && await page.locator('text=One leased branch').count() > 0
    && (await page.locator('#tool-state').innerText()).includes('rollback')
    && await page.locator('#maker-control-repository').inputValue() === control;
  if (!proof.executionTruthVisible) throw new Error('execution truth or control repository is not visible');

  proof.archieDefaultTruth = await page.locator('#archie-sparse').innerText() === 'Unobserved'
    && /unavailable until observed/i.test(await page.locator('#archie-compute').innerText())
    && await page.locator('text=Training complete').count() === 0 && await page.locator('text=GPU available').count() === 0;
  if (!proof.archieDefaultTruth) throw new Error('Archie default surface claimed unobserved execution');
  const applyArchie = async receipt => { await page.locator('#archie-receipt-input').fill(JSON.stringify(receipt)); await page.locator('#archie-apply').click(); await page.waitForTimeout(40); };
  await applyArchie(localReceipt);
  proof.archieLocalHit = await page.locator('#archie-sparse').innerText() === 'hit' && await page.locator('#archie-route').innerText() === 'sparse-specialist';
  await applyArchie(plannerReceipt);
  proof.archiePlannerHit = await page.locator('#archie-planner').innerText() === 'hit' && /0\.84 \/ 0\.29/.test(await page.locator('#archie-confidence').innerText());
  await applyArchie(escalationReceipt);
  proof.archieEscalation = /called.*local confidence/i.test(await page.locator('#archie-teacher').innerText()) && /17 credits/.test(await page.locator('#archie-budget').innerText());
  await page.locator('#archie-export-pack').click();
  await page.waitForFunction(() => document.querySelector('#archie-command-preview')?.textContent.includes('export_pack'));
  proof.archiePackCommand = /"execution_claimed": false/.test(await page.locator('#archie-command-preview').textContent());
  await applyArchie(staleReceipt); const staleRejected = /stale/i.test(await page.locator('#archie-status').innerText());
  await applyArchie(wrongNamespaceReceipt); const namespaceRejected = /namespace/i.test(await page.locator('#archie-status').innerText());
  const secretReceipt = structuredClone(localReceipt); secretReceipt.payload = { ...secretReceipt.payload, api_key: 'sk-123456789012345678901' };
  await applyArchie(secretReceipt); const secretReceiptRejected = /secret/i.test(await page.locator('#archie-status').innerText());
  proof.archieRejections = staleRejected && namespaceRejected && secretReceiptRejected;
  if (!proof.archieLocalHit || !proof.archiePlannerHit || !proof.archieEscalation || !proof.archiePackCommand || !proof.archieRejections) throw new Error('Archie receipt timeline or rejection proof failed');

  await page.waitForFunction(() => document.querySelector('#repo-head')?.textContent === '634a511f68e8');
  proof.liveState = await page.locator('#open-issues').innerText() === '1' && await page.locator('#open-prs').innerText() === '2'
    && await page.locator('#running-workflows').innerText() === '1' && await page.locator('#active-work .operation-row').count() === 3
    && await page.locator('#workflow-runs .operation-row').count() === 2 && apiRoutes.length >= 4;
  proof.timeline = await page.locator('#task-timeline .operation-row').count() >= 6;
  if (!proof.liveState || !proof.timeline) throw new Error('mocked execution state or machine timeline did not render completely');

  await page.locator('#maker-repository').fill('acme/widgets');
  await page.locator('#maker-head-repository').fill('acme/widgets-fork');
  await page.locator('#maker-branch').fill('maker/issue-304');
  await page.locator('[data-mode="repair"]').click();
  await page.locator('#maker-base').fill('36666d4288fca28a0a76324f6cb7906050d7e11e');
  await page.locator('#maker-backend').selectOption('native');
  await page.locator('#maker-request').fill('Build a repository-general repair engine with an exact branch lease.');
  await page.locator('#maker-protect').fill('Keep credentials server-side and require human merge approval.');
  await page.locator('#maker-proof').fill('Run a failing fixture, diagnose it, repair it, verify it, and emit a receipt.');
  if (!/blocked until checkpoint admission/.test(await page.locator('#backend-state').innerText())) throw new Error('native backend did not expose admission block');
  const bridgeHref = await page.locator('#send-command').getAttribute('href');
  const bridge = new URL(bridgeHref || ''); const body = bridge.searchParams.get('body') || '';
  proof.crossRepositoryRouting = bridge.pathname === `/${control}/issues/new` && body.includes('target repository: `acme/widgets`')
    && body.includes('head repository: `acme/widgets-fork`') && body.includes('leased branch: `maker/issue-304`');
  if (!proof.crossRepositoryRouting) throw new Error(`cross-repository routing failed: ${bridgeHref}`);
  proof.interventions = await page.locator('#intervention-links .operation-row').count() === 6
    && (await page.locator('#intervention-links .operation-row').first().getAttribute('href')).includes(`github.com/${control}/issues/new`);
  if (!proof.interventions) throw new Error('intervention links are missing or claim direct execution');

  const normalRequest = await page.locator('#maker-request').inputValue();
  await page.locator('#maker-request').fill('x'.repeat(8000)); await page.locator('#maker-protect').fill('y'.repeat(4000)); await page.locator('#maker-proof').fill('z'.repeat(4000));
  proof.longReceiptFallback = await page.locator('#send-command').innerText() === 'OPEN COMPACT TASK'
    && /Compact issue \+ full receipt required/.test(await page.locator('#dispatch-strategy').innerText());
  if (!proof.longReceiptFallback) throw new Error('long receipt did not switch to truthful compact transport');
  await page.locator('#maker-request').fill(normalRequest); await page.locator('#maker-protect').fill('Keep credentials server-side and require human merge approval.'); await page.locator('#maker-proof').fill('Run a failing fixture, diagnose it, repair it, verify it, and emit a receipt.');

  await page.locator('#maker-request').fill('ghp_123456789012345678901234567890123456');
  proof.secretRejected = await page.locator('#send-command').getAttribute('aria-disabled') === 'true' && /Secret-like/i.test(await page.locator('#command-status').innerText());
  if (!proof.secretRejected) throw new Error('secret-like command was not rejected');
  await page.locator('#maker-request').fill(normalRequest);

  const popupPromise = context.waitForEvent('page'); await page.locator('#send-command').click(); const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded'); proof.issueBridge = popup.url().startsWith(`https://github.com/${control}/issues/new?`); await popup.close();
  await page.reload({ waitUntil: 'networkidle' });
  proof.persisted = (await page.locator('#maker-request').inputValue()).startsWith('Build a repository-general repair engine')
    && await page.locator('#maker-repository').inputValue() === 'acme/widgets' && await page.locator('#maker-head-repository').inputValue() === 'acme/widgets-fork'
    && await page.locator('#maker-branch').inputValue() === 'maker/issue-304' && await page.locator('[data-mode="repair"]').getAttribute('aria-pressed') === 'true'
    && await page.locator('#recent-receipts .operation-row').count() >= 1;
  if (!proof.persisted || !proof.issueBridge) throw new Error('task routing or local receipt history did not survive phone reload');

  const keys = await page.evaluate(() => Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)));
  proof.archieNamespaceIsolated = keys.every(key => ['maker:engineering:task:v3', 'maker:engineering:receipts:v1', 'maker:archie:receipt:v1'].includes(key));
  if (!proof.archieNamespaceIsolated) throw new Error(`unexpected localStorage namespace: ${keys.join(', ')}`);
  if (browserErrors.length) throw new Error(`unexpected browser errors before degraded-state test: ${browserErrors.join(' | ')}`);
  await context.unrouteAll({ behavior: 'wait' }); await context.setOffline(true); await page.locator('#refresh-state').click(); await page.waitForTimeout(150);
  proof.degraded = /offline|unavailable/i.test(await page.locator('#state-status').innerText());
  proof.expectedOfflineErrors = browserErrors.filter(message => /ERR_INTERNET_DISCONNECTED/.test(message)).length;
  proof.overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (!proof.degraded) throw new Error('offline state was not reported');
  if (proof.overflow > 1) throw new Error(`maker console overflows phone viewport by ${proof.overflow}px`);
  if (unexpectedBrowserErrors().length) throw new Error(unexpectedBrowserErrors().join(' | '));
} catch (error) {
  proof.errors.push(error instanceof Error ? error.message : String(error)); proof.errors.push(...unexpectedBrowserErrors()); throw error;
} finally {
  try { await page.screenshot({ path: 'maker-console-phone.png', fullPage: true }); } catch (error) { proof.errors.push(`screenshot: ${error instanceof Error ? error.message : String(error)}`); }
  fs.writeFileSync('maker-console-proof.json', `${JSON.stringify(proof, null, 2)}\n`); console.log(JSON.stringify(proof, null, 2)); await browser.close();
}
