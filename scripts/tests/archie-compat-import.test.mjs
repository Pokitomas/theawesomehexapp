import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWorkspaceEngine } from '../archie-workspace-core.mjs';
import { SafeFileWorkspaceProvider } from '../archie-workspace-file-provider.mjs';
import {
  importCompatibilitySource,
  restoreCompatibilityArchive,
  scanCompatibilitySource,
  verifyCompatibilityArchive
} from '../archie-compat-import.mjs';
import { importWorkspaceBundle, readWorkspaceBundle } from '../archie-workspace-portable.mjs';

async function tempRoot(t, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function fixture(t) {
  const root = await tempRoot(t, 'archie-compat-source-');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, '.git', 'refs', 'heads'), { recursive: true });
  await fs.mkdir(path.join(root, '.git', 'objects'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules', 'ignored'), { recursive: true });
  await fs.writeFile(path.join(root, 'README.md'), '# Existing program\n\nKeep this behavior.\n');
  await fs.writeFile(path.join(root, 'src', 'app.js'), "export const answer = 42;\n");
  await fs.writeFile(path.join(root, 'assets.bin'), Buffer.from([0, 1, 2, 3, 255]));
  await fs.writeFile(path.join(root, '.env'), 'SUPER_SECRET=must-not-leak\n');
  await fs.writeFile(path.join(root, 'node_modules', 'ignored', 'index.js'), 'ignored');
  await fs.writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await fs.writeFile(path.join(root, '.git', 'refs', 'heads', 'main'), 'a'.repeat(40) + '\n');
  await fs.writeFile(path.join(root, '.git', 'config'), `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://user:ghp_must_not_leak@github.com/example/legacy.git\n`);
  await fs.writeFile(path.join(root, '.git', 'objects', 'secret-object'), 'git object storage is excluded');
  try {
    await fs.symlink(path.join(root, 'README.md'), path.join(root, 'linked-readme'));
  } catch {}
  return root;
}

test('compatibility scan creates a bounded portable archive and demotes GitHub to redacted provenance', async t => {
  const sourceRoot = await fixture(t);
  const archive = await scanCompatibilitySource({ sourceRoot, label: 'Legacy order desk' });
  assert.equal(verifyCompatibilityArchive(archive).archive_digest, archive.archive_digest);
  assert.equal(archive.source.kind, 'local_git_directory');
  assert.equal(archive.source.absolute_path_preserved, false);
  assert.equal(archive.source.source_host_canonical, false);
  assert.deepEqual(archive.files.map(file => file.path), ['README.md', 'assets.bin', 'src/app.js']);
  assert.ok(archive.skipped.some(entry => entry.path === '.env' && entry.reason === 'sensitive_name'));
  assert.ok(archive.skipped.some(entry => entry.path === 'node_modules/' && entry.reason === 'generated_or_internal_directory'));
  assert.equal(archive.git.head_sha, 'a'.repeat(40));
  assert.equal(archive.git.remotes[0].kind, 'github');
  assert.match(archive.git.remotes[0].endpoint_digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(archive.git.remotes[0].raw_url_preserved, false);
  assert.equal(archive.git.canonical_runtime_authority, false);

  const serialized = JSON.stringify(archive);
  assert.equal(serialized.includes(sourceRoot), false);
  assert.equal(serialized.includes('must-not-leak'), false);
  assert.equal(serialized.includes('ghp_must_not_leak'), false);
  assert.equal(serialized.includes('github.com/example/legacy'), false);

  const restoreRoot = await tempRoot(t, 'archie-compat-restore-');
  const receipt = await restoreCompatibilityArchive({ archive, targetRoot: restoreRoot });
  assert.equal(receipt.archive_digest, archive.archive_digest);
  assert.equal(receipt.restored_files, 3);
  assert.equal(await fs.readFile(path.join(restoreRoot, 'README.md'), 'utf8'), '# Existing program\n\nKeep this behavior.\n');
  assert.equal(await fs.readFile(path.join(restoreRoot, 'src', 'app.js'), 'utf8'), "export const answer = 42;\n");
  assert.deepEqual(await fs.readFile(path.join(restoreRoot, 'assets.bin')), Buffer.from([0, 1, 2, 3, 255]));
  await assert.rejects(fs.stat(path.join(restoreRoot, '.env')), error => error.code === 'ENOENT');
});

test('compatibility import produces Archie-native evidence, portable replay, and clean-root restoration', async t => {
  const sourceRoot = await fixture(t);
  const home = await tempRoot(t, 'archie-compat-home-');
  const dataRoot = path.join(home, 'standalone');
  const provider = new SafeFileWorkspaceProvider(path.join(dataRoot, 'workspaces'));
  const engine = createWorkspaceEngine({ provider });
  const result = await importCompatibilitySource({
    engine,
    dataRoot,
    sourceRoot,
    label: 'Legacy order desk',
    visibility: 'private'
  });
  assert.match(result.workspace_id, /^workspace_compat_[a-f0-9]{16}$/);
  assert.match(result.archive_digest, /^[a-f0-9]{64}$/);
  assert.match(result.bundle_digest, /^[a-f0-9]{64}$/);
  assert.equal(result.admitted_files, 3);
  assert.equal(result.source_kind, 'local_git_directory');
  assert.equal(result.source_host_canonical, false);

  const state = await engine.inspect(result.workspace_id, { principalId: 'owner_local' });
  assert.equal(state.workspace.visibility, 'private');
  assert.equal(Object.keys(state.artifacts).length, 2);
  assert.equal(Object.keys(state.reviews).length, 1);
  assert.equal(Object.keys(state.evidence).length, 1);
  assert.equal(Object.keys(state.approvals).length, 0);
  assert.equal(Object.keys(state.rollbacks).length, 0);

  const archiveArtifact = await engine.readArtifact(result.workspace_id, 'artifact_compatibility_archive', { principalId: 'owner_local' });
  const archive = verifyCompatibilityArchive(JSON.parse(archiveArtifact.bytes.toString('utf8')));
  assert.equal(archive.archive_digest, result.archive_digest);
  assert.equal(JSON.stringify(archive).includes(sourceRoot), false);

  const restoredRoot = await tempRoot(t, 'archie-compat-restored-');
  await restoreCompatibilityArchive({ archive, targetRoot: restoredRoot });
  assert.equal(await fs.readFile(path.join(restoredRoot, 'src', 'app.js'), 'utf8'), "export const answer = 42;\n");

  const bundle = await readWorkspaceBundle(result.export_path);
  assert.equal(bundle.bundle_digest, result.bundle_digest);
  const secondHome = await tempRoot(t, 'archie-compat-second-');
  const secondProvider = new SafeFileWorkspaceProvider(path.join(secondHome, 'workspaces'));
  const imported = await importWorkspaceBundle({ provider: secondProvider, bundle });
  assert.equal(imported.state.head_digest, result.head_digest);
  const secondEngine = createWorkspaceEngine({ provider: secondProvider });
  const secondArchive = await secondEngine.readArtifact(result.workspace_id, 'artifact_compatibility_archive', { principalId: 'owner_local' });
  assert.equal(JSON.parse(secondArchive.bytes.toString('utf8')).archive_digest, result.archive_digest);

  const restartedProvider = new SafeFileWorkspaceProvider(path.join(dataRoot, 'workspaces'));
  const restartedEngine = createWorkspaceEngine({ provider: restartedProvider });
  const restarted = await restartedEngine.inspect(result.workspace_id, { principalId: 'owner_local' });
  assert.equal(restarted.head_digest, result.head_digest);
});

test('compatibility archive rejects tampering and unsafe paths', async t => {
  const sourceRoot = await fixture(t);
  const archive = structuredClone(await scanCompatibilitySource({ sourceRoot }));
  archive.files[0].content_base64 = Buffer.from('tampered').toString('base64');
  assert.throws(() => verifyCompatibilityArchive(archive), /digest mismatch/);

  const unsafe = structuredClone(await scanCompatibilitySource({ sourceRoot }));
  unsafe.files[0].path = '../escape';
  assert.throws(() => verifyCompatibilityArchive(unsafe), /unsafe path/);
});
