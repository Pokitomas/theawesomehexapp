import { FOUNDRY_VERSION, validateMission } from './protocol.mjs';
import { SHA40, asFiniteNumber, asText, assertNoSecrets, digest } from './util.mjs';

function proposalGate(candidate) {
  const reasons = [];
  if (!candidate.falsifier) reasons.push('missing-falsifier');
  if (!candidate.matched_compute_baseline) reasons.push('missing-matched-compute-baseline');
  if (!candidate.hidden_evaluation) reasons.push('missing-hidden-evaluation');
  if (candidate.reproduction_seeds < 2) reasons.push('requires-at-least-two-reproduction-seeds');
  if (!(candidate.cost > 0)) reasons.push('invalid-cost');
  return reasons;
}

export function buildExperimentPortfolio(integration, { budget = Infinity, require_strata = true } = {}) {
  if (!integration || !Array.isArray(integration.candidates)) throw new Error('Integration with candidates is required.');
  const maxBudget = budget === Infinity ? Infinity : asFiniteNumber(budget, 'budget', { min: 0 });
  const eligible = [];
  const rejected = [];

  for (const candidate of integration.candidates) {
    const reasons = proposalGate(candidate);
    const scored = {
      ...candidate,
      information_per_cost: candidate.expected_information_gain / candidate.cost
    };
    if (reasons.length) rejected.push({ candidate_id: candidate.candidate_id, reasons });
    else eligible.push(scored);
  }

  eligible.sort((a, b) => b.information_per_cost - a.information_per_cost || a.cost - b.cost || a.candidate_id.localeCompare(b.candidate_id));
  const selected = [];
  const selectedIds = new Set();
  let spent = 0;

  const trySelect = candidate => {
    if (!candidate || selectedIds.has(candidate.candidate_id) || spent + candidate.cost > maxBudget) return false;
    selected.push(candidate);
    selectedIds.add(candidate.candidate_id);
    spent += candidate.cost;
    return true;
  };

  if (require_strata) {
    for (const distance of ['conservative', 'adjacent', 'heretical']) {
      trySelect(eligible.find(candidate => candidate.distance === distance));
    }
  }
  for (const candidate of eligible) trySelect(candidate);

  return Object.freeze({
    schema: FOUNDRY_VERSION,
    selection_policy: 'expected-information-gain-per-cost-with-diversity-strata',
    budget: maxBudget,
    spent,
    selected: selected.map((candidate, index) => ({
      experiment_id: `experiment:${String(index + 1).padStart(3, '0')}:${candidate.candidate_id}`,
      candidate_id: candidate.candidate_id,
      distance: candidate.distance,
      mechanism: candidate.mechanism,
      falsifier: candidate.falsifier,
      matched_compute_baseline: candidate.matched_compute_baseline,
      hidden_evaluation: candidate.hidden_evaluation,
      reproduction_seeds: candidate.reproduction_seeds,
      expected_information_gain: candidate.expected_information_gain,
      estimated_cost: candidate.cost,
      information_per_cost: candidate.information_per_cost,
      state: 'leased-not-executed'
    })),
    deferred: eligible.filter(candidate => !selectedIds.has(candidate.candidate_id)).map(candidate => ({ candidate_id: candidate.candidate_id, reason: 'budget-or-priority' })),
    rejected,
    winner: null
  });
}

const REQUIRED_GENOME_PATHS = Object.freeze([
  'identity',
  'lineage',
  'model_graph',
  'representation',
  'state_memory',
  'learning',
  'data',
  'optimizer',
  'precision',
  'inference',
  'hardware',
  'seeds',
  'code_revision',
  'external_tools'
]);

export function validateCandidateGenome(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Candidate genome must be an object.');
  assertNoSecrets(input);
  for (const key of REQUIRED_GENOME_PATHS) {
    if (!(key in input)) throw new Error(`Candidate genome is missing ${key}.`);
  }
  if (!Array.isArray(input.seeds) || input.seeds.length < 2 || input.seeds.some(seed => !Number.isInteger(seed))) {
    throw new Error('Candidate genome requires at least two integer seeds.');
  }
  if (!SHA40.test(String(input.code_revision))) throw new Error('Candidate genome code_revision must be a full 40-character commit SHA.');
  if (!Array.isArray(input.model_graph?.nodes) || input.model_graph.nodes.length === 0) throw new Error('Candidate genome model_graph.nodes must be non-empty.');
  if (!Array.isArray(input.model_graph?.edges)) throw new Error('Candidate genome model_graph.edges must be an array.');
  if (!Array.isArray(input.external_tools)) throw new Error('Candidate genome external_tools must be an array.');
  for (const [index, tool] of input.external_tools.entries()) {
    if (!tool || typeof tool !== 'object' || !tool.name || !tool.pin || !tool.license) {
      throw new Error(`Candidate genome external_tools[${index}] requires name, pin, and license.`);
    }
  }
  const normalized = structuredClone(input);
  normalized.schema = FOUNDRY_VERSION;
  normalized.genome_digest = digest({ ...normalized, genome_digest: undefined });
  return Object.freeze(normalized);
}

export function paretoFront(candidates, objectives) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  if (!objectives || typeof objectives !== 'object' || Array.isArray(objectives) || Object.keys(objectives).length === 0) {
    throw new Error('Pareto objectives are required.');
  }
  for (const [metric, direction] of Object.entries(objectives)) {
    if (!['min', 'max'].includes(direction)) throw new Error(`Objective ${metric} direction must be min or max.`);
    for (const candidate of candidates) asFiniteNumber(candidate.metrics?.[metric], `candidate ${candidate.id} metric ${metric}`);
  }
  const noWorse = (a, b, metric, direction) => direction === 'max' ? a.metrics[metric] >= b.metrics[metric] : a.metrics[metric] <= b.metrics[metric];
  const strictlyBetter = (a, b, metric, direction) => direction === 'max' ? a.metrics[metric] > b.metrics[metric] : a.metrics[metric] < b.metrics[metric];
  return candidates.filter(candidate => !candidates.some(other => {
    if (other === candidate) return false;
    return Object.entries(objectives).every(([metric, direction]) => noWorse(other, candidate, metric, direction))
      && Object.entries(objectives).some(([metric, direction]) => strictlyBetter(other, candidate, metric, direction));
  })).map(candidate => candidate.id).sort();
}

export function evaluateAdmission(candidate, evidence) {
  const reasons = [];
  if (!evidence?.matched_compute) reasons.push('matched-compute-comparison-not-proven');
  if (!evidence?.hidden_evaluation_passed) reasons.push('hidden-evaluation-not-passed');
  if ((Number(evidence?.reproduced_seeds) || 0) < 2) reasons.push('insufficient-reproduction');
  if (!evidence?.broad_regression_passed) reasons.push('broad-regression-not-passed');
  if (Array.isArray(evidence?.critical_sabotage_findings) && evidence.critical_sabotage_findings.length) reasons.push('critical-sabotage-finding-open');
  if (!evidence?.resource_receipt || typeof evidence.resource_receipt !== 'object') reasons.push('resource-receipt-missing');
  return Object.freeze({
    candidate_id: asText(candidate?.candidate_id || candidate?.id, 'candidate id', 300),
    admitted: reasons.length === 0,
    reasons,
    demonstrated: reasons.length === 0 ? [...new Set(evidence.demonstrated_claims || [])] : [],
    unverified: [...new Set(evidence?.unverified_claims || [])]
  });
}

export function createReceipt({ mission, assignments, integration, portfolio, admissions = [], commands = [], artifacts = [] }) {
  const validatedMission = validateMission(mission);
  const receipt = {
    schema: FOUNDRY_VERSION,
    mission_id: validatedMission.id,
    mission_digest: digest(validatedMission),
    assignment_count: Array.isArray(assignments) ? assignments.length : 0,
    roles: Array.isArray(assignments) ? [...new Set(assignments.map(item => item.role))].sort() : [],
    report_count: integration?.report_count || 0,
    contradiction_count: integration?.contradiction_graph?.edges?.length || 0,
    candidate_count: integration?.candidates?.length || 0,
    experiment_count: portfolio?.selected?.length || 0,
    experiments_executed: portfolio?.selected?.filter(item => item.state === 'executed').length || 0,
    admissions,
    demonstrated_claims: admissions.flatMap(item => item.demonstrated || []).sort(),
    unverified_claims: admissions.flatMap(item => item.unverified || []).sort(),
    commands: commands.map(command => asText(command, 'receipt command', 2000)),
    artifacts: artifacts.map(artifact => asText(artifact, 'receipt artifact', 2000)),
    authority: {
      merge: 'human',
      deploy: 'human',
      external_installs: 'not-granted-by-receipt',
      training_spend: 'not-granted-by-receipt'
    }
  };
  return Object.freeze({ ...receipt, receipt_digest: digest(receipt) });
}
