#!/usr/bin/env node
import crypto from 'node:crypto';

export const ARCHIE_OPERATOR_RECEIPT_SCHEMA = 'archie-operator-runtime-receipt/v1';
export const ARCHIE_OPERATOR_COMMAND_SCHEMA = 'archie-operator-command/v1';
const SECRET_KEY = /(?:^|[_-])(?:secret|token|password|authorization|cookie|private[_-]?key|api[_-]?key|credential|session)(?:$|[_-])/i;
const SECRET_TEXT = /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/-]{12,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)\b/i;
const clean = (value, limit = 20_000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const stable = value => JSON.stringify(canonical(value));
const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
const nowMs = clock => typeof clock === 'function' ? Number(clock()) : Date.now();

function assertNoSecrets(value, path = '$', depth = 0) {
  if (depth > 30) throw new Error(`Operator value nesting exceeded at ${path}.`);
  if (Array.isArray(value)) return value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`, depth + 1));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && SECRET_TEXT.test(value)) throw new Error(`Secret-like material rejected at ${path}.`);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key) && child !== null && child !== '' && child !== '[redacted]') throw new Error(`Unredacted secret-like field rejected at ${path}.${key}.`);
    assertNoSecrets(child, `${path}.${key}`, depth + 1);
  }
}

function receiptBody(receipt) {
  const { receipt_digest, ...body } = receipt;
  return body;
}

export function createOperatorRuntimeReceipt(payload, {
  source = 'authenticated-runtime',
  clock = Date.now,
  ttl_ms = 5 * 60_000,
  namespace = 'maker:archie'
} = {}) {
  assertNoSecrets(payload);
  const observed = nowMs(clock);
  const receipt = {
    schema: ARCHIE_OPERATOR_RECEIPT_SCHEMA,
    source: clean(source, 200),
    namespace: clean(namespace, 200),
    observed_at: new Date(observed).toISOString(),
    expires_at: new Date(observed + Math.max(1, Number(ttl_ms) || 1)).toISOString(),
    payload: canonical(payload)
  };
  receipt.payload_digest = digest(receipt.payload);
  receipt.receipt_digest = digest(receiptBody(receipt));
  return Object.freeze(receipt);
}

export function verifyOperatorRuntimeReceipt(receipt, { clock = Date.now, expected_namespace = 'maker:archie' } = {}) {
  if (!receipt || receipt.schema !== ARCHIE_OPERATOR_RECEIPT_SCHEMA) throw new Error('Unsupported Archie operator receipt schema.');
  assertNoSecrets(receipt);
  if (receipt.namespace !== expected_namespace) throw new Error('Operator namespace isolation rejected the receipt.');
  if (digest(receipt.payload) !== receipt.payload_digest) throw new Error('Operator receipt payload digest mismatch.');
  if (digest(receiptBody(receipt)) !== receipt.receipt_digest) throw new Error('Operator receipt digest mismatch.');
  const observed = Date.parse(receipt.observed_at);
  const expires = Date.parse(receipt.expires_at);
  const now = nowMs(clock);
  if (!Number.isFinite(observed) || !Number.isFinite(expires) || observed > now + 30_000) throw new Error('Operator receipt observation time is invalid.');
  if (expires <= now) throw new Error('Operator receipt is stale.');
  return true;
}

const state = (value, fallback = 'unobserved') => clean(value || fallback, 120).toLowerCase();
const nullableNumber = value => Number.isFinite(Number(value)) ? Number(value) : null;

export function projectOperatorView(receipt, options = {}) {
  verifyOperatorRuntimeReceipt(receipt, options);
  const p = receipt.payload || {};
  return Object.freeze({
    schema: 'archie-operator-view/v1',
    source: receipt.source,
    observed_at: receipt.observed_at,
    expires_at: receipt.expires_at,
    route: Object.freeze({
      sparse: state(p.route?.sparse),
      planner: state(p.route?.planner),
      selected: state(p.route?.selected),
      confidence: nullableNumber(p.route?.confidence),
      margin: nullableNumber(p.route?.margin)
    }),
    budget: Object.freeze({
      decision: state(p.budget?.decision),
      charged_credits: nullableNumber(p.budget?.charged_credits),
      usage_evidence: state(p.budget?.usage_evidence)
    }),
    teacher: Object.freeze({
      state: state(p.teacher?.state),
      reason: clean(p.teacher?.reason || 'unobserved', 500)
    }),
    learning: Object.freeze({
      lesson: state(p.learning?.lesson),
      retraining: state(p.learning?.retraining)
    }),
    corpus: Object.freeze({
      health: state(p.corpus?.health),
      pack: state(p.corpus?.pack),
      pack_digest: /^[a-f0-9]{64}$/.test(p.corpus?.pack_digest || '') ? p.corpus.pack_digest : null
    }),
    sync: Object.freeze({
      state: state(p.sync?.state),
      generation: Number.isSafeInteger(p.sync?.generation) ? p.sync.generation : null,
      relay_plaintext_authority: false
    }),
    compute: Object.freeze({
      selected: state(p.compute?.selected),
      ladder: Array.isArray(p.compute?.ladder) ? p.compute.ladder.slice(0, 12).map(item => ({ kind: state(item.kind), state: state(item.state), evidence: clean(item.evidence || 'unobserved', 300) })) : [],
      gpu: state(p.compute?.gpu),
      linux: state(p.compute?.linux),
      storage: state(p.compute?.storage)
    }),
    blockers: Array.isArray(p.blockers) ? p.blockers.slice(0, 30).map(item => clean(item, 500)).filter(Boolean) : [],
    execution_claimed_by_browser: false
  });
}

export function emptyOperatorView() {
  return Object.freeze({
    schema: 'archie-operator-view/v1', source: 'none', observed_at: null, expires_at: null,
    route: { sparse: 'unobserved', planner: 'unobserved', selected: 'unobserved', confidence: null, margin: null },
    budget: { decision: 'unobserved', charged_credits: null, usage_evidence: 'unobserved' },
    teacher: { state: 'unobserved', reason: 'No authenticated runtime receipt loaded.' },
    learning: { lesson: 'unobserved', retraining: 'unobserved' },
    corpus: { health: 'unobserved', pack: 'unobserved', pack_digest: null },
    sync: { state: 'unobserved', generation: null, relay_plaintext_authority: false },
    compute: { selected: 'unobserved', ladder: [], gpu: 'unavailable-until-observed', linux: 'unavailable-until-observed', storage: 'unavailable-until-observed' },
    blockers: ['No authenticated runtime receipt loaded.'], execution_claimed_by_browser: false
  });
}

export function createOperatorCommandPacket(operation, payload = {}, {
  namespace = 'maker:archie', clock = Date.now
} = {}) {
  const op = clean(operation, 120);
  if (!['export_pack', 'import_pack', 'sync', 'run_task', 'retrain', 'refresh_receipt'].includes(op)) throw new Error('Unsupported operator command operation.');
  assertNoSecrets(payload);
  const body = {
    schema: ARCHIE_OPERATOR_COMMAND_SCHEMA,
    namespace: clean(namespace, 200),
    created_at: new Date(nowMs(clock)).toISOString(),
    operation: op,
    payload: canonical(payload),
    execution_claimed: false,
    requires_authenticated_runtime: true,
    requires_explicit_authority: true
  };
  return Object.freeze({ ...body, command_digest: digest(body) });
}

export function verifyOperatorCommandPacket(packet) {
  assertNoSecrets(packet);
  if (!packet || packet.schema !== ARCHIE_OPERATOR_COMMAND_SCHEMA || packet.execution_claimed !== false) throw new Error('Invalid operator command packet.');
  const { command_digest, ...body } = packet;
  if (digest(body) !== command_digest) throw new Error('Operator command packet digest mismatch.');
  return true;
}
