#!/usr/bin/env node
import { createHash, createHmac, randomUUID, sign as signBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import process from 'node:process';
import {
  defaultWeaveVisibility,
  weavePayload
} from './weave-protocol.mjs';
import {
  createWeaveEvent,
  foldWeaveMessages
} from './weave-replay-integrity.mjs';

const clean = value => String(value ?? '').trim();
const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonical = ({ method, path, timestamp, nonce, body = '' }) => [method.toUpperCase(), path, timestamp, nonce, sha256(body)].join('\n');

function usage() {
  console.log(`Sideways weave client

Environment:
  REMOTE_URL          Site origin or /api/remote URL
  REMOTE_SESSION      Project-defined session
  REMOTE_GENERATION   Current generation (default 1)
  REMOTE_PRINCIPAL    Opaque principal id
  REMOTE_KEY          HMAC secret
  REMOTE_PRIVATE_KEY  Ed25519 private key PEM or @path
  WEAVE_SESSION_ID    Current agent runtime session id

Commands:
  state [--private]
  list [--after CURSOR] [--private]
  event FILE.json
  beacon FILE.json
  join BEACON_ID [STATEMENT]
  release BEACON_ID [REASON]
  resolve FILE.json
  presence STATE [LEASE_SECONDS]
  intent FILE.json
  message FILE.json
  recode FILE.json
  recode-join RECODE_ID [POSITION]
  recode-event FILE.json
  recode-terminate FILE.json
  handoff FILE.json
  lost FILE.json
  recover FILE.json

JSON files contain the event body, except event which accepts a complete weave event.`);
}

function baseURL() {
  const raw = clean(process.env.REMOTE_URL);
  if (!raw) throw new Error('REMOTE_URL is required.');
  return new URL(raw.includes('/api/remote') ? raw : `${raw.replace(/\/$/, '')}/api/remote`);
}

async function privateKey() {
  const value = clean(process.env.REMOTE_PRIVATE_KEY);
  if (!value) return '';
  if (value.startsWith('@')) return fs.readFile(value.slice(1), 'utf8');
  return value.replace(/\\n/g, '\n');
}

async function signedHeaders(method, url, body, timestamp, nonce) {
  const principal = clean(process.env.REMOTE_PRINCIPAL);
  const hmacKey = clean(process.env.REMOTE_KEY);
  const key = await privateKey();
  if (!principal || (!hmacKey && !key)) throw new Error('REMOTE_PRINCIPAL and REMOTE_KEY or REMOTE_PRIVATE_KEY are required.');
  const path = `${url.pathname}${url.search}`;
  const material = canonical({ method, path, timestamp, nonce, body });
  const signature = hmacKey
    ? createHmac('sha256', hmacKey).update(material).digest('hex')
    : signBytes(null, Buffer.from(material), key).toString('base64');
  return {
    'content-type': 'application/json',
    'x-remote-principal': principal,
    'x-remote-timestamp': timestamp,
    'x-remote-nonce': nonce,
    'x-remote-signature': signature,
    'x-remote-path': path
  };
}

async function request(method, url, bodyObject, authenticated = true) {
  const body = bodyObject === undefined ? '' : JSON.stringify(bodyObject);
  let headers = { 'content-type': 'application/json' };
  if (authenticated) {
    const timestamp = new Date().toISOString();
    const nonce = randomUUID();
    headers = await signedHeaders(method, url, body, timestamp, nonce);
  }
  const response = await fetch(url, { method, headers, ...(body ? { body } : {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${data.error || response.statusText}${data.detail ? `: ${JSON.stringify(data.detail)}` : ''}`);
  return data;
}

function remoteEnvelope(payload, { timestamp, nonce, visibility }) {
  const principal = clean(process.env.REMOTE_PRINCIPAL);
  const session = clean(process.env.REMOTE_SESSION);
  if (!session) throw new Error('REMOTE_SESSION is required.');
  return {
    id: randomUUID(),
    session,
    generation: Number(process.env.REMOTE_GENERATION || 1),
    issuer: principal,
    parent: null,
    issued_at: timestamp,
    expires_at: null,
    head_sha: clean(process.env.GITHUB_SHA) || null,
    scope: ['weave'],
    payload,
    visibility,
    nonce
  };
}

async function postEvent(input) {
  const principal = clean(process.env.REMOTE_PRINCIPAL);
  const timestamp = new Date().toISOString();
  const nonce = randomUUID();
  const visibility = defaultWeaveVisibility(input.kind, input.visibility);
  const event = createWeaveEvent(input, { issuer: principal, issued_at: timestamp });
  const message = remoteEnvelope(weavePayload(event), { timestamp, nonce, visibility });
  const url = baseURL();
  const body = JSON.stringify({ message });
  const headers = await signedHeaders('POST', url, body, timestamp, nonce);
  const response = await fetch(url, { method: 'POST', headers, body });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${data.error || response.statusText}${data.detail ? `: ${JSON.stringify(data.detail)}` : ''}`);
  return data;
}

async function readJSON(path) {
  if (!path) throw new Error('A JSON file path is required.');
  return JSON.parse(await fs.readFile(path, 'utf8'));
}

function parseFlags(args) {
  const result = { positional: [] };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--private') result.private = true;
    else if (args[index] === '--after') result.after = args[++index] || '';
    else result.positional.push(args[index]);
  }
  return result;
}

function event(kind, body) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? { ...body } : {};
  const visibility = source.visibility;
  delete source.visibility;
  return { kind, body: source, ...(visibility ? { visibility } : {}) };
}

const [command = 'help', ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);

try {
  let result;
  if (['help', '--help', '-h'].includes(command)) {
    usage();
    process.exit(0);
  } else if (command === 'state' || command === 'list') {
    const url = baseURL();
    url.pathname = '/api/remote';
    url.searchParams.set('session', clean(process.env.REMOTE_SESSION));
    if (!flags.private) url.searchParams.set('public', '1');
    if (flags.after) url.searchParams.set('after', flags.after);
    url.searchParams.set('limit', '100');
    const page = await request('GET', url, undefined, Boolean(flags.private));
    result = command === 'state'
      ? { remote: { session: page.session, generation: page.generation, next_cursor: page.next_cursor, has_more: page.has_more }, weave: foldWeaveMessages(page.messages) }
      : page;
  } else if (command === 'event') {
    result = await postEvent(await readJSON(flags.positional[0]));
  } else if (command === 'beacon') {
    const body = await readJSON(flags.positional[0]);
    result = await postEvent(event('beacon.emit', { beacon_id: body.beacon_id || randomUUID(), ...body }));
  } else if (command === 'join') {
    result = await postEvent(event('beacon.join', { beacon_id: flags.positional[0], statement: flags.positional.slice(1).join(' ') || null }));
  } else if (command === 'release') {
    result = await postEvent(event('beacon.release', { beacon_id: flags.positional[0], reason: flags.positional.slice(1).join(' ') || null }));
  } else if (command === 'resolve') {
    result = await postEvent(event('beacon.resolve', await readJSON(flags.positional[0])));
  } else if (command === 'presence') {
    const seconds = Math.max(30, Number(flags.positional[1] || 300));
    const agentId = clean(process.env.REMOTE_PRINCIPAL);
    result = await postEvent(event('presence', {
      agent_id: agentId,
      session_id: clean(process.env.WEAVE_SESSION_ID) || `${agentId}:${process.pid}`,
      state: flags.positional[0],
      lease_expires_at: new Date(Date.now() + seconds * 1000).toISOString()
    }));
  } else if (command === 'intent') {
    result = await postEvent(event('intent', await readJSON(flags.positional[0])));
  } else if (command === 'message') {
    result = await postEvent(event('message', await readJSON(flags.positional[0])));
  } else if (command === 'recode') {
    const body = await readJSON(flags.positional[0]);
    result = await postEvent(event('recode.declare', { recode_id: body.recode_id || randomUUID(), ...body }));
  } else if (command === 'recode-join') {
    result = await postEvent(event('recode.join', { recode_id: flags.positional[0], position: flags.positional.slice(1).join(' ') || null }));
  } else if (command === 'recode-event') {
    result = await postEvent(event('recode.event', await readJSON(flags.positional[0])));
  } else if (command === 'recode-terminate') {
    result = await postEvent(event('recode.terminate', await readJSON(flags.positional[0])));
  } else if (command === 'handoff') {
    const body = await readJSON(flags.positional[0]);
    const agentId = clean(process.env.REMOTE_PRINCIPAL);
    result = await postEvent(event('session.handoff', {
      agent_id: body.agent_id || agentId,
      session_id: body.session_id || clean(process.env.WEAVE_SESSION_ID) || `${agentId}:${process.pid}`,
      ...body
    }));
  } else if (command === 'lost') {
    result = await postEvent(event('session.lost', await readJSON(flags.positional[0])));
  } else if (command === 'recover') {
    result = await postEvent(event('session.recover', await readJSON(flags.positional[0])));
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`weave-client: ${error.message}`);
  process.exit(1);
}
