#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseMakerArgs } from './maker-core.mjs';
import { recallNativeMakerPlan, rememberNativeMakerRun } from './maker-archie-native.mjs';

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

async function repoRoot() {
  const result = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 30000 });
  return clean(result.stdout, 4000);
}

function runMaker(argv, root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts', 'maker.mjs'), ...argv], {
      cwd: root,
      env: process.env,
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
    child.once('close', code => resolve({ code: Number(code || 0), stdout }));
  });
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
  const root = await repoRoot();
  if (options.request && !options.help) {
    const recalled = await recallNativeMakerPlan({ repoRoot: root, request: options.request, baseBranch: options.base });
    if (recalled.status === 'local') {
      process.stdout.write(`[archie] reusable local plan ${recalled.specialist_id} confidence=${Number(recalled.confidence).toFixed(3)} margin=${Number(recalled.margin).toFixed(3)}\n`);
      process.stdout.write(`${JSON.stringify(recalled.plan, null, 2)}\n`);
    } else if (recalled.status === 'failed') {
      process.stderr.write(`[archie] recall failed closed: ${clean(recalled.reason, 1000)}\n`);
    } else if (recalled.status === 'miss') {
      process.stdout.write(`[archie] no reusable local plan (${clean(recalled.reason || 'miss', 300)})\n`);
    }
  }

  const result = await runMaker(argv, root);
  if (result.code !== 0) {
    process.exitCode = result.code;
    return;
  }
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
