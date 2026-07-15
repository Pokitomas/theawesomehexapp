#!/usr/bin/env node
import { execFile } from 'node:child_process';
import process from 'node:process';
import { promisify } from 'node:util';
import { createOpenModelClient } from './open-model-adapter.mjs';
import { runNativeDevAgent } from './native-dev-agent.mjs';

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
  const fallbackRequest = body.match(/## Founder command\s+([\s\S]*?)(?=\n## |$)/i)?.[1]?.trim();
  const intent = {
    version: 'sideways-maker/v1',
    repository: clean(receipt?.repository || repository, 500),
    mode,
    request: clean(receipt?.request || fallbackRequest || title.replace(/^\[maker:[^\]]+\]\s*/i, ''), 4000),
    protect: clean(receipt?.protect, 2400),
    proof: clean(receipt?.proof, 2400),
    device_requirement: clean(receipt?.device_requirement || 'phone-first', 100),
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
    max_turns: Number(env.SIDEWAYS_AGENT_MAX_TURNS || 24),
    max_writes: Number(env.SIDEWAYS_AGENT_MAX_WRITES || 12),
    max_total_write_bytes: Number(env.SIDEWAYS_AGENT_MAX_WRITE_BYTES || 600000),
    max_model_tokens: Number(env.SIDEWAYS_AGENT_MAX_MODEL_TOKENS || 4096)
  };
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
  async function request(path, options = {}) {
    const response = await fetchImpl(`${base}${path}`, {
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
  const lines = [`<!-- sideways-native-worker:v1 -->`, `## ${title}`, ''];
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
  const env = {
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || '',
    CI: '1',
    NODE_ENV: 'test',
    NO_COLOR: '1'
  };
  for (const [program, args] of commands) {
    try {
      const value = await execFileAsync(program, args, {
        cwd: process.cwd(),
        env,
        timeout: 30 * 60 * 1000,
        maxBuffer: 12 * 1024 * 1024,
        windowsHide: true
      });
      results.push({ command: [program, ...args].join(' '), ok: true, output: clean(`${value.stdout || ''}\n${value.stderr || ''}`, 4000) });
    } catch (error) {
      results.push({ command: [program, ...args].join(' '), ok: false, output: clean(`${error.stdout || ''}\n${error.stderr || error.message}`, 8000) });
      return { ok: false, results };
    }
  }
  return { ok: true, results };
}

function branchFor(issueNumber, runId) {
  return `maker/issue-${Number(issueNumber)}-${clean(runId || Date.now(), 40).replace(/[^A-Za-z0-9._-]/g, '-')}`;
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

  const branch = branchFor(issueNumber, process.env.GITHUB_RUN_ID);
  await github.comment(issueNumber, receiptComment('Native worker started', {
    branch,
    provider: `${config.protocol}:${config.model}`,
    endpoint_host: new URL(config.base_url).host,
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
  const agent = await runNativeDevAgent({
    root: process.cwd(),
    intent,
    model_client: model,
    budget: config,
    on_turn: async ({ turn, action, observation }) => {
      process.stdout.write(`${JSON.stringify({ turn, tool: action?.tool || null, ok: observation.ok, finished: observation.finished || false })}\n`);
    }
  });

  if (agent.status !== 'finished') {
    await github.comment(issueNumber, receiptComment('Native worker stopped', {
      state: agent.status,
      branch,
      writes: agent.writes,
      action: 'No PR was created.',
      run: runURL()
    }));
    process.exitCode = 2;
    return;
  }

  const { stdout: dirty } = await git(['status', '--porcelain=v1']);
  if (!clean(dirty)) {
    await github.comment(issueNumber, receiptComment('Native worker finished without a patch', {
      summary: agent.summary || 'Model produced no repository changes.',
      branch,
      run: runURL()
    }));
    return;
  }

  const verification = await verifyCandidate();
  if (!verification.ok) {
    const failed = verification.results.find(value => !value.ok);
    await github.comment(issueNumber, receiptComment('Native worker patch blocked', {
      branch,
      failed_witness: failed?.command,
      evidence: `\n\n\`\`\`text\n${clean(failed?.output, 6000)}\n\`\`\``,
      action: 'No commit, push, or PR was created.',
      run: runURL()
    }));
    process.exitCode = 3;
    return;
  }

  await git(['add', '--all']);
  await git(['commit', '-m', `[maker:${intent.mode}] issue #${issueNumber} native worker patch`]);
  await git(['push', '--set-upstream', 'origin', branch]);

  let pull = await github.findOpenPull(owner, branch);
  if (!pull) {
    pull = await github.createPull({
      title: `[maker:${intent.mode}] ${clean(intent.request.split(/\r?\n/)[0], 96)}`,
      head: branch,
      base: issue.repository?.default_branch || 'main',
      draft: true,
      body: [
        `Generated from #${issueNumber} by the provider-neutral native Maker worker.`,
        '',
        `## Model receipt`,
        `- protocol: ${config.protocol}`,
        `- model: ${config.model}`,
        `- endpoint host: ${new URL(config.base_url).host}`,
        `- turns: ${agent.transcript.length}`,
        `- writes: ${agent.writes}`,
        '',
        '## Worker summary',
        agent.summary || '_No summary returned._',
        '',
        '## Worker-reported tests',
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

  await github.comment(issueNumber, receiptComment('Native worker produced a draft PR', {
    branch,
    pull_request: pull.html_url,
    commit_witnesses: verification.results.map(value => value.command).join(' · '),
    run: runURL(),
    authority: 'unmerged and undeployed'
  }));

  await sleep(100);
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(async error => {
    console.error(`maker-native-worker: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}
