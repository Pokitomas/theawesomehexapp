import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ROLE_SPECS,
  buildExperimentPortfolio,
  createAssignments,
  createReceipt,
  evaluateAdmission,
  integrateReports,
  paretoFront,
  validateCandidateGenome,
  validateReport
} from '../core.mjs';

const mission = {
  id: 'paradox-search',
  objective: 'Discover a native model or learning mechanism that improves broad capability while reducing active resource use.',
  hardware: { device: 'ordinary-local-hardware', memory_gb: 24 },
  budget: { proxy_compute_units: 12 },
  success_metrics: ['broad capability', 'active memory traffic', 'calibration'],
  forbidden_defaults: ['Do not preselect Transformer, Mamba, MoE, or conventional distillation as the answer.'],
  operator_constraints: ['No external installation without an explicit experiment and human approval.']
};

function proposal(candidate_id, distance, cost, gain, overrides = {}) {
  return {
    candidate_id,
    family: `${candidate_id}-family`,
    distance,
    mechanism: `Mechanism for ${candidate_id}`,
    falsifier: `Matched proxy result fails for ${candidate_id}`,
    cost,
    expected_information_gain: gain,
    matched_compute_baseline: 'Dense recurrent baseline under identical tokens, precision, and wall-clock cap.',
    hidden_evaluation: 'Procedurally generated held-out tasks unavailable to proposing agents.',
    reproduction_seeds: 3,
    novelty_tags: [distance],
    ...overrides
  };
}

function reportFor(assignment, { claims = [], proposals = [], external_resources = [] } = {}) {
  return {
    assignment_id: assignment.assignment_id,
    role: assignment.role,
    claims,
    proposals,
    external_resources,
    uncertainty: 'Proxy effects may not survive scale.'
  };
}

test('creates ten exact read-only research roles without architecture precommitment', () => {
  const assignments = createAssignments(mission);
  assert.equal(assignments.length, 10);
  assert.equal(assignments.length, ROLE_SPECS.length);
  assert.equal(new Set(assignments.map(item => item.role)).size, 10);
  assert.ok(assignments.every(item => item.read_only));
  assert.ok(assignments.every(item => item.constraints.no_architecture_precommitment));
  assert.ok(assignments.some(item => item.role === 'architecture-heretic'));
  assert.ok(assignments.some(item => item.role === 'benchmark-saboteur'));
});

test('read-only report validation rejects mutation claims and secret-like fields', () => {
  const [assignment] = createAssignments(mission);
  assert.throws(() => validateReport({
    assignment_id: assignment.assignment_id,
    role: assignment.role,
    mutations: ['installed dependency']
  }, [assignment]), /may not contain mutations/);
  assert.throws(() => validateReport({
    assignment_id: assignment.assignment_id,
    role: assignment.role,
    api_key: 'nope'
  }, [assignment]), /Secret-like field/);
});

test('integration preserves contradictions instead of averaging them away', () => {
  const assignments = createAssignments(mission);
  const reports = [
    reportFor(assignments[0], {
      claims: [{ id: 'claim-a', statement: 'Compressed recurrent state preserves exact retrieval.', confidence: 0.6, evidence: ['proxy-a'], contradicts: ['claim-b'], hypothesis_id: 'h-memory', status: 'inferred' }],
      proposals: [proposal('candidate-a', 'adjacent', 2, 5)]
    }),
    reportFor(assignments[4], {
      claims: [{ id: 'claim-b', statement: 'Compressed recurrent state loses exact retrieval.', confidence: 0.7, evidence: ['attack-b'], contradicts: ['claim-a'], hypothesis_id: 'h-memory', status: 'observed' }],
      proposals: [proposal('candidate-b', 'heretical', 3, 8)]
    })
  ];
  const integration = integrateReports(reports, assignments);
  assert.equal(integration.claims.length, 2);
  assert.deepEqual(integration.contradiction_graph.edges, [{ from: 'claim-a', to: 'claim-b', kind: 'contradiction' }]);
  assert.equal(integration.hypotheses[0].hypothesis_id, 'h-memory');
  assert.equal(integration.no_winner_selected, true);
});

test('portfolio requires falsification, matched compute, hidden evaluation, and reproduction', () => {
  const integration = {
    candidates: [
      proposal('good', 'conservative', 1, 3),
      proposal('bad', 'heretical', 1, 100, { reproduction_seeds: 1 })
    ]
  };
  const portfolio = buildExperimentPortfolio(integration, { budget: 5 });
  assert.deepEqual(portfolio.selected.map(item => item.candidate_id), ['good']);
  assert.deepEqual(portfolio.rejected, [{ candidate_id: 'bad', reasons: ['requires-at-least-two-reproduction-seeds'] }]);
  assert.equal(portfolio.winner, null);
});

test('portfolio preserves conservative, adjacent, and heretical experiments before filling by information gain', () => {
  const integration = {
    candidates: [
      proposal('c-low', 'conservative', 1, 1),
      proposal('a-high', 'adjacent', 1, 10),
      proposal('h-mid', 'heretical', 1, 5),
      proposal('a-second', 'adjacent', 1, 9)
    ]
  };
  const portfolio = buildExperimentPortfolio(integration, { budget: 3 });
  assert.deepEqual(new Set(portfolio.selected.map(item => item.distance)), new Set(['conservative', 'adjacent', 'heretical']));
  assert.equal(portfolio.spent, 3);
  assert.equal(portfolio.selected.every(item => item.state === 'leased-not-executed'), true);
});

test('candidate genome serializes the full mechanism and rejects secret leakage', () => {
  const genome = {
    identity: { candidate_id: 'g-1' },
    lineage: { parents: [] },
    model_graph: { nodes: [{ id: 'n1', operation: 'learned-state-transition' }], edges: [] },
    representation: { kind: 'learned-segment-lattice' },
    state_memory: { update: 'bounded-plastic-state' },
    learning: { objectives: ['prediction', 'verification'] },
    data: { generators: ['procedural'] },
    optimizer: { name: 'test-optimizer', schedule: 'constant' },
    precision: { weights: 'bf16' },
    inference: { budget: 4 },
    hardware: { device: 'cpu' },
    seeds: [1, 2],
    code_revision: 'a'.repeat(40),
    external_tools: [{ name: 'simulator', pin: 'sha256:abc', license: 'MIT' }]
  };
  const validated = validateCandidateGenome(genome);
  assert.match(validated.genome_digest, /^[0-9a-f]{64}$/);
  assert.throws(() => validateCandidateGenome({ ...genome, api_token: 'leak' }), /Secret-like field/);
  assert.throws(() => validateCandidateGenome({ ...genome, seeds: [1] }), /at least two integer seeds/);
});

test('pareto front rewards capability and efficiency without collapsing to one scalar', () => {
  const front = paretoFront([
    { id: 'balanced', metrics: { capability: 8, bytes: 5 } },
    { id: 'capability-max', metrics: { capability: 10, bytes: 8 } },
    { id: 'dominated', metrics: { capability: 7, bytes: 7 } },
    { id: 'efficiency-max', metrics: { capability: 6, bytes: 2 } }
  ], { capability: 'max', bytes: 'min' });
  assert.deepEqual(front, ['balanced', 'capability-max', 'efficiency-max']);
});

test('admission blocks benchmark theater and admits only reproduced matched-resource evidence', () => {
  const blocked = evaluateAdmission({ candidate_id: 'candidate-x' }, {
    matched_compute: false,
    hidden_evaluation_passed: true,
    reproduced_seeds: 1,
    broad_regression_passed: true,
    resource_receipt: { active_flops: 1 }
  });
  assert.equal(blocked.admitted, false);
  assert.ok(blocked.reasons.includes('matched-compute-comparison-not-proven'));
  assert.ok(blocked.reasons.includes('insufficient-reproduction'));

  const admitted = evaluateAdmission({ candidate_id: 'candidate-y' }, {
    matched_compute: true,
    hidden_evaluation_passed: true,
    reproduced_seeds: 3,
    broad_regression_passed: true,
    critical_sabotage_findings: [],
    resource_receipt: { active_flops: 10, bytes_moved: 20 },
    demonstrated_claims: ['higher capability at lower measured memory traffic'],
    unverified_claims: ['advantage survives billion-parameter scale']
  });
  assert.equal(admitted.admitted, true);
  assert.deepEqual(admitted.demonstrated, ['higher capability at lower measured memory traffic']);
});

test('receipt separates demonstrated gains from unverified hypotheses', () => {
  const assignments = createAssignments(mission);
  const integration = { report_count: 2, candidates: [{}, {}], contradiction_graph: { edges: [{}, {}] } };
  const portfolio = { selected: [{ state: 'executed' }, { state: 'leased-not-executed' }] };
  const receipt = createReceipt({
    mission,
    assignments,
    integration,
    portfolio,
    admissions: [{ demonstrated: ['proxy gain reproduced'], unverified: ['scaling gain'], admitted: true }],
    commands: ['node --test foundry/tests/core.test.mjs'],
    artifacts: ['foundry/example-mission.json']
  });
  assert.deepEqual(receipt.demonstrated_claims, ['proxy gain reproduced']);
  assert.deepEqual(receipt.unverified_claims, ['scaling gain']);
  assert.equal(receipt.experiments_executed, 1);
  assert.equal(receipt.authority.training_spend, 'not-granted-by-receipt');
  assert.match(receipt.receipt_digest, /^[0-9a-f]{64}$/);
});
