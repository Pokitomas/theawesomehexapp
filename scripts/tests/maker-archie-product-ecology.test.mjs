import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeArchieAppManifest, resolveArchieApps } from '../maker-archie-product-ecology.mjs';

test('Archie App manifests do not require chat or an assistant voice', () => {
  const manifest = normalizeArchieAppManifest({
    app_id: 'ambient-research-wall',
    version: '1.0.0',
    human_outcome: 'Make unresolved evidence and changing hypotheses spatially legible.',
    required_faculties: ['observe', 'represent', 'remember'],
    interaction_forms: ['spatial', 'ambient'],
    requirements: { permissions: ['local-display'], minimum_memory_mb: 512, maximum_latency_ms: 100 }
  });
  assert.deepEqual(manifest.interaction_forms, ['ambient', 'spatial']);
  assert.equal(manifest.interaction_forms.includes('chat'), false);
});

test('one Core admits only apps supported by the exact package and environment', () => {
  const manifests = [
    {
      app_id: 'ambient-research-wall', version: '1', human_outcome: 'Spatial research continuity',
      required_faculties: ['observe', 'represent'], interaction_forms: ['ambient'],
      requirements: { permissions: ['local-display'], minimum_memory_mb: 256, maximum_latency_ms: 100 }
    },
    {
      app_id: 'physical-lab', version: '1', human_outcome: 'Operate calibrated lab equipment',
      required_faculties: ['observe', 'act'], requirements: { permissions: ['lab-control'], sensors: ['calibrated-camera'] }
    }
  ];
  const resolution = resolveArchieApps(manifests, {
    brain_package_digest: 'a'.repeat(64),
    faculties: ['observe', 'represent'], permissions: ['local-display'], sensors: [], tools: [],
    connectivity: 'offline', memory_mb: 1024, latency_ms: 40
  });
  assert.deepEqual(resolution.admitted.map(item => item.app_id), ['ambient-research-wall']);
  assert.equal(resolution.blocked[0].app_id, 'physical-lab');
  assert.ok(resolution.blocked[0].reasons.some(item => item.kind === 'missing-faculty'));
});
