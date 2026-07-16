import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CALIBRATION_BLEND_SCHEMA,
  blendCalibratedEstimates,
  calibrateRole,
  createAssignments,
  integrateReports,
  normalizeCalibrationHistories
} from '../core.mjs';

const mission = {
  id: 'calibration-admission',
  objective: 'Rank architecture experiments without rewarding chronic overclaiming.',
  hardware: { device: 'ordinary-local-hardware' },
  budget: { proxy_compute_units: 8 },
  success_metrics: ['held-out capability', 'calibrated information gain'],
  forbidden_defaults: ['No proposal wins from self-reported gain alone.'],
  operator_constraints: ['Training spend requires separate authority.']
};

function proposal(gain, mechanism) {
  return {
    candidate_id: 'shared-candidate',
    family: 'calibrated-family',
    distance: 'adjacent',
    mechanism,
    falsifier: 'Matched held-out evidence does not reproduce the predicted gain.',
    cost: 2,
    expected_information_gain: gain,
    matched_compute_baseline: 'Matched tokens, precision, wall-clock, and seeds.',
    hidden_evaluation: 'Procedurally generated held-out tasks.',
    reproduction_seeds: 3,
    novelty_tags: ['calibration']
  };
}

function report(assignment, gain, mechanism) {
  return {
    assignment_id: assignment.assignment_id,
    role: assignment.role,
    claims: [],
    proposals: [proposal(gain, mechanism)],
    external_resources: [],
    uncertainty: 'Calibration history may be sparse.'
  };
}

const history = (role, observations) => ({
  schema: 'sideways-foundry-calibration/v1',
  role,
  observations
});

test('cold-start roles receive an explicit prior rather than full trust', () => {
  const calibration = calibrateRole('new-role', []);
  assert.equal(calibration.status, 'cold-start-prior');
  assert.equal(calibration.sample_count, 0);
  assert.equal(calibration.calibration_factor, 0.5);
  assert.equal(calibration.weight, 0.2);
  const blend = blendCalibratedEstimates([
    { role: 'new-role', source_assignment_id: 'assignment-new', raw_estimate: 10 }
  ]);
  assert.equal(blend.blended_estimate, 5);
  assert.equal(blend.estimates[0].adjusted_estimate, 5);
});

test('chronic overclaiming is discounted below a grounded role despite a larger raw estimate', () => {
  const histories = [
    history('overclaimer', Array.from({ length: 8 }, () => ({ predicted: 10, realized: 0.5 }))),
    history('grounded', Array.from({ length: 8 }, () => ({ predicted: 4, realized: 4 })))
  ];
  const blend = blendCalibratedEstimates([
    { role: 'overclaimer', source_assignment_id: 'a-over', raw_estimate: 20 },
    { role: 'grounded', source_assignment_id: 'a-grounded', raw_estimate: 8 }
  ], histories);
  const overclaimer = blend.estimates.find(item => item.role === 'overclaimer');
  const grounded = blend.estimates.find(item => item.role === 'grounded');
  assert.ok(overclaimer.calibration_factor < grounded.calibration_factor);
  assert.ok(overclaimer.weight < grounded.weight);
  assert.ok(overclaimer.adjusted_estimate < overclaimer.raw_estimate);
  assert.ok(blend.blended_estimate < 8);
  assert.notEqual(blend.blended_estimate, 20);
});

test('integrated candidates retain every raw estimate and full role-history blend provenance', () => {
  const assignments = createAssignments(mission);
  const selected = [assignments[0], assignments[1]];
  const histories = [
    history(selected[0].role, [
      { predicted: 10, realized: 2, candidate_id: 'prior-a', receipt_digest: 'receipt-a' },
      { predicted: 8, realized: 2, candidate_id: 'prior-b', receipt_digest: 'receipt-b' }
    ]),
    history(selected[1].role, [
      { predicted: 5, realized: 5, candidate_id: 'prior-c', receipt_digest: 'receipt-c' },
      { predicted: 6, realized: 5.5, candidate_id: 'prior-d', receipt_digest: 'receipt-d' }
    ])
  ];
  const integration = integrateReports([
    report(selected[0], 14, 'optimistic mechanism variant'),
    report(selected[1], 7, 'grounded mechanism variant')
  ], assignments, histories);
  const candidate = integration.candidates[0];
  assert.equal(candidate.information_gain_estimates.length, 2);
  assert.deepEqual(candidate.information_gain_estimates.map(item => item.raw_estimate), [14, 7]);
  assert.equal(candidate.information_gain_blend.schema, CALIBRATION_BLEND_SCHEMA);
  assert.equal(candidate.information_gain_blend.estimates.length, 2);
  assert.ok(candidate.information_gain_blend.estimates.every(item => item.history_digest));
  assert.equal(candidate.expected_information_gain, candidate.information_gain_blend.blended_estimate);
  assert.ok(candidate.expected_information_gain < 14);
  assert.match(candidate.information_gain_blend.blend_digest, /^[a-f0-9]{64}$/);
  assert.match(integration.digest, /^[a-f0-9]{64}$/);
});

test('calibration histories are deterministic and fail closed on duplicates, invalid outcomes, and secrets', () => {
  const histories = [history('role-b', [{ predicted: 2, realized: 1 }]), history('role-a', [])];
  assert.deepEqual(normalizeCalibrationHistories(histories).map(item => item.role), ['role-a', 'role-b']);
  assert.throws(() => normalizeCalibrationHistories([
    history('duplicate', []),
    history('duplicate', [])
  ]), /Duplicate calibration history/);
  assert.throws(() => normalizeCalibrationHistories([
    history('bad', [{ predicted: 1, realized: -1 }])
  ]), /finite number/);
  assert.throws(() => normalizeCalibrationHistories([
    { role: 'secret-role', observations: [], api_key: 'forbidden' }
  ]), /Secret-like field/);
});
