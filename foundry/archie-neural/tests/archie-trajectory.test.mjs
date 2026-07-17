import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  assessTrajectoryAdmission,
  createTrajectoryBatch,
  normalizeArchieTrajectory,
  trajectoryFromMakerReceipt
} from '../archie-trajectory.mjs';

const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const git = value => sha(value).slice(0, 40);

function admittedTrajectory(overrides = {}) {
  const request = 'Update one file and run its focused test.';
  return normalizeArchieTrajectory({
    subject: 'fixture',
    request,
    provenance: {
      repository: 'Pokitomas/fixture',
      branch: 'archie-neural-contracts',
      base_sha: git('base'),
      head_sha: git('head'),
      code_commit: git('head'),
      request_digest: sha(request),
      plan_digest: sha('plan'),
      patch_digest: sha('patch'),
      authority_digest: sha('authority'),
      environment_digest: sha('environment')
    },
    events: [
      { sequence: 1, type: 'request', payload: { text: request } },
      { sequence: 2, type: 'plan', payload: { steps: ['edit', 'test'] } },
      { sequence: 3, type: 'verification', payload: { verifier: 'focused-test', status: 'passed' } },
      { sequence: 4, type: 'outcome', payload: { status: 'completed' } }
    ],
    verification: [{
      verifier: 'independent-test-runner',
      status: 'passed',
      independent: true,
      evidence_digest: sha('verification')
    }],
    outcome: { status: 'completed', summary: 'focused test passed' },
    labels: ['accepted'],
    ...overrides
  });
}

test('positive trajectory is admitted only with exact independent evidence', () => {
  const trajectory = admittedTrajectory();
  const admission = assessTrajectoryAdmission(trajectory);
  assert.equal(admission.disposition, 'admitted-positive');
  assert.equal(admission.positive, true);
  assert.deepEqual(admission.reasons, []);
});

test('completed trajectory without patch evidence is rejected', () => {
  const trajectory = admittedTrajectory({
    provenance: {
      repository: 'Pokitomas/fixture',
      branch: 'archie-neural-contracts',
      base_sha: git('base'),
      head_sha: git('head'),
      request_digest: sha('Update one file and run its focused test.')
    }
  });
  const admission = assessTrajectoryAdmission(trajectory);
  assert.equal(admission.admitted, false);
  assert.ok(admission.reasons.includes('completed-without-patch-digest'));
});

test('failed work is retained as negative knowledge when verification evidence is present', () => {
  const trajectory = admittedTrajectory({
    outcome: { status: 'failed', summary: 'injected tool failure', negative: true }
  });
  const admission = assessTrajectoryAdmission(trajectory);
  assert.equal(admission.disposition, 'admitted-negative');
  assert.equal(admission.negative, true);
});

test('request bytes are bound to provenance digest', () => {
  const value = admittedTrajectory();
  assert.throws(() => normalizeArchieTrajectory({ ...value, request: 'tampered request' }), /request_digest/);
});

test('Maker receipts compile into ordered provenance-bound trajectories', () => {
  const request = 'Create a deterministic fixture.';
  const trajectory = trajectoryFromMakerReceipt({
    repository: 'Pokitomas/fixture',
    branch: 'main',
    request,
    base_sha: git('base'),
    head_sha: git('head'),
    patch_digest: sha('patch'),
    plan: { steps: [{ tool: 'files', action: 'write' }] },
    verification: ['node --test passed'],
    state: 'completed',
    writer_summary: 'created fixture'
  }, { recorded_at: '2026-07-17T00:00:00Z' });
  assert.equal(trajectory.provenance.request_digest, sha(request));
  assert.equal(trajectory.outcome.status, 'completed');
  assert.ok(trajectory.events.some(item => item.type === 'plan'));
  assert.equal(assessTrajectoryAdmission(trajectory).positive, true);
});

test('trajectory batches preserve admitted positives, negatives, and rejected receipts', () => {
  const positive = admittedTrajectory();
  const negative = admittedTrajectory({ outcome: { status: 'failed', negative: true } });
  const rejected = admittedTrajectory({ verification: [] });
  const batch = createTrajectoryBatch([positive, negative, rejected]);
  assert.deepEqual(batch.counts, { submitted: 3, admitted: 2, positive: 1, negative: 1, rejected: 1 });
  assert.equal(batch.trajectories.length, 2);
});
