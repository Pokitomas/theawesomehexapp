import { appendFile } from 'node:fs/promises';

const VALID = new Set(['proceed', 'pause', 'stop', 'superseded', 'terminal']);

export function decideRemoteState(remoteState = {}, expectedHead = '') {
  if (remoteState.terminal || remoteState.decision === 'terminal') return 'terminal';
  if (expectedHead && remoteState.head_sha && remoteState.head_sha !== expectedHead) return 'superseded';
  if (VALID.has(remoteState.decision)) return remoteState.decision;
  return 'proceed';
}

async function emit(name, value) {
  process.stdout.write(`${name}=${value}\n`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

export async function runRemoteGate(env = process.env, fetchImpl = fetch) {
  const base = String(env.REMOTE_URL || '').replace(/\/$/, '');
  const session = String(env.REMOTE_SESSION || '');
  const generation = String(env.REMOTE_GENERATION || '');
  const expectedHead = String(env.EXPECTED_HEAD || env.GITHUB_SHA || '');
  const required = String(env.REMOTE_REQUIRED || '') === '1';

  if (!base || !session) {
    await emit('decision', 'proceed');
    await emit('remote_configured', 'false');
    return { decision: 'proceed', configured: false };
  }

  const url = new URL(`${base}/api/remote/state`);
  url.searchParams.set('session', session);
  url.searchParams.set('public', '1');
  if (generation) url.searchParams.set('generation', generation);

  try {
    const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`remote returned ${response.status}`);
    const payload = await response.json();
    const state = payload.state || {};
    const decision = decideRemoteState(state, expectedHead);
    await emit('decision', decision);
    await emit('remote_configured', 'true');
    await emit('remote_generation', String(state.generation || ''));
    await emit('remote_head', String(state.head_sha || ''));
    return { decision, configured: true, state };
  } catch (error) {
    process.stderr.write(`remote gate unavailable: ${error.message}\n`);
    const decision = required ? 'stop' : 'proceed';
    await emit('decision', decision);
    await emit('remote_configured', 'true');
    await emit('remote_error', JSON.stringify(error.message));
    if (required) process.exitCode = 1;
    return { decision, configured: true, error };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await runRemoteGate();
