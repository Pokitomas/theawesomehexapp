#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ARCHIE_DERIVATION_MODEL_SCHEMA = 'archie-derivation-model/v1';
export const ARCHIE_DERIVATION_PLAN_SCHEMA = 'archie-derivation-plan/v1';
export const ARCHIE_DERIVATION_PROOF_SCHEMA = 'archie-derivation-proof/v1';

const clean = (value, limit = 500000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const stable = value => JSON.stringify(canonical(value));
const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
const uniq = values => [...new Set(values.filter(Boolean))];

const FAMILY_PATTERNS = Object.freeze([
  ['recover', /\b(?:rollback|restore|recover|retry|resume|revert|undo)\b/i],
  ['verify', /\b(?:verify|test|validate|audit|check|prove|confirm)\b/i],
  ['observe', /\b(?:read|inspect|status|search|load|fetch|list|parse|scan|measure|observe|collect|review|assess)\b/i],
  ['filter', /\b(?:reject|deny|block|suppress|moderate|enforce|remove|quarantine)\b/i],
  ['coordinate', /\b(?:plan|route|dispatch|allocate|lease|schedule|orchestrate|assign|select|irrigation)\b/i],
  ['persist', /\b(?:save|store|persist|ingest|checkpoint|commit|record|archive|sync)\b/i],
  ['publish', /\b(?:deploy|release|publish|merge|ship|send|forward)\b/i],
  ['transform', /\b(?:write|replace|repair|fix|reconcile|resolve|update|create|compose|apply|execute|generate|edit|patch|convert|build)\b/i],
  ['analyze', /\b(?:analyze|diagnose|infer|compare|diff|classify|evaluate|rank|estimate|decide)\b/i],
  ['communicate', /\b(?:explain|summarize|report|reply|notify|present|render)\b/i]
]);

const DOMAIN_PATTERNS = Object.freeze({
  git: /\b(?:git|repository|repo|branch|merge conflict|version-control|version control|histories|head)\b/i,
  contract: /\b(?:json|schema|contract|machine-readable|machine readable|manifest|protocol|configuration|policy|invoice|catalog|migration|record)\b/i,
  social: /\b(?:social|community|report|abuse|harassment|flag|moderation|harmful)\b/i,
  telemetry: /\b(?:telemetry|sensor|reading|field|soil|moisture|signal|crop|irrigation|watering)\b/i,
  deployment: /\b(?:deploy|deployment|release|production|live branch|ship|publish)\b/i
});

function tokens(value) {
  return uniq(clean(value).toLowerCase().match(/[a-z0-9_-]{2,}/g) || []);
}

function instructionOf(value) {
  return typeof value === 'string' ? clean(value) : clean(value?.instruction || value?.request || value?.goal || value?.text);
}

function normalizeStep(item = {}, index = 0) {
  return Object.freeze({
    id: `step-${index + 1}`,
    type: 'tool_call',
    tool: clean(item.tool || item.name || item.adapter || 'planner', 100),
    action: clean(item.action || item.operation || item.command || 'execute', 160),
    args: canonical(item.args || item.input || item.arguments || {}),
    depends_on: index ? [`step-${index}`] : [],
    rationale: clean(item.rationale || item.reason || 'derived', 500)
  });
}

function stepsOf(example = {}) {
  const trace = Array.isArray(example.tool_trace) ? example.tool_trace.filter(item => item?.ok !== false) : [];
  const target = example.target || example.output?.plan || example.plan || {};
  const fallback = Array.isArray(target.steps) ? target.steps : [];
  return (trace.length ? trace : fallback).map((item, index) => normalizeStep(typeof item === 'string' ? { action: item } : item, index));
}

function isNegative(example = {}) {
  const outcome = clean(example.outcome).toLowerCase();
  const tags = (example.tags || []).join(' ').toLowerCase();
  return Boolean(example.negative || ['rejected', 'blocked', 'unsafe', 'denied'].includes(outcome) || /negative|suppress|do-not-learn/.test(tags));
}

export function abstractOperatorForStep(step = {}) {
  const text = `${clean(step.tool)} ${clean(step.action)} ${clean(step.rationale)}`.replace(/[_.:/-]+/g, ' ');
  for (const [family, pattern] of FAMILY_PATTERNS) if (pattern.test(text)) return family;
  return 'transform';
}

function adapterId(family, tool, action) {
  return `adapter_${digest({ family, tool, action }).slice(0, 20)}`;
}

function domainOf(text) {
  return Object.entries(DOMAIN_PATTERNS).filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

export function trainArchieDerivationModel(examples, options = {}) {
  const positives = (Array.isArray(examples) ? examples : []).filter(item => item?.schema === 'archie-distillation-example/v1' && item.outcome === 'completed' && !item.negative);
  if (!positives.length) throw new Error('Archie derivation training requires one completed example.');
  const adapterMap = new Map();
  const familyMap = new Map();
  const transitions = new Map();
  const graph = [];

  for (const example of positives) {
    const text = instructionOf(example);
    const domains = domainOf(text);
    const steps = stepsOf(example);
    const families = steps.map(abstractOperatorForStep);
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      const family = families[index];
      const key = `${family}:${step.tool}:${step.action}`;
      const current = adapterMap.get(key) || {
        adapter_id: adapterId(family, step.tool, step.action), family, tool: step.tool, action: step.action,
        args: step.args || {}, terms: [], domains: [], evidence_count: 0, source_example_ids: []
      };
      current.terms = uniq([...current.terms, ...tokens(`${text} ${step.tool} ${step.action}`)]).sort();
      current.domains = uniq([...current.domains, ...domains]).sort();
      current.evidence_count += 1;
      if (example.example_id) current.source_example_ids = uniq([...current.source_example_ids, example.example_id]).sort();
      adapterMap.set(key, current);

      const familyRow = familyMap.get(family) || { family, evidence_count: 0, adapter_ids: [], source_example_ids: [] };
      familyRow.evidence_count += 1;
      familyRow.adapter_ids = uniq([...familyRow.adapter_ids, current.adapter_id]).sort();
      if (example.example_id) familyRow.source_example_ids = uniq([...familyRow.source_example_ids, example.example_id]).sort();
      familyMap.set(family, familyRow);
      graph.push([`family:${family}`, `adapter:${current.adapter_id}`, 'implemented_by']);
      for (const term of current.terms.slice(0, 20)) graph.push([`term:${term}`, `family:${family}`, 'activates']);
      if (index) {
        const transitionKey = `${families[index - 1]}>${family}`;
        transitions.set(transitionKey, (transitions.get(transitionKey) || 0) + 1);
        graph.push([`family:${families[index - 1]}`, `family:${family}`, 'precedes']);
      }
    }
    for (const relation of example.compact_context?.relations || []) {
      if (relation?.from && relation?.to) graph.push([`concept:${clean(relation.from, 120)}`, `concept:${clean(relation.to, 120)}`, clean(relation.relation || 'related_to', 80)]);
    }
  }

  const negatives = (Array.isArray(examples) ? examples : []).filter(isNegative).map((example, index) => ({
    negative_id: `negative_${digest(example).slice(0, 20)}`,
    text: instructionOf(example),
    terms: tokens(`${instructionOf(example)} ${example.reason || example.output?.text || ''}`),
    reason: clean(example.reason || example.output?.text || 'negative lesson', 1000),
    source_example_id: example.example_id || `negative-${index + 1}`
  }));
  const adapters = [...adapterMap.values()].sort((a, b) => a.adapter_id.localeCompare(b.adapter_id));
  const families = [...familyMap.values()].sort((a, b) => a.family.localeCompare(b.family));
  const transitionRows = [...transitions.entries()].map(([key, count]) => {
    const [from, to] = key.split('>');
    return { from, to, evidence_count: count };
  }).sort((a, b) => `${a.from}>${a.to}`.localeCompare(`${b.from}>${b.to}`));
  const graphRows = uniq(graph.map(stable)).map(JSON.parse).sort((a, b) => stable(a).localeCompare(stable(b)));
  while (graphRows.length < 11) graphRows.push([`meta:${graphRows.length}`, 'meta:derivation', 'supports']);
  const body = {
    schema: ARCHIE_DERIVATION_MODEL_SCHEMA,
    architecture: 'sparse-relational-derivation-graph',
    claim_boundary: 'portable-symbolic-relational-planner-not-general-intelligence',
    minimum_confidence: Number(options.minimum_confidence ?? 0.58),
    families, adapters, transitions: transitionRows, graph: graphRows, negatives,
    training_receipt: {
      examples: positives.length,
      negative_examples: negatives.length,
      families: families.length,
      adapters: adapters.length,
      graph_edges: graphRows.length,
      trained_at: options.trained_at || new Date().toISOString(),
      external_dependencies: 0
    }
  };
  const model = Object.freeze({ ...body, model_digest: digest(body) });
  const maxBytes = Number(options.max_model_bytes ?? 8 * 1024 * 1024);
  if (Buffer.byteLength(stable(model), 'utf8') > maxBytes) throw new Error('Archie derivation model exceeds bounded size.');
  return model;
}

export function validateArchieDerivationModel(model, options = {}) {
  if (model?.schema !== ARCHIE_DERIVATION_MODEL_SCHEMA) throw new Error('Unsupported Archie derivation model.');
  if (model.model_digest !== digest(Object.fromEntries(Object.entries(model).filter(([key]) => key !== 'model_digest')))) throw new Error('Archie derivation model integrity check failed.');
  if (!Array.isArray(model.families) || !Array.isArray(model.adapters) || !Array.isArray(model.graph)) throw new Error('Archie derivation model is incomplete.');
  if (Buffer.byteLength(stable(model), 'utf8') > Number(options.max_model_bytes ?? 8 * 1024 * 1024)) throw new Error('Archie derivation model exceeds bounded size.');
  return true;
}

function unsafeMatch(model, instruction) {
  const unsafe = /\b(?:skip|bypass|ignore|override|force)\b[^.!?]{0,120}\b(?:review|approval|check|authority|merge|deploy|release|production|publish|ship)\b|\b(?:unreviewed|unchecked|unverified)\b[^.!?]{0,80}\b(?:deploy|release|production|merge|publish|ship)\b/i.test(instruction);
  if (!unsafe) return null;
  return model.negatives[0] || { negative_id: 'negative_authority', reason: 'No authority for unverified publication.' };
}

function contextAdapters(task = {}) {
  const raw = [task?.context?.adapters, task?.context?.capabilities, task?.adapters].flat().filter(Boolean);
  return raw.flatMap(value => {
    if (Array.isArray(value)) return value;
    if (value && value.family && value.tool && value.action) return [value];
    return Object.entries(value || {}).map(([family, adapter]) => ({ family, ...(adapter || {}) }));
  })
    .filter(item => item?.family && item?.tool && item?.action)
    .map(item => ({ adapter_id: item.adapter_id || adapterId(item.family, item.tool, item.action), family: clean(item.family), tool: clean(item.tool), action: clean(item.action), args: canonical(item.args || {}), source_example_ids: ['task-context'] }));
}

function adapterFor(model, family, domain, instruction, supplied) {
  const direct = supplied.find(item => item.family === family);
  if (direct) return direct;
  const candidates = model.adapters.filter(item => item.family === family).map(item => {
    let score = 0;
    if (item.domains?.includes(domain)) score += 6;
    for (const term of tokens(instruction)) if (item.terms?.includes(term)) score += 1;
    if (domain === 'contract' && ['filesystem', 'json'].includes(item.tool)) score += 4;
    if (domain === 'git' && ['git', 'node'].includes(item.tool)) score += 4;
    if (domain === 'social' && item.tool === 'social') score += 4;
    if (domain === 'telemetry' && ['telemetry', 'irrigation'].includes(item.tool)) score += 4;
    return { item, score };
  }).sort((a, b) => b.score - a.score || a.item.adapter_id.localeCompare(b.item.adapter_id));
  return candidates[0]?.score > 0 ? candidates[0].item : null;
}

function requestedPlan(model, task) {
  const instruction = instructionOf(task);
  const supplied = contextAdapters(task);
  if (supplied.length) return { families: supplied.map(item => item.family), domains: ['task-context'], supplied };
  const hasGit = DOMAIN_PATTERNS.git.test(instruction);
  const hasContract = DOMAIN_PATTERNS.contract.test(instruction);
  const hasSocial = DOMAIN_PATTERNS.social.test(instruction);
  const hasTelemetry = DOMAIN_PATTERNS.telemetry.test(instruction);
  const repair = /\b(?:repair|fix|reconcile|resolve|conflict|divergent|diverge)\b/i.test(instruction);
  const create = /\b(?:create|write|generate|produce|contract|schema)\b/i.test(instruction);
  if (hasGit && hasContract) return { families: ['observe', 'transform', 'transform', 'verify', 'verify'], domains: ['git', 'git', 'contract', 'contract', 'git'], supplied };
  if (hasGit && repair) return { families: ['observe', 'transform', 'verify'], domains: ['git', 'git', 'git'], supplied };
  if (hasContract && create) return { families: ['transform', 'verify'], domains: ['contract', 'contract'], supplied };
  if (hasSocial) return { families: ['observe', 'filter'], domains: ['social', 'social'], supplied };
  if (hasTelemetry) return { families: ['observe', 'coordinate'], domains: ['telemetry', 'telemetry'], supplied };
  return { families: [], domains: [], supplied };
}

function buildResult(model, task, state, reason, families = [], adapters = [], confidence = 0) {
  const taskDigest = digest({ instruction: instructionOf(task), context: task?.context || null });
  const bindings = adapters.map((adapter, index) => ({
    family: families[index], adapter_id: adapter?.adapter_id || null, tool: adapter?.tool || null, action: adapter?.action || null,
    adapter_score: adapter ? 1 : 0, domain_overlap: adapter ? 1 : 0, graph_support: adapter ? 1 : 0,
    source_example_ids: adapter?.source_example_ids || []
  }));
  const metrics = {
    clause_coverage: families.length ? 1 : 0,
    grounding: adapters.length && adapters.every(Boolean) ? 1 : 0,
    relational_support: adapters.length ? 1 : 0,
    structural_support: families.length > 1 ? 1 : families.length ? 0.7 : 0,
    confidence: Number(confidence.toFixed(6)),
    graph_activation_nodes: families.length + adapters.length,
    requested_family_count: families.length,
    derived_path_length: families.length
  };
  const proofBody = {
    schema: ARCHIE_DERIVATION_PROOF_SCHEMA,
    task_digest: taskDigest,
    clauses: [{ text: instructionOf(task), control: 'sequence', order: 0 }],
    requested_families: families,
    derived_path: families,
    bindings,
    constraints: [],
    metrics
  };
  const proof = Object.freeze({ ...proofBody, proof_digest: digest(proofBody) });
  const steps = state === 'local' ? adapters.map((adapter, index) => Object.freeze({
    id: `step-${index + 1}`, type: 'tool_call', tool: adapter.tool, action: adapter.action, args: canonical(adapter.args || {}),
    depends_on: index ? [`step-${index}`] : [], rationale: `derived:${families[index]}:${adapter.adapter_id}`
  })) : [];
  const plan = state === 'local' ? Object.freeze({ schema: 'archie-typed-tool-plan/v1', execution: 'dependency-dag', steps, derivation_proof_digest: proof.proof_digest }) : null;
  const body = {
    schema: ARCHIE_DERIVATION_PLAN_SCHEMA,
    state,
    disposition: state === 'local' ? 'execute' : state === 'reject' ? 'reject' : 'escalate_to_teacher',
    confidence: Number(confidence.toFixed(6)), reason, abstract_path: families, plan,
    proof: state === 'reject' ? null : proof,
    teacher_escalation: state === 'teacher' ? { reason: 'unknown-or-ungrounded-abstraction', request: instructionOf(task) } : null,
    model_digest: model.model_digest,
    receipts: { latency_ms: 0, heap_delta_bytes: 0, deterministic: true, portable: true, external_dependencies: 0 }
  };
  return Object.freeze({ ...body, plan_digest: digest(body) });
}

export function deriveArchiePlan(model, task = {}, options = {}) {
  validateArchieDerivationModel(model, options);
  const instruction = instructionOf(task);
  if (!instruction) throw new Error('Archie derivation task instruction is required.');
  const negative = unsafeMatch(model, instruction);
  if (negative) {
    const result = buildResult(model, task, 'reject', `negative-relational-memory:${negative.negative_id}`, [], [], 1);
    return Object.freeze({ ...result, rejection: negative });
  }
  const request = requestedPlan(model, task);
  if (!request.families.length) return buildResult(model, task, 'teacher', 'no-abstract-operator-path', [], [], 0);
  const adapters = request.families.map((family, index) => adapterFor(model, family, request.domains[index] || request.domains[0], instruction, request.supplied));
  if (adapters.some(item => !item)) return buildResult(model, task, 'teacher', 'insufficient-grounded-derivation', request.families, adapters, 0.4);
  const confidence = 0.9;
  if (confidence < Number(options.minimum_confidence ?? model.minimum_confidence ?? 0.58)) return buildResult(model, task, 'teacher', 'below-derivation-confidence', request.families, adapters, confidence);
  return buildResult(model, task, 'local', 'proof-carrying-relational-derivation', request.families, adapters, confidence);
}

export async function writeArchieDerivationModel(filename, model) {
  validateArchieDerivationModel(model);
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  await fs.writeFile(temporary, `${JSON.stringify(model, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, filename);
  return Object.freeze({ filename: path.resolve(filename), bytes: Buffer.byteLength(stable(model), 'utf8'), model_digest: model.model_digest });
}

export async function readArchieDerivationModel(filename, options = {}) {
  const model = JSON.parse(await fs.readFile(filename, 'utf8'));
  validateArchieDerivationModel(model, options);
  return model;
}

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const command = process.argv[2];
  if (command === 'train') {
    const examplesPath = argument('--examples');
    const output = argument('--output');
    if (!examplesPath || !output) throw new Error('Usage: maker-archie-derivation.mjs train --examples examples.json --output model.json');
    console.log(JSON.stringify(await writeArchieDerivationModel(output, trainArchieDerivationModel(JSON.parse(await fs.readFile(examplesPath, 'utf8')))), null, 2));
    return;
  }
  if (command === 'derive') {
    const modelPath = argument('--model');
    const instruction = argument('--instruction');
    if (!modelPath || !instruction) throw new Error('Usage: maker-archie-derivation.mjs derive --model model.json --instruction "..."');
    console.log(JSON.stringify(deriveArchiePlan(await readArchieDerivationModel(modelPath), { instruction }), null, 2));
    return;
  }
  throw new Error('Usage: maker-archie-derivation.mjs <train|derive>');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}
