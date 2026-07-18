import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { importLegacySource } from '../archie-legacy-import.mjs';
import { inventorySourceHostAuthority } from '../archie-source-host-inventory.mjs';
import {
  createWorkspaceEngine,
  sha256,
  stableJSONStringify
} from '../archie-workspace-core.mjs';
import { SafeFileWorkspaceProvider } from '../archie-workspace-file-provider.mjs';
import {
  exportWorkspaceBundle,
  writeWorkspaceBundle
} from '../archie-workspace-portable.mjs';

async function temporary(t, prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function createPortableSource(root) {
  const provider = new SafeFileWorkspaceProvider(path.join(root, 'portable-source'));
  const engine = createWorkspaceEngine({ provider });
  await engine.createWorkspace({
    workspace_id: 'workspace_portable_source',
    title: 'Portable source',
    visibility: 'private',
    owner_id: 'owner_local'
  });
  await engine.execute('workspace_portable_source', 'owner_local', 'objective.define', {
    objective_id: 'objective_portable_source',
    statement: 'Prove exact portable restore through compatibility import.',
    protected_reality: 'Preserve the immutable event head.',
    proof_of_done: 'Second provider has the same event count and head digest.'
  });
  const bundle = await exportWorkspaceBundle({ engine, workspaceId: 'workspace_portable_source', principalId: 'owner_local' });
  const filename = path.join(root, 'portable.archie.json');
  await writeWorkspaceBundle(filename, bundle);
  return { filename, bundle };
}

test('legacy directory import preserves exact bytes in content-derived Archie-native authority and is idempotent', async t => {
  const root = await temporary(t, 'archie-compat-');
  const input = path.join(root, 'legacy-input');
  const workspaceRoot = path.join(root, 'workspaces');
  await fs.mkdir(path.join(input, 'nested'), { recursive: true });

  const receiptBody = {
    schema: 'maker-receipt/v1',
    task: { request: 'Preserve the old result.' },
    lease: { authority: { merge: 'human', deploy: 'human' } },
    changed_paths: ['output/result.json'],
    status: 'ready'
  };
  const receipt = { ...receiptBody, receipt_digest: sha256(stableJSONStringify(receiptBody)) };
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  const pack = {
    schema: 'archie-corpus-pack/v1',
    examples: [{ instruction: 'old input', outcome: 'completed' }]
  };
  const packBytes = Buffer.from(`${JSON.stringify(pack, null, 2)}\n`);
  const opaqueBytes = Buffer.from([0, 1, 2, 3, 250, 251, 252]);
  await fs.writeFile(path.join(input, 'maker-receipt.json'), receiptBytes);
  await fs.writeFile(path.join(input, 'nested', 'corpus-pack.json'), packBytes);
  await fs.writeFile(path.join(input, 'opaque.bin'), opaqueBytes);
  await fs.symlink(path.join(root, 'outside'), path.join(input, 'ignored-link')).catch(() => {});

  const provider = new SafeFileWorkspaceProvider(workspaceRoot);
  const engine = createWorkspaceEngine({ provider });
  const exportPath = path.join(root, 'legacy-export.archie.json');
  const first = await importLegacySource({ inputPath: input, provider, engine, exportPath });

  assert.equal(first.schema, 'archie-legacy-import-receipt/v1');
  assert.equal(first.mode, 'compatibility-import');
  assert.equal(first.file_count, 3);
  assert.equal(first.total_bytes, receiptBytes.length + packBytes.length + opaqueBytes.length);
  assert.match(first.workspace_id, /^workspace_import_[a-f0-9]{20}$/);
  assert.match(first.source_digest, /^[a-f0-9]{64}$/);
  assert.match(first.manifest_digest, /^[a-f0-9]{64}$/);
  assert.match(first.bundle_digest, /^[a-f0-9]{64}$/);
  assert.equal(first.canonical_identity_source, 'source-content-digest');
  assert.equal(first.github_required, false);
  assert.equal(first.idempotent, false);

  const state = (await engine.readState(first.workspace_id)).state;
  assert.equal(state.workspace.owner_id, 'owner_local');
  assert.equal(state.tasks.task_legacy_import.status, 'completed');
  assert.equal(state.evidence.evidence_legacy_import.result, 'pass');
  assert.equal(Object.keys(state.artifacts).length, 4);
  assert.equal(JSON.stringify(state).includes(root), false, 'canonical records must not expose the source absolute path');
  assert.equal(JSON.stringify(state).includes('github.com'), false, 'generated canonical records must not derive identity from GitHub');

  const entries = Object.entries(state.artifacts);
  const byName = Object.fromEntries(entries.map(([artifactId, artifact]) => [artifact.name, artifactId]));
  const loadedReceipt = await engine.readArtifact(first.workspace_id, byName['maker-receipt.json'], { principalId: 'owner_local' });
  const loadedPack = await engine.readArtifact(first.workspace_id, byName['nested/corpus-pack.json'], { principalId: 'owner_local' });
  const loadedOpaque = await engine.readArtifact(first.workspace_id, byName['opaque.bin'], { principalId: 'owner_local' });
  assert.deepEqual(loadedReceipt.bytes, receiptBytes);
  assert.deepEqual(loadedPack.bytes, packBytes);
  assert.deepEqual(loadedOpaque.bytes, opaqueBytes);

  const manifestArtifact = await engine.readArtifact(first.workspace_id, byName['legacy-import-manifest.json'], { principalId: 'owner_local' });
  const manifest = JSON.parse(manifestArtifact.bytes.toString('utf8'));
  assert.equal(manifest.schema, 'archie-legacy-import-manifest/v1');
  assert.equal(manifest.source_digest, first.source_digest);
  assert.equal(manifest.canonical_identity_source, 'source-content-digest');
  assert.equal(manifest.github_required, false);
  assert.deepEqual(manifest.imported_entries.map(entry => entry.source_name), [
    'maker-receipt.json',
    'nested/corpus-pack.json',
    'opaque.bin'
  ]);
  assert.equal(manifest.imported_entries[0].classification.kind, 'maker-receipt');
  assert.equal(manifest.imported_entries[0].embedded_digest.status, 'verified-stable-json');
  assert.equal(manifest.imported_entries[1].classification.kind, 'archie-corpus-pack');
  assert.equal(manifest.imported_entries[2].classification.kind, 'opaque-file');
  assert.equal(JSON.stringify(manifest).includes(root), false);

  const restartedEngine = createWorkspaceEngine({ provider: new SafeFileWorkspaceProvider(workspaceRoot) });
  const restarted = (await restartedEngine.readState(first.workspace_id)).state;
  assert.equal(restarted.head_digest, first.head_digest);
  assert.equal(restarted.event_count, first.event_count);

  const second = await importLegacySource({ inputPath: input, provider: new SafeFileWorkspaceProvider(workspaceRoot) });
  assert.equal(second.idempotent, true);
  assert.equal(second.workspace_id, first.workspace_id);
  assert.equal(second.head_digest, first.head_digest);
  assert.equal(second.event_count, first.event_count);
  assert.equal(second.bundle_digest, first.bundle_digest);

  const exported = JSON.parse(await fs.readFile(exportPath, 'utf8'));
  assert.equal(exported.workspace_id, first.workspace_id);
  assert.equal(exported.bundle_digest, first.bundle_digest);
});

test('native portable bundles restore exactly without compatibility reinterpretation', async t => {
  const root = await temporary(t, 'archie-portable-compat-');
  const source = await createPortableSource(root);
  const provider = new SafeFileWorkspaceProvider(path.join(root, 'restored'));

  const first = await importLegacySource({ inputPath: source.filename, provider });
  assert.equal(first.mode, 'native-portable-restore');
  assert.equal(first.workspace_id, source.bundle.workspace_id);
  assert.equal(first.bundle_digest, source.bundle.bundle_digest);
  assert.equal(first.head_digest, source.bundle.head_digest);
  assert.equal(first.event_count, source.bundle.event_count);
  assert.equal(first.idempotent, false);

  const second = await importLegacySource({ inputPath: source.filename, provider });
  assert.equal(second.mode, 'native-portable-restore');
  assert.equal(second.idempotent, true);
  assert.equal(second.head_digest, source.bundle.head_digest);
});

test('source-host inventory separates canonical runtime blockers from adapters, CI, tests, and documentation', async t => {
  const root = await temporary(t, 'archie-source-host-inventory-');
  await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(root, '.github', 'workflows'), { recursive: true });
  await fs.mkdir(path.join(root, 'scripts', 'tests'), { recursive: true });

  await fs.writeFile(path.join(root, 'scripts', 'canonical-queue.mjs'), `
export async function loadWorkspace() {
  return fetch('https://api.github.com/repos/acme/app/issues?labels=queue', {
    headers: { authorization: 'Bearer ' + process.env.GITHUB_TOKEN }
  }); // GitHub Issues are the canonical workspace queue and event log.
}
`);
  await fs.writeFile(path.join(root, 'scripts', 'github-import-adapter.mjs'), `
// Optional GitHub import/export adapter. Archie-native workspace state remains canonical.
export async function importSnapshot(url) { return fetch(url); }
`);
  await fs.writeFile(path.join(root, 'scripts', 'browser-surface.mjs'), `
// Browser-only canonical approval state is forbidden.
localStorage.setItem('canonical-approval', 'approved');
`);
  await fs.writeFile(path.join(root, '.github', 'workflows', 'ci.yml'), `name: CI\non: workflow_dispatch\njobs: {}\n`);
  await fs.writeFile(path.join(root, 'scripts', 'tests', 'github-adapter.test.mjs'), `assert.match('https://github.com/acme/app', /github/);\n`);
  await fs.writeFile(path.join(root, 'MIGRATION.md'), `GitHub Issues were previously authoritative. The Archie workspace replaces them.\n`);

  const report = await inventorySourceHostAuthority({ root });
  assert.equal(report.schema, 'archie-source-host-inventory/v1');
  assert.match(report.inventory_digest, /^[a-f0-9]{64}$/);
  assert.equal(report.scanned_root, '.');
  assert.equal(report.scanned_file_count, 6);
  assert.ok(report.finding_count >= 6);
  assert.ok(report.blocker_count >= 2);
  assert.equal(report.deletion_ready, false);
  assert.ok(report.findings.some(finding => finding.path === 'scripts/canonical-queue.mjs' && finding.disposition === 'canonical-runtime-blocker'));
  assert.ok(report.findings.some(finding => finding.path === 'scripts/browser-surface.mjs' && finding.disposition === 'canonical-runtime-blocker'));
  assert.ok(report.findings.some(finding => finding.path === 'scripts/github-import-adapter.mjs' && finding.disposition === 'optional-adapter-candidate'));
  assert.ok(report.findings.some(finding => finding.path === '.github/workflows/ci.yml' && finding.disposition === 'allowed-ci'));
  assert.ok(report.findings.some(finding => finding.path === 'scripts/tests/github-adapter.test.mjs' && finding.disposition === 'allowed-nonruntime'));
  assert.ok(report.findings.some(finding => finding.path === 'MIGRATION.md' && finding.file_category === 'documentation'));
  assert.ok(report.findings.every(finding => !path.isAbsolute(finding.path)));
  assert.ok(report.findings.every(finding => /^[a-f0-9]{64}$/.test(finding.match_digest)));
});

test('source-host inventory reports deletion readiness only after blockers are absent', async t => {
  const root = await temporary(t, 'archie-source-host-clean-');
  await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(root, 'scripts', 'github-export-adapter.mjs'), `
// Optional adapter only. The Archie-native workspace is authoritative.
export function exportToGitHub(bundle) { return { bundle, destination: 'github.com' }; }
`);
  const report = await inventorySourceHostAuthority({ root, replacementReceipts: ['PR-562', 'PR-565', 'PR-568'] });
  assert.equal(report.blocker_count, 0);
  assert.equal(report.deletion_ready, true);
  assert.deepEqual(report.replacement_receipts, ['PR-562', 'PR-565', 'PR-568']);
});
