import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildExperimentPortfolio,
  createAssignments,
  integrateReports
} from '../core.mjs';

const mission = {
  id: 'cost-calibration-admission',
  objective: 'Rank architecture experiments without rewarding optimistic cost claims.',
  hardware: { device: 'ordinary-local-hardware' },
  budget: { proxy_compute_units: 8 },
  success_metrics: ['held-out capability', 'calibrated information per cost'],
  forbidden_defaults: ['No proposal wins from a low self-reported cost alone.'],
  operator_constraints: ['Training spend requires separate authority.']
};

function proposal({ cost, gain = 4, mechanism = 'cost-calibrated mechanism' }) {
  return {
    candidate_id: 'shared-candidate',
    family: 'calibrated-family',
    distance: 'adjacent',
    mechanism,
    falsifier: 'Matched execution costs do not reproduce the predicted cost.',
    cost,
    expected_information_gain: gain,
    matched_compute_baseline: 'Matched tokens, precision, wall-clock, and seeds.',
    hidden_evaluation: 'Procedurally generated held-out tasks.',
    reproduction_seeds: 3,
    novelty_tags: ['cost-calibration']
  };
}

function report(assignment, options) {
  return {
    assignment_id: assignment.assignment_id,
    role: assignment.role,
    claims: [],
    proposals: [proposal(options)],
    external_resources: [],
    uncertainty: 'Cost history may be sparse.'
  };
}

function history(role, costObservations) {
  return {
    schema: 'sideways-foundry-calibration/v1',
    role,
    observations: [],
    cost_observations: costObservations
  };
}

test('cold-start cost claims receive conservative provisional trust', () => {
  const [assignment] = createAssignments(mission);
  const integration = integrateReports([
    report(assignment, { cost: 2 })
  ], [assignment]);
  const candidate = integration.candidates[0];

  assert.deepEqual(candidate.cost_estimates.map(item => item.raw_estimate), [2]);
  assert.equal(candidate.cost_blend.estimate_space, 'inverse-cost');
  assert.equal(candidate.cost_blend.inverse_cost_blend.estimates[0].calibration_status, 'cold-start-prior');
  assert.equal(candidate.cost, 4);
  assert.equal(candidate.cost, candidate.cost_blend.blended_cost);

  const portfolio = buildExperimentPortfolio(integration, { budget: 4, require_strata: false });
  assert.equal(portfolio.selected.length, 1);
  assert.equal(portfolio.spent, 4);
  assert.equal(portfolio.selected[0].estimated_cost, 4);
  assert.equal(portfolio.selected[0].information_per_cost, candidate.expected_information_gain / candidate.cost);
});

test('a chronic cost lowballer cannot win through Math.min and calibrated cost controls the budget', () => {
  const assignments = createAssignments(mission).slice(0, 2);
  const histories = [
    history(assignments[0].role, Array.from({ length: 8 }, () => ({ predicted_cost: 1, realized_cost: 8 }))),
    history(assignments[1].role, Array.from({ length: 8 }, () => ({ predicted_cost: 4, realized_cost: 4 })))
  ];
  const integration = integrateReports([
    report(assignments[0], { cost: 1, gain: 8, mechanism: 'optimistic low-cost variant' }),
    report(assignments[1], { cost: 4, gain: 8, mechanism: 'grounded cost variant' })
  ], assignments, histories);
  const candidate = integration.candidates[0];

  assert.deepEqual(candidate.cost_estimates.map(item => item.raw_estimate), [1, 4]);
  assert.ok(candidate.cost > 4);
  assert.notEqual(candidate.cost, 1);
  assert.equal(candidate.cost_blend.inverse_cost_blend.estimates.length, 2);
  assert.ok(candidate.cost_blend.inverse_cost_blend.estimates.every(item => item.calibration_status === 'history-calibrated'));

  const insufficient = buildExperimentPortfolio(integration, { budget: 4, require_strata: false });
  assert.equal(insufficient.selected.length, 0);
  assert.equal(insufficient.spent, 0);
  assert.deepEqual(insufficient.deferred, [{ candidate_id: 'shared-candidate', reason: 'budget-or-priority' }]);

  const sufficient = buildExperimentPortfolio(integration, { budget: 5, require_strata: false });
  assert.equal(sufficient.selected.length, 1);
  assert.equal(sufficient.selected[0].estimated_cost, candidate.cost);
  assert.equal(sufficient.selected[0].information_per_cost, candidate.expected_information_gain / candidate.cost);
  assert.ok(sufficient.spent > 4 && sufficient.spent <= 5);
});
