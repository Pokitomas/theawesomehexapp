import assert from 'node:assert/strict';
import test from 'node:test';
import AUTHORITY_MANIFEST from '../../audit/authority-manifest.mjs';
import {
  compareSurfaceCoverage,
  discoverAuthoritySurfaces,
  validateManifest
} from '../check-authority-manifest.mjs';
import { auditRepository } from '../run-authority-audit.mjs';

const ROOT = new URL('../..', import.meta.url);
const manifest = () => structuredClone(AUTHORITY_MANIFEST);

test('manifest covers every discovered in-repository authority surface', async () => {
  const result = await auditRepository(ROOT);
  assert.deepEqual(result.errors, []);
  assert.ok(result.summary.rows >= 30);
  assert.ok(result.summary.surfaces >= 80);
  assert.equal(result.summary.trackedGaps, 0);
  assert.ok(result.summary.externalUnknowns >= 7);
});

test('removing one mapped surface is detected as drift', async () => {
  const value = manifest();
  const discovered = await discoverAuthoritySurfaces(ROOT);
  const target = discovered[0];
  for (const row of value.rows) row.surfaces = row.surfaces.filter(surface => surface !== target);
  assert.ok(compareSurfaceCoverage(value, discovered).includes(`unmapped authority surface: ${target}`));
});

test('executive convergence leaves no stale tracked-gap rows', async () => {
  const value = manifest();
  assert.deepEqual(value.rows.filter(row => row.status === 'tracked-gap'), []);
  const errors = await validateManifest({
    root: ROOT,
    manifest: value,
    discoveredSurfaces: await discoverAuthoritySurfaces(ROOT)
  });
  assert.deepEqual(errors, []);
});

test('declaration-only capability surfaces remain explicit', () => {
  const declared = new Set(
    manifest().rows
      .filter(row => row.status === 'declaration-only')
      .flatMap(row => row.surfaces)
  );
  for (const capability of ['repo:read', 'ci:read', 'ci:run', 'deploy:read', 'deploy:write']) {
    assert.ok(declared.has(`remote-capability:${capability}`), capability);
  }
});

test('read-only and coordination workflows remain explicitly mapped', () => {
  const value = manifest();
  const readOnly = value.rows.find(row => row.id === 'workflow.read-only-ci');
  assert.ok(readOnly.surfaces.length >= 15);
  assert.ok(readOnly.surfaces.every(surface => surface.endsWith(':contents:read')));

  const coordination = value.rows.find(row => row.id === 'workflow.coordination-ticks');
  assert.deepEqual(new Set(coordination.surfaces), new Set([
    'workflow-permission:.github/workflows/coordination-ticks.yml:contents:read',
    'workflow-permission:.github/workflows/coordination-ticks.yml:issues:write',
    'workflow-permission:.github/workflows/coordination-ticks.yml:pull-requests:read',
    'workflow-permission:.github/workflows/coordination-ticks.yml:actions:read'
  ]));
});

test('public projection inventory includes the bounded terminal receipt projection', () => {
  const row = manifest().rows.find(candidate => candidate.id === 'projection.remote-public');
  assert.ok(row.surfaces.includes('public-projection:publicTerminalReceiptProjection'));
});
