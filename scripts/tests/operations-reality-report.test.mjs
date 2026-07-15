import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspectOperationsReality } from '../operations-reality-report.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('operations report proves repository facts and gives every external unknown an executable authority-bound procedure', () => {
  const report = inspectOperationsReality({ root, observedAt: '2026-07-15T18:00:00.000Z' });
  assert.equal(report.schema, 'sideways-operations-reality/v1');
  assert.equal(report.status, 'partial');
  assert.deepEqual(report.stale, []);
  const verified = new Set(report.verified.map(item => item.id));
  for (const id of ['pages_workflow_least_privilege', 'pages_exact_commit_verification', 'deployment_sentinel_contract', 'relational_schema_bootstrap', 'relational_migration_runner', 'ordered_social_migrations', 'whole_repository_verification', 'safe_operations_probe', 'operator_runbook']) assert.ok(verified.has(id), `missing verified repository fact: ${id}`);
  const unknown = new Set(report.unknown.map(item => item.id));
  for (const id of ['live_pages_served_commit', 'github_pages_environment_protection', 'netlify_site_configuration', 'live_social_database_schema', 'database_backup_and_restore', 'rollback_drill', 'production_rate_limits', 'secret_values_and_rotation', 'self_hosted_maker_runner', 'production_cookie_behavior']) assert.ok(unknown.has(id), `external fact omitted or falsely verified: ${id}`);
  assert.ok(report.unknown.every(item => item.status === 'unknown' && item.source === 'external' && item.authority && item.procedure.command && item.procedure.stop_conditions.length));
  assert.match(report.admission_rule, /dated redacted snapshot/);
});
