import assert from 'node:assert/strict';
import test from 'node:test';
import { archieMakerValueDigest, createArchieMakerDecision, verifyArchieMakerDecision } from '../maker-archie-runtime-contract.mjs';

const request = 'Complete the Archie intellect path.';
const repository = '/tmp/theawesomehexapp';
const baseSha = 'a'.repeat(40);
const key = 'k'.repeat(64);
const plan = {
  title: 'Complete Archie intellect path',
  branch_slug: 'archie-intellect',
  selected_lane: 'operator',
  why_now: 'The runtime should use a bounded teacher before redundant assessment.',
  owned_paths: ['scripts/maker-archie-native.mjs'],
  implementation_prompt: 'Implement the bounded teacher and verify all gates.',
  focused_tests: ['node --test scripts/tests/maker-archie-openai-runtime.test.mjs'],
  deferred: []
};

function teacherReceipt() {
  const body = {
    schema: 'archie-openai-teacher-receipt/v1',
    created_at: '2026-07-17T20:00:00.000Z',
    response_id: 'resp_fixture',
    teacher: 'openai-responses',
    model: 'gpt-5.1',
    request_digest: archieMakerValueDigest(request),
    context_digest: archieMakerValueDigest({ repository: 'theawesomehexapp', base_branch: 'main', base_sha: baseSha }),
    base_branch: 'main',
    base_sha: baseSha,
    plan_digest: archieMakerValueDigest(plan),
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    storage: 'disabled',
    effect_authority: 'maker-only'
  };
  return { ...body, receipt_digest: archieMakerValueDigest(body) };
}

test('fresh teacher plans enter Maker only through an integrity-bound current-base decision', () => {
  const receipt = teacherReceipt();
  const decision = createArchieMakerDecision({
    request,
    repository,
    baseBranch: 'main',
    baseSha,
    key,
    clock: () => '2026-07-17T20:00:00.000Z',
    recall: {
      status: 'teacher',
      plan,
      execution_eligible: true,
      execution_basis: {
        kind: 'fresh-bounded-teacher-plan',
        response_id: receipt.response_id,
        teacher_receipt_digest: receipt.receipt_digest,
        base_sha: baseSha
      },
      teacher_receipt: receipt
    }
  });
  assert.equal(decision.state, 'teacher');
  assert.equal(decision.source, 'openai-responses-teacher');
  assert.equal(decision.execution_basis.kind, 'fresh-bounded-teacher-plan');
  assert.deepEqual(verifyArchieMakerDecision(decision, { request, repository, baseBranch: 'main', baseSha, key, clock: () => '2026-07-17T20:01:00.000Z' }).plan, plan);
});

test('teacher plan tampering fails closed before Maker can use it', () => {
  const receipt = teacherReceipt();
  const recall = {
    status: 'teacher',
    plan,
    execution_eligible: true,
    execution_basis: { kind: 'fresh-bounded-teacher-plan', response_id: receipt.response_id, teacher_receipt_digest: receipt.receipt_digest, base_sha: baseSha },
    teacher_receipt: receipt
  };
  assert.throws(() => createArchieMakerDecision({ request, repository, baseBranch: 'main', baseSha, key, recall: { ...recall, plan: { ...plan, title: 'tampered' } } }), /plan does not match/);
  assert.throws(() => createArchieMakerDecision({ request, repository, baseBranch: 'main', baseSha, key, recall: { ...recall, teacher_receipt: { ...receipt, base_sha: 'b'.repeat(40) } } }), /base does not match/);
});
