import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createOpenModelClient, createOpenModelRoleAdapter, parseModelJSON } from '../open-model-adapter.mjs';
import { makerPlanningSeed, runOpenModelPlanning } from '../open-model-planning.mjs';
import { normalizeAgentBudget, resolveWorkspacePath, runNativeDevAgent } from '../native-dev-agent.mjs';
import { branchFor, nativeEpisodePath, normalizeWorkerConfig, parseMakerIssue } from '../maker-native-worker.mjs';

const execFileAsync = promisify(execFile);

async function fixtureRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sideways-native-worker-'));
  await execFileAsync('git', ['init'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'Test Worker'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'worker@example.test'], { cwd: root });
  await fs.writeFile(path.join(root, 'README.md'), '# Fixture\n', 'utf8');
  await fs.mkdir(path.join(root, 'src'));
  await execFileAsync('git', ['add', '--all'], { cwd: root });
  await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: root });
  return root;
}

function sequenceClient(actions) {
  let index = 0;
  return {
    async complete() {
      const value = actions[Math.min(index, actions.length - 1)];
      index += 1;
      return { text: typeof value === 'string' ? value : JSON.stringify(value) };
    }
  };
}

test('open model adapter supports OpenAI-compatible JSON without a vendor SDK', async () => {
  const calls = [];
  const client = createOpenModelClient({
    base_url: 'https://models.example.test',
    model: 'open-coder',
    protocol: 'openai',
    api_key: 'manual-test-key',
    retries: 0,
    fetch_impl: async (url, options) => {
      calls.push({ url: url.toString(), options, body: JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"events":[]}' } }] }) };
    }
  });
  const response = await client.complete([{ role: 'user', content: 'test' }]);
  assert.equal(response.text, '{"events":[]}');
  assert.equal(calls[0].url, 'https://models.example.test/v1/chat/completions');
  assert.equal(calls[0].body.model, 'open-coder');
  assert.equal(calls[0].body.response_format.type, 'json_object');
  assert.equal(calls[0].options.headers.authorization, 'Bearer manual-test-key');
});

test('open model adapter supports local Ollama-native JSON with no auth', async () => {
  const calls = [];
  const client = createOpenModelClient({
    base_url: 'http://127.0.0.1:11434',
    model: 'qwen-local',
    protocol: 'ollama',
    retries: 0,
    fetch_impl: async (url, options) => {
      calls.push({ url: url.toString(), options, body: JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => ({ message: { content: '{"events":[]}' } }) };
    }
  });
  await client.complete([{ role: 'user', content: 'test' }]);
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(calls[0].body.stream, false);
  assert.equal(calls[0].body.format, 'json');
  assert.equal(calls[0].options.headers.authorization, undefined);
});

test('role adapter admits only an events array', async () => {
  const adapter = createOpenModelRoleAdapter({ complete: async () => ({ text: '```json\n{"events":[{"kind":"claim"}]}\n```' }) }, { id: 'local:test' });
  assert.deepEqual(await adapter.execute({ assignment_event_id: 'assignment:1' }), [{ kind: 'claim' }]);
  await assert.rejects(
    createOpenModelRoleAdapter({ complete: async () => ({ text: '{"answer":1}' }) }).execute({}),
    /events array/
  );
  assert.deepEqual(parseModelJSON('[1,2]'), [1, 2]);
});

test('recursive open-model planning fans one Maker command across typed roles', async () => {
  let calls = 0;
  const client = {
    async complete(messages) {
      calls += 1;
      const packet = JSON.parse(messages.at(-1).content);
      const target = packet.assignment.target_ids[0];
      const role = packet.assignment.role;
      return {
        text: JSON.stringify({
          events: [{
            id: `uncertainty:${role}:${calls}`,
            kind: 'uncertainty',
            source_event_ids: [target],
            body: {
              target_id: target,
              confidence: 0.4,
              statement: `${role} requires repository evidence before admission.`
            }
          }]
        })
      };
    }
  };
  const intent = { request: 'Build the native issue worker.', protect: 'No merge authority.', proof: 'Draft PR and tests.' };
  const seed = makerPlanningSeed(intent, () => '2026-07-15T06:00:00.000Z');
  assert.equal(seed.length, 2);
  assert.equal(seed[0].kind, 'goal');
  assert.equal(seed[1].kind, 'question');
  const result = await runOpenModelPlanning({
    intent,
    model_client: client,
    max_waves: 1,
    max_events: 96,
    max_assignments_per_wave: 4,
    now: () => '2026-07-15T06:00:00.000Z'
  });
  assert.ok(calls >= 2);
  assert.equal(result.terminal, 'budget_exhausted');
  assert.ok(result.brief.event_count > seed.length);
  assert.ok(result.brief.outputs.some(event => event.kind === 'uncertainty'));
  assert.ok(result.brief.outputs.some(event => event.kind === 'synthesis'));
  assert.ok(result.brief.outputs.some(event => event.kind === 'critique'));
});

test('Maker issue parser uses the typed phone receipt and preserves human authority', () => {
  const receipt = {
    version: 'sideways-maker/v1',
    repository: 'Pokitomas/theawesomehexapp',
    mode: 'fix',
    request: 'Repair the issue trigger.',
    protect: 'Do not merge.',
    proof: 'Show a draft PR.',
    device_requirement: 'phone-first'
  };
  const intent = parseMakerIssue({
    title: '[maker:fix] Repair trigger',
    body: `## Machine receipt\n\n\`\`\`json\n${JSON.stringify(receipt)}\n\`\`\``
  }, 'Pokitomas/theawesomehexapp');
  assert.equal(intent.request, receipt.request);
  assert.equal(intent.mode, 'fix');
  assert.equal(intent.authority.human_merge_required, true);
  assert.equal(intent.authority.human_deploy_required, true);
  assert.throws(() => parseMakerIssue({ title: 'ordinary issue', body: '' }, 'Pokitomas/theawesomehexapp'), /not a Maker command/);
});

test('worker config names missing manual runtime values exactly', () => {
  const missing = normalizeWorkerConfig({});
  assert.deepEqual(missing.missing, ['SIDEWAYS_MODEL_BASE_URL', 'SIDEWAYS_MODEL_NAME']);
  assert.equal(missing.planning_enabled, true);
  assert.equal(missing.default_branch, 'main');
  const local = normalizeWorkerConfig({
    SIDEWAYS_MODEL_BASE_URL: 'http://127.0.0.1:11434',
    SIDEWAYS_MODEL_NAME: 'qwen',
    SIDEWAYS_MODEL_PROTOCOL: 'ollama',
    SIDEWAYS_DEFAULT_BRANCH: 'trunk',
    SIDEWAYS_PLANNING_ENABLED: '0'
  });
  assert.deepEqual(local.missing, []);
  assert.equal(local.protocol, 'ollama');
  assert.equal(local.default_branch, 'trunk');
  assert.equal(local.planning_enabled, false);
});

test('reruns receive separate branches and episode artifacts stay outside the checkout', () => {
  assert.equal(branchFor(221, '999', '1'), 'maker/issue-221-999-1');
  assert.equal(branchFor(221, '999', '2'), 'maker/issue-221-999-2');
  assert.notEqual(branchFor(221, '999', '1'), branchFor(221, '999', '2'));
  assert.equal(nativeEpisodePath({ RUNNER_TEMP: '/tmp/runner' }), path.join('/tmp/runner', 'sideways-native-episode.json'));
});

test('native dev agent reads, writes, witnesses, inspects, and finishes in one checkout', async t => {
  const root = await fixtureRepo();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const client = sequenceClient([
    { tool: 'read', path: 'README.md', start: 1, end: 20 },
    { tool: 'write', path: 'src/answer.mjs', content: 'export const answer = 42;\n' },
    { tool: 'run', witness: 'git-diff-check' },
    { tool: 'status' },
    { tool: 'finish', summary: 'Added one bounded module.', tests: ['do not trust this claim'], risks: [] }
  ]);
  const result = await runNativeDevAgent({
    root,
    intent: { request: 'Add answer module.' },
    model_client: client,
    budget: { max_turns: 8, max_writes: 2, max_total_write_bytes: 1000, max_model_tokens: 1000 }
  });
  assert.equal(result.status, 'finished');
  assert.deepEqual(result.tests, ['git-diff-check']);
  assert.deepEqual(result.claimed_tests, ['do not trust this claim']);
  assert.match(await fs.readFile(path.join(root, 'src/answer.mjs'), 'utf8'), /42/);
  assert.match(result.git_status, /src\/answer\.mjs/);
});

test('native dev agent rejects path escape, secrets, authority writes, and arbitrary witnesses', async t => {
  const root = await fixtureRepo();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.throws(() => resolveWorkspacePath(root, '../escape'), /repository-relative|Blocked/);
  assert.throws(() => resolveWorkspacePath(root, '.env'), /Secret-like/);
  const client = sequenceClient([
    { tool: 'write', path: '.github/workflows/pwn.yml', content: 'permissions: write-all\n' },
    { tool: 'write', path: '../escape.txt', content: 'nope' },
    { tool: 'run', witness: 'curl-the-network' },
    { tool: 'run', witness: 'git-diff-check' },
    { tool: 'status' },
    { tool: 'finish', summary: 'No unauthorized change.', tests: [], risks: [] }
  ]);
  const result = await runNativeDevAgent({
    root,
    intent: { request: 'Attempt hostile actions.' },
    model_client: client,
    budget: { max_turns: 10, max_writes: 4, max_total_write_bytes: 1000, max_model_tokens: 1000 }
  });
  assert.equal(result.status, 'finished');
  assert.match(result.transcript[0].observation.error, /authority surface/);
  assert.match(result.transcript[1].observation.error, /repository-relative|Blocked/);
  assert.match(result.transcript[2].observation.error, /not allowlisted/);
  await assert.rejects(fs.stat(path.join(root, '.github/workflows/pwn.yml')));
});

test('native dev agent recovers from malformed model JSON but enforces completion evidence', async t => {
  const root = await fixtureRepo();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const client = sequenceClient([
    'not json',
    { tool: 'finish', summary: 'premature', tests: [], risks: [] },
    { tool: 'run', witness: 'git-diff-check' },
    { tool: 'status' },
    { tool: 'finish', summary: 'Evidence complete.', tests: [], risks: [] }
  ]);
  const result = await runNativeDevAgent({
    root,
    intent: { request: 'No-op audit.' },
    model_client: client,
    budget: normalizeAgentBudget({ max_turns: 8, max_writes: 1, max_total_write_bytes: 100, max_model_tokens: 1000 })
  });
  assert.equal(result.status, 'finished');
  assert.match(result.transcript[0].observation.error, /valid JSON/);
  assert.match(result.transcript[1].observation.error, /inspect repository status first/);
});
