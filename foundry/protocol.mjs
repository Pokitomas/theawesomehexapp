import { asFiniteNumber, asText, assertNoSecrets, digest } from './util.mjs';

export const FOUNDRY_VERSION = 'sideways-model-foundry/v1';

export const ROLE_SPECS = Object.freeze([
  {
    id: 'frontier-cartographer',
    scope: 'repository assumptions, inherited design constraints, and discriminating proxy experiments',
    required_outputs: ['fixed_assumptions', 'accidental_assumptions', 'removable_assumptions', 'unexplored_axes', 'proposals']
  },
  {
    id: 'architecture-heretic',
    scope: 'structurally distinct model families; at least half outside straightforward Transformer/Mamba/MoE hybrids',
    required_outputs: ['model_families', 'mechanisms', 'falsifiable_advantages', 'proposals']
  },
  {
    id: 'learning-dynamics-inventor',
    scope: 'learning signals, parameter or state updates, curricula, self-play, active acquisition, and learned optimization',
    required_outputs: ['learning_rules', 'update_targets', 'signals', 'proposals']
  },
  {
    id: 'distillation-breaker',
    scope: 'transfer of algorithms, uncertainty, search policy, abstractions, memory policy, and teacher-exceeding verification',
    required_outputs: ['transfer_limits', 'transfer_mechanisms', 'teacher_exceeding_paths', 'proposals']
  },
  {
    id: 'benchmark-saboteur',
    scope: 'hidden, procedural, contamination-resistant, and cost-honest evaluation attacks',
    required_outputs: ['attack_cases', 'hidden_evaluations', 'veto_conditions', 'proposals']
  },
  {
    id: 'efficiency-physicist',
    scope: 'active FLOPs, bytes moved, memory, latency, energy proxies, training cost, and local throughput',
    required_outputs: ['resource_metrics', 'measurement_protocols', 'cost_shifting_risks', 'proposals']
  },
  {
    id: 'mechanistic-pathologist',
    scope: 'causal diagnosis of dead capacity, collapse, shortcuts, unstable memory, and removable components',
    required_outputs: ['failure_mechanisms', 'interventions', 'ablation_requirements', 'proposals']
  },
  {
    id: 'open-world-toolsmith',
    scope: 'pinned, licensed, sandboxed external libraries, datasets, simulators, kernels, and evaluation environments',
    required_outputs: ['external_resources', 'licenses', 'pins', 'unlocked_experiments', 'proposals']
  },
  {
    id: 'scaling-law-skeptic',
    scope: 'proxy-to-scale transfer, uncertainty, tiny-model artifacts, and architecture-versus-optimization separation',
    required_outputs: ['scaling_hypotheses', 'proxy_failures', 'uncertainty', 'proposals']
  },
  {
    id: 'product-reality-agent',
    scope: 'ordinary-hardware launch, budgets, resumability, inspection, export, recovery, and operator truthfulness',
    required_outputs: ['operator_flows', 'hardware_constraints', 'recovery_paths', 'proposals']
  }
]);

export function validateMission(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Mission must be an object.');
  assertNoSecrets(input);
  const mission = {
    schema: FOUNDRY_VERSION,
    id: asText(input.id, 'mission.id', 120),
    objective: asText(input.objective, 'mission.objective', 12000),
    hardware: input.hardware && typeof input.hardware === 'object' ? structuredClone(input.hardware) : {},
    budget: input.budget && typeof input.budget === 'object' ? structuredClone(input.budget) : {},
    success_metrics: Array.isArray(input.success_metrics) ? input.success_metrics.map((metric, index) => asText(metric, `mission.success_metrics[${index}]`, 500)) : [],
    forbidden_defaults: Array.isArray(input.forbidden_defaults) ? input.forbidden_defaults.map((item, index) => asText(item, `mission.forbidden_defaults[${index}]`, 500)) : [],
    operator_constraints: Array.isArray(input.operator_constraints) ? input.operator_constraints.map((item, index) => asText(item, `mission.operator_constraints[${index}]`, 1000)) : []
  };
  if (mission.success_metrics.length < 2) throw new Error('mission.success_metrics must contain at least two non-equivalent metrics.');
  return Object.freeze(mission);
}

export function createAssignments(missionInput) {
  const mission = validateMission(missionInput);
  return ROLE_SPECS.map((role, index) => Object.freeze({
    schema: FOUNDRY_VERSION,
    assignment_id: `${mission.id}:assessment:${String(index + 1).padStart(2, '0')}:${role.id}`,
    mission_id: mission.id,
    phase: 'parallel-read-only-assessment',
    role: role.id,
    read_only: true,
    scope: role.scope,
    objective: mission.objective,
    constraints: {
      hardware: mission.hardware,
      budget: mission.budget,
      forbidden_defaults: mission.forbidden_defaults,
      operator_constraints: mission.operator_constraints,
      no_architecture_precommitment: true,
      no_mutation_claims_without_supplied_evidence: true
    },
    output_contract: {
      required_outputs: role.required_outputs,
      claims: 'array<{id,statement,confidence,evidence,contradicts,hypothesis_id}>',
      proposals: 'array<{candidate_id,family,distance,mechanism,falsifier,cost,expected_information_gain,matched_compute_baseline,hidden_evaluation,reproduction_seeds}>',
      external_resources: 'array<{name,purpose,license,pin,unlocked_experiment}>',
      uncertainty: 'explicit'
    }
  }));
}

function normalizeClaim(claim, reportIndex, claimIndex) {
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) throw new Error(`reports[${reportIndex}].claims[${claimIndex}] must be an object.`);
  return {
    id: asText(claim.id, `reports[${reportIndex}].claims[${claimIndex}].id`, 200),
    statement: asText(claim.statement, `reports[${reportIndex}].claims[${claimIndex}].statement`, 5000),
    confidence: asFiniteNumber(claim.confidence, `reports[${reportIndex}].claims[${claimIndex}].confidence`, { min: 0, max: 1 }),
    evidence: Array.isArray(claim.evidence) ? claim.evidence.map((item, index) => asText(item, `claim.evidence[${index}]`, 2000)) : [],
    contradicts: Array.isArray(claim.contradicts) ? claim.contradicts.map((item, index) => asText(item, `claim.contradicts[${index}]`, 200)) : [],
    hypothesis_id: claim.hypothesis_id ? asText(claim.hypothesis_id, 'claim.hypothesis_id', 200) : null,
    status: ['observed', 'inferred', 'hypothesis'].includes(claim.status) ? claim.status : 'hypothesis'
  };
}

function normalizeProposal(proposal, reportIndex, proposalIndex) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) throw new Error(`reports[${reportIndex}].proposals[${proposalIndex}] must be an object.`);
  const distance = ['conservative', 'adjacent', 'heretical'].includes(proposal.distance) ? proposal.distance : 'adjacent';
  return {
    candidate_id: asText(proposal.candidate_id, `proposal.candidate_id`, 200),
    family: asText(proposal.family, 'proposal.family', 500),
    distance,
    mechanism: asText(proposal.mechanism, 'proposal.mechanism', 10000),
    falsifier: asText(proposal.falsifier, 'proposal.falsifier', 5000),
    cost: asFiniteNumber(proposal.cost, 'proposal.cost', { min: 0.000001 }),
    expected_information_gain: asFiniteNumber(proposal.expected_information_gain, 'proposal.expected_information_gain', { min: 0 }),
    matched_compute_baseline: asText(proposal.matched_compute_baseline, 'proposal.matched_compute_baseline', 2000),
    hidden_evaluation: asText(proposal.hidden_evaluation, 'proposal.hidden_evaluation', 2000),
    reproduction_seeds: Math.floor(asFiniteNumber(proposal.reproduction_seeds, 'proposal.reproduction_seeds', { min: 1, max: 1000 })),
    novelty_tags: Array.isArray(proposal.novelty_tags) ? proposal.novelty_tags.map((item, index) => asText(item, `proposal.novelty_tags[${index}]`, 200)) : [],
    dependencies: Array.isArray(proposal.dependencies) ? proposal.dependencies.map((item, index) => asText(item, `proposal.dependencies[${index}]`, 500)) : [],
    source_report: reportIndex
  };
}

export function validateReport(report, assignments = []) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('Report must be an object.');
  assertNoSecrets(report);
  const assignmentId = asText(report.assignment_id, 'report.assignment_id', 300);
  const role = asText(report.role, 'report.role', 120);
  const assignment = assignments.find(item => item.assignment_id === assignmentId);
  if (assignments.length && !assignment) throw new Error(`Unknown assignment_id: ${assignmentId}.`);
  if (assignment && assignment.role !== role) throw new Error(`Report role ${role} does not match assignment role ${assignment.role}.`);
  if (report.mutations && report.mutations.length) throw new Error('Read-only reports may not contain mutations.');
  return {
    schema: FOUNDRY_VERSION,
    assignment_id: assignmentId,
    role,
    claims: Array.isArray(report.claims) ? report.claims.map((claim, index) => normalizeClaim(claim, 0, index)) : [],
    proposals: Array.isArray(report.proposals) ? report.proposals.map((proposal, index) => normalizeProposal(proposal, 0, index)) : [],
    external_resources: Array.isArray(report.external_resources) ? report.external_resources.map((resource, index) => ({
      name: asText(resource.name, `external_resources[${index}].name`, 300),
      purpose: asText(resource.purpose, `external_resources[${index}].purpose`, 2000),
      license: asText(resource.license, `external_resources[${index}].license`, 300),
      pin: asText(resource.pin, `external_resources[${index}].pin`, 500),
      unlocked_experiment: asText(resource.unlocked_experiment, `external_resources[${index}].unlocked_experiment`, 1000),
      install_authority: 'not-granted'
    })) : [],
    uncertainty: report.uncertainty ? asText(report.uncertainty, 'report.uncertainty', 4000) : 'unspecified'
  };
}

export function integrateReports(reportInputs, assignments = []) {
  if (!Array.isArray(reportInputs) || reportInputs.length === 0) throw new Error('At least one report is required.');
  const reports = reportInputs.map(report => validateReport(report, assignments));
  const seenAssignments = new Set();
  const claimById = new Map();
  const candidateById = new Map();
  const externalResourceByKey = new Map();

  reports.forEach((report, reportIndex) => {
    if (seenAssignments.has(report.assignment_id)) throw new Error(`Duplicate report for assignment ${report.assignment_id}.`);
    seenAssignments.add(report.assignment_id);
    report.claims.forEach((claim, claimIndex) => {
      if (claimById.has(claim.id)) throw new Error(`Duplicate claim id ${claim.id}.`);
      claimById.set(claim.id, { ...claim, source_role: report.role, source_assignment_id: report.assignment_id, source_index: [reportIndex, claimIndex] });
    });
    report.proposals.forEach(proposal => {
      const existing = candidateById.get(proposal.candidate_id);
      if (!existing) {
        candidateById.set(proposal.candidate_id, {
          ...proposal,
          source_roles: [report.role],
          source_assignments: [report.assignment_id],
          corroborations: 1,
          mechanism_variants: [proposal.mechanism]
        });
      } else {
        existing.source_roles.push(report.role);
        existing.source_assignments.push(report.assignment_id);
        existing.corroborations += 1;
        if (!existing.mechanism_variants.includes(proposal.mechanism)) existing.mechanism_variants.push(proposal.mechanism);
        existing.expected_information_gain = Math.max(existing.expected_information_gain, proposal.expected_information_gain);
        existing.cost = Math.min(existing.cost, proposal.cost);
        existing.novelty_tags = [...new Set([...existing.novelty_tags, ...proposal.novelty_tags])];
      }
    });
    report.external_resources.forEach(resource => {
      externalResourceByKey.set(`${resource.name}@${resource.pin}`, resource);
    });
  });

  const edges = [];
  for (const claim of claimById.values()) {
    for (const target of claim.contradicts) {
      if (!claimById.has(target)) {
        edges.push({ from: claim.id, to: target, kind: 'unresolved-reference' });
      } else {
        const [from, to] = [claim.id, target].sort();
        if (!edges.some(edge => edge.from === from && edge.to === to && edge.kind === 'contradiction')) {
          edges.push({ from, to, kind: 'contradiction' });
        }
      }
    }
  }

  const hypotheses = [...claimById.values()].reduce((map, claim) => {
    if (!claim.hypothesis_id) return map;
    const current = map.get(claim.hypothesis_id) || { hypothesis_id: claim.hypothesis_id, supporting_claims: [], opposing_claims: [] };
    current.supporting_claims.push(claim.id);
    for (const contradiction of claim.contradicts) current.opposing_claims.push(contradiction);
    map.set(claim.hypothesis_id, current);
    return map;
  }, new Map());

  const integration = {
    schema: FOUNDRY_VERSION,
    report_count: reports.length,
    roles_present: [...new Set(reports.map(report => report.role))].sort(),
    claims: [...claimById.values()].sort((a, b) => a.id.localeCompare(b.id)),
    contradiction_graph: {
      nodes: [...claimById.keys()].sort(),
      edges: edges.sort((a, b) => `${a.from}:${a.to}:${a.kind}`.localeCompare(`${b.from}:${b.to}:${b.kind}`))
    },
    hypotheses: [...hypotheses.values()].sort((a, b) => a.hypothesis_id.localeCompare(b.hypothesis_id)),
    candidates: [...candidateById.values()].sort((a, b) => a.candidate_id.localeCompare(b.candidate_id)),
    external_resources: [...externalResourceByKey.values()].sort((a, b) => `${a.name}@${a.pin}`.localeCompare(`${b.name}@${b.pin}`)),
    unresolved_contradictions: edges.filter(edge => edge.kind === 'unresolved-reference'),
    no_winner_selected: true
  };
  return Object.freeze({ ...integration, digest: digest(integration) });
}
