import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MAKER_LANES, normalizeLeasePaths, slugify } from './maker-core.mjs';

export const ARCHIE_MAKER_DECISION_SCHEMA = 'sideways-archie-maker-decision/v1';
const ALLOWED_LANES = new Set(MAKER_LANES.map(value => value.id));
const clean = (value, limit = 12000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function stableJSONStringify(value) {
  return JSON.stringify(canonical(value));
}

export function archieMakerValueDigest(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableJSONStringify(value)).digest('hex');
}

function signatureFor(body, key) {
  const secret = clean(key, 1000);
  if (secret.length < 32) throw new Error('Archie Maker decision key must contain at least 32 characters.');
  return crypto.createHmac('sha256', secret).update(stableJSONStringify(body)).digest('hex');
}

function safeEqual(left, right) {
  const a = Buffer.from(clean(left, 200), 'utf8');
  const b = Buffer.from(clean(right, 200), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function clockDate(clock) {
  const value = typeof clock === 'function' ? clock() : clock;
  const date = new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new Error('Archie Maker decision clock is invalid.');
  return date;
}

export function normalizeMakerExecutionPlan(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const title = clean(value.title, 200);
  const selectedLane = clean(value.selected_lane, 120);
  const whyNow = clean(value.why_now, 4000);
  const implementationPrompt = clean(value.implementation_prompt, 50000);
  const branchSlug = slugify(value.branch_slug || title, 'maker-work');
  let ownedPaths;
  try { ownedPaths = normalizeLeasePaths(value.owned_paths); }
  catch { return null; }
  const focusedTests = (Array.isArray(value.focused_tests) ? value.focused_tests : []).map(item => clean(item, 2000)).filter(Boolean).slice(0, 20);
  const deferred = (Array.isArray(value.deferred) ? value.deferred : []).map(item => clean(item, 2000)).filter(Boolean).slice(0, 30);
  if (!title || !ALLOWED_LANES.has(selectedLane) || !whyNow || !implementationPrompt || !ownedPaths.length) return null;
  return Object.freeze({
    title,
    branch_slug: branchSlug,
    selected_lane: selectedLane,
    why_now: whyNow,
    owned_paths: ownedPaths,
    implementation_prompt: implementationPrompt,
    focused_tests: focusedTests,
    deferred
  });
}

function repositoryDigest(repository) {
  return archieMakerValueDigest(path.resolve(clean(repository, 4000)));
}

function finiteUsage(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`Archie Maker teacher ${field} must be finite and non-negative.`);
  return number;
}

function validateTeacherReceipt(receipt, { instruction, baseBranch, baseSha, plan, executionBasis }) {
  if (receipt?.schema !== 'archie-openai-teacher-receipt/v1') throw new Error('Archie Maker teacher plan lacks a valid teacher receipt.');
  if (!clean(receipt.response_id, 300)) throw new Error('Archie Maker teacher receipt lacks a response ID.');
  if (!clean(receipt.model, 300)) throw new Error('Archie Maker teacher receipt lacks a model identity.');
  if (receipt.request_digest !== archieMakerValueDigest(instruction)) throw new Error('Archie Maker teacher receipt request does not match.');
  if (clean(receipt.base_branch, 200) !== clean(baseBranch, 200) || clean(receipt.base_sha, 200) !== clean(baseSha, 200)) throw new Error('Archie Maker teacher receipt base does not match.');
  if (receipt.plan_digest !== archieMakerValueDigest(plan)) throw new Error('Archie Maker teacher receipt plan does not match.');
  if (!/^[a-f0-9]{64}$/.test(clean(receipt.repository_evidence_digest, 128))) throw new Error('Archie Maker teacher receipt lacks repository-evidence binding.');
  finiteUsage(receipt.usage?.input_tokens, 'input_tokens');
  finiteUsage(receipt.usage?.output_tokens, 'output_tokens');
  finiteUsage(receipt.usage?.total_tokens, 'total_tokens');
  if (clean(executionBasis?.response_id, 300) !== clean(receipt.response_id, 300)) throw new Error('Archie Maker teacher execution response ID does not match its receipt.');
  if (clean(executionBasis?.repository_evidence_digest, 128) !== clean(receipt.repository_evidence_digest, 128)) throw new Error('Archie Maker teacher execution evidence does not match its receipt.');
  const { receipt_digest: claimed, ...receiptBody } = receipt;
  if (claimed !== archieMakerValueDigest(receiptBody) || claimed !== clean(executionBasis?.teacher_receipt_digest, 200)) throw new Error('Archie Maker teacher receipt integrity check failed.');
  return receipt.repository_evidence_digest;
}

export function createArchieMakerDecision({
  request,
  repository,
  baseBranch = 'main',
  baseSha,
  recall,
  key,
  clock = Date.now,
  ttlMs = 10 * 60 * 1000
} = {}) {
  const instruction = clean(request);
  const plan = normalizeMakerExecutionPlan(recall?.plan);
  const state = clean(recall?.status, 100);
  const localRecurrence = state === 'local' && recall?.execution_basis?.kind === 'normalized-exact-verified-recurrence';
  const freshTeacher = state === 'teacher' && recall?.execution_basis?.kind === 'fresh-bounded-teacher-plan';
  if (!instruction) throw new Error('Archie Maker decision requires a request.');
  if (!repository) throw new Error('Archie Maker decision requires a repository.');
  if (!clean(baseSha, 200)) throw new Error('Archie Maker decision requires an exact base SHA.');
  if (!plan) throw new Error('Archie Maker decision requires a valid exact recurrence or bounded teacher plan.');
  if (state === 'local' && !localRecurrence) throw new Error('Archie Maker decision requires a normalized-exact verified recurrence.');
  if (state === 'teacher' && !freshTeacher) throw new Error('Archie Maker decision requires a fresh bounded teacher plan.');
  if (!localRecurrence && !freshTeacher) throw new Error('Archie Maker decision requires a valid exact recurrence or bounded teacher plan.');
  if (recall.execution_eligible !== true) throw new Error('Archie Maker decision is not execution eligible.');
  if (clean(recall.execution_basis?.base_sha, 200) !== clean(baseSha, 200)) throw new Error('Archie Maker decision base SHA does not match.');
  const repositoryEvidenceDigest = freshTeacher
    ? validateTeacherReceipt(recall.teacher_receipt, { instruction, baseBranch, baseSha, plan, executionBasis: recall.execution_basis })
    : null;
  const issued = clockDate(clock);
  const expires = new Date(issued.getTime() + Math.max(1000, Number(ttlMs) || 0));
  const body = {
    schema: ARCHIE_MAKER_DECISION_SCHEMA,
    state: freshTeacher ? 'teacher' : 'local',
    source: freshTeacher ? 'openai-responses-teacher' : 'native-maker-recall',
    issued_at: issued.toISOString(),
    expires_at: expires.toISOString(),
    request_digest: archieMakerValueDigest(instruction),
    repository_digest: repositoryDigest(repository),
    base_branch: clean(baseBranch, 200),
    base_sha: clean(baseSha, 200),
    specialist_id: clean(recall.specialist_id, 300) || null,
    confidence: Number(recall.confidence || 0),
    margin: Number(recall.margin || 0),
    model_digest: clean(recall.model_digest, 200) || null,
    execution_basis: freshTeacher ? {
      kind: 'fresh-bounded-teacher-plan',
      response_id: clean(recall.execution_basis.response_id, 300),
      teacher_receipt_digest: clean(recall.execution_basis.teacher_receipt_digest, 200),
      repository_evidence_digest: clean(repositoryEvidenceDigest, 128),
      base_sha: clean(baseSha, 200)
    } : {
      kind: 'normalized-exact-verified-recurrence',
      example_id: clean(recall.execution_basis.example_id, 300),
      base_sha: clean(baseSha, 200)
    },
    repository_evidence_digest: repositoryEvidenceDigest,
    teacher_receipt: freshTeacher ? recall.teacher_receipt : null,
    plan,
    plan_digest: archieMakerValueDigest(plan)
  };
  return Object.freeze({ ...body, signature: signatureFor(body, key) });
}

export function verifyArchieMakerDecision(value, {
  request,
  repository,
  baseBranch = 'main',
  baseSha,
  key,
  clock = Date.now,
  maximumFutureSkewMs = 60 * 1000
} = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Archie Maker decision must be an object.');
  if (value.schema !== ARCHIE_MAKER_DECISION_SCHEMA) throw new Error(`Archie Maker decision schema must be ${ARCHIE_MAKER_DECISION_SCHEMA}.`);
  const localRecurrence = value.state === 'local' && value.source === 'native-maker-recall' && value.execution_basis?.kind === 'normalized-exact-verified-recurrence';
  const freshTeacher = value.state === 'teacher' && value.source === 'openai-responses-teacher' && value.execution_basis?.kind === 'fresh-bounded-teacher-plan';
  if (!localRecurrence && !freshTeacher) throw new Error('Archie Maker decision state or source is not executable.');
  if (localRecurrence && !clean(value.execution_basis?.example_id, 300)) throw new Error('Archie Maker decision lacks normalized-exact verified recurrence evidence.');
  if (freshTeacher) {
    const evidenceDigest = validateTeacherReceipt(value.teacher_receipt, {
      instruction: clean(request),
      baseBranch,
      baseSha,
      plan: value.plan,
      executionBasis: value.execution_basis
    });
    if (clean(value.repository_evidence_digest, 128) !== clean(evidenceDigest, 128)) throw new Error('Archie Maker decision repository evidence does not match its teacher receipt.');
  }
  const plan = normalizeMakerExecutionPlan(value.plan);
  if (!plan) throw new Error('Archie Maker decision contains an invalid execution plan.');
  if (value.plan_digest !== archieMakerValueDigest(plan)) throw new Error('Archie Maker decision plan integrity check failed.');
  if (value.request_digest !== archieMakerValueDigest(clean(request))) throw new Error('Archie Maker decision request does not match the active Maker request.');
  if (value.repository_digest !== repositoryDigest(repository)) throw new Error('Archie Maker decision repository does not match the active checkout.');
  if (clean(value.base_branch, 200) !== clean(baseBranch, 200)) throw new Error('Archie Maker decision base branch does not match Maker.');
  if (clean(value.base_sha, 200) !== clean(baseSha, 200) || clean(value.execution_basis?.base_sha, 200) !== clean(baseSha, 200)) {
    throw new Error('Archie Maker decision base SHA does not match Maker.');
  }
  const now = clockDate(clock).getTime();
  const issued = new Date(value.issued_at).getTime();
  const expires = new Date(value.expires_at).getTime();
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) throw new Error('Archie Maker decision validity window is invalid.');
  if (issued > now + maximumFutureSkewMs) throw new Error('Archie Maker decision was issued in the future.');
  if (expires < now) throw new Error('Archie Maker decision has expired.');
  const { signature, ...body } = value;
  const expected = signatureFor({ ...body, plan }, key);
  if (!safeEqual(signature, expected)) throw new Error('Archie Maker decision signature verification failed.');
  return Object.freeze({ ...body, plan, signature: expected });
}

export async function readArchieMakerDecision(filename, options = {}) {
  const target = path.resolve(clean(filename, 4000));
  const raw = JSON.parse(await fs.readFile(target, 'utf8'));
  return verifyArchieMakerDecision(raw, options);
}
