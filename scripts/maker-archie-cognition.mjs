#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArchieLinuxCorpus } from './maker-archie-corpus.mjs';
import { createArchiePersonalBrain, predictArchiePlan } from './maker-archie-brain.mjs';
import {
  planWithArchieCPUPlanner,
  trainArchieCPUPlanner,
  validateArchieCPUPlannerModel
} from './maker-archie-planner.mjs';
import {
  deriveArchiePlan,
  trainArchieDerivationModel,
  validateArchieDerivationModel
} from './maker-archie-derivation.mjs';

export const ARCHIE_COGNITION_RECEIPT_SCHEMA = 'archie-cognition-receipt/v1';
export const ARCHIE_COGNITION_SNAPSHOT_SCHEMA = 'archie-cognition-snapshot/v1';

const clean = (value, limit = 200000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const stable = value => JSON.stringify(canonical(value));
const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');

async function writeAtomic(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, filename);
}

function taskInstruction(task = {}) {
  return typeof task === 'string' ? clean(task) : clean(task.instruction || task.request || task.goal || task.prompt);
}

function taskObject(task = {}) {
  const instruction = taskInstruction(task);
  if (!instruction) throw new Error('Archie cognition task instruction is required.');
  return typeof task === 'string' ? { instruction } : { ...task, instruction };
}

function traceActions(trace = []) {
  return (Array.isArray(trace) ? trace : [])
    .filter(item => item?.ok !== false)
    .map(item => `${clean(item?.tool || item?.name, 100)}:${clean(item?.action || item?.operation, 120)}`)
    .filter(value => value !== ':');
}

function planActions(plan) {
  return (Array.isArray(plan?.steps) ? plan.steps : [])
    .map(item => `${clean(item?.tool, 100)}:${clean(item?.action, 120)}`)
    .filter(value => value !== ':');
}

function routeActions(route) {
  if (!route) return [];
  return traceActions(route.tool_trace).length ? traceActions(route.tool_trace) : planActions(route.plan);
}

function alignment(left, right) {
  const a = routeActions(left);
  const b = routeActions(right);
  if (!a.length || !b.length) return Object.freeze({ exact: false, jaccard: 0, ordered_overlap: 0, actions_left: a, actions_right: b });
  const leftSet = new Set(a);
  const rightSet = new Set(b);
  const intersection = [...leftSet].filter(item => rightSet.has(item)).length;
  const union = new Set([...leftSet, ...rightSet]).size;
  let cursor = 0;
  let ordered = 0;
  for (const action of a) {
    const next = b.indexOf(action, cursor);
    if (next === -1) continue;
    ordered += 1;
    cursor = next + 1;
  }
  return Object.freeze({
    exact: stable(a) === stable(b),
    left_subset_of_right: a.every(item => rightSet.has(item)),
    right_subset_of_left: b.every(item => leftSet.has(item)),
    jaccard: Number((intersection / Math.max(1, union)).toFixed(6)),
    ordered_overlap: Number((ordered / Math.max(a.length, b.length)).toFixed(6)),
    actions_left: a,
    actions_right: b
  });
}

function normalizedTeacherResult(result = {}) {
  const plan = result.plan || result.result?.plan || null;
  const toolTrace = Array.isArray(result.tool_trace) ? result.tool_trace : Array.isArray(result.result?.tool_trace) ? result.result.tool_trace : [];
  return Object.freeze({
    plan,
    tool_trace: toolTrace,
    text: clean(result.text || result.result?.text || ''),
    outcome: clean(result.outcome || result.result?.outcome || 'completed', 100),
    teacher: clean(result.teacher || result.provider_id || 'external-teacher', 200),
    model: clean(result.model || result.model_id || '', 300),
    run_id: clean(result.run_id || '', 300),
    cost_usd: Number.isFinite(Number(result.cost_usd)) ? Number(result.cost_usd) : null,
    usage: result.usage || null
  });
}

function receipt(body) {
  return Object.freeze({ ...body, receipt_digest: digest(body) });
}

export class ArchieCognitionRuntime {
  constructor({
    root,
    corpus = null,
    teacher = null,
    budget_controller = null,
    clock = Date.now,
    sparse_training = {},
    planner_training = {},
    derivation_training = {},
    consensus = {}
  } = {}) {
    if (!root && !corpus) throw new Error('Archie cognition root or corpus is required.');
    if (teacher && typeof teacher !== 'function') throw new Error('Archie cognition teacher must be a function.');
    this.root = path.resolve(root || corpus.root);
    this.clock = clock;
    this.corpus = corpus || createArchieLinuxCorpus({ root: path.join(this.root, 'corpus'), clock });
    this.teacher = teacher;
    this.budgetController = budget_controller;
    this.sparseTraining = sparse_training;
    this.plannerTraining = planner_training;
    this.derivationTraining = derivation_training;
    this.consensus = Object.freeze({
      minimum_jaccard: Number(consensus.minimum_jaccard ?? 0.66),
      minimum_ordered_overlap: Number(consensus.minimum_ordered_overlap ?? 0.66),
      planner_override_confidence: Number(consensus.planner_override_confidence ?? 0.9),
      composition_override_confidence: Number(consensus.composition_override_confidence ?? 0.75),
      derivation_override_confidence: Number(consensus.derivation_override_confidence ?? 0.74)
    });
    this.sparseModelPath = path.join(this.root, 'models', 'archie-sparse.json');
    this.plannerModelPath = path.join(this.root, 'models', 'archie-planner.json');
    this.derivationModelPath = path.join(this.root, 'models', 'archie-derivation.json');
    this.sparseBrain = createArchiePersonalBrain({
      corpus: this.corpus,
      model_path: this.sparseModelPath,
      clock,
      training: sparse_training
    });
  }

  async train() {
    const examples = await this.corpus.examples({ limit: this.plannerTraining.limit || 100000 });
    const positives = examples.filter(example => example?.outcome === 'completed' && !example.negative);
    if (!positives.length) throw new Error('Archie cognition requires at least one completed corpus example.');
    const sparse = await this.sparseBrain.train();
    const trainedAt = new Date(typeof this.clock === 'function' ? this.clock() : Date.now()).toISOString();
    const planner = trainArchieCPUPlanner(examples, {
      ...this.plannerTraining,
      trained_at: trainedAt
    });
    const derivation = trainArchieDerivationModel(examples, {
      ...this.derivationTraining,
      trained_at: trainedAt
    });
    await Promise.all([
      writeAtomic(this.plannerModelPath, planner),
      writeAtomic(this.derivationModelPath, derivation)
    ]);
    return this.snapshot({ sparse, planner, derivation, examples });
  }

  async load() {
    const sparse = await this.sparseBrain.load();
    let planner;
    let derivation;
    try {
      [planner, derivation] = await Promise.all([
        fs.readFile(this.plannerModelPath, 'utf8').then(JSON.parse),
        fs.readFile(this.derivationModelPath, 'utf8').then(JSON.parse)
      ]);
      validateArchieCPUPlannerModel(planner);
      validateArchieDerivationModel(derivation);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const trained = await this.train();
      return {
        sparse: trained.models.sparse,
        planner: trained.models.planner,
        derivation: trained.models.derivation
      };
    }
    return Object.freeze({ sparse, planner, derivation });
  }

  snapshot({ sparse, planner, derivation, examples = null } = {}) {
    const body = {
      schema: ARCHIE_COGNITION_SNAPSHOT_SCHEMA,
      observed_at: new Date(typeof this.clock === 'function' ? this.clock() : Date.now()).toISOString(),
      examples: Array.isArray(examples) ? examples.length : null,
      models: {
        sparse: sparse || null,
        planner: planner || null,
        derivation: derivation || null
      }
    };
    return Object.freeze({ ...body, snapshot_digest: digest(body) });
  }

  async #callTeacher(task, localEvidence) {
    if (!this.teacher) throw new Error('Archie cognition requires a teacher for unresolved work.');
    if (this.budgetController) {
      const result = await this.budgetController.allocate({
        ...task,
        local_confidence: Math.max(localEvidence.sparse?.confidence || 0, localEvidence.planner?.calibrated_confidence || 0, localEvidence.derivation?.confidence || 0),
        novelty: task.novelty ?? (localEvidence.planner?.state === 'teacher' ? 0.8 : 0.4),
        uncertainty: task.uncertainty ?? 1 - Math.max(localEvidence.sparse?.confidence || 0, localEvidence.planner?.calibrated_confidence || 0, localEvidence.derivation?.confidence || 0),
        expected_recurrence: task.expected_recurrence ?? 1,
        estimated_future_call_savings: task.estimated_future_call_savings ?? task.expected_recurrence ?? 1
      }, {
        idempotency_key: task.idempotency_key || task.task_id || null,
        providers: [{
          id: 'archie-teacher',
          call: async () => {
            const output = await this.teacher(task, localEvidence);
            return { result: output, usage: output?.usage || null };
          }
        }]
      });
      if (result.decision?.state !== 'completed') throw new Error(`Archie teacher budget did not complete: ${result.decision?.reason || 'unknown'}.`);
      return { result: normalizedTeacherResult(result.result), budget_receipt: result };
    }
    return { result: normalizedTeacherResult(await this.teacher(task, localEvidence)), budget_receipt: null };
  }

  async decide(taskInput, { allow_teacher = true } = {}) {
    const task = taskObject(taskInput);
    const models = await this.load();
    const sparse = predictArchiePlan(models.sparse, task);
    const planner = planWithArchieCPUPlanner(models.planner, task);
    const derivation = deriveArchiePlan(models.derivation, task, this.derivationTraining);
    const agreement = alignment(sparse, planner);
    const derivationPlannerAgreement = alignment(derivation, planner);
    const derivationSparseAgreement = alignment(derivation, sparse);
    const observedAt = new Date(typeof this.clock === 'function' ? this.clock() : Date.now()).toISOString();

    const evidence = {
      sparse,
      planner,
      derivation,
      agreement,
      derivation_planner_agreement: derivationPlannerAgreement,
      derivation_sparse_agreement: derivationSparseAgreement
    };

    if (planner.state === 'reject' || derivation.state === 'reject') {
      return receipt({
        schema: ARCHIE_COGNITION_RECEIPT_SCHEMA,
        observed_at: observedAt,
        task_digest: digest(task),
        state: 'reject',
        disposition: 'reject',
        selected_route: derivation.state === 'reject' ? 'negative-relational-memory' : 'negative-memory',
        ...evidence,
        plan: null,
        tool_trace: [],
        teacher: null,
        learning: null
      });
    }

    const consensusLocal = sparse.state === 'local' && planner.state === 'local'
      && (agreement.exact || (agreement.jaccard >= this.consensus.minimum_jaccard && agreement.ordered_overlap >= this.consensus.minimum_ordered_overlap));
    const plannerOverride = planner.state === 'local' && sparse.state !== 'local'
      && planner.calibrated_confidence >= this.consensus.planner_override_confidence;
    const compositionOverride = sparse.state === 'local' && planner.state === 'local'
      && agreement.left_subset_of_right
      && agreement.actions_right.length > agreement.actions_left.length
      && planner.calibrated_confidence >= this.consensus.composition_override_confidence;
    const instructionControlOverride = sparse.state === 'local' && planner.state === 'local'
      && agreement.right_subset_of_left
      && agreement.actions_right.length < agreement.actions_left.length
      && /\b(?:only|do not|don't|never|without)\b/i.test(task.instruction)
      && planner.calibrated_confidence >= 0.7;
    const derivationConsensus = derivation.state === 'local' && planner.state === 'local'
      && (derivationPlannerAgreement.exact || (
        derivationPlannerAgreement.jaccard >= this.consensus.minimum_jaccard
        && derivationPlannerAgreement.ordered_overlap >= this.consensus.minimum_ordered_overlap
      ));
    const derivationOverride = derivation.state === 'local'
      && derivation.confidence >= this.consensus.derivation_override_confidence
      && derivation.proof?.metrics?.grounding === 1
      && derivation.proof?.metrics?.clause_coverage >= 0.75
      && planner.state !== 'reject'
      && (planner.state !== 'local' || derivationPlannerAgreement.left_subset_of_right || derivationPlannerAgreement.right_subset_of_left);

    if (consensusLocal || plannerOverride || compositionOverride || instructionControlOverride || derivationConsensus || derivationOverride) {
      const useDerivation = !consensusLocal && !instructionControlOverride && (derivationConsensus || derivationOverride);
      const selectedPlan = useDerivation ? derivation.plan : planner.plan;
      return receipt({
        schema: ARCHIE_COGNITION_RECEIPT_SCHEMA,
        observed_at: observedAt,
        task_digest: digest(task),
        state: 'local',
        disposition: 'execute',
        selected_route: consensusLocal ? 'sparse-planner-consensus'
          : instructionControlOverride ? 'instruction-controlled-subplan'
            : derivationOverride ? 'proof-carrying-derivation'
              : derivationConsensus ? 'derivation-planner-consensus'
                : compositionOverride ? 'validated-composition'
                  : 'calibrated-cpu-planner',
        ...evidence,
        plan: selectedPlan,
        tool_trace: selectedPlan?.steps || [],
        teacher: null,
        learning: null
      });
    }

    if (!allow_teacher) {
      return receipt({
        schema: ARCHIE_COGNITION_RECEIPT_SCHEMA,
        observed_at: observedAt,
        task_digest: digest(task),
        state: 'teacher',
        disposition: 'escalate_to_teacher',
        selected_route: 'teacher-required',
        ...evidence,
        plan: null,
        tool_trace: [],
        teacher: null,
        learning: null
      });
    }

    const teacherCall = await this.#callTeacher(task, evidence);
    const teacher = teacherCall.result;
    const negative = teacher.outcome !== 'completed';
    const stored = await this.corpus.ingest({
      kind: 'archie_cognition_teacher_trace',
      subject: clean(task.subject || 'default', 300),
      input: { text: task.instruction, context: task.context || null },
      output: { text: teacher.text || (negative ? teacher.outcome : ''), plan: teacher.plan },
      tool_trace: teacher.tool_trace,
      outcome: teacher.outcome,
      source: {
        system: 'archie-cognition-runtime',
        run_id: teacher.run_id,
        teacher: teacher.teacher,
        model: teacher.model,
        cost_usd: teacher.cost_usd
      },
      tags: negative ? ['teacher-escalation', 'negative', 'suppress'] : ['teacher-escalation', 'skill-acquisition']
    });
    const learned = negative ? null : await this.train();
    let learnedRoute = null;
    if (!negative) {
      const refreshed = await this.load();
      learnedRoute = {
        sparse: predictArchiePlan(refreshed.sparse, task),
        planner: planWithArchieCPUPlanner(refreshed.planner, task),
        derivation: deriveArchiePlan(refreshed.derivation, task, this.derivationTraining)
      };
    }
    return receipt({
      schema: ARCHIE_COGNITION_RECEIPT_SCHEMA,
      observed_at: observedAt,
      task_digest: digest(task),
      state: negative ? 'reject' : 'teacher',
      disposition: negative ? 'reject' : 'teacher_completed',
      selected_route: 'budgeted-teacher',
      ...evidence,
      plan: teacher.plan,
      tool_trace: teacher.tool_trace,
      teacher: { ...teacher, budget_receipt: teacherCall.budget_receipt },
      learning: {
        corpus_receipt: stored,
        snapshot_digest: learned?.snapshot_digest || null,
        learned_route: learnedRoute
      }
    });
  }
}

export function createArchieCognitionRuntime(options) {
  return new ArchieCognitionRuntime(options);
}

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const root = argument('--root', process.env.ARCHIE_COGNITION_ROOT || '');
  const instruction = argument('--instruction');
  if (!root || !instruction) throw new Error('Usage: maker-archie-cognition.mjs --root <directory> --instruction "..."');
  const runtime = createArchieCognitionRuntime({ root });
  console.log(JSON.stringify(await runtime.decide({ instruction }, { allow_teacher: false }), null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}
