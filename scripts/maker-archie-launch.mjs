#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseMakerArgs } from './maker-core.mjs';
import { recallNativeMakerPlan, rememberNativeMakerRun } from './maker-archie-native.mjs';
import {
  createArchieMakerDecision,
  createArchieMakerLauncherReceipt,
  createArchieMakerRoutingDecision
} from './maker-archie-runtime-contract.mjs';

const execFileAsync = promisify(execFile);
const MAX_CAPTURE = 32 * 1024 * 1024;
const clean = (value, limit = 12000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);

export function extractNativeMakerReceipt(output) {
  const text = String(output || '');
  const pattern = /\{\s*"schema"\s*:\s*"sideways-maker-run\/v2"/g;
  const starts = [...text.matchAll(pattern)].map(match => match.index).filter(Number.isInteger).reverse();
  for (const start of starts) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          try { return JSON.parse(text.slice(start, index + 1)); }
          catch { break; }
        }
      }
    }
  }
  return null;
}

export function archieMakerDisabled(env = process.env) {
  return /^(?:1|true|yes|on)$/i.test(clean(env?.ARCHIE_DISABLED, 20));
}

export async function resolveArchieMakerLaunch({
  repoRoot,
  request,
  baseBranch = 'main',
  baseSha,
  env = process.env,
  clock = Date.now,
  recall = recallNativeMakerPlan,
  executionKey = null
} = {}) {
  if (archieMakerDisabled(env)) {
    const receipt = createArchieMakerLauncherReceipt({
      request,
      repository: repoRoot,
      baseBranch,
      baseSha,
      bypassed: true,
      clock
    });
    return Object.freeze({ bypassed: true, decision: null, execution_decision: null, execution_key: null, recall: null, receipt });
  }

  const recalled = await recall({ repoRoot, request, baseBranch, baseSha, env, clock });
  const decision = createArchieMakerRoutingDecision({
    request,
    repository: repoRoot,
    baseBranch,
    baseSha,
    recall: recalled,
    clock
  });

  let key = null;
  let executionDecision = null;
  if (decision.state === 'local_recurrence' && decision.executable) {
    key = clean(executionKey, 1000) || randomBytes(32).toString('hex');
    executionDecision = createArchieMakerDecision({
      request,
      repository: repoRoot,
      baseBranch,
      baseSha,
      recall: recalled,
      key,
      clock
    });
  }

  const receipt = createArchieMakerLauncherReceipt({
    request,
    repository: repoRoot,
    baseBranch,
    baseSha,
    decision,
    executionAuthority: executionDecision,
    clock
  });
  return Object.freeze({ bypassed: false, decision, execution_decision: executionDecision, execution_key: key, recall: recalled, receipt });
}

async function repoRoot() {
  const result = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 30000 });
  return clean(result.stdout, 4000);
}

async function resolveBaseSha(root, baseBranch) {
  await execFileAsync('git', ['fetch', 'origin', '--prune'], { cwd: root, encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: MAX_CAPTURE });
  const result = await execFileAsync('git', ['rev-parse', '--verify', `origin/${baseBranch}`], { cwd: root, encoding: 'utf8', timeout: 30000 });
  return clean(result.stdout, 200);
}

function runMaker(argv, root, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts', 'maker.mjs'), ...argv], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['inherit', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    child.stdout.on('data', chunk => {
      const text = String(chunk);
      stdout += text;
      if (stdout.length > MAX_CAPTURE) stdout = stdout.slice(-MAX_CAPTURE);
      process.stdout.write(text);
    });
    child.stderr.on('data', chunk => process.stderr.write(String(chunk)));
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code: Number.isInteger(code) ? code : 1, signal: signal || null, stdout }));
  });
}

function writeDecisionStatus(launch) {
  if (launch.bypassed) {
    process.stdout.write('[archie] ARCHIE_DISABLED bypassed Archie decision production; running ordinary Maker compatibility behavior\n');
    return;
  }
  const { decision, recall } = launch;
  if (decision.state === 'local_recurrence') {
    process.stdout.write(`[archie] exact verified recurrence ${clean(recall?.specialist_id, 300) || 'unknown'} admitted for Maker verification and execution\n`);
  } else if (decision.state === 'derived_candidate') {
    process.stdout.write(`[archie] proof-carrying derived candidate ${clean(decision.candidate?.candidate_id, 300) || 'unknown'} is inspectable but non-executable before POK-35 admission\n`);
  } else if (decision.state === 'teacher_required') {
    process.stdout.write(`[archie] teacher required: ${clean(decision.reason, 1000)}\n`);
  } else if (decision.state === 'rejected') {
    process.stderr.write(`[archie] decision rejected: ${clean(decision.reason, 1000)}\n`);
  } else if (decision.state === 'failed') {
    process.stderr.write(`[archie] decision failed closed: ${clean(decision.reason, 1000)}\n`);
  } else {
    process.stdout.write(`[archie] no admitted local decision: ${clean(decision.reason, 1000)}\n`);
  }
  if (!decision.executable) process.stdout.write('[archie] ordinary Maker compatibility path selected; no local competence claimed\n');
}

async function main() {
  const argv = process.argv.slice(2);
  let options;
  try { options = parseMakerArgs(argv); }
  catch (error) {
    console.error(`maker: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (options.archieDecisionFile) throw new Error('--archie-decision-file is internal to the Archie launcher.');

  const root = await repoRoot();
  const baseSha = await resolveBaseSha(root, options.base);
  const makerArgv = [...argv];
  const makerEnv = {};
  let decisionRoot = null;
  let launch = null;

  if (options.request && !options.help) {
    launch = await resolveArchieMakerLaunch({
      repoRoot: root,
      request: options.request,
      baseBranch: options.base,
      baseSha,
      env: process.env
    });
    writeDecisionStatus(launch);
    process.stdout.write(`[archie:launcher-receipt] ${JSON.stringify(launch.receipt)}\n`);

    if (launch.execution_decision) {
      decisionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sideways-archie-maker-decision-'));
      const decisionPath = path.join(decisionRoot, 'decision.json');
      await fs.writeFile(decisionPath, `${JSON.stringify(launch.execution_decision, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      makerArgv.push('--archie-decision-file', decisionPath);
      makerEnv.ARCHIE_MAKER_DECISION_KEY = launch.execution_key;
    }
  }

  let result;
  try { result = await runMaker(makerArgv, root, { env: makerEnv }); }
  finally { if (decisionRoot) await fs.rm(decisionRoot, { recursive: true, force: true }); }

  if (result.code !== 0) {
    if (result.signal) process.stderr.write(`[archie] Maker terminated by ${result.signal}; memory was not updated.\n`);
    process.exitCode = result.code;
    return;
  }
  if (launch?.bypassed) return;

  const receipt = extractNativeMakerReceipt(result.stdout);
  if (!receipt) {
    process.stderr.write('[archie] Maker succeeded but emitted no sideways-maker-run/v2 receipt; memory was not updated.\n');
    return;
  }
  const memory = await rememberNativeMakerRun({ repoRoot: root, receipt: { ...receipt, repository: root } });
  if (memory.status === 'failed') {
    process.stderr.write(`[archie] Maker completed, but local memory update failed: ${clean(memory.error, 1000)}\n`);
    return;
  }
  process.stdout.write(`[archie] memory ${memory.status}; examples=${memory.document_count ?? 0} specialists=${memory.specialist_count ?? 0}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => {
    console.error(`maker: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}
