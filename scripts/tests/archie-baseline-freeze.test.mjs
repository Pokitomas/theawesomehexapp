import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { ARCHIE_BASELINE_RECEIPT_SCHEMA, buildArchieBaselineReceipt } from '../archie-baseline-freeze.mjs';

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

function fixture() {
  const suite = {
    schema: 'archie-equivalence-suite/v1',
    suite_id: 'baseline-fixture',
    training: [],
    episodes: [
      { id: 'local', class: 'composition', instruction: 'Do it.', expected_state: 'local', reference_actions: ['node:test'] },
      { id: 'teacher', class: 'novelty', instruction: 'Unknown.', expected_state: 'teacher', reference_actions: ['clarification:request'] },
      { id: 'reject', class: 'safety', instruction: 'Deploy.', expected_state: 'reject', reference_actions: [] }
    ]
  };
  const equivalence = {
    schema: 'archie-equivalence-report/v1',
    suite_id: suite.suite_id,
    suite_digest: digest(suite),
    report_digest: 'a'.repeat(64),
    metrics: { task_success_rate: 1, action_contract_pass_rate: 1 },
    performance: { latency_p50_ms: 1, latency_p95_ms: 2 },
    episodes: [
      { episode_id: 'local', expected_state: 'local', observed_state: 'local', success: true },
      { episode_id: 'teacher', expected_state: 'teacher', observed_state: 'teacher', teacher_called: true, success: true },
      { episode_id: 'reject', expected_state: 'reject', observed_state: 'reject', success: true }
    ]
  };
  const derivation = {
    schema: 'archie-derivation-benchmark-report/v1',
    report_digest: 'b'.repeat(64),
    metrics: { total_success_rate: 1, proof_integrity_rate: 1 },
    performance: { latency_p50_ms: 0.1, latency_p95_ms: 0.2 },
    episodes: [
      { episode_id: 'compose', category: 'composition', success: true },
      { episode_id: 'transfer', category: 'adapter-transfer', success: true }
    ]
  };
  return { suite, equivalence, derivation };
}

test('freezes exact-head route-separated baseline receipts without upgrading unmeasured routes', () => {
  const values = fixture();
  const receipt = buildArchieBaselineReceipt({
    repository_sha: '1'.repeat(40),
    ...values,
    generated_at: '2026-07-18T05:00:00.000Z',
    environment: { platform: 'test', architecture: 'fixture', node: 'v20' }
  });
  assert.equal(receipt.schema, ARCHIE_BASELINE_RECEIPT_SCHEMA);
  assert.equal(receipt.routes.current_archie.status, 'measured-controlled-substitution');
  assert.equal(receipt.routes.derived_composed_planning.status, 'measured-deterministic-local');
  assert.equal(receipt.routes.frontier_escalation.status, 'controlled-fixture-only');
  assert.equal(receipt.routes.retrieval_only_recall.status, 'unmeasured');
  assert.equal(receipt.routes.local_model_inference.status, 'unmeasured');
  assert.deepEqual(receipt.routes.abstention_and_failure.rejection_task_ids, ['reject']);
  assert.equal(receipt.evidence.exact_reference_diagnostic_only, true);
  assert.match(receipt.receipt_digest, /^[a-f0-9]{64}$/);
  const repeated = buildArchieBaselineReceipt({
    repository_sha: '1'.repeat(40),
    ...values,
    generated_at: '2026-07-18T05:00:00.000Z',
    environment: { platform: 'test', architecture: 'fixture', node: 'v20' }
  });
  assert.equal(repeated.receipt_digest, receipt.receipt_digest);
});

test('rejects a benchmark report that is not bound to the frozen suite', () => {
  const values = fixture();
  values.equivalence.suite_digest = 'f'.repeat(64);
  assert.throws(() => buildArchieBaselineReceipt({
    repository_sha: '1'.repeat(40),
    ...values,
    generated_at: '2026-07-18T05:00:00.000Z'
  }), /suite digest does not match/);
});

test('rejects non-exact repository identities', () => {
  const values = fixture();
  assert.throws(() => buildArchieBaselineReceipt({
    repository_sha: 'main',
    ...values,
    generated_at: '2026-07-18T05:00:00.000Z'
  }), /40-character Git commit SHA/);
});
