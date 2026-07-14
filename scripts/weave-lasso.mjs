#!/usr/bin/env node
import { createHash, createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  isWeaveMessage,
  normalizeWeaveEvent,
  weavePayload
} from './weave-protocol.mjs';

const clean = value => String(value ?? '').replace(/\u0000/g, '').trim();
const sha256 = value => createHash('sha256').update(String(value)).digest('hex');
const canonical = ({ method, path, timestamp, nonce, body = '' }) => [method.toUpperCase(), path, timestamp, nonce, sha256(body)].join('\n');
const assemblyThread = id => `assembly:${id}`;

export const ASSEMBLIES = Object.freeze([
  {
    id: 'program-execution',
    title: 'What actually executes?',
    question: 'Trace the real program from source material to stored object to authority to candidate selection to ranking to rendering to feedback to moderation. Which layers are real, which are adapters, and which are nouns invented after the code existed?',
    required_move: 'Return one end-to-end trace, one concept to delete, and one executable probe that would prove the trace wrong.',
    keywords: ['architecture', 'execution', 'flow', 'runtime', 'pipeline', 'adapter', 'source', 'render', 'feed', 'product']
  },
  {
    id: 'corpus-boundaries',
    title: 'Stop calling everything corpus',
    question: 'Separate the public social graph, private personal archive, transient ranking candidate pool, derived retrieval index, and starter fixture. Which of these exists today, who owns each one, and what is allowed to cross between them?',
    required_move: 'Do not use the unqualified word corpus. Name the objects, authorities, retention rules, and migration paths explicitly.',
    keywords: ['corpus', 'archive', 'import', 'records', 'index', 'dataset', 'starter', 'storage', 'indexeddb', 'opfs']
  },
  {
    id: 'social-substrate',
    title: 'What is the social world?',
    question: 'Is the product fundamentally a personal reader, a public network, a community host, a federated client, or several products sharing a ranking kernel? Define the social substrate without borrowing the interface as the answer.',
    required_move: 'Name the canonical public objects, mutation authority, durability boundary, and why a person would create rather than merely import.',
    keywords: ['social', 'network', 'reddit', 'community', 'public', 'federation', 'hosted', 'creator', 'post']
  },
  {
    id: 'conversation-model',
    title: 'What makes conversation conversation?',
    question: 'Define posts, comments, replies, threads, edits, deletions, remixes, quotes, and community context without flattening all of them into generic records.',
    required_move: 'Propose the smallest conversation model that preserves threading, authorship, moderation, and link stability; then attack it.',
    keywords: ['comment', 'reply', 'thread', 'conversation', 'remix', 'quote', 'discussion', 'link']
  },
  {
    id: 'ranking-legitimacy',
    title: 'Why is this ranked above that?',
    question: 'Define candidate eligibility before scoring. Separate community rules, user preference, freshness, relationship, quality, exploration, and safety instead of compressing legitimacy into one saturation number.',
    required_move: 'Produce one inspectable ranking receipt and one adversarial corpus where the current kernel behaves embarrassingly.',
    keywords: ['rank', 'ranking', 'saturation', 'candidate', 'recommendation', 'score', 'freshness', 'quality']
  },
  {
    id: 'identity-community',
    title: 'Who belongs where?',
    question: 'Define identity, pseudonymity, community membership, roles, follows, blocks, bans, subscriptions, and portable ownership. Decide what belongs to a person, a community, a deployment, and a device.',
    required_move: 'Draw the authority graph and identify the first abuse case that breaks it.',
    keywords: ['profile', 'identity', 'handle', 'community', 'membership', 'follow', 'block', 'role', 'subscription']
  },
  {
    id: 'governance-abuse',
    title: 'How does it survive people?',
    question: 'Model spam, brigading, harassment, illegal material, ban evasion, moderator capture, community forks, appeals, and evidence retention before pretending the public network exists.',
    required_move: 'Choose one ugly incident, walk it through the system, and expose every missing authority or irreversible mistake.',
    keywords: ['moderation', 'spam', 'abuse', 'ban', 'report', 'appeal', 'brigade', 'safety', 'governance']
  }
]);

const IGNORED_ACTORS = new Set(['github-actions[bot]', 'dependabot[bot]', 'renovate[bot]']);

export function normalizeGitHubArrival(payload = {}, env = process.env) {
  const sender = payload.sender || payload.comment?.user || payload.review?.user || payload.issue?.user || payload.pull_request?.user || {};
  const repository = clean(payload.repository?.full_name || env.GITHUB_REPOSITORY);
  const eventName = clean(env.GITHUB_EVENT_NAME || payload.event_name || 'manual');
  const action = clean(payload.action || env.GITHUB_EVENT_ACTION || 'observed');
  const actor = clean(sender.login || env.GITHUB_ACTOR || 'unknown');
  const sourceId = clean(
    payload.comment?.id
      || payload.review?.id
      || payload.pull_request?.id
      || payload.issue?.id
      || payload.check_run?.id
      || payload.after
      || sha256(JSON.stringify(payload)).slice(0, 24)
  );
  const title = clean(payload.pull_request?.title || payload.issue?.title || payload.workflow?.name || '').slice(0, 1000);
  const body = clean(payload.comment?.body || payload.review?.body || payload.pull_request?.body || payload.issue?.body || '').slice(0, 12000);
  const ref = clean(payload.pull_request?.html_url || payload.issue?.html_url || payload.comment?.html_url || payload.review?.html_url || '');
  const defaultBranch = clean(payload.repository?.default_branch || env.GITHUB_BASE_REF || env.GITHUB_REF_NAME || 'main');
  return {
    actor,
    repository,
    event_name: eventName,
    action,
    source_id: sourceId,
    title,
    body,
    ref,
    default_branch: defaultBranch,
    observed_at: new Date().toISOString()
  };
}

export function shouldLassoArrival(arrival) {
  if (!clean(arrival?.actor) || arrival.actor === 'unknown') return false;
  return !IGNORED_ACTORS.has(arrival.actor.toLowerCase());
}

function keywordScore(assembly, text) {
  return assembly.keywords.reduce((score, keyword) => score + (text.includes(keyword) ? 3 : 0), 0);
}

export function selectAssemblies(arrival, limit = 3) {
  const text = `${arrival.title || ''}\n${arrival.body || ''}\n${arrival.event_name || ''}`.toLowerCase();
  const required = ['program-execution', 'corpus-boundaries'];
  const optional = ASSEMBLIES
    .filter(assembly => !required.includes(assembly.id))
    .map(assembly => ({
      assembly,
      score: keywordScore(assembly, text),
      tie: sha256(`${arrival.actor}:${arrival.source_id}:${assembly.id}`)
    }))
    .sort((left, right) => right.score - left.score || left.tie.localeCompare(right.tie))
    .map(item => item.assembly.id);
  const ids = [...required, ...optional].slice(0, Math.max(2, Math.min(ASSEMBLIES.length, Number(limit) || 3)));
  return ids.map(id => ASSEMBLIES.find(assembly => assembly.id === id));
}

function eventFromMessage(message) {
  return isWeaveMessage(message) ? message.payload.weave : null;
}

function assemblyHistory(messages, assemblyId) {
  return (Array.isArray(messages) ? messages : [])
    .map(eventFromMessage)
    .filter(Boolean)
    .filter(event => event.body?.thread_id === assemblyThread(assemblyId) || event.body?.beacon_id === assemblyThread(assemblyId));
}

function participantsFromHistory(history) {
  const participants = new Set();
  for (const event of history) {
    if (event.kind !== 'message') continue;
    if (!['assembly.invite', 'assembly.round'].includes(event.body?.message_type)) continue;
    for (const artifact of event.body?.artifacts || []) {
      if (artifact?.kind === 'github-arrival' && clean(artifact.actor)) participants.add(clean(artifact.actor));
    }
  }
  return [...participants].sort();
}

function deterministicEventId(...parts) {
  return `lasso-${sha256(parts.join('|')).slice(0, 48)}`;
}

function arrivalArtifact(arrival) {
  return {
    kind: 'github-arrival',
    actor: arrival.actor,
    repository: arrival.repository,
    event_name: arrival.event_name,
    action: arrival.action,
    source_id: arrival.source_id,
    ref: arrival.ref || null
  };
}

function inviteStatement(arrival, assembly) {
  return [
    `${arrival.actor} has been grouped into ${assembly.title}.`,
    assembly.question,
    assembly.required_move,
    'Do not begin with a feature list or summarize the repository. State a position, contradict one inherited assumption, and produce an executable probe, deletion, schema, or running variant.',
    'Treat other participants as peers with full program authority; challenge artifacts and premises rather than identities.'
  ].join('\n\n');
}

function roundStatement(assembly, participants) {
  return [
    `${assembly.title} now has overlapping participants: ${participants.join(', ')}.`,
    assembly.question,
    'Round protocol: each participant publishes (1) a concrete model, (2) a direct contradiction of another model or inherited premise, (3) an executable probe, and (4) one thing the program should delete or stop pretending exists.',
    'The round ends only when code, a runnable variant, a failing witness, a schema migration, or a durable decision changes shared reality.'
  ].join('\n\n');
}

export function buildLassoEvents(arrival, existingMessages = [], options = {}) {
  if (!shouldLassoArrival(arrival)) return [];
  const principal = clean(options.principal || 'weave-lasso');
  const events = [];

  for (const assembly of selectAssemblies(arrival, options.limit || 3)) {
    const threadId = assemblyThread(assembly.id);
    const history = assemblyHistory(existingMessages, assembly.id);
    const hasSeed = history.some(event => event.kind === 'beacon.emit');
    const participants = participantsFromHistory(history);
    const alreadyInvited = participants.includes(arrival.actor);

    if (!hasSeed) {
      events.push({
        id: deterministicEventId(arrival.repository, 'seed', assembly.id),
        kind: 'beacon.emit',
        issuer: principal,
        visibility: 'private',
        body: {
          beacon_id: threadId,
          kind: 'join_me',
          thread_id: threadId,
          target: { kind: 'program-ontology', document: 'PROGRAM_ONTOLOGY.md' },
          signal: assembly.question,
          current_understanding: 'This room exists to prevent agents from optimizing inherited nouns before proving what the program actually is.',
          useful_contribution: ['position', 'contradiction', 'executable probe', 'deletion candidate'],
          urgency: assembly.id === 'corpus-boundaries' ? 95 : 75,
          desired_agents: 4
        }
      });
    }

    if (!alreadyInvited) {
      events.push({
        id: deterministicEventId(arrival.repository, arrival.actor, arrival.source_id, 'invite', assembly.id),
        kind: 'message',
        issuer: principal,
        visibility: 'private',
        body: {
          message_type: 'assembly.invite',
          thread_id: threadId,
          statement: inviteStatement(arrival, assembly),
          expects_response: {
            kinds: ['position', 'contradiction', 'executable_probe', 'recode'],
            minimum_responses: 1
          },
          artifacts: [arrivalArtifact(arrival), { kind: 'ontology-room', id: assembly.id }],
          evidence: arrival.ref ? [{ kind: 'github-ref', ref: arrival.ref }] : []
        }
      });
    }

    const nextParticipants = [...new Set([...participants, arrival.actor])].sort();
    if (nextParticipants.length >= 2) {
      const roundKey = nextParticipants.join(',');
      const roundExists = history.some(event => event.kind === 'message'
        && event.body?.message_type === 'assembly.round'
        && event.body?.artifacts?.some(artifact => artifact?.kind === 'participant-set' && artifact.key === roundKey));
      if (!roundExists) {
        events.push({
          id: deterministicEventId(arrival.repository, 'round', assembly.id, roundKey),
          kind: 'message',
          issuer: principal,
          visibility: 'private',
          body: {
            message_type: 'assembly.round',
            thread_id: threadId,
            statement: roundStatement(assembly, nextParticipants),
            expects_response: {
              kinds: ['position', 'contradiction', 'executable_probe'],
              minimum_responses: nextParticipants.length
            },
            artifacts: [
              ...nextParticipants.map(actor => ({ kind: 'github-arrival', actor })),
              { kind: 'participant-set', key: roundKey },
              { kind: 'ontology-room', id: assembly.id }
            ],
            evidence: []
          }
        });
      }
    }
  }

  return events;
}

function remoteURL(env = process.env) {
  const raw = clean(env.REMOTE_URL);
  if (!raw) throw new Error('REMOTE_URL is required.');
  return new URL(raw.includes('/api/remote') ? raw : `${raw.replace(/\/$/, '')}/api/remote`);
}

function remoteSession(arrival, env = process.env) {
  return clean(env.REMOTE_SESSION || `${arrival.repository}:${arrival.default_branch || 'main'}`);
}

function remotePrincipal(env = process.env) {
  return clean(env.REMOTE_PRINCIPAL || 'weave-lasso');
}

function authHeaders(method, url, body, env = process.env, timestamp = new Date().toISOString(), nonce = randomUUID()) {
  const principal = remotePrincipal(env);
  const key = clean(env.REMOTE_KEY);
  if (!key) throw new Error('REMOTE_KEY is required.');
  const path = `${url.pathname}${url.search}`;
  const signature = createHmac('sha256', key).update(canonical({ method, path, timestamp, nonce, body })).digest('hex');
  return {
    timestamp,
    nonce,
    headers: {
      'content-type': 'application/json',
      'x-remote-principal': principal,
      'x-remote-timestamp': timestamp,
      'x-remote-nonce': nonce,
      'x-remote-signature': signature,
      'x-remote-path': path
    }
  };
}

async function readRemoteMessages(arrival, env = process.env) {
  const messages = [];
  let after = '';
  for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
    const url = remoteURL(env);
    url.searchParams.set('session', remoteSession(arrival, env));
    url.searchParams.set('limit', '100');
    if (after) url.searchParams.set('after', after);
    const { headers } = authHeaders('GET', url, '', env);
    const response = await fetch(url, { method: 'GET', headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${response.status} ${data.error || response.statusText}`);
    messages.push(...(Array.isArray(data.messages) ? data.messages : []));
    if (!data.has_more || !data.next_cursor || data.next_cursor === after) break;
    after = data.next_cursor;
  }
  return messages;
}

async function postLassoEvent(event, arrival, env = process.env) {
  const url = remoteURL(env);
  const timestamp = new Date().toISOString();
  const normalized = normalizeWeaveEvent({ ...event, issuer: remotePrincipal(env), issued_at: timestamp });
  const nonce = randomUUID();
  const message = {
    id: `remote-${sha256(normalized.id).slice(0, 48)}`,
    session: remoteSession(arrival, env),
    generation: Math.max(1, Number(env.REMOTE_GENERATION || 1) || 1),
    issuer: remotePrincipal(env),
    parent: null,
    issued_at: timestamp,
    expires_at: null,
    head_sha: clean(env.GITHUB_SHA) || null,
    scope: ['weave', 'lasso', normalized.body?.thread_id || normalized.body?.beacon_id].filter(Boolean),
    payload: weavePayload(normalized),
    visibility: event.visibility === 'public' ? 'public' : 'private',
    nonce
  };
  const body = JSON.stringify({ message });
  const signed = authHeaders('POST', url, body, env, timestamp, nonce);
  const response = await fetch(url, { method: 'POST', headers: signed.headers, body });
  const data = await response.json().catch(() => ({}));
  if (response.status === 409 && /message id already exists/i.test(clean(data.error))) {
    return { duplicate: true, event_id: normalized.id };
  }
  if (!response.ok) throw new Error(`${response.status} ${data.error || response.statusText}${data.detail ? `: ${JSON.stringify(data.detail)}` : ''}`);
  return { stored: true, event_id: normalized.id, message_id: message.id };
}

export async function runGitHubLasso({ payload, env = process.env } = {}) {
  const arrival = normalizeGitHubArrival(payload || {}, env);
  if (!shouldLassoArrival(arrival)) return { skipped: true, reason: 'ignored actor', arrival };
  const existing = await readRemoteMessages(arrival, env);
  const events = buildLassoEvents(arrival, existing, { principal: remotePrincipal(env) });
  const results = [];
  for (const event of events) results.push(await postLassoEvent(event, arrival, env));
  return {
    arrival,
    selected_assemblies: selectAssemblies(arrival).map(assembly => assembly.id),
    planned: events.length,
    stored: results.filter(result => result.stored).length,
    duplicates: results.filter(result => result.duplicate).length,
    results
  };
}

async function main() {
  const command = process.argv[2] || 'help';
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log('Usage: node scripts/weave-lasso.mjs github-event | plan EVENT.json');
    return;
  }
  if (command === 'plan') {
    const file = process.argv[3];
    if (!file) throw new Error('plan requires a GitHub event JSON file.');
    const payload = JSON.parse(await fs.readFile(file, 'utf8'));
    const arrival = normalizeGitHubArrival(payload);
    console.log(JSON.stringify({ arrival, events: buildLassoEvents(arrival) }, null, 2));
    return;
  }
  if (command === 'github-event') {
    const file = clean(process.env.GITHUB_EVENT_PATH);
    if (!file) throw new Error('GITHUB_EVENT_PATH is required.');
    const payload = JSON.parse(await fs.readFile(file, 'utf8'));
    console.log(JSON.stringify(await runGitHubLasso({ payload }), null, 2));
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`weave-lasso: ${error.message}`);
    process.exit(1);
  });
}
