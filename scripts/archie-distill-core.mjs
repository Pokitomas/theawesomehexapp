import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HEX = /^[a-f0-9]{64}$/;
export const PROFILE_SCHEMA = 'archie-distill-profile/v1';
export const REVIEW_SCHEMA = 'archie-teacher-review/v2';

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const stableJSONStringify = value => JSON.stringify(canonical(value));
export const sha256 = value => crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex');

async function readJSON(file) { return JSON.parse(await fs.readFile(path.resolve(file), 'utf8')); }
async function exists(file) { try { await fs.stat(file); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; } }
async function hashFile(file) {
  const h = crypto.createHash('sha256');
  const data = await fs.readFile(file); h.update(data); return h.digest('hex');
}
function assertProfile(profile) {
  if (profile?.schema !== PROFILE_SCHEMA) throw new Error('Unsupported Archie distillation profile.');
  if (!HEX.test(profile.teacher?.sha256 || '')) throw new Error('Teacher SHA-256 is required.');
  if (!/^[a-f0-9]{40}$/.test(profile.teacher?.revision || '') || !/^[a-f0-9]{40}$/.test(profile.student?.revision || '')) throw new Error('Teacher and student revisions must be exact 40-character commits.');
  if (!String(profile.claim_boundary || '').includes('does not')) throw new Error('Profile must state a fail-closed capability boundary.');
  return profile;
}
export async function loadProfile(profilePath) { return assertProfile(await readJSON(profilePath)); }
export function defaultWorkspace(profile, home = path.join(os.homedir(), '.archie')) { return path.join(home, 'distill', profile.id); }

const curriculum = [
  ['evidence-plan-01', 'Produce a bounded implementation plan from incomplete evidence without claiming unobserved state.', { domain: 'evidence' }],
  ['authority-01', 'Separate read, write, merge, deploy, secret, and production-data authority for an autonomous coding task.', { domain: 'authority' }],
  ['repair-01', 'Diagnose a failing exact-tree repository gate and propose the smallest truth-preserving repair.', { domain: 'diagnosis' }],
  ['security-01', 'Reject a request to place credentials in prompts or receipts and provide a safe local alternative.', { domain: 'security' }],
  ['collision-01', 'Reconcile an existing leased worktree before starting another writer.', { domain: 'operations' }],
  ['rollback-01', 'Design rollback evidence for a model-runtime release without claiming deployment.', { domain: 'operations' }],
  ['benchmark-01', 'Design a leakage-resistant comparison among raw student, prompt-only, adapter, and teacher paths.', { domain: 'evaluation' }],
  ['negative-01', 'Turn a failed tool trajectory into explicit suppression knowledge rather than a positive lesson.', { domain: 'learning' }],
  ['artifact-01', 'Verify model provenance, revision, digest, license, and runtime ABI before installation.', { domain: 'artifact' }],
  ['device-01', 'Distinguish simulated device checks from real-device evidence and fail closed.', { domain: 'device' }],
  ['recovery-01', 'Recover an interrupted multi-step run from digest-bound checkpoints without duplicating accepted work.', { domain: 'recovery' }],
  ['product-01', 'State the strongest truthful product claim supported by a local model and surrounding tool runtime.', { domain: 'product' }],
  ['privacy-01', 'Keep training admission separate from retrieval admission for user-connected and public sources.', { domain: 'privacy' }],
  ['training-01', 'Explain what a sixteen-example QLoRA smoke run can and cannot establish.', { domain: 'training' }],
  ['verification-01', 'Define exact-head verification receipts for source, tests, artifacts, and benchmark outputs.', { domain: 'verification' }],
  ['handoff-01', 'Produce a concise engineering handoff with exact SHA, files, tests, blockers, and rollback.', { domain: 'handoff' }]
].map(([task_id, instruction, context]) => ({ task_id, instruction, context }));

export async function initializeWorkspace({ profilePath, workspace }) {
  const profile = await loadProfile(profilePath);
  const root = path.resolve(workspace || defaultWorkspace(profile));
  await fs.mkdir(root, { recursive: true });
  const profileOut = path.join(root, 'profile.json');
  await fs.writeFile(profileOut, `${JSON.stringify(profile, null, 2)}\n`);
  const tasks = curriculum.map(row => stableJSONStringify(row)).join('\n') + '\n';
  await fs.writeFile(path.join(root, 'curriculum.jsonl'), tasks);
  const teacherPath = path.join(root, 'models', 'teacher', profile.teacher.filename);
  const freeNote = profile.footprint?.recommended_free_bytes ? `~${Math.round(profile.footprint.recommended_free_bytes / 1e9)} GB free disk space` : 'significant free disk space';
  const next_steps = [
    `1. Place the teacher model at: ${teacherPath}`,
    `   SHA-256: ${profile.teacher.sha256}`,
    `   Source: ${profile.teacher.repository}`,
    `   Note: the model file is not part of this repository and requires ${freeNote}`,
    `2. Install llama.cpp and note the path to the llama-cli binary`,
    `3. Check readiness: archie distill doctor --workspace ${root} --runner <llama-cli-path>`,
    `4. Run the teacher: archie distill teach --workspace ${root} --runner <llama-cli-path>`,
  ];
  const receipt = { schema: 'archie-distill-workspace/v1', profile_id: profile.id, profile_sha256: sha256(stableJSONStringify(profile)), curriculum_sha256: sha256(tasks), task_count: curriculum.length, workspace: root, claim_boundary: profile.claim_boundary, next_steps };
  await fs.writeFile(path.join(root, 'workspace-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

export async function doctor({ profilePath, workspace, runner = '' }) {
  const profile = await loadProfile(profilePath);
  const root = path.resolve(workspace || defaultWorkspace(profile));
  const teacher = path.join(root, 'models', 'teacher', profile.teacher.filename);
  const teacherExists = await exists(teacher);
  const observed = teacherExists ? await hashFile(teacher) : null;
  const runnerPath = runner ? path.resolve(runner) : '';
  const runnerPresent = runnerPath ? await exists(runnerPath) : false;
  const studentPresent = await exists(path.join(root, 'models', 'student', 'config.json'));
  const teacherVerified = observed === profile.teacher.sha256;
  const readyToTeach = teacherVerified && Boolean(runnerPath && runnerPresent);
  const blockers = [];
  const next_steps = [];
  if (!teacherExists) {
    blockers.push(`teacher model missing — expected at: ${teacher}`);
    next_steps.push(`Download the teacher model from ${profile.teacher.repository}`);
    next_steps.push(`Place the file at: ${teacher}`);
    next_steps.push(`Expected SHA-256: ${profile.teacher.sha256}`);
  } else if (!teacherVerified) {
    blockers.push('teacher model SHA-256 mismatch — file may be incomplete or the wrong version');
    next_steps.push(`Replace the teacher model at: ${teacher}`);
    next_steps.push(`Expected SHA-256: ${profile.teacher.sha256}`);
    next_steps.push(`Observed SHA-256: ${observed}`);
  }
  if (!runnerPresent) {
    if (!runnerPath) {
      blockers.push('no runner path provided — pass --runner <path-to-llama-cli>');
      next_steps.push('Build llama.cpp (https://github.com/ggerganov/llama.cpp) then rerun with --runner <path-to-llama-cli>');
    } else {
      blockers.push(`runner not found at: ${runnerPath}`);
      next_steps.push('Verify the --runner path is correct and the llama-cli binary is executable.');
    }
  }
  if (readyToTeach) {
    next_steps.push(`All checks passed — run: archie distill teach --workspace ${root} --runner ${runnerPath}`);
  }
  return {
    schema: 'archie-distill-doctor/v1', profile_id: profile.id, workspace: root,
    teacher: { path: teacher, present: teacherExists, expected_sha256: profile.teacher.sha256, observed_sha256: observed, verified: teacherVerified },
    student_present: studentPresent,
    runner: { path: runnerPath || null, present: runnerPresent },
    ready_to_teach: readyToTeach,
    blockers,
    next_steps,
    claim_boundary: profile.claim_boundary
  };
}

function cleanOutput(stdout) {
  const text = String(stdout || '').replace(/\r/g, '').trim();
  const contamination = /(llama_model_loader|load_tensors|system_info:|sampler seed|prompt eval time|eval time|llama_perf_context_print|^>\s*--|Loading model)/im;
  if (!text) throw new Error('Teacher returned an empty response.');
  if (contamination.test(text)) throw new Error('Teacher output contains runner banner, prompt, or timing contamination.');
  return text;
}
async function readJSONL(file) { return (await fs.readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
async function appendJSONL(file, row) { await fs.appendFile(file, `${stableJSONStringify(row)}\n`); }

export async function teach({ profilePath, workspace, runner, tasksPath, maxTasks = Infinity, execute = execFileAsync, onProgress = () => {} }) {
  const profile = await loadProfile(profilePath);
  const root = path.resolve(workspace || defaultWorkspace(profile));
  const diagnosis = await doctor({ profilePath, workspace: root, runner });
  if (!diagnosis.ready_to_teach) throw new Error('Teacher model and explicit runner must both be present and verified.');
  const tasks = await readJSONL(tasksPath || path.join(root, 'curriculum.jsonl'));
  const final = path.join(root, 'teacher-candidates.jsonl');
  const partial = `${final}.partial`;
  const existingRows = await exists(partial) ? await readJSONL(partial) : [];
  const completed = new Map(existingRows.map(row => [row.task_id, row]));
  for (const [index, task] of tasks.slice(0, maxTasks).entries()) {
    if (completed.has(task.task_id)) continue;
    onProgress({ status: 'starting', index: index + 1, total: tasks.length, task_id: task.task_id });
    const systemPrompt = 'You are generating a candidate teaching trace for Archie. Be precise, preserve stated authority, refuse unsupported mutation or claims, and give a verifiable bounded answer.';
    const prompt = `${stableJSONStringify({ instruction: task.instruction, context: task.context ?? null })}\n\n/no_think`;
    const args = ['-m', diagnosis.teacher.path, '--system-prompt', systemPrompt, '-p', prompt, '-n', String(profile.teacher_generation.max_tokens), '-c', String(profile.teacher_generation.context_size), '-ngl', String(profile.teacher_generation.gpu_layers), '--temp', String(profile.teacher_generation.temperature), '--seed', String(profile.training.seed), '--no-display-prompt', '--conversation', '--single-turn', '--no-warmup', '--color', 'off', '--simple-io', '--log-disable', '--no-perf'];
    const command_digest = sha256(stableJSONStringify({ args, model_sha256: diagnosis.teacher.observed_sha256, system_prompt_sha256: sha256(systemPrompt), prompt_sha256: sha256(prompt) }));
    const result = await execute(path.resolve(runner), args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    const response = cleanOutput(result.stdout);
    const row = { schema: 'archie-teacher-candidate/v1', candidate_id: `${task.task_id}-${sha256(response).slice(0, 16)}`, task_id: task.task_id, instruction: task.instruction, context: task.context ?? null, response, response_sha256: sha256(response), command_digest, teacher: { repository: profile.teacher.repository, revision: profile.teacher.revision, file_sha256: diagnosis.teacher.observed_sha256 } };
    await appendJSONL(partial, row); completed.set(task.task_id, row);
    onProgress({ status: 'completed', index: index + 1, total: tasks.length, task_id: task.task_id, candidate_id: row.candidate_id });
  }
  const rows = await readJSONL(partial);
  if (rows.length === tasks.length) await fs.rename(partial, final);
  return { schema: 'archie-distill-teach-result/v1', candidate_path: rows.length === tasks.length ? final : partial, completed: rows.length, total: tasks.length, complete: rows.length === tasks.length };
}

export async function attestTeacher({ candidatesPath, reviewPath, reviewer, decisions, confirmInspectedAll = false }) {
  if (!confirmInspectedAll) throw new Error('Teacher review requires --confirm-inspected-all.');
  const candidates = await readJSONL(candidatesPath);
  const byId = new Map(candidates.map(row => [row.candidate_id, row]));
  if (decisions.length !== candidates.length) throw new Error('Exactly one review decision is required for every candidate.');
  const seen = new Set();
  const normalized = decisions.map(item => {
    if (!byId.has(item.candidate_id) || seen.has(item.candidate_id)) throw new Error(`Invalid or duplicate candidate decision: ${item.candidate_id}.`);
    seen.add(item.candidate_id);
    if (!['accepted', 'rejected'].includes(item.decision) || !String(item.reason || '').trim()) throw new Error('Each decision requires accepted/rejected and a reason.');
    return { candidate_id: item.candidate_id, decision: item.decision, reason: String(item.reason).trim() };
  });
  const review = { schema: REVIEW_SCHEMA, candidate_file_sha256: await hashFile(candidatesPath), review_scope: 'all-candidates', reviewer, decisions: normalized, capability_claim: 'none' };
  review.review_digest = sha256(stableJSONStringify(review));
  await fs.writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, { flag: 'wx' });
  return review;
}

export async function importTeacher({ candidatesPath, reviewPath, outputPath, confirmReviewed = false }) {
  if (!confirmReviewed) throw new Error('Teacher import requires --confirm-reviewed.');
  const candidates = await readJSONL(candidatesPath);
  const review = await readJSON(reviewPath);
  if (review.schema !== REVIEW_SCHEMA || review.candidate_file_sha256 !== await hashFile(candidatesPath)) throw new Error('Teacher review does not bind the exact candidate file.');
  const decisions = new Map(review.decisions.map(row => [row.candidate_id, row]));
  const rows = candidates.map(candidate => {
    const decision = decisions.get(candidate.candidate_id);
    if (!decision) throw new Error(`Missing review for ${candidate.candidate_id}.`);
    const positive = decision.decision === 'accepted';
    return {
      schema: 'archie-distillation-example/v1',
      example_id: candidate.candidate_id,
      example_digest: sha256(stableJSONStringify({ candidate, decision })),
      instruction: candidate.instruction,
      compact_context: candidate.context,
      target: positive ? candidate.response : null,
      outcome: positive ? 'completed' : 'rejected',
      negative: !positive,
      reason: decision.reason,
      source_digest: candidate.response_sha256,
      teacher_evidence: { candidate_id: candidate.candidate_id, review_digest: review.review_digest },
      tags: positive ? ['teacher', 'reviewed', 'positive'] : ['teacher', 'reviewed', 'negative', 'suppress']
    };
  });
  await fs.writeFile(outputPath, rows.map(stableJSONStringify).join('\n') + '\n', { flag: 'wx' });
  return { schema: 'archie-distill-import-result/v1', output_path: path.resolve(outputPath), rows: rows.length, positive: rows.filter(row => !row.negative).length, negative: rows.filter(row => row.negative).length, sha256: await hashFile(outputPath) };
}
