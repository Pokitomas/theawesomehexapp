import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspectHumanQuality } from '../human-quality-report.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('human quality report admits executable exact-head witnesses and preserves unsupported runtime boundaries', () => {
  const report = inspectHumanQuality({ root, observedAt: '2026-07-15T07:00:00.000Z' });
  assert.equal(report.schema, 'sideways-human-quality/v2');
  assert.equal(report.status, 'partial', JSON.stringify(report.stale, null, 2));
  assert.deepEqual(report.stale, [], JSON.stringify(report.stale, null, 2));

  const verified = new Set(report.verified.map(item => item.id));
  for (const id of [
    'founder_semantic_controls',
    'founder_keyboard_and_touch_baseline',
    'maker_semantic_controls',
    'maker_keyboard_touch_and_reflow_baseline',
    'root_phone_desktop_zoom_contrast_motion_keyboard_network',
    'manual_primary_phone_journey',
    'social_phone_authority_and_overflow',
    'blocked_storage_quota_and_restore_failure'
  ]) assert.ok(verified.has(id), `missing executable quality proof: ${id}; stale=${JSON.stringify(report.stale)}`);

  const unknown = new Set(report.unknown.map(item => item.id));
  assert.deepEqual([...unknown].sort(), ['cross_browser_behavior', 'screen_reader_journeys', 'startup_and_scale_performance']);
  assert.ok(report.verified.every(item => item.evidence.length > 0));
  assert.ok(report.unknown.every(item => item.status === 'unknown' && item.source === 'runtime'));
  assert.match(report.admission_rule, /exact-head workflows pass/);
  assert.match(report.admission_rule, /unsupported/);
});
