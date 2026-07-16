import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MakerToolBroker, normalizeToolLease, pathIsLeased } from '../../maker/runtime/tool-broker.mjs';
import { MakerSecurityPolicy } from '../maker-security-policy.mjs';

const BASE = 'a'.repeat(40);
const CLOCK = () => '2026-07-16T00:00:00.000Z';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-tool-broker-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'existing.txt'), 'alpha\nbeta\n', 'utf8');
  await fs.writeFile(path.join(root, 'README.md'), '# Fixture\n', 'utf8');
  return root;
}

function grant(capability, nonce, scope = {}, maxUses = 50) {
  return {
    capability,
    issued_by: 'kai',
    nonce,
    expires_at: '2026-07-16T02:00:00.000Z',
    human_approved: true,
    max_uses: maxUses,
    scope,
    reason: 'test authority'
  };
}

function security(extra = []) {
  return new MakerSecurityPolicy({
    clock: CLOCK,
    grants: [
      grant('write.file', 'write', { paths: ['src/**'] }),
      grant('delete.file', 'delete', { paths: ['src/**'] }),
      grant('command.execute', 'command', { commands: ['node --test scripts/tests/unit.test.mjs', 'npm ci --ignore-scripts'] }),
      grant('dependency.install', 'dependency', { hosts: ['registry.npmjs.org'] }),
      grant('adapter.browser.screenshot', 'browser'),
      ...extra
    ]
  });
}

function lease(overrides = {}) {
  return {
    base_sha: BASE,
    branch: 'maker/issue-303-test',
    writer_count: 1,
    owned_paths: ['src/**'],
    authority: { merge: 'human', deploy: 'human' },
    ...overrides
  };
}

function broker(root, overrides = {}) {
  return new MakerToolBroker({
    root,
    lease: lease(overrides.lease),
    security_policy: overrides.security || security(),
    command_allowlist: overrides.command_allowlist || [
      { program: 'node', args: ['--test'], prefix: true, timeout_ms: 5000, max_output_bytes: 100000 },
      { program: 'npm', args: ['ci', '--ignore-scripts'], network: true, container: true, timeout_ms: 5000 }
    ],
    adapters: overrides.adapters || {},
    executor: overrides.executor || (async command => ({ code: 0, stdout: `${command.program} ok`, stderr: '' })),
    state_path: overrides.state_path || null,
    clock: CLOCK
  });
}

test('tool leases are exact, one-writer, human-gated, and path bounded', () => {
  const normalized = normalizeToolLease(lease());
  assert.equal(normalized.writer_count, 1);
  assert.equal(normalized.authority.merge, 'human');
  assert.match(normalized.lease_digest, /^[0-9a-f]{64}$/);
  assert.equal(pathIsLeased('src/a.js', normalized), true);
  assert.equal(pathIsLeased('README.md', normalized), false);
  assert.throws(() => normalizeToolLease(lease({ writer_count: 2 })), /exactly one writer/);
  assert.throws(() => normalizeToolLease(lease({ authority: { merge: 'worker', deploy: 'human' } })), /cannot widen/);
  assert.throws(() => normalizeToolLease(lease({ owned_paths: ['../escape'] })), /repository-relative/);
});

test('list, read, and search are bounded and redact secret-bearing matching lines', async t => {
  const root = await fixture(t);
  const token = 'github_pat_123456789012345678901234567890';
  await fs.writeFile(path.join(root, 'src', 'secret.txt'), `ordinary\nBearer ${token}\n`, 'utf8');
  const tools = broker(root);
  const listing = await tools.list('src');
  assert.ok(listing.entries.some(value => value.path === 'src/existing.txt'));
  const read = await tools.read('src/existing.txt', { start: 2, end: 2 });
  assert.equal(read.content, 'beta');
  const search = await tools.search('Bearer', { prefix: 'src' });
  assert.equal(search.matches.length, 1);
  assert.match(search.matches[0].text, /\[REDACTED:/);
  assert.ok(!JSON.stringify(search).includes(token));
});

test('writes, exact replacements, deletes, and rollback preserve original files', async t => {
  const root = await fixture(t);
  const tools = broker(root);
  const created = await tools.write('src/new.txt', 'one\ntwo\n');
  assert.equal(created.created, true);
  const replacement = await tools.replace('src/existing.txt', 'beta', 'gamma', { expected: 1 });
  assert.equal(replacement.occurrences, 1);
  await tools.delete('src/existing.txt');
  await assert.rejects(fs.stat(path.join(root, 'src', 'existing.txt')));
  const rollback = await tools.rollback('test failure');
  assert.deepEqual(rollback.restored.sort(), ['src/existing.txt', 'src/new.txt']);
  assert.equal(await fs.readFile(path.join(root, 'src', 'existing.txt'), 'utf8'), 'alpha\nbeta\n');
  await assert.rejects(fs.stat(path.join(root, 'src', 'new.txt')));
});

test('mutations outside the lease and secret paths are rejected independently of policy grants', async t => {
  const root = await fixture(t);
  const tools = broker(root);
  await assert.rejects(tools.write('README.md', 'changed\n'), /outside the one-writer lease/);
  await assert.rejects(tools.write('.env', 'TOKEN=x\n'), /secret-like|blocked/);
  await assert.rejects(tools.delete('README.md'), /outside the one-writer lease/);
  assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), '# Fixture\n');
});

test('symlinks and hard links are denied before reads or writes', async t => {
  const root = await fixture(t);
  await fs.symlink(path.join(root, 'README.md'), path.join(root, 'src', 'link.txt'));
  const tools = broker(root);
  await assert.rejects(tools.read('src/link.txt'), /symlink/);
  const hard = path.join(root, 'src', 'hard.txt');
  await fs.link(path.join(root, 'src', 'existing.txt'), hard);
  await assert.rejects(tools.read('src/hard.txt'), /hard-linked/);
});

test('atomic replacement requires the exact expected occurrence count', async t => {
  const root = await fixture(t);
  const tools = broker(root);
  await assert.rejects(tools.replace('src/existing.txt', 'missing', 'x', { expected: 1 }), /found 0/);
  await tools.write('src/repeated.txt', 'x x x');
  await assert.rejects(tools.replace('src/repeated.txt', 'x', 'y', { expected: 1 }), /found 3/);
  assert.equal(await fs.readFile(path.join(root, 'src', 'repeated.txt'), 'utf8'), 'x x x');
});

test('argv-only commands execute with bounded allowlists and redacted output receipts', async t => {
  const root = await fixture(t);
  const token = 'github_pat_123456789012345678901234567890';
  const calls = [];
  const tools = broker(root, {
    executor: async command => {
      calls.push(command);
      return { code: 0, stdout: `success Bearer ${token}`, stderr: `token=${token}` };
    }
  });
  const run = await tools.run({
    operation_id: 'unit',
    program: 'node',
    args: ['--test', 'scripts/tests/unit.test.mjs'],
    origin: 'model_output',
    env: { CI: '1', GITHUB_TOKEN: token },
    secret_references: { GITHUB_TOKEN: 'github-actions-token' }
  });
  assert.equal(run.result.code, 0);
  assert.match(run.result.stdout, /\[REDACTED:/);
  assert.match(run.result.stderr, /\[REDACTED:/);
  assert.ok(!JSON.stringify(run).includes(token));
  assert.equal(calls[0].program, 'node');
  assert.deepEqual(calls[0].args, ['--test', 'scripts/tests/unit.test.mjs']);
  assert.equal(calls[0].env.GITHUB_TOKEN, token);
  assert.equal(tools.receipt().events.some(value => JSON.stringify(value).includes(token)), false);
});

test('shell strings, arbitrary programs, control newlines, devices, and lifecycle scripts fail closed', async t => {
  const root = await fixture(t);
  const tools = broker(root);
  await assert.rejects(tools.run({ program: 'bash', args: ['-lc', 'curl x'], shell: true }), /Command policy denied/);
  await assert.rejects(tools.run({ program: 'curl', args: ['https://example.com'] }), /not allowlisted/);
  await assert.rejects(tools.run({ program: 'node', args: ['--test\nrm -rf /'] }), /control newlines/);
  await assert.rejects(tools.run({ program: 'node', args: ['--test'], devices: ['/dev/kvm'] }), /device access/);
  await assert.rejects(tools.run({ program: 'npm', args: ['ci'], lifecycle_script: true }), /lifecycle scripts|not allowlisted/);
});

test('active commands can be cancelled through AbortSignal without fabricating success', async t => {
  const root = await fixture(t);
  let started;
  const began = new Promise(resolve => { started = resolve; });
  const tools = broker(root, {
    executor: command => new Promise((resolve, reject) => {
      started();
      command.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.code = 'ABORT_ERR';
        error.stderr = 'cancelled';
        reject(error);
      }, { once: true });
    })
  });
  const pending = tools.run({ operation_id: 'slow', program: 'node', args: ['--test', 'scripts/tests/unit.test.mjs'] });
  await began;
  const cancelled = tools.cancel('slow', 'operator stop');
  assert.equal(cancelled.cancelled, true);
  const result = await pending;
  assert.notEqual(result.result.code, 0);
  assert.equal(result.result.killed, true);
  assert.equal(tools.cancel('missing').cancelled, false);
});

test('dependency installation requires provenance and both dependency and command authority', async t => {
  const root = await fixture(t);
  const calls = [];
  const tools = broker(root, { executor: async command => { calls.push(command); return { code: 0, stdout: 'installed', stderr: '' }; } });
  const result = await tools.installDependency({
    dependency: {
      name: 'left-pad',
      version: '1.3.0',
      lockfile_present: true,
      integrity: 'sha512-abc',
      registry_host: 'registry.npmjs.org',
      allowed_registry_hosts: ['registry.npmjs.org'],
      lifecycle_scripts: false,
      license: 'MIT'
    },
    registry_host: 'registry.npmjs.org',
    command: { program: 'npm', args: ['ci', '--ignore-scripts'], ignore_scripts: true }
  });
  assert.equal(result.dependency.allowed, true);
  assert.equal(calls[0].program, 'npm');
  await assert.rejects(tools.installDependency({
    dependency: { name: 'lef-pad', version: '^1', lockfile_present: false, name_confusion: true },
    command: { program: 'npm', args: ['ci', '--ignore-scripts'], ignore_scripts: true }
  }), /Dependency policy denied/);
});

test('unconfigured adapters report truthful unavailable states and configured adapters require capability grants', async t => {
  const root = await fixture(t);
  const unavailable = await broker(root).invokeAdapter('browser', 'screenshot', { url: 'https://example.com' });
  assert.equal(unavailable.available, false);
  assert.match(unavailable.reason, /not configured/);

  const tools = broker(root, {
    adapters: {
      browser: {
        async invoke(action, payload) {
          return { action, url: payload.url, token: 'github_pat_123456789012345678901234567890' };
        }
      }
    }
  });
  const result = await tools.invokeAdapter('browser', 'screenshot', { url: 'https://example.com' });
  assert.equal(result.available, true);
  assert.equal(result.output.action, 'screenshot');
  assert.match(result.output.token, /\[REDACTED:/);
});

test('artifacts are hashed and registered without loading secret output into receipts', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'artifacts', 'proof.json'), '{"ok":true}\n', 'utf8');
  const tools = broker(root);
  const artifact = await tools.registerArtifact('artifacts/proof.json', { kind: 'test-proof' });
  assert.equal(artifact.kind, 'test-proof');
  assert.equal(artifact.bytes, 12);
  assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
  assert.equal(tools.receipt().artifacts['artifacts/proof.json'].sha256, artifact.sha256);
});

test('durable state contains tamper-evident redacted events and closes active authority', async t => {
  const root = await fixture(t);
  const statePath = path.join(root, '.maker-state.json');
  const tools = broker(root, { state_path: statePath });
  await tools.write('src/state.txt', 'state\n');
  const closed = await tools.close('verified');
  assert.equal(closed.status, 'closed');
  assert.match(closed.receipt_digest, /^[0-9a-f]{64}$/);
  assert.match(closed.terminal_digest, /^[0-9a-f]{64}$/);
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(state.status, 'closed');
  assert.equal(state.receipt.receipt_digest, closed.receipt_digest);
  await assert.rejects(tools.write('src/after.txt', 'no\n'), /terminal/);
});
