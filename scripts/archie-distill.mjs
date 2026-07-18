import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { has, integer, last, requiredFlag } from './archie-cli-core.mjs';
import { attestTeacher, defaultWorkspace, doctor, importTeacher, initializeWorkspace, loadProfile, teach } from './archie-distill-core.mjs';

const defaultProfile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'maker', 'evaluations', 'archie-distill-qwen3-quality.json');
function splitDecision(value, decision) {
  const index = value.indexOf('::');
  if (index < 1) throw new Error(`${decision} requires candidate-id::reason.`);
  return { candidate_id: value.slice(0, index), reason: value.slice(index + 2), decision };
}

function taskSeconds(milliseconds) {
  return `${(Math.max(0, Number(milliseconds) || 0) / 1000).toFixed(1)}s`;
}

function etaSeconds(milliseconds) {
  return `${Math.max(0, Math.round((Number(milliseconds) || 0) / 1000))}s`;
}

export function formatTeachProgress(event) {
  const prefix = `[archie] teacher ${event.index}/${event.total} ${event.task_id}: ${event.status}`;
  if (event.status !== 'completed') return prefix;
  const duration = Number.isFinite(event.task_elapsed_ms) ? ` (${taskSeconds(event.task_elapsed_ms)})` : '';
  const eta = Number.isFinite(event.eta_ms) && event.eta_ms > 0 ? `, ~${etaSeconds(event.eta_ms)} remaining` : '';
  return `${prefix}${duration}${eta}`;
}

export async function runDistillCommand({ positionals, flags }) {
  const command = positionals[1] || 'help';
  const profilePath = path.resolve(last(flags, '--profile', defaultProfile));
  const profile = await loadProfile(profilePath);
  const workspace = path.resolve(last(flags, '--workspace', defaultWorkspace(profile)));
  if (command === 'init') return initializeWorkspace({ profilePath, workspace });
  if (command === 'doctor') return doctor({ profilePath, workspace, runner: last(flags, '--runner') });
  if (command === 'teach') return teach({
    profilePath,
    workspace,
    runner: requiredFlag(flags, '--runner'),
    tasksPath: last(flags, '--tasks'),
    maxTasks: integer(flags, '--max-tasks', Number.MAX_SAFE_INTEGER),
    onProgress: event => process.stderr.write(`${formatTeachProgress(event)}\n`)
  });
  if (command === 'attest-teacher') {
    const decisions = [
      ...(flags.get('--accept') || []).map(value => splitDecision(value, 'accepted')),
      ...(flags.get('--reject') || []).map(value => splitDecision(value, 'rejected'))
    ];
    return attestTeacher({
      candidatesPath: path.resolve(last(flags, '--candidates', path.join(workspace, 'teacher-candidates.jsonl'))),
      reviewPath: path.resolve(last(flags, '--review', path.join(workspace, 'teacher-review.json'))),
      reviewer: {
        kind: last(flags, '--reviewer-kind', 'human'),
        id: requiredFlag(flags, '--reviewer-id'),
        implementation: last(flags, '--reviewer-implementation', 'manual')
      },
      decisions,
      confirmInspectedAll: has(flags, '--confirm-inspected-all')
    });
  }
  if (command === 'import-teacher') return importTeacher({
    candidatesPath: path.resolve(last(flags, '--candidates', path.join(workspace, 'teacher-candidates.jsonl'))),
    reviewPath: path.resolve(last(flags, '--review', path.join(workspace, 'teacher-review.json'))),
    outputPath: path.resolve(last(flags, '--output', path.join(workspace, 'reviewed-training.jsonl'))),
    confirmReviewed: has(flags, '--confirm-reviewed')
  });
  throw new Error('Usage: archie distill <init|doctor|teach|attest-teacher|import-teacher> [flags]');
}
