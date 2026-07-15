import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { HTML_MARKER, PROMISE, ROOT_CSS, ROOT_JS, applyRootCompletion } = require('../root-product-completion.cjs');
const root = new URL('../../', import.meta.url);
const read = relative => readFile(new URL(relative, root), 'utf8');
const audit = JSON.parse(await read('audit/product-journey.json'));
const byId = new Map(audit.surfaces.map(surface => [surface.id, surface]));

const trackedEvidence = relative => relative === 'src/app.js' ? 'scripts/root-product-completion.cjs' : relative;

test('product audit defines one ordinary promise and exactly two default entry surfaces', () => {
  assert.equal(audit.schema, 'sideways-product-journey-audit/v1');
  assert.equal(audit.primary_promise, PROMISE);
  assert.match(audit.primary_promise, /public world/i);
  assert.match(audit.primary_promise, /private archive that belongs to you/i);
  assert.doesNotMatch(audit.primary_promise, /Founder Room|\bMaker\b|protocol|debug/i);
  assert.deepEqual([...byId.keys()].sort(), ['founder-room', 'live', 'maker', 'private-archive', 'root-reader']);
  assert.equal(byId.get('root-reader').default_user_path, true);
  assert.equal(byId.get('private-archive').default_user_path, true);
  assert.equal(byId.get('founder-room').default_user_path, false);
  assert.equal(byId.get('maker').default_user_path, false);
  assert.equal(audit.surfaces.filter(surface => surface.default_user_path).length, 2);
});

test('normal product journey has no code-local partial state and every evidence path resolves', async () => {
  const named = new Set();
  for (const step of audit.journey) {
    assert.ok(byId.has(step.surface), `unknown surface ${step.surface}`);
    assert.ok(['implemented', 'advanced'].includes(step.state), `unfinished step ${step.step}: ${step.state}`);
    if (step.state === 'implemented') assert.equal(step.gap, null);
    if (step.state === 'advanced') assert.ok(step.gap);
    for (const relative of step.evidence) {
      named.add(relative);
      await assert.doesNotReject(read(trackedEvidence(relative)), `missing evidence ${relative}`);
    }
  }
  assert.ok(named.size >= 12);
  assert.equal(audit.journey.find(step => step.step === 1).state, 'implemented');
  assert.equal(audit.journey.find(step => step.step === 4).state, 'implemented');
  assert.equal(audit.journey.find(step => step.step === 5).state, 'implemented');
  assert.match(audit.offline_contract, /require no shared mutation/i);
});

test('root completion installs a direct archive action and ordinary fail-honest explanations idempotently', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sideways-root-completion-'));
  try {
    await writeFile(path.join(directory, 'index.html'), '<!doctype html><html><head><title>Root</title></head><body><main><article class="post"><h2>Candidate</h2></article></main></body></html>');
    const first = applyRootCompletion({ outputDir: directory });
    const second = applyRootCompletion({ outputDir: directory });
    assert.deepEqual(first.assets, second.assets);
    const html = await readFile(path.join(directory, 'index.html'), 'utf8');
    assert.equal(html.split(HTML_MARKER).length - 1, 2);
    assert.match(html, /root-product-completion\.css/);
    assert.match(html, /root-product-completion\.js/);
    assert.equal(await readFile(path.join(directory, 'root-product-completion.js'), 'utf8'), ROOT_JS.trimStart());
    assert.equal(await readFile(path.join(directory, 'root-product-completion.css'), 'utf8'), ROOT_CSS.trimStart());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  assert.match(ROOT_JS, /href = '\.\/manual\/'/);
  assert.match(ROOT_JS, /Open your private archive/);
  for (const term of ['Source eligibility', 'Score contributions', 'Saturation and diversity', 'Why it is present']) assert.match(ROOT_JS, new RegExp(term));
  assert.match(ROOT_JS, /does not read your private archive/i);
  assert.match(ROOT_JS, /grants no publishing or moderation authority/i);
  assert.doesNotMatch(ROOT_JS, /\bfetch\s*\(|localStorage\.|sessionStorage\./);
  assert.doesNotMatch(ROOT_JS, /Founder Room|\bMaker\b|protocol vocabulary|debug concepts/i);
  assert.match(ROOT_CSS, /min-height:44px/);
  assert.match(ROOT_CSS, /prefers-reduced-motion:reduce/);
});

test('real root build verifier applies the completion layer and runs phone and desktop proof', async () => {
  const verifier = await read('verify-profile-build.py');
  assert.match(verifier, /scripts\/root-product-completion\.cjs/);
  assert.match(verifier, /scripts\/root-product-phone\.mjs/);
  assert.match(verifier, /390x844/);
  assert.match(verifier, /200%/);
  assert.match(verifier, /400%/);
  assert.match(verifier, /reduced-motion/);
  assert.match(verifier, /offline/);
});

test('internal surfaces remain separately inspectable and outside default consumer copy', async () => {
  const founder = await read('founder/index.html');
  const maker = await read('maker/index.html');
  assert.match(founder, /FOUNDER ROOM/);
  assert.match(maker, /Maker/i);
  assert.match(audit.release_rule, /outside the normal user path/i);
});
