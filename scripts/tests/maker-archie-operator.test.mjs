import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
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
  const css = await fs.readFile(path.resolve('maker/maker.css'), 'utf8');
  assert.match(html, /id="archie-runtime"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(css, /@media \(max-width: 520px\)/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /:focus-visible/);
  assert.match(html, /textContent/);
  assert.match(html, /Storage unavailable/);
  assert.match(html, /ctrlKey/);
  assert.match(html, /No authenticated runtime receipt loaded/);
  assert.doesNotMatch(html, />Training complete</i);
  assert.doesNotMatch(html, />GPU available</i);
});

test('real Chromium proves phone and desktop receipt-only behavior with exact page bytes', async t => {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); }
  catch { return t.skip('playwright-core unavailable'); }
  const executablePath = ['/usr/bin/google-chrome', '/usr/bin/chromium'].find(candidate => spawnSync('test', ['-x', candidate]).status === 0);
  if (!executablePath) return t.skip('Chromium unavailable');
  const htmlSource = await fs.readFile(path.resolve('maker/index.html'), 'utf8');
  const cssSource = await fs.readFile(path.resolve('maker/maker.css'), 'utf8');
  const exactPage = htmlSource
    .replace('<link rel="stylesheet" href="./maker.css">', `<style>${cssSource}</style>`)
    .replace('<script type="module" src="./maker.js"></script>', '');
  const installDigestShim = async page => {
    await page.exposeFunction('__archieNodeSha256', bytes => {
      return crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
    }).catch(() => {});
    await page.evaluate(() => {
      Object.defineProperty(globalThis.crypto, 'subtle', { configurable: true, value: {
        async digest(_algorithm, input) {
          const hex = await globalThis.__archieNodeSha256(Array.from(new Uint8Array(input)));
          return Uint8Array.from(hex.match(/../g).map(byte => Number.parseInt(byte, 16))).buffer;
        }
      }});
    });
  };
  const loadExactPage = async page => {
    await installDigestShim(page);
    await page.setContent(exactPage, { waitUntil: 'domcontentloaded' });
    await page.locator('#archie-runtime').waitFor({ state: 'visible' });
    return 'setContent-exact-bytes';
  };
  const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    {
      const live = createOperatorRuntimeReceipt({
        route: { sparse: 'hit', planner: 'not-needed', selected: 'sparse-specialist', confidence: 0.93, margin: 0.42 },
        budget: { decision: 'local-first', charged_credits: 0, usage_evidence: 'observed' },
        teacher: { state: 'not-called', reason: 'local specialist admitted' },
        learning: { lesson: 'already-stored', retraining: 'not-needed' },
        corpus: { health: 'healthy', pack: 'verified', pack_digest: 'b'.repeat(64) },
        sync: { state: 'locked', generation: 4 },
        compute: { selected: 'local-cpu', gpu: 'unavailable', linux: 'unavailable', storage: 'unavailable', ladder: [{ kind: 'local_cpu', state: 'available', evidence: 'observed receipt' }] },
        blockers: ['GPU not observed.', 'Linux worker not observed.', 'Persistent storage unavailable.']
      });
      for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
        const page = await browser.newPage({ viewport });
        await page.route('https://api.github.com/**', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await loadExactPage(page);
        await page.locator('#archie-runtime').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#archie-sparse').innerText(), 'Unobserved');
        assert.match(await page.locator('#archie-compute').innerText(), /unavailable until observed/i);
        await page.locator('#archie-receipt-input').fill(JSON.stringify(live));
        await page.locator('#archie-apply').click();
        await page.waitForFunction(() => document.querySelector('#archie-sparse')?.textContent === 'hit', null, { timeout: 5000 });
        assert.equal(await page.locator('#archie-route').innerText(), 'sparse-specialist');
        assert.match(await page.locator('#archie-sync').innerText(), /locked.*relay plaintext authority: none/i);
        assert.match(await page.locator('#archie-compute').innerText(), /local_cpu:available/);
        assert.equal(await page.locator('#archie-storage').innerText(), 'unavailable');
        await page.locator('#archie-export-pack').click();
        await page.waitForFunction(() => document.querySelector('#archie-command-preview')?.textContent.includes('export_pack'), null, { timeout: 5000 });
        assert.match(await page.locator('#archie-command-preview').textContent(), /"operation": "export_pack"/);
        assert.match(await page.locator('#archie-status').innerText(), /does not claim execution/i);
        assert.equal(await page.locator('text=Training complete').count(), 0);
        assert.equal(await page.locator('text=GPU available').count(), 0);
        await page.locator('#archie-apply').focus();
        assert.equal(await page.evaluate(() => document.activeElement?.id), 'archie-apply');
        const transition = await page.locator('#archie-runtime').evaluate(node => getComputedStyle(node).transitionDuration);
        assert.ok(transition === '0s' || transition === '');
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(overflow <= 1, `viewport overflow ${overflow}px at ${viewport.width}x${viewport.height}`);
        await page.context().setOffline(true);
        await page.evaluate(() => dispatchEvent(new Event('offline')));
        assert.match(await page.locator('#archie-freshness').innerText(), /OFFLINE/);
        await page.close();
      }
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await context.addInitScript(() => {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key, value) {
          if (key === 'maker:archie:receipt:v1') throw new DOMException('blocked', 'QuotaExceededError');
          return original.call(this, key, value);
        };
      });
      const page = await context.newPage();
      await page.route('https://api.github.com/**', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
      await loadExactPage(page);
      await page.locator('#archie-receipt-input').fill(JSON.stringify(live));
      await page.locator('#archie-apply').click();
      assert.match(await page.locator('#archie-status').innerText(), /Storage unavailable/i);
      await context.close();
    }
  } finally { await browser.close(); }
});
