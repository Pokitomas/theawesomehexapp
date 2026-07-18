import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { doctor, attestTeacher, importTeacher, initializeWorkspace, loadProfile, sha256, teach } from '../archie-distill-core.mjs';
import { formatTeachProgress } from '../archie-distill.mjs';

const profilePath = path.resolve('maker/evaluations/archie-distill-qwen3-quality.json');
async function temp() { return fs.mkdtemp(path.join(os.tmpdir(), 'archie-distill-')); }
async function fixtureProfile(workspace) {
  const profile = await loadProfile(profilePath);
  profile.teacher.sha256 = sha256('fixture');
  const localProfile = path.join(workspace, 'local-profile.json');
  await fs.writeFile(localProfile, JSON.stringify(profile));
  return { profile, localProfile };
}

async function readyWorkspace() {
  const workspace = await temp();
  await initializeWorkspace({ profilePath, workspace });
  const { profile, localProfile } = await fixtureProfile(workspace);
  const model = path.join(workspace, 'models', 'teacher', profile.teacher.filename);
  await fs.writeFile(model, 'fixture');
  const runner = path.join(workspace, 'runner');
  await fs.writeFile(runner, 'fixture');
  return { workspace, profile, localProfile, runner };
}

test('quality profile pins exact inputs and an honest claim boundary', async () => {
  const profile = await loadProfile(profilePath);
  assert.match(profile.teacher.revision, /^[a-f0-9]{40}$/);
  assert.match(profile.student.revision, /^[a-f0-9]{40}$/);
  assert.equal(profile.teacher.sha256, '500a8806e85ee9c83f3ae08420295592451379b4f8cf2d0f41c15dffeb6b81f0');
  assert.match(profile.claim_boundary, /does not admit intelligence/i);
  assert.ok(profile.footprint.recommended_free_bytes >= 69_000_000_000);
});

test('workspace initialization creates model directories, guidance, and the digest-bound sixteen-task curriculum', async () => {
  const workspace = await temp();
  const receipt = await initializeWorkspace({ profilePath, workspace });
  assert.equal(receipt.task_count, 16);
  assert.match(receipt.profile_sha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.teacher.path, path.join(workspace, 'models', 'teacher', 'Qwen3-14B-Q4_K_M.gguf'));
  assert.ok(receipt.next_steps.some(step => step.includes('archie distill doctor')));
  assert.equal((await fs.stat(path.join(workspace, 'models', 'teacher'))).isDirectory(), true);
  assert.equal((await fs.stat(path.join(workspace, 'models', 'student'))).isDirectory(), true);
  const rows = (await fs.readFile(path.join(workspace, 'curriculum.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].task_id, 'evidence-plan-01');
  assert.equal(new Set(rows.map(row => row.task_id)).size, 16);
});

test('doctor returns precise blockers and next steps for a fresh workspace', async () => {
  const workspace = await temp();
  await initializeWorkspace({ profilePath, workspace });
  const diagnosis = await doctor({ profilePath, workspace });
  assert.equal(diagnosis.status, 'blocked');
  assert.equal(diagnosis.ready_to_teach, false);
  assert.deepEqual(diagnosis.blockers.map(blocker => blocker.code), ['teacher_missing', 'runner_not_provided']);
  assert.ok(diagnosis.next_steps.some(step => step.includes('Expected SHA-256')));
  assert.ok(diagnosis.next_steps.some(step => step.includes('--runner')));
});

test('doctor distinguishes a teacher digest mismatch from a missing model', async () => {
  const workspace = await temp();
  const receipt = await initializeWorkspace({ profilePath, workspace });
  await fs.writeFile(receipt.teacher.path, 'wrong-model');
  const runner = path.join(workspace, 'runner');
  await fs.writeFile(runner, 'fixture');
  const diagnosis = await doctor({ profilePath, workspace, runner });
  assert.equal(diagnosis.blockers[0].code, 'teacher_digest_mismatch');
  assert.ok(diagnosis.next_steps.some(step => step.includes('Observed SHA-256')));
});

test('doctor emits the exact teach command when all required inputs verify', async () => {
  const { workspace, localProfile, runner } = await readyWorkspace();
  const diagnosis = await doctor({ profilePath: localProfile, workspace, runner });
  assert.equal(diagnosis.status, 'ready');
  assert.equal(diagnosis.ready_to_teach, true);
  assert.deepEqual(diagnosis.blockers, []);
  assert.deepEqual(diagnosis.next_steps, [`Run: archie distill teach --workspace ${workspace} --runner ${runner}`]);
});

test('teacher run checkpoints clean output and emits measured progress', async () => {
  const { workspace, localProfile, runner } = await readyWorkspace();
  let nowMs = 0;
  const events = [];
  const result = await teach({
    profilePath: localProfile,
    workspace,
    runner,
    maxTasks: 2,
    now: () => nowMs,
    onProgress: event => events.push(event),
    execute: async () => {
      nowMs += 1_250;
      return { stdout: 'Bounded verified answer.', stderr: '' };
    }
  });
  assert.equal(result.completed, 2);
  assert.equal(result.complete, false);
  const completions = events.filter(event => event.status === 'completed');
  assert.equal(completions[0].task_elapsed_ms, 1_250);
  assert.equal(completions[0].eta_ms, 1_250);
  assert.equal(completions[1].eta_ms, 0);
});

test('teach progress rendering includes per-task duration and ETA', () => {
  assert.equal(
    formatTeachProgress({ status: 'completed', index: 3, total: 16, task_id: 'artifact-01', task_elapsed_ms: 8_400, eta_ms: 104_000 }),
    '[archie] teacher 3/16 artifact-01: completed (8.4s), ~104s remaining'
  );
  assert.equal(
    formatTeachProgress({ status: 'starting', index: 4, total: 16, task_id: 'device-01' }),
    '[archie] teacher 4/16 device-01: starting'
  );
});

test('teacher run rejects runtime contamination', async () => {
  const { workspace, localProfile, runner } = await readyWorkspace();
  await assert.rejects(() => teach({ profilePath: localProfile, workspace, runner, maxTasks: 1, execute: async () => ({ stdout: 'Loading model\nprompt eval time = 2 ms', stderr: '' }) }), /contamination/);
});

test('review is exhaustive and import retains rejected candidates as negative knowledge', async () => {
  const root = await temp();
  const candidates = path.join(root, 'candidates.jsonl');
  const rows = [
    { candidate_id: 'a', instruction: 'A', context: {}, response: 'yes', response_sha256: sha256('yes') },
    { candidate_id: 'b', instruction: 'B', context: {}, response: 'no', response_sha256: sha256('no') }
  ];
  await fs.writeFile(candidates, rows.map(JSON.stringify).join('\n') + '\n');
  const reviewPath = path.join(root, 'review.json');
  await attestTeacher({
    candidatesPath: candidates,
    reviewPath,
    reviewer: { kind: 'human', id: 'reviewer' },
    decisions: [
      { candidate_id: 'a', decision: 'accepted', reason: 'Correct and bounded.' },
      { candidate_id: 'b', decision: 'rejected', reason: 'Unsupported claim.' }
    ],
    confirmInspectedAll: true
  });
  const output = path.join(root, 'training.jsonl');
  const result = await importTeacher({ candidatesPath: candidates, reviewPath, outputPath: output, confirmReviewed: true });
  assert.deepEqual({ positive: result.positive, negative: result.negative }, { positive: 1, negative: 1 });
  const imported = (await fs.readFile(output, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(imported[1].negative, true);
  assert.equal(imported[1].target, null);
  assert.ok(imported[1].tags.includes('suppress'));
});
