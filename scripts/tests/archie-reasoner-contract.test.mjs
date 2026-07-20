import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const lane = path.join(root, 'foundry', 'archie-reasoner');

function read(name) {
  return fs.readFileSync(path.join(lane, name), 'utf8');
}

test('archie reasoner lane contains executable full-scope training surfaces', () => {
  for (const name of [
    'LEASE.md',
    'README.md',
    'requirements.txt',
    'archie_reasoner.py',
    'train.py',
    'baseline.py',
    'infer.py',
  ]) {
    assert.equal(fs.existsSync(path.join(lane, name)), true, `${name} is missing`);
  }
});

test('training and inference code parse without importing optional ML dependencies', () => {
  const python = process.env.PYTHON || process.env.PYTHON3 || 'python3';
  const result = spawnSync(
    python,
    [
      '-m',
      'py_compile',
      path.join(lane, 'archie_reasoner.py'),
      path.join(lane, 'train.py'),
      path.join(lane, 'baseline.py'),
      path.join(lane, 'infer.py'),
    ],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('tokenizer and model preserve request, attachment, graph, plan, and padding contracts', () => {
  const core = read('archie_reasoner.py');
  for (const token of [
    '<REQUEST>',
    '<ATTACHMENT>',
    '<MEMORY>',
    '<THREAD>',
    '<TASK_GRAPH>',
    '</TASK_GRAPH>',
    '<PLAN>',
    '</PLAN>',
    '<CLARIFY>',
  ]) {
    assert.match(core, new RegExp(token.replace(/[<>/]/g, '\\$&')));
  }
  assert.match(core, /pack_padded_sequence/);
  assert.match(core, /target\.masked_fill\(target_padding\.unsqueeze\(-1\), 0\.0\)/);
  assert.match(core, /scores\.masked_fill\(source_padding\.unsqueeze\(1\)/);
  assert.match(core, /self\.decoder = nn\.GRU/);
  assert.match(core, /self\.lm_head\.weight = self\.token_embedding\.weight/);
});

test('full trainer implements AdamW, cosine decay, calibration, resume, and candidate sweeps', () => {
  const trainer = read('train.py');
  assert.match(trainer, /torch\.optim\.AdamW/);
  assert.match(trainer, /math\.cos/);
  assert.match(trainer, /fit_temperature/);
  assert.match(trainer, /--resume/);
  assert.match(trainer, /--sweep/);
  assert.match(trainer, /PRESETS/);
  assert.match(trainer, /best\.pt/);
  assert.match(trainer, /last\.pt/);
});

test('frozen prompts are removed before tokenizer fitting and model fitting', () => {
  const trainer = read('train.py');
  const filterIndex = trainer.indexOf('filter_frozen_rows');
  const tokenizerIndex = trainer.indexOf('train_sentencepiece(train_rows');
  const loaderIndex = trainer.indexOf('train_loader = loader_for');
  assert.ok(filterIndex >= 0);
  assert.ok(tokenizerIndex > filterIndex);
  assert.ok(loaderIndex > tokenizerIndex);
  assert.match(trainer, /removed_frozen_rows/);
  assert.match(trainer, /external_suites/);
});

test('authority denial, missing context, and invalid generation fail closed to clarify', () => {
  const core = read('archie_reasoner.py');
  assert.match(core, /if authority == "deny":\s+return clarify_output\("authority_denied"/s);
  assert.match(core, /if context != "ready":\s+return clarify_output\("context_missing"/s);
  assert.match(core, /if parsed is None:\s+return clarify_output\("invalid_generation"/s);
  assert.match(core, /route = "clarify" if forced_clarify else original_route/);
});


test('stdlib target construction preserves allow-versus-clarify-versus-deny semantics', () => {
  const python = process.env.PYTHON || process.env.PYTHON3 || 'python3';
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(lane)})
from archie_reasoner import target_objects, apply_fail_closed
graph, plan = target_objects({"prompt":"summarize it","route":"summary","authority":"allow","context_state":"ready"})
assert graph["route"] == "summary" and plan["must_clarify"] is False
graph, plan = target_objects({"prompt":"help with that","route":"clarify","authority":"allow"})
assert graph["authority"] == "allow" and graph["context"] == "missing" and graph["route"] == "clarify"
graph, plan = target_objects({"prompt":"do it","route":"plan","authority":"deny"})
assert graph["authority"] == "deny" and graph["route"] == "clarify" and plan["must_clarify"] is True
guarded = apply_fail_closed("garbage", 0, 0)
assert guarded["graph"]["route"] == "clarify" and guarded["decision_source"] == "fail_closed_gate"
`;
  const result = spawnSync(python, ['-c', script], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('baseline is the planned word plus character TF-IDF logistic classifier', () => {
  const baseline = read('baseline.py');
  assert.match(baseline, /TfidfVectorizer/);
  assert.match(baseline, /analyzer="word"/);
  assert.match(baseline, /analyzer="char_wb"/);
  assert.match(baseline, /LogisticRegression/);
  assert.match(baseline, /max-features.*16000/);
});

test('lane has no runtime network client or pretrained-model loading path', () => {
  const combined = [
    read('archie_reasoner.py'),
    read('train.py'),
    read('baseline.py'),
    read('infer.py'),
  ].join('\n');
  for (const forbidden of [
    /requests\./,
    /urllib\.request/,
    /httpx/,
    /aiohttp/,
    /from_pretrained/,
    /snapshot_download/,
    /hf_hub_download/,
    /openai/i,
    /anthropic/i,
  ]) {
    assert.doesNotMatch(combined, forbidden);
  }
});

test('all receipts and documentation preserve the non-admitted boundary', () => {
  for (const name of ['README.md', 'archie_reasoner.py', 'train.py', 'baseline.py', 'infer.py']) {
    assert.match(read(name), /not-admitted/);
  }
  const architecture = fs.readFileSync(path.join(root, 'docs', 'archie-reasoner.md'), 'utf8');
  assert.match(architecture, /separately authored untouched\s+admission pack/);
});
