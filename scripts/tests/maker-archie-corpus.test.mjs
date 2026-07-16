import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createArchieLinuxCorpus } from '../maker-archie-corpus.mjs';
import { attachArchieCorpus } from '../maker-archie-loop.mjs';

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'archie-corpus-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('stores one immutable text-first task trace, deduplicates it, retrieves it, and emits a distillation example', async t => {
  const root = await tempRoot(t);
  const corpus = createArchieLinuxCorpus({ root, clock: () => '2026-07-16T02:00:00.000Z' });
  const event = {
    kind: 'task_trace',
    subject: 'Pokitomas/theawesomehexapp',
    input: {
      text: 'Repair the Linux corpus backend and keep deployment forbidden.',
      context: { authorization: 'Bearer secret-secret-secret-secret', modality: 'text' }
    },
    output: {
      text: 'Implemented the append-only corpus and verified retrieval.',
      plan: { steps: ['ingest', 'deduplicate', 'retrieve', 'distill'] }
    },
    tool_trace: [{ tool: 'git', action: 'commit', input: { token: 'github_pat_123456789012345678901234567890' }, output: { sha: 'abc' }, ok: true }],
    outcome: 'completed',
    source: { system: 'test', run_id: 'run-1', teacher: 'frontier-teacher', cost_usd: 0.12 },
    artifacts: [{ name: 'result.png', media_type: 'image/png', digest: 'sha256:abc', bytes: 100 }]
  };

  const stored = await corpus.ingest(event);
  const repeated = await corpus.ingest(event);
  assert.equal(stored.status, 'stored');
  assert.equal(repeated.status, 'deduplicated');
  assert.equal(repeated.record_id, stored.record_id);

  const matches = await corpus.query('linux corpus retrieval');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].record.input.context.authorization, '[redacted]');
  assert.equal(matches[0].record.tool_trace[0].input.token, '[redacted]');
  assert.equal(matches[0].record.artifact_refs[0].media_type, 'image/png');
  assert.ok(!JSON.stringify(matches[0]).includes('github_pat_'));
  assert.ok(!JSON.stringify(matches[0]).includes('Bearer secret'));

  const examples = await corpus.examples();
  assert.equal(examples.length, 1);
  assert.equal(examples[0].instruction, event.input.text);
  assert.deepEqual(examples[0].target, event.output.plan);

  const stats = await corpus.stats();
  assert.deepEqual({ records: stats.records, examples: stats.examples, events: stats.events }, { records: 1, examples: 1, events: 2 });
});

test('converts a completed Maker receipt into owned teacher data without storing multimodal bytes', async t => {
  const root = await tempRoot(t);
  const corpus = createArchieLinuxCorpus({ root, clock: () => '2026-07-16T02:01:00.000Z' });
  const receipt = {
    schema: 'sideways-maker-runtime-platform-receipt/v1',
    platform_run_id: 'platform-1',
    state: 'completed',
    task: {
      repository: 'Pokitomas/theawesomehexapp',
      request: 'Build one strange personal model learning loop.',
      mode: 'build',
      protect: 'Do not deploy.'
    },
    components: {
      model_route: {
        receipt_digest: 'route-digest',
        provider: { id: 'teacher-a', display_name: 'Teacher A' },
        output: { plan: ['store trace', 'distill target'] },
        attempts: [{ provider_id: 'teacher-a', status: 'completed', duration_ms: 10 }],
        usage: { cost_usd: 0.4 }
      },
      fleet_placement: { worker_id: 'linux-box' },
      dispatch: {
        ok: true,
        adapter: 'self_hosted',
        output: { result: { branch: 'agent/archie', pull_request: 'https://github.com/Pokitomas/theawesomehexapp/pull/999' } }
      },
      control_job: {
        result: { branch: 'agent/archie', pull_request: 'https://github.com/Pokitomas/theawesomehexapp/pull/999' }
      }
    }
  };

  const stored = await corpus.recordMakerRun(receipt);
  assert.equal(stored.status, 'stored');
  const matches = await corpus.query('personal model learning');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].record.source.teacher, 'Teacher A');
  assert.equal(matches[0].record.source.cost_usd, 0.4);
  assert.equal(matches[0].record.artifact_refs.length, 2);
  assert.equal(matches[0].record.artifact_refs.some(item => item.media_type === 'image/png'), false);
  assert.equal((await corpus.examples()).length, 1);
});

test('wraps an existing runtime so every terminal result is written to the Linux corpus', async t => {
  const root = await tempRoot(t);
  const corpus = createArchieLinuxCorpus({ root, clock: () => '2026-07-16T02:02:00.000Z' });
  const runtime = {
    async run(input) {
      return {
        schema: 'sideways-maker-runtime-platform-receipt/v1',
        platform_run_id: 'platform-wrapped',
        state: 'completed',
        task: input.control_request,
        components: {
          model_route: {
            receipt_digest: 'route-wrapped',
            provider: { id: 'teacher-wrapped', display_name: 'Wrapped Teacher' },
            output: { plan: 'emit compact latent work plan' },
            attempts: [],
            usage: { cost_usd: 0.05 }
          },
          dispatch: { ok: true, adapter: 'linux', output: { result: { summary: 'done' } } },
          control_job: { result: { summary: 'done' } }
        }
      };
    }
  };
  const wrapped = attachArchieCorpus(runtime, corpus, { required: true });
  const receipt = await wrapped.run({ control_request: { repository: 'acme/app', request: 'Teach the small model to recover from tool failure.' } });
  assert.equal(receipt.state, 'completed');
  assert.equal(receipt.archie.status, 'stored');
  assert.equal((await corpus.query('recover tool failure')).length, 1);
});

test('persists explicit negative lessons for planner suppression without treating ordinary failures as training data', async t => {
  const root = await tempRoot(t);
  const corpus = createArchieLinuxCorpus({ root, clock: () => '2026-07-16T02:03:00.000Z' });
  await corpus.ingest({
    input: { text: 'Bypass review and deploy production immediately.' },
    output: { text: 'No deployment authority.', plan: null },
    outcome: 'rejected',
    tags: ['negative', 'suppress']
  });
  await corpus.ingest({
    input: { text: 'A transient worker crashed before producing evidence.' },
    output: { text: 'worker unavailable', plan: null },
    outcome: 'failed',
    tags: ['runtime-failure']
  });
  const examples = await corpus.examples();
  assert.equal(examples.length, 1);
  assert.equal(examples[0].negative, true);
  assert.equal(examples[0].outcome, 'rejected');
  assert.match(examples[0].reason, /authority/);
  assert.deepEqual(examples[0].tool_trace, []);
});
