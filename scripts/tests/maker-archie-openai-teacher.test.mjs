import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ARCHIE_OPENAI_TEACHER_RECEIPT_SCHEMA,
  createOpenAIArchieTeacher,
  isOpenAIArchieTeacherConfigured
} from '../maker-archie-openai-teacher.mjs';
import { repositoryEvidenceDigest } from '../maker-archie-repository-evidence.mjs';

const plan = {
  title: 'Integrate bounded Archie teacher',
  branch_slug: 'archie-teacher',
  selected_lane: 'operator',
  why_now: 'The default path needs a dense plan without redundant assessment agents.',
  owned_paths: ['scripts/maker-archie-native.mjs', 'scripts/maker-archie-openai-teacher.mjs'],
  implementation_prompt: 'Connect the strict teacher plan to Maker while preserving Maker as the only effect boundary.',
  focused_tests: ['node --test scripts/tests/maker-archie-openai-teacher.test.mjs'],
  deferred: []
};

function repositoryEvidence() {
  const body = {
    schema: 'archie-repository-evidence/v1',
    repository: 'theawesomehexapp',
    base_sha: 'a'.repeat(40),
    collection: 'exact-git-tree-package-and-ranked-source/v1',
    request_terms: ['archie', 'finish'],
    path_count: 3,
    included_path_count: 3,
    truncated: false,
    paths: [
      'scripts/maker-archie-native.mjs',
      'scripts/maker-archie-openai-teacher.mjs',
      'scripts/tests/maker-archie-openai-teacher.test.mjs'
    ],
    directories: ['scripts', 'scripts/tests'],
    package_scripts: {},
    package_dependencies: [],
    source_file_count: 1,
    captured_source_bytes: 34,
    source_limits: { max_files: 64, max_file_bytes: 24576, max_total_bytes: 393216 },
    source_files: [{
      path: 'scripts/maker-archie-native.mjs',
      blob_oid: 'b'.repeat(40),
      bytes: 34,
      captured_bytes: 34,
      truncated: false,
      content: 'export const nativeRuntime = true;',
      relevance_score: 100
    }],
    recent_commits: [{ sha: 'a'.repeat(40), message: 'fixture' }],
    limitations: ['fixture']
  };
  return { ...body, evidence_digest: repositoryEvidenceDigest(body) };
}

function task(instruction) {
  return {
    instruction,
    context: {
      repository: 'theawesomehexapp',
      base_branch: 'main',
      base_sha: 'a'.repeat(40),
      repository_evidence: repositoryEvidence()
    }
  };
}

function response(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
    async text() { return JSON.stringify(body); }
  };
}

test('teacher is configured only by a nontrivial API key and can be disabled explicitly', () => {
  assert.equal(isOpenAIArchieTeacherConfigured({}), false);
  assert.equal(isOpenAIArchieTeacherConfigured({ OPENAI_API_KEY: 'sk-test-abcdefghijklmnopqrstuvwxyz' }), true);
  assert.equal(isOpenAIArchieTeacherConfigured({ OPENAI_API_KEY: 'sk-test-abcdefghijklmnopqrstuvwxyz', ARCHIE_OPENAI_DISABLED: 'true' }), false);
});

test('one Responses API call returns a strict Maker plan and evidence receipt', async () => {
  let request;
  const teacher = createOpenAIArchieTeacher({
    env: { OPENAI_API_KEY: 'sk-test-abcdefghijklmnopqrstuvwxyz', ARCHIE_OPENAI_MODEL: 'gpt-5.1' },
    clock: () => '2026-07-17T20:00:00.000Z',
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return response({
        id: 'resp_fixture',
        status: 'completed',
        model: 'gpt-5.1-2025-11-13',
        output_text: JSON.stringify(plan),
        usage: { input_tokens: 100, output_tokens: 40, total_tokens: 140 }
      });
    }
  });
  const result = await teacher(task('Finish Archie without intermediary sprawl.'), { local_attempt: { state: 'escalate', confidence: 0.1, margin: 0.01 } });

  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.options.headers.authorization, 'Bearer sk-test-abcdefghijklmnopqrstuvwxyz');
  assert.equal(request.body.store, false);
  assert.equal(request.body.text.format.type, 'json_schema');
  assert.equal(request.body.text.format.strict, true);
  assert.equal(request.body.reasoning.effort, 'high');
  assert.equal(request.body.input[0].content[0].text.includes('nativeRuntime'), true);
  assert.deepEqual(result.plan, plan);
  assert.equal(result.receipt.schema, ARCHIE_OPENAI_TEACHER_RECEIPT_SCHEMA);
  assert.equal(result.receipt.response_id, 'resp_fixture');
  assert.equal(result.receipt.base_sha, 'a'.repeat(40));
  assert.equal(result.receipt.effect_authority, 'maker-only');
  assert.equal(result.receipt.repository_evidence_digest, repositoryEvidence().evidence_digest);
  assert.match(result.receipt.receipt_digest, /^[a-f0-9]{64}$/);
});

test('teacher rejects broad leases, invalid output, and API failures', async () => {
  const env = { OPENAI_API_KEY: 'sk-test-abcdefghijklmnopqrstuvwxyz' };
  const broad = createOpenAIArchieTeacher({ env, fetchImpl: async () => response({ id: 'x', status: 'completed', output_text: JSON.stringify({ ...plan, owned_paths: ['**'] }) }) });
  await assert.rejects(() => broad(task('broad')), /repository-wide/);

  const invalid = createOpenAIArchieTeacher({ env, fetchImpl: async () => response({ id: 'x', status: 'completed', output_text: '{nope' }) });
  await assert.rejects(() => invalid(task('invalid')), /invalid JSON/);

  const failed = createOpenAIArchieTeacher({ env, fetchImpl: async () => response({ error: { message: 'denied' } }, { status: 401 }) });
  await assert.rejects(() => failed(task('failed')), /HTTP 401/);
});
