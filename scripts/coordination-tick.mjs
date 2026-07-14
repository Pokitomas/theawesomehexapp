#!/usr/bin/env node
import fs from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  STATE_MARKER,
  closingIssueNumbers,
  emptyTickState,
  parseDeclarationLines,
  parseStateComment,
  reduceCoordinationTick,
  renderStateComment
} from './coordination-tick-core.mjs';

const clean = value => String(value ?? '').replace(/\u0000/g, '').trim();
const unique = values => [...new Set(values.filter(Boolean))];

export function inventoryFromGitHub(pulls = [], issues = []) {
  const lanes = [];
  for (const pull of pulls) {
    lanes.push({
      key: `pr:${pull.number}`,
      kind: 'pr',
      number: pull.number,
      title: pull.title,
      url: pull.html_url,
      branch: pull.head?.ref || null,
      issue_refs: closingIssueNumbers(pull.body || '')
    });
  }
  for (const issue of issues) {
    if (issue.pull_request) continue;
    lanes.push({
      key: `issue:${issue.number}`,
      kind: 'issue',
      number: issue.number,
      title: issue.title,
      url: issue.html_url,
      branch: null,
      issue_refs: []
    });
  }
  return lanes.sort((a, b) => a.key.localeCompare(b.key));
}

function inventoryLane(inventory, key) {
  return inventory.find(lane => lane.key === key) || null;
}

function issueContextForLanes(inventory, laneKeys) {
  const issues = [];
  for (const key of laneKeys) {
    const lane = inventoryLane(inventory, key);
    if (!lane) continue;
    if (lane.kind === 'issue') issues.push(lane.number);
    if (lane.kind === 'pr') issues.push(...(lane.issue_refs || []));
  }
  return unique(issues.map(Number).filter(Number.isFinite));
}

function eventKey(name, action, payload, env) {
  if (name === 'issue_comment') return `issue_comment:${payload.comment?.id || 'unknown'}`;
  if (name === 'issues') return `issues:${payload.issue?.id || payload.issue?.number}:${action}:${payload.issue?.updated_at || ''}`;
  if (name === 'pull_request_review') return `pull_request_review:${payload.review?.id || 'unknown'}:${action}`;
  if (name === 'pull_request_review_comment') return `pull_request_review_comment:${payload.comment?.id || 'unknown'}:${action}`;
  if (name === 'pull_request' || name === 'pull_request_target') {
    const pull = payload.pull_request || {};
    const revision = action === 'synchronize' ? pull.head?.sha : (pull.updated_at || pull.head?.sha || '');
    return `${name}:${pull.id || pull.number}:${action}:${revision}`;
  }
  if (name === 'workflow_run') {
    const run = payload.workflow_run || {};
    return `workflow_run:${run.id || 'unknown'}:${run.run_attempt || 1}:${run.conclusion || run.status || action}`;
  }
  if (name === 'create' || name === 'delete' || name === 'push') {
    return `${name}:${payload.ref_type || 'branch'}:${payload.ref || env.GITHUB_REF_NAME || ''}:${payload.after || payload.ref || action}`;
  }
  return `${name || 'manual'}:${env.GITHUB_RUN_ID || 'local'}:${env.GITHUB_RUN_ATTEMPT || '1'}`;
}

export function normalizeGitHubTickEvent(payload = {}, env = process.env, inventory = []) {
  const name = clean(env.GITHUB_EVENT_NAME || payload.event_name || 'workflow_dispatch');
  const action = clean(payload.action || env.GITHUB_EVENT_ACTION || 'observed');
  const actor = clean(payload.sender?.login || env.GITHUB_ACTOR || 'unknown');
  const laneKeys = [];
  let branch = '';
  let body = '';
  let source = '';

  if (name === 'issue_comment' || name === 'issues') {
    const issue = payload.issue || {};
    const kind = issue.pull_request ? 'pr' : 'issue';
    if (issue.number) laneKeys.push(`${kind}:${issue.number}`);
    body = clean(payload.comment?.body || issue.body || '');
    source = clean(payload.comment?.html_url || issue.html_url || '');
  }

  if (name === 'pull_request' || name === 'pull_request_target') {
    const pull = payload.pull_request || {};
    if (pull.number) laneKeys.push(`pr:${pull.number}`);
    branch = clean(pull.head?.ref);
    body = clean(payload.review?.body || payload.comment?.body || pull.body || '');
    source = clean(payload.review?.html_url || payload.comment?.html_url || pull.html_url || '');
  }

  if (name === 'pull_request_review' || name === 'pull_request_review_comment') {
    const pull = payload.pull_request || {};
    if (pull.number) laneKeys.push(`pr:${pull.number}`);
    branch = clean(pull.head?.ref);
    body = clean(payload.review?.body || payload.comment?.body || '');
    source = clean(payload.review?.html_url || payload.comment?.html_url || pull.html_url || '');
  }

  if (name === 'workflow_run') {
    const run = payload.workflow_run || {};
    branch = clean(run.head_branch);
    for (const pull of run.pull_requests || []) if (pull.number) laneKeys.push(`pr:${pull.number}`);
    if (!laneKeys.length && branch) {
      for (const lane of inventory) if (lane.kind === 'pr' && lane.branch === branch) laneKeys.push(lane.key);
    }
    body = clean(`${run.name || ''} ${run.conclusion || run.status || ''}`);
    source = clean(run.html_url || '');
  }

  if (name === 'create' || name === 'delete' || name === 'push') {
    branch = clean(payload.ref || env.GITHUB_REF_NAME || '');
    for (const lane of inventory) if (lane.kind === 'pr' && lane.branch === branch) laneKeys.push(lane.key);
    source = clean(payload.repository?.html_url || '');
  }

  for (const key of [...laneKeys]) {
    const lane = inventoryLane(inventory, key);
    if (lane?.kind === 'pr') for (const issue of lane.issue_refs || []) laneKeys.push(`issue:${issue}`);
    if (!branch && lane?.branch) branch = lane.branch;
  }

  return {
    key: eventKey(name, action, payload, env),
    name,
    action,
    actor,
    source: source || null,
    observed_at: new Date().toISOString(),
    lane_keys: unique(laneKeys),
    branch: branch || null,
    body,
    issue_numbers: issueContextForLanes(inventory, unique(laneKeys))
  };
}

function generatedStateEvent(payload, env) {
  const actor = clean(payload.sender?.login || env.GITHUB_ACTOR || '').toLowerCase();
  const body = clean(payload.comment?.body || '');
  return actor === 'github-actions[bot]' && body.includes(STATE_MARKER);
}

function apiClient(env = process.env) {
  const token = clean(env.GITHUB_TOKEN);
  const repository = clean(env.GITHUB_REPOSITORY);
  if (!token) throw new Error('GITHUB_TOKEN is required.');
  if (!repository || !repository.includes('/')) throw new Error('GITHUB_REPOSITORY is required.');
  const base = `https://api.github.com/repos/${repository}`;
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'sideways-coordination-tick'
  };

  async function request(path, options = {}) {
    const response = await fetch(path.startsWith('http') ? path : `${base}${path}`, {
      method: options.method || 'GET',
      headers: { ...headers, ...(options.body ? { 'content-type': 'application/json' } : {}) },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API ${response.status} ${options.method || 'GET'} ${path}: ${text.slice(0, 1000)}`);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  async function all(path) {
    const values = [];
    for (let page = 1; page <= 10; page += 1) {
      const separator = path.includes('?') ? '&' : '?';
      const batch = await request(`${path}${separator}per_page=100&page=${page}`);
      values.push(...batch);
      if (batch.length < 100) break;
    }
    return values;
  }

  return { request, all };
}

export async function runCoordinationTick(env = process.env) {
  const payload = JSON.parse(await fs.readFile(env.GITHUB_EVENT_PATH, 'utf8'));
  if (generatedStateEvent(payload, env)) {
    console.log('Ignoring the coordinator state comment created by this workflow.');
    return { ignored: true };
  }

  const coordinationIssue = Number(env.COORDINATION_ISSUE || 131);
  const api = apiClient(env);
  const comments = await api.all(`/issues/${coordinationIssue}/comments?`);
  const stateComment = comments.find(comment => String(comment.body || '').includes(STATE_MARKER));
  const previous = parseStateComment(stateComment?.body || '') || emptyTickState({
    quietTicks: Number(env.COORDINATION_QUIET_TICKS || 3),
    staleTicks: Number(env.COORDINATION_STALE_TICKS || 8)
  });

  const [pulls, issues] = await Promise.all([
    api.all('/pulls?state=open'),
    api.all('/issues?state=open')
  ]);
  const inventory = inventoryFromGitHub(pulls, issues);
  const event = normalizeGitHubTickEvent(payload, env, inventory);
  const declarations = parseDeclarationLines(event.body, {
    actor: event.actor,
    branch: event.branch,
    issueNumbers: event.issue_numbers,
    source: event.source || event.key
  });
  const result = reduceCoordinationTick(previous, { event, inventory, declarations });
  if (!result.changed) {
    console.log(`Duplicate delivery ignored: ${event.key}`);
    return result;
  }

  const body = renderStateComment(result.state);
  if (stateComment) {
    await api.request(`/issues/comments/${stateComment.id}`, { method: 'PATCH', body: { body } });
  } else {
    await api.request(`/issues/${coordinationIssue}/comments`, { method: 'POST', body: { body } });
  }

  console.log(`coordination tick ${result.state.tick}: ${event.key}`);
  for (const signal of result.newSignals) console.log(`signal ${signal.type}: ${signal.lane || 'repository'} ${signal.detail}`);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await runCoordinationTick();
}
