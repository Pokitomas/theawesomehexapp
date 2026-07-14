#!/usr/bin/env node
import { createHash, createHmac, randomUUID, sign as signBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import process from 'node:process';

const clean = value => String(value ?? '').trim();
const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonical = ({ method, path, timestamp, nonce, body = '' }) => [method.toUpperCase(), path, timestamp, nonce, sha256(body)].join('\n');

function usage() {
  console.log(`Sideways universal remote client

Environment:
  REMOTE_URL          Site origin or /api/remote URL
  REMOTE_SESSION      Project-defined session
  REMOTE_PRINCIPAL    Opaque principal id
  REMOTE_KEY          HMAC secret (generic bootstrap/development credential)
  REMOTE_PRIVATE_KEY  Ed25519 private key PEM or @path/to/key.pem

Commands:
  state [--private]
  list [--after CURSOR] [--private]
  send '{"payload":{"action":"..."},"visibility":"public"}'
  claim SCOPE [TTL_SECONDS]
  release SCOPE
  pause [SUMMARY]
  resume [SUMMARY]
  stop [SUMMARY]
  set-head SHA [SUMMARY]
  propose FILE.json
  terminalize [SUMMARY]

The client never prints private key material.`);
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

async function authHeaders(method, url, body = '') {
  const principal = clean(process.env.REMOTE_PRINCIPAL);
  const hmacKey = clean(process.env.REMOTE_KEY);
  const key = await privateKey();
  if (!principal || (!hmacKey && !key)) throw new Error('REMOTE_PRINCIPAL and REMOTE_KEY or REMOTE_PRIVATE_KEY are required for authenticated commands.');
  const timestamp = new Date().toISOString();
  const nonce = randomUUID();
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
  const headers = authenticated ? await authHeaders(method, url, body) : { 'content-type': 'application/json' };
  const response = await fetch(url, { method, headers, ...(body ? { body } : {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${data.error || response.statusText}${data.detail ? `: ${JSON.stringify(data.detail)}` : ''}`);
  return data;
}

function envelope(payload = {}) {
  const principal = clean(process.env.REMOTE_PRINCIPAL);
  const session = clean(payload.session || process.env.REMOTE_SESSION);
  if (!session) throw new Error('REMOTE_SESSION is required.');
  return {
    id: clean(payload.id) || randomUUID(),
    session,
    generation: Number(payload.generation || process.env.REMOTE_GENERATION || 1),
    issuer: principal,
    parent: payload.parent || null,
    issued_at: new Date().toISOString(),
    expires_at: payload.expires_at || null,
    head_sha: payload.head_sha || process.env.GITHUB_SHA || null,
    scope: Array.isArray(payload.scope) ? payload.scope : [],
    payload: payload.payload && typeof payload.payload === 'object' ? payload.payload : {},
    visibility: payload.visibility === 'public' ? 'public' : 'private'
  };
}

async function post(control, payload = {}) {
  const url = baseURL();
  const principal = clean(process.env.REMOTE_PRINCIPAL);
  const message = envelope(payload);
  const timestamp = new Date().toISOString();
  const nonce = randomUUID();
  message.issued_at = timestamp;
  message.nonce = nonce;
  const body = JSON.stringify({ message, ...(control ? { control } : {}) });
  const path = `${url.pathname}${url.search}`;
  const material = canonical({ method: 'POST', path, timestamp, nonce, body });
  const hmacKey = clean(process.env.REMOTE_KEY);
  const key = await privateKey();
  if (!principal || (!hmacKey && !key)) throw new Error('REMOTE_PRINCIPAL and REMOTE_KEY or REMOTE_PRIVATE_KEY are required.');
  const signature = hmacKey
    ? createHmac('sha256', hmacKey).update(material).digest('hex')
    : signBytes(null, Buffer.from(material), key).toString('base64');
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-remote-principal': principal,
      'x-remote-timestamp': timestamp,
      'x-remote-nonce': nonce,
      'x-remote-signature': signature,
      'x-remote-path': path
    },
    body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${data.error || response.statusText}${data.detail ? `: ${JSON.stringify(data.detail)}` : ''}`);
  return data;
}

function parseFlags(args) {
  const result = { positional: [] };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--private') result.private = true;
    else if (args[i] === '--after') result.after = args[++i] || '';
    else result.positional.push(args[i]);
  }
  return result;
}

const [command = 'help', ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);

try {
  let result;
  if (command === 'help' || command === '--help' || command === '-h') {
    usage();
    process.exit(0);
  } else if (command === 'state' || command === 'list') {
    const url = baseURL();
    url.pathname = command === 'state' ? '/api/remote/state' : '/api/remote';
    url.searchParams.set('session', clean(process.env.REMOTE_SESSION));
    if (!flags.private) url.searchParams.set('public', '1');
    if (flags.after) url.searchParams.set('after', flags.after);
    result = await request('GET', url, undefined, Boolean(flags.private));
  } else if (command === 'send') {
    const raw = flags.positional.join(' ') || '{}';
    result = await post(null, JSON.parse(raw));
  } else if (command === 'claim') {
    result = await post({ op: 'claim', scope: flags.positional[0], ttl_seconds: Number(flags.positional[1] || 1200) }, { payload: { summary: `Claimed ${flags.positional[0]}` }, visibility: 'public', scope: [flags.positional[0]] });
  } else if (command === 'release') {
    result = await post({ op: 'release', scope: flags.positional[0] }, { payload: { summary: `Released ${flags.positional[0]}` }, visibility: 'public', scope: [flags.positional[0]] });
  } else if (['pause', 'resume', 'stop'].includes(command)) {
    const summary = flags.positional.join(' ') || `${command[0].toUpperCase()}${command.slice(1)} requested.`;
    result = await post({ op: command }, { payload: { summary, action: command }, visibility: 'public' });
  } else if (command === 'set-head') {
    const [head, ...words] = flags.positional;
    result = await post({ op: 'set-head', head_sha: head }, { head_sha: head, payload: { summary: words.join(' ') || `Working head ${head}` }, visibility: 'public', scope: ['repo:head'] });
  } else if (command === 'propose') {
    const file = flags.positional[0];
    if (!file) throw new Error('propose requires an evidence JSON file.');
    const evidence = JSON.parse(await fs.readFile(file, 'utf8'));
    result = await post({ op: 'propose-terminal', evidence }, { head_sha: evidence.head_sha, payload: { summary: 'Exact-head completion proposed.', evidence }, visibility: 'public' });
  } else if (command === 'terminalize') {
    result = await post({ op: 'terminalize' }, { payload: { summary: flags.positional.join(' ') || 'Session terminalized.' }, visibility: 'public' });
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`remote-client: ${error.message}`);
  process.exit(1);
}
