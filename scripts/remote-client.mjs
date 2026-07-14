import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { signRemoteRequest } from '../netlify/functions/remote-core.mjs';

function required(name, value) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function config(env = process.env) {
  return {
    base: required('REMOTE_URL', String(env.REMOTE_URL || '').replace(/\/$/, '')),
    session: required('REMOTE_SESSION', String(env.REMOTE_SESSION || '')),
    generation: env.REMOTE_GENERATION ? Number(env.REMOTE_GENERATION) : undefined,
    principal: String(env.REMOTE_PRINCIPAL || ''),
    keyId: String(env.REMOTE_KEY_ID || env.REMOTE_PRINCIPAL || ''),
    secret: String(env.REMOTE_KEY || '')
  };
}

function signedHeaders({ method, url, bodyText, principal, keyId, secret, now = new Date(), nonce = randomUUID() }) {
  required('REMOTE_PRINCIPAL', principal);
  required('REMOTE_KEY_ID', keyId);
  required('REMOTE_KEY', secret);
  const timestamp = now.toISOString();
  const signature = signRemoteRequest({ method, path: url.pathname, timestamp, nonce, bodyText, secret });
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    'x-remote-principal': principal,
    'x-remote-key-id': keyId,
    'x-remote-timestamp': timestamp,
    'x-remote-nonce': nonce,
    'x-remote-signature': signature
  };
}

async function parseInput(argument) {
  if (!argument || argument === '-') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  }
  if (argument.startsWith('@')) return JSON.parse(await readFile(argument.slice(1), 'utf8'));
  return JSON.parse(argument);
}

export async function remoteRequest(command, argument, env = process.env, fetchImpl = fetch) {
  const cfg = config(env);
  const publicRead = command === 'public-state';
  const stateRead = publicRead || command === 'state';
  const messageRead = command === 'messages';

  if (stateRead || messageRead) {
    const url = new URL(stateRead ? `${cfg.base}/api/remote/state` : `${cfg.base}/api/remote`);
    url.searchParams.set('session', cfg.session);
    if (cfg.generation) url.searchParams.set('generation', String(cfg.generation));
    if (publicRead) url.searchParams.set('public', '1');
    if (messageRead && argument) url.searchParams.set('after', argument);
    const headers = publicRead ? { accept: 'application/json' } : signedHeaders({ method: 'GET', url, bodyText: '', ...cfg });
    const response = await fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.timeout(10_000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `remote returned ${response.status}`);
    return data;
  }

  if (command !== 'post') throw new Error('usage: remote-client.mjs public-state | state | messages [cursor] | post <json|@file|->');
  const body = await parseInput(argument);
  if (!body.session) body.session = cfg.session;
  if (!body.generation && cfg.generation) body.generation = cfg.generation;
  const url = new URL(`${cfg.base}/api/remote`);
  const bodyText = JSON.stringify(body);
  const headers = signedHeaders({ method: 'POST', url, bodyText, ...cfg });
  const response = await fetchImpl(url, { method: 'POST', headers, body: bodyText, signal: AbortSignal.timeout(10_000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `remote returned ${response.status}`);
    error.details = data;
    throw error;
  }
  return data;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = await remoteRequest(process.argv[2], process.argv[3]);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    if (error.details) process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
    process.exitCode = 1;
  }
}
