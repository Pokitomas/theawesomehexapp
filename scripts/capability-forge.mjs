#!/usr/bin/env node
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { normalizeIntent } from '../maker/maker.js';

const execFile = promisify(execFileCallback);
export const CAPABILITY_FORGE_SCHEMA = 'sideways-capability-forge/v1';
export const INSTALL_LEASE_SCHEMA = 'sideways-capability-install-lease/v1';
export const RECEIPT_SCHEMA = 'sideways-capability-forge-receipt/v1';
const ALLOWED_PROGRAMS = new Set(['ollama', 'uv', 'python', 'python3', 'npm']);
const SECRET = /\b(?:ghp_|github_pat_|sk-|Bearer\s+|DATABASE_URL\s*=|SESSION_SECRET\s*=)/i;
const clean = (value, limit = 12000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);

const CANDIDATES = Object.freeze([
  Object.freeze({ id: 'recurrent-rwkv-family', family: 'recurrent', hypothesis: 'streaming state and bounded memory may provide the best phone/local capability per byte' }),
  Object.freeze({ id: 'selective-state-space-family', family: 'state-space', hypothesis: 'selective state updates may preserve long-range signal with linear sequence cost' }),
  Object.freeze({ id: 'hybrid-recurrent-attention-family', family: 'hybrid', hypothesis: 'small attention windows plus recurrent or state-space memory may dominate either mechanism alone' }),
  Object.freeze({ id: 'compact-transformer-baseline', family: 'transformer', hypothesis: 'a matched compact transformer remains the required conventional baseline' })
]);

function requireText(value, label, limit = 4000) {
  const normalized = clean(value, limit);
  if (!normalized) throw new Error(`${label} is required.`);
  if (SECRET.test(normalized)) throw new Error(`${label} contains secret-like material.`);
  return normalized;
}

function exactSha(value, label = 'head_sha') {
  const normalized = clean(value, 80).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalized)) throw new Error(`${label} must be an exact 40-character commit SHA.`);
  return normalized;
}

function candidateOrder(prior) {
  const selected = prior === 'recurrent'
    ? 'recurrent-rwkv-family'
    : prior === 'state-space'
      ? 'selective-state-space-family'
      : prior === 'hybrid'
        ? 'hybrid-recurrent-attention-family'
        : null;
  return selected
    ? [...CANDIDATES.filter(item => item.id === selected), ...CANDIDATES.filter(item => item.id !== selected)]
    : [...CANDIDATES];
}

export function buildCapabilityForgePlan(input = {}) {
  const intent = normalizeIntent(input);
  if (!intent.request) throw new Error('Capability request is required.');
  return Object.freeze({
    schema: CAPABILITY_FORGE_SCHEMA,
    intent,
    budget: Object.freeze({
      envelope: intent.budget_envelope,
      unit: 'operator-bound-relative-compute',
      candidate_cap: Math.max(2, Math.min(8, Math.ceil(intent.budget_envelope * 4))),
      external_install_cap: Math.max(0, Math.min(4, Math.floor(intent.budget_envelope * 2))),
      spend_authority: 'explicit-operator-only'
    }),
    candidates: Object.freeze(candidateOrder(intent.architecture_prior)),
    lifecycle: intent.lifecycle,
    admission: Object.freeze({
      compare_on_matched_inputs: true,
      matched_compute_baseline: 'compact-transformer-baseline',
      require_product_integration: true,
      require_exact_head_product_proof: true,
      require_cleanup_after_install: true,
      prohibit_wellbeing_claims: true
    }),
    termination: intent.termination
  });
}

export function createTemporaryInstallLease({
  lease_id,
  candidate_id,
  program,
  install_args = [],
  cleanup_args = [],
  budget_cost = 0
} = {}) {
  const leaseId = requireText(lease_id, 'lease_id', 160).replace(/[^A-Za-z0-9._-]/g, '-');
  const candidateId = requireText(candidate_id, 'candidate_id', 200);
  const executable = requireText(program, 'program', 40);
  if (!ALLOWED_PROGRAMS.has(executable)) throw new Error(`External install program is not allowlisted: ${executable}.`);
  const normalizeArgs = (args, label) => {
    if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) throw new Error(`${label} must be an argv string array.`);
    const values = args.map(value => clean(value, 1000));
    if (values.some(value => !value || SECRET.test(value))) throw new Error(`${label} contains empty or secret-like arguments.`);
    if (values.some(value => /(?:^|\s)(?:--prefix|--target|--root|--cache-dir)(?:=|\s)/.test(value))) {
      throw new Error(`${label} cannot choose its own filesystem target.`);
    }
    return values;
  };
  const cost = Number(budget_cost);
  if (!Number.isFinite(cost) || cost < 0) throw new Error('budget_cost must be finite and non-negative.');
  const workspace = path.join(os.tmpdir(), 'sideways-capability-forge', leaseId);
  return Object.freeze({
    schema: INSTALL_LEASE_SCHEMA,
    lease_id: leaseId,
    candidate_id: candidateId,
    program: executable,
    install_args: Object.freeze(normalizeArgs(install_args, 'install_args')),
    cleanup_args: Object.freeze(normalizeArgs(cleanup_args, 'cleanup_args')),
    workspace,
    isolated: true,
    production_target: false,
    budget_cost: cost,
    authority: 'explicit-operator-only',
    cleanup_required: true
  });
}

function minimalEnvironment(env = process.env) {
  return {
    PATH: env.PATH || '',
    HOME: env.HOME || '',
    TMPDIR: env.TMPDIR || os.tmpdir(),
    NO_COLOR: '1',
    CI: env.CI || '1'
  };
}

export async function runTemporaryInstallLease(leaseInput, {
  authorization = process.env.SIDEWAYS_ALLOW_TEMP_INSTALL,
  execute = execFile,
  remove = fs.rm,
  mkdir = fs.mkdir,
  env = process.env
} = {}) {
  const lease = createTemporaryInstallLease(leaseInput);
  if (authorization !== 'I_ACCEPT_EPHEMERAL_INSTALLS') {
    throw new Error('Temporary external installation is blocked without explicit operator authorization.');
  }
  const root = path.resolve(os.tmpdir(), 'sideways-capability-forge');
  const workspace = path.resolve(lease.workspace);
  if (!workspace.startsWith(`${root}${path.sep}`)) throw new Error('Temporary workspace escaped the forge root.');

  const receipts = [];
  await mkdir(workspace, { recursive: true });
  let installError = null;
  try {
    const installed = await execute(lease.program, lease.install_args, {
      cwd: workspace,
      env: minimalEnvironment(env),
      shell: false,
      timeout: 30 * 60 * 1000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true
    });
    receipts.push({
      schema: RECEIPT_SCHEMA,
      type: 'temporary-install',
      lease_id: lease.lease_id,
      candidate_id: lease.candidate_id,
      ok: true,
      program: lease.program,
      output: clean(`${installed?.stdout || ''}\n${installed?.stderr || ''}`, 2000)
    });
  } catch (error) {
    installError = error;
    receipts.push({
      schema: RECEIPT_SCHEMA,
      type: 'temporary-install',
      lease_id: lease.lease_id,
      candidate_id: lease.candidate_id,
      ok: false,
      program: lease.program,
      output: clean(`${error?.stdout || ''}\n${error?.stderr || error?.message || error}`, 2000)
    });
  } finally {
    let cleanupCommandOk = true;
    let cleanupOutput = '';
    if (lease.cleanup_args.length) {
      try {
        const cleaned = await execute(lease.program, lease.cleanup_args, {
          cwd: workspace,
          env: minimalEnvironment(env),
          shell: false,
          timeout: 15 * 60 * 1000,
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true
        });
        cleanupOutput = clean(`${cleaned?.stdout || ''}\n${cleaned?.stderr || ''}`, 2000);
      } catch (error) {
        cleanupCommandOk = false;
        cleanupOutput = clean(`${error?.stdout || ''}\n${error?.stderr || error?.message || error}`, 2000);
      }
    }
    let workspaceRemoved = true;
    try { await remove(workspace, { recursive: true, force: true }); }
    catch (error) {
      workspaceRemoved = false;
      cleanupOutput = clean(`${cleanupOutput}\n${error?.message || error}`, 2000);
    }
    receipts.push({
      schema: RECEIPT_SCHEMA,
      type: 'temporary-cleanup',
      lease_id: lease.lease_id,
      candidate_id: lease.candidate_id,
      ok: cleanupCommandOk && workspaceRemoved,
      workspace_removed: workspaceRemoved,
      cleanup_command_ok: cleanupCommandOk,
      output: cleanupOutput
    });
  }
  return Object.freeze({ lease, receipts: Object.freeze(receipts), ok: !installError && receipts.at(-1)?.ok === true });
}

export function evaluateCapabilityTermination(planInput, receiptsInput = []) {
  const plan = planInput?.schema === CAPABILITY_FORGE_SCHEMA ? planInput : buildCapabilityForgePlan(planInput);
  const receipts = Array.isArray(receiptsInput) ? receiptsInput : receiptsInput?.receipts;
  if (!Array.isArray(receipts)) throw new Error('receipts must be an array.');
  const normalized = receipts.map((receipt, index) => {
    if (!receipt || typeof receipt !== 'object') throw new Error(`receipts[${index}] must be an object.`);
    if (receipt.schema !== RECEIPT_SCHEMA) throw new Error(`receipts[${index}] has an unsupported schema.`);
    return receipt;
  });
  const successful = new Set(normalized.filter(item => item.ok === true).map(item => item.type));
  const required = ['crawl', 'architecture-comparison', 'candidate-evaluation', 'distillation', 'product-integration', 'product-proof'];
  const missing = required.filter(type => !successful.has(type));
  const installs = normalized.filter(item => item.type === 'temporary-install' && item.ok === true);
  const cleanupByLease = new Map(normalized.filter(item => item.type === 'temporary-cleanup').map(item => [item.lease_id, item]));
  const cleanupFailures = installs.filter(item => cleanupByLease.get(item.lease_id)?.ok !== true).map(item => item.lease_id);
  const productProof = normalized.find(item => item.type === 'product-proof' && item.ok === true);
  const exactHead = productProof?.head_sha ? exactSha(productProof.head_sha, 'product-proof head_sha') : null;
  const spent = normalized.reduce((sum, item) => sum + (Number.isFinite(Number(item.budget_cost)) ? Number(item.budget_cost) : 0), 0);
  const budgetExceeded = spent > plan.budget.envelope;
  const admitted = missing.length === 0 && cleanupFailures.length === 0 && !budgetExceeded && Boolean(exactHead);
  return Object.freeze({
    schema: RECEIPT_SCHEMA,
    type: 'termination',
    ok: admitted,
    state: admitted ? 'admitted-product-capability' : budgetExceeded ? 'budget-exhausted' : cleanupFailures.length ? 'cleanup-blocked' : 'evidence-incomplete',
    exact_head: exactHead,
    spent,
    budget: plan.budget.envelope,
    missing,
    cleanup_failures: cleanupFailures,
    temporary_installs: installs.length,
    claim_boundary: 'Admission proves only the named product capability under the recorded matched evaluation and exact-head witnesses.'
  });
}

async function readJSON(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function main(argv = process.argv.slice(2)) {
  const [command, first, second] = argv;
  if (command === 'plan' && first) {
    process.stdout.write(`${JSON.stringify(buildCapabilityForgePlan(await readJSON(first)), null, 2)}\n`);
    return;
  }
  if (command === 'evaluate' && first && second) {
    process.stdout.write(`${JSON.stringify(evaluateCapabilityTermination(await readJSON(first), await readJSON(second)), null, 2)}\n`);
    return;
  }
  throw new Error('Usage: capability-forge.mjs plan <intent.json> | evaluate <plan.json> <receipts.json>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`capability-forge: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}
