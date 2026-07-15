#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { runAutonomousMakerAgent } from '../maker/runtime/autonomous-agent.mjs';
import { createOpenModelClient } from './open-model-adapter.mjs';
import { runOpenModelPlanning } from './open-model-planning.mjs';

const execFileAsync = promisify(execFile);
const clean = (value, limit = 20000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function parseMakerIssue(issue = {}, repository = '') {
  const title = clean(issue.title, 500);
  if (!/^\[maker:(build|fix|explore|audit)\]\s+/i.test(title)) throw new Error('Issue is not a Maker command.');
  const body = String(issue.body || '');
  const blocks = [...body.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  let receipt = null;
  for (const match of blocks.reverse()) {
    try {
      const value = JSON.parse(match[1]);
      if (value?.version === 'sideways-maker/v1') { receipt = value; break; }
    } catch {}
  }
  const mode = title.match(/^\[maker:([^\]]+)\]/i)?.[1]?.toLowerCase() || receipt?.mode || 'build';
  const fallbackRequest = body.match(/## (?:Founder|Engineering) command\s+([\s\S]*?)(?=\n## |$)/i)?.[1]?.trim();
  const intent = {
    version: 'sideways-maker/v1',
    repository: clean(receipt?.repository || repository, 500),
    base_revision: clean(receipt?.base_revision || 'main', 200),
    backend: clean(receipt?.backend || 'auto', 80),
    mode,
    request: clean(receipt?.request || fallbackRequest || title.replace(/^\[maker:[^\]]+\]\s*/i, ''), 8000),
    protect: clean(receipt?.protect, 4000),
    proof: clean(receipt?.proof, 4000),
    device_requirement: clean(receipt?.device_requirement || 'phone-first-and-desktop', 100),
    authority: {
      human_merge_required: true,
      human_deploy_required: true,
      browser_credentials: 'none'
    }
  };
  if (!intent.request) throw new Error('Maker command has no request.');
  if (repository && intent.repository && intent.repository !== repository) throw new Error('Maker receipt targets another repository.');
  intent.repository = repository || intent.repository;
  return intent;
}

export function normalizeWorkerConfig(env = process.env) {
  const protocol = clean(env.SIDEWAYS_MODEL_PROTOCOL || 'openai', 40).toLowerCase();
  const base_url = clean(env.SIDEWAYS_MODEL_BASE_URL, 4000);
  const model = clean(env.SIDEWAYS_MODEL_NAME, 500);
  const missing = [];
  if (!base_url) missing.push('SIDEWAYS_MODEL_BASE_URL');
  if (!model) missing.push('SIDEWAYS_MODEL_NAME');
  return {
    protocol,
    base_url,
    model,
    api_key: clean(env.SIDEWAYS_MODEL_API_KEY, 10000),
    missing,
    default_branch: clean(env.SIDEWAYS_DEFAULT_BRANCH || 'main', 200),
    planning_enabled: clean(env.SIDEWAYS_PLANNING_ENABLED || '1', 20) !== '0',
    planning_max_waves: Number(env.SIDEWAYS_PLANNING_MAX_WAVES || 2),
    planning_max_events: Number(env.SIDEWAYS_PLANNING_MAX_EVENTS || 160),
    planning_max_assignments: Number(env.SIDEWAYS_PLANNING_MAX_ASSIGNMENTS || 6),
    max_turns: Number(env.SIDEWAYS_AGENT_MAX_TURNS || 32),
    max_writes: Number(env.SIDEWAYS_AGENT_MAX_WRITES || 24),
    max_total_write_bytes: Number(env.SIDEWAYS_AGENT_MAX_WRITE_BYTES || 1200000),
    max_model_tokens: Number(env.SIDEWAYS_AGENT_MAX_MODEL_TOKENS || 4096)
  };
}

export function parseMakerLeaseMarker(body = '') {
  const matches = [...String(body).matchAll(/<!--\s*sideways-(?:maker|path)-lease\/v1\s*([\s\S]*?)-->/gi)];
  for (const match of matches.reverse()) {
    try {
      const value = JSON.parse(match[1].trim());
      if (!Array.isArray(value.owned_paths) || !value.owned_paths.length) continue;
      return {
        version: 'sideways-maker-lease/v1',
        base_sha: clean(value.base_sha, 40),
        branch: clean(value.branch || value.owner || 'unknown-active-lease', 240),
        writer_count: Number(value.writer_count ?? 1),
        owned_paths: value.owned_paths,
        authority: {
          merge: clean(value.authority?.merge || 'human', 40),
          deploy: clean(value.authority?.deploy || 'human', 40)
        }
      };
    } catch {}
  }
  return null;
}

export function nativeCommandPolicy() {
  return Object.freeze([
    { program: 'git', args: ['diff', '--check'] },
    { program: 'git', args: ['status', '--short', '--untracked-files=all'] },
    { program: 'node', args: ['--test'], prefix: true },
    { program: 'node', args: ['scripts/native-changed-check.mjs'] },
    { program: 'npm', args: ['run'], prefix: true }
  ]);
}

function apiClient({ token, repository, fetchImpl = fetch }) {
  const base = `https://api.github.com/repos/${repository}`;
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'sideways-native-maker-worker'
  };
  async function request(apiPath, options = {}) {
    const response = await fetchImpl(`${base}${apiPath}`, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`GitHub API ${response.status}: ${clean(data.message || response.statusText, 1000)}`);
    return data;
  }
  return {
    getIssue: number => request(`/issues/${Number(number)}`),
    comment: (number, body) => request(`/issues/${Number(number)}/comments`, { method: 'POST', body: { body } }),
    listOpenPulls: () => request('/pulls?state=open&per_page=100'),
    async findOpenPull(headOwner, branch) {
      const values = await request(`/pulls?state=open&head=${encodeURIComponent(`${headOwner}:${branch}`)}&per_page=10`);
      return values[0] || null;
    },
    createPull: body => request('/pulls', { method: 'POST', body })
  };
}

function runURL(env = process.env) {
  const server = clean(env.GITHUB_SERVER_URL || 'https://github.com', 500);
  const repository = clean(env.GITHUB_REPOSITORY, 500);
  const runId = clean(env.GITHUB_RUN_ID, 100);
  return runId ? `${server}/${repository}/actions/runs/${runId}` : null;
}

function receiptComment(title, fields = {}) {
  const lines = ['<!-- sideways-native-worker:v1 -->', `## ${title}`, ''];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    lines.push(`**${key}:** ${String(value)}`);
  }
  return lines.join('\n');
}

async function git(args, options = {}) {
  return execFileAsync('git', args, { cwd: process.cwd(), maxBuffer: 8 * 1024 * 1024, ...options });
}

async function verifyCandidate() {
  const commands = [
    ['git', ['diff', '--check']],
    [process.execPath, ['scripts/native-changed-check.mjs']],
    ['npm', ['run', 'verify:repository']]
  ];
  const results = [];
  const env = { PATH: process.env.PATH || '', HOME: process.env.HOME || '', CI: '1', NODE_ENV: 'test', NO_COLOR: '1' };
  for (const [program, args] of commands) {
    try {
      const value = await execFileAsync(program, args, { cwd: process.cwd(), env, timeout: 30 * 60 * 1000, maxBuffer: 12 * 1024 * 1024, windowsHide: true });
      results.push({ command: [program, ...args].join(' '), ok: true, output: clean(`${value.stdout || ''}\n${value.stderr || ''}`, 4000) });
    } catch (error) {
      results.push({ command: [program, ...args].join(' '), ok: false, output: clean(`${error.stdout || ''}\n${error.stderr || error.message}`, 8000) });
      return { ok: false, results };
    }
  }
  return { ok: true, results };
}

export function branchFor(issueNumber, runId, runAttempt = '1') {
  const identity = `${clean(runId || Date.now(), 40)}-${clean(runAttempt || '1', 10)}`.replace(/[^A-Za-z0-9._-]/g, '-');
  return `maker/issue-${Number(issueNumber)}-${identity}`;
}

export function nativeEpisodePath(env = process.env) {
  return path.join(clean(env.RUNNER_TEMP, 4000) || os.tmpdir(), 'sideways-native-episode.json');
}

async function writeEpisode(episode, env = process.env) {
  const target = nativeEpisodePath(env);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(episode, null, 2)}\n`, 'utf8');
  return target;
}

async function main() {
  const required = ['GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_REPOSITORY_OWNER', 'SIDEWAYS_ISSUE_NUMBER'];
  const missingRuntime = required.filter(name => !clean(process.env[name]));
  if (missingRuntime.length) throw new Error(`Missing worker environment: ${missingRuntime.join(', ')}.`);

  const repository = clean(process.env.GITHUB_REPOSITORY, 500);
  const owner = clean(process.env.GITHUB_REPOSITORY_OWNER, 300);
  const issueNumber = Number(process.env.SIDEWAYS_ISSUE_NUMBER);
  const github = apiClient({ token: process.env.GITHUB_TOKEN, repository });
  const issue = await github.getIssue(issueNumber);
  if (clean(issue.user?.login, 300).toLowerCase() !== owner.toLowerCase()) throw new Error('Only a repository-owner Maker issue may execute.');
  const intent = parseMakerIssue(issue, repository);
  const config = normalizeWorkerConfig();
  if (config.missing.length) {
    await github.comment(issueNumber, receiptComment('Native worker blocked', {
      state: 'missing model runtime',
      missing: config.missing.join(', '),
      action: 'Configure repository variables or a self-hosted local model runner. No engineering model was invoked.',
      run: runURL()
    }));
    return;
  }

  const branch = branchFor(issueNumber, process.env.GITHUB_RUN_ID, process.env.GITHUB_RUN_ATTEMPT);
  const { stdout: baseShaOutput } = await git(['rev-parse', 'HEAD']);
  const baseSha = clean(baseShaOutput, 40);
  const openPulls = await github.listOpenPulls();
  const activeLeases = openPulls
    .filter(pull => clean(pull.head?.ref, 240) !== branch)
    .map(pull => parseMakerLeaseMarker(pull.body))
    .filter(Boolean);
  const endpointHost = new URL(config.base_url).host;
  const statePath = path.join(clean(process.env.RUNNER_TEMP, 4000) || os.tmpdir(), 'sideways-maker-state.json');
  const episode = {
    schema: 'sideways-native-maker-episode/v2',
    repository,
    issue_number: issueNumber,
    run_url: runURL(),
    branch,
    base_sha: baseSha,
    active_leases: activeLeases,
    provider: { protocol: config.protocol, model: config.model, endpoint_host: endpointHost },
    intent,
    started_at: new Date().toISOString(),
    planning: null,
    implementation: null,
    engine_state: null,
    verification: null,
    outcome: 'started'
  };
  await writeEpisode(episode);

  await github.comment(issueNumber, receiptComment('Native worker started', {
    branch,
    base_sha: baseSha,
    active_leases: activeLeases.length,
    provider: `${config.protocol}:${config.model}`,
    endpoint_host: endpointHost,
    planning: config.planning_enabled ? 'recursive role planning enabled' : 'disabled by configuration',
    execution: 'lease-first durable Maker engine',
    run: runURL(),
    authority: 'branch and draft PR only; no merge or deploy'
  }));

  await git(['config', 'user.name', 'sideways-native-worker']);
  await git(['config', 'user.email', 'sideways-native-worker@users.noreply.github.com']);
  await git(['checkout', '-b', branch]);

  const model = createOpenModelClient({
    base_url: config.base_url,
    model: config.model,
    protocol: config.protocol,
    api_key: config.api_key,
    timeout_ms: Number(process.env.SIDEWAYS_MODEL_TIMEOUT_MS || 180000),
    retries: Number(process.env.SIDEWAYS_MODEL_RETRIES || 1)
  });

  let planningBrief = null;
  if (config.planning_enabled) {
    try {
      const planning = await runOpenModelPlanning({
        intent,
        model_client: model,
        max_waves: config.planning_max_waves,
        max_events: config.planning_max_events,
        max_assignments_per_wave: config.planning_max_assignments
      });
      planningBrief = planning.brief;
      episode.planning = { status: 'completed', ...planningBrief };
    } catch (error) {
      planningBrief = { terminal: 'failed', event_count: 0, outputs: [], error: clean(error.message, 2000) };
      episode.planning = { status: 'failed', ...planningBrief };
    }
    await writeEpisode(episode);
  }

  const taskRequest = [intent.request, planningBrief ? `Planning brief: ${JSON.stringify(planningBrief)}` : ''].filter(Boolean).join('\n\n').slice(0, 8000);
  const agent = await runAutonomousMakerAgent({
    root: process.cwd(),
    task: { repository, base_sha: baseSha, branch, request: taskRequest, protect: intent.protect, proof: intent.proof },
    model_client: model,
    state_path: statePath,
    active_leases: activeLeases,
    command_policy: nativeCommandPolicy(),
    budget: config,
    on_turn: async ({ turn, action, observation }) => {
      try { episode.engine_state = JSON.parse(await fs.readFile(statePath, 'utf8')); } catch {}
      await writeEpisode(episode);
      process.stdout.write(`${JSON.stringify({ turn, tool: action?.tool || null, ok: observation.ok, finished: observation.finished || false })}\n`);
    }
  });
  episode.implementation = agent;
  episode.outcome = agent.status;
  try { episode.engine_state = JSON.parse(await fs.readFile(statePath, 'utf8')); } catch {}
  await writeEpisode(episode);

  if (agent.status !== 'finished') {
    await github.comment(issueNumber, receiptComment('Native worker stopped', {
      state: agent.status,
      branch,
      planning_terminal: planningBrief?.terminal,
      writes: agent.writes,
      lease: agent.lease ? agent.lease.owned_paths.join(', ') : 'none acquired',
      action: 'No PR was created.',
      run: runURL()
    }));
    process.exitCode = 2;
    return;
  }

  const { stdout: dirty } = await git(['status', '--porcelain=v1']);
  if (!clean(dirty)) {
    episode.outcome = 'finished_without_patch';
    await writeEpisode(episode);
    await github.comment(issueNumber, receiptComment('Native worker finished without a patch', {
      summary: agent.summary || 'Model produced no repository changes.',
      branch,
      planning_terminal: planningBrief?.terminal,
      run: runURL()
    }));
    return;
  }

  const verification = await verifyCandidate();
  episode.verification = verification;
  await writeEpisode(episode);
  if (!verification.ok) {
    const failed = verification.results.find(value => !value.ok);
    episode.outcome = 'verification_blocked';
    await writeEpisode(episode);
    await github.comment(issueNumber, receiptComment('Native worker patch blocked', {
      branch,
      planning_terminal: planningBrief?.terminal,
      failed_witness: failed?.command,
      evidence: `\n\n\`\`\`text\n${clean(failed?.output, 6000)}\n\`\`\``,
      action: 'No commit, push, or PR was created.',
      run: runURL()
    }));
    process.exitCode = 3;
    return;
  }

  await git(['add', '--all']);
  await git(['commit', '-m', `[maker:${intent.mode}] issue #${issueNumber} autonomous worker patch`]);
  await git(['push', '--set-upstream', 'origin', branch]);

  let pull = await github.findOpenPull(owner, branch);
  if (!pull) {
    const leaseMarker = `<!-- sideways-maker-lease/v1\n${JSON.stringify(agent.lease)}\n-->`;
    pull = await github.createPull({
      title: `[maker:${intent.mode}] ${clean(intent.request.split(/\r?\n/)[0], 96)}`,
      head: branch,
      base: config.default_branch,
      draft: true,
      body: [
        `Generated from #${issueNumber} by the provider-neutral autonomous Maker worker.`,
        '',
        leaseMarker,
        '',
        '## Model receipt',
        `- protocol: ${config.protocol}`,
        `- model: ${config.model}`,
        `- endpoint host: ${endpointHost}`,
        `- planning terminal: ${planningBrief?.terminal || 'disabled'}`,
        `- planning events: ${planningBrief?.event_count || 0}`,
        `- implementation turns: ${agent.transcript.length}`,
        `- writes: ${agent.writes}`,
        `- engine receipt: ${agent.receipt?.receipt_digest || 'missing'}`,
        '',
        '## Worker summary',
        agent.summary || '_No summary returned._',
        '',
        '## Runtime-observed tests',
        ...(agent.tests?.length ? agent.tests.map(value => `- ${value}`) : ['- none']),
        '',
        '## Independent admission witnesses',
        ...verification.results.map(value => `- ${value.ok ? 'PASS' : 'FAIL'}: \`${value.command}\``),
        '',
        '## Authority',
        'Draft only. Human review, merge, and deployment remain required.'
      ].join('\n')
    });
  }

  episode.outcome = 'draft_pr_created';
  episode.pull_request = pull.html_url;
  episode.finished_at = new Date().toISOString();
  await writeEpisode(episode);

  await github.comment(issueNumber, receiptComment('Native worker produced a draft PR', {
    branch,
    pull_request: pull.html_url,
    lease: agent.lease?.owned_paths?.join(', '),
    engine_receipt: agent.receipt?.receipt_digest,
    planning_terminal: planningBrief?.terminal,
    commit_witnesses: verification.results.map(value => value.command).join(' · '),
    episode_artifact: 'sideways-native-maker-episode',
    run: runURL(),
    authority: 'unmerged and undeployed'
  }));

  await sleep(100);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`maker-native-worker: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}
