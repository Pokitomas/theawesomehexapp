import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  ARCHIE_LAUNCH_CANDIDATE_SCHEMA,
  deriveLaunchRequirements,
  digest,
  evaluateLaunchCandidate,
  productFormCatalog,
  validateLaunchCandidate,
  validateLaunchTarget
} from '../archie-launch-contract.mjs';

const targetUrl = new URL('../../founder/archie-launch-target.json', import.meta.url);
const target = JSON.parse(await fs.readFile(targetUrl, 'utf8'));
const evidence = label => digest({ evidence: label });

function maximalCandidate(overrides = {}) {
  const requirements = deriveLaunchRequirements(target);
  const faculties = Object.fromEntries(requirements.faculties.map(item => [item.id, {
    status: 'admitted',
    evidence: [evidence(`faculty:${item.id}`)]
  }]));
  const interfaces = requirements.recommended_product_forms.map(form => ({
    id: form.id,
    status: 'admitted',
    faculties: [...form.requires],
    evidence: [evidence(`interface:${form.id}`)]
  }));
  return {
    schema: ARCHIE_LAUNCH_CANDIDATE_SCHEMA,
    id: 'candidate-maximal-fixture',
    artifact_digest: evidence('candidate-artifact'),
    intelligence_report_digest: evidence('intelligence-report'),
    authority_report_digest: evidence('authority-report'),
    reproduction_receipt_digest: evidence('reproduction-receipt'),
    domains: [...target.intelligence_target.domains],
    intelligence_requirements: [...target.intelligence_target.requirements],
    metrics: {
      cross_domain_completion_rate: 0.82,
      failure_repair_rate: 0.78,
      calibrated_abstention_rate: 0.9,
      false_completion_rate_max: 0.005,
      terminal_evidence_rate: 0.99
    },
    faculties,
    interfaces,
    ...overrides
  };
}

test('the founder target commits to outcomes and maximality without making one interface architectural', () => {
  const validated = validateLaunchTarget(target);
  assert.equal(validated.launch_policy.single_canonical_interface, false);
  assert.equal(validated.launch_policy.chat_window_is_architecture, false);
  assert.equal(validated.launch_policy.voice_is_architecture, false);
  assert.equal(validated.launch_policy.always_on_daemon_is_architecture, false);
  assert.equal(validated.launch_policy.joint_intelligence_and_embodiment_admission, true);
  assert.equal(validated.launch_policy.degraded_private_mode_required, true);
  assert.equal(validated.launch_policy.maximal_first_release, true);
  assert.ok(validated.human_outcomes.every(outcome => outcome.statement.length > 20));
});

test('Jarvis-like surfaces are recommendations derived from demanded outcomes rather than preselected as the product', () => {
  const requirements = deriveLaunchRequirements(target);
  const facultyIds = requirements.faculties.map(item => item.id);
  const formIds = requirements.recommended_product_forms.map(item => item.id);
  assert.ok(facultyIds.includes('audio-input'));
  assert.ok(facultyIds.includes('background-execution'));
  assert.ok(facultyIds.includes('screen-context'));
  assert.ok(facultyIds.includes('artifact-workbench'));
  assert.ok(facultyIds.includes('local-model-execution'));
  assert.ok(formIds.includes('spoken-companion'));
  assert.ok(formIds.includes('ambient-runtime'));
  assert.ok(formIds.includes('visual-workbench'));
  assert.ok(formIds.includes('private-local-runtime'));
  assert.match(requirements.product_form_rule, /recommendations are not canonical interfaces/);
});

test('changing the desired outcomes changes the required embodiment instead of preserving a hidden chat or voice axiom', () => {
  const precisionOnly = structuredClone(target);
  precisionOnly.id = 'precision-only-fixture';
  precisionOnly.human_outcomes = target.human_outcomes.filter(outcome => outcome.id === 'inspect-exact-work-when-precision-matters');
  const requirements = deriveLaunchRequirements(precisionOnly);
  const facultyIds = requirements.faculties.map(item => item.id);
  const formIds = requirements.recommended_product_forms.map(item => item.id);
  assert.equal(facultyIds.includes('audio-input'), false);
  assert.equal(facultyIds.includes('background-execution'), false);
  assert.equal(formIds.includes('spoken-companion'), false);
  assert.equal(formIds.includes('ambient-runtime'), false);
  assert.ok(formIds.includes('visual-workbench'));
  assert.ok(formIds.includes('text-and-receipt-console'));
});

test('a powerful brain without the access modes required by its ambition cannot launch', () => {
  const brainOnly = maximalCandidate({ faculties: {}, interfaces: [] });
  const decision = evaluateLaunchCandidate(target, brainOnly);
  assert.equal(decision.intelligence.passed, true);
  assert.equal(decision.embodiment.passed, false);
  assert.equal(decision.decision, 'rejected-incomplete-launch');
  assert.ok(decision.embodiment.missing_faculties.includes('audio-input'));
  assert.ok(decision.embodiment.missing_faculties.includes('background-execution'));
  assert.match(decision.claim_boundary, /must not launch/);
});

test('a polished multimodal shell without admitted general intelligence cannot launch', () => {
  const shellOnly = maximalCandidate({
    domains: ['software'],
    intelligence_requirements: [],
    metrics: {
      cross_domain_completion_rate: 0.1,
      failure_repair_rate: 0.1,
      calibrated_abstention_rate: 0.1,
      false_completion_rate_max: 0.5,
      terminal_evidence_rate: 0.2
    }
  });
  const decision = evaluateLaunchCandidate(target, shellOnly);
  assert.equal(decision.intelligence.passed, false);
  assert.equal(decision.embodiment.passed, true);
  assert.equal(decision.decision, 'rejected-incomplete-launch');
  assert.ok(decision.intelligence.missing_domains.includes('research'));
  assert.ok(decision.intelligence.metrics.some(metric => !metric.passed));
});

test('maximal launch jointly admits the brain and every evidence-backed recommended product form', () => {
  const decision = evaluateLaunchCandidate(target, maximalCandidate());
  assert.equal(decision.intelligence.passed, true);
  assert.equal(decision.embodiment.passed, true);
  assert.equal(decision.decision, 'admitted-maximal-launch');
  assert.equal(decision.embodiment.product_form.primary_interface, null);
  assert.deepEqual(
    decision.embodiment.product_form.selected_surfaces,
    productFormCatalog().map(form => form.id).sort()
  );
  assert.deepEqual(decision.policy_violations, []);
  assert.match(decision.decision_digest, /^[a-f0-9]{64}$/);
});

test('a different integrated interface may satisfy the same outcomes without becoming an architectural axiom', () => {
  const candidate = maximalCandidate();
  candidate.interfaces = [{
    id: 'integrated-access-surface',
    status: 'admitted',
    faculties: Object.keys(candidate.faculties),
    evidence: [evidence('interface:integrated-access-surface')]
  }];
  const decision = evaluateLaunchCandidate(target, candidate);
  assert.equal(decision.decision, 'admitted-maximal-launch');
  assert.deepEqual(decision.embodiment.product_form.selected_surfaces, ['integrated-access-surface']);
});

test('an experimental modality cannot be marketed as admitted launch embodiment', () => {
  const candidate = maximalCandidate();
  candidate.faculties['audio-input'] = { status: 'experimental', evidence: [evidence('prototype:audio-input')] };
  const decision = evaluateLaunchCandidate(target, candidate);
  assert.equal(decision.decision, 'rejected-incomplete-launch');
  assert.ok(decision.embodiment.missing_faculties.includes('audio-input'));
  assert.equal(decision.embodiment.product_form.selected_surfaces.includes('spoken-companion'), false);
});

test('launch evidence and rates fail closed instead of accepting prose or impossible metrics', () => {
  assert.throws(() => validateLaunchCandidate({
    ...maximalCandidate(),
    intelligence_report_digest: 'looks-good-to-me'
  }), /SHA-256/);
  assert.throws(() => validateLaunchCandidate({
    ...maximalCandidate(),
    metrics: { ...maximalCandidate().metrics, cross_domain_completion_rate: 4 }
  }), /between 0 and 1/);
  const candidate = maximalCandidate();
  candidate.interfaces[0].evidence = ['not-a-receipt'];
  assert.throws(() => validateLaunchCandidate(candidate), /SHA-256/);
});
