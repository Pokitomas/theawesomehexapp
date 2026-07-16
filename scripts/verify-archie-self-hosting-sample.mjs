#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]));
}

function digest(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex');
}

function argumentsMap(argv) {
  const output = new Map();
  for (let index = 0; index < argv.length; index += 2) output.set(argv[index], argv[index + 1]);
  return output;
}

function safePrefix(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/$/, '');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some(part => !part || part === '..' || part === '.')) {
    throw new Error('Verifier root must be repository-relative.');
  }
  return normalized;
}

async function main(argv = process.argv.slice(2)) {
  const flags = argumentsMap(argv);
  const prefix = safePrefix(flags.get('--root'));
  const expected = String(flags.get('--expected-digest') || '').trim();
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error('Verifier requires a lowercase SHA-256 expected digest.');

  const files = {};
  for (const name of ['app.js', 'index.html', 'state.json']) {
    files[name] = await fs.readFile(path.resolve(prefix, name), 'utf8');
  }
  const html = files['index.html'];
  const javascript = files['app.js'];
  const state = JSON.parse(files['state.json']);

  if (!/<main id="archie-app">/.test(html)) throw new Error('Missing main#archie-app.');
  if (!/<button id="run"[^>]*aria-label="Run deterministic Archie sample"/.test(html)) throw new Error('Run button lacks its exact accessible label.');
  if (!/<p id="status" aria-live="polite">/.test(html)) throw new Error('Status output is not aria-live polite.');
  if (!/<output id="count" aria-label="Completed runs">0<\/output>/.test(html)) throw new Error('Completed-run output is missing.');
  if (!/button\.addEventListener\('click'/.test(javascript)) throw new Error('Run button has no click behavior.');
  if (!/completed \+= 1/.test(javascript)) throw new Error('Run behavior does not increment deterministic state.');
  if (state?.schema !== 'sideways-archie-app-state/v1') throw new Error('State schema mismatch.');
  if (!Number.isSafeInteger(state.seed) || state.seed < 0) throw new Error('State seed is invalid.');
  if (typeof state.scenario_id !== 'string' || !state.scenario_id) throw new Error('State scenario ID is missing.');

  const observed = digest({ target_prefix: prefix, files });
  if (observed !== expected) throw new Error(`Self-hosting artifact digest mismatch: expected ${expected}, observed ${observed}.`);
  process.stdout.write(`${JSON.stringify({
    schema: 'sideways-archie-self-hosting-verification/v1',
    target_prefix: prefix,
    expected_digest: expected,
    observed_digest: observed,
    file_digests: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, digest(content)]).sort(([left], [right]) => left.localeCompare(right))),
    accessibility: {
      main_landmark: true,
      button_label: true,
      polite_status: true,
      visible_counter: true
    }
  })}\n`);
}

main().catch(error => {
  process.stderr.write(`archie-self-hosting-verifier: ${error?.stack || error}\n`);
  process.exitCode = 1;
});
