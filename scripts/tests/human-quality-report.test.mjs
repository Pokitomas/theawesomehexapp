import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspectHumanQuality } from '../human-quality-report.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('human quality report enforces static admission and preserves runtime unknowns', () => {
  const report = inspectHumanQuality({ root, observedAt: '2026-07-15T07:00:00.000Z' });
  assert.equal(report.schema, 'sideways-human-quality/v1');
  assert.equal(report.status, 'partial');
  assert.deepEqual(report.stale, []);

  const verified = new Set(report.verified.map(item => item.id));
  for (const id of [
    'founder_semantic_controls',
    'founder_keyboard_and_touch_baseline',
    'maker_semantic_controls',
    'maker_keyboard_touch_and_reflow_baseline'
  ]) assert.ok(verified.has(id), `missing static quality proof: ${id}`);

  const unknown = new Set(report.unknown.map(item => item.id));
  for (const id of [
    'screen_reader_journeys',
    'cross_browser_behavior',
    'text_zoom_and_reflow',
    'computed_contrast',
    'reduced_motion_behavior',
    'keyboard_end_to_end',
    'touch_target_geometry',
    'startup_and_scale_performance',
    'offline_and_bad_network',
    'blocked_storage_and_quota'
  ]) assert.ok(unknown.has(id), `runtime quality boundary was omitted or falsely verified: ${id}`);

  assert.ok(report.verified.every(item => item.evidence.length > 0));
  assert.ok(report.unknown.every(item => item.status === 'unknown' && item.source === 'runtime'));
});
