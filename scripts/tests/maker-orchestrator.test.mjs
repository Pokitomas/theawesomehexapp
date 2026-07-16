import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  MakerOrchestrator,
  normalizeOrchestrationPlan,
  verifyOrchestrationEvents
} from '../maker-orchestrator.mjs';

const BASE = 'a'.repeat(40);
const HEAD_ONE = 'b'.repeat(40);
const HEAD_TWO = 'c'.repeat(40);
const RECEIPT = 'd'.repeat(64);
const VERIFY_RECEIPT = 'e'.repeat(64);

function fixedClock() {
  let tick = 0;
  return () => `2026-07-16T00:${String(Math.floor(tick / 60)).padStart(2, '0')}:${String(tick++ % 60).padStart(2, '0')}.000Z`;
}

function idFactory() {
  let id = 0;
  return () => `id-${++id}`;
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-orchestrator-root-'));
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-orchestrator-state-'));
  t.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(stateDir, { recursive: true, force: true })
  ]));
  return { root, statePath: path.join(stateDir, 'state.json') };
}

function task(overrides = {}) {
  return {
    task_id: overrides.task_id || 'task-test',
    repository: 'acme/widgets',
    base_sha: BASE,
    branch: 'main',
    goal: 'Implement the exact verified feature.',
    protect: 'Do not merge or deploy.',
    proof: 'All witnesses must pass on the exact head.',
    roles: overrides.roles || [
      { assignment_id: 'architecture', role: 'architecture', question: 'Map the architecture.' },
      { assignment_id: 'security', role: 'security', question: 'Map hostile authority risks.' }
    ],
    budget: {
      max_assignments: 8,
      max_depth: 2,
      max_events: 500,
      max_model_calls: 30,
      max_reported_tokens: 100000,
      max_worker_attempts: 3,
      max_specialist_attempts: 2,
      assessment_concurrency: 2,
      ...overrides.budget
    }
  };
}

function orchestrator(root, statePath) {
  return new MakerOrchestrator({ root, state_path: statePath, clock: fixedClock(), id_factory: idFactory() });
}

function specialistAdapter(overrides = {}) {
  const calls = [];
  return {
    calls,
    async execute(packet) {
      calls.push(packet);
      if (overrides.execute) return overrides.execute(packet, calls.length);
      const assignment = packet.assignment;
      if (assignment.role === 'architecture' && assignment.depth === 0) {
        return {
          findings: [
            { finding_id: 'claim-architecture', kind: 'claim', statement: 'src/core.mjs owns the behavior.', confidence: 0.8, source_paths: ['src/core.mjs'] },
            { finding_id: 'contradiction-cache', kind: 'contradiction', statement: 'Caching may improve latency but weakens exact freshness.', confidence: 0.6, source_paths: ['src/cache.mjs'] }
          ],
          followups: [{ assignment_id: 'performance-followup', role: 'performance', question: 'Measure the cache/freshness tradeoff.', target_ids: ['contradiction-cache'] }],
          usage: { model_calls: 1, tokens_in: 100, tokens_out: 60, wall_ms: 10 }
        };
      }
      if (assignment.role === 'security') {
        return {
          findings: [{ finding_id: 'risk-authority', kind: 'risk', statement: 'Merge authority must remain human.', confidence: 0.99 }],
          usage: { model_calls: 1, tokens_in: 80, tokens_out: 40, wall_ms: 8 }
        };
      }
      return {
        findings: [{ finding_id: 'evidence-performance', kind: 'evidence', statement: 'A bounded cache test can preserve explicit freshness evidence.', confidence: 0.7, contradicts: ['contradiction-cache'], source_paths: ['test/cache.test.mjs'] }],
        usage: { model_calls: 1, tokens_in: 70, tokens_out: 50, wall_ms: 7 }
      };
    }
  };
}

function plannerAdapter(overrides = {}) {
  const calls = [];
  return {
    calls,
    async execute(packet) {
      calls.push(packet);
      if (overrides.execute) return overrides.execute(packet, calls.length);
      return {
        summary: 'Change core code, then documentation.',
        preserved_contradictions: ['contradiction-cache'],
        created_from_finding_ids: packet.findings.map(value => value.finding_id),
        lanes: [
          { lane_id: 'code', title: 'Code', request: 'Implement the bounded core change.', proof: 'Unit tests.', owned_paths: ['src/**'] },
          { lane_id: 'docs', title: 'Docs', request: 'Document the verified behavior.', proof: 'Documentation test.', owned_paths: ['docs/**'], depends_on: ['code'] }
        ],
        usage: { model_calls: 1, tokens_in: 200, tokens_out: 100, wall_ms: 12 }
      };
    }
  };
}

function workerAdapter(overrides = {}) {
  const calls = [];
  return {
    calls,
    async execute(packet) {
      calls.push(packet);
      if (overrides.execute) return overrides.execute(packet, calls.length);
      if (packet.lane.lane_id === 'code' && packet.attempt === 1) {
        return { status: 'failed', repository: 'acme/widgets', base_sha: BASE, branch: 'maker/code', failure: 'first test failed', usage: { model_calls: 1, tokens_in: 120, tokens_out: 40, wall_ms: 11 } };
      }
      const code = packet.lane.lane_id === 'code';
      return {
        status: 'finished',
        repository: 'acme/widgets',
        base_sha: BASE,
        branch: code ? 'maker/code' : 'maker/docs',
        head_sha: code ? HEAD_ONE : HEAD_TWO,
        changed_paths: code ? ['src/core.mjs', 'src/cache.mjs'] : ['docs/feature.md'],
        witnesses: [{ name: code ? 'unit' : 'docs', ok: true, evidence: 'passed' }],
        summary: code ? 'Implemented code.' : 'Updated docs.',
        receipt_digest: RECEIPT,
        usage: { model_calls: 1, tokens_in: 120, tokens_out: 60, wall_ms: 10 }
      };
    }
  };
}

function verifierAdapter(overrides = {}) {
  const calls = [];
  return {
    calls,
    async execute(packet) {
      calls.push(packet);
      if (overrides.execute) return overrides.execute(packet, calls.length);
      return {
        ok: true,
        exact_head_sha: HEAD_TWO,
        witnesses: [
          { name: 'repository verification', ok: true, evidence: 'run:1' },
          { name: 'diff inspection', ok: true, evidence: 'receipt:1' }
        ],
        risks: ['Merge and deploy remain human-only.'],
        receipt_digest: VERIFY_RECEIPT,
        usage: { model_calls: 1, tokens_in: 100, tokens_out: 30, wall_ms: 5 }
      };
    }
  };
}

test('plan normalization rejects collisions, cycles, unknown dependencies, and executable lanes without leases', () => {
  assert.throws(() => normalizeOrchestrationPlan({ lanes: [
    { lane_id: 'one', request: 'one', owned_paths: ['src/**'] },
    { lane_id: 'two', request: 'two', owned_paths: ['src/a.js'] }
  ] }, { base_sha: BASE, branch: 'main' }), /path collision/);
  assert.throws(() => normalizeOrchestrationPlan({ lanes: [
    { lane_id: 'one', request: 'one', owned_paths: ['a/**'], depends_on: ['two'] },
    { lane_id: 'two', request: 'two', owned_paths: ['b/**'], depends_on: ['one'] }
  ] }, { base_sha: BASE, branch: 'main' }), /dependency cycle/);
  assert.throws(() => normalizeOrchestrationPlan({ lanes: [
    { lane_id: 'one', request: 'one', owned_paths: ['a/**'], depends_on: ['missing'] }
  ] }, { base_sha: BASE, branch: 'main' }), /unknown lane/);
  assert.throws(() => normalizeOrchestrationPlan({ lanes: [
    { lane_id: 'one', request: 'one', owned_paths: [] }
  ] }, { base_sha: BASE, branch: 'main' }), /requires owned paths/);
});

test('full orchestration recursively assesses, preserves contradictions, retries workers, and stops ready for a human', async t => {
  const { root, statePath } = await fixture(t);
  const maker = orchestrator(root, statePath);
  const specialists = specialistAdapter();
  const planner = plannerAdapter();
  const workers = workerAdapter();
  const verifier = verifierAdapter();
  const receipt = await maker.run({ task: task(), specialist_adapter: specialists, planner_adapter: planner, worker_adapter: workers, verifier_adapter: verifier });
  assert.equal(receipt.status, 'ready_for_human');
  assert.equal(receipt.assessment.assignments.length, 3);
  assert.equal(receipt.assessment.finding_count, 4);
  assert.ok(receipt.assessment.contradiction_ids.includes('contradiction-cache'));
  assert.ok(receipt.plan.preserved_contradictions.includes('contradiction-cache'));
  assert.deepEqual(receipt.plan.lanes.map(value => value.lane_id), ['code', 'docs']);
  assert.equal(receipt.lanes.find(value => value.lane.lane_id === 'code').attempts, 2);
  assert.equal(receipt.lanes.find(value => value.lane.lane_id === 'docs').attempts, 1);
  assert.equal(receipt.verification.exact_head_sha, HEAD_TWO);
  assert.equal(receipt.authority.merge, 'human');
  assert.equal(receipt.authority.deploy, 'human');
  assert.match(receipt.receipt_digest, /^[0-9a-f]{64}$/);
  assert.match(receipt.event_terminal_digest, /^[0-9a-f]{64}$/);
  assert.equal(planner.calls.length, 1);
  assert.equal(workers.calls.length, 3);
  assert.ok(receipt.usage.model_calls >= 8);
  assert.equal(receipt.usage.unreported_calls, 0);
});

test('read-only specialist packets cannot write, run, merge, deploy, or access network', async t => {
  const { root, statePath } = await fixture(t);
  const packets = [];
  const specialist = specialistAdapter({ execute: async packet => {
    packets.push(packet);
    return { findings: [{ kind: 'claim', statement: 'Observed only.' }], usage: { model_calls: 1, tokens_in: 1, tokens_out: 1 } };
  } });
  const maker = orchestrator(root, statePath);
  await maker.create(task({ roles: [{ role: 'observer', question: 'Observe.' }] }));
  await maker.assess(specialist);
  assert.equal(packets.length, 1);
  assert.deepEqual(packets[0].authority, { write: false, command: false, network: false, merge: false, deploy: false });
});

test('specialist failures retry to the configured ceiling and preserve negative evidence', async t => {
  const { root, statePath } = await fixture(t);
  let attempts = 0;
  const specialist = specialistAdapter({ execute: async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('temporary provider failure');
    return { findings: [{ kind: 'negative_result', statement: 'First provider call failed and the retry succeeded.' }], usage: { model_calls: 1, tokens_in: 1, tokens_out: 1 } };
  } });
  const maker = orchestrator(root, statePath);
  await maker.create(task({ roles: [{ assignment_id: 'retry', role: 'retry', question: 'Retry once.' }], budget: { max_specialist_attempts: 2, assessment_concurrency: 1 } }));
  await maker.assess(specialist);
  const snapshot = maker.snapshot();
  assert.equal(attempts, 2);
  assert.equal(snapshot.assignments[0].attempts, 2);
  assert.equal(snapshot.assignments[0].status, 'completed');
  assert.ok(snapshot.events.some(value => value.type === 'assessment.assignment.failed' && value.payload.retrying === true));
});

test('specialist retry exhaustion blocks synthesis rather than pretending assessment completed', async t => {
  const { root, statePath } = await fixture(t);
  const maker = orchestrator(root, statePath);
  await maker.create(task({ roles: [{ assignment_id: 'always-fail', role: 'failure', question: 'Fail.' }], budget: { max_specialist_attempts: 2, assessment_concurrency: 1 } }));
  await assert.rejects(maker.assess({ execute: async () => { throw new Error('provider unavailable'); } }), /Assessment failed/);
  assert.equal(maker.snapshot().status, 'assessment_failed');
  assert.equal(maker.snapshot().assignments[0].attempts, 2);
  await assert.rejects(maker.synthesize(plannerAdapter()), /not ready/);
});

test('reported budgets are observed and block only after the inclusive ceiling is exceeded', async t => {
  const { root, statePath } = await fixture(t);
  const maker = orchestrator(root, statePath);
  await maker.create(task({ roles: [
    { assignment_id: 'one', role: 'one', question: 'One.' },
    { assignment_id: 'two', role: 'two', question: 'Two.' }
  ], budget: { max_model_calls: 1, assessment_concurrency: 1, max_specialist_attempts: 1 } }));
  const specialist = { execute: async () => ({ findings: [{ kind: 'claim', statement: 'finding' }], usage: { model_calls: 1, tokens_in: 1, tokens_out: 1 } }) };
  await assert.rejects(maker.assess(specialist), /model-call budget exhausted/);
  assert.equal(maker.snapshot().status, 'blocked');
  assert.equal(maker.snapshot().usage.model_calls, 2);
  assert.ok(maker.snapshot().events.some(value => value.type === 'budget.exhausted'));
});

test('missing token accounting is explicit rather than fabricated', async t => {
  const { root, statePath } = await fixture(t);
  const maker = orchestrator(root, statePath);
  await maker.create(task({ roles: [{ assignment_id: 'one', role: 'one', question: 'One.' }] }));
  await maker.assess({ execute: async () => ({ findings: [{ kind: 'claim', statement: 'finding' }] }) });
  assert.equal(maker.snapshot().usage.model_calls, 1);
  assert.equal(maker.snapshot().usage.tokens_in, 0);
  assert.equal(maker.snapshot().usage.tokens_out, 0);
  assert.equal(maker.snapshot().usage.unreported_calls, 1);
});

test('state path must remain outside the checkout and existing state requires resume', async t => {
  const { root, statePath } = await fixture(t);
  assert.throws(() => new MakerOrchestrator({ root, state_path: path.join(root, '.maker-state.json') }), /outside the repository checkout/);
  const maker = orchestrator(root, statePath);
  await maker.create(task());
  const duplicate = orchestrator(root, statePath);
  await assert.rejects(duplicate.create(task()), /already exists/);
});

test('pause and durable resume preserve event history and prevent dispatch while paused', async t => {
  const { root, statePath } = await fixture(t);
  const first = orchestrator(root, statePath);
  await first.create(task({ roles: [{ assignment_id: 'one', role: 'one', question: 'One.' }] }));
  await first.pause('operator inspection');
  await assert.rejects(first.assess(specialistAdapter()), /paused/);
  const second = orchestrator(root, statePath);
  await second.resume();
  assert.equal(second.snapshot().paused, true);
  await second.unpause('kai');
  await second.assess({ execute: async () => ({ findings: [{ kind: 'claim', statement: 'resumed' }], usage: { model_calls: 1, tokens_in: 1, tokens_out: 1 } }) });
  assert.equal(second.snapshot().status, 'synthesizing');
  verifyOrchestrationEvents(second.snapshot().events);
});

test('tampered durable events are rejected before resume', async t => {
  const { root, statePath } = await fixture(t);
  const maker = orchestrator(root, statePath);
  await maker.create(task());
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  state.events[0].payload.task.goal = 'tampered goal';
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const resumed = orchestrator(root, statePath);
  await assert.rejects(resumed.resume(), /digest mismatch/);
});

test('synthesis runs exactly once and may not drop a specialist contradiction', async t => {
  const { root, statePath } = await fixture(t);
  const maker = orchestrator(root, statePath);
  await maker.create(task());
  await maker.assess(specialistAdapter());
  const badPlanner = plannerAdapter({ execute: async packet => ({
    lanes: [{ lane_id: 'code', request: 'code', owned_paths: ['src/**'] }],
    preserved_contradictions: [],
    created_from_finding_ids: packet.findings.map(value => value.finding_id),
    usage: { model_calls: 1, tokens_in: 1, tokens_out: 1 }
  }) });
  await assert.rejects(maker.synthesize(badPlanner), /dropped contradiction/);
  assert.equal(maker.snapshot().synthesis_count, 0);
  const good = plannerAdapter();
  const plan = await maker.synthesize(good);
  assert.equal(plan.plan_digest, (await maker.synthesize({ execute: async () => { throw new Error('must not rerun'); } })).plan_digest);
  assert.equal(good.calls.length, 1);
});

test('workers cannot claim unleased paths, missing witnesses, stale identity, or evidence-free completion', async t => {
  for (const variant of ['unleased', 'witness', 'identity', 'receipt']) {
    const { root, statePath } = await fixture(t);
    const maker = orchestrator(root, statePath);
    await maker.create(task({ roles: [{ assignment_id: 'one', role: 'one', question: 'One.' }], budget: { max_worker_attempts: 1 } }));
    await maker.assess({ execute: async () => ({ findings: [{ kind: 'claim', statement: 'ready' }], usage: { model_calls: 1, tokens_in: 1, tokens_out: 1 } }) });
    await maker.synthesize({ execute: async packet => ({ lanes: [{ lane_id: 'code', request: 'code', owned_paths: ['src/**'] }], created_from_finding_ids: packet.findings.map(value => value.finding_id), usage: { model_calls: 1, tokens_in: 1, tokens_out: 1 } }) });
    const adapter = { execute: async () => ({
      status: 'finished',
      repository: variant === 'identity' ? 'evil/repo' : 'acme/widgets',
      base_sha: BASE,
      branch: 'maker/code',
      head_sha: HEAD_ONE,
      changed_paths: variant === 'unleased' ? ['README.md'] : ['src/a.js'],
      witnesses: variant === 'witness' ? [] : [{ name: 'test', ok: true }],
      receipt_digest: variant === 'receipt' ? null : RECEIPT,
      usage: { model_calls: 1, tokens_in: 1, tokens_out: 1 }
    }) };
    await assert.rejects(maker.execute(adapter), /exhausted retries/);
    assert.equal(maker.snapshot().status, 'blocked');
  }
});

test('human-gated lanes do not execute until exact approval is recorded', async t => {
  const { root, statePath } = await fixture(t);
  const maker = orchestrator(root, statePath);
  await maker.create(task({ roles: [{ assignment_id: 'one', role: 'one', question: 'One.' }] }));
  await maker.assess({ execute: async () => ({ findings: [{ kind: 'claim', statement: 'ready' }], usage: { model_calls: 1, tokens_in: 1, tokens_out: 1 } }) });
  await maker.synthesize({ execute: async packet => ({
    lanes: [
      { lane_id: 'approval', request: 'Approve production release boundary.', human_gate: true, gate_kind: 'release-approval' },
      { lane_id: 'code', request: 'Implement code.', owned_paths: ['src/**'], depends_on: ['approval'] }
    ],
    created_from_finding_ids: packet.findings.map(value => value.finding_id),
    usage: { model_calls: 1, tokens_in: 1, tokens_out: 1 }
  }) });
  const worker = workerAdapter({ execute: async packet => ({ status: 'finished', repository: 'acme/widgets', base_sha: BASE, branch: 'maker/code', head_sha: HEAD_ONE, changed_paths: ['src/a.js'], witnesses: [{ name: 'test', ok: true }], receipt_digest: RECEIPT, usage: { model_calls: 1, tokens_in: 1, tokens_out: 1 } }) });
  await maker.execute(worker);
  assert.equal(maker.snapshot().status, 'awaiting_human');
  assert.equal(worker.calls.length, 0);
  await assert.rejects(maker.approveHumanGate({ lane_id: 'approval', approved: false, actor: 'kai' }), /denied/);
});

test('approved human gates resume execution but do not grant merge or deploy authority', async t => {
  const { root, statePath } = await fixture(t);
  const maker = orchestrator(root, statePath);
  await maker.create(task({ roles: [{ assignment_id: 'one', role: 'one', question: 'One.' }] }));
  await maker.assess({ execute: async () => ({ findings: [{ kind: 'claim', statement: 'ready' }], usage: { model_calls: 1, tokens_in: 1, tokens_out: 1 } }) });
  await maker.synthesize({ execute: async packet => ({
    lanes: [
      { lane_id: 'approval', request: 'Approve bounded continuation.', human_gate: true, gate_kind: 'continuation' },
      { lane_id: 'code', request: 'Implement code.', owned_paths: ['src/**'], depends_on: ['approval'] }
    ],
    created_from_finding_ids: packet.findings.map(value => value.finding_id),
    usage: { model_calls: 1, tokens_in: 1, tokens_out: 1 }
  }) });
  await maker.execute(workerAdapter());
  await maker.approveHumanGate({ lane_id: 'approval', approved: true, actor: 'kai', evidence: 'explicit button' });
  const worker = workerAdapter({ execute: async () => ({ status: 'finished', repository: 'acme/widgets', base_sha: BASE, branch: 'maker/code', head_sha: HEAD_ONE, changed_paths: ['src/a.js'], witnesses: [{ name: 'test', ok: true }], receipt_digest: RECEIPT, usage: { model_calls: 1, tokens_in: 1, tokens_out: 1 } }) });
  await maker.execute(worker);
  assert.equal(maker.snapshot().status, 'verifying');
  const receipt = await maker.verify(verifierAdapter({ execute: async () => ({ ok: true, exact_head_sha: HEAD_ONE, witnesses: [{ name: 'verify', ok: true }], receipt_digest: VERIFY_RECEIPT, usage: { model_calls: 1, tokens_in: 1, tokens_out: 1 } }) }));
  assert.equal(receipt.authority.merge, 'human');
  assert.equal(receipt.authority.deploy, 'human');
});

test('verifier must name the actual final worker head and passing exact evidence', async t => {
  const { root, statePath } = await fixture(t);
  const maker = orchestrator(root, statePath);
  await maker.create(task({ roles: [{ assignment_id: 'one', role: 'one', question: 'One.' }] }));
  await maker.assess({ execute: async () => ({ findings: [{ kind: 'claim', statement: 'ready' }], usage: { model_calls: 1, tokens_in: 1, tokens_out: 1 } }) });
  await maker.synthesize({ execute: async packet => ({ lanes: [{ lane_id: 'code', request: 'code', owned_paths: ['src/**'] }], created_from_finding_ids: packet.findings.map(value => value.finding_id), usage: { model_calls: 1, tokens_in: 1, tokens_out: 1 } }) });
  await maker.execute({ execute: async () => ({ status: 'finished', repository: 'acme/widgets', base_sha: BASE, branch: 'maker/code', head_sha: HEAD_ONE, changed_paths: ['src/a.js'], witnesses: [{ name: 'test', ok: true }], receipt_digest: RECEIPT, usage: { model_calls: 1, tokens_in: 1, tokens_out: 1 } }) });
  await assert.rejects(maker.verify(verifierAdapter({ execute: async () => ({ ok: true, exact_head_sha: HEAD_TWO, witnesses: [{ name: 'verify', ok: true }], receipt_digest: VERIFY_RECEIPT, usage: { model_calls: 1, tokens_in: 1, tokens_out: 1 } }) })), /did not produce exact passing evidence/);
  assert.equal(maker.snapshot().status, 'blocked');
});

test('cancellation is durable, redacted, and terminal', async t => {
  const { root, statePath } = await fixture(t);
  const maker = orchestrator(root, statePath);
  await maker.create(task());
  const token = 'github_pat_123456789012345678901234567890';
  const receipt = await maker.cancel(`stop Bearer ${token}`);
  assert.equal(receipt.status, 'cancelled');
  assert.match(receipt.cancel_reason, /\[REDACTED:/);
  assert.ok(!JSON.stringify(receipt).includes(token));
  await assert.rejects(maker.assess(specialistAdapter()), /terminal/);
});
