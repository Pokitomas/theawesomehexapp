import crypto from 'node:crypto';

export const ARCHIE_LAUNCH_FRONTIER_TARGET_SCHEMA = 'archie-launch-frontier-target/v2';
export const ARCHIE_LAUNCH_FRONTIER_MANIFEST_SCHEMA = 'archie-launch-frontier-manifest/v2';
export const ARCHIE_LAUNCH_FRONTIER_DECISION_SCHEMA = 'archie-launch-frontier-decision/v2';

const DIGEST = /^[a-f0-9]{64}$/;
const SHA40 = /^[a-f0-9]{40}$/;
const DIRECTIONS = new Set(['max', 'min']);
const GROUPS = new Set(['intelligence', 'embodiment', 'authority', 'resource']);
const PROFILE_STATUS = new Set(['admitted', 'experimental', 'absent']);
const SELECTION_MODES = new Set(['adaptive-frontier', 'lexicographic']);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

export function stableJSONStringify(value) {
  return JSON.stringify(stable(value));
}

export function frontierDigest(value) {
  return crypto.createHash('sha256').update(stableJSONStringify(value)).digest('hex');
}

function clean(value, field, limit = 10_000) {
  const text = String(value ?? '').replace(/\u0000/g, '').trim();
  if (!text) throw new Error(`${field} is required.`);
  if (text.length > limit) throw new Error(`${field} exceeds ${limit} characters.`);
  return text;
}

function exactDigest(value, field) {
  const text = clean(value, field, 64).toLowerCase();
  if (!DIGEST.test(text)) throw new Error(`${field} must be a lowercase SHA-256 digest.`);
  return text;
}

function exactSha(value, field) {
  const text = clean(value, field, 40).toLowerCase();
  if (!SHA40.test(text)) throw new Error(`${field} must be a 40-character Git SHA.`);
  return text;
}

function finite(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${field} must be finite.`);
  return number;
}

function nonnegative(value, field) {
  const number = finite(value, field);
  if (number < 0) throw new Error(`${field} must be nonnegative.`);
  return number;
}

function uniqueStrings(values, field, { allowEmpty = true } = {}) {
  if (!Array.isArray(values)) throw new Error(`${field} must be an array.`);
  const output = values.map((value, index) => clean(value, `${field}[${index}]`, 300));
  if (!allowEmpty && !output.length) throw new Error(`${field} must be non-empty.`);
  if (new Set(output).size !== output.length) throw new Error(`${field} contains duplicate values.`);
  return output;
}

function digestList(values, field, options = {}) {
  return uniqueStrings(values, field, options).map((value, index) => exactDigest(value, `${field}[${index}]`));
}

function numberMap(input, field) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`${field} must be an object.`);
  return Object.freeze(Object.fromEntries(Object.entries(input).map(([key, value]) => [
    clean(key, `${field} key`, 200),
    nonnegative(value, `${field}.${key}`)
  ])));
}

function booleanPolicy(input, field, expected) {
  if (typeof input !== 'boolean') throw new Error(`${field} must be boolean.`);
  if (input !== expected) throw new Error(`${field} must be ${expected}.`);
  return input;
}

export function validateFrontierTarget(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Frontier target must be an object.');
  if (input.schema !== ARCHIE_LAUNCH_FRONTIER_TARGET_SCHEMA) {
    throw new Error(`Frontier target schema must be ${ARCHIE_LAUNCH_FRONTIER_TARGET_SCHEMA}.`);
  }
  if (!Array.isArray(input.objectives) || !input.objectives.length) throw new Error('objectives must be non-empty.');
  const objectives = input.objectives.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`objectives[${index}] must be an object.`);
    const id = clean(entry.id, `objectives[${index}].id`, 200);
    const group = clean(entry.group, `objectives[${index}].group`, 100);
    const direction = clean(entry.direction, `objectives[${index}].direction`, 20);
    if (!GROUPS.has(group)) throw new Error(`objectives[${index}].group is unsupported.`);
    if (!DIRECTIONS.has(direction)) throw new Error(`objectives[${index}].direction is unsupported.`);
    return Object.freeze({
      id,
      group,
      direction,
      critical: entry.critical !== false,
      gate: finite(entry.gate, `objectives[${index}].gate`),
      description: clean(entry.description, `objectives[${index}].description`, 1500)
    });
  });
  if (new Set(objectives.map(item => item.id)).size !== objectives.length) throw new Error('Objective IDs must be unique.');
  if (!objectives.some(item => item.group === 'intelligence')) throw new Error('At least one intelligence objective is required.');
  if (!objectives.some(item => item.group === 'embodiment')) throw new Error('At least one embodiment objective is required.');
  if (!objectives.some(item => item.group === 'authority')) throw new Error('At least one authority objective is required.');

  const policy = input.frontier_policy;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('frontier_policy must be an object.');
  booleanPolicy(policy.per_environment_frontier, 'frontier_policy.per_environment_frontier', true);
  booleanPolicy(policy.complete_profile_search_required, 'frontier_policy.complete_profile_search_required', true);
  booleanPolicy(policy.reject_dominated_default, 'frontier_policy.reject_dominated_default', true);
  booleanPolicy(policy.allow_adaptive_frontier, 'frontier_policy.allow_adaptive_frontier', true);
  booleanPolicy(policy.chat_is_architecture, 'frontier_policy.chat_is_architecture', false);
  booleanPolicy(policy.voice_is_architecture, 'frontier_policy.voice_is_architecture', false);
  booleanPolicy(policy.screen_is_architecture, 'frontier_policy.screen_is_architecture', false);
  booleanPolicy(policy.always_on_is_architecture, 'frontier_policy.always_on_is_architecture', false);
  if (policy.canonical_interface !== null) throw new Error('frontier_policy.canonical_interface must be null.');

  return Object.freeze({
    schema: ARCHIE_LAUNCH_FRONTIER_TARGET_SCHEMA,
    id: clean(input.id, 'target.id', 200),
    claim_boundary: clean(input.claim_boundary, 'target.claim_boundary', 3000),
    objectives: Object.freeze(objectives),
    frontier_policy: Object.freeze({ ...policy })
  });
}

function normalizeRelease(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('release must be an object.');
  return Object.freeze({
    id: clean(input.id, 'release.id', 200),
    model_artifact_digest: exactDigest(input.model_artifact_digest, 'release.model_artifact_digest'),
    checkpoint_digest: exactDigest(input.checkpoint_digest, 'release.checkpoint_digest'),
    intelligence_report_digest: exactDigest(input.intelligence_report_digest, 'release.intelligence_report_digest'),
    authority_report_digest: exactDigest(input.authority_report_digest, 'release.authority_report_digest'),
    reproduction_receipt_digest: exactDigest(input.reproduction_receipt_digest, 'release.reproduction_receipt_digest'),
    runtime_abi: clean(input.runtime_abi, 'release.runtime_abi', 200),
    code_revision: exactSha(input.code_revision, 'release.code_revision')
  });
}

function normalizeEnvironment(input, index, objectiveIds) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`environments[${index}] must be an object.`);
  const selection = input.selection_policy;
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) throw new Error(`environments[${index}].selection_policy must be an object.`);
  const mode = clean(selection.mode, `environments[${index}].selection_policy.mode`, 100);
  if (!SELECTION_MODES.has(mode)) throw new Error(`environments[${index}].selection_policy.mode is unsupported.`);
  const objectiveOrder = uniqueStrings(selection.objective_order || [], `environments[${index}].selection_policy.objective_order`);
  for (const objective of objectiveOrder) if (!objectiveIds.has(objective)) throw new Error(`Unknown selection objective ${objective}.`);
  if (mode === 'lexicographic' && !objectiveOrder.length) throw new Error('Lexicographic selection requires objective_order.');
  return Object.freeze({
    id: clean(input.id, `environments[${index}].id`, 200),
    required_for_launch: input.required_for_launch !== false,
    hardware_fingerprint: exactDigest(input.hardware_fingerprint, `environments[${index}].hardware_fingerprint`),
    os_fingerprint: exactDigest(input.os_fingerprint, `environments[${index}].os_fingerprint`),
    platform_receipt_digests: Object.freeze(digestList(input.platform_receipt_digests || [], `environments[${index}].platform_receipt_digests`, { allowEmpty: false })),
    authority_grants: Object.freeze(uniqueStrings(input.authority_grants || [], `environments[${index}].authority_grants`)),
    resource_budgets: numberMap(input.resource_budgets || {}, `environments[${index}].resource_budgets`),
    selection_policy: Object.freeze({ mode, objective_order: Object.freeze(objectiveOrder) }),
    requested_default_profile_id: input.requested_default_profile_id === null || input.requested_default_profile_id === undefined
      ? null
      : clean(input.requested_default_profile_id, `environments[${index}].requested_default_profile_id`, 200)
  });
}

function normalizeProfile(input, index, release, environmentIds, objectiveIds) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(`profiles[${index}] must be an object.`);
  const status = clean(input.status, `profiles[${index}].status`, 100);
  if (!PROFILE_STATUS.has(status)) throw new Error(`profiles[${index}].status is unsupported.`);
  const environmentId = clean(input.environment_id, `profiles[${index}].environment_id`, 200);
  if (!environmentIds.has(environmentId)) throw new Error(`profiles[${index}] references unknown environment ${environmentId}.`);
  const metrics = Object.freeze(Object.fromEntries(Object.entries(input.objective_metrics || {}).map(([key, value]) => [
    clean(key, `profiles[${index}].objective_metrics key`, 200),
    finite(value, `profiles[${index}].objective_metrics.${key}`)
  ])));
  for (const id of objectiveIds) if (!Object.prototype.hasOwnProperty.call(metrics, id)) throw new Error(`profiles[${index}] is missing objective metric ${id}.`);
  for (const id of Object.keys(metrics)) if (!objectiveIds.has(id)) throw new Error(`profiles[${index}] declares unknown objective metric ${id}.`);
  const evidence = digestList(input.evidence_digests || [], `profiles[${index}].evidence_digests`);
  if (status === 'admitted' && !evidence.length) throw new Error(`profiles[${index}] cannot be admitted without evidence.`);
  const modelDigest = exactDigest(input.model_artifact_digest, `profiles[${index}].model_artifact_digest`);
  const codeRevision = exactSha(input.code_revision, `profiles[${index}].code_revision`);
  const runtimeAbi = clean(input.runtime_abi, `profiles[${index}].runtime_abi`, 200);
  if (modelDigest !== release.model_artifact_digest) throw new Error(`profiles[${index}] model artifact mismatch.`);
  if (codeRevision !== release.code_revision) throw new Error(`profiles[${index}] code revision mismatch.`);
  if (runtimeAbi !== release.runtime_abi) throw new Error(`profiles[${index}] runtime ABI mismatch.`);
  return Object.freeze({
    id: clean(input.id, `profiles[${index}].id`, 200),
    environment_id: environmentId,
    status,
    model_artifact_digest: modelDigest,
    code_revision: codeRevision,
    runtime_abi: runtimeAbi,
    evidence_digests: Object.freeze(evidence),
    modalities: Object.freeze(uniqueStrings(input.modalities || [], `profiles[${index}].modalities`)),
    invocation_modes: Object.freeze(uniqueStrings(input.invocation_modes || [], `profiles[${index}].invocation_modes`)),
    continuity_modes: Object.freeze(uniqueStrings(input.continuity_modes || [], `profiles[${index}].continuity_modes`)),
    required_authorities: Object.freeze(uniqueStrings(input.required_authorities || [], `profiles[${index}].required_authorities`)),
    resource_usage: numberMap(input.resource_usage || {}, `profiles[${index}].resource_usage`),
    objective_metrics: metrics,
    activation_conditions: Object.freeze(uniqueStrings(input.activation_conditions || [], `profiles[${index}].activation_conditions`)),
    platform_constraints: Object.freeze(uniqueStrings(input.platform_constraints || [], `profiles[${index}].platform_constraints`))
  });
}

function normalizeSearchReceipt(input, profileIds) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('search_receipt must be an object.');
  const enumerated = uniqueStrings(input.enumerated_profile_ids || [], 'search_receipt.enumerated_profile_ids').sort();
  const expected = [...profileIds].sort();
  if (enumerated.length !== expected.length || enumerated.some((id, index) => id !== expected[index])) {
    throw new Error('search_receipt.enumerated_profile_ids must exactly match profiles.');
  }
  const excluded = Array.isArray(input.excluded_candidates) ? input.excluded_candidates.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`search_receipt.excluded_candidates[${index}] must be an object.`);
    return Object.freeze({
      id: clean(entry.id, `search_receipt.excluded_candidates[${index}].id`, 200),
      reasons: Object.freeze(uniqueStrings(entry.reasons || [], `search_receipt.excluded_candidates[${index}].reasons`, { allowEmpty: false })),
      evidence_digests: Object.freeze(digestList(entry.evidence_digests || [], `search_receipt.excluded_candidates[${index}].evidence_digests`, { allowEmpty: false }))
    });
  }) : [];
  return Object.freeze({
    complete: input.complete === true,
    generator_digest: exactDigest(input.generator_digest, 'search_receipt.generator_digest'),
    candidate_space_digest: exactDigest(input.candidate_space_digest, 'search_receipt.candidate_space_digest'),
    enumerated_profile_ids: Object.freeze(enumerated),
    excluded_candidates: Object.freeze(excluded)
  });
}

export function validateFrontierManifest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Frontier manifest must be an object.');
  if (input.schema !== ARCHIE_LAUNCH_FRONTIER_MANIFEST_SCHEMA) {
    throw new Error(`Frontier manifest schema must be ${ARCHIE_LAUNCH_FRONTIER_MANIFEST_SCHEMA}.`);
  }
  const target = validateFrontierTarget(input.target);
  const release = normalizeRelease(input.release);
  const objectiveIds = new Set(target.objectives.map(item => item.id));
  if (!Array.isArray(input.environments) || !input.environments.length) throw new Error('environments must be non-empty.');
  const environments = input.environments.map((entry, index) => normalizeEnvironment(entry, index, objectiveIds));
  if (new Set(environments.map(item => item.id)).size !== environments.length) throw new Error('Environment IDs must be unique.');
  const environmentIds = new Set(environments.map(item => item.id));
  if (!Array.isArray(input.profiles) || !input.profiles.length) throw new Error('profiles must be non-empty.');
  const profiles = input.profiles.map((entry, index) => normalizeProfile(entry, index, release, environmentIds, objectiveIds));
  if (new Set(profiles.map(item => item.id)).size !== profiles.length) throw new Error('Profile IDs must be unique.');
  const profileIds = new Set(profiles.map(item => item.id));
  for (const environment of environments) {
    if (environment.requested_default_profile_id && !profileIds.has(environment.requested_default_profile_id)) {
      throw new Error(`Environment ${environment.id} requests unknown default profile.`);
    }
  }
  const searchReceipt = normalizeSearchReceipt(input.search_receipt, profileIds);
  const body = {
    schema: ARCHIE_LAUNCH_FRONTIER_MANIFEST_SCHEMA,
    target,
    release,
    environments: Object.freeze(environments),
    profiles: Object.freeze(profiles),
    search_receipt: searchReceipt,
    claim_boundary: clean(input.claim_boundary, 'claim_boundary', 3000)
  };
  return Object.freeze({ ...body, manifest_digest: frontierDigest(body) });
}

function objectivePasses(objective, observed) {
  return objective.direction === 'max' ? observed >= objective.gate : observed <= objective.gate;
}

function noWorse(left, right, objective) {
  return objective.direction === 'max'
    ? left.objective_metrics[objective.id] >= right.objective_metrics[objective.id]
    : left.objective_metrics[objective.id] <= right.objective_metrics[objective.id];
}

function strictlyBetter(left, right, objective) {
  return objective.direction === 'max'
    ? left.objective_metrics[objective.id] > right.objective_metrics[objective.id]
    : left.objective_metrics[objective.id] < right.objective_metrics[objective.id];
}

export function profileDominates(left, right, targetInput) {
  const target = validateFrontierTarget(targetInput);
  if (left.environment_id !== right.environment_id) return false;
  return target.objectives.every(objective => noWorse(left, right, objective))
    && target.objectives.some(objective => strictlyBetter(left, right, objective));
}

function profileEligibility(profile, environment, target) {
  const reasons = [];
  if (profile.status !== 'admitted') reasons.push(`status:${profile.status}`);
  if (!profile.evidence_digests.length) reasons.push('missing-evidence');
  for (const authority of profile.required_authorities) {
    if (!environment.authority_grants.includes(authority)) reasons.push(`authority:${authority}`);
  }
  for (const [resource, used] of Object.entries(profile.resource_usage)) {
    const budget = environment.resource_budgets[resource];
    if (!Number.isFinite(budget)) reasons.push(`resource-budget-missing:${resource}`);
    else if (used > budget) reasons.push(`resource-exceeded:${resource}`);
  }
  const objectiveResults = target.objectives.map(objective => ({
    id: objective.id,
    group: objective.group,
    direction: objective.direction,
    gate: objective.gate,
    observed: profile.objective_metrics[objective.id],
    critical: objective.critical,
    passed: objectivePasses(objective, profile.objective_metrics[objective.id])
  }));
  for (const result of objectiveResults) if (result.critical && !result.passed) reasons.push(`objective:${result.id}`);
  return Object.freeze({ passed: reasons.length === 0, reasons: Object.freeze(reasons.sort()), objective_results: Object.freeze(objectiveResults) });
}

function lexicographicCompare(left, right, objectiveOrder, objectiveById) {
  for (const id of objectiveOrder) {
    const objective = objectiveById.get(id);
    const leftValue = left.objective_metrics[id];
    const rightValue = right.objective_metrics[id];
    if (leftValue === rightValue) continue;
    if (objective.direction === 'max') return rightValue - leftValue;
    return leftValue - rightValue;
  }
  return left.id.localeCompare(right.id);
}

function resolveEnvironment(manifest, environment) {
  const target = manifest.target;
  const profiles = manifest.profiles.filter(profile => profile.environment_id === environment.id);
  const eligibility = profiles.map(profile => ({ profile, eligibility: profileEligibility(profile, environment, target) }));
  const feasible = eligibility.filter(item => item.eligibility.passed).map(item => item.profile);
  const frontier = feasible.filter(candidate => !feasible.some(other => other.id !== candidate.id && profileDominates(other, candidate, target)))
    .sort((left, right) => left.id.localeCompare(right.id));
  const dominated = feasible.filter(candidate => !frontier.some(item => item.id === candidate.id)).map(candidate => ({
    id: candidate.id,
    dominated_by: feasible.filter(other => other.id !== candidate.id && profileDominates(other, candidate, target)).map(item => item.id).sort()
  }));
  let selectedProfileId = null;
  if (environment.selection_policy.mode === 'lexicographic' && frontier.length) {
    const objectiveById = new Map(target.objectives.map(item => [item.id, item]));
    selectedProfileId = [...frontier].sort((left, right) => lexicographicCompare(left, right, environment.selection_policy.objective_order, objectiveById))[0].id;
  }
  const requested = environment.requested_default_profile_id;
  const requestedIsDominated = Boolean(requested && dominated.some(item => item.id === requested));
  const requestedIsInfeasible = Boolean(requested && eligibility.some(item => item.profile.id === requested && !item.eligibility.passed));
  const environmentAdmitted = frontier.length > 0 && !requestedIsDominated && !requestedIsInfeasible;
  return Object.freeze({
    environment_id: environment.id,
    required_for_launch: environment.required_for_launch,
    decision: environmentAdmitted ? 'admitted-environment-frontier' : 'rejected-environment-frontier',
    selection_mode: environment.selection_policy.mode,
    primary_profile_id: selectedProfileId,
    frontier_profile_ids: Object.freeze(frontier.map(item => item.id)),
    adaptive_profile_set: environment.selection_policy.mode === 'adaptive-frontier' ? Object.freeze(frontier.map(item => item.id)) : Object.freeze([]),
    requested_default_profile_id: requested,
    requested_default_is_dominated: requestedIsDominated,
    requested_default_is_infeasible: requestedIsInfeasible,
    dominated_profiles: Object.freeze(dominated),
    rejected_profiles: Object.freeze(eligibility.filter(item => !item.eligibility.passed).map(item => ({
      id: item.profile.id,
      reasons: item.eligibility.reasons,
      objective_results: item.eligibility.objective_results
    }))),
    strongest_profile_proof: Object.freeze({
      pareto_frontier_computed: true,
      all_objectives_jointly_compared: true,
      intelligence_and_embodiment_compared_together: true,
      no_modality_preselected: true,
      no_primary_profile_without_explicit_selection_policy: environment.selection_policy.mode === 'adaptive-frontier',
      dominated_requested_default_rejected: !requestedIsDominated,
      feasible_profile_count: feasible.length,
      frontier_profile_count: frontier.length
    })
  });
}

export function resolveLaunchFrontierV2(input) {
  const manifest = validateFrontierManifest(input);
  const environments = manifest.environments.map(environment => resolveEnvironment(manifest, environment));
  const requiredEnvironmentsPass = environments.filter(item => item.required_for_launch).every(item => item.decision === 'admitted-environment-frontier');
  const searchComplete = manifest.search_receipt.complete;
  const admitted = requiredEnvironmentsPass && searchComplete;
  const body = {
    schema: ARCHIE_LAUNCH_FRONTIER_DECISION_SCHEMA,
    manifest_digest: manifest.manifest_digest,
    target_id: manifest.target.id,
    release_id: manifest.release.id,
    model_artifact_digest: manifest.release.model_artifact_digest,
    code_revision: manifest.release.code_revision,
    decision: admitted ? 'admitted-capability-frontier' : 'rejected-capability-frontier',
    search_complete: searchComplete,
    environments,
    excluded_candidates: manifest.search_receipt.excluded_candidates,
    compatibility_boundary: {
      v1_required_faculty_resolver_is_canonical: false,
      v1_machine_profile_resolver_may_be_used_as_backend: true,
      v2_frontier_decision_required_for_maximal_product_claim: true
    },
    claim_boundary: admitted
      ? 'This exact release may expose only the nondominated evidence-backed profile frontier for each exact environment. No chat, voice, screen, daemon, or always-on form is implied unless a frontier profile proves it.'
      : 'This release must not claim a maximal product frontier. Incomplete search, missing evidence, failed joint objectives, authority limits, resource limits, or a dominated default remain explicit.'
  };
  return Object.freeze({ ...body, decision_digest: frontierDigest(body) });
}
