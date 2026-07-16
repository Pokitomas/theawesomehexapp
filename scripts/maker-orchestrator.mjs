import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { digest, normalizeRelativePath, redactSecrets } from './maker-security-policy.mjs';

const ORCHESTRATOR_SCHEMA = 'sideways-maker-orchestrator/v1';
const STATE_SCHEMA = 'sideways-maker-orchestrator-state/v1';
const RECEIPT_SCHEMA = 'sideways-maker-orchestrator-receipt/v1';
const PLAN_SCHEMA = 'sideways-maker-orchestration-plan/v1';
const TERMINAL = new Set(['cancelled', 'ready_for_human', 'blocked']);
const FINDING_KINDS = new Set(['claim', 'evidence', 'uncertainty', 'contradiction', 'question', 'risk', 'recommendation', 'negative_result']);
const DEFAULT_ROLES = Object.freeze([
  { role: 'architecture', question: 'Map architecture, boundaries, and likely change impact.' },
  { role: 'product', question: 'Trace the user journey and acceptance behavior.' },
  { role: 'verification', question: 'Map tests, workflows, failure modes, and executable proof.' },
  { role: 'security', question: 'Find authority, secret, sandbox, dependency, and operational risks.' }
]);

const clean = (value, limit = 20000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const nowISO = () => new Date().toISOString();
const sortedUnique = values => [...new Set(values)].sort();

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]));
}

function stableJSONStringify(value) {
  return JSON.stringify(canonical(value));
}

function safeId(value, fallback) {
  const id = clean(value || fallback, 200).replace(/[^A-Za-z0-9._:-]/g, '-');
  if (!id || id === '.' || id === '..') throw new Error('Orchestration identifier is invalid.');
  return id;
}

function normalizeBudget(input = {}) {
  const bounded = (value, fallback, min, max) => Math.max(min, Math.min(max, Number(value ?? fallback)));
  return Object.freeze({
    max_assignments: bounded(input.max_assignments, 24, 1, 500),
    max_depth: bounded(input.max_depth, 3, 0, 12),
    max_events: bounded(input.max_events, 5000, 50, 100000),
    max_model_calls: bounded(input.max_model_calls, 100, 1, 10000),
    max_reported_tokens: bounded(input.max_reported_tokens, 2000000, 1, 1000000000),
    max_worker_attempts: bounded(input.max_worker_attempts, 3, 1, 12),
    max_wall_ms: bounded(input.max_wall_ms, 6 * 60 * 60 * 1000, 1000, 7 * 24 * 60 * 60 * 1000),
    assessment_concurrency: bounded(input.assessment_concurrency, 4, 1, 32)
  });
}

function emptyUsage() {
  return { model_calls: 0, tokens_in: 0, tokens_out: 0, wall_ms: 0, unreported_calls: 0 };
}

function normalizeUsage(input = {}, invocationOccurred = true) {
  const hasTokenReport = Number.isFinite(Number(input.tokens_in)) || Number.isFinite(Number(input.tokens_out));
  return {
    model_calls: Math.max(0, Number(input.model_calls ?? (invocationOccurred ? 1 : 0)) || 0),
    tokens_in: Math.max(0, Number(input.tokens_in) || 0),
    tokens_out: Math.max(0, Number(input.tokens_out) || 0),
    wall_ms: Math.max(0, Number(input.wall_ms) || 0),
    unreported_calls: invocationOccurred && !hasTokenReport ? 1 : Math.max(0, Number(input.unreported_calls) || 0)
  };
}

function addUsage(left, right) {
  return {
    model_calls: left.model_calls + right.model_calls,
    tokens_in: left.tokens_in + right.tokens_in,
    tokens_out: left.tokens_out + right.tokens_out,
    wall_ms: left.wall_ms + right.wall_ms,
    unreported_calls: left.unreported_calls + right.unreported_calls
  };
}

function assertExternalStatePath(root, statePath) {
  if (!statePath) throw new Error('Orchestrator requires an external state path.');
  const target = path.resolve(statePath);
  if (root) {
    const repository = path.resolve(root);
    if (target === repository || target.startsWith(`${repository}${path.sep}`)) throw new Error('Orchestrator state must remain outside the repository checkout.');
  }
  return target;
}

async function writeAtomic(fsImpl, filename, value) {
  await fsImpl.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  await fsImpl.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fsImpl.rename(temporary, filename);
}

function eventDigest(event) {
  return digest({ sequence: event.sequence, at: event.at, type: event.type, payload: event.payload, previous_digest: event.previous_digest });
}

export function verifyOrchestrationEvents(events = []) {
  let previous = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.sequence !== index + 1) throw new Error(`Orchestrator event sequence mismatch at ${index + 1}.`);
    if ((event.previous_digest || null) !== previous) throw new Error(`Orchestrator event predecessor mismatch at ${index + 1}.`);
    if (event.digest !== eventDigest(event)) throw new Error(`Orchestrator event digest mismatch at ${index + 1}.`);
    previous = event.digest;
  }
  return previous;
}

function normalizeTask(input = {}, idFactory = () => crypto.randomUUID()) {
  const repository = clean(input.repository, 300);
  const baseSha = clean(input.base_sha, 40).toLowerCase();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Orchestration task requires owner/repository.');
  if (!/^[0-9a-f]{40}$/.test(baseSha)) throw new Error('Orchestration task requires an exact base SHA.');
  const goal = clean(redactSecrets(input.goal || input.request), 10000);
  if (!goal) throw new Error('Orchestration task requires a goal.');
  const roles = (input.roles?.length ? input.roles : DEFAULT_ROLES).map((value, index) => ({
    assignment_id: safeId(value.assignment_id, `assessment-${index + 1}`),
    role: clean(value.role, 160),
    question: clean(redactSecrets(value.question), 3000),
    depth: 0,
    parent_assignment_id: null,
    target_ids: sortedUnique((value.target_ids || []).map(item => clean(item, 200)).filter(Boolean))
  }));
  if (roles.some(value => !value.role || !value.question)) throw new Error('Assessment roles require role and question.');
  const task = {
    task_id: safeId(input.task_id, `task-${idFactory()}`),
    repository,
    base_sha: baseSha,
    branch: clean(input.branch || 'main', 240),
    goal,
    protect: clean(redactSecrets(input.protect), 6000) || null,
    proof: clean(redactSecrets(input.proof), 6000) || null,
    repository_map_digest: clean(input.repository_map_digest, 64) || null,
    roles,
    human_gates: Object.freeze(['merge', 'deploy', 'production_data', 'repository_settings', 'secrets', 'training_spend'])
  };
  return Object.freeze(task);
}

function normalizeFinding(input = {}, assignment) {
  const kind = clean(input.kind || 'claim', 80).toLowerCase();
  if (!FINDING_KINDS.has(kind)) throw new Error(`Unsupported specialist finding kind: ${kind}.`);
  const finding = {
    finding_id: safeId(input.finding_id, `${assignment.assignment_id}:${kind}:${digest(input).slice(0, 16)}`),
    assignment_id: assignment.assignment_id,
    role: assignment.role,
    depth: assignment.depth,
    kind,
    statement: clean(redactSecrets(input.statement || input.body), 6000),
    confidence: input.confidence === undefined ? null : Math.max(0, Math.min(1, Number(input.confidence))),
    evidence: Array.isArray(input.evidence) ? redactSecrets(input.evidence).slice(0, 100) : [],
    contradicts: sortedUnique((input.contradicts || []).map(value => clean(value, 200)).filter(Boolean)),
    source_paths: sortedUnique((input.source_paths || []).map(normalizeRelativePath)),
    next_test: clean(redactSecrets(input.next_test), 2000) || null
  };
  if (!finding.statement) throw new Error('Specialist finding requires a statement.');
  return Object.freeze(finding);
}

function normalizeFollowup(input = {}, parent, index) {
  return Object.freeze({
    assignment_id: safeId(input.assignment_id, `${parent.assignment_id}:followup-${index + 1}`),
    role: clean(input.role || parent.role, 160),
    question: clean(redactSecrets(input.question), 3000),
    depth: parent.depth + 1,
    parent_assignment_id: parent.assignment_id,
    target_ids: sortedUnique((input.target_ids || []).map(value => clean(value, 200)).filter(Boolean))
  });
}

function normalizeLeasePath(value) {
  const raw = clean(value, 1000).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (raw === '**') return raw;
  const recursive = raw.endsWith('/**');
  const base = recursive ? raw.slice(0, -3) : raw;
  const normalized = normalizeRelativePath(base);
  return recursive ? `${normalized}/**` : normalized;
}

function pathsOverlap(left, right) {
  if (left === '**' || right === '**') return true;
  const leftRecursive = left.endsWith('/**');
  const rightRecursive = right.endsWith('/**');
  const a = leftRecursive ? left.slice(0, -3) : left;
  const b = rightRecursive ? right.slice(0, -3) : right;
  if (a === b) return true;
  if (leftRecursive && b.startsWith(`${a}/`)) return true;
  if (rightRecursive && a.startsWith(`${b}/`)) return true;
  return false;
}

function normalizeLane(input = {}, index = 0) {
  const lane = {
    lane_id: safeId(input.lane_id || input.id, `lane-${index + 1}`),
    title: clean(input.title, 500) || `Lane ${index + 1}`,
    request: clean(redactSecrets(input.request), 6000),
    proof: clean(redactSecrets(input.proof), 4000) || null,
    owned_paths: sortedUnique((input.owned_paths || []).map(normalizeLeasePath)),
    depends_on: sortedUnique((input.depends_on || []).map(value => safeId(value, ''))),
    human_gate: input.human_gate === true,
    gate_kind: input.human_gate === true ? clean(input.gate_kind || 'approval', 120) : null,
    max_attempts: Math.max(1, Math.min(12, Number(input.max_attempts || 0) || 0)) || null
  };
  if (!lane.request) throw new Error(`Orchestration lane ${lane.lane_id} requires a request.`);
  if (!lane.human_gate && !lane.owned_paths.length) throw new Error(`Executable lane ${lane.lane_id} requires owned paths.`);
  return Object.freeze(lane);
}

function topologicalOrder(lanes) {
  const map = new Map(lanes.map(lane => [lane.lane_id, lane]));
  for (const lane of lanes) for (const dependency of lane.depends_on) if (!map.has(dependency)) throw new Error(`Lane ${lane.lane_id} depends on unknown lane ${dependency}.`);
  const visited = new Set();
  const visiting = new Set();
  const ordered = [];
  const visit = lane => {
    if (visited.has(lane.lane_id)) return;
    if (visiting.has(lane.lane_id)) throw new Error(`Orchestration lane dependency cycle at ${lane.lane_id}.`);
    visiting.add(lane.lane_id);
    for (const dependency of lane.depends_on) visit(map.get(dependency));
    visiting.delete(lane.lane_id);
    visited.add(lane.lane_id);
    ordered.push(lane);
  };
  for (const lane of lanes) visit(lane);
  return ordered;
}

export function normalizeOrchestrationPlan(input = {}, { base_sha, branch } = {}) {
  const lanes = (input.lanes || []).map(normalizeLane);
  if (!lanes.length) throw new Error('Orchestration synthesis requires at least one lane.');
  const ids = new Set();
  for (const lane of lanes) {
    if (ids.has(lane.lane_id)) throw new Error(`Duplicate orchestration lane: ${lane.lane_id}.`);
    ids.add(lane.lane_id);
  }
  for (let leftIndex = 0; leftIndex < lanes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < lanes.length; rightIndex += 1) {
      for (const leftPath of lanes[leftIndex].owned_paths) for (const rightPath of lanes[rightIndex].owned_paths) {
        if (pathsOverlap(leftPath, rightPath)) throw new Error(`Orchestration path collision: ${leftPath} overlaps ${rightPath}.`);
      }
    }
  }
  const ordered = topologicalOrder(lanes);
  const body = {
    schema: PLAN_SCHEMA,
    base_sha: clean(base_sha || input.base_sha, 40).toLowerCase(),
    branch: clean(branch || input.branch, 240),
    summary: clean(redactSecrets(input.summary), 6000) || null,
    preserved_contradictions: sortedUnique((input.preserved_contradictions || []).map(value => clean(value, 200)).filter(Boolean)),
    lanes: ordered,
    created_from_finding_ids: sortedUnique((input.created_from_finding_ids || []).map(value => clean(value, 200)).filter(Boolean))
  };
  if (!/^[0-9a-f]{40}$/.test(body.base_sha) || !body.branch) throw new Error('Orchestration plan requires exact base and branch identity.');
  return Object.freeze({ ...body, plan_digest: digest(body) });
}

function normalizeWorkerResult(input = {}, lane, task) {
  const result = {
    status: clean(input.status, 80).toLowerCase(),
    lane_id: lane.lane_id,
    repository: clean(input.repository || task.repository, 300),
    base_sha: clean(input.base_sha, 40).toLowerCase(),
    branch: clean(input.branch, 240),
    head_sha: clean(input.head_sha, 40).toLowerCase() || null,
    changed_paths: sortedUnique((input.changed_paths || []).map(normalizeRelativePath)),
    witnesses: (input.witnesses || []).map(value => ({ name: clean(value.name, 500), ok: value.ok === true, evidence: clean(redactSecrets(value.evidence), 2000) || null })),
    summary: clean(redactSecrets(input.summary), 4000) || null,
    failure: clean(redactSecrets(input.failure || input.error), 3000) || null,
    receipt_digest: clean(input.receipt_digest, 64) || null,
    usage: normalizeUsage(input.usage)
  };
  if (result.repository !== task.repository || result.base_sha !== task.base_sha) throw new Error(`Worker result identity differs for ${lane.lane_id}.`);
  if (!result.branch) throw new Error(`Worker result branch is missing for ${lane.lane_id}.`);
  if (result.changed_paths.some(file => !lane.owned_paths.some(pattern => pathsOverlap(file, pattern)))) throw new Error(`Worker changed an unleased path for ${lane.lane_id}.`);
  if (result.status === 'finished') {
    if (!/^[0-9a-f]{40}$/.test(result.head_sha || '')) throw new Error(`Finished worker lacks exact head SHA for ${lane.lane_id}.`);
    if (!result.witnesses.length || result.witnesses.some(value => !value.ok)) throw new Error(`Finished worker lacks passing witnesses for ${lane.lane_id}.`);
    if (!/^[0-9a-f]{64}$/.test(result.receipt_digest || '')) throw new Error(`Finished worker lacks evidence receipt for ${lane.lane_id}.`);
  }
  return Object.freeze(result);
}

function budgetExceeded(state) {
  const usage = state.usage;
  const budget = state.budget;
  if (state.events.length >= budget.max_events) return 'event budget exhausted';
  if (usage.model_calls >= budget.max_model_calls) return 'model-call budget exhausted';
  if (usage.tokens_in + usage.tokens_out >= budget.max_reported_tokens) return 'reported-token budget exhausted';
  if (usage.wall_ms >= budget.max_wall_ms) return 'wall-time budget exhausted';
  return null;
}

export class MakerOrchestrator {
  constructor({ state_path, root = null, fs_impl = fs, clock = nowISO, id_factory = () => crypto.randomUUID() } = {}) {
    this.statePath = assertExternalStatePath(root, state_path);
    this.root = root ? path.resolve(root) : null;
    this.fs = fs_impl;
    this.clock = clock;
    this.idFactory = id_factory;
    this.state = null;
  }

  async #persist() {
    await writeAtomic(this.fs, this.statePath, this.state);
  }

  async #append(type, payload = {}) {
    const previous = this.state.events.at(-1)?.digest || null;
    const event = {
      sequence: this.state.events.length + 1,
      at: this.clock(),
      type: clean(type, 160),
      payload: redactSecrets(payload),
      previous_digest: previous
    };
    event.digest = eventDigest(event);
    this.state.events.push(Object.freeze(event));
    this.state.updated_at = this.clock();
    await this.#persist();
    return event;
  }

  #assertActive() {
    if (!this.state) throw new Error('Orchestrator task is not loaded.');
    if (TERMINAL.has(this.state.status)) throw new Error(`Orchestrator task is terminal: ${this.state.status}.`);
  }

  async create(input = {}) {
    if (await exists(this.fs, this.statePath)) throw new Error('Orchestrator state already exists; resume it instead.');
    const task = normalizeTask(input, this.idFactory);
    this.state = {
      schema: STATE_SCHEMA,
      task,
      budget: normalizeBudget(input.budget),
      usage: emptyUsage(),
      status: 'assessing',
      paused: false,
      cancel_reason: null,
      created_at: this.clock(),
      updated_at: null,
      events: [],
      assignments: task.roles.map(value => ({ ...value, status: 'queued', attempts: 0, result_digest: null })),
      findings: [],
      synthesis_count: 0,
      plan: null,
      lanes: [],
      verification: null,
      human_gate: null,
      receipt: null
    };
    await this.#append('task.created', { task, budget: this.state.budget });
    return this.snapshot();
  }

  async resume() {
    const state = JSON.parse(await this.fs.readFile(this.statePath, 'utf8'));
    if (state?.schema !== STATE_SCHEMA) throw new Error('Unsupported orchestrator state.');
    verifyOrchestrationEvents(state.events || []);
    state.usage = { ...emptyUsage(), ...(state.usage || {}) };
    this.state = state;
    await this.#append('task.resumed', { status: state.status, paused: state.paused });
    return this.snapshot();
  }

  async #recordUsage(usageInput, source) {
    const usage = normalizeUsage(usageInput);
    this.state.usage = addUsage(this.state.usage, usage);
    await this.#append('usage.recorded', { source, usage, total: this.state.usage });
    const exceeded = budgetExceeded(this.state);
    if (exceeded) {
      this.state.status = 'blocked';
      await this.#append('budget.exhausted', { reason: exceeded, usage: this.state.usage, budget: this.state.budget });
      throw new Error(exceeded);
    }
  }

  async #invoke(adapter, packet, kind) {
    if (!adapter?.execute) throw new Error(`${kind} adapter is unavailable.`);
    const invocationId = `${kind}-${this.idFactory()}`;
    await this.#append('adapter.started', { invocation_id: invocationId, kind, packet_digest: digest(packet) });
    const started = Date.now();
    try {
      const output = await adapter.execute(packet);
      const usage = { ...(output?.usage || {}), wall_ms: Number(output?.usage?.wall_ms) || Math.max(0, Date.now() - started) };
      await this.#recordUsage(usage, invocationId);
      await this.#append('adapter.finished', { invocation_id: invocationId, kind, output_digest: digest(redactSecrets(output)), status: clean(output?.status || 'completed', 80) });
      return output;
    } catch (error) {
      const usage = { wall_ms: Math.max(0, Date.now() - started), model_calls: 0, unreported_calls: 0 };
      this.state.usage = addUsage(this.state.usage, normalizeUsage(usage, false));
      await this.#append('adapter.failed', { invocation_id: invocationId, kind, error: clean(redactSecrets(error?.message || error), 3000) });
      throw error;
    }
  }

  async assess(specialistAdapter) {
    this.#assertActive();
    if (this.state.paused) throw new Error('Orchestrator is paused.');
    if (!['assessing', 'assessment_failed'].includes(this.state.status)) return this.snapshot();
    this.state.status = 'assessing';
    await this.#append('assessment.started', { queued: this.state.assignments.filter(value => value.status === 'queued').length });
    while (true) {
      const exceeded = budgetExceeded(this.state);
      if (exceeded) throw new Error(exceeded);
      const queued = this.state.assignments.filter(value => value.status === 'queued').slice(0, this.state.budget.assessment_concurrency);
      if (!queued.length) break;
      const outputs = await Promise.all(queued.map(async assignment => {
        assignment.status = 'running';
        assignment.attempts += 1;
        await this.#append('assessment.assignment.started', { assignment });
        try {
          const packet = {
            schema: ORCHESTRATOR_SCHEMA,
            mode: 'read-only-specialist',
            task: this.state.task,
            assignment,
            findings: this.state.findings,
            authority: { write: false, command: false, network: false, merge: false, deploy: false }
          };
          const output = await this.#invoke(specialistAdapter, packet, `specialist:${assignment.role}`);
          return { assignment, output, error: null };
        } catch (error) {
          return { assignment, output: null, error };
        }
      }));
      for (const { assignment, output, error } of outputs) {
        if (error) {
          assignment.status = 'failed';
          assignment.failure = clean(redactSecrets(error.message), 2000);
          await this.#append('assessment.assignment.failed', { assignment_id: assignment.assignment_id, error: assignment.failure });
          continue;
        }
        const findings = (output?.findings || []).map(value => normalizeFinding(value, assignment));
        for (const finding of findings) {
          if (this.state.findings.some(value => value.finding_id === finding.finding_id)) throw new Error(`Duplicate specialist finding: ${finding.finding_id}.`);
          this.state.findings.push(finding);
        }
        const followups = assignment.depth < this.state.budget.max_depth ? (output?.followups || []).map((value, index) => normalizeFollowup(value, assignment, index)) : [];
        for (const followup of followups) {
          if (this.state.assignments.length >= this.state.budget.max_assignments) break;
          if (!followup.question) continue;
          if (!this.state.assignments.some(value => value.assignment_id === followup.assignment_id)) this.state.assignments.push({ ...followup, status: 'queued', attempts: 0, result_digest: null });
        }
        assignment.status = 'completed';
        assignment.result_digest = digest({ findings, followups });
        await this.#append('assessment.assignment.completed', { assignment_id: assignment.assignment_id, finding_ids: findings.map(value => value.finding_id), followup_ids: followups.map(value => value.assignment_id), result_digest: assignment.result_digest });
      }
      await this.#persist();
    }
    const failed = this.state.assignments.filter(value => value.status === 'failed');
    if (failed.length) {
      this.state.status = 'assessment_failed';
      await this.#append('assessment.failed', { failed_assignments: failed.map(value => value.assignment_id) });
      throw new Error(`Assessment failed for ${failed.length} assignment(s).`);
    }
    this.state.status = 'synthesizing';
    await this.#append('assessment.completed', { assignments: this.state.assignments.length, findings: this.state.findings.length, contradictions: this.state.findings.filter(value => value.kind === 'contradiction').map(value => value.finding_id) });
    return this.snapshot();
  }

  async synthesize(plannerAdapter) {
    this.#assertActive();
    if (this.state.paused) throw new Error('Orchestrator is paused.');
    if (this.state.plan) return this.state.plan;
    if (this.state.status !== 'synthesizing') throw new Error(`Orchestrator is not ready to synthesize: ${this.state.status}.`);
    if (this.state.synthesis_count !== 0) throw new Error('Orchestrator permits exactly one synthesis.');
    const packet = {
      schema: ORCHESTRATOR_SCHEMA,
      mode: 'single-synthesis',
      task: this.state.task,
      findings: this.state.findings,
      assignments: this.state.assignments.map(value => ({ assignment_id: value.assignment_id, role: value.role, question: value.question, status: value.status, result_digest: value.result_digest })),
      requirements: { preserve_contradictions: true, collision_free_owned_paths: true, one_writer_per_lane: true, human_merge_deploy: true }
    };
    const output = await this.#invoke(plannerAdapter, packet, 'planner');
    const contradictions = this.state.findings.filter(value => value.kind === 'contradiction').map(value => value.finding_id);
    const plan = normalizeOrchestrationPlan({
      ...output,
      preserved_contradictions: output?.preserved_contradictions?.length ? output.preserved_contradictions : contradictions,
      created_from_finding_ids: output?.created_from_finding_ids?.length ? output.created_from_finding_ids : this.state.findings.map(value => value.finding_id)
    }, { base_sha: this.state.task.base_sha, branch: this.state.task.branch });
    for (const contradiction of contradictions) if (!plan.preserved_contradictions.includes(contradiction)) throw new Error(`Synthesis dropped contradiction ${contradiction}.`);
    this.state.synthesis_count = 1;
    this.state.plan = plan;
    this.state.lanes = plan.lanes.map(lane => ({ lane, status: 'queued', attempts: 0, result: null, failures: [] }));
    this.state.status = 'executing';
    await this.#append('synthesis.completed', { plan_digest: plan.plan_digest, lane_ids: plan.lanes.map(value => value.lane_id), preserved_contradictions: plan.preserved_contradictions });
    return plan;
  }

  async execute(workerAdapter) {
    this.#assertActive();
    if (this.state.paused) throw new Error('Orchestrator is paused.');
    if (this.state.status === 'awaiting_human') return this.snapshot();
    if (this.state.status !== 'executing') throw new Error(`Orchestrator is not ready to execute: ${this.state.status}.`);
    for (const record of this.state.lanes) {
      if (record.status === 'completed') continue;
      const dependencies = record.lane.depends_on.map(id => this.state.lanes.find(value => value.lane.lane_id === id));
      if (dependencies.some(value => value?.status !== 'completed')) throw new Error(`Lane ${record.lane.lane_id} dependencies are incomplete.`);
      if (record.lane.human_gate) {
        record.status = 'awaiting_human';
        this.state.status = 'awaiting_human';
        this.state.human_gate = { lane_id: record.lane.lane_id, kind: record.lane.gate_kind, request: record.lane.request, plan_digest: this.state.plan.plan_digest };
        await this.#append('human_gate.requested', this.state.human_gate);
        return this.snapshot();
      }
      const maxAttempts = record.lane.max_attempts || this.state.budget.max_worker_attempts;
      while (record.attempts < maxAttempts && record.status !== 'completed') {
        record.attempts += 1;
        record.status = 'running';
        await this.#append('worker.started', { lane_id: record.lane.lane_id, attempt: record.attempts, owned_paths: record.lane.owned_paths });
        try {
          const packet = {
            schema: ORCHESTRATOR_SCHEMA,
            mode: 'one-writer-execution',
            task: this.state.task,
            plan_digest: this.state.plan.plan_digest,
            lane: record.lane,
            attempt: record.attempts,
            prior_failures: record.failures,
            completed_lanes: this.state.lanes.filter(value => value.status === 'completed').map(value => ({ lane_id: value.lane.lane_id, result: value.result }))
          };
          const output = await this.#invoke(workerAdapter, packet, `worker:${record.lane.lane_id}`);
          const result = normalizeWorkerResult(output, record.lane, this.state.task);
          if (result.status !== 'finished') throw new Error(result.failure || `Worker returned ${result.status || 'unknown status'}.`);
          record.result = result;
          record.status = 'completed';
          await this.#append('worker.completed', { lane_id: record.lane.lane_id, attempt: record.attempts, head_sha: result.head_sha, changed_paths: result.changed_paths, witness_count: result.witnesses.length, receipt_digest: result.receipt_digest });
        } catch (error) {
          const failure = { attempt: record.attempts, at: this.clock(), error: clean(redactSecrets(error?.message || error), 3000) };
          record.failures.push(failure);
          record.status = record.attempts >= maxAttempts ? 'failed' : 'queued';
          await this.#append('worker.failed', { lane_id: record.lane.lane_id, ...failure, retrying: record.attempts < maxAttempts });
        }
      }
      if (record.status !== 'completed') {
        this.state.status = 'blocked';
        await this.#append('execution.blocked', { lane_id: record.lane.lane_id, attempts: record.attempts, failures: record.failures });
        throw new Error(`Worker lane ${record.lane.lane_id} exhausted retries.`);
      }
    }
    this.state.status = 'verifying';
    await this.#append('execution.completed', { lanes: this.state.lanes.map(value => ({ lane_id: value.lane.lane_id, status: value.status, head_sha: value.result?.head_sha })) });
    return this.snapshot();
  }

  async verify(verifierAdapter) {
    this.#assertActive();
    if (this.state.paused) throw new Error('Orchestrator is paused.');
    if (this.state.status !== 'verifying') throw new Error(`Orchestrator is not ready to verify: ${this.state.status}.`);
    const packet = {
      schema: ORCHESTRATOR_SCHEMA,
      mode: 'exact-evidence-verification',
      task: this.state.task,
      plan: this.state.plan,
      lane_results: this.state.lanes.map(value => value.result),
      requirements: { all_witnesses_pass: true, exact_heads: true, diff_inspection: true, no_merge_or_deploy: true }
    };
    const output = await this.#invoke(verifierAdapter, packet, 'verifier');
    const verification = {
      ok: output?.ok === true,
      exact_head_sha: clean(output?.exact_head_sha, 40).toLowerCase() || null,
      witnesses: (output?.witnesses || []).map(value => ({ name: clean(value.name, 500), ok: value.ok === true, evidence: clean(redactSecrets(value.evidence), 2000) || null })),
      risks: redactSecrets(output?.risks || []),
      receipt_digest: clean(output?.receipt_digest, 64) || null
    };
    if (!verification.ok || !/^[0-9a-f]{40}$/.test(verification.exact_head_sha || '') || !verification.witnesses.length || verification.witnesses.some(value => !value.ok) || !/^[0-9a-f]{64}$/.test(verification.receipt_digest || '')) {
      this.state.status = 'blocked';
      this.state.verification = verification;
      await this.#append('verification.failed', verification);
      throw new Error('Orchestration verification did not produce exact passing evidence.');
    }
    this.state.verification = verification;
    this.state.status = 'ready_for_human';
    const receipt = this.#receipt();
    this.state.receipt = receipt;
    await this.#append('verification.completed', { exact_head_sha: verification.exact_head_sha, witness_count: verification.witnesses.length, verification_receipt: verification.receipt_digest });
    this.state.receipt = this.#receipt();
    await this.#persist();
    return this.state.receipt;
  }

  async run({ task, specialist_adapter, planner_adapter, worker_adapter, verifier_adapter } = {}) {
    if (!this.state) await this.create(task);
    if (this.state.status === 'assessing' || this.state.status === 'assessment_failed') await this.assess(specialist_adapter);
    if (this.state.status === 'synthesizing') await this.synthesize(planner_adapter);
    if (this.state.status === 'executing') await this.execute(worker_adapter);
    if (this.state.status === 'verifying') return this.verify(verifier_adapter);
    return this.snapshot();
  }

  async approveHumanGate({ lane_id, approved, actor, evidence } = {}) {
    this.#assertActive();
    if (this.state.status !== 'awaiting_human' || this.state.human_gate?.lane_id !== lane_id) throw new Error('No matching human gate is awaiting approval.');
    if (approved !== true || !clean(actor, 300)) {
      this.state.status = 'blocked';
      await this.#append('human_gate.denied', { lane_id, actor: clean(actor, 300) || null, evidence: clean(redactSecrets(evidence), 2000) || null });
      throw new Error('Human gate was denied.');
    }
    const record = this.state.lanes.find(value => value.lane.lane_id === lane_id);
    record.status = 'completed';
    record.result = { status: 'human_approved', actor: clean(actor, 300), evidence: clean(redactSecrets(evidence), 2000) || null };
    this.state.human_gate = null;
    this.state.status = 'executing';
    await this.#append('human_gate.approved', { lane_id, actor: clean(actor, 300), evidence: clean(redactSecrets(evidence), 2000) || null });
    return this.snapshot();
  }

  async pause(reason = 'operator pause') {
    this.#assertActive();
    this.state.paused = true;
    await this.#append('task.paused', { reason: clean(redactSecrets(reason), 2000) });
    return this.snapshot();
  }

  async unpause(actor = 'operator') {
    this.#assertActive();
    this.state.paused = false;
    await this.#append('task.unpaused', { actor: clean(actor, 300) });
    return this.snapshot();
  }

  async cancel(reason = 'operator cancellation') {
    if (!this.state) throw new Error('Orchestrator task is not loaded.');
    if (TERMINAL.has(this.state.status)) return this.snapshot();
    this.state.status = 'cancelled';
    this.state.cancel_reason = clean(redactSecrets(reason), 3000);
    await this.#append('task.cancelled', { reason: this.state.cancel_reason });
    this.state.receipt = this.#receipt();
    await this.#persist();
    return this.state.receipt;
  }

  #receipt() {
    const body = {
      schema: RECEIPT_SCHEMA,
      task: this.state.task,
      status: this.state.status,
      budget: this.state.budget,
      usage: this.state.usage,
      assessment: {
        assignments: this.state.assignments.map(value => ({ assignment_id: value.assignment_id, role: value.role, depth: value.depth, status: value.status, attempts: value.attempts, result_digest: value.result_digest })),
        finding_count: this.state.findings.length,
        finding_digest: digest(this.state.findings),
        contradiction_ids: this.state.findings.filter(value => value.kind === 'contradiction').map(value => value.finding_id)
      },
      plan: this.state.plan,
      lanes: this.state.lanes.map(value => ({ lane: value.lane, status: value.status, attempts: value.attempts, result: value.result, failures: value.failures })),
      verification: this.state.verification,
      human_gate: this.state.human_gate,
      cancel_reason: this.state.cancel_reason,
      event_count: this.state.events.length,
      event_terminal_digest: verifyOrchestrationEvents(this.state.events),
      authority: { merge: 'human', deploy: 'human', production_data: 'none', repository_settings: 'none', training_spend: 'human' },
      finished_at: this.clock()
    };
    return Object.freeze({ ...body, receipt_digest: digest(body) });
  }

  snapshot() {
    if (!this.state) return null;
    return Object.freeze(redactSecrets({ ...this.state, receipt: this.state.receipt }));
  }
}

async function exists(fsImpl, filename) {
  try { await fsImpl.stat(filename); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}
