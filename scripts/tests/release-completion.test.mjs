import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspectReleaseCompletion } from '../release-completion.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = relative => readFile(path.join(root, relative), 'utf8');

test('release completion admits every code-local lane and preserves exact external boundaries', async () => {
  const report = await inspectReleaseCompletion({ root, observedAt: '2026-07-15T19:00:00.000Z' });
  assert.equal(report.schema, 'sideways-release-completion/v1');
  assert.equal(report.code_local_status, 'verified');
  assert.deepEqual(report.failed, []);
  const requirements = new Set(report.requirements.map(item => item.id));
  for (const id of [
    'ordinary_product_journey',
    'private_archive_durability',
    'complete_social_reachability',
    'shipped_kernel_ranking',
    'operations_procedures',
    'runtime_quality_witnesses',
    'repository_verification_manifest',
    'security_authority_supply_chain'
  ]) assert.ok(requirements.has(id), `missing release requirement ${id}`);
  assert.ok(report.requirements.every(item => item.status === 'verified' && item.evidence.length));
  assert.equal(report.ranking_receipt.schema, 'sideways-ranking-evaluation/v2');
  assert.equal(report.ranking_receipt.source_binding, 'single-shipped-source');
  assert.ok(report.ranking_receipt.source_evidence.every(item => item.ok));
  assert.equal(report.ranking_receipt.delayed_feedback.raw_private_content, false);
  assert.match(report.ranking_receipt.interpretation, /does not measure or prove satisfaction/i);
  assert.ok(report.required_exact_head_workflows.includes('Verify exact repository tree'));
  assert.ok(report.required_exact_head_workflows.includes('Kernel parity check'));
  assert.ok(report.required_exact_head_workflows.includes('Build and deploy manual root-kernel feed'));
  assert.match(report.workflow_admission, /exact head SHA/);
  assert.ok(report.external_and_intentionally_unsupported.includes('screen_reader_journeys'));
  assert.ok(report.external_and_intentionally_unsupported.includes('cross_browser_behavior'));
  assert.ok(report.external_and_intentionally_unsupported.includes('live_pages_served_commit'));
  assert.match(report.termination_rule, /terminate the completion swarm/i);
});

test('release policy forbids silent completion and requires post-merge deployment identity', async () => {
  const policy = JSON.parse(await read('audit/release-completion.json'));
  assert.equal(policy.schema, 'sideways-release-completion-policy/v1');
  assert.deepEqual(policy.prerequisite_issues, [257, 258, 259, 260, 261, 262]);
  assert.equal(new Set(policy.required_exact_head_workflows).size, policy.required_exact_head_workflows.length);
  assert.ok(policy.post_merge_requirements.some(item => /sentinel equals the final merge commit/i.test(item)));
  assert.ok(policy.post_merge_requirements.some(item => /no competing Maker or agent lease/i.test(item)));
  assert.match(policy.termination_rule, /Do not spawn speculative follow-on work/i);
});

test('program completion document separates demonstrated, external, and unsupported reality', async () => {
  const document = await read('PROGRAM_COMPLETION.md');
  for (const heading of ['Demonstrated code-local completion', 'Exact-head workflow admission', 'Post-merge deployment proof', 'External and intentionally unsupported boundaries', 'Termination']) assert.match(document, new RegExp(`## ${heading}`));
  assert.match(document, /\.well-known\/sideways-deployment\.json/);
  assert.match(document, /screen reader/i);
  assert.match(document, /Firefox|WebKit/);
  assert.match(document, /no speculative follow-on/i);
});
