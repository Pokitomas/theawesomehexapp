#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { promisify } from 'node:util';
import {
  MAKER_LANES,
  buildIntegratorPrompt,
  buildLanePrompt,
  buildLease,
  buildWriterPrompt,
  codexExecArgs,
  expandCommandArgv,
  laneReportSchema,
  leaseMarker,
  parseCommandArgv,
  parseMakerArgs,
  planSchema,
  slugify
} from './maker-core.mjs';
import { readArchieMakerDecision } from './maker-archie-runtime-contract.mjs';

const execFileAsync = promisify(execFile);
const MAX_CAPTURE = 16 * 1024 * 1024;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function clean(value, limit = 12000) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
}

async function command(program, args = [], { cwd = process.cwd(), env = {}, timeout = 30 * 60 * 1000 } = {}) {
  try {
    const result = await execFileAsync(program, args, {
      cwd,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      maxBuffer: MAX_CAPTURE,
      timeout,
      windowsHide: true
    });
    return { ok: true, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
  } catch (error) {
    const detail = clean(`${error.stdout || ''}\n${error.stderr || error.message}`, 24000);
    const wrapped = new Error(`${program} ${args.join(' ')} failed.\n${detail}`);
    wrapped.cause = error;
    throw wrapped;
  }
}

async function probe(program, args = []) {
  try {
    const result = await command(program, args, { timeout: 30000 });
    return clean(result.stdout || result.stderr, 4000);
  } catch {
    return null;
  }
}

function runStreaming(program, args, { cwd, input, env = {}, label = program }) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      const text = String(chunk);
      stdout += text;
      if (stdout.length > MAX_CAPTURE) stdout = stdout.slice(-MAX_CAPTURE);
      process.stdout.write(`[${label}] ${text}`);
    });
    child.stderr.on('data', chunk => {
      const text = String(chunk);
      stderr += text;
      if (stderr.length > MAX_CAPTURE) stderr = stderr.slice(-MAX_CAPTURE);
      process.stderr.write(`[${label}] ${text}`);
    });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${label} exited with ${code}.\n${clean(stderr || stdout, 24000)}`));
    });
    child.stdin.end(input);
  });
}

function printHelp() {
  process.stdout.write(`Usage:\n  npm run maker -- "what you want completed"\n\nOptions:\n  --base <branch>          Base branch, default main\n  --agent codex|command   Local intelligence adapter, default codex\n  --command-json <json>   Explicit argv array for a custom agent; prompt is sent on stdin\n  --local-only            Skip GitHub push, draft PR, and Actions collision gate\n  --no-install            Skip npm ci --ignore-scripts in the writer worktree\n  --keep-worktree         Preserve the successful temporary worktree\n  --dry-run               Assess and synthesize without creating a branch\n\nCustom command placeholders: {workspace}, {output}, {schema}, {role}.\n`);
}

async function requestFromTerminal(options) {
  if (options.request) return options.request;
  if (!process.stdin.isTTY) return clean(await fs.readFile(0, 'utf8'), 12000);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return clean(await rl.question('Maker request: '), 12000); }
  finally { rl.close(); }
}

async function repoRoot() {
  const result = await command('git', ['rev-parse', '--show-toplevel']);
  return clean(result.stdout, 4000);
}

async function git(args, cwd, options = {}) {
  return command('git', args, {
    cwd,
    ...options,
    env: {
      GIT_AUTHOR_NAME: 'Sideways Maker',
      GIT_AUTHOR_EMAIL: 'sideways-maker@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'Sideways Maker',
      GIT_COMMITTER_EMAIL: 'sideways-maker@users.noreply.github.com',
      ...(options.env || {})
    }
  });
}

async function assertClean(root) {
  const status = clean((await git(['status', '--porcelain=v1'], root)).stdout);
  if (status) throw new Error(`Maker requires a clean launching checkout. Preserve or commit these changes first:\n${status}`);
}

async function writeSchema(target, schema) {
  await fs.writeFile(target, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
}

async function runAgent({ options, role, workspace, prompt, outputPath, schemaPath = '', sandbox = 'read-only' }) {
  await fs.rm(outputPath, { force: true });
  if (options.agent === 'codex') {
    const args = codexExecArgs({ workspace, sandbox, outputPath, schemaPath, json: true });
    await runStreaming('codex', args, { cwd: workspace, input: prompt, label: role });
  } else {
    const template = parseCommandArgv(options.commandJson);
    const argv = expandCommandArgv(template, { workspace, output: outputPath, schema: schemaPath, role });
    const [program, ...args] = argv;
    const result = await runStreaming(program, args, {
      cwd: workspace,
      input: prompt,
      label: role,
      env: {
        MAKER_WORKSPACE: workspace,
        MAKER_OUTPUT: outputPath,
        MAKER_SCHEMA: schemaPath,
        MAKER_ROLE: role,
        MAKER_SANDBOX: sandbox
      }
    });
    try { await fs.access(outputPath); }
    catch { await fs.writeFile(outputPath, result.stdout, 'utf8'); }
  }
  const text = await fs.readFile(outputPath, 'utf8');
  return JSON.parse(text);
}

async function runWriter({ options, workspace, prompt, outputPath }) {
  await fs.rm(outputPath, { force: true });
  if (options.agent === 'codex') {
    const args = codexExecArgs({ workspace, sandbox: 'workspace-write', outputPath, json: true });
    await runStreaming('codex', args, { cwd: workspace, input: prompt, label: 'writer' });
  } else {
    const template = parseCommandArgv(options.commandJson);
    const argv = expandCommandArgv(template, { workspace, output: outputPath, schema: '', role: 'writer' });
    const [program, ...args] = argv;
    const result = await runStreaming(program, args, {
      cwd: workspace,
      input: prompt,
      label: 'writer',
      env: {
        MAKER_WORKSPACE: workspace,
        MAKER_OUTPUT: outputPath,
        MAKER_SCHEMA: '',
        MAKER_ROLE: 'writer',
        MAKER_SANDBOX: 'workspace-write'
      }
    });
    try { await fs.access(outputPath); }
    catch { await fs.writeFile(outputPath, result.stdout, 'utf8'); }
  }
  return clean(await fs.readFile(outputPath, 'utf8'), 24000);
}

function sessionId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

async function openDraftPr({ root, branch, base, title, bodyPath }) {
  await command('gh', ['pr', 'create', '--draft', '--base', base, '--head', branch, '--title', title, '--body-file', bodyPath], { cwd: root });
  const info = await command('gh', ['pr', 'view', branch, '--json', 'number,url'], { cwd: root });
  return JSON.parse(info.stdout);
}

async function editPr({ root, number, bodyPath }) {
  await command('gh', ['pr', 'edit', String(number), '--body-file', bodyPath], { cwd: root });
}

async function waitForSprawl({ root, sha, timeoutMs = 30 * 60 * 1000 }) {
  const started = Date.now();
  let announced = false;
  while (Date.now() - started < timeoutMs) {
    let runs = [];
    try {
      const result = await command('gh', [
        'run', 'list',
        '--workflow', 'maker-sprawl.yml',
        '--commit', sha,
        '--limit', '10',
        '--json', 'databaseId,status,conclusion,url,headSha,event'
      ], { cwd: root, timeout: 60000 });
      runs = JSON.parse(result.stdout);
    } catch (error) {
      if (/could not find any workflows|HTTP 404|not found/i.test(error.message)) {
        throw new Error('Maker Actions sprawl workflow is not available on the default branch yet. Merge the Maker completion PR before using remote collision gating, or rerun with --local-only.');
      }
      throw error;
    }
    const run = runs.find(value => value.headSha === sha && value.event === 'pull_request') || runs.find(value => value.headSha === sha);
    if (!run) {
      if (!announced) {
        process.stdout.write('[maker] waiting for Actions collision/sprawl run to appear\n');
        announced = true;
      }
      await sleep(5000);
      continue;
    }
    if (run.status !== 'completed') {
      process.stdout.write(`[maker] Actions sprawl ${run.status}: ${run.url || run.databaseId}\n`);
      await sleep(10000);
      continue;
    }
    if (run.conclusion !== 'success') throw new Error(`Maker Actions sprawl failed with ${run.conclusion}: ${run.url || run.databaseId}`);
    process.stdout.write(`[maker] Actions collision/sprawl passed: ${run.url || run.databaseId}\n`);
    return run;
  }
  throw new Error(`Timed out waiting for Maker Actions sprawl at ${sha}.`);
}

function initialPrBody({ lease, plan, reports }) {
  return [
    leaseMarker(lease),
    '',
    '## Maker request',
    lease.request,
    '',
    '## Exclusive writer lease',
    `- session: \`${lease.session_id}\``,
    `- base: \`${lease.base_sha}\``,
    `- selected lane: \`${lease.selected_lane}\``,
    `- owned paths: ${lease.owned_paths.map(value => `\`${value}\``).join(', ')}`,
    '- writer count: 1',
    '',
    '## Why this lane',
    plan.why_now,
    '',
    '## Read-only assessment',
    ...reports.map(report => `- **${report.lane}:** ${report.summary}`),
    '',
    '## State',
    'Lease-only draft. Actions must prove no collision before the writer starts. Human merge and deployment remain required.'
  ].join('\n');
}

function finalPrBody({ lease, plan, reports, summary, verification, head }) {
  return [
    leaseMarker(lease),
    '',
    '## Maker request',
    lease.request,
    '',
    '## Implemented lane',
    `**${plan.selected_lane}:** ${plan.why_now}`,
    '',
    '## Writer receipt',
    summary || '_Agent returned no final prose receipt._',
    '',
    '## Independent verification',
    ...verification.map(value => `- PASS: \`${value}\``),
    `- exact head: \`${head}\``,
    '',
    '## Deferred sprawl',
    ...(plan.deferred.length ? plan.deferred.map(value => `- ${value}`) : ['- none recorded']),
    '',
    '## Assessment sources',
    ...reports.map(report => `- **${report.lane}:** ${report.evidence.slice(0, 4).map(value => `\`${value.path}\``).join(', ')}`),
    '',
    '## Authority',
    'Draft only. Human review, merge, deployment, secrets, and repository settings remain outside Maker authority.'
  ].join('\n');
}

async function main() {
  const options = parseMakerArgs(process.argv.slice(2));
  if (options.help) { printHelp(); return; }
  const request = await requestFromTerminal(options);
  if (!request) throw new Error('Maker needs a request. Example: npm run maker -- "finish the social product journey"');

  const root = await repoRoot();
  await assertClean(root);
  await git(['fetch', 'origin', '--prune'], root);
  const baseRef = `origin/${options.base}`;
  const baseSha = clean((await git(['rev-parse', '--verify', baseRef], root)).stdout, 100);
  const launchHead = clean((await git(['rev-parse', 'HEAD'], root)).stdout, 100);
  let archieDecision = null;
  if (options.archieDecisionFile) {
    const decisionKey = process.env.ARCHIE_MAKER_DECISION_KEY;
    try {
      archieDecision = await readArchieMakerDecision(options.archieDecisionFile, {
        request,
        repository: root,
        baseBranch: options.base,
        baseSha,
        key: decisionKey
      });
    } finally {
      delete process.env.ARCHIE_MAKER_DECISION_KEY;
    }
    process.stdout.write(`[maker] accepted integrity-bound Archie plan ${archieDecision.specialist_id || 'unknown'} for ${archieDecision.plan.selected_lane}\n`);
  }

  if (options.agent === 'codex') {
    const version = await probe('codex', ['--version']);
    if (!version) throw new Error('Codex is not installed. Install @openai/codex and sign in, or use --agent command.');
    const login = await probe('codex', ['login', 'status']);
    if (!login) throw new Error('Codex is not authenticated. Run codex login, then rerun Maker.');
    process.stdout.write(`[maker] intelligence: ${version}\n`);
  }
  if (!options.localOnly) {
    const gh = await probe('gh', ['auth', 'status']);
    if (!gh) throw new Error('GitHub CLI is required and must be authenticated for collision leases, Actions, push, and draft PR creation. Run gh auth login, or use --local-only.');
  }

  const id = sessionId();
  const sessionRoot = path.join(os.tmpdir(), 'sideways-maker', slugify(path.basename(root)), id);
  await fs.mkdir(sessionRoot, { recursive: true });
  let reports;
  let plan;
  let planSource;
  if (archieDecision) {
    plan = { ...archieDecision.plan };
    planSource = 'archie-native-recall';
    reports = [{
      lane: plan.selected_lane,
      summary: 'Maker accepted an integrity-bound reusable plan and skipped redundant repository-wide assessment.',
      evidence: [{ path: 'local Archie corpus', finding: `specialist=${archieDecision.specialist_id || 'unknown'} model=${archieDecision.model_digest || 'unknown'}` }],
      priority: 'high',
      recommended_lane: plan.selected_lane,
      owned_paths: plan.owned_paths,
      risks: ['The plan remains subject to lease, authority, writer, test, exact-tree, and human review gates.']
    }];
  } else {
    planSource = 'maker-integrator';
    const laneSchemaPath = path.join(sessionRoot, 'lane.schema.json');
    const planSchemaPath = path.join(sessionRoot, 'plan.schema.json');
    await Promise.all([writeSchema(laneSchemaPath, laneReportSchema), writeSchema(planSchemaPath, planSchema)]);
    process.stdout.write(`[maker] assessment HEAD: ${launchHead}\n[maker] spawning four read-only agents\n`);
    reports = await Promise.all(MAKER_LANES.map(async lane => {
      const outputPath = path.join(sessionRoot, `${lane.id}.json`);
      const report = await runAgent({
        options,
        role: lane.id,
        workspace: root,
        prompt: buildLanePrompt({ request, lane, head: baseSha }),
        outputPath,
        schemaPath: laneSchemaPath,
        sandbox: 'read-only'
      });
      if (report.lane !== lane.id) report.lane = lane.id;
      process.stdout.write(`[maker] ${lane.id}: ${report.priority} — ${clean(report.summary, 500)}\n`);
      return report;
    }));
    const planPath = path.join(sessionRoot, 'plan.json');
    plan = await runAgent({
      options,
      role: 'integrator',
      workspace: root,
      prompt: buildIntegratorPrompt({ request, head: baseSha, reports }),
      outputPath: planPath,
      schemaPath: planSchemaPath,
      sandbox: 'read-only'
    });
    plan.branch_slug = slugify(plan.branch_slug || plan.title, 'maker-work');
  }
  process.stdout.write(`[maker] selected ${plan.selected_lane} via ${planSource}: ${clean(plan.why_now, 1000)}\n`);
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({
      request,
      base_sha: baseSha,
      reports,
      plan,
      plan_source: planSource,
      archie_decision: archieDecision ? {
        specialist_id: archieDecision.specialist_id,
        confidence: archieDecision.confidence,
        margin: archieDecision.margin,
        model_digest: archieDecision.model_digest,
        plan_digest: archieDecision.plan_digest,
        execution_basis: archieDecision.execution_basis
      } : null
    }, null, 2)}\n`);
    return;
  }

  const branch = `maker/${plan.branch_slug}-${id}`;
  const worktree = path.join(sessionRoot, 'worktree');
  const lease = buildLease({
    sessionId: id,
    request,
    branch,
    baseBranch: options.base,
    baseSha,
    ownedPaths: plan.owned_paths,
    selectedLane: plan.selected_lane
  });

  await git(['worktree', 'add', '-b', branch, worktree, baseSha], root);
  let pr = null;
  let successful = false;
  try {
    if (!options.localOnly) {
      const leasePath = path.join(worktree, '.maker', 'lease.json');
      await fs.mkdir(path.dirname(leasePath), { recursive: true });
      await fs.writeFile(leasePath, `${JSON.stringify(lease, null, 2)}\n`, 'utf8');
      await git(['add', '.maker/lease.json'], worktree);
      await git(['commit', '-m', `[maker] acquire ${lease.session_id} path lease`], worktree);
      await git(['push', '--set-upstream', 'origin', branch], worktree, { timeout: 10 * 60 * 1000 });

      const initialBodyPath = path.join(sessionRoot, 'pr-initial.md');
      await fs.writeFile(initialBodyPath, `${initialPrBody({ lease, plan, reports })}\n`, 'utf8');
      pr = await openDraftPr({ root: worktree, branch, base: options.base, title: plan.title, bodyPath: initialBodyPath });
      process.stdout.write(`[maker] lease draft: ${pr.url}\n`);
      const leaseHead = clean((await git(['rev-parse', 'HEAD'], worktree)).stdout, 100);
      await waitForSprawl({ root: worktree, sha: leaseHead });
    }

    if (!options.noInstall) {
      process.stdout.write('[maker] installing locked dependencies\n');
      await command('npm', ['ci', '--ignore-scripts'], { cwd: worktree, timeout: 20 * 60 * 1000 });
    }

    const writerOutput = path.join(sessionRoot, 'writer.txt');
    const writerSummary = await runWriter({
      options,
      workspace: worktree,
      outputPath: writerOutput,
      prompt: buildWriterPrompt({ request, head: baseSha, plan, reports, lease })
    });

    await fs.rm(path.join(worktree, '.maker', 'lease.json'), { force: true });
    try { await fs.rmdir(path.join(worktree, '.maker')); } catch {}

    const verification = [];
    for (const [program, args] of [
      ['git', ['diff', '--check']],
      [process.execPath, ['scripts/native-changed-check.mjs']],
      ['npm', ['run', 'verify:repository']]
    ]) {
      process.stdout.write(`[maker] verify: ${program} ${args.join(' ')}\n`);
      await command(program, args, { cwd: worktree, timeout: 45 * 60 * 1000 });
      verification.push([program, ...args].join(' '));
    }

    const status = clean((await git(['status', '--porcelain=v1'], worktree)).stdout, 12000);
    const meaningful = status.split(/\r?\n/).filter(Boolean).filter(line => !line.includes('.maker/lease.json'));
    if (!meaningful.length) throw new Error('Writer finished without a repository patch. The lease PR remains draft for inspection.');

    await git(['add', '--all'], worktree);
    await git(['commit', '-m', `[maker:${plan.selected_lane}] ${clean(plan.title, 120)}`], worktree);
    if (!options.localOnly) await git(['push'], worktree, { timeout: 10 * 60 * 1000 });
    const finalHead = clean((await git(['rev-parse', 'HEAD'], worktree)).stdout, 100);

    if (pr) {
      const finalBodyPath = path.join(sessionRoot, 'pr-final.md');
      await fs.writeFile(finalBodyPath, `${finalPrBody({ lease, plan, reports, summary: writerSummary, verification, head: finalHead })}\n`, 'utf8');
      await editPr({ root: worktree, number: pr.number, bodyPath: finalBodyPath });
      await waitForSprawl({ root: worktree, sha: finalHead });
    }

    const receipt = {
      schema: 'sideways-maker-run/v2',
      state: 'completed',
      request,
      session_id: id,
      branch,
      base_sha: baseSha,
      head_sha: finalHead,
      selected_lane: plan.selected_lane,
      owned_paths: lease.owned_paths,
      plan,
      plan_source: planSource,
      archie_decision: archieDecision ? {
        specialist_id: archieDecision.specialist_id,
        confidence: archieDecision.confidence,
        margin: archieDecision.margin,
        model_digest: archieDecision.model_digest,
        plan_digest: archieDecision.plan_digest,
        execution_basis: archieDecision.execution_basis
      } : null,
      writer_summary: writerSummary,
      verification,
      pull_request: pr?.url || null,
      worktree: options.keepWorktree ? worktree : null,
      deferred: plan.deferred
    };
    await fs.writeFile(path.join(sessionRoot, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    process.stdout.write(`\n${JSON.stringify(receipt, null, 2)}\n`);
    successful = true;
  } finally {
    if (successful && !options.keepWorktree) {
      await git(['worktree', 'remove', '--force', worktree], root).catch(() => {});
    } else if (!successful) {
      process.stderr.write(`[maker] recovery worktree preserved: ${worktree}\n[maker] branch: ${branch}\n${pr?.url ? `[maker] draft PR: ${pr.url}\n` : ''}`);
    }
  }
}

main().catch(error => {
  console.error(`maker: ${error.stack || error.message}`);
  process.exitCode = 1;
});
