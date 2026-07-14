#!/usr/bin/env node
import { createHash, createHmac, randomUUID } from 'node:crypto';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  foldCognitionEvents,
  normalizeCognitionEvent,
  stableDigest,
  unresolvedCognitionIds
} from './weave-cognition.mjs';
import { planDeliberationWave } from './weave-deliberation.mjs';
import { buildRolePacket, dispatchIdempotencyKey, parseAdapterOutput } from './weave-dispatch.mjs';
import { retrieveCognitionMemory } from './weave-memory.mjs';
import { buildSynthesis, critiqueSynthesis } from './weave-synthesis.mjs';
import { publicCognitionEventProjection } from '../netlify/functions/weave-cognition-public.mjs';

export const ASSIGNMENT_MARKER = 'sideways-cognition-assignment:v1';
export const OUTPUT_MARKER = 'sideways-cognition-output:v1';
export const SEED_MARKER = 'sideways-cognition-seed:v1';

const DEFAULT_ROLE_MENTIONS = Object.freeze({
  proposer: '@codex',
  implementer: '@codex',
  integrator: '@codex',
  verifier: '@copilot',
  opponent: '@claude',
  critic: '@claude',
  historian: '@claude',
  default: '@codex'
});

const clean = (value, limit = 8000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const digest = value => createHash('sha256').update(String(value)).digest('hex');
const unique = values => [...new Set(values.filter(Boolean))];
const trustedAssociations = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

function jsonBlock(body, marker) {
  const text = String(body || '');
  if (!text.includes(`<!-- ${marker}`)) return null;
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (!match) return null;
  try { return JSON.parse(match[1]); }
  catch { return null; }
}

export function parseCognitionSeedComment(comment) {
  const value = jsonBlock(comment?.body, SEED_MARKER);
  return value && Array.isArray(value.events) ? value : null;
}

export function parseCognitionOutputComment(comment) {
  const value = jsonBlock(comment?.body, OUTPUT_MARKER);
  return value && clean(value.assignment_id, 160) && Array.isArray(value.events) ? value : null;
}

export function trustedCognitionComment(comment, allowLogins = []) {
  const login = clean(comment?.user?.login, 160).toLowerCase();
  if (!login || login === 'github-actions[bot]') return false;
  if (trustedAssociations.has(clean(comment?.author_association, 40).toUpperCase())) return true;
  return new Set(allowLogins.map(value => clean(value, 160).toLowerCase())).has(login);
}

function summaryForEvent(event) {
  const body = event?.body || {};
  return clean(
    body.statement || body.question || body.name || body.role || body.status || `${event.kind} ${event.id}`,
    300
  );
}

function eventMessageId(event) {
  return `cognition-${digest(event.id).slice(0, 48)}`;
}

export function extractRemoteCognitionEvents(messages = []) {
  const events = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const value = message?.payload?.cognition;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    try { events.push(normalizeCognitionEvent(value)); }
    catch {}
  }
  return events;
}

function canonicalRequest({ method, path, timestamp, nonce, body = '' }) {
  return [method.toUpperCase(), path, timestamp, nonce, digest(body)].join('\n');
}

export function createSignedRemoteCognitionClient({
  remoteUrl,
  session,
  principal,
  key,
  generation = 1,
  fetchImpl = fetch,
  now = () => new Date().toISOString(),
  nonce = () => randomUUID(),
  headSha = null
}) {
  const base = new URL(String(remoteUrl).includes('/api/remote') ? remoteUrl : `${String(remoteUrl).replace(/\/$/, '')}/api/remote`);
  if (!clean(session, 220) || !clean(principal, 160) || !clean(key, 8192)) throw new Error('Remote session, principal, and HMAC key are required.');

  const headersFor = (method, url, body = '') => {
    const timestamp = now();
    const requestNonce = nonce();
    const path = `${url.pathname}${url.search}`;
    const signature = createHmac('sha256', key).update(canonicalRequest({ method, path, timestamp, nonce: requestNonce, body })).digest('hex');
    return {
      timestamp,
      nonce: requestNonce,
      headers: {
        'content-type': 'application/json',
        'x-remote-principal': principal,
        'x-remote-timestamp': timestamp,
        'x-remote-nonce': requestNonce,
        'x-remote-signature': signature,
        'x-remote-path': path
      }
    };
  };

  const request = async (method, url, bodyObject) => {
    const body = bodyObject === undefined ? '' : JSON.stringify(bodyObject);
    const auth = headersFor(method, url, body);
    const response = await fetchImpl(url, { method, headers: auth.headers, ...(body ? { body } : {}) });
    const data = await response.json().catch(() => ({}));
    return { response, data, auth };
  };

  return {
    async listMessages() {
      const messages = [];
      let after = '';
      let resolvedGeneration = Number(generation) || 1;
      for (let page = 0; page < 100; page += 1) {
        const url = new URL(base);
        url.searchParams.set('session', session);
        url.searchParams.set('limit', '100');
        if (after) url.searchParams.set('after', after);
        const { response, data } = await request('GET', url);
        if (!response.ok) throw new Error(`Remote list failed: ${response.status} ${clean(data.error || response.statusText, 500)}`);
        messages.push(...(Array.isArray(data.messages) ? data.messages : []));
        resolvedGeneration = Number(data.generation || resolvedGeneration) || resolvedGeneration;
        if (!data.has_more || !data.next_cursor || data.next_cursor === after) break;
        after = data.next_cursor;
      }
      return { messages, generation: resolvedGeneration };
    },
    async appendEvent(rawEvent, currentGeneration = generation) {
      const event = normalizeCognitionEvent(rawEvent);
      const url = new URL(base);
      const timestamp = now();
      const requestNonce = nonce();
      const message = {
        id: eventMessageId(event),
        session,
        generation: Number(currentGeneration) || 1,
        issuer: principal,
        parent: null,
        issued_at: timestamp,
        expires_at: null,
        head_sha: headSha,
        scope: ['weave:cognition'],
        payload: {
          action: 'cognition.event',
          summary: summaryForEvent(event),
          cognition: event
        },
        visibility: event.visibility,
        nonce: requestNonce
      };
      const body = JSON.stringify({ message });
      const path = `${url.pathname}${url.search}`;
      const signature = createHmac('sha256', key).update(canonicalRequest({ method: 'POST', path, timestamp, nonce: requestNonce, body })).digest('hex');
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-remote-principal': principal,
          'x-remote-timestamp': timestamp,
          'x-remote-nonce': requestNonce,
          'x-remote-signature': signature,
          'x-remote-path': path
        },
        body
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 409) return { event, duplicate: true, data };
      if (!response.ok) throw new Error(`Remote append failed: ${response.status} ${clean(data.error || response.statusText, 500)}`);
      return { event, duplicate: false, data };
    },
    async appendEvents(events, currentGeneration = generation) {
      const results = [];
      for (const event of events) results.push(await this.appendEvent(event, currentGeneration));
      return results;
    }
  };
}

export function createGitHubIssueCognitionClient({ token, repository, fetchImpl = fetch }) {
  if (!clean(token, 8192) || !clean(repository, 300).includes('/')) throw new Error('GitHub token and repository are required.');
  const base = `https://api.github.com/repos/${repository}`;
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'sideways-recursive-weave'
  };
  const request = async (path, options = {}) => {
    const response = await fetchImpl(`${base}${path}`, {
      method: options.method || 'GET',
      headers: { ...headers, ...(options.body ? { 'content-type': 'application/json' } : {}) },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`GitHub API ${response.status}: ${clean(data.message || response.statusText, 500)}`);
    return data;
  };
  return {
    async listComments(issueNumber) {
      const values = [];
      for (let page = 1; page <= 20; page += 1) {
        const batch = await request(`/issues/${Number(issueNumber)}/comments?per_page=100&page=${page}`);
        values.push(...batch);
        if (batch.length < 100) break;
      }
      return values;
    },
    async postComment(issueNumber, body) {
      return request(`/issues/${Number(issueNumber)}/comments`, { method: 'POST', body: { body } });
    }
  };
}

function memorySummaryEntry(event) {
  const projected = publicCognitionEventProjection({ visibility: 'public', payload: { cognition: event } });
  return projected || { id: event.id, kind: event.kind, issued_at: event.issued_at };
}

export function renderCognitionAssignmentComment({ assignment, memory, mention = '@codex' }) {
  const body = assignment.body;
  const packet = {
    assignment_id: body.assignment_id,
    wave_id: body.wave_id,
    role: body.role,
    target_event_ids: body.target_ids,
    expected_event_kinds: body.expected_kinds,
    completion_criteria: body.completion_criteria,
    budget: body.budget,
    artifact_scope: body.artifact_scope,
    memory: (memory?.events || []).map(value => memorySummaryEntry(value)).slice(0, 48)
  };
  return `<!-- ${ASSIGNMENT_MARKER} assignment=${body.assignment_id} -->\n${mention}\n\nExecute the typed role packet below. Return concise claims, evidence, tests, artifacts, decisions, syntheses, or critiques only; do not return private chain-of-thought. Every event must cite at least one target event ID.\n\n\`\`\`json\n${JSON.stringify(packet, null, 2)}\n\`\`\`\n\nReturn exactly one output envelope:\n\n<!-- ${OUTPUT_MARKER} -->\n\`\`\`json\n{\n  "assignment_id": "${body.assignment_id}",\n  "events": []\n}\n\`\`\``;
}

function roleMentions(config = {}) {
  return { ...DEFAULT_ROLE_MENTIONS, ...(config.role_mentions || {}) };
}

function assignmentMarker(assignmentId) {
  return `<!-- ${ASSIGNMENT_MARKER} assignment=${assignmentId} -->`;
}

function trustedComments(comments, allowLogins) {
  return [...comments]
    .filter(comment => trustedCognitionComment(comment, allowLogins))
    .sort((left, right) => Date.parse(left.created_at || 0) - Date.parse(right.created_at || 0) || Number(left.id) - Number(right.id));
}

async function appendMissing(remote, state, events, generation) {
  const known = new Set(state.events.map(event => event.id));
  const fresh = [];
  for (const event of events) if (!known.has(event.id)) fresh.push(event);
  if (fresh.length) await remote.appendEvents(fresh, generation);
  return fresh;
}

function dispatchStartedEvent(assignment, adapterId, issuedAt) {
  const idempotencyKey = dispatchIdempotencyKey({
    wave_id: assignment.body.wave_id,
    assignment_id: assignment.body.assignment_id,
    adapter_id: adapterId
  });
  const short = idempotencyKey.slice(0, 32);
  return normalizeCognitionEvent({
    id: `dispatch-start:${short}`,
    kind: 'dispatch.started',
    issuer: 'system:weave-bridge',
    issued_at: issuedAt,
    visibility: assignment.visibility,
    source_event_ids: [assignment.id],
    body: {
      dispatch_id: `dispatch:${short}`,
      assignment_event_id: assignment.id,
      assignment_id: assignment.body.assignment_id,
      adapter_id: adapterId,
      idempotency_key: idempotencyKey
    }
  });
}

function dispatchCompletedEvent(assignment, adapterId, status, outputIds, error, issuedAt) {
  const idempotencyKey = dispatchIdempotencyKey({
    wave_id: assignment.body.wave_id,
    assignment_id: assignment.body.assignment_id,
    adapter_id: adapterId
  });
  const short = idempotencyKey.slice(0, 32);
  return normalizeCognitionEvent({
    id: `dispatch-complete:${short}`,
    kind: 'dispatch.completed',
    issuer: 'system:weave-bridge',
    issued_at: issuedAt,
    visibility: assignment.visibility,
    source_event_ids: [assignment.id, ...outputIds],
    body: {
      dispatch_id: `dispatch:${short}`,
      assignment_event_id: assignment.id,
      assignment_id: assignment.body.assignment_id,
      adapter_id: adapterId,
      idempotency_key: idempotencyKey,
      status,
      output_ids: outputIds,
      error: error || null
    }
  });
}

function waveReceiptEvent({ waveIndex, status, assignments, outputs, unresolved, issuedAt, visibility = 'public' }) {
  return normalizeCognitionEvent({
    id: `receipt:bridge-wave:${waveIndex}:${status}`,
    kind: 'wave.receipt',
    issuer: 'system:weave-bridge',
    issued_at: issuedAt,
    visibility,
    source_event_ids: [...assignments.map(event => event.id), ...outputs.map(event => event.id), ...unresolved],
    body: {
      wave_id: `wave:${waveIndex}`,
      index: waveIndex,
      status,
      assignment_ids: assignments.map(event => event.id),
      output_ids: outputs.map(event => event.id),
      unresolved_ids: unresolved,
      budget_used: { assignments: assignments.length, outputs: outputs.length },
      statement: `Event-driven recursive weave wave ${waveIndex} ${status}.`
    }
  });
}

async function reload(remote) {
  const result = await remote.listMessages();
  const events = extractRemoteCognitionEvents(result.messages);
  return { ...result, events, state: foldCognitionEvents(events) };
}

async function ingestSeeds({ remote, snapshot, comments, allowLogins, now }) {
  const additions = [];
  for (const comment of trustedComments(comments, allowLogins)) {
    const seed = parseCognitionSeedComment(comment);
    if (!seed) continue;
    for (let index = 0; index < seed.events.length; index += 1) {
      const raw = seed.events[index];
      try {
        additions.push(normalizeCognitionEvent({
          ...raw,
          id: raw.id || `seed:${comment.id}:${index}`,
          issuer: `github:${clean(comment.user?.login, 120)}`,
          issued_at: raw.issued_at || comment.created_at || now(),
          visibility: 'public'
        }));
      } catch {}
    }
  }
  return appendMissing(remote, snapshot.state, additions, snapshot.generation);
}

async function ingestOutputs({ remote, snapshot, comments, allowLogins, now }) {
  const outputByAssignment = new Map();
  for (const comment of trustedComments(comments, allowLogins)) {
    const parsed = parseCognitionOutputComment(comment);
    if (!parsed || outputByAssignment.has(parsed.assignment_id)) continue;
    outputByAssignment.set(parsed.assignment_id, { comment, parsed });
  }

  const additions = [];
  for (const assignmentEventId of snapshot.state.pending_assignment_event_ids) {
    const assignment = snapshot.state.by_id[assignmentEventId];
    const found = outputByAssignment.get(assignment.body.assignment_id);
    if (!found) continue;
    const adapterId = snapshot.state.dispatch_started[assignment.body.assignment_id]?.body.adapter_id || `github:${assignment.body.role}`;
    const publicTargets = assignment.body.target_ids.every(id => snapshot.state.by_id[id]?.visibility === 'public');
    if (assignment.visibility !== 'public' || !publicTargets) continue;
    const memory = retrieveCognitionMemory(snapshot.state, {
      role: assignment.body.role,
      target_ids: assignment.body.target_ids,
      text: assignment.body.completion_criteria.join(' ')
    }, { visibility: 'public', max_chars: assignment.body.budget.max_chars });
    const packet = buildRolePacket(assignment, memory, adapterId);
    const rawEvents = found.parsed.events.map((value, index) => ({
      ...value,
      id: value.id || `github-output:${found.comment.id}:${index}`,
      issuer: `github:${clean(found.comment.user?.login, 120)}`,
      issued_at: value.issued_at || found.comment.created_at || now(),
      visibility: 'public'
    }));
    try {
      const outputs = parseAdapterOutput(rawEvents, packet, {
        issuer: `github:${clean(found.comment.user?.login, 120)}`,
        issued_at: found.comment.created_at || now()
      });
      additions.push(...outputs);
      additions.push(dispatchCompletedEvent(assignment, adapterId, 'completed', outputs.map(event => event.id), null, now()));
    } catch (error) {
      additions.push(dispatchCompletedEvent(assignment, adapterId, 'failed', [], `invalid output comment ${found.comment.id}: ${clean(error?.message || error, 320)}`, now()));
    }
  }
  return appendMissing(remote, snapshot.state, additions, snapshot.generation);
}

function waveIndexFromId(value) {
  const match = String(value || '').match(/:(\d+)$/);
  return match ? Number(match[1]) : 0;
}

async function finalizeCompletedWave({ remote, snapshot, now }) {
  const assignmentsByWave = new Map();
  for (const assignment of Object.values(snapshot.state.assignments)) {
    const list = assignmentsByWave.get(assignment.body.wave_id) || [];
    list.push(assignment);
    assignmentsByWave.set(assignment.body.wave_id, list);
  }
  const candidates = [...assignmentsByWave.entries()]
    .filter(([waveId, assignments]) => !snapshot.state.waves[waveId] && assignments.every(event => snapshot.state.dispatch_completed[event.body.assignment_id]))
    .sort((left, right) => waveIndexFromId(left[0]) - waveIndexFromId(right[0]));
  const candidate = candidates[0];
  if (!candidate) return [];
  const [waveId, assignments] = candidate;
  const waveIndex = waveIndexFromId(waveId);
  const completions = assignments.map(event => snapshot.state.dispatch_completed[event.body.assignment_id]);
  const outputs = unique(completions.flatMap(event => event.body.output_ids)).map(id => snapshot.state.by_id[id]).filter(Boolean);
  const additions = [];
  let critique = null;
  if (outputs.length) {
    const unresolvedBefore = unresolvedCognitionIds(snapshot.state).filter(id => !snapshot.state.pending_assignment_event_ids.includes(id));
    const synthesis = buildSynthesis({
      id: `synthesis:bridge-wave:${waveIndex}`,
      issuer: 'system:weave-synthesizer',
      issued_at: now(),
      source_events: outputs,
      unresolved_ids: unresolvedBefore,
      minority_report_ids: snapshot.state.dissent_event_ids.filter(id => outputs.some(event => event.id === id)),
      proposed_actions: unresolvedBefore.length ? ['derive another bounded wave'] : ['terminalize convergence']
    });
    synthesis.visibility = assignments.every(event => event.visibility === 'public') ? 'public' : 'private';
    additions.push(synthesis);
    const projected = foldCognitionEvents([...snapshot.state.events, synthesis]);
    critique = critiqueSynthesis({
      id: `critique:bridge-wave:${waveIndex}`,
      synthesis,
      state: projected,
      issuer: 'system:weave-critic',
      issued_at: now()
    });
    critique.visibility = synthesis.visibility;
    additions.push(critique);
  }
  const projected = foldCognitionEvents([...snapshot.state.events, ...additions]);
  const unresolved = unresolvedCognitionIds(projected).filter(id => !projected.pending_assignment_event_ids.includes(id));
  const failed = completions.some(event => event.body.status === 'failed');
  const status = failed && !outputs.length
    ? 'blocked'
    : (unresolved.length || (critique && critique.body.verdict !== 'accept') ? 'advanced' : 'converged');
  additions.push(waveReceiptEvent({
    waveIndex,
    status,
    assignments,
    outputs,
    unresolved,
    issuedAt: now(),
    visibility: assignments.every(event => event.visibility === 'public') ? 'public' : 'private'
  }));
  await appendMissing(remote, snapshot.state, additions, snapshot.generation);
  return additions;
}

async function dispatchPending({ remote, github, snapshot, comments, issueNumber, roleMentionMap, now }) {
  const additions = [];
  let commentsPosted = 0;
  for (const assignmentEventId of snapshot.state.pending_assignment_event_ids) {
    const assignment = snapshot.state.by_id[assignmentEventId];
    const mention = roleMentionMap[assignment.body.role] || roleMentionMap.default || '@codex';
    const adapterId = `github-issue:${mention.replace(/^@/, '')}`;
    let started = snapshot.state.dispatch_started[assignment.body.assignment_id];
    if (!started) {
      started = dispatchStartedEvent(assignment, adapterId, now());
      additions.push(started);
    }
    const publicTargets = assignment.body.target_ids.every(id => snapshot.state.by_id[id]?.visibility === 'public');
    if (assignment.visibility !== 'public' || !publicTargets) {
      additions.push(dispatchCompletedEvent(assignment, adapterId, 'failed', [], 'private assignment requires a private adapter', now()));
      continue;
    }
    if (!comments.some(comment => String(comment.body || '').includes(assignmentMarker(assignment.body.assignment_id)))) {
      const memory = retrieveCognitionMemory(snapshot.state, {
        role: assignment.body.role,
        target_ids: assignment.body.target_ids,
        text: assignment.body.completion_criteria.join(' ')
      }, { visibility: 'public', max_chars: assignment.body.budget.max_chars });
      await github.postComment(issueNumber, renderCognitionAssignmentComment({ assignment, memory, mention }));
      commentsPosted += 1;
    }
  }
  if (additions.length) await appendMissing(remote, snapshot.state, additions, snapshot.generation);
  return { additions, commentsPosted };
}

function nextWaveIndex(state) {
  const values = Object.values(state.waves).map(event => Number(event.body.index || 0));
  return values.length ? Math.max(...values) + 1 : 0;
}

function terminalReceipt(state) {
  return Object.values(state.waves)
    .sort((left, right) => Number(left.body.index) - Number(right.body.index))
    .findLast(event => event.body.status !== 'advanced') || null;
}

export async function runRecursiveCognitionBridge({
  remote,
  github,
  issue_number = 178,
  allow_logins = [],
  role_mentions = {},
  budget = {},
  now = () => new Date().toISOString()
}) {
  const comments = await github.listComments(issue_number);
  let snapshot = await reload(remote);
  const seeded = await ingestSeeds({ remote, snapshot, comments, allowLogins: allow_logins, now });
  if (seeded.length) snapshot = await reload(remote);
  const ingested = await ingestOutputs({ remote, snapshot, comments, allowLogins: allow_logins, now });
  if (ingested.length) snapshot = await reload(remote);

  if (snapshot.state.pending_assignment_event_ids.length) {
    const dispatched = await dispatchPending({
      remote,
      github,
      snapshot,
      comments,
      issueNumber: issue_number,
      roleMentionMap: roleMentions({ role_mentions }),
      now
    });
    return {
      status: 'awaiting_outputs',
      seeded: seeded.length,
      ingested: ingested.length,
      pending: snapshot.state.pending_assignment_event_ids.length,
      comments_posted: dispatched.commentsPosted
    };
  }

  const finalized = await finalizeCompletedWave({ remote, snapshot, now });
  if (finalized.length) snapshot = await reload(remote);
  const terminal = terminalReceipt(snapshot.state);
  if (terminal) {
    return {
      status: terminal.body.status,
      seeded: seeded.length,
      ingested: ingested.length,
      finalized: finalized.length,
      wave: terminal.body.index
    };
  }

  const maxWaves = Math.max(1, Math.min(32, Number(budget.max_waves ?? 8) || 8));
  const waveIndex = nextWaveIndex(snapshot.state);
  if (waveIndex >= maxWaves || snapshot.state.events.length >= Math.max(1, Number(budget.max_events ?? 512) || 512)) {
    const receipt = waveReceiptEvent({
      waveIndex,
      status: 'budget_exhausted',
      assignments: [],
      outputs: [],
      unresolved: unresolvedCognitionIds(snapshot.state),
      issuedAt: now()
    });
    await appendMissing(remote, snapshot.state, [receipt], snapshot.generation);
    return { status: 'budget_exhausted', wave: waveIndex };
  }

  const plan = planDeliberationWave(snapshot.state, {
    wave_index: waveIndex,
    max_assignments: Math.max(1, Math.min(32, Number(budget.max_assignments_per_wave ?? 8) || 8)),
    max_events_per_assignment: Math.max(1, Math.min(16, Number(budget.max_events_per_assignment ?? 4) || 4)),
    max_chars_per_assignment: Math.max(256, Math.min(64000, Number(budget.max_chars_per_assignment ?? 12000) || 12000)),
    issued_at: now(),
    visibility: 'public'
  });
  if (plan.terminal) {
    const receipt = waveReceiptEvent({
      waveIndex,
      status: plan.terminal,
      assignments: [],
      outputs: [],
      unresolved: plan.unresolved_ids,
      issuedAt: now()
    });
    await appendMissing(remote, snapshot.state, [receipt], snapshot.generation);
    return { status: plan.terminal, wave: waveIndex };
  }

  const assignments = plan.assignments.map(value => {
    const { novelty_key, priority, ...event } = value;
    const targetsPublic = event.body.target_ids.every(id => snapshot.state.by_id[id]?.visibility === 'public');
    return normalizeCognitionEvent({ ...event, visibility: targetsPublic ? 'public' : 'private' });
  });
  await appendMissing(remote, snapshot.state, assignments, snapshot.generation);
  snapshot = await reload(remote);
  const dispatched = await dispatchPending({
    remote,
    github,
    snapshot,
    comments: await github.listComments(issue_number),
    issueNumber: issue_number,
    roleMentionMap: roleMentions({ role_mentions }),
    now
  });
  return {
    status: 'dispatched',
    wave: waveIndex,
    assignments: assignments.length,
    comments_posted: dispatched.commentsPosted,
    seeded: seeded.length,
    ingested: ingested.length,
    finalized: finalized.length
  };
}

function parseJSONEnv(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; }
  catch { return fallback; }
}

async function main() {
  const required = ['REMOTE_URL', 'REMOTE_SESSION', 'REMOTE_PRINCIPAL', 'REMOTE_KEY', 'GITHUB_TOKEN', 'GITHUB_REPOSITORY'];
  const missing = required.filter(name => !clean(process.env[name]));
  if (missing.length) {
    console.log(JSON.stringify({ status: 'disabled', missing }));
    return;
  }
  const remote = createSignedRemoteCognitionClient({
    remoteUrl: process.env.REMOTE_URL,
    session: process.env.REMOTE_SESSION,
    principal: process.env.REMOTE_PRINCIPAL,
    key: process.env.REMOTE_KEY,
    generation: Number(process.env.REMOTE_GENERATION || 1),
    headSha: process.env.GITHUB_SHA || null
  });
  const github = createGitHubIssueCognitionClient({
    token: process.env.GITHUB_TOKEN,
    repository: process.env.GITHUB_REPOSITORY
  });
  const owner = clean(process.env.GITHUB_REPOSITORY).split('/')[0];
  const result = await runRecursiveCognitionBridge({
    remote,
    github,
    issue_number: Number(process.env.WEAVE_COGNITION_ISSUE || 178),
    allow_logins: unique([owner, ...clean(process.env.WEAVE_AGENT_LOGINS).split(',').map(value => value.trim())]),
    role_mentions: parseJSONEnv(process.env.WEAVE_ROLE_MENTIONS, {}),
    budget: {
      max_waves: Number(process.env.WEAVE_MAX_WAVES || 8),
      max_events: Number(process.env.WEAVE_MAX_EVENTS || 512),
      max_assignments_per_wave: Number(process.env.WEAVE_MAX_ASSIGNMENTS || 8),
      max_events_per_assignment: Number(process.env.WEAVE_MAX_OUTPUT_EVENTS || 4),
      max_chars_per_assignment: Number(process.env.WEAVE_MAX_OUTPUT_CHARS || 12000)
    }
  });
  console.log(JSON.stringify(result));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await main();
}
