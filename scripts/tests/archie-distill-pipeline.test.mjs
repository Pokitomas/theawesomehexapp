import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { attestTeacher, importTeacher, initializeWorkspace, loadProfile, sha256, teach } from '../archie-distill-core.mjs';

const profilePath = path.resolve('maker/evaluations/archie-distill-qwen3-quality.json');
async function temp() { return fs.mkdtemp(path.join(os.tmpdir(), 'archie-distill-')); }

test('quality profile pins exact inputs and an honest claim boundary', async () => {
  const profile = await loadProfile(profilePath);
  assert.match(profile.teacher.revision, /^[a-f0-9]{40}$/);
  assert.match(profile.student.revision, /^[a-f0-9]{40}$/);
  assert.equal(profile.teacher.sha256, '500a8806e85ee9c83f3ae08420295592451379b4f8cf2d0f41c15dffeb6b81f0');
  assert.match(profile.claim_boundary, /does not admit intelligence/i);
  assert.ok(profile.footprint.recommended_free_bytes >= 69_000_000_000);
});

test('workspace initialization creates a digest-bound thirty-two-task curriculum', async () => {
  const workspace = await temp();
  const receipt = await initializeWorkspace({ profilePath, workspace });
  assert.equal(receipt.task_count, 32);
  assert.match(receipt.profile_sha256, /^[a-f0-9]{64}$/);
  const rows = (await fs.readFile(path.join(workspace, 'curriculum.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].task_id, 'evidence-plan-01');
  assert.equal(new Set(rows.map(row => row.task_id)).size, 32);
});

test('teacher run checkpoints clean output', async () => {
  const workspace = await temp();
  await initializeWorkspace({ profilePath, workspace });
  const profile = await loadProfile(profilePath);
  const teacherDir = path.join(workspace, 'models', 'teacher');
  await fs.mkdir(teacherDir, { recursive: true });
  const model = path.join(teacherDir, profile.teacher.filename);
  await fs.writeFile(model, 'fixture');
  profile.teacher.sha256 = sha256('fixture');
  const localProfile = path.join(workspace, 'local-profile.json');
  await fs.writeFile(localProfile, JSON.stringify(profile));
  const runner = path.join(workspace, 'runner');
  await fs.writeFile(runner, 'fixture');
  const result = await teach({ profilePath: localProfile, workspace, runner, maxTasks: 1, execute: async () => ({ stdout: 'Bounded verified answer.', stderr: '' }) });
  assert.equal(result.completed, 1);
  assert.equal(result.complete, false);
});

test('teacher run rejects runtime contamination', async () => {
  const workspace = await temp();
  await initializeWorkspace({ profilePath, workspace });
  const profile = await loadProfile(profilePath);
  const teacherDir = path.join(workspace, 'models', 'teacher');
  await fs.mkdir(teacherDir, { recursive: true });
  await fs.writeFile(path.join(teacherDir, profile.teacher.filename), 'fixture');
  profile.teacher.sha256 = sha256('fixture');
  const localProfile = path.join(workspace, 'local-profile.json');
  await fs.writeFile(localProfile, JSON.stringify(profile));
  const runner = path.join(workspace, 'runner');
  await fs.writeFile(runner, 'fixture');
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
