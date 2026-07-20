import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertAdmittedLaneLeaseCompletion
} from '../maker-executive-admission-completion.mjs';
import {
  buildAdmittedMutationReceipt
} from '../maker-executive-admission.mjs';

const MAIN = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const D1 = '1'.repeat(64);
const D2 = '2'.repeat(64);
const D3 = '3'.repeat(64);
const D4 = '4'.repeat(64);
const D5 = '5'.repeat(64);

test('completes a lane through its distinct writer lease identity', () => {
  const receipt = buildAdmittedMutationReceipt({
    repository: 'owner/repo', source_sha: MAIN, result_sha: HEAD,
    snapshot_digest: D1, lease_id: 'lease-writer-1', plan_digest: D2,
    authority_manifest_digest: D3,
    changed_scopes: [{ kind: 'repository', id: 'scripts/one/file.mjs' }],
    commands: [{ command: 'node --test' }], produced_artifacts: [],
    verification: { ok: true, verification_digest: D4 },
    rollback_target_sha: MAIN
  });
  const result = assertAdmittedLaneLeaseCompletion({
    lane: {
      id: 'lane-train-1', lease_id: 'lease-writer-1', source_sha: MAIN,
      required_evidence: ['tests', 'receipt']
    },
    mutation_receipt: receipt,
    evidence: [{ type: 'tests' }, { type: 'receipt' }],
    terminal_observed: true,
    terminal_evidence_digest: D5
  });
  assert.equal(result.lane_id, 'lane-train-1');
  assert.equal(result.lease_id, 'lease-writer-1');
  assert.equal(result.status, 'completed');
});

test('rejects a receipt from another writer lease', () => {
  const receipt = buildAdmittedMutationReceipt({
    repository: 'owner/repo', source_sha: MAIN, result_sha: HEAD,
    snapshot_digest: D1, lease_id: 'lease-other', plan_digest: D2,
    authority_manifest_digest: D3,
    changed_scopes: [{ kind: 'repository', id: 'scripts/one/file.mjs' }],
    commands: [{ command: 'node --test' }], produced_artifacts: [],
    verification: { ok: true, verification_digest: D4 },
    rollback_target_sha: MAIN
  });
  assert.throws(() => assertAdmittedLaneLeaseCompletion({
    lane: { id: 'lane-train-1', lease_id: 'lease-writer-1', source_sha: MAIN },
    mutation_receipt: receipt,
    terminal_observed: true,
    terminal_evidence_digest: D5
  }), /writer lease/);
});
