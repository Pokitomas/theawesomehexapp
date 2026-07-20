import {
  ADMITTED_MUTATION_RECEIPT_SCHEMA
} from './maker-executive-admission.mjs';
import {
  digest,
  stableJSONStringify
} from './maker-executive-state.mjs';

const SHA40 = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const clean = (value, limit = 8000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => [key, canonical(child)]));
}

function exact(value, pattern, label) {
  const normalized = clean(value, 1000).toLowerCase();
  if (!pattern.test(normalized)) throw new Error(`${label} must be an exact ${pattern === SHA40 ? '40-character commit SHA' : 'SHA-256 digest'}.`);
  return normalized;
}

function verifyReceipt(receipt) {
  if (receipt?.schema !== ADMITTED_MUTATION_RECEIPT_SCHEMA || receipt.status !== 'ready') {
    throw new Error('Lane completion requires an admitted ready mutation receipt.');
  }
  const claimed = exact(receipt.receipt_digest, SHA256, 'mutation_receipt.receipt_digest');
  const body = { ...receipt };
  delete body.receipt_digest;
  if (claimed !== digest(body)) throw new Error('Mutation receipt digest mismatch.');
  return receipt;
}

/**
 * Completion adapter for the normal case where a lane and its writer lease have
 * distinct identities. Callers should prefer this over the legacy identity-
 * coupled helper exported by maker-executive-admission.mjs.
 */
export function assertAdmittedLaneLeaseCompletion({
  lane,
  mutation_receipt,
  evidence = [],
  terminal_observed = false,
  terminal_evidence_digest
} = {}) {
  const receipt = verifyReceipt(mutation_receipt);
  const laneId = clean(lane?.id, 200);
  const leaseId = clean(lane?.lease_id, 200);
  if (!laneId || !leaseId) throw new Error('Lane completion requires distinct lane and lease identities.');
  if (receipt.lease_id !== leaseId) throw new Error('Mutation receipt is not bound to the lane writer lease.');
  if (lane.source_sha && receipt.source_sha !== exact(lane.source_sha, SHA40, 'lane.source_sha')) {
    throw new Error('Mutation receipt source SHA does not match the lane.');
  }
  const types = evidence.map(value => clean(value.type, 200));
  if (types.some(value => !value) || new Set(types).size !== types.length) {
    throw new Error('Completion evidence requires unique non-empty types.');
  }
  const present = new Set(types);
  for (const required of lane.required_evidence || []) {
    if (!present.has(clean(required, 500))) throw new Error(`Lane completion is missing evidence ${required}.`);
  }
  if (terminal_observed !== true) throw new Error('Lane terminal condition is not independently observed.');
  const body = canonical({
    lane_id: laneId,
    lease_id: leaseId,
    status: 'completed',
    receipt_digest: receipt.receipt_digest,
    terminal_evidence_digest: exact(terminal_evidence_digest, SHA256, 'terminal_evidence_digest')
  });
  return Object.freeze({ ...body, completion_digest: digest(body) });
}

export const completionIdentityBoundary = Object.freeze({
  lane_identity_separate_from_lease_identity: true,
  canonical_schema_input: stableJSONStringify({ lane_id: '<lane>', lease_id: '<lease>' })
});
