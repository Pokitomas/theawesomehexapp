import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  auditRepository,
  compareSurfaceCoverage,
  discoverAuthoritySurfaces,
  validateManifest
} from '../check-authority-manifest.mjs';

const ROOT = new URL('../..', import.meta.url);
const MANIFEST_URL = new URL('../../audit/authority-manifest.json', import.meta.url);

async function manifest() {
  return JSON.parse(await readFile(MANIFEST_URL, 'utf8'));
}

test('manifest covers every discovered in-repository authority surface', async () => {
  const result = await auditRepository(ROOT);
  assert.deepEqual(result.errors, []);
  assert.ok(result.summary.rows >= 30);
  assert.ok(result.summary.surfaces >= 80);
  assert.ok(result.summary.externalUnknowns >= 7);
});

test('removing one mapped surface is detected as drift', async () => {
  const value = await manifest();
  const discovered = await discoverAuthoritySurfaces(ROOT);
  const target = discovered[0];
  for (const row of value.rows) row.surfaces = row.surfaces.filter(surface => surface !== target);
  assert.ok(compareSurfaceCoverage(value, discovered).includes(`unmapped authority surface: ${target}`));
});

test('tracked gaps retain an issue and executable characterization anchor', async () => {
  const value = await manifest();
  const tracked = value.rows.filter(row => row.status === 'tracked-gap');
  assert.ok(tracked.length > 0);
  for (const row of tracked) {
    assert.ok(row.trackers.every(tracker => /^#\d+$/.test(tracker)), row.id);
    assert.ok(row.gapCharacterization.length > 0, row.id);
    assert.ok(row.denyWitness.length > 0, row.id);
  }

  const broken = structuredClone(value);
  const row = broken.rows.find(candidate => candidate.status === 'tracked-gap');
  row.trackers = [];
  const errors = await validateManifest({
    root: ROOT,
    manifest: broken,
    discoveredSurfaces: await discoverAuthoritySurfaces(ROOT)
  });
  assert.ok(errors.some(error => error.includes(`${row.id}: tracked-gap rows require`)));
});

test('declaration-only capability surfaces remain explicit', async () => {
  const value = await manifest();
  const declared = new Set(
    value.rows
      .filter(row => row.status === 'declaration-only')
      .flatMap(row => row.surfaces)
  );
  for (const capability of ['repo:read', 'ci:read', 'ci:run', 'deploy:read', 'deploy:write']) {
    assert.ok(declared.has(`remote-capability:${capability}`), capability);
  }
});

test('read-only workflows remain explicitly mapped', async () => {
  const value = await manifest();
  const row = value.rows.find(candidate => candidate.id === 'workflow.read-only-ci');
  assert.ok(row);
  assert.ok(row.surfaces.length >= 10);
  assert.ok(row.surfaces.every(surface => surface.endsWith(':contents:read')));
});
