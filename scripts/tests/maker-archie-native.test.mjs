import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { extractNativeMakerReceipt } from '../maker-archie-launch.mjs';
import {
  nativeMakerReceiptForCorpus,
  normalizeReusableMakerPlan,
  recallNativeMakerPlan,
  rememberNativeMakerRun,
  resolveNativeArchiePaths
} from '../maker-archie-native.mjs';

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archie-native-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function makerPlan() {
  return {
    title: 'Repair native Maker memory',
    branch_slug: 'repair-native-maker-memory',
    selected_lane: 'operator',
    why_now: 'Successful native runs currently never become reusable local plans.',
    owned_paths: ['scripts/maker-archie-native.mjs', 'scripts/maker-archie-launch.mjs'],
    implementation_prompt: 'Wire the receipt into Archie and prove recall.',
    focused_tests: ['node --test scripts/tests/maker-archie-native.test.mjs'],
    deferred: ['Do not merge automatically.']
  };
}

test('extracts the final native Maker receipt from streamed logs without being confused by braces in strings', () => {
  const receipt = {
    schema: 'sideways-maker-run/v2',
    request: 'repair {the} learning loop',
    session_id: 'native-1',
    state: 'completed',
    plan: makerPlan(),
    head_sha: 'abc123'
  };
  const output = `[writer] emitted {not-json}\n${JSON.stringify(receipt, null, 2)}\n[tail] done\n`;
  assert.deepEqual(extractNativeMakerReceipt(output), receipt);
});

test('normalizes current native Maker receipts into completed corpus evidence', () => {
  const receipt = {
    schema: 'sideways-maker-run/v2',
    request: 'Repair native Maker memory and prove local recall.',
    session_id: 'native-2',
    state: 'completed',
    selected_lane: 'operator',
    branch: 'maker/native-memory',
    base_sha: 'base456',
    head_sha: 'def456',
    pull_request: 'https://github.com/Pokitomas/theawesomehexapp/pull/999',
    verification: ['git diff --check', 'npm run verify:repository'],
    writer_summary: 'Implemented the memory bridge.',
    plan: makerPlan()
  };
  const normalized = nativeMakerReceiptForCorpus(receipt, { repoRoot: '/work/theawesomehexapp' });
  assert.equal(normalized.state, 'completed');
  assert.equal(normalized.task.request, receipt.request);
  assert.deepEqual(normalized.components.model_route.output.plan, normalizeReusableMakerPlan(receipt.plan));
  assert.equal(normalized.components.dispatch.adapter, 'native-maker-operator');
  assert.equal(normalized.components.control_job.result.pull_request, receipt.pull_request);
  assert.equal(normalized.components.model_route.attempts.length, 2);
  assert.equal(normalized.task.proof.base_sha, receipt.base_sha);
  assert.equal(normalized.task.proof.head_sha, receipt.head_sha);
});

test('stores a successful native Maker plan and recalls it locally on the repeated request', async t => {
  const root = await tempRoot(t);
  const repository = path.join(root, 'repository');
  const home = path.join(root, 'home');
  await fs.mkdir(repository, { recursive: true });
  const request = 'Repair native Maker memory and prove local recall.';
  const receipt = {
    schema: 'sideways-maker-run/v2',
    request,
    session_id: 'native-3',
    state: 'completed',
    selected_lane: 'operator',
    branch: 'maker/native-memory',
    base_sha: 'base-fedcba',
    head_sha: 'fedcba',
    pull_request: 'https://github.com/Pokitomas/theawesomehexapp/pull/1000',
    verification: ['node --test scripts/tests/maker-archie-native.test.mjs'],
    writer_summary: 'The current Maker receipt now trains the local plan mixture.',
    plan: makerPlan()
  };
  const env = {};
  const clock = () => '2026-07-16T08:00:00.000Z';
  const training = { dimensions: 512, threshold: 0.05, minimum_margin: 0.01 };

  const before = await recallNativeMakerPlan({ repoRoot: repository, request, baseSha: receipt.base_sha, home, env, clock, training });
  assert.equal(before.status, 'miss');

  const remembered = await rememberNativeMakerRun({ repoRoot: repository, receipt, home, env, clock, training });
  assert.equal(remembered.status, 'stored');
  assert.equal(remembered.document_count, 1);
  assert.equal(remembered.specialist_count, 1);

  const recalled = await recallNativeMakerPlan({ repoRoot: repository, request, baseSha: receipt.base_sha, home, env, clock, training });
  assert.equal(recalled.status, 'local');
  assert.equal(recalled.plan.selected_lane, 'operator');
  assert.deepEqual(recalled.plan.owned_paths, normalizeReusableMakerPlan(makerPlan()).owned_paths);
  assert.ok(recalled.confidence >= 0.05);
  assert.equal(recalled.execution_eligible, true);
  assert.equal(recalled.execution_basis.kind, 'normalized-exact-verified-recurrence');
  assert.equal(recalled.execution_basis.base_sha, receipt.base_sha);

  const moved = await recallNativeMakerPlan({ repoRoot: repository, request, baseSha: 'different-base', home, env, clock, training });
  assert.equal(moved.status, 'local');
  assert.equal(moved.execution_eligible, false);
  assert.match(moved.reason, /current base SHA/);

  const paths = resolveNativeArchiePaths(repository, { home, env });
  assert.equal(paths.root.startsWith(home), true);
  assert.equal(normalizeReusableMakerPlan({ title: 'incomplete' }), null);
});
