#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { inspectHumanQuality } from './human-quality-report.mjs';
import { inspectOperationsReality } from './operations-reality-report.mjs';
import { evaluateRankingFixture } from './ranking-evaluation.mjs';
import { loadShippedRootSource } from './shipped-kernel-source.mjs';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA40 = /^[0-9a-f]{40}$/i;

function readJson(root, relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), 'utf8'));
}

function checkedHead(root) {
  if (SHA40.test(String(process.env.GITHUB_SHA || ''))) return process.env.GITHUB_SHA.toLowerCase();
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return result.status === 0 && SHA40.test(result.stdout.trim()) ? result.stdout.trim().toLowerCase() : 'unknown';
}

function requirement(id, condition, evidence, detail = null) {
  return condition
    ? { id, status: 'verified', evidence, ...(detail ? { detail } : {}) }
    : { id, status: 'failed', evidence, ...(detail ? { detail } : {}) };
}

function allowedUnknowns(policy) {
  return new Set(policy.allowed_unsupported_boundaries || []);
}

function normalJourneyComplete(product) {
  const normalSteps = product.journey.filter(step => Number(step.step) <= 6);
  return normalSteps.length === 6 && normalSteps.every(step => step.state === 'implemented' && step.gap === null);
}

function operationsAuditComplete(audit) {
  const procedures = new Set((audit.procedures || []).map(item => item.id));
  return (audit.facts || []).every(fact => {
    if (fact.state === 'verified') return Array.isArray(fact.evidence) && fact.evidence.length > 0;
    if (fact.state === 'previously_verified') return Array.isArray(fact.evidence) && fact.evidence.length > 0 && fact.recheck_required === true && procedures.has(fact.procedure);
    return fact.state === 'unknown' && Array.isArray(fact.evidence) && fact.evidence.length === 0 && procedures.has(fact.procedure);
  }) && (audit.next_proof || []).every(item => procedures.has(item.procedure));
}

function repositoryManifestComplete(manifest) {
  const ids = new Set((manifest.suites || []).map(item => item.id));
  return ['remote', 'weave-v1', 'recursive-weave', 'native-maker', 'maker-orchestrator', 'social-memory', 'authority-manifest', 'workflow-permissions', 'deployment-receipt', 'human-quality', 'ranking-evaluation', 'operations-reality', 'release-completion', 'supply-chain', 'frankenstate'].every(id => ids.has(id));
}

export async function inspectReleaseCompletion({ root = defaultRoot, observedAt = new Date().toISOString() } = {}) {
  const policy = readJson(root, 'audit/release-completion.json');
  const product = readJson(root, policy.code_local_contracts.product);
  const archive = readJson(root, policy.code_local_contracts.archive);
  const social = readJson(root, policy.code_local_contracts.social);
  const rankingFixture = readJson(root, policy.code_local_contracts.ranking);
  const operationsAudit = readJson(root, policy.code_local_contracts.operations);
  const repositoryManifest = readJson(root, policy.code_local_contracts.repository);
  const quality = inspectHumanQuality({ root, observedAt });
  const operations = inspectOperationsReality({ root, observedAt });
  const rootSource = await loadShippedRootSource({ root });
  const ranking = evaluateRankingFixture(rankingFixture, { kernelSources: [rootSource] });
  const kernelParitySource = readFileSync(path.join(root, 'studio/manual/tests/kernel-parity.mjs'), 'utf8');
  const packageJson = readJson(root, 'package.json');

  const requirements = [
    requirement('ordinary_product_journey', normalJourneyComplete(product), [policy.code_local_contracts.product, 'scripts/root-product-completion.cjs', 'scripts/root-product-phone.mjs']),
    requirement('private_archive_durability', Array.isArray(archive.open_gaps) && archive.open_gaps.length === 0 && Array.isArray(archive.external_observation_limits), [policy.code_local_contracts.archive, 'studio/manual/product/survival-ledger.js', 'scripts/tests/archive-revival-contract.test.mjs']),
    requirement('complete_social_reachability', Array.isArray(social.server_only_operations) && social.server_only_operations.length === 0 && Array.isArray(social.highest_priority_gaps) && social.highest_priority_gaps.length === 0, [policy.code_local_contracts.social, 'studio/manual/product/social-governance-controls.js', 'scripts/tests/social-product-reachability.test.mjs']),
    requirement('shipped_kernel_ranking', ranking.schema === 'sideways-ranking-evaluation/v2' && ranking.source_binding === 'single-shipped-source' && ranking.source_evidence.every(item => item.ok) && ranking.delayed_feedback.raw_private_content === false && kernelParitySource.includes("source_binding !== 'root-and-manual'"), [policy.code_local_contracts.ranking, 'scripts/ranking-evaluation.mjs', 'scripts/shipped-kernel-source.mjs', 'studio/manual/tests/kernel-parity.mjs'], { source_binding: ranking.source_binding, fixture_digest: ranking.fixture_digest }),
    requirement('operations_procedures', operationsAuditComplete(operationsAudit) && operations.stale.length === 0, [policy.code_local_contracts.operations, 'scripts/operations-probe.mjs', 'OPERATIONS_RUNBOOK.md'], { external_unknowns: operations.unknown.map(item => item.id) }),
    requirement('runtime_quality_witnesses', quality.stale.length === 0 && quality.verified.some(item => item.id === 'root_phone_desktop_zoom_contrast_motion_keyboard_network') && quality.verified.some(item => item.id === 'blocked_storage_quota_and_restore_failure'), ['scripts/human-quality-report.mjs', 'scripts/root-product-phone.mjs', 'studio/manual/tests/survival-ledger-clickthrough.mjs'], { unsupported: quality.unknown.map(item => item.id) }),
    requirement('repository_verification_manifest', repositoryManifestComplete(repositoryManifest) && packageJson.scripts?.['verify:release'] === 'node --test scripts/tests/release-completion.test.mjs && node scripts/release-completion.mjs', [policy.code_local_contracts.repository, 'package.json']),
    requirement('security_authority_supply_chain', existsSync(path.join(root, 'audit/authority-manifest.workflow-projection.mjs')) && existsSync(path.join(root, 'scripts/tests/supply-chain-contract.test.mjs')) && existsSync(path.join(root, 'scripts/tests/workflow-permissions.test.mjs')), ['audit/authority-manifest.workflow-projection.mjs', 'scripts/tests/supply-chain-contract.test.mjs', 'scripts/tests/workflow-permissions.test.mjs'])
  ];

  const unsupported = [
    ...quality.unknown.map(item => item.id),
    'conventional_download_retention',
    'device_specific_storage_eviction',
    ...operations.unknown.map(item => item.id)
  ];
  const allowed = allowedUnknowns(policy);
  const unexpectedUnsupported = unsupported.filter(id => !allowed.has(id) && ![
    'live_pages_served_commit', 'github_pages_environment_protection', 'netlify_site_configuration', 'live_social_database_schema',
    'database_backup_and_restore', 'rollback_drill', 'production_rate_limits', 'secret_values_and_rotation',
    'self_hosted_maker_runner', 'production_cookie_behavior'
  ].includes(id));
  if (unexpectedUnsupported.length) requirements.push(requirement('unsupported_boundary_allowlist', false, ['audit/release-completion.json'], { unexpected: unexpectedUnsupported }));

  const failed = requirements.filter(item => item.status !== 'verified');
  return {
    schema: 'sideways-release-completion/v1',
    program: policy.program,
    checked_head_sha: checkedHead(root),
    observed_at: observedAt,
    code_local_status: failed.length ? 'failed' : 'verified',
    requirements,
    failed,
    ranking_receipt: {
      schema: ranking.schema,
      source_binding: ranking.source_binding,
      source_evidence: ranking.source_evidence,
      candidate_pool: ranking.candidate_pool,
      gate: ranking.gate,
      deltas: ranking.deltas,
      delayed_feedback: ranking.delayed_feedback,
      interpretation: ranking.interpretation
    },
    operations_status: operations.status,
    quality_status: quality.status,
    required_exact_head_workflows: policy.required_exact_head_workflows,
    workflow_admission: 'must be checked externally against this exact head SHA',
    post_merge_requirements: policy.post_merge_requirements,
    external_and_intentionally_unsupported: [...new Set(unsupported)].sort(),
    termination_rule: policy.termination_rule
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  inspectReleaseCompletion().then(report => {
    const output = process.env.RELEASE_COMPLETION_RECEIPT;
    if (output) writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    if (report.failed.length) process.exitCode = 1;
  }).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
