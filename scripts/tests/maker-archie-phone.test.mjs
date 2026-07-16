import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  callAuthenticatedRuntime,
  containsSecret,
  createArchieCommandPacket,
  deriveArchieViewModel,
  storageKey
} from '../../maker/archie.js';

const root = path.resolve(new URL('../..', import.meta.url).pathname);
const read = file => fs.readFile(path.join(root, file), 'utf8');

test('declares a phone-first 390x844-safe document shell without claiming completion', async () => {
  const html = await read('maker/archie.html');
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">/);
  assert.match(html, /data-archie-root/);
  assert.match(html, /type="module" src="\.\/archie\.js" data-auto-init/);
  assert.doesNotMatch(html, /training complete|compute complete|fake/i);
});

test('proves mobile, desktop, keyboard, reduced-motion, and reflow CSS affordances', async () => {
  const css = await read('maker/archie.css');
  assert.match(css, /@media \(max-width:\s*430px\)/);
  assert.match(css, /@media \(min-width:\s*900px\)/);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /grid-template-columns:\s*1fr/);
  assert.match(css, /min-width:\s*0/);
});

test('renders truthful local-hit evidence and confidence-margin without browser-side training claims', () => {
  const vm = deriveArchieViewModel({
    generated_at: '2026-07-16T04:00:00.000Z',
    plan: {
      state: 'local',
      specialist_id: 'skill_git_repair',
      confidence: 0.81,
      margin: 0.29,
      threshold: 0.22,
      minimum_margin: 0.03
    },
    corpus: { records: 7, examples: 4, events: 9, last_record_id: 'rec_123', health: 'evidence-present' },
    retrain: { status: 'idle' },
    compute: { control_authenticated: true, linux_available: true, gpu_available: false, storage_available: true },
    usage: { cost_usd: 0.04, teacher_calls: 1, local_hits: 3, escalations: 1, source: 'route-receipt' }
  }, { viewport: { width: 390, height: 844 }, onLine: true });

  assert.equal(vm.loop.find(step => step.id === 'local-specialist-hit').state, 'complete');
  assert.match(vm.loop.find(step => step.id === 'confidence-margin').evidence, /confidence=0\.810 margin=0\.290/);
  assert.equal(vm.loop.find(step => step.id === 'retrain-state').state, 'idle');
  assert.equal(vm.pack.records, 7);
  assert.equal(vm.cost.cost_usd, 0.04);
  assert.equal(vm.compute.find(step => step.id === 'gpu').state, 'blocked');
});

test('renders escalation timeline, stored lesson, and retrain receipt only from runtime evidence', () => {
  const vm = deriveArchieViewModel({
    plan: { state: 'teacher', confidence: 0.36, margin: 0.02, corpus_record: { record_id: 'rec_teacher' } },
    teacher: { state: 'completed', run_id: 'teacher-run-1' },
    corpus: { records: 8, examples: 5, events: 11, last_example_id: 'ex_teacher' },
    retrain: { status: 'trained', model_digest: 'model_digest_abc' },
    compute: { control_authenticated: true, linux_available: true, gpu_available: false, storage_available: true },
    usage: { teacher_calls: 2, escalations: 2, source: 'teacher receipt' }
  });

  assert.equal(vm.loop.find(step => step.id === 'teacher-escalation').state, 'requested');
  assert.equal(vm.loop.find(step => step.id === 'lesson-stored').state, 'complete');
  assert.equal(vm.loop.find(step => step.id === 'retrain-state').state, 'complete');
  assert.equal(vm.loop.find(step => step.id === 'retrain-state').evidence, 'model_digest_abc');
});

test('offline and unavailable GPU/Linux/storage states are explicit external blockers', () => {
  const vm = deriveArchieViewModel({ compute: {} }, { onLine: false });
  const blockers = Object.fromEntries(vm.blockers.map(blocker => [blocker.id, blocker]));
  assert.equal(blockers.offline.state, 'blocked');
  assert.equal(blockers.linux.state, 'blocked');
  assert.equal(blockers.gpu.state, 'blocked');
  assert.equal(blockers.storage.state, 'blocked');
  assert.equal(vm.status, 'blocked');
});

test('pack export/import/retrain actions produce command packets, not fake completion receipts', () => {
  const exportPacket = createArchieCommandPacket('export_pack', { pack_digest: 'pack_a', records: 3 }, { now: '2026-07-16T04:01:00.000Z' });
  const importPacket = createArchieCommandPacket('import_pack', { pack_digest: 'pack_b', mode: 'dry-run' }, { now: '2026-07-16T04:02:00.000Z' });
  const retrainPacket = createArchieCommandPacket('start_retrain', { corpus_root: 'archie-local', dimensions: 512 }, { now: '2026-07-16T04:03:00.000Z' });

  for (const packet of [exportPacket, importPacket, retrainPacket]) {
    assert.equal(packet.status, 'ready_to_submit');
    assert.equal(packet.requires_authenticated_runtime, true);
    assert.match(packet.truthful_limitations.join(' '), /not proof/);
    assert.ok(packet.packet_digest);
  }
});

test('rejects secrets before browser storage, command export, or authenticated runtime calls', async () => {
  assert.equal(containsSecret({ nested: 'Bearer abcdefghijklmnop' }), true);
  assert.throws(() => createArchieCommandPacket('export_pack', { token: 'github_pat_123456789012345678901234567890' }), /refuses to store or export secrets/);
  await assert.rejects(
    callAuthenticatedRuntime('https://runtime.example.test/archie', { Authorization: 'Bearer abcdefghijklmnop' }, { token: 'runtime-token', fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true }) }) }),
    /secret-bearing payloads/
  );
});

test('uses scoped storage isolation keys instead of global browser state', () => {
  const left = storageKey('https://wizardpost.net/one', 'pack');
  const right = storageKey('https://wizardpost.net/two', 'pack');
  assert.match(left, /^archie\.phone\.runtime:[a-f0-9]{8}:pack$/);
  assert.notEqual(left, right);
  assert.throws(() => storageKey('', 'pack'), /explicit scope/);
});

test('authenticated runtime calls use the existing contract lane and never imply local completion', async () => {
  let observed;
  const result = await callAuthenticatedRuntime('https://runtime.example.test/archie', { action: 'sync_control', request: 'status' }, {
    token: 'runtime-session-token',
    fetchImpl: async (url, options) => {
      observed = { url, options };
      return { ok: true, json: async () => ({ state: 'accepted' }) };
    }
  });
  assert.equal(result.state, 'accepted');
  assert.equal(observed.options.method, 'POST');
  assert.equal(observed.options.headers.authorization, 'Bearer runtime-session-token');
  assert.match(observed.options.body, /sync_control/);
});
