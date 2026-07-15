import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SNAPSHOT_SCHEMA,
  PLAN_SCHEMA,
  buildIntegrationPlan,
  normalizePath,
  pathsOverlap
} from '../swarm-integration-plan.mjs';

const BASE = '5bc28784e1634334dacba624d19fcb87ee8c2cd7';

function lease(paths) {
  return {
    owned_paths: paths,
    writer_count: 1,
    base_sha: BASE,
    authority: { merge: 'human', deploy: 'human' }
  };
}

function pr(number, overrides = {}) {
  return {
    number,
    title: `PR ${number}`,
    branch: `agent/pr-${number}`,
    head_sha: `${number}`.padStart(40, '0'),
    base_sha: BASE,
    state: 'open',
    draft: true,
    role: 'worker',
    changed_paths: [`lane/${number}.txt`],
    lease: lease([`lane/${number}.txt`]),
    ci: { status: 'success', exact_head: true, run_count: 1 },
    review_status: 'none',
    ...overrides
  };
}

function snapshot(prs) {
  return {
    schema: SNAPSHOT_SCHEMA,
    repository: 'Pokitomas/theawesomehexapp',
    base_branch: 'main',
    base_sha: BASE,
    prs
  };
}

test('path normalization and prefix overlap are deterministic and traversal-safe', () => {
  assert.equal(normalizePath('./foundry/**'), 'foundry');
  assert.equal(pathsOverlap('foundry', 'foundry/runtime.mjs'), true);
  assert.equal(pathsOverlap('foundry', 'scripts/foundry.mjs'), false);
  assert.throws(() => normalizePath('../escape'), /traversal/);
  assert.throws(() => normalizePath('foo/*.mjs'), /terminal/);
});

test('independent exact-head green PRs remain parallel candidates', () => {
  const plan = buildIntegrationPlan(snapshot([pr(1), pr(2)]));
  assert.equal(plan.schema, PLAN_SCHEMA);
  assert.equal(plan.status, 'ready_for_coordinator_composition');
  assert.deepEqual(plan.admissible_prs, [1, 2]);
  assert.deepEqual(plan.stages.map(stage => stage.type), ['independent_candidate', 'independent_candidate']);
});

test('overlapping PRs require exactly one declared composition target', () => {
  const plan = buildIntegrationPlan(snapshot([
    pr(1, { changed_paths: ['package.json'], lease: lease(['package.json']) }),
    pr(2, { changed_paths: ['package.json'], lease: lease(['package.json']) })
  ]));
  assert.equal(plan.status, 'held');
  assert.equal(plan.stages[0].type, 'coordinator_hold');

  const resolved = buildIntegrationPlan(snapshot([
    pr(1, { changed_paths: ['package.json'], lease: lease(['package.json']) }),
    pr(2, { changed_paths: ['package.json'], lease: lease(['package.json']), composition_target: true })
  ]));
  assert.equal(resolved.status, 'ready_for_coordinator_composition');
  assert.equal(resolved.stages[0].type, 'coordinator_compose');
  assert.equal(resolved.stages[0].target_pr, 2);
});

test('managed branches fail closed on missing or under-scoped leases', () => {
  const missing = buildIntegrationPlan(snapshot([pr(1, { lease: null })]));
  assert.equal(missing.status, 'held');
  assert.ok(missing.blockers.some(item => item.code === 'missing_lease'));

  const escaped = buildIntegrationPlan(snapshot([
    pr(1, { changed_paths: ['package.json'], lease: lease(['scripts/only.mjs']) })
  ]));
  assert.ok(escaped.blockers.some(item => item.code === 'changed_path_outside_lease'));
});

test('secret-bearing snapshot fields are rejected before planning', () => {
  const value = snapshot([pr(1)]);
  value.prs[0].api_token = 'do-not-store';
  assert.throws(() => buildIntegrationPlan(value), /secret-bearing/);
});

test('stale bases, non-exact green CI, action-required CI, and requested changes hold a PR', () => {
  const plan = buildIntegrationPlan(snapshot([
    pr(1, { base_sha: 'old' }),
    pr(2, { ci: { status: 'success', exact_head: false } }),
    pr(3, { ci: { status: 'action_required', exact_head: true } }),
    pr(4, { review_status: 'changes_requested' })
  ]));
  const codes = new Set(plan.blockers.map(item => item.code));
  assert.ok(codes.has('stale_base_sha'));
  assert.ok(codes.has('ci_not_exact_head'));
  assert.ok(codes.has('ci_not_admissible'));
  assert.ok(codes.has('changes_requested'));
  assert.deepEqual(plan.held_prs, [1, 2, 3, 4]);
});

test('dependency cycles are preserved as explicit global blockers', () => {
  const plan = buildIntegrationPlan(snapshot([
    pr(1, { depends_on: [2] }),
    pr(2, { depends_on: [1] })
  ]));
  assert.equal(plan.status, 'held');
  assert.equal(plan.global_blockers[0].code, 'dependency_cycle');
});

test('current repository constellation yields independent foundry, coordinator composition, and held Copilot recovery', () => {
  const plan = buildIntegrationPlan(snapshot([
    pr(249, {
      branch: 'agent/fullstack-takeover',
      head_sha: 'eb5a3626640cc2df46bb1890441b4b8622b63201',
      role: 'product',
      changed_paths: ['FULLSTACK_TAKEOVER_RECEIPT.md', 'audit/social-product-reachability.json', 'package.json', 'scripts/tests/social-author-controls.test.mjs', 'scripts/tests/social-product-reachability.test.mjs', 'studio/manual/imports/apply.py', 'studio/manual/product/social-author-controls.js'],
      lease: lease(['FULLSTACK_TAKEOVER_RECEIPT.md', 'audit/social-product-reachability.json', 'package.json', 'scripts/tests/social-author-controls.test.mjs', 'scripts/tests/social-product-reachability.test.mjs', 'studio/manual/imports/apply.py', 'studio/manual/product/social-author-controls.js'])
    }),
    pr(250, {
      branch: 'agent/maker-collision-gate',
      head_sha: 'ee9b388972e972627b93f8b6485fe5a642446892',
      role: 'collision-control',
      changed_paths: ['.github/workflows/maker-native-worker-ci.yml', '.github/workflows/maker-pr-collision-gate.yml', 'audit/authority-manifest.workflow-projection.mjs', 'maker/leases/agent-maker-collision-gate.json', 'scripts/maker-pr-collision-gate.mjs', 'scripts/tests/maker-pr-collision-gate.test.mjs', 'scripts/tests/workflow-permissions.test.mjs'],
      lease: lease(['.github/workflows/maker-native-worker-ci.yml', '.github/workflows/maker-pr-collision-gate.yml', 'audit/authority-manifest.workflow-projection.mjs', 'maker/leases/agent-maker-collision-gate.json', 'scripts/maker-pr-collision-gate.mjs', 'scripts/tests/maker-pr-collision-gate.test.mjs', 'scripts/tests/workflow-permissions.test.mjs'])
    }),
    pr(251, {
      branch: 'maker/complete-maker',
      head_sha: '45536b06baba8ae15e37bcd6d6c39556aa99bc9f',
      role: 'maker',
      composition_target: true,
      depends_on: [249, 250],
      changed_paths: ['.github/workflows/maker-native-worker-ci.yml', '.github/workflows/maker-sprawl.yml', 'AGENTS.md', 'NATIVE_MAKER.md', 'README.md', 'audit/authority-manifest.workflow-projection.mjs', 'audit/repository-verification.json', 'package.json', 'scripts/maker-core.mjs', 'scripts/maker.mjs', 'scripts/tests/maker-actions-sprawl.test.mjs', 'scripts/tests/maker-core.test.mjs'],
      lease: lease(['.github/workflows/maker-native-worker-ci.yml', '.github/workflows/maker-sprawl.yml', 'AGENTS.md', 'NATIVE_MAKER.md', 'README.md', 'audit', 'package.json', 'scripts/maker-core.mjs', 'scripts/maker.mjs', 'scripts/tests/maker-actions-sprawl.test.mjs', 'scripts/tests/maker-core.test.mjs'])
    }),
    pr(252, {
      branch: 'agent/native-model-foundry',
      head_sha: '59a7e602d2907b4c4bd122acc02d882a65b398af',
      role: 'foundry',
      changed_paths: ['MODEL_FOUNDRY.md', 'foundry/cli.mjs', 'foundry/core.mjs', 'foundry/directive.md', 'foundry/example-genome.json', 'foundry/example-mission.json', 'foundry/experiments.mjs', 'foundry/lease.json', 'foundry/protocol.mjs', 'foundry/run.mjs', 'foundry/runtime.mjs', 'foundry/tests/core.test.mjs', 'foundry/tests/mock-agent.mjs', 'foundry/tests/runtime.test.mjs', 'foundry/util.mjs'],
      lease: lease(['MODEL_FOUNDRY.md', 'foundry/**'])
    }),
    pr(253, {
      branch: 'copilot/build-parallel-agent-swarm',
      head_sha: 'eb44506ae5f899a7e76bb5b20577f4b9e7cd6215',
      role: 'adapter',
      changed_paths: ['foundry/README.md', 'foundry/agents/runtime.mjs', 'foundry/generation-1/agent-cartographer/findings.json', 'package.json', 'scripts/foundry-agent-cli.mjs', 'scripts/foundry-agent-spawner.mjs'],
      lease: null,
      ci: { status: 'action_required', exact_head: true, run_count: 18 },
      review_status: 'changes_requested'
    })
  ]));

  assert.equal(plan.status, 'held');
  assert.deepEqual(plan.held_prs, [253]);
  assert.ok(plan.stages.some(stage => stage.type === 'independent_candidate' && stage.prs[0] === 252));
  const composition = plan.stages.find(stage => stage.type === 'coordinator_compose');
  assert.deepEqual(composition.prs, [249, 250]);
  assert.equal(composition.target_pr, 251);
  assert.ok(composition.conflict_paths.some(path => path.includes('package.json')));
  assert.ok(plan.stages.some(stage => stage.type === 'held_recovery' && stage.prs.includes(253)));
});

test('output is deterministic regardless of input PR order', () => {
  const first = buildIntegrationPlan(snapshot([pr(2), pr(1)]));
  const second = buildIntegrationPlan(snapshot([pr(1), pr(2)]));
  assert.deepEqual(first, second);
});
