import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  TargetWorkspaceManager,
  createWorkspacePlan,
  digest,
  normalizeBaseRevision,
  normalizeRepositoryIdentity,
  normalizeWorkerBranch
} from '../maker-target-workspace.mjs';

const SHA = 'a'.repeat(40);

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-target-workspace-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function fakeGit({ sha = SHA, lfs = [], onClone, fail = null } = {}) {
  const calls = [];
  const executor = async command => {
    calls.push({
      program: command.program,
      args: [...command.args],
      cwd: command.cwd,
      env: { ...command.env }
    });
    const key = `${command.program} ${command.args.join(' ')}`;
    if (fail && key.includes(fail.match)) {
      const error = new Error(fail.message || 'simulated git failure');
      error.result = { stdout: '', stderr: fail.message || 'simulated git failure', code: fail.code || 1 };
      throw error;
    }
    if (command.program !== 'git') throw new Error(`unexpected program ${command.program}`);
    if (command.args[0] === 'clone') {
      const checkout = command.args.at(-1);
      await fs.mkdir(checkout, { recursive: true });
      if (onClone) await onClone(checkout);
      return { stdout: '', stderr: '', code: 0 };
    }
    if (command.args[0] === 'rev-parse' && command.args[1] === 'HEAD') return { stdout: `${sha}\n`, stderr: '', code: 0 };
    if (command.args[0] === 'rev-parse' && command.args[1] === '--is-shallow-repository') return { stdout: 'true\n', stderr: '', code: 0 };
    if (command.args[0] === 'status') return { stdout: '', stderr: '', code: 0 };
    if (command.args[0] === 'grep') {
      if (lfs.length) return { stdout: `${lfs.join('\n')}\n`, stderr: '', code: 0 };
      const error = new Error('no matches');
      error.result = { stdout: '', stderr: '', code: 1 };
      throw error;
    }
    return { stdout: '', stderr: '', code: 0 };
  };
  return { calls, executor };
}

function github(permission = 'write', overrides = {}) {
  const calls = [];
  return {
    calls,
    async inspectRepository(repository, credential) {
      calls.push({ repository, credential });
      return {
        exists: true,
        visible: true,
        permission,
        default_branch: 'main',
        private: false,
        archived: false,
        disabled: false,
        source: 'test',
        ...overrides
      };
    }
  };
}

test('repository, revision, branch, and workspace plan normalization is fail closed', () => {
  assert.equal(normalizeRepositoryIdentity('https://github.com/acme/widgets.git').repository, 'acme/widgets');
  assert.equal(normalizeRepositoryIdentity('acme/widgets').clone_url, 'https://github.com/acme/widgets.git');
  assert.equal(normalizeBaseRevision(SHA), SHA);
  assert.equal(normalizeWorkerBranch('maker/issue-1-run-1'), 'maker/issue-1-run-1');
  assert.throws(() => normalizeRepositoryIdentity('widgets'), /owner\/repository/);
  assert.throws(() => normalizeRepositoryIdentity('acme/widgets/escape'), /owner\/repository/);
  assert.throws(() => normalizeBaseRevision('../main'), /invalid/);
  assert.throws(() => normalizeWorkerBranch('bad branch'), /invalid/);
  const plan = createWorkspacePlan({
    control_repository: 'control/platform',
    target_repository: 'acme/widgets',
    base_revision: SHA,
    branch: 'maker/task',
    workspace_id: 'fixture',
    workspace_root: '/tmp/maker-fixture'
  });
  assert.equal(plan.same_repository, false);
  assert.equal(plan.exact_base_requested, true);
  assert.equal(plan.authority.merge, 'human');
  assert.ok(plan.checkout.endsWith('/fixture'));
});

test('prepare creates a clean exact-base branch and keeps credentials out of receipts', async t => {
  const root = await tempRoot(t);
  const transport = fakeGit();
  const broker = github('write');
  const manager = new TargetWorkspaceManager({
    workspace_root: root,
    executor: transport.executor,
    github: broker,
    random_id: () => 'success',
    clock: (() => {
      let tick = 0;
      return () => `2026-07-16T00:00:${String(tick++).padStart(2, '0')}.000Z`;
    })()
  });
  const secret = 'Bearer github_pat_123456789012345678901234567890';
  const result = await manager.prepare({
    control_repository: 'Pokitomas/theawesomehexapp',
    target_repository: 'acme/widgets',
    base_revision: 'main',
    branch: 'maker/issue-1-run-1',
    credential: { authorization_header: secret }
  });
  assert.equal(result.state.status, 'ready');
  assert.equal(result.state.base_sha, SHA);
  assert.equal(result.state.target_repository, 'acme/widgets');
  assert.equal(result.state.authorization.permission, 'write');
  assert.equal(result.state.shallow, true);
  assert.match(result.receipt.receipt_digest, /^[0-9a-f]{64}$/);
  const serialized = JSON.stringify(result.receipt);
  assert.ok(!serialized.includes(secret));
  assert.ok(!serialized.includes('github_pat_'));
  assert.ok(result.receipt.transcript.some(value => value.command.args[0] === 'clone'));
  const clone = transport.calls.find(value => value.args[0] === 'clone');
  assert.equal(clone.args.at(-2), 'https://github.com/acme/widgets.git');
  assert.equal(clone.env.GIT_CONFIG_VALUE_0, secret);
  const remoteSet = transport.calls.find(value => value.args[0] === 'remote' && value.args[1] === 'set-url');
  assert.equal(remoteSet.args.at(-1), 'https://github.com/acme/widgets.git');
  const state = await manager.readState('success');
  assert.equal(state.receipt_digest, result.receipt.receipt_digest);
});

test('cross-repository authorization rejects invisible and read-only targets before clone', async t => {
  const root = await tempRoot(t);
  const transport = fakeGit();
  const manager = new TargetWorkspaceManager({ workspace_root: root, executor: transport.executor, github: github('read'), random_id: () => 'denied' });
  await assert.rejects(manager.prepare({
    control_repository: 'control/platform',
    target_repository: 'acme/private',
    base_revision: 'main',
    branch: 'maker/task',
    credential: {}
  }), /authorization denied/);
  assert.equal(transport.calls.length, 0);

  const hidden = new TargetWorkspaceManager({ workspace_root: root, executor: transport.executor, github: github('admin', { visible: false }), random_id: () => 'hidden' });
  await assert.rejects(hidden.prepare({
    control_repository: 'control/platform',
    target_repository: 'acme/hidden',
    base_revision: 'main',
    branch: 'maker/task',
    credential: {}
  }), /authorization denied/);
});

test('exact SHA mismatch fails, removes the checkout, and returns a failure receipt', async t => {
  const root = await tempRoot(t);
  const transport = fakeGit({ sha: 'b'.repeat(40) });
  const manager = new TargetWorkspaceManager({ workspace_root: root, executor: transport.executor, github: github('write'), random_id: () => 'mismatch' });
  let failure;
  try {
    await manager.prepare({
      control_repository: 'control/platform',
      target_repository: 'acme/widgets',
      base_revision: SHA,
      branch: 'maker/task',
      credential: {}
    });
  } catch (error) {
    failure = error;
  }
  assert.match(failure.message, /differs from requested/);
  assert.equal(failure.receipt.status, 'failed');
  assert.match(failure.receipt.receipt_digest, /^[0-9a-f]{64}$/);
  await assert.rejects(fs.stat(path.join(root, 'mismatch')));
});

test('contaminated reused workspaces are rejected without deleting user files', async t => {
  const root = await tempRoot(t);
  const checkout = path.join(root, 'contaminated');
  await fs.mkdir(checkout, { recursive: true });
  await fs.writeFile(path.join(checkout, 'user.txt'), 'keep me\n');
  const transport = fakeGit();
  const manager = new TargetWorkspaceManager({ workspace_root: root, executor: transport.executor, github: github('write'), random_id: () => 'contaminated' });
  await assert.rejects(manager.prepare({
    control_repository: 'control/platform',
    target_repository: 'acme/widgets',
    base_revision: 'main',
    branch: 'maker/task',
    credential: {}
  }), /contaminated/);
  assert.equal(await fs.readFile(path.join(checkout, 'user.txt'), 'utf8'), 'keep me\n');
  assert.equal(transport.calls.length, 0);
});

test('submodules fail closed and Git LFS pointers remain explicit warnings', async t => {
  const root = await tempRoot(t);
  const withSubmodule = fakeGit({ onClone: checkout => fs.writeFile(path.join(checkout, '.gitmodules'), '[submodule "x"]\n') });
  const blocked = new TargetWorkspaceManager({ workspace_root: root, executor: withSubmodule.executor, github: github('write'), random_id: () => 'submodule' });
  await assert.rejects(blocked.prepare({
    control_repository: 'control/platform',
    target_repository: 'acme/widgets',
    base_revision: 'main',
    branch: 'maker/task',
    credential: {}
  }), /submodules/);

  const lfs = fakeGit({ lfs: ['assets/model.bin'] });
  const warned = new TargetWorkspaceManager({ workspace_root: root, executor: lfs.executor, github: github('write'), random_id: () => 'lfs' });
  const result = await warned.prepare({
    control_repository: 'control/platform',
    target_repository: 'acme/widgets',
    base_revision: 'main',
    branch: 'maker/task',
    credential: {}
  });
  assert.deepEqual(result.state.lfs_pointers, ['assets/model.bin']);
  assert.match(result.state.warnings.join('\n'), /LFS pointer/);
});

test('default branch drift is surfaced rather than silently changing requested main', async t => {
  const root = await tempRoot(t);
  const transport = fakeGit();
  const manager = new TargetWorkspaceManager({
    workspace_root: root,
    executor: transport.executor,
    github: github('write', { default_branch: 'trunk' }),
    random_id: () => 'drift'
  });
  const result = await manager.prepare({
    control_repository: 'control/platform',
    target_repository: 'acme/widgets',
    base_revision: 'main',
    branch: 'maker/task',
    credential: {}
  });
  assert.match(result.state.warnings.join('\n'), /differs from target default branch trunk/);
  const fetch = transport.calls.find(value => value.args[0] === 'fetch');
  assert.equal(fetch.args.at(-1), 'main');
});

test('clone and fetch failures are classified with command evidence and cleanup', async t => {
  const root = await tempRoot(t);
  for (const match of ['clone', 'fetch']) {
    const transport = fakeGit({ fail: { match: `git ${match}`, message: `${match} unavailable` } });
    const manager = new TargetWorkspaceManager({ workspace_root: root, executor: transport.executor, github: github('write'), random_id: () => `failure-${match}` });
    let failure;
    try {
      await manager.prepare({
        control_repository: 'control/platform',
        target_repository: 'acme/widgets',
        base_revision: 'main',
        branch: 'maker/task',
        credential: {}
      });
    } catch (error) {
      failure = error;
    }
    assert.match(failure.message, new RegExp(`${match} unavailable`));
    assert.equal(failure.receipt.status, 'failed');
    assert.ok(failure.receipt.transcript.some(value => value.ok === false));
    await assert.rejects(fs.stat(path.join(root, `failure-${match}`)));
  }
});

test('rollback resets and cleans while cleanup removes only the owned workspace', async t => {
  const root = await tempRoot(t);
  const transport = fakeGit();
  const manager = new TargetWorkspaceManager({ workspace_root: root, executor: transport.executor, github: github('write'), random_id: () => 'lifecycle' });
  const prepared = await manager.prepare({
    control_repository: 'control/platform',
    target_repository: 'acme/widgets',
    base_revision: 'main',
    branch: 'maker/task',
    credential: {}
  });
  await fs.writeFile(path.join(prepared.plan.checkout, 'untracked.txt'), 'temporary\n');
  const rolledBack = await manager.rollback('lifecycle', { reason: 'test repair failed' });
  assert.equal(rolledBack.status, 'rolled_back');
  assert.ok(transport.calls.some(value => value.args[0] === 'reset' && value.args.includes(SHA)));
  assert.ok(transport.calls.some(value => value.args[0] === 'clean'));
  const cleaned = await manager.cleanup('lifecycle', { reason: 'done' });
  assert.equal(cleaned.status, 'cleaned');
  await assert.rejects(fs.stat(prepared.plan.checkout));
  const state = await manager.readState('lifecycle');
  assert.equal(state.status, 'cleaned');
});

test('workspace receipts are deterministic for equivalent evidence', () => {
  assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 }));
});
