import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  createOperatorCommandPacket,
  createOperatorRuntimeReceipt,
  emptyOperatorView,
  projectOperatorView,
  verifyOperatorCommandPacket,
  verifyOperatorRuntimeReceipt
} from '../maker-archie-operator.mjs';

const now = Date.parse('2026-07-16T07:00:00.000Z');
const clock = () => now;
const receipt = extra => createOperatorRuntimeReceipt({
  route: { sparse: 'miss', planner: 'hit', selected: 'cpu-planner', confidence: 0.82, margin: 0.31 },
  budget: { decision: 'local-first', charged_credits: 0, usage_evidence: 'observed' },
  teacher: { state: 'not-called', reason: 'planner confidence admitted' },
  learning: { lesson: 'stored', retraining: 'complete' },
  corpus: { health: 'healthy', pack: 'verified', pack_digest: 'a'.repeat(64) },
  sync: { state: 'locked', generation: 3 },
  compute: { selected: 'local-cpu', gpu: 'unavailable', linux: 'unavailable', storage: 'available', ladder: [{ kind: 'local_cpu', state: 'available', evidence: 'observed receipt' }] },
  blockers: ['GPU not observed.'],
  ...extra
}, { clock });

test('renders the real local/planner/budget/teacher/learning loop from a fresh authenticated receipt', () => {
  const view = projectOperatorView(receipt(), { clock });
  assert.equal(view.route.planner, 'hit');
  assert.equal(view.route.confidence, 0.82);
  assert.equal(view.budget.charged_credits, 0);
  assert.equal(view.teacher.state, 'not-called');
  assert.equal(view.learning.lesson, 'stored');
  assert.equal(view.execution_claimed_by_browser, false);
});

test('default offline surface reports every external fact as unobserved or unavailable', () => {
  const view = emptyOperatorView();
  assert.equal(view.route.sparse, 'unobserved');
  assert.match(view.compute.gpu, /unavailable/);
  assert.equal(view.sync.relay_plaintext_authority, false);
  assert.equal(view.execution_claimed_by_browser, false);
});

test('rejects stale and tampered receipts', () => {
  const fresh = receipt();
  assert.equal(verifyOperatorRuntimeReceipt(fresh, { clock }), true);
  assert.throws(() => verifyOperatorRuntimeReceipt(fresh, { clock: () => now + 10 * 60_000 }), /stale/);
  assert.throws(() => verifyOperatorRuntimeReceipt({ ...fresh, payload: { ...fresh.payload, route: { planner: 'fake-hit' } } }, { clock }), /digest/);
});

test('rejects secret material and isolates the Maker Archie namespace', () => {
  assert.throws(() => createOperatorRuntimeReceipt({ authorization: 'Bearer abcdefghijklmnopqrstuvwxyz' }, { clock }), /secret/i);
  const other = createOperatorRuntimeReceipt({}, { clock, namespace: 'other' });
  assert.throws(() => verifyOperatorRuntimeReceipt(other, { clock }), /namespace/);
});

test('exports truthful command packets without simulating execution', () => {
  const packet = createOperatorCommandPacket('export_pack', { destination: 'download' }, { clock });
  assert.equal(packet.execution_claimed, false);
  assert.equal(packet.requires_authenticated_runtime, true);
  assert.equal(verifyOperatorCommandPacket(packet), true);
  assert.throws(() => verifyOperatorCommandPacket({ ...packet, execution_claimed: true }), /invalid|digest/i);
});

test('rejects command secrets and unsupported actions', () => {
  assert.throws(() => createOperatorCommandPacket('deploy', {}, { clock }), /unsupported/i);
  assert.throws(() => createOperatorCommandPacket('sync', { api_key: 'sk-123456789012345678901' }, { clock }), /secret/i);
});

test('ships keyboard, focus, zoom/reflow, reduced-motion, storage failure and receipt-only language', async () => {
  const html = await fs.readFile(path.resolve('maker/index.html'), 'utf8');
  assert.match(html, /id="archie-runtime"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /@media \(max-width:520px\)/);
  assert.match(html, /prefers-reduced-motion:reduce/);
  assert.match(html, /textContent/);
  assert.match(html, /Storage unavailable/);
  assert.match(html, /No authenticated runtime receipt loaded/);
  assert.doesNotMatch(html, />Training complete</i);
  assert.doesNotMatch(html, />GPU available</i);
});

test('real Chromium renders 390x844 and desktop receipt-only surfaces when the repository browser dependency is installed', async t => {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); }
  catch { return t.skip('playwright-core is installed by the repository workflow, not this isolated lane fixture'); }
  const executablePath = ['/usr/bin/google-chrome', '/usr/bin/chromium'].find(candidate => spawnSync('test', ['-x', candidate]).status === 0);
  if (!executablePath) return t.skip('Chromium unavailable');
  const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
      const page = await browser.newPage({ viewport });
      await page.goto(`file://${path.resolve('maker/index.html')}`);
      await page.locator('#archie-runtime').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#archie-sparse').innerText(), 'Unobserved');
      assert.ok((await page.locator('#archie-compute').innerText()).includes('unavailable until observed'));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `viewport overflow ${overflow}px at ${viewport.width}x${viewport.height}`);
      await page.close();
    }
  } finally { await browser.close(); }
});
