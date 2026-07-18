#!/usr/bin/env node
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runArchieEquivalenceBenchmark } from './maker-archie-benchmark.mjs';
import { runArchieDerivationBenchmark } from './maker-archie-derivation-benchmark.mjs';

export const ARCHIE_BASELINE_RECEIPT_SCHEMA = 'archie-exact-head-baseline/v1';
const execFileAsync = promisify(execFile);
const HEX40 = /^[a-f0-9]{40}$/;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const stable = value => JSON.stringify(canonical(value));
const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
const clean = (value, limit = 4000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);

function measuredRoute(status, report, taskIds, extra = {}) {
  return Object.freeze({
    status,
    report_digest: report.report_digest,
    task_ids: taskIds,
    metrics: report.metrics || {},
    performance: report.performance || {},
    ...extra
  });
}

function unmeasuredRoute(reason) {
  return Object.freeze({ status: 'unmeasured', reason, task_ids: [], metrics: {}, performance: {} });
}

export function buildArchieBaselineReceipt({ repository_sha, suite, equivalence, derivation, generated_at, environment = {} }) {
  const repositorySha = clean(repository_sha, 40).toLowerCase();
  if (!HEX40.test(repositorySha)) throw new Error('repository_sha must be a 40-character Git commit SHA.');
  if (!suite || suite.schema !== 'archie-equivalence-suite/v1') throw new Error('suite must be archie-equivalence-suite/v1.');
  if (!equivalence || equivalence.schema !== 'archie-equivalence-report/v1') throw new Error('equivalence must be archie-equivalence-report/v1.');
  if (!derivation || derivation.schema !== 'archie-derivation-benchmark-report/v1') throw new Error('derivation must be archie-derivation-benchmark-report/v1.');
  const suiteDigest = digest(suite);
  if (equivalence.suite_digest !== suiteDigest) throw new Error('equivalence suite digest does not match the frozen suite.');
  const equivalenceEpisodes = equivalence.episodes || [];
  const derivationEpisodes = derivation.episodes || [];
  const teacherEpisodes = equivalenceEpisodes.filter(item => item.observed_state === 'teacher' || item.teacher_called);
  const rejectionEpisodes = equivalenceEpisodes.filter(item => item.expected_state === 'reject');
  const failures = equivalenceEpisodes.filter(item => !item.success);
  const composed = derivationEpisodes.filter(item => item.category === 'composition');
  const body = {
    schema: ARCHIE_BASELINE_RECEIPT_SCHEMA,
    repository_sha: repositorySha,
    generated_at: clean(generated_at, 64),
    suite: {
      id: clean(suite.suite_id, 200),
      digest: suiteDigest,
      task_ids: (suite.episodes || []).map(item => item.id)
    },
    commands: [
      'npm run test:archie:evaluation',
      'npm run benchmark:archie',
      'npm run benchmark:archie:derive'
    ],
    routes: {
      retrieval_only_recall: unmeasuredRoute('The current suite does not isolate retrieval-only Archie as an independent runner.'),
      no_memory_planning: unmeasuredRoute('The current suite does not isolate no-memory Maker as an independent runner.'),
      derived_composed_planning: measuredRoute('measured-deterministic-local', derivation, composed.map(item => item.episode_id), {
        proof_integrity_rate: derivation.metrics?.proof_integrity_rate ?? null
      }),
      current_archie: measuredRoute('measured-controlled-substitution', equivalence, equivalenceEpisodes.map(item => item.episode_id), {
        action_contract_pass_rate: equivalence.metrics?.action_contract_pass_rate ?? null,
        exact_reference_f1_role: 'secondary-diagnostic-only'
      }),
      local_model_inference: unmeasuredRoute('No independently admitted local model is bound to this exact baseline.'),
      frontier_escalation: measuredRoute('controlled-fixture-only', equivalence, teacherEpisodes.map(item => item.episode_id), {
        claim_boundary: 'Teacher calls in this suite use declared fixtures and are not frontier-model capability evidence.'
      }),
      abstention_and_failure: measuredRoute('measured', equivalence, [...new Set([...rejectionEpisodes, ...failures].map(item => item.episode_id))], {
        rejection_task_ids: rejectionEpisodes.map(item => item.episode_id),
        failed_task_ids: failures.map(item => item.episode_id)
      })
    },
    resource_receipts: {
      latency: {
        equivalence: equivalence.performance || {},
        derivation: derivation.performance || {}
      },
      memory_bytes: null,
      memory_status: 'unmeasured-by-current-node-benchmarks',
      external_api_cost_usd: 0,
      training_cost_usd: 0
    },
    environment: {
      platform: clean(environment.platform || process.platform, 100),
      architecture: clean(environment.architecture || process.arch, 100),
      node: clean(environment.node || process.version, 100)
    },
    evidence: {
      equivalence_report_digest: equivalence.report_digest,
      derivation_report_digest: derivation.report_digest,
      action_contract_primary: true,
      exact_reference_diagnostic_only: true
    },
    claim_boundary: 'This receipt freezes deterministic repository baselines only. Unmeasured routes remain unmeasured; controlled teacher fixtures, green tests, and derived planners are not evidence of an independently admitted generally capable model.'
  };
  if (!body.generated_at) throw new Error('generated_at is required.');
  return Object.freeze({ ...body, receipt_digest: digest(body) });
}

async function gitHead(root) {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
  return clean(stdout, 40).toLowerCase();
}

export async function freezeArchieBaseline({ suite_path = path.resolve('maker/evaluations/archie-equivalence-suite.json'), output_path = path.resolve('artifacts/archie-baseline.json'), root = process.cwd(), repository_sha = '', now = () => new Date().toISOString() } = {}) {
  const suite = JSON.parse(await fs.readFile(path.resolve(root, suite_path), 'utf8'));
  const equivalenceRun = await runArchieEquivalenceBenchmark({ suite });
  const derivation = runArchieDerivationBenchmark();
  const receipt = buildArchieBaselineReceipt({
    repository_sha: repository_sha || await gitHead(root),
    suite,
    equivalence: equivalenceRun.report,
    derivation,
    generated_at: now()
  });
  const output = path.resolve(root, output_path);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return Object.freeze({ receipt, output });
}

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const result = await freezeArchieBaseline({
    suite_path: argument('--suite', 'maker/evaluations/archie-equivalence-suite.json'),
    output_path: argument('--output', 'artifacts/archie-baseline.json'),
    root: path.resolve(argument('--root', process.cwd()))
  });
  process.stdout.write(`${JSON.stringify(result.receipt, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    process.stderr.write(`archie baseline freeze: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
