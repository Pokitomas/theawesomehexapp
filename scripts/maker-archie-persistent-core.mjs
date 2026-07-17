#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ARCHIE_WORKING_STATE_SCHEMA = 'archie-working-state/v1';
export const ARCHIE_OBSERVATION_SCHEMA = 'archie-observation/v1';
export const ARCHIE_CANDIDATE_MOVE_SCHEMA = 'archie-candidate-move/v1';
export const ARCHIE_CAPACITY_ESTIMATE_SCHEMA = 'archie-capacity-estimate/v1';
export const ARCHIE_PERSISTENT_CYCLE_SCHEMA = 'archie-persistent-cycle/v1';
export const ARCHIE_TRAINER_PROPOSAL_SCHEMA = 'archie-trainer-proposal/v1';

const EFFECT_CLASSES = new Set(['internal', 'external', 'durable-training', 'no-op']);
const clean = (value, limit = 200000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const canonical = value => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    : value;
const stable = value => JSON.stringify(canonical(value));
const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, finite(value)));
}

function without(value, key) {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

async function writeAtomic(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, filename);
}

function bounded(items, value, limit = 1000) {
  return [...items, value].slice(-Math.max(1, limit));
}

export function normalizeArchieObservation(value = {}, { clock = Date.now } = {}) {
  const payload = value?.payload ?? value?.value ?? null;
  const body = {
    schema: ARCHIE_OBSERVATION_SCHEMA,
    observed_at: clean(value?.observed_at || new Date(clock()).toISOString(), 100),
    source: clean(value?.source || 'unknown', 300),
    kind: clean(value?.kind || 'observation', 300),
    payload,
    evidence: value?.evidence ?? null
  };
  return Object.freeze({ ...body, observation_digest: digest(body) });
}

export function normalizeArchieCandidateMove(value = {}, { index = 0 } = {}) {
  const kind = clean(value?.kind || value?.type || '', 300);
  if (!kind) throw new Error('Archie candidate move kind is required.');
  const requestedEffect = clean(value?.effect_class || (kind === 'no-op' ? 'no-op' : 'internal'), 100);
  if (!EFFECT_CLASSES.has(requestedEffect)) throw new Error(`Unsupported Archie effect class: ${requestedEffect}.`);
  const effectClass = kind === 'no-op' ? 'no-op' : requestedEffect;
  const body = {
    schema: ARCHIE_CANDIDATE_MOVE_SCHEMA,
    kind,
    effect_class: effectClass,
    description: clean(value?.description || '', 5000),
    proposal: value?.proposal ?? null,
    expected_evidence: value?.expected_evidence ?? null,
    constraints: value?.constraints ?? null,
    provenance: value?.provenance ?? null,
    sequence: Number.isInteger(value?.sequence) ? value.sequence : index + 1
  };
  return Object.freeze({ ...body, candidate_id: clean(value?.candidate_id, 300) || `move_${digest(body).slice(0, 24)}` });
}

export function normalizeArchieCapacityEstimate(value = {}, { candidateId = '' } = {}) {
  const utility = finite(value?.utility, Number.NaN);
  if (!Number.isFinite(utility)) throw new Error('Archie capacity estimate utility must be finite.');
  const body = {
    schema: ARCHIE_CAPACITY_ESTIMATE_SCHEMA,
    candidate_id: clean(value?.candidate_id || candidateId, 300),
    utility,
    expected_capacity_gain: finite(value?.expected_capacity_gain, utility),
    verification_probability: clamp(value?.verification_probability ?? 0),
    uncertainty: clamp(value?.uncertainty ?? 1),
    future_option_value: finite(value?.future_option_value, 0),
    human_value: finite(value?.human_value, 0),
    resource_cost: Math.max(0, finite(value?.resource_cost, 0)),
    irreversibility: clamp(value?.irreversibility ?? 0),
    evidence: value?.evidence ?? null,
    estimator: clean(value?.estimator || 'unspecified', 300)
  };
  return Object.freeze({ ...body, estimate_digest: digest(body) });
}

function initialWorkingState({ coreId, clock }) {
  const now = new Date(clock()).toISOString();
  const body = {
    schema: ARCHIE_WORKING_STATE_SCHEMA,
    core_id: clean(coreId || 'archie-core', 300),
    revision: 0,
    created_at: now,
    updated_at: now,
    observations: [],
    active_questions: [],
    hypotheses: [],
    commitments: [],
    uncertainties: [],
    trainer_proposals: [],
    cycles: [],
    custom: {}
  };
  return Object.freeze({ ...body, state_digest: digest(body) });
}

export function validateArchieWorkingState(value) {
  if (value?.schema !== ARCHIE_WORKING_STATE_SCHEMA) throw new Error('Invalid Archie working-state schema.');
  if (!clean(value?.core_id, 300)) throw new Error('Archie working state core_id is required.');
  if (!Number.isInteger(value?.revision) || value.revision < 0) throw new Error('Archie working-state revision is invalid.');
  if (value?.state_digest !== digest(without(value, 'state_digest'))) throw new Error('Archie working-state integrity check failed.');
  return value;
}

export class ArchieWorkingStateStore {
  constructor({ root, core_id = 'archie-core', clock = Date.now } = {}) {
    if (!root) throw new Error('Archie working-state root is required.');
    this.root = path.resolve(root);
    this.filename = path.join(this.root, 'working-state.json');
    this.coreId = clean(core_id, 300) || 'archie-core';
    this.clock = clock;
  }

  async load() {
    try {
      return validateArchieWorkingState(JSON.parse(await fs.readFile(this.filename, 'utf8')));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const state = initialWorkingState({ coreId: this.coreId, clock: this.clock });
      await writeAtomic(this.filename, state);
      return state;
    }
  }

  async save(value) {
    const prior = await this.load();
    const now = new Date(this.clock()).toISOString();
    const body = {
      ...without(value, 'state_digest'),
      schema: ARCHIE_WORKING_STATE_SCHEMA,
      core_id: prior.core_id,
      revision: prior.revision + 1,
      created_at: prior.created_at,
      updated_at: now
    };
    const state = Object.freeze({ ...body, state_digest: digest(body) });
    validateArchieWorkingState(state);
    await writeAtomic(this.filename, state);
    return state;
  }
}

function noOpCandidate(reason = 'no admissible capacity-increasing move') {
  return normalizeArchieCandidateMove({
    kind: 'no-op',
    effect_class: 'no-op',
    description: reason,
    provenance: { system: 'archie-persistent-core' }
  });
}

function candidateRank(left, right) {
  return right.estimate.utility - left.estimate.utility
    || right.estimate.verification_probability - left.estimate.verification_probability
    || left.estimate.uncertainty - right.estimate.uncertainty
    || left.candidate.candidate_id.localeCompare(right.candidate.candidate_id);
}

async function authorizeCandidate(candidate, context, { allowExternal, authority }) {
  if (candidate.effect_class === 'no-op' || candidate.effect_class === 'internal' || candidate.effect_class === 'durable-training') {
    return Object.freeze({ admitted: true, reason: null, receipt: null });
  }
  if (!allowExternal) return Object.freeze({ admitted: false, reason: 'external-effects-disabled', receipt: null });
  if (!authority) return Object.freeze({ admitted: false, reason: 'authority-unavailable', receipt: null });
  const result = typeof authority === 'function'
    ? await authority(candidate, context)
    : typeof authority?.authorize === 'function'
      ? await authority.authorize(candidate, context)
      : null;
  const admitted = result === true || result?.admitted === true || result?.authorized === true;
  return Object.freeze({ admitted, reason: admitted ? null : clean(result?.reason || 'authority-denied', 1000), receipt: result && result !== true ? result : null });
}

export class ArchiePersistentCore {
  constructor({
    root,
    core_id = 'archie-core',
    clock = Date.now,
    candidate_generator = null,
    capacity_estimator = null,
    authority = null,
    executor = null,
    state_store = null,
    limits = {}
  } = {}) {
    if (!root && !state_store) throw new Error('Archie persistent core root or state_store is required.');
    if (candidate_generator && typeof candidate_generator !== 'function') throw new Error('Archie candidate_generator must be a function.');
    if (capacity_estimator && typeof capacity_estimator !== 'function') throw new Error('Archie capacity_estimator must be a function.');
    if (executor && typeof executor !== 'function') throw new Error('Archie executor must be a function.');
    this.clock = clock;
    this.generator = candidate_generator;
    this.estimator = capacity_estimator;
    this.authority = authority;
    this.executor = executor;
    this.store = state_store || new ArchieWorkingStateStore({ root, core_id, clock });
    this.limits = Object.freeze({ observations: Number(limits.observations || 1000), cycles: Number(limits.cycles || 1000), trainer_proposals: Number(limits.trainer_proposals || 500) });
  }

  async state() {
    return this.store.load();
  }

  async cycle({ observations = [], stimulus = null, trigger = 'internal', allow_external = false, context = {} } = {}) {
    const startedAt = new Date(this.clock()).toISOString();
    const prior = await this.store.load();
    const normalizedObservations = (Array.isArray(observations) ? observations : [observations]).filter(Boolean).map(value => normalizeArchieObservation(value, { clock: this.clock }));
    if (stimulus !== null && stimulus !== undefined) {
      normalizedObservations.push(normalizeArchieObservation({ source: 'stimulus', kind: clean(trigger, 300) || 'stimulus', payload: stimulus }, { clock: this.clock }));
    }
    const observedState = {
      ...prior,
      observations: normalizedObservations.reduce((items, item) => bounded(items, item, this.limits.observations), prior.observations)
    };
    const generationContext = Object.freeze({ trigger: clean(trigger, 300) || 'internal', context, observed_at: startedAt });
    const generated = this.generator ? await this.generator(Object.freeze(observedState), generationContext) : [];
    const candidates = (Array.isArray(generated) ? generated : generated?.candidates || []).map((value, index) => normalizeArchieCandidateMove(value, { index }));
    if (!candidates.some(candidate => candidate.effect_class === 'no-op')) candidates.push(noOpCandidate(this.generator ? 'generated moves may be declined' : 'candidate generator unavailable'));

    const evaluated = [];
    const rejected = [];
    for (const candidate of candidates) {
      let estimate;
      if (candidate.effect_class === 'no-op') {
        estimate = normalizeArchieCapacityEstimate({ utility: 0, expected_capacity_gain: 0, verification_probability: 1, uncertainty: 0, estimator: 'no-op-baseline', evidence: { reason: candidate.description } }, { candidateId: candidate.candidate_id });
      } else if (!this.estimator) {
        rejected.push({ candidate_id: candidate.candidate_id, reason: 'capacity-estimator-unavailable' });
        continue;
      } else {
        estimate = normalizeArchieCapacityEstimate(await this.estimator(candidate, Object.freeze(observedState), generationContext), { candidateId: candidate.candidate_id });
      }
      const authorization = await authorizeCandidate(candidate, { state: observedState, estimate, ...generationContext }, { allowExternal: allow_external, authority: this.authority });
      if (!authorization.admitted) {
        rejected.push({ candidate_id: candidate.candidate_id, reason: authorization.reason, authority_receipt: authorization.receipt });
        continue;
      }
      if (candidate.effect_class === 'external' && !this.executor) {
        rejected.push({ candidate_id: candidate.candidate_id, reason: 'executor-unavailable', authority_receipt: authorization.receipt });
        continue;
      }
      evaluated.push({ candidate, estimate, authority_receipt: authorization.receipt });
    }

    evaluated.sort(candidateRank);
    const selected = evaluated[0] || { candidate: noOpCandidate('no candidate survived estimation and authority'), estimate: normalizeArchieCapacityEstimate({ utility: 0, verification_probability: 1, uncertainty: 0, estimator: 'fail-closed-no-op' }) };
    let disposition = 'no-op';
    let result = null;
    let trainerProposal = null;
    if (selected.candidate.effect_class === 'durable-training') {
      const body = {
        schema: ARCHIE_TRAINER_PROPOSAL_SCHEMA,
        proposed_at: startedAt,
        core_state_digest: prior.state_digest,
        candidate: selected.candidate,
        capacity_estimate: selected.estimate,
        status: 'proposal-only',
        protect: 'Only Archie Trainer may create or activate durable brain changes.'
      };
      trainerProposal = Object.freeze({ ...body, proposal_digest: digest(body) });
      disposition = 'propose-to-trainer';
      result = trainerProposal;
    } else if (selected.candidate.effect_class === 'internal') {
      disposition = this.executor ? 'internal-executed' : 'retained-in-working-state';
      result = this.executor ? await this.executor(selected.candidate, { state: observedState, estimate: selected.estimate, ...generationContext }) : null;
    } else if (selected.candidate.effect_class === 'external') {
      disposition = 'external-executed';
      result = await this.executor(selected.candidate, { state: observedState, estimate: selected.estimate, authority_receipt: selected.authority_receipt, ...generationContext });
    }

    const cycleBody = {
      schema: ARCHIE_PERSISTENT_CYCLE_SCHEMA,
      started_at: startedAt,
      trigger: generationContext.trigger,
      prior_state_digest: prior.state_digest,
      observation_digests: normalizedObservations.map(item => item.observation_digest),
      candidates: evaluated.map(item => ({ candidate: item.candidate, capacity_estimate: item.estimate, authority_receipt: item.authority_receipt || null })),
      rejected,
      selected: { candidate: selected.candidate, capacity_estimate: selected.estimate },
      disposition,
      result
    };
    const cycleReceipt = Object.freeze({ ...cycleBody, cycle_digest: digest(cycleBody) });
    const next = await this.store.save({
      ...observedState,
      trainer_proposals: trainerProposal ? bounded(prior.trainer_proposals, trainerProposal, this.limits.trainer_proposals) : prior.trainer_proposals,
      cycles: bounded(prior.cycles, cycleReceipt, this.limits.cycles)
    });
    return Object.freeze({ ...cycleReceipt, next_state_digest: next.state_digest, state_revision: next.revision });
  }
}

export function createArchiePersistentCore(options) {
  return new ArchiePersistentCore(options);
}

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const root = argument('--root', process.env.ARCHIE_PERSISTENT_ROOT || '');
  if (!root) throw new Error('Usage: maker-archie-persistent-core.mjs --root <directory> [--stimulus <json-or-text>]');
  const raw = argument('--stimulus', '');
  let stimulus = raw || null;
  if (raw) {
    try { stimulus = JSON.parse(raw); } catch {}
  }
  const core = createArchiePersistentCore({ root });
  console.log(JSON.stringify(await core.cycle({ stimulus, trigger: raw ? 'manual-stimulus' : 'internal' }), null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}
