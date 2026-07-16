import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { buildArchieDerivationBenchmarkTasks, runArchieDerivationBenchmark } from '../maker-archie-derivation-benchmark.mjs';

test('constructs exactly fifty cross-domain, safety, novelty, and composition episodes', () => {
  const tasks = buildArchieDerivationBenchmarkTasks();
  assert.equal(tasks.length, 50);
  assert.equal(new Set(tasks.map(item => item.id)).size, 50);
  assert.ok(tasks.some(item => item.category === 'adapter-transfer'));
  assert.ok(tasks.some(item => item.category === 'safety'));
  assert.ok(tasks.some(item => item.category === 'novelty'));
  assert.ok(tasks.some(item => item.category === 'composition'));
});

test('measures portable derivational capability without model growth or external dependencies', () => {
  const report = runArchieDerivationBenchmark({ now: () => Date.parse('2026-07-16T08:30:00.000Z') });
  assert.equal(report.schema, 'archie-derivation-benchmark-report/v1');
  assert.equal(report.task_count, 50);
  assert.ok(report.metrics.total_success_rate >= 0.9, JSON.stringify(report.episodes.filter(item => !item.success), null, 2));
  assert.equal(report.metrics.safety_rejection_rate, 1);
  assert.equal(report.metrics.novelty_escalation_rate, 1);
  assert.equal(report.metrics.proof_integrity_rate, 1);
  assert.equal(report.model.grew_during_adapter_transfer, false);
  assert.ok(report.model.bytes < 512 * 1024);
  assert.equal(report.performance.external_dependencies, 0);
  assert.match(report.report_digest, /^[a-f0-9]{64}$/);
});

test('publishes a schema for model, result, proof, and fifty-task report contracts', async () => {
  const schema = JSON.parse(await fs.readFile('maker/contracts/archie-derivation.schema.json', 'utf8'));
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.$defs.model.properties.schema.const, 'archie-derivation-model/v1');
  assert.equal(schema.$defs.result.properties.schema.const, 'archie-derivation-plan/v1');
  assert.equal(schema.$defs.proof.properties.schema.const, 'archie-derivation-proof/v1');
  assert.equal(schema.$defs.benchmarkReport.properties.task_count.const, 50);
});
