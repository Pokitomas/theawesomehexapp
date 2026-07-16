import crypto from 'node:crypto';

export const ARCHIE_LAUNCH_TARGET_SCHEMA = 'archie-launch-target/v1';
export const ARCHIE_LAUNCH_CANDIDATE_SCHEMA = 'archie-launch-candidate/v1';
export const ARCHIE_LAUNCH_DECISION_SCHEMA = 'archie-launch-decision/v1';

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

const OUTCOME_REQUIREMENTS = Object.freeze({
  'available-while-attention-is-occupied': Object.freeze([
    'audio-input',
    'audio-output',
    'duplex-turn-taking',
    'streaming-response'
  ]),
  'continue-without-open-window': Object.freeze([
    'durable-run-state',
    'background-execution',
    'suspend-resume-recovery',
    'user-governed-notification'
  ]),
  'notice-authorized-relevant-change': Object.freeze([
    'explicit-event-subscription',
    'background-execution',
    'interruption-policy',
    'user-governed-notification'
  ]),
  'perceive-the-active-digital-world': Object.freeze([
    'consent-bound-sensing',
    'screen-context',
    'multimodal-ingestion',
    'connected-tool-context'
  ]),
  'inspect-exact-work-when-precision-matters': Object.freeze([
    'artifact-workbench',
    'inspectable-transcript',
    'receipt-inspection',
    'unfinished-obligation-inspection'
  ]),
  'move-between-devices-without-losing-authority': Object.freeze([
    'authenticated-device-handoff',
    'encrypted-continuity',
    'capability-revocation'
  ]),
  'operate-privately-on-ordinary-hardware': Object.freeze([
    'local-model-execution',
    'offline-core-operation',
    'resource-adaptive-runtime'
  ])
});

// These are derived recommendations, not the only interfaces a candidate may use.
const PRODUCT_FORMS = Object.freeze([
  Object.freeze({
    id: 'spoken-companion',
    kind: 'interaction-adapter',
    requires: ['audio-input', 'audio-output', 'duplex-turn-taking', 'streaming-response'],
    contributes: ['available-while-attention-is-occupied']
  }),
  Object.freeze({
    id: 'ambient-runtime',
    kind: 'continuity-adapter',
    requires: ['durable-run-state', 'background-execution', 'suspend-resume-recovery', 'explicit-event-subscription', 'interruption-policy', 'user-governed-notification'],
    contributes: ['continue-without-open-window', 'notice-authorized-relevant-change']
  }),
  Object.freeze({
    id: 'visual-workbench',
    kind: 'precision-adapter',
    requires: ['screen-context', 'multimodal-ingestion', 'artifact-workbench', 'inspectable-transcript', 'receipt-inspection', 'unfinished-obligation-inspection'],
    contributes: ['perceive-the-active-digital-world', 'inspect-exact-work-when-precision-matters']
  }),
  Object.freeze({
    id: 'tool-and-automation-bridge',
    kind: 'execution-adapter',
    requires: ['connected-tool-context', 'consent-bound-sensing'],
    contributes: ['perceive-the-active-digital-world']
  }),
  Object.freeze({
    id: 'device-continuity-plane',
    kind: 'continuity-adapter',
    requires: ['authenticated-device-handoff', 'encrypted-continuity', 'capability-revocation'],
    contributes: ['move-between-devices-without-losing-authority']
  }),
  Object.freeze({
    id: 'private-local-runtime',
    kind: 'runtime-adapter',
    requires: ['local-model-execution', 'offline-core-operation', 'resource-adaptive-runtime'],
    contributes: ['operate-privately-on-ordinary-hardware']
  }),
  Object.freeze({
    id: 'text-and-receipt-console',
    kind: 'fallback-and-audit-adapter',
    requires: ['inspectable-transcript', 'receipt-inspection'],
    contributes: ['inspect-exact-work-when-precision-matters']
  })
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}

export function stableJSONStringify(value) {
  return JSON.stringify(stable(value));
}

export function digest(value) {
  return crypto.createHash('sha256').update(stableJSONStringify(value)).digest('hex');
}

function clean(value, field, limit = 10_000) {
  const text = String(value ?? '').replace(/\u0000/g, '').trim();
  if (!text) throw new Error(`${field} is required.`);
  if (text.length > limit) throw new Error(`${field} exceeds ${limit} characters.`);
  return text;
}

function exactDigest(value, field) {
  const text = clean(value, field, 64);
  if (!DIGEST_PATTERN.test(text)) throw new Error(`${field} must be a lowercase SHA-256 digest.`);
  return text;
}

function uniqueStrings(values, field) {
  if (!Array.isArray(values)) throw new Error(`${field} must be an array.`);
  const output = [];
  const seen = new Set();
  values.forEach((value, index) => {
    const text = clean(value, `${field}[${index}]`, 300);
    if (seen.has(text)) throw new Error(`${field} contains duplicate value ${text}.`);
    seen.add(text);
    output.push(text);
  });
  return output;
}

function evidenceDigests(values, field) {
  if (!Array.isArray(values)) throw new Error(`${field} must be an array.`);
  const output = values.map((value, index) => exactDigest(value, `${field}[${index}]`));
  if (new Set(output).size !== output.length) throw new Error(`${field} contains duplicate evidence digests.`);
  return output;
}

function finiteMetric(value, field, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${field} must be finite.`);
  if (name.includes('_rate') && (number < 0 || number > 1)) throw new Error(`${field} must be between 0 and 1.`);
  return number;
}

export function validateLaunchTarget(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Launch target must be an object.');
  if (input.schema !== ARCHIE_LAUNCH_TARGET_SCHEMA) throw new Error(`Launch target schema must be ${ARCHIE_LAUNCH_TARGET_SCHEMA}.`);
  const outcomes = Array.isArray(input.human_outcomes) ? input.human_outcomes.map((outcome, index) => {
    if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) throw new Error(`human_outcomes[${index}] must be an object.`);
    const id = clean(outcome.id, `human_outcomes[${index}].id`, 200);
    const explicitRequirements = outcome.required_faculties === undefined
      ? null
      : uniqueStrings(outcome.required_faculties, `human_outcomes[${index}].required_faculties`);
    if (!explicitRequirements && !OUTCOME_REQUIREMENTS[id]) throw new Error(`Unknown human outcome ${id}; define required_faculties explicitly.`);
    return Object.freeze({
      id,
      critical: outcome.critical !== false,
      statement: clean(outcome.statement, `human_outcomes[${index}].statement`, 2000),
      required_faculties: Object.freeze(explicitRequirements || [...OUTCOME_REQUIREMENTS[id]])
    });
  }) : [];
  if (!outcomes.length) throw new Error('Launch target requires at least one human outcome.');
  if (new Set(outcomes.map(outcome => outcome.id)).size !== outcomes.length) throw new Error('Launch target contains duplicate human outcome IDs.');

  const intelligence = input.intelligence_target;
  if (!intelligence || typeof intelligence !== 'object' || Array.isArray(intelligence)) throw new Error('intelligence_target must be an object.');
  const minimumMetrics = {};
  for (const [nameInput, value] of Object.entries(intelligence.minimum_metrics || {})) {
    const name = clean(nameInput, 'intelligence_target.minimum_metrics key', 200);
    minimumMetrics[name] = finiteMetric(value, `intelligence_target.minimum_metrics.${name}`, name);
  }
  if (!Object.keys(minimumMetrics).length) throw new Error('intelligence_target.minimum_metrics must be non-empty.');

  const policy = input.launch_policy;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('launch_policy must be an object.');
  const requiredPolicy = [
    'joint_intelligence_and_embodiment_admission',
    'strongest_admitted_product_form',
    'single_canonical_interface',
    'chat_window_is_architecture',
    'voice_is_architecture',
    'always_on_daemon_is_architecture',
    'shell_without_brain_may_launch',
    'brain_without_required_access_may_launch',
    'all_critical_outcomes_required',
    'degraded_private_mode_required',
    'maximal_first_release'
  ];
  for (const key of requiredPolicy) {
    if (typeof policy[key] !== 'boolean') throw new Error(`launch_policy.${key} must be boolean.`);
  }

  return Object.freeze({
    schema: ARCHIE_LAUNCH_TARGET_SCHEMA,
    id: clean(input.id, 'id', 200),
    claim_boundary: clean(input.claim_boundary, 'claim_boundary', 2000),
    intelligence_target: Object.freeze({
      domains: Object.freeze(uniqueStrings(intelligence.domains, 'intelligence_target.domains')),
      minimum_metrics: Object.freeze(minimumMetrics),
      requirements: Object.freeze(uniqueStrings(intelligence.requirements, 'intelligence_target.requirements'))
    }),
    human_outcomes: Object.freeze(outcomes),
    launch_policy: Object.freeze({ ...policy })
  });
}

export function deriveLaunchRequirements(targetInput) {
  const target = validateLaunchTarget(targetInput);
  const facultyMap = new Map();
  for (const outcome of target.human_outcomes) {
    for (const faculty of outcome.required_faculties) {
      const current = facultyMap.get(faculty) || { id: faculty, critical: false, required_by: [] };
      current.critical ||= outcome.critical;
      current.required_by.push(outcome.id);
      facultyMap.set(faculty, current);
    }
  }
  const faculties = [...facultyMap.values()]
    .map(item => Object.freeze({ ...item, required_by: Object.freeze([...new Set(item.required_by)].sort()) }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const productForms = PRODUCT_FORMS
    .filter(form => form.requires.some(faculty => facultyMap.has(faculty)))
    .map(form => Object.freeze({
      ...form,
      requires: Object.freeze([...form.requires]),
      contributes: Object.freeze(form.contributes.filter(outcome => target.human_outcomes.some(item => item.id === outcome)))
    }));
  const body = {
    schema: 'archie-derived-launch-requirements/v1',
    target_id: target.id,
    intelligence: target.intelligence_target,
    faculties,
    recommended_product_forms: productForms,
    product_form_rule: 'admit every evidence-backed interface needed to cover the required faculties; recommendations are not canonical interfaces'
  };
  return Object.freeze({ ...body, requirements_digest: digest(body) });
}

export function validateLaunchCandidate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Launch candidate must be an object.');
  if (input.schema !== ARCHIE_LAUNCH_CANDIDATE_SCHEMA) throw new Error(`Launch candidate schema must be ${ARCHIE_LAUNCH_CANDIDATE_SCHEMA}.`);
  const faculties = {};
  for (const [idInput, entry] of Object.entries(input.faculties || {})) {
    const id = clean(idInput, 'faculty id', 200);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`faculties.${id} must be an object.`);
    const status = clean(entry.status, `faculties.${id}.status`, 100);
    if (!['admitted', 'experimental', 'absent'].includes(status)) throw new Error(`faculties.${id}.status is unsupported.`);
    const evidence = entry.evidence === undefined ? [] : evidenceDigests(entry.evidence, `faculties.${id}.evidence`);
    if (status === 'admitted' && !evidence.length) throw new Error(`faculties.${id} cannot be admitted without evidence.`);
    faculties[id] = Object.freeze({ status, evidence: Object.freeze(evidence) });
  }
  const interfaces = Array.isArray(input.interfaces) ? input.interfaces.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`interfaces[${index}] must be an object.`);
    const status = clean(entry.status, `interfaces[${index}].status`, 100);
    if (!['admitted', 'experimental', 'absent'].includes(status)) throw new Error(`interfaces[${index}].status is unsupported.`);
    const evidence = entry.evidence === undefined ? [] : evidenceDigests(entry.evidence, `interfaces[${index}].evidence`);
    if (status === 'admitted' && !evidence.length) throw new Error(`interfaces[${index}] cannot be admitted without evidence.`);
    const providedFaculties = uniqueStrings(entry.faculties || [], `interfaces[${index}].faculties`);
    if (status === 'admitted' && !providedFaculties.length) throw new Error(`interfaces[${index}] cannot be admitted without declared faculties.`);
    return Object.freeze({
      id: clean(entry.id, `interfaces[${index}].id`, 200),
      status,
      faculties: Object.freeze(providedFaculties),
      evidence: Object.freeze(evidence)
    });
  }) : [];
  if (new Set(interfaces.map(entry => entry.id)).size !== interfaces.length) throw new Error('Candidate contains duplicate interface IDs.');
  const metrics = {};
  for (const [nameInput, value] of Object.entries(input.metrics || {})) {
    const name = clean(nameInput, 'metric name', 200);
    metrics[name] = finiteMetric(value, `metrics.${name}`, name);
  }
  return Object.freeze({
    schema: ARCHIE_LAUNCH_CANDIDATE_SCHEMA,
    id: clean(input.id, 'candidate.id', 200),
    artifact_digest: exactDigest(input.artifact_digest, 'candidate.artifact_digest'),
    intelligence_report_digest: exactDigest(input.intelligence_report_digest, 'candidate.intelligence_report_digest'),
    authority_report_digest: exactDigest(input.authority_report_digest, 'candidate.authority_report_digest'),
    reproduction_receipt_digest: exactDigest(input.reproduction_receipt_digest, 'candidate.reproduction_receipt_digest'),
    domains: Object.freeze(uniqueStrings(input.domains, 'candidate.domains')),
    intelligence_requirements: Object.freeze(uniqueStrings(input.intelligence_requirements, 'candidate.intelligence_requirements')),
    metrics: Object.freeze(metrics),
    faculties: Object.freeze(faculties),
    interfaces: Object.freeze(interfaces)
  });
}

function metricPasses(name, target, observed) {
  if (name.endsWith('_max')) return observed <= target;
  return observed >= target;
}

export function evaluateLaunchCandidate(targetInput, candidateInput) {
  const target = validateLaunchTarget(targetInput);
  const candidate = validateLaunchCandidate(candidateInput);
  const requirements = deriveLaunchRequirements(target);

  const missingDomains = target.intelligence_target.domains.filter(domain => !candidate.domains.includes(domain));
  const missingIntelligenceRequirements = target.intelligence_target.requirements.filter(requirement => !candidate.intelligence_requirements.includes(requirement));
  const metricResults = Object.entries(target.intelligence_target.minimum_metrics).map(([name, threshold]) => {
    const observed = candidate.metrics[name];
    return Object.freeze({
      name,
      threshold,
      observed: observed ?? null,
      passed: observed !== undefined && metricPasses(name, threshold, observed)
    });
  });
  const intelligencePassed = missingDomains.length === 0
    && missingIntelligenceRequirements.length === 0
    && metricResults.every(result => result.passed);

  const missingFaculties = requirements.faculties.filter(requirement => candidate.faculties[requirement.id]?.status !== 'admitted');
  const selectedInterfaces = candidate.interfaces.filter(entry => {
    if (entry.status !== 'admitted') return false;
    return entry.faculties.every(faculty => candidate.faculties[faculty]?.status === 'admitted');
  });
  const coveredFaculties = new Set(selectedInterfaces.flatMap(entry => entry.faculties));
  const uncoveredByProductForm = requirements.faculties.filter(requirement => !coveredFaculties.has(requirement.id));
  const outcomeResults = target.human_outcomes.map(outcome => {
    const missing = outcome.required_faculties.filter(faculty => candidate.faculties[faculty]?.status !== 'admitted' || !coveredFaculties.has(faculty));
    return Object.freeze({ id: outcome.id, critical: outcome.critical, passed: missing.length === 0, missing_faculties: Object.freeze(missing) });
  });
  const criticalOutcomesPassed = outcomeResults.filter(outcome => outcome.critical).every(outcome => outcome.passed);
  const embodimentPassed = missingFaculties.length === 0
    && uncoveredByProductForm.length === 0
    && criticalOutcomesPassed;

  const policyViolations = [];
  if (!target.launch_policy.joint_intelligence_and_embodiment_admission) policyViolations.push('joint-admission-disabled');
  if (!target.launch_policy.strongest_admitted_product_form) policyViolations.push('strongest-product-form-disabled');
  if (target.launch_policy.single_canonical_interface) policyViolations.push('single-interface-precommitted');
  if (target.launch_policy.chat_window_is_architecture) policyViolations.push('chat-window-precommitted');
  if (target.launch_policy.voice_is_architecture) policyViolations.push('voice-precommitted');
  if (target.launch_policy.always_on_daemon_is_architecture) policyViolations.push('daemon-precommitted');
  if (target.launch_policy.shell_without_brain_may_launch) policyViolations.push('shell-without-brain-allowed');
  if (target.launch_policy.brain_without_required_access_may_launch) policyViolations.push('brain-without-access-allowed');
  if (!target.launch_policy.all_critical_outcomes_required) policyViolations.push('critical-outcome-gate-disabled');
  if (!target.launch_policy.degraded_private_mode_required) policyViolations.push('private-degraded-mode-disabled');
  if (!target.launch_policy.maximal_first_release) policyViolations.push('maximal-first-release-disabled');

  const admitted = intelligencePassed && embodimentPassed && policyViolations.length === 0;
  const body = {
    schema: ARCHIE_LAUNCH_DECISION_SCHEMA,
    target_id: target.id,
    candidate_id: candidate.id,
    candidate_artifact_digest: candidate.artifact_digest,
    intelligence_report_digest: candidate.intelligence_report_digest,
    authority_report_digest: candidate.authority_report_digest,
    reproduction_receipt_digest: candidate.reproduction_receipt_digest,
    requirements_digest: requirements.requirements_digest,
    decision: admitted ? 'admitted-maximal-launch' : 'rejected-incomplete-launch',
    intelligence: {
      passed: intelligencePassed,
      missing_domains: missingDomains,
      missing_requirements: missingIntelligenceRequirements,
      metrics: metricResults
    },
    embodiment: {
      passed: embodimentPassed,
      missing_faculties: missingFaculties.map(item => item.id),
      uncovered_by_product_form: uncoveredByProductForm.map(item => item.id),
      outcomes: outcomeResults,
      product_form: {
        primary_interface: null,
        selection_rule: requirements.product_form_rule,
        selected_surfaces: selectedInterfaces.map(entry => entry.id).sort()
      }
    },
    policy_violations: policyViolations,
    claim_boundary: admitted
      ? 'The candidate satisfies this exact target and digest-bound evidence contract; this does not imply untested capability outside it.'
      : 'The candidate must not launch as the maximal Archie product or imply satisfaction of unmet intelligence or embodiment requirements.'
  };
  return Object.freeze({ ...body, decision_digest: digest(body) });
}

export function productFormCatalog() {
  return PRODUCT_FORMS.map(form => ({ ...form, requires: [...form.requires], contributes: [...form.contributes] }));
}
