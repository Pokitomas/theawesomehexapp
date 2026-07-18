#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { collectRepositoryEvidence } from './maker-archie-repository-evidence.mjs';
import { codexExecArgs, expandCommandArgv, parseCommandArgv, slugify } from './maker-core.mjs';

const execFileAsync = promisify(execFile);
const MAX_CAPTURE = 16 * 1024 * 1024;
const BLOCKED_SCRIPT = /(?:^|:)(?:deploy|publish|release|ship|upload|migrate|production|prod)(?:$|:)/i;
const clean = (value, limit = 12000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const digest = value => createHash('sha256').update(value).digest('hex');
const remoteSource = value => /^[a-z][a-z0-9+.-]*:\/\//i.test(value);

function parseArgs(argv) {
  const result = { source: '', output: '', artifacts: '', objective: '', base: '', agent: 'codex', commandJson: '', maxPasses: 3, prepareOnly: false, install: false, verify: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const take = () => {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${token} requires a value.`);
      return value;
    };
    if (token === '--source') result.source = take();
    else if (token === '--output') result.output = take();
    else if (token === '--artifacts') result.artifacts = take();
    else if (token === '--objective') result.objective = take();
    else if (token === '--base') result.base = take();
    else if (token === '--agent') result.agent = take();
    else if (token === '--command-json') result.commandJson = take();
    else if (token === '--max-passes') result.maxPasses = Number(take());
    else if (token === '--verify') result.verify.push(take());
    else if (token === '--prepare-only') result.prepareOnly = true;
    else if (token === '--install') result.install = true;
    else if (token === '--help' || token === '-h') result.help = true;
    else throw new Error(`Unknown option: ${token}`);
  }
  if (result.help) return result;
  for (const key of ['source', 'output', 'objective']) if (!result[key]) throw new Error(`--${key} is required.`);
  if (!['codex', 'command'].includes(result.agent)) throw new Error('--agent must be codex or command.');
  if (result.agent === 'command' && !result.commandJson && !result.prepareOnly) throw new Error('--command-json is required with --agent command.');
  if (!Number.isInteger(result.maxPasses) || result.maxPasses < 1 || result.maxPasses > 8) throw new Error('--max-passes must be 1 through 8.');
  return result;
}

function help() {
  process.stdout.write(`Usage:\n  npm run archie:repository:complete -- --source <git-url-or-path> --output <isolated-clone> --objective <finished outcome>\n\nOptions: --base <branch> --artifacts <dir> --agent codex|command --command-json <json> --max-passes <1-8> --verify <command> --install --prepare-only\n\nThe source remote becomes upstream-readonly with a disabled push URL. This command never pushes, opens a PR, merges, deploys, publishes, or changes the source checkout.\n`);
}

async function run(program, args = [], { cwd = process.cwd(), env = {}, allowFailure = false, timeout = 30 * 60 * 1000 } = {}) {
  try {
    const result = await execFileAsync(program, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: MAX_CAPTURE, timeout, windowsHide: true });
    return { ok: true, code: 0, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
  } catch (error) {
    const result = { ok: false, code: Number.isInteger(error.code) ? error.code : 1, stdout: String(error.stdout || ''), stderr: String(error.stderr || error.message || '') };
    if (allowFailure) return result;
    throw new Error(`${program} ${args.join(' ')} failed.\n${clean(`${result.stdout}\n${result.stderr}`, 24000)}`);
  }
}

function stream(program, args, { cwd, input, env, label }) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-MAX_CAPTURE); process.stdout.write(`[${label}] ${chunk}`); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-MAX_CAPTURE); process.stderr.write(`[${label}] ${chunk}`); });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${label} exited with ${code}.\n${clean(stderr || stdout, 24000)}`)));
    child.stdin.end(input);
  });
}

async function empty(target, label) {
  try { if ((await fs.readdir(target)).length) throw new Error(`${label} must be empty: ${target}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function sourceValue(value) {
  const text = clean(value, 8000);
  if (!remoteSource(text)) return path.resolve(text);
  const url = new URL(text);
  if (url.username || url.password) throw new Error('Credential-bearing source URLs are refused.');
  return url.toString();
}

async function sourceState(source) {
  if (remoteSource(source)) return null;
  const probe = await run('git', ['-C', source, 'rev-parse', '--is-inside-work-tree'], { allowFailure: true, timeout: 30000 });
  if (!probe.ok || clean(probe.stdout) !== 'true') return null;
  const head = clean((await run('git', ['-C', source, 'rev-parse', 'HEAD'], { timeout: 30000 })).stdout, 128);
  const status = (await run('git', ['-C', source, 'status', '--porcelain=v1'], { timeout: 30000 })).stdout;
  return { source, fingerprint: digest(`${head}\n${status}`) };
}

async function clone(source, output, base) {
  const args = ['clone', '--no-tags', '--origin', 'upstream-readonly'];
  if (!remoteSource(source)) args.push('--no-hardlinks');
  if (base) args.push('--branch', base, '--single-branch');
  await run('git', [...args, source, output], { timeout: 20 * 60 * 1000 });
  await run('git', ['-C', output, 'remote', 'set-url', '--push', 'upstream-readonly', 'disabled://archie-read-only-source'], { timeout: 30000 });
  const sourceSha = clean((await run('git', ['-C', output, 'rev-parse', 'HEAD'], { timeout: 30000 })).stdout, 128);
  const branch = `archie/completion-${slugify(path.basename(output), 'repository')}-${sourceSha.slice(0, 8)}`;
  await run('git', ['-C', output, 'switch', '-c', branch], { timeout: 30000 });
  return { sourceSha, branch };
}

const shell = text => process.platform === 'win32'
  ? { program: 'cmd.exe', args: ['/d', '/s', '/c', text], display: text }
  : { program: '/bin/sh', args: ['-lc', text], display: text };

async function verification(root, explicit) {
  if (explicit.length) return explicit.map(shell);
  let packageJSON = null;
  try { packageJSON = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')); } catch {}
  const scripts = packageJSON?.scripts || {};
  const priorities = ['test', 'typecheck', 'check', 'lint', 'build', 'verify'];
  const names = Object.keys(scripts).filter(name => !BLOCKED_SCRIPT.test(name))
    .filter(name => priorities.includes(name) || /^(?:test|check|verify|lint|typecheck)(?::|$)/.test(name))
    .sort((a, b) => (priorities.indexOf(a) < 0 ? 99 : priorities.indexOf(a)) - (priorities.indexOf(b) < 0 ? 99 : priorities.indexOf(b)) || a.localeCompare(b)).slice(0, 8);
  if (names.length) return names.map(name => ({ program: 'npm', args: ['run', name], display: `npm run ${name}` }));
  const exists = name => fs.access(path.join(root, name)).then(() => true, () => false);
  if (await exists('pyproject.toml') || await exists('pytest.ini')) return [{ program: 'python', args: ['-m', 'pytest'], display: 'python -m pytest' }];
  if (await exists('go.mod')) return [{ program: 'go', args: ['test', './...'], display: 'go test ./...' }];
  if (await exists('Cargo.toml')) return [{ program: 'cargo', args: ['test', '--all-targets'], display: 'cargo test --all-targets' }];
  return [];
}

async function verify(root, commands, artifacts, label) {
  if (!commands.length) return [{ command: null, ok: false, code: null, log: null, tail: 'No verification command discovered; supply --verify.' }];
  const results = [];
  for (let i = 0; i < commands.length; i += 1) {
    const command = commands[i];
    const result = await run(command.program, command.args, { cwd: root, allowFailure: true, timeout: 45 * 60 * 1000 });
    const log = `${result.stdout}${result.stderr ? `\n[stderr]\n${result.stderr}` : ''}`;
    const name = `${label}-${String(i + 1).padStart(2, '0')}-${slugify(command.display, 'verification')}.log`;
    await fs.writeFile(path.join(artifacts, name), log);
    results.push({ command: command.display, ok: result.ok, code: result.code, log: name, tail: clean(log, 8000) });
  }
  return results;
}

function prompt(options, sourceSha, evidence, failures, pass) {
  return [
    'You are the sole writer inside an isolated clone. Finish the repository for the stated objective, not merely describe work.',
    `Objective: ${options.objective}`,
    `Exact source commit: ${sourceSha}`,
    `Archie evidence digest: ${evidence.evidence_digest}`,
    `Pass: ${pass} of ${options.maxPasses}`,
    'Do not push, open or merge PRs, deploy, publish, spend money, accept legal terms, request credentials, or alter the source checkout.',
    'Resolve root causes, preserve unrelated behavior, add tests when needed, leave a complete patch, and finish with a concise receipt.',
    `Repository inventory: ${JSON.stringify({ paths: evidence.path_count, source_files: evidence.source_file_count, scripts: evidence.package_scripts, dependencies: evidence.package_dependencies, recent_commits: evidence.recent_commits }, null, 2)}`,
    `Current failures: ${JSON.stringify(failures.filter(item => !item.ok).map(item => ({ command: item.command, code: item.code, tail: item.tail })), null, 2)}`
  ].join('\n\n');
}

async function writer(options, workspace, artifacts, input, pass) {
  const output = path.join(artifacts, `writer-pass-${pass}.txt`);
  await fs.writeFile(path.join(artifacts, `prompt-pass-${pass}.txt`), `${input}\n`);
  if (options.agent === 'codex') {
    if (!(await run('codex', ['--version'], { allowFailure: true, timeout: 30000 })).ok) throw new Error('Codex is not installed; use --agent command or install/authenticate Codex.');
    await stream('codex', codexExecArgs({ workspace, sandbox: 'workspace-write', outputPath: output, json: false }), { cwd: workspace, input, label: `writer-${pass}` });
  } else {
    const [program, ...args] = expandCommandArgv(parseCommandArgv(options.commandJson), { workspace, output, schema: '', role: `writer-${pass}` });
    const result = await stream(program, args, { cwd: workspace, input, label: `writer-${pass}`, env: { ARCHIE_COMPLETION_WORKSPACE: workspace, ARCHIE_COMPLETION_OUTPUT: output, ARCHIE_COMPLETION_PASS: String(pass), ARCHIE_COMPLETION_OBJECTIVE: options.objective } });
    try { await fs.access(output); } catch { await fs.writeFile(output, result.stdout); }
  }
  return clean(await fs.readFile(output, 'utf8').catch(() => ''), 24000);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return help();
  const source = sourceValue(options.source);
  const output = path.resolve(options.output);
  const artifacts = path.resolve(options.artifacts || `${output}.archie-completion`);
  if (!remoteSource(source)) {
    const relative = path.relative(source, output);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) throw new Error('Output cannot be the source or nested inside it.');
  }
  await empty(output, 'Output');
  await empty(artifacts, 'Artifacts');
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.mkdir(artifacts, { recursive: true });
  const before = await sourceState(source);
  const isolated = await clone(source, output, options.base);
  const evidence = await collectRepositoryEvidence({ repoRoot: output, baseSha: isolated.sourceSha, request: options.objective, maxPaths: 100000, maxSourceFiles: 96, maxFileBytes: 24 * 1024, maxSourceBytes: 512 * 1024 });
  await fs.writeFile(path.join(artifacts, 'repository-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  if (options.install && await fs.access(path.join(output, 'package-lock.json')).then(() => true, () => false)) await run('npm', ['ci', '--ignore-scripts'], { cwd: output, timeout: 30 * 60 * 1000 });
  const commands = await verification(output, options.verify);
  const baseline = await verify(output, commands, artifacts, 'baseline');
  let finalVerification = baseline;
  const passes = [];
  if (!options.prepareOnly) for (let pass = 1; pass <= options.maxPasses; pass += 1) {
    const summary = await writer(options, output, artifacts, prompt(options, isolated.sourceSha, evidence, finalVerification, pass), pass);
    const diffCheck = await run('git', ['-C', output, 'diff', '--check'], { allowFailure: true, timeout: 30000 });
    finalVerification = await verify(output, commands, artifacts, `pass-${pass}`);
    const passed = diffCheck.ok && finalVerification.every(item => item.ok);
    passes.push({ pass, summary, diff_check_ok: diffCheck.ok, verification: finalVerification, passed });
    if (passed) break;
  }
  const status = clean((await run('git', ['-C', output, 'status', '--porcelain=v1'], { timeout: 30000 })).stdout, 64000);
  if (status) await run('git', ['-C', output, 'add', '--intent-to-add', '--all'], { timeout: 30000 });
  const patch = (await run('git', ['-C', output, 'diff', '--binary', isolated.sourceSha], { timeout: 120000 })).stdout;
  if (status) await run('git', ['-C', output, 'reset', '--mixed', isolated.sourceSha], { timeout: 30000 });
  const patchFile = path.join(artifacts, 'completion.patch');
  await fs.writeFile(patchFile, patch);
  const after = await sourceState(source);
  const sourceUnchanged = !before || before.fingerprint === after?.fingerprint;
  if (!sourceUnchanged) throw new Error('Source checkout changed; refusing to admit the run.');
  const completed = patch && finalVerification.every(item => item.ok) && passes.at(-1)?.diff_check_ok;
  const receipt = { schema: 'archie-external-repository-completion/v1', state: options.prepareOnly ? 'prepared' : completed ? 'completed' : 'incomplete', objective: options.objective, source: remoteSource(source) ? source : path.basename(source), source_sha: isolated.sourceSha, isolated_branch: isolated.branch, isolated_workspace: output, upstream_remote: 'upstream-readonly', upstream_push_url: 'disabled://archie-read-only-source', source_checkout_unchanged: sourceUnchanged, evidence_digest: evidence.evidence_digest, verification_commands: commands.map(item => item.display), baseline, passes, final_verification: finalVerification, changed: Boolean(status), status, patch_file: patchFile, patch_sha256: digest(patch), limitations: ['No push, PR, merge, deploy, publish, repository-setting, spending, legal, credential, or production-data authority is exercised.', 'Completion proves only the isolated clone, emitted patch, and executed verification commands.'] };
  await fs.writeFile(path.join(artifacts, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (receipt.state === 'incomplete') process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main().catch(error => { console.error(`archie repository completion: ${error.stack || error.message}`); process.exitCode = 1; });
