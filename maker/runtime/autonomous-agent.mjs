import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { MakerEngine } from '../../scripts/maker-engine.mjs';

const execFileAsync = promisify(execFile);
const clean = (value, limit = 20000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const MAX_OBSERVATION = 24000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const BLOCKED = new Set(['.git', 'node_modules', '.netlify', '.cache']);

function parseModelJSON(value) {
  const text = String(value ?? '').trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced ? fenced[1] : text);
}

function prompt() {
  return [
    'You are Maker, an autonomous software engineer inside one authorized repository checkout.',
    'Return exactly one JSON object per turn and no prose.',
    'Before mutation, inspect and then acquire one exact lease:',
    '{"tool":"list","prefix":"optional/path"}',
    '{"tool":"read","path":"relative/file","start":1,"end":240}',
    '{"tool":"search","query":"literal text","prefix":"optional/path"}',
    '{"tool":"lease","owned_paths":["exact/file","directory/**"],"summary":"why these paths are sufficient"}',
    'After the lease:',
    '{"tool":"write","path":"relative/file","content":"complete UTF-8 contents"}',
    '{"tool":"replace","path":"relative/file","before":"exact text","after":"replacement","expected":1}',
    '{"tool":"delete","path":"relative/file"}',
    '{"tool":"run","program":"allowlisted executable","args":["argv","only"]}',
    '{"tool":"repair_start","failure_id":"failure-1","hypothesis":"falsifiable root-cause claim"}',
    'After mutation, rerun the exact failing command. repair_complete is rejected until that command succeeds.',
    '{"tool":"repair_complete","failure_id":"failure-1","evidence":"what changed and why the successful rerun proves it"}',
    '{"tool":"checkpoint","label":"meaningful state"}',
    '{"tool":"verify","commands":[{"program":"...","args":["..."]}]}',
    '{"tool":"status"}',
    '{"tool":"rollback","reason":"why"}',
    '{"tool":"cancel","reason":"why"}',
    '{"tool":"finish","summary":"implemented result","risks":["remaining external facts"]}',
    'No shell strings, network, credentials, merge, deploy, production data, repository settings, or training-spend authority.',
    'A failed command freezes mutation until repair_start records a hypothesis. Failed repair probes remain attached to the same failure.',
    'Do not claim a test passed unless the engine observation says ok=true. Finish is rejected until state=ready.'
  ].join('\n');
}

async function trackedFiles(root) {
  const { stdout } = await execFileAsync('git', ['ls-files'], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
  return stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
}

function resolveReadPath(root, relative) {
  const raw = clean(relative, 1000).replace(/\\/g, '/');
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) throw new Error('Path must be repository-relative.');
  const parts = raw.split('/').filter(Boolean);
  if (parts.some(part => part === '..' || BLOCKED.has(part))) throw new Error(`Blocked repository path: ${raw}.`);
  const base = path.resolve(root);
  const absolute = path.resolve(base, ...parts);
  if (!absolute.startsWith(`${base}${path.sep}`) && absolute !== base) throw new Error(`Path escapes repository: ${raw}.`);
  return { relative: parts.join('/'), absolute };
}

async function readBeforeLease(root, action) {
  const target = resolveReadPath(root, action.path);
  const stat = await fs.stat(target.absolute);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error(`File is not bounded UTF-8 text: ${target.relative}.`);
  const lines = (await fs.readFile(target.absolute, 'utf8')).split(/\r?\n/);
  const start = Math.max(1, Number(action.start || 1) || 1);
  const end = Math.min(lines.length, Math.max(start, Number(action.end || start + 239) || start + 239));
  return { tool: 'read', path: target.relative, start, end, total_lines: lines.length, content: lines.slice(start - 1, end).join('\n') };
}

async function searchBeforeLease(root, action) {
  const query = clean(action.query, 1000);
  if (!query) throw new Error('Search query is required.');
  const prefix = clean(action.prefix, 1000);
  const files = (await trackedFiles(root)).filter(file => !prefix || file.startsWith(prefix));
  const matches = [];
  for (const file of files) {
    let text;
    try {
      const target = resolveReadPath(root, file);
      const stat = await fs.stat(target.absolute);
      if (stat.size > MAX_FILE_BYTES) continue;
      text = await fs.readFile(target.absolute, 'utf8');
    } catch { continue; }
    text.split(/\r?\n/).forEach((line, index) => {
      if (line.includes(query) && matches.length < 300) matches.push(`${file}:${index + 1}:${clean(line, 1000)}`);
    });
  }
  return { tool: 'search', query, matches, truncated: matches.length >= 300 };
}

function resultSummary(engine, transcript, summary, risks) {
  const state = engine.snapshot();
  return {
    status: 'finished',
    summary: clean(summary, 4000),
    tests: (state.verification || []).filter(value => value.ok).map(value => [value.program, ...(value.args || [])].join(' ')),
    claimed_tests: [],
    risks: Array.isArray(risks) ? risks.map(value => clean(value, 1000)).filter(Boolean) : [],
    writes: state.events.filter(value => value.type === 'file_written' || value.type === 'file_deleted').length,
    total_write_bytes: state.events.filter(value => value.type === 'file_written').reduce((sum, value) => sum + Number(value.payload?.bytes || 0), 0),
    transcript,
    receipt: state.receipt,
    lease: state.lease,
    failures: state.failures,
    verification: state.verification
  };
}

export async function runAutonomousMakerAgent({
  root = process.cwd(),
  task,
  model_client,
  state_path,
  active_leases = [],
  command_policy = [],
  budget = {},
  on_turn = null
} = {}) {
  if (!model_client?.complete) throw new Error('A model client is required.');
  if (!state_path) throw new Error('An external Maker state path is required.');
  const maxTurns = Math.max(1, Math.min(96, Number(budget.max_turns || 32)));
  const maxTokens = Math.max(256, Math.min(32000, Number(budget.max_model_tokens || 4096)));
  const conversation = [
    { role: 'system', content: prompt() },
    { role: 'user', content: JSON.stringify({ task, active_leases, command_policy, requirement: 'Inspect, lease, implement, repair failures, verify, then finish.' }) }
  ];
  const transcript = [];
  let engine = null;

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const response = await model_client.complete(conversation, { temperature: 0.05, max_tokens: maxTokens });
    let action;
    try { action = parseModelJSON(response.text); }
    catch (error) {
      const observation = { ok: false, error: clean(error.message, 1000), required: 'Return one valid JSON tool object.' };
      transcript.push({ turn, action: null, observation });
      conversation.push({ role: 'assistant', content: response.text }, { role: 'user', content: JSON.stringify(observation) });
      continue;
    }

    let observation;
    try {
      const tool = clean(action.tool, 80).toLowerCase();
      if (tool === 'list') {
        const files = await trackedFiles(root);
        const prefix = clean(action.prefix, 500);
        const selected = prefix ? files.filter(file => file.startsWith(prefix)) : files;
        observation = { ok: true, tool, files: selected.slice(0, 800), truncated: selected.length > 800 };
      } else if (tool === 'read') {
        observation = { ok: true, ...(engine ? await engine.read(action.path, action) : await readBeforeLease(root, action)) };
      } else if (tool === 'search') {
        observation = { ok: true, ...(engine ? { tool, query: action.query, matches: await engine.search(action.query, { prefix: action.prefix }) } : await searchBeforeLease(root, action)) };
      } else if (tool === 'lease') {
        if (engine) throw new Error('Maker already acquired a lease.');
        const lease = {
          base_sha: task.base_sha,
          branch: task.branch,
          writer_count: 1,
          owned_paths: action.owned_paths,
          authority: { merge: 'human', deploy: 'human' }
        };
        engine = await MakerEngine.create({ root, state_path, task, lease, active_leases, command_policy });
        observation = { ok: true, tool, lease: engine.snapshot().lease, summary: clean(action.summary, 2000) };
      } else {
        if (!engine) throw new Error('Acquire a path lease before mutation or command execution.');
        if (tool === 'write') observation = { ok: true, tool, ...(await engine.write(action.path, action.content)) };
        else if (tool === 'replace') observation = { ok: true, tool, ...(await engine.replace(action.path, action.before, action.after, { expected: action.expected })) };
        else if (tool === 'delete') observation = { ok: true, tool, ...(await engine.delete(action.path)) };
        else if (tool === 'run') observation = { ok: true, tool, result: await engine.run({ program: action.program, args: action.args }) };
        else if (tool === 'repair_start') observation = { ok: true, tool, ...(await engine.beginRepair(action.failure_id, action.hypothesis)) };
        else if (tool === 'repair_complete') observation = { ok: true, tool, repair: await engine.markRepaired(action.failure_id, action.evidence) };
        else if (tool === 'checkpoint') observation = { ok: true, tool, checkpoint: await engine.checkpoint(action.label) };
        else if (tool === 'verify') observation = { ok: true, tool, verification: await engine.verify(action.commands || []) };
        else if (tool === 'status') {
          const [{ stdout: status }, { stdout: diff }] = await Promise.all([
            execFileAsync('git', ['status', '--short', '--untracked-files=all'], { cwd: root, maxBuffer: 1024 * 1024 }),
            execFileAsync('git', ['diff', '--stat'], { cwd: root, maxBuffer: 1024 * 1024 })
          ]);
          const state = engine.snapshot();
          observation = { ok: true, tool, state: state.status, attempt: state.attempt, changed_paths: state.changed_paths, failures: state.failures, git_status: clean(status, MAX_OBSERVATION), diff_stat: clean(diff, MAX_OBSERVATION) };
        } else if (tool === 'rollback') observation = { ok: true, tool, ...(await engine.rollback(action.reason)) };
        else if (tool === 'cancel') observation = { ok: true, tool, ...(await engine.cancel(action.reason)) };
        else if (tool === 'finish') {
          const receipt = await engine.receipt();
          observation = { ok: true, tool, finished: true, receipt_digest: receipt.receipt_digest };
        } else throw new Error(`Unknown Maker tool: ${tool || 'missing'}.`);
      }
    } catch (error) {
      observation = { ok: false, tool: clean(action?.tool, 80), error: clean(error.message, 4000) };
    }

    transcript.push({ turn, action, observation });
    if (on_turn) await on_turn({ turn, action, observation });
    if (observation.finished) return resultSummary(engine, transcript, action.summary, action.risks);
    if (engine && ['cancelled', 'rolled_back'].includes(engine.snapshot().status)) {
      return { status: engine.snapshot().status, summary: clean(action.reason, 4000), writes: 0, total_write_bytes: 0, transcript, lease: engine.snapshot().lease };
    }
    conversation.push({ role: 'assistant', content: JSON.stringify(action) }, { role: 'user', content: JSON.stringify(observation).slice(0, MAX_OBSERVATION) });
  }

  const state = engine?.snapshot();
  return {
    status: 'budget_exhausted',
    writes: state?.events?.filter(value => value.type === 'file_written' || value.type === 'file_deleted').length || 0,
    total_write_bytes: state?.events?.filter(value => value.type === 'file_written').reduce((sum, value) => sum + Number(value.payload?.bytes || 0), 0) || 0,
    transcript,
    lease: state?.lease || null,
    failures: state?.failures || []
  };
}
