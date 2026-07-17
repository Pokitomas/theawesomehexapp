import crypto from 'node:crypto';

export const ARCHIE_TRAJECTORY_SCHEMA = 'archie-trajectory/v1';
export const ARCHIE_TRAJECTORY_BATCH_SCHEMA = 'archie-trajectory-batch/v1';
export const ARCHIE_TRAJECTORY_ADMISSION_SCHEMA = 'archie-trajectory-admission/v1';

export const TRAJECTORY_EVENT_TYPES = Object.freeze([
  'request',
  'plan',
  'tool-call',
  'tool-result',
  'verification',
  'correction',
  'retry',
  'rollback',
  'user-intervention',
  'pause',
  'resume',
  'cancel',
  'outcome'
]);

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GIT_OID_PATTERN = /^[a-f0-9]{40,64}$/;
const clean = (value, limit = 200000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function stable(value) {
  return JSON.stringify(canonical(value));
}

function digest(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
}

function sha256(value, field, { required = true } = {}) {
  const normalized = clean(value, 128).toLowerCase();
  if (!normalized && !required) return null;
  if (!SHA256_PATTERN.test(normalized)) throw new Error(`${field} must be a SHA-256 hex digest.`);
  return normalized;
}

function gitOid(value, field, { required = true } = {}) {
  const normalized = clean(value, 128).toLowerCase();
  if (!normalized && !required) return null;
  if (!GIT_OID_PATTERN.test(normalized)) throw new Error(`${field} must be a 40- or 64-character Git object ID.`);
  return normalized;
}

function isoDate(value, field, { required = true } = {}) {
  const normalized = clean(value, 100);
  if (!normalized && !required) return null;
  if (!normalized || Number.isNaN(Date.parse(normalized))) throw new Error(`${field} must be an ISO date.`);
  return new Date(normalized).toISOString();
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  return canonical(value);
}

function normalizeVerification(value, index) {
  const item = object(value, `verification[${index}]`);
  const status = clean(item.status || item.state, 80).toLowerCase();
  if (!['passed', 'failed', 'blocked', 'skipped'].includes(status)) throw new Error(`verification[${index}].status is unsupported.`);
  const verifier = clean(item.verifier || item.name, 300);
  if (!verifier) throw new Error(`verification[${index}].verifier is required.`);
  const evidenceDigest = sha256(item.evidence_digest || item.receipt_digest || item.digest, `verification[${index}].evidence_digest`, { required: status === 'passed' });
  return Object.freeze({
    verifier,
    status,
    independent: item.independent === true,
    evidence_digest: evidenceDigest,
    detail: item.detail && typeof item.detail === 'object' && !Array.isArray(item.detail) ? canonical(item.detail) : {},
    observed_at: isoDate(item.observed_at || item.finished_at, `verification[${index}].observed_at`, { required: false })
  });
}

function normalizeEvent(value, index) {
  const item = object(value, `events[${index}]`);
  const type = clean(item.type, 80);
  if (!TRAJECTORY_EVENT_TYPES.includes(type)) throw new Error(`events[${index}].type is unsupported.`);
  const sequence = Number(item.sequence ?? index + 1);
  if (!Number.isInteger(sequence) || sequence < 1) throw new Error(`events[${index}].sequence must be a positive integer.`);
  const at = isoDate(item.at || item.observed_at, `events[${index}].at`, { required: false });
  const payload = item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload)
    ? canonical(item.payload)
    : canonical(Object.fromEntries(Object.entries(item).filter(([key]) => !['type', 'sequence', 'at', 'observed_at'].includes(key))));
  return Object.freeze({ sequence, type, at, payload });
}

function normalizeOutcome(value) {
  const item = object(value, 'outcome');
  const status = clean(item.status || item.state, 80).toLowerCase();
  if (!['completed', 'failed', 'rejected', 'blocked', 'cancelled', 'partial'].includes(status)) throw new Error('outcome.status is unsupported.');
  return Object.freeze({
    status,
    summary: clean(item.summary || item.message, 100000),
    negative: item.negative === true || status !== 'completed',
    delayed_signals: item.delayed_signals && typeof item.delayed_signals === 'object' && !Array.isArray(item.delayed_signals)
      ? canonical(item.delayed_signals)
      : {},
    observed_at: isoDate(item.observed_at || item.finished_at, 'outcome.observed_at', { required: false })
  });
}

function normalizeProvenance(value) {
  const item = object(value, 'provenance');
  const repository = clean(item.repository, 1000);
  if (!repository) throw new Error('provenance.repository is required.');
  const requestDigest = sha256(item.request_digest, 'provenance.request_digest');
  return Object.freeze({
    repository,
    branch: clean(item.branch, 500) || null,
    base_sha: gitOid(item.base_sha, 'provenance.base_sha'),
    head_sha: gitOid(item.head_sha, 'provenance.head_sha', { required: false }),
    code_commit: gitOid(item.code_commit || item.head_sha, 'provenance.code_commit', { required: false }),
    request_digest: requestDigest,
    plan_digest: sha256(item.plan_digest, 'provenance.plan_digest', { required: false }),
    patch_digest: sha256(item.patch_digest, 'provenance.patch_digest', { required: false }),
    authority_digest: sha256(item.authority_digest, 'provenance.authority_digest', { required: false }),
    environment_digest: sha256(item.environment_digest, 'provenance.environment_digest', { required: false }),
    teacher: item.teacher && typeof item.teacher === 'object' && !Array.isArray(item.teacher) ? canonical(item.teacher) : null,
    sources: Array.isArray(item.sources) ? item.sources.map((source, index) => {
      const normalized = object(source, `provenance.sources[${index}]`);
      return Object.freeze({
        kind: clean(normalized.kind, 100),
        uri: clean(normalized.uri, 4000),
        digest: sha256(normalized.digest || normalized.bytes_digest, `provenance.sources[${index}].digest`),
        license: clean(normalized.license, 500) || null
      });
    }) : []
  });
}

export function normalizeArchieTrajectory(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Archie trajectory must be an object.');
  if (value.schema && value.schema !== ARCHIE_TRAJECTORY_SCHEMA) throw new Error(`Trajectory schema must be ${ARCHIE_TRAJECTORY_SCHEMA}.`);
  const request = clean(value.request || value.instruction, 500000);
  if (!request) throw new Error('Trajectory request is required.');
  const provenance = normalizeProvenance(value.provenance || {});
  if (provenance.request_digest !== digest(request)) throw new Error('Trajectory request_digest does not match request bytes.');
  const events = (Array.isArray(value.events) ? value.events : []).map(normalizeEvent).sort((left, right) => left.sequence - right.sequence || left.type.localeCompare(right.type));
  const sequences = new Set();
  for (const event of events) {
    if (sequences.has(event.sequence)) throw new Error(`Duplicate trajectory event sequence ${event.sequence}.`);
    sequences.add(event.sequence);
  }
  const verification = (Array.isArray(value.verification) ? value.verification : []).map(normalizeVerification);
  const outcome = normalizeOutcome(value.outcome || {});
  const semanticBody = {
    schema: ARCHIE_TRAJECTORY_SCHEMA,
    subject: clean(value.subject || 'default', 500),
    request,
    provenance,
    events,
    verification,
    outcome,
    labels: [...new Set((Array.isArray(value.labels) ? value.labels : []).map(item => clean(item, 200)).filter(Boolean))].sort(),
    parent_trajectory_digest: sha256(value.parent_trajectory_digest, 'parent_trajectory_digest', { required: false })
  };
  const body = {
    ...semanticBody,
    trajectory_digest: digest(semanticBody),
    recorded_at: isoDate(value.recorded_at, 'recorded_at', { required: false })
  };
  return Object.freeze(body);
}

export function trajectoryFromMakerReceipt(receipt, { recorded_at = new Date().toISOString() } = {}) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('Maker receipt must be an object.');
  const request = clean(receipt.request || receipt.task?.request || receipt.input?.request, 500000);
  if (!request) throw new Error('Maker receipt request is required.');
  const baseSha = clean(receipt.base_sha || receipt.task?.proof?.base_sha, 128);
  const headSha = clean(receipt.head_sha || receipt.task?.proof?.head_sha, 128);
  const plan = receipt.plan || receipt.components?.model_route?.output?.plan || null;
  const planDigest = plan ? digest(plan) : null;
  const rawVerification = Array.isArray(receipt.verification)
    ? receipt.verification
    : Array.isArray(receipt.task?.proof?.verification)
      ? receipt.task.proof.verification
      : [];
  const verification = rawVerification.map((item, index) => typeof item === 'string'
    ? {
        verifier: `maker-verifier-${index + 1}`,
        status: 'passed',
        independent: true,
        evidence_digest: digest(item),
        detail: { summary: clean(item, 5000) }
      }
    : item);
  const toolTrace = Array.isArray(receipt.tool_trace)
    ? receipt.tool_trace
    : Array.isArray(receipt.components?.model_route?.attempts)
      ? receipt.components.model_route.attempts
      : [];
  const events = [
    { sequence: 1, type: 'request', payload: { request_digest: digest(request) } },
    ...(plan ? [{ sequence: 2, type: 'plan', payload: { plan, plan_digest: planDigest } }] : []),
    ...toolTrace.map((item, index) => ({ sequence: 10 + index, type: item?.ok === false ? 'tool-result' : 'tool-call', payload: canonical(item) })),
    ...verification.map((item, index) => ({ sequence: 1000 + index, type: 'verification', payload: canonical(item) })),
    { sequence: 2000, type: 'outcome', payload: { status: clean(receipt.state || receipt.outcome || (headSha ? 'completed' : 'failed'), 80) } }
  ];
  const status = clean(receipt.state || receipt.outcome || (headSha ? 'completed' : 'failed'), 80).toLowerCase();
  return normalizeArchieTrajectory({
    schema: ARCHIE_TRAJECTORY_SCHEMA,
    subject: clean(receipt.subject || receipt.repository || receipt.task?.repository || 'maker', 500),
    request,
    provenance: {
      repository: clean(receipt.repository || receipt.task?.repository || 'unknown', 1000),
      branch: receipt.branch,
      base_sha: baseSha,
      head_sha: headSha || null,
      code_commit: headSha || null,
      request_digest: digest(request),
      plan_digest: planDigest,
      patch_digest: receipt.patch_digest || null,
      authority_digest: receipt.authority_digest || null,
      environment_digest: receipt.environment_digest || null,
      teacher: receipt.teacher || null,
      sources: receipt.sources || []
    },
    events,
    verification,
    outcome: {
      status: ['completed', 'failed', 'rejected', 'blocked', 'cancelled', 'partial'].includes(status) ? status : 'failed',
      summary: receipt.writer_summary || receipt.summary || '',
      negative: status !== 'completed',
      observed_at: receipt.finished_at || null
    },
    labels: ['maker-receipt', status === 'completed' ? 'positive' : 'negative'],
    recorded_at
  });
}

export function assessTrajectoryAdmission(trajectory, {
  require_independent_verification = true,
  require_patch_for_completed = true,
  require_head_for_completed = true
} = {}) {
  const normalized = normalizeArchieTrajectory(trajectory);
  const reasons = [];
  const completed = normalized.outcome.status === 'completed' && !normalized.outcome.negative;
  const passed = normalized.verification.filter(item => item.status === 'passed');
  const failed = normalized.verification.filter(item => item.status === 'failed' || item.status === 'blocked');
  if (failed.length) reasons.push('verification-failed-or-blocked');
  if (!passed.length) reasons.push('no-passed-verification');
  if (require_independent_verification && !passed.some(item => item.independent)) reasons.push('no-independent-passed-verification');
  if (completed && require_head_for_completed && !normalized.provenance.head_sha) reasons.push('completed-without-head-sha');
  if (completed && require_patch_for_completed && !normalized.provenance.patch_digest) reasons.push('completed-without-patch-digest');
  if (normalized.provenance.head_sha && normalized.provenance.base_sha === normalized.provenance.head_sha && completed) reasons.push('completed-without-tree-change');
  const disposition = reasons.length ? 'rejected' : completed ? 'admitted-positive' : 'admitted-negative';
  const body = {
    schema: ARCHIE_TRAJECTORY_ADMISSION_SCHEMA,
    trajectory_digest: normalized.trajectory_digest,
    disposition,
    admitted: reasons.length === 0,
    positive: reasons.length === 0 && completed,
    negative: reasons.length === 0 && !completed,
    reasons,
    verification_digests: passed.map(item => item.evidence_digest).filter(Boolean).sort()
  };
  return Object.freeze({ ...body, admission_digest: digest(body) });
}

export function createTrajectoryBatch(items, options = {}) {
  const entries = (Array.isArray(items) ? items : []).map(item => {
    const trajectory = normalizeArchieTrajectory(item);
    const admission = assessTrajectoryAdmission(trajectory, options);
    return { trajectory, admission };
  });
  const admitted = entries.filter(item => item.admission.admitted);
  const body = {
    schema: ARCHIE_TRAJECTORY_BATCH_SCHEMA,
    trajectories: admitted.map(item => item.trajectory).sort((left, right) => left.trajectory_digest.localeCompare(right.trajectory_digest)),
    admissions: entries.map(item => item.admission).sort((left, right) => left.trajectory_digest.localeCompare(right.trajectory_digest)),
    counts: {
      submitted: entries.length,
      admitted: admitted.length,
      positive: admitted.filter(item => item.admission.positive).length,
      negative: admitted.filter(item => item.admission.negative).length,
      rejected: entries.length - admitted.length
    }
  };
  return Object.freeze({ ...body, batch_digest: digest(body) });
}
