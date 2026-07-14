#!/usr/bin/env node
import fs from 'node:fs';

const clean = value => String(value ?? '').trim();
const allowed = new Set(['proceed', 'pause', 'stop', 'superseded', 'terminal']);

function writeOutput(name, value) {
  console.log(`${name}=${value}`);
  const target = process.env.GITHUB_OUTPUT;
  if (target) fs.appendFileSync(target, `${name}=${value}\n`);
}

async function main() {
  const base = clean(process.env.REMOTE_URL);
  const session = clean(process.env.REMOTE_SESSION);
  if (!base || !session) {
    writeOutput('decision', 'proceed');
    writeOutput('reason', 'remote-not-configured');
    writeOutput('session', session || '');
    return;
  }
  const url = new URL(base.includes('/api/remote') ? base : `${base.replace(/\/$/, '')}/api/remote/state`);
  url.pathname = '/api/remote/state';
  url.searchParams.set('session', session);
  url.searchParams.set('public', '1');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.REMOTE_GATE_TIMEOUT_MS || 5000));
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) throw new Error(`remote returned ${response.status}`);
    const data = await response.json();
    const state = data.state || {};
    const decision = state.terminal ? 'terminal' : (allowed.has(state.decision) ? state.decision : 'proceed');
    writeOutput('decision', decision);
    writeOutput('reason', state.summary || 'remote-state');
    writeOutput('session', state.session || session);
    writeOutput('generation', String(state.generation || 1));
    writeOutput('head_sha', state.head_sha || '');
  } catch (error) {
    const failClosed = process.env.REMOTE_GATE_FAIL_CLOSED === '1';
    writeOutput('decision', failClosed ? 'stop' : 'proceed');
    writeOutput('reason', failClosed ? `remote-unavailable:${error.message}` : `remote-unavailable-proceeding:${error.message}`);
    writeOutput('session', session);
  } finally {
    clearTimeout(timer);
  }
}

await main();
