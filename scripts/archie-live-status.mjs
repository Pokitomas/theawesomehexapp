#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const STATUS_MARKER = '<!-- archie-live-status:v1 -->';
export const DEFAULTS = Object.freeze({
  repository: 'Pokitomas/theawesomehexapp',
  issue: 351,
  branch: 'agent/archie-democratized-runtime',
  expectedHead: 'c9a710fdef372b4bf7fab53a514410f09d31495a',
  totalTokens: 1_310_720,
  watchSeconds: 20
});

const clean = value => String(value ?? '').replace(/\u0000/g, '').trim();
const compact = value => clean(value).replace(/\s+/g, ' ');
const shortSha = value => /^[0-9a-f]{7,40}$/i.test(clean(value)) ? clean(value).slice(0, 7) : 'unknown';
const number = value => Number.isFinite(Number(value)) ? Number(value) : null;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function tokenStatePath(env = process.env) {
  if (clean(env.ARCHIE_TOKEN_STATE)) return path.resolve(env.ARCHIE_TOKEN_STATE);
  const root = clean(env.XDG_STATE_HOME) || path.join(os.homedir(), '.local', 'state');
  return path.join(root, 'archie', 'live-status.json');
}

export function normalizeTokenState(input = {}, defaults = DEFAULTS) {
  const total = Math.max(0, Math.trunc(number(input.total) ?? defaults.totalTokens));
  const remaining = clamp(Math.trunc(number(input.remaining) ?? total), 0, total);
  return {
    schema: 'archie-token-state/v1',
    total,
    remaining,
    used: total - remaining,
    source: compact(input.source || 'manual-observed'),
    updated_at: clean(input.updated_at) || new Date().toISOString()
  };
}

export async function readTokenState(file, defaults = DEFAULTS) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return normalizeTokenState(parsed, defaults);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return normalizeTokenState({}, defaults);
  }
}

export async function writeTokenState(file, input, defaults = DEFAULTS) {
  const state = normalizeTokenState(input, defaults);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return state;
}

export function parseTokenUpdate(args, current, defaults = DEFAULTS) {
  if (!args.length) return current;
  const remaining = number(String(args[0]).replaceAll(',', ''));
  const total = args[1] === undefined
    ? current.total || defaults.totalTokens
    : number(String(args[1]).replaceAll(',', ''));
  if (remaining === null || total === null || remaining < 0 || total <= 0 || remaining > total) {
    throw new Error('Usage: tokens <remaining> [total], with 0 <= remaining <= total.');
  }
  return normalizeTokenState({ remaining, total, source: 'manual-observed' }, defaults);
}

export function resolveToken(env = process.env) {
  if (clean(env.GITHUB_TOKEN)) return clean(env.GITHUB_TOKEN);
  if (clean(env.GH_TOKEN)) return clean(env.GH_TOKEN);
  try {
    return clean(execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return '';
  }
}

export function githubClient({ token = '', repository, fetchImpl = globalThis.fetch }) {
  if (!repository.includes('/')) throw new Error('Repository must be owner/name.');
  const base = `https://api.github.com/repos/${repository}`;
  const headers = {
    accept: 'application/vnd.github+json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    'x-github-api-version': '2022-11-28',
    'user-agent': 'archie-live-status'
  };

  async function request(route, options = {}) {
    const response = await fetchImpl(route.startsWith('http') ? route : `${base}${route}`, {
      method: options.method || 'GET',
      headers: { ...headers, ...(options.body ? { 'content-type': 'application/json' } : {}) },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    if (!response.ok) {
      const body = compact(await response.text()).slice(0, 300);
      throw new Error(`GitHub ${response.status} ${options.method || 'GET'} ${route}: ${body}`);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  return { request };
}

function field(body, name) {
  const match = clean(body).match(new RegExp(`^[-*]?\\s*${name}\\s*:\\s*(.+)$`, 'im'));
  return match ? compact(match[1]) : null;
}

export function parseHeartbeat(comment = {}) {
  const body = clean(comment.body);
  if (!body.includes(STATUS_MARKER) && !/active[- ]writer|active writer|heartbeat/i.test(body)) return null;
  return {
    id: comment.id ?? null,
    author: clean(comment.user?.login || 'unknown'),
    created_at: clean(comment.created_at || ''),
    updated_at: clean(comment.updated_at || comment.created_at || ''),
    marker: body.includes(STATUS_MARKER),
    writer: field(body, 'writer') || field(body, 'active writer') || null,
    observer: field(body, 'observer') || null,
    mode: field(body, 'mode') || null,
    head: field(body, 'head') || null,
    next: field(body, 'next') || null,
    source: clean(comment.html_url || '') || null
  };
}

export function selectHeartbeat(comments = []) {
  return comments
    .map(parseHeartbeat)
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0))[0] || null;
}

export function relativeTime(iso, now = Date.now()) {
  const then = Date.parse(iso || '');
  if (!Number.isFinite(then)) return 'unknown';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function tokenBar(state, width = 12) {
  const ratio = state.total ? state.remaining / state.total : 0;
  const filled = clamp(Math.round(ratio * width), 0, width);
  return `[${'='.repeat(filled)}${'.'.repeat(width - filled)}]`;
}

export function renderDashboard(snapshot, { now = Date.now(), width = 44 } = {}) {
  const token = snapshot.tokens;
  const exact = snapshot.head === snapshot.expectedHead;
  const lines = [
    `ARCHIE #${snapshot.issue}  ${String(snapshot.issueState || 'unknown').toUpperCase()}`,
    `HEAD   ${shortSha(snapshot.head)}  ${exact ? 'exact' : 'DRIFT'}`,
    `WRITER ${snapshot.heartbeat?.writer || snapshot.heartbeat?.observer || 'unreported'}`,
    `MODE   ${snapshot.heartbeat?.mode || 'unreported'}`,
    `TOKENS ${token.remaining.toLocaleString('en-US')} / ${token.total.toLocaleString('en-US')}`,
    `       ${tokenBar(token)} ${token.total ? Math.floor((token.remaining / token.total) * 100) : 0}%`,
    `BEAT   ${relativeTime(snapshot.heartbeat?.updated_at, now)}`,
    `PR     ${snapshot.pullRequest ? `#${snapshot.pullRequest.number} ${snapshot.pullRequest.state}` : 'none'}`,
    `NEXT   ${snapshot.heartbeat?.next || 'read issue #351'}`
  ];
  if (snapshot.error) lines.push(`ERROR  ${compact(snapshot.error).slice(0, Math.max(12, width - 7))}`);
  return lines.map(line => line.slice(0, width)).join('\n');
}

export async function fetchSnapshot({ client, repository, issue, branch, expectedHead, tokens }) {
  const owner = repository.split('/')[0];
  const refRoute = `/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`;
  const [issueData, comments, ref, pulls] = await Promise.all([
    client.request(`/issues/${issue}`),
    client.request(`/issues/${issue}/comments?per_page=100`),
    client.request(refRoute),
    client.request(`/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=10`)
  ]);
  return {
    repository,
    issue,
    issueState: issueData.state,
    branch,
    expectedHead,
    head: clean(ref.object?.sha),
    heartbeat: selectHeartbeat(comments),
    pullRequest: pulls[0] ? { number: pulls[0].number, state: pulls[0].draft ? 'draft' : pulls[0].state } : null,
    tokens,
    fetched_at: new Date().toISOString()
  };
}

export function renderHeartbeat(snapshot, note = '') {
  const token = snapshot.tokens;
  return [
    STATUS_MARKER,
    '## Archie live status',
    '',
    '- observer: GPT-5.6 Thinking',
    '- writer: one coordinator writer remains authoritative',
    '- mode: sidecar observer; no coordinator edits',
    `- branch: \`${snapshot.branch}\``,
    `- head: \`${snapshot.head || 'unobserved'}\``,
    `- expected head: \`${snapshot.expectedHead}\``,
    `- drift: ${snapshot.head === snapshot.expectedHead ? 'none' : 'detected'}`,
    `- tokens remaining: ${token.remaining.toLocaleString('en-US')} / ${token.total.toLocaleString('en-US')} (${token.source})`,
    `- updated: ${new Date().toISOString()}`,
    `- next: ${compact(note) || snapshot.heartbeat?.next || 'observe current writer and avoid overlapping coordinator writes'}`,
    '',
    'No merge or deployment.'
  ].join('\n');
}

export async function publishHeartbeat({ client, issue, comments, body }) {
  const existing = comments.find(comment => clean(comment.body).includes(STATUS_MARKER));
  if (existing) {
    await client.request(`/issues/comments/${existing.id}`, { method: 'PATCH', body: { body } });
    return { action: 'updated', id: existing.id };
  }
  const created = await client.request(`/issues/${issue}/comments`, { method: 'POST', body: { body } });
  return { action: 'created', id: created.id };
}

function optionsFromEnv(env = process.env) {
  return {
    repository: clean(env.ARCHIE_REPOSITORY) || DEFAULTS.repository,
    issue: Math.trunc(number(env.ARCHIE_ISSUE) ?? DEFAULTS.issue),
    branch: clean(env.ARCHIE_BRANCH) || DEFAULTS.branch,
    expectedHead: clean(env.ARCHIE_EXPECTED_HEAD) || DEFAULTS.expectedHead
  };
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const command = clean(argv[0] || 'status').toLowerCase();
  const stateFile = tokenStatePath(env);
  let tokens = await readTokenState(stateFile);

  if (command === 'tokens') {
    tokens = parseTokenUpdate(argv.slice(1), tokens);
    tokens = await writeTokenState(stateFile, tokens);
    console.log(`TOKENS ${tokens.remaining.toLocaleString('en-US')} / ${tokens.total.toLocaleString('en-US')} (${stateFile})`);
    return;
  }

  const config = optionsFromEnv(env);
  const token = resolveToken(env);
  const client = githubClient({ token, repository: config.repository });

  async function getSnapshot() {
    try {
      return await fetchSnapshot({ client, ...config, tokens });
    } catch (error) {
      return { ...config, issueState: 'unknown', head: '', heartbeat: null, pullRequest: null, tokens, error: error.message };
    }
  }

  if (command === 'heartbeat') {
    if (!token) throw new Error('Heartbeat publishing requires GITHUB_TOKEN/GH_TOKEN or gh auth login.');
    const snapshot = await getSnapshot();
    if (snapshot.error) throw new Error(snapshot.error);
    const comments = await client.request(`/issues/${config.issue}/comments?per_page=100`);
    const result = await publishHeartbeat({
      client,
      issue: config.issue,
      comments,
      body: renderHeartbeat(snapshot, argv.slice(1).join(' '))
    });
    console.log(`Heartbeat ${result.action} on issue #${config.issue}.`);
    return;
  }

  const json = argv.includes('--json');
  if (command === 'watch') {
    const requested = number(argv[1]);
    const seconds = clamp(Math.trunc(requested ?? DEFAULTS.watchSeconds), 5, 3600);
    while (true) {
      const snapshot = await getSnapshot();
      process.stdout.write('\u001b[2J\u001b[H');
      process.stdout.write(`${json ? JSON.stringify(snapshot, null, 2) : renderDashboard(snapshot)}\n`);
      await new Promise(resolve => setTimeout(resolve, seconds * 1000));
    }
  }

  const snapshot = await getSnapshot();
  console.log(json ? JSON.stringify(snapshot, null, 2) : renderDashboard(snapshot));
  if (snapshot.error) process.exitCode = 2;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch(error => {
    console.error(`archie-live-status: ${compact(error.message)}`);
    process.exitCode = 1;
  });
}
