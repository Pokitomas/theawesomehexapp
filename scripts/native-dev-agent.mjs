import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseModelJSON } from './open-model-adapter.mjs';
import { terminalReleaseForNativeAgent } from './maker-terminal-release.mjs';

const execFileAsync = promisify(execFile);
const clean = (value, limit = 20000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const BLOCKED_SEGMENTS = new Set(['.git', 'node_modules', '.netlify', '.cache']);
const BLOCKED_BASENAMES = [/^\.env(?:\.|$)/i, /(?:^|\.)private[-_]?key/i, /\.pem$/i, /\.p12$/i, /\.pfx$/i, /credentials?/i];
const BLOCKED_WRITE_PREFIXES = [
  '.github/workflows/',
  '.github/actions/',
  'audit/authority-manifest',
  '.frankenstate',
  'CODEOWNERS'
];
const MAX_FILE_BYTES = 240000;
const MAX_OBSERVATION = 24000;

export function normalizeAgentBudget(input = {}) {
  const bounded = (name, fallback, min, max) => {
    const value = input[name] === undefined ? fallback : Number(input[name]);
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid native agent budget: ${name}.`);
    return Math.floor(value);
  };
  return Object.freeze({
    max_turns: bounded('max_turns', 24, 1, 64),
    max_writes: bounded('max_writes', 12, 0, 64),
    max_total_write_bytes: bounded('max_total_write_bytes', 600000, 0, 4000000),
    max_model_tokens: bounded('max_model_tokens', 4096, 256, 32000)
  });
}

export function resolveWorkspacePath(root, relative) {
  const raw = clean(relative, 1000).replace(/\\/g, '/');
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) throw new Error('Path must be repository-relative.');
  const parts = raw.split('/').filter(Boolean);
  if (parts.some(part => part === '..' || BLOCKED_SEGMENTS.has(part))) throw new Error(`Blocked repository path: ${raw}.`);
  if (BLOCKED_BASENAMES.some(pattern => pattern.test(parts.at(-1) || ''))) throw new Error(`Secret-like repository path is blocked: ${raw}.`);
  const base = path.resolve(root);
  const absolute = path.resolve(base, ...parts);
  if (absolute !== base && !absolute.startsWith(`${base}${path.sep}`)) throw new Error(`Path escapes repository: ${raw}.`);
  return { relative: parts.join('/'), absolute };
}

function assertWritable(target) {
  if (BLOCKED_WRITE_PREFIXES.some(prefix => target.relative === prefix || target.relative.startsWith(prefix))) {
    throw new Error(`Native worker cannot alter authority surface: ${target.relative}.`);
  }
}

async function runFixed(root, witness, timeout = 180000) {
  const definitions = {
    'git-diff-check': ['git', ['diff', '--check']],
    'node-check-changed': ['node', ['scripts/native-changed-check.mjs']],
    'verify-repository': ['npm', ['run', 'verify:repository']],
    'test-weave': ['npm', ['run', 'test:weave']],
    'test-recursive-weave': ['npm', ['run', 'test:recursive-weave']],
    'test-authority': ['npm', ['run', 'test:authority']]
  };
  const selected = definitions[clean(witness, 100)];
  if (!selected) throw new Error(`Witness is not allowlisted: ${clean(witness, 100)}.`);
  const env = {
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || '',
    CI: '1',
    NODE_ENV: 'test',
    NO_COLOR: '1'
  };
  try {
    const result = await execFileAsync(selected[0], selected[1], {
      cwd: root,
      env,
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true
    });
    return { ok: true, witness, stdout: clean(result.stdout, MAX_OBSERVATION), stderr: clean(result.stderr, MAX_OBSERVATION) };
  } catch (error) {
    return {
      ok: false,
      witness,
      code: error.code ?? null,
      stdout: clean(error.stdout, MAX_OBSERVATION),
      stderr: clean(error.stderr || error.message, MAX_OBSERVATION)
    };
  }
}

async function trackedFiles(root) {
  const { stdout } = await execFileAsync('git', ['ls-files'], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
  return stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean).filter(file => {
    try { resolveWorkspacePath(root, file); return true; }
    catch { return false; }
  });
}

async function toolObservation({ root, action, counters }) {
  const tool = clean(action?.tool, 80).toLowerCase();
  if (tool === 'list') {
    const files = await trackedFiles(root);
    const prefix = clean(action.prefix, 500);
    const selected = prefix ? files.filter(file => file.startsWith(prefix)) : files;
    return { tool, files: selected.slice(0, 800), truncated: selected.length > 800 };
  }
  if (tool === 'read') {
    const target = resolveWorkspacePath(root, action.path);
    const stat = await fs.stat(target.absolute);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error(`File is not bounded UTF-8 text: ${target.relative}.`);
    const lines = (await fs.readFile(target.absolute, 'utf8')).split(/\r?\n/);
    const start = Math.max(1, Number(action.start || 1) || 1);
    const end = Math.min(lines.length, Math.max(start, Number(action.end || start + 239) || start + 239));
    return { tool, path: target.relative, start, end, total_lines: lines.length, content: lines.slice(start - 1, end).join('\n') };
  }
  if (tool === 'search') {
    const query = clean(action.query, 1000);
    if (!query) throw new Error('Search query is required.');
    try {
      const { stdout } = await execFileAsync('git', ['grep', '-n', '-I', '--fixed-strings', '--', query], {
        cwd: root,
        maxBuffer: 4 * 1024 * 1024
      });
      const matches = stdout.split(/\r?\n/).filter(Boolean);
      return { tool, query, matches: matches.slice(0, 300), truncated: matches.length > 300 };
    } catch (error) {
      if (error.code === 1) return { tool, query, matches: [], truncated: false };
      throw error;
    }
  }
  if (tool === 'write') {
    if (counters.writes >= counters.budget.max_writes) throw new Error('Write budget exhausted.');
    const target = resolveWorkspacePath(root, action.path);
    assertWritable(target);
    const content = String(action.content ?? '').replace(/\u0000/g, '');
    const bytes = Buffer.byteLength(content);
    if (bytes > MAX_FILE_BYTES) throw new Error(`Single write exceeds ${MAX_FILE_BYTES} bytes.`);
    if (counters.total_write_bytes + bytes > counters.budget.max_total_write_bytes) throw new Error('Total write budget exhausted.');
    await fs.mkdir(path.dirname(target.absolute), { recursive: true });
    await fs.writeFile(target.absolute, content, 'utf8');
    counters.writes += 1;
    counters.total_write_bytes += bytes;
    return { tool, path: target.relative, bytes, writes_used: counters.writes, total_write_bytes: counters.total_write_bytes };
  }
  if (tool === 'run') {
    const result = await runFixed(root, action.witness);
    if (result.ok) counters.successful_witnesses.add(result.witness);
    return result;
  }
  if (tool === 'status') {
    const [{ stdout: status }, { stdout: diff }] = await Promise.all([
      execFileAsync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, maxBuffer: 1024 * 1024 }),
      execFileAsync('git', ['diff', '--stat'], { cwd: root, maxBuffer: 1024 * 1024 })
    ]);
    counters.saw_status = true;
    return { tool, status: clean(status, MAX_OBSERVATION), diff_stat: clean(diff, MAX_OBSERVATION) };
  }
  if (tool === 'finish') {
    if (!counters.saw_status) throw new Error('Finish rejected: inspect repository status first.');
    if (!counters.successful_witnesses.size) throw new Error('Finish rejected: run at least one successful allowlisted witness.');
    return {
      tool,
      finished: true,
      summary: clean(action.summary, 4000),
      tests: [...counters.successful_witnesses],
      claimed_tests: Array.isArray(action.tests) ? action.tests.map(value => clean(value, 500)).filter(Boolean).slice(0, 30) : [],
      risks: Array.isArray(action.risks) ? action.risks.map(value => clean(value, 500)).filter(Boolean).slice(0, 30) : []
    };
  }
  throw new Error(`Unknown native tool: ${tool || 'missing'}.`);
}

function systemPrompt() {
  return [
    'You are the implementation worker inside a bounded repository checkout.',
    'Return exactly one JSON object per turn and no other text.',
    'Available actions:',
    '{"tool":"list","prefix":"optional/path"}',
    '{"tool":"read","path":"relative/file","start":1,"end":240}',
    '{"tool":"search","query":"literal text"}',
    '{"tool":"write","path":"relative/file","content":"complete UTF-8 contents"}',
    '{"tool":"run","witness":"git-diff-check|node-check-changed|verify-repository|test-weave|test-recursive-weave|test-authority"}',
    '{"tool":"status"}',
    '{"tool":"finish","summary":"what changed","tests":["claimed context only"],"risks":["remaining risks"]}',
    'You have no shell, network, package installation, credentials, authority-surface write, merge, deploy, repository settings, or external messaging authority.',
    'Read before writing. Keep changes minimal. Never claim a witness passed unless its observation says ok=true.',
    'The runtime will reject finish until status was inspected and a fixed witness succeeded.'
  ].join('\n');
}

export async function runNativeDevAgent({
  root = process.cwd(),
  intent,
  model_client,
  budget: budgetInput = {},
  on_turn = null,
  generation_id = 'native-agent',
  outer_receipt_id = 'native-agent-result'
} = {}) {
  if (!model_client?.complete) throw new Error('A model client is required.');
  const budget = normalizeAgentBudget(budgetInput);
  const counters = { budget, writes: 0, total_write_bytes: 0, saw_status: false, successful_witnesses: new Set() };
  const conversation = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: JSON.stringify({ intent, repository_root: '.', budget }) }
  ];
  const transcript = [];

  for (let turn = 0; turn < budget.max_turns; turn += 1) {
    const response = await model_client.complete(conversation, { temperature: 0.05, max_tokens: budget.max_model_tokens });
    let action;
    try { action = parseModelJSON(response.text); }
    catch (error) {
      const observation = { ok: false, error: clean(error.message, 1000), required: 'Return one valid JSON tool object.' };
      transcript.push({ turn, action: null, observation });
      conversation.push({ role: 'assistant', content: response.text }, { role: 'user', content: JSON.stringify(observation) });
      continue;
    }

    let observation;
    try { observation = { ok: true, ...(await toolObservation({ root, action, counters })) }; }
    catch (error) { observation = { ok: false, tool: clean(action?.tool, 80), error: clean(error.message, 2000) }; }
    transcript.push({ turn, action, observation });
    if (on_turn) await on_turn({ turn, action, observation });
    if (observation.finished) {
      const [{ stdout: status }, { stdout: diff }] = await Promise.all([
        execFileAsync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, maxBuffer: 1024 * 1024 }),
        execFileAsync('git', ['diff', '--stat'], { cwd: root, maxBuffer: 1024 * 1024 })
      ]);
      return {
        status: 'finished',
        summary: observation.summary,
        tests: observation.tests,
        claimed_tests: observation.claimed_tests,
        risks: observation.risks,
        writes: counters.writes,
        total_write_bytes: counters.total_write_bytes,
        git_status: clean(status, MAX_OBSERVATION),
        diff_stat: clean(diff, MAX_OBSERVATION),
        transcript,
        termination: terminalReleaseForNativeAgent({ status: 'finished', generation_id, outer_receipt_id })
      };
    }
    conversation.push(
      { role: 'assistant', content: JSON.stringify(action) },
      { role: 'user', content: JSON.stringify(observation).slice(0, MAX_OBSERVATION) }
    );
  }

  return {
    status: 'budget_exhausted',
    writes: counters.writes,
    total_write_bytes: counters.total_write_bytes,
    transcript,
    termination: terminalReleaseForNativeAgent({ status: 'budget_exhausted', generation_id, outer_receipt_id })
  };
}
