import crypto from 'node:crypto';
import { validateArchieCheckpoint, validateArchieStateContract } from './archie-model-contract.mjs';

export const ARCHIE_TRAINING_PLAN_SCHEMA = 'archie-training-plan/v1';
export const ARCHIE_TRAINING_INPUT_RECEIPT_SCHEMA = 'archie-training-input-receipt/v1';
export const ARCHIE_TRAINING_SAMPLE_SCHEMA = 'archie-training-sample/v1';
export const ARCHIE_STUDENT_TRAINING_RECEIPT_SCHEMA = 'archie-student-training-receipt/v1';

const HEX = /^[a-f0-9]{64}$/;
const GIT_OID = /^[a-f0-9]{40,64}$/;
const clean = (value, limit = 500000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const stable = value => JSON.stringify(canonical(value));
const digest = value => crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : typeof value === 'string' ? value : stable(value)).digest('hex');

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object.`);
  return value;
}
function exactDigest(value, field) {
  const result = clean(value, 128).toLowerCase();
  if (!HEX.test(result)) throw new Error(`${field} must be a SHA-256 digest.`);
  return result;
}
function gitOid(value, field) {
  const result = clean(value, 128).toLowerCase();
  if (!GIT_OID.test(result)) throw new Error(`${field} must be a Git object ID.`);
  return result;
}
function positiveRate(value, field) {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || result >= 1) throw new Error(`${field} must be in [0,1).`);
  return result;
}
function parseJSONL(bytes, field) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes ?? '');
  return text.split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`${field} line ${index + 1} is not valid JSON.`); }
  });
}
function verifyEmbedded(value, key, field) {
  const claimed = exactDigest(value?.[key], `${field}.${key}`);
  const body = { ...value }; delete body[key];
  if (digest(body) !== claimed) throw new Error(`${field}.${key} mismatch.`);
  return claimed;
}
function descriptor(path, text) {
  const bytes = Buffer.from(text, 'utf8');
  return Object.freeze({ path, sha256: digest(bytes), bytes: bytes.length, rows: text ? text.split('\n').filter(Boolean).length : 0 });
}
function jsonl(rows) {
  return rows.length ? `${rows.map(stable).join('\n')}\n` : '';
}
function sampleId(body) { return `sample_${digest(body).slice(0, 32)}`; }
function groupUnit(seed, group) {
  const prefix = digest(`${seed}:${group}`).slice(0, 13);
  return Number.parseInt(prefix, 16) / 0x1fffffffffffff;
}
function normalizeProfile(profile) {
  object(profile, 'profile');
  if (profile.schema !== 'archie-distill-profile/v1') throw new Error('Unsupported Archie distillation profile.');
  const student = object(profile.student, 'profile.student');
  const training = object(profile.training, 'profile.training');
  if (!/^[a-f0-9]{40}$/.test(clean(student.revision, 80))) throw new Error('Student revision must be an exact 40-character commit.');
  const seed = Number(training.seed);
  if (!Number.isSafeInteger(seed)) throw new Error('profile.training.seed must be an integer.');
  const holdout = positiveRate(training.holdout_rate ?? 0.2, 'profile.training.holdout_rate');
  return Object.freeze({
    id: clean(profile.id, 300),
    digest: digest(profile),
    student: canonical(student),
    training: canonical(training),
    seed,
    holdout_rate: holdout,
    claim_boundary: clean(profile.claim_boundary, 10000)
  });
}
function sourceIdentity(row) {
  return clean(row?.source?.source_id || row?.source?.domain || row?.source_id || row?.document_id, 1000);
}
function sidepusSamples(input, index) {
  const field = `sidepus[${index}]`;
  const source = object(input, field);
  const manifest = object(source.manifest, `${field}.manifest`);
  const receipt = object(source.export_receipt, `${field}.export_receipt`);
  if (manifest.schema !== 'sidepus-diet-manifest/v1') throw new Error(`${field}.manifest schema is unsupported.`);
  if (receipt.schema !== 'sidepus-export-receipt/v1') throw new Error(`${field}.export_receipt schema is unsupported.`);
  const manifestDigest = exactDigest(manifest.manifest_digest, `${field}.manifest.manifest_digest`);
  const manifestFileSha = exactDigest(source.manifest_file_sha256, `${field}.manifest_file_sha256`);
  if (receipt.manifest_digest !== manifestDigest) throw new Error(`${field} export receipt is bound to a different manifest.`);
  const exportBytes = Buffer.isBuffer(source.export_bytes) ? source.export_bytes : Buffer.from(String(source.export_bytes ?? ''), 'utf8');
  if (exactDigest(receipt.sha256, `${field}.export_receipt.sha256`) !== digest(exportBytes)) throw new Error(`${field} export bytes do not match the receipt.`);
  if (Number(receipt.bytes) !== exportBytes.length) throw new Error(`${field} export byte count mismatch.`);
  const selected = new Map((Array.isArray(manifest.selected) ? manifest.selected : []).map(item => [item.document_id, item]));
  const rows = parseJSONL(exportBytes, `${field}.export_bytes`);
  if (rows.length !== selected.size || Number(receipt.documents) !== rows.length) throw new Error(`${field} export rows do not exactly cover the selected manifest documents.`);
  const seen = new Set();
  const samples = rows.map((row, rowIndex) => {
    const selection = selected.get(row.document_id);
    if (!selection || seen.has(row.document_id)) throw new Error(`${field} export contains an unknown or duplicate document at row ${rowIndex + 1}.`);
    seen.add(row.document_id);
    if (selection.object_digest !== row.selection?.object_digest || (row.object_digest !== undefined && selection.object_digest !== row.object_digest)) {
      throw new Error(`${field} export object digest mismatch for ${row.document_id}.`);
    }
    const text = clean(row.text, 5_000_000);
    if (!text) throw new Error(`${field} export contains empty text for ${row.document_id}.`);
    if (digest(Buffer.from(text, 'utf8')) !== selection.object_digest) throw new Error(`${field} export text bytes do not match object digest for ${row.document_id}.`);
    const identity = {
      kind: 'continued-pretraining',
      sidepus_manifest_digest: manifestDigest,
      document_id: row.document_id,
      object_digest: selection.object_digest
    };
    return Object.freeze({
      schema: ARCHIE_TRAINING_SAMPLE_SCHEMA,
      sample_id: sampleId(identity),
      kind: 'continued-pretraining',
      group_id: `sidepus:${manifestDigest}:${sourceIdentity(row)}`,
      text,
      source: canonical(row.source || {}),
      provenance: Object.freeze({
        sidepus_manifest_digest: manifestDigest,
        sidepus_manifest_file_sha256: manifestFileSha,
        sidepus_export_receipt_digest: exactDigest(receipt.receipt_digest, `${field}.export_receipt.receipt_digest`),
        sidepus_export_sha256: receipt.sha256,
        document_id: row.document_id,
        object_digest: selection.object_digest,
        measurement_digest: selection.measurement_digest
      })
    });
  });
  return { samples, evidence: Object.freeze({ manifest_digest: manifestDigest, manifest_file_sha256: manifestFileSha, export_receipt_digest: receipt.receipt_digest, export_sha256: receipt.sha256, rows: rows.length }) };
}
function trajectorySamples(batch, index) {
  const field = `trajectory_batches[${index}]`;
  object(batch, field);
  if (batch.schema !== 'archie-trajectory-batch/v1') throw new Error(`${field} schema is unsupported.`);
  const batchDigest = verifyEmbedded(batch, 'batch_digest', field);
  const admissions = new Map((Array.isArray(batch.admissions) ? batch.admissions : []).map(item => [item.trajectory_digest, item]));
  const samples = [];
  for (const trajectory of Array.isArray(batch.trajectories) ? batch.trajectories : []) {
    const admission = admissions.get(trajectory.trajectory_digest);
    if (!admission?.admitted) throw new Error(`${field} includes a trajectory without an admitted receipt.`);
    const kind = admission.positive ? 'supervised-distillation' : 'negative-suppression';
    const identity = { kind, batch_digest: batchDigest, trajectory_digest: trajectory.trajectory_digest };
    const sample = {
      schema: ARCHIE_TRAINING_SAMPLE_SCHEMA,
      sample_id: sampleId(identity),
      kind,
      group_id: `trajectory:${trajectory.trajectory_digest}`,
      instruction: clean(trajectory.request, 500000),
      compact_context: canonical({ subject: trajectory.subject, provenance: trajectory.provenance }),
      target: admission.positive ? stable({ events: trajectory.events.filter(item => item.type !== 'request'), outcome: trajectory.outcome }) : null,
      reason: admission.negative ? clean(trajectory.outcome?.summary || 'evidenced negative trajectory', 100000) : null,
      provenance: Object.freeze({ batch_digest: batchDigest, trajectory_digest: trajectory.trajectory_digest, admission_digest: admission.admission_digest })
    };
    samples.push(Object.freeze(sample));
  }
  return { samples, evidence: Object.freeze({ batch_digest: batchDigest, admitted: samples.length, positive: samples.filter(item => item.kind === 'supervised-distillation').length, negative: samples.filter(item => item.kind === 'negative-suppression').length }) };
}
function distillationSamples(examples) {
  return (Array.isArray(examples) ? examples : []).map((row, index) => {
    if (row?.schema !== 'archie-distillation-example/v1') throw new Error(`distillation_examples[${index}] schema is unsupported.`);
    const exampleDigest = exactDigest(row.example_digest, `distillation_examples[${index}].example_digest`);
    const negative = row.negative === true || !row.target;
    const kind = negative ? 'negative-suppression' : 'supervised-distillation';
    const identity = { kind, example_digest: exampleDigest };
    return Object.freeze({
      schema: ARCHIE_TRAINING_SAMPLE_SCHEMA,
      sample_id: sampleId(identity),
      kind,
      group_id: `distillation:${clean(row.example_id || exampleDigest, 500)}`,
      instruction: clean(row.instruction, 500000),
      compact_context: canonical(row.compact_context ?? null),
      target: negative ? null : clean(row.target, 1_000_000),
      reason: negative ? clean(row.reason || row.outcome || 'reviewed negative example', 100000) : null,
      provenance: Object.freeze({ example_digest: exampleDigest, source_digest: row.source_digest ? exactDigest(row.source_digest, `distillation_examples[${index}].source_digest`) : null, source_file_sha256: row.source_file_sha256 ? exactDigest(row.source_file_sha256, `distillation_examples[${index}].source_file_sha256`) : null, teacher_evidence: canonical(row.teacher_evidence || null) })
    });
  });
}
function dedupe(samples) {
  const byId = new Map();
  for (const sample of samples) {
    const prior = byId.get(sample.sample_id);
    if (prior && stable(prior) !== stable(sample)) throw new Error(`Conflicting training sample ${sample.sample_id}.`);
    byId.set(sample.sample_id, sample);
  }
  return [...byId.values()].sort((left, right) => left.sample_id.localeCompare(right.sample_id));
}
function splitSamples(samples, seed, holdoutRate) {
  const groups = new Map();
  for (const sample of samples) {
    const rows = groups.get(sample.group_id) || [];
    rows.push({ sample, holdout: false });
    groups.set(sample.group_id, rows);
  }
  for (const [groupId, rows] of groups) {
    const holdout = groupUnit(seed, groupId) < holdoutRate;
    for (const row of rows) row.holdout = holdout;
  }
  const split = [...groups.values()].flat();
  for (const kind of [...new Set(samples.map(item => item.kind))]) {
    const kindRows = split.filter(item => item.sample.kind === kind);
    if (!kindRows.length || !kindRows.every(item => item.holdout)) continue;
    const selectedGroup = [...new Set(kindRows.map(item => item.sample.group_id))].sort()[0];
    for (const row of groups.get(selectedGroup) || []) row.holdout = false;
  }
  return split.sort((left, right) => left.sample.sample_id.localeCompare(right.sample.sample_id));
}
export function compileArchieTrainingPlan({ profile, state_contract, sidepus = [], trajectory_batches = [], distillation_examples = [], code_commit }) {
  const normalizedProfile = normalizeProfile(profile);
  const state = validateArchieStateContract(state_contract);
  const commit = gitOid(code_commit, 'code_commit');
  const sidepusResults = sidepus.map(sidepusSamples);
  const trajectoryResults = trajectory_batches.map(trajectorySamples);
  const samples = dedupe([
    ...sidepusResults.flatMap(item => item.samples),
    ...trajectoryResults.flatMap(item => item.samples),
    ...distillationSamples(distillation_examples)
  ]);
  if (!samples.length) throw new Error('No admissible training samples were supplied.');
  const split = splitSamples(samples, normalizedProfile.seed, normalizedProfile.holdout_rate);
  const pretrain = split.filter(item => !item.holdout && item.sample.kind === 'continued-pretraining').map(item => item.sample);
  const supervised = split.filter(item => !item.holdout && item.sample.kind === 'supervised-distillation').map(item => item.sample);
  const negative = split.filter(item => !item.holdout && item.sample.kind === 'negative-suppression').map(item => item.sample);
  const development = split.filter(item => item.holdout).map(item => Object.freeze({ ...item.sample, split: 'development-holdout-not-promotion-eligible' }));
  const fileTexts = Object.freeze({
    'datasets/pretrain.train.jsonl': jsonl(pretrain),
    'datasets/sft.train.jsonl': jsonl(supervised),
    'datasets/negative.train.jsonl': jsonl(negative),
    'datasets/development-holdout.jsonl': jsonl(development)
  });
  const datasets = Object.fromEntries(Object.entries(fileTexts).map(([filename, text]) => [filename.split('/').pop().replace('.jsonl', ''), descriptor(filename, text)]));
  const inputIdentity = {
    profile_digest: normalizedProfile.digest,
    state_contract_digest: state.state_contract_digest,
    code_commit: commit,
    sidepus_manifest_digests: sidepusResults.map(item => item.evidence.manifest_digest).sort(),
    trajectory_batch_digests: trajectoryResults.map(item => item.evidence.batch_digest).sort(),
    sample_ids: samples.map(item => item.sample_id)
  };
  const inputDigest = digest(inputIdentity);
  const runId = `archie-${clean(normalizedProfile.id, 100)}-${inputDigest.slice(0, 16)}`;
  const stages = [
    { id: 'continued-pretraining', enabled: pretrain.length > 0, dataset: datasets['pretrain.train'], objective: 'causal-language-modeling', execution: 'explicit-trainer-required' },
    { id: 'supervised-distillation', enabled: supervised.length > 0, dataset: datasets['sft.train'], objective: 'supervised-fine-tuning', execution: 'explicit-trainer-required' },
    { id: 'negative-verifier', enabled: negative.length > 0, dataset: datasets['negative.train'], objective: 'failure-and-suppression-calibration', execution: 'verifier-trainer-required' }
  ];
  const planBody = {
    schema: ARCHIE_TRAINING_PLAN_SCHEMA,
    run_id: runId,
    code_commit: commit,
    profile: normalizedProfile,
    base_student: normalizedProfile.student,
    state_contract: { digest: state.state_contract_digest, immutable_digest: state.immutable_digest, mutable_digest: state.mutable_digest, runtime_abi: state.immutable.runtime_abi },
    inputs: {
      input_digest: inputDigest,
      sidepus: sidepusResults.map(item => item.evidence).sort((a, b) => a.manifest_digest.localeCompare(b.manifest_digest)),
      trajectories: trajectoryResults.map(item => item.evidence).sort((a, b) => a.batch_digest.localeCompare(b.batch_digest)),
      distillation_example_digests: distillation_examples.map(item => item.example_digest).sort()
    },
    datasets,
    stages,
    budgets: normalizedProfile.training,
    development_evaluation: { dataset: datasets['development-holdout'], access: 'local-development-visible', promotion_eligible: false, independent_hidden_evaluation_still_required: true },
    counts: { submitted: samples.length, pretrain: pretrain.length, supervised: supervised.length, negative: negative.length, development_holdout: development.length },
    claim_boundary: 'This plan deterministically compiles admitted corpus and trajectory evidence. It does not train, admit, promote, or establish frontier capability.'
  };
  const plan = Object.freeze({ ...planBody, plan_digest: digest(planBody) });
  const receiptBody = {
    schema: ARCHIE_TRAINING_INPUT_RECEIPT_SCHEMA,
    run_id: runId,
    plan_digest: plan.plan_digest,
    input_digest: inputDigest,
    code_commit: commit,
    datasets,
    counts: plan.counts,
    sidepus_manifest_digests: inputIdentity.sidepus_manifest_digests,
    trajectory_batch_digests: inputIdentity.trajectory_batch_digests,
    state_contract_digest: state.state_contract_digest,
    claim_boundary: plan.claim_boundary
  };
  const input_receipt = Object.freeze({ ...receiptBody, receipt_digest: digest(receiptBody) });
  return Object.freeze({ plan, input_receipt, files: fileTexts });
}
export function verifyArchieTrainingPlan(value) {
  if (value?.schema !== ARCHIE_TRAINING_PLAN_SCHEMA) throw new Error('Unsupported Archie training plan schema.');
  return verifyEmbedded(value, 'plan_digest', 'training_plan');
}
export function createStudentTrainingReceipt({ plan, checkpoint, artifact, tokenizer = null, metrics = {}, trainer = {}, started_at = null, finished_at = null }) {
  const planDigest = verifyArchieTrainingPlan(plan);
  const checkpointValue = validateArchieCheckpoint(checkpoint);
  if (checkpointValue.immutable_digest !== plan.state_contract.immutable_digest) throw new Error('Checkpoint immutable digest does not match the training plan.');
  if (checkpointValue.runtime_abi !== plan.state_contract.runtime_abi) throw new Error('Checkpoint runtime ABI does not match the training plan.');
  if (checkpointValue.training.code_commit !== plan.code_commit) throw new Error('Checkpoint code commit does not match the training plan.');
  const checkpointDatasets = [...checkpointValue.training.dataset_digests].sort();
  const planDatasets = Object.values(plan.datasets).map(item => item.sha256).sort();
  if (stable(checkpointDatasets) !== stable(planDatasets)) throw new Error('Checkpoint dataset digests do not match the compiled plan.');
  if (stable([...checkpointValue.training.trajectory_batch_digests].sort()) !== stable([...plan.inputs.trajectories.map(item => item.batch_digest)].sort())) throw new Error('Checkpoint trajectory batches do not match the compiled plan.');
  const artifactValue = object(artifact, 'artifact');
  const artifactSha = exactDigest(artifactValue.sha256, 'artifact.sha256');
  const body = {
    schema: ARCHIE_STUDENT_TRAINING_RECEIPT_SCHEMA,
    run_id: plan.run_id,
    plan_digest: planDigest,
    input_digest: plan.inputs.input_digest,
    code_commit: plan.code_commit,
    state_contract_digest: plan.state_contract.digest,
    checkpoint_digest: exactDigest(checkpointValue.checkpoint_digest, 'checkpoint.checkpoint_digest'),
    mutable_digest: exactDigest(checkpointValue.mutable_digest, 'checkpoint.mutable_digest'),
    artifact: { path: clean(artifactValue.path, 1000), sha256: artifactSha, bytes: Number(artifactValue.bytes), format: clean(artifactValue.format, 200), model_id: clean(artifactValue.model_id, 300), checkpoint_id: clean(artifactValue.checkpoint_id, 300) },
    tokenizer: tokenizer ? canonical(tokenizer) : null,
    sidepus_manifest_digests: [...plan.inputs.sidepus.map(item => item.manifest_digest)].sort(),
    trajectory_batch_digests: [...plan.inputs.trajectories.map(item => item.batch_digest)].sort(),
    dataset_digests: Object.values(plan.datasets).map(item => item.sha256).sort(),
    trainer: canonical(trainer),
    metrics: canonical(metrics),
    started_at: started_at ? clean(started_at, 100) : null,
    finished_at: finished_at ? clean(finished_at, 100) : null,
    promotion: 'not-admitted',
    claim_boundary: 'This receipt binds one executed training run and artifact. Independent evaluation, authority, reproduction, resources, embodiment, and launch admission remain required.'
  };
  if (!Number.isSafeInteger(body.artifact.bytes) || body.artifact.bytes <= 0) throw new Error('artifact.bytes must be a positive safe integer.');
  return Object.freeze({ ...body, receipt_digest: digest(body) });
}
export function verifyStudentTrainingReceipt(value) {
  if (value?.schema !== ARCHIE_STUDENT_TRAINING_RECEIPT_SCHEMA) throw new Error('Unsupported Archie student training receipt schema.');
  return verifyEmbedded(value, 'receipt_digest', 'training_receipt');
}
export function brainPackageInputFromTraining({ plan, checkpoint, training_receipt, tokenizer, architecture, evaluation_receipts = [], authority_policy = null, hardware_envelope = null, parent_digest = null }) {
  verifyArchieTrainingPlan(plan);
  verifyStudentTrainingReceipt(training_receipt);
  if (training_receipt.plan_digest !== plan.plan_digest) throw new Error('Training receipt is bound to a different plan.');
  if (training_receipt.checkpoint_digest !== checkpoint?.checkpoint_digest) throw new Error('Training receipt is bound to a different checkpoint.');
  return Object.freeze({
    package_id: `${plan.run_id}:${training_receipt.artifact.checkpoint_id}`,
    runtime_abi: plan.state_contract.runtime_abi,
    working_state_schema: 'archie-working-state/v1',
    tokenizer: canonical(tokenizer),
    architecture: canonical(architecture),
    artifacts: [
      { role: 'student-model', digest: training_receipt.artifact.sha256, bytes: training_receipt.artifact.bytes, media_type: 'application/octet-stream' },
      { role: 'checkpoint-receipt', digest: training_receipt.checkpoint_digest, bytes: Buffer.byteLength(stable(checkpoint)), media_type: 'application/json' },
      { role: 'training-receipt', digest: training_receipt.receipt_digest, bytes: Buffer.byteLength(stable(training_receipt)), media_type: 'application/json' }
    ],
    sidepus_manifest_digests: training_receipt.sidepus_manifest_digests,
    evaluation_receipts,
    authority_policy,
    hardware_envelope,
    parent_digest,
    metadata: { plan_digest: plan.plan_digest, trajectory_batch_digests: training_receipt.trajectory_batch_digests, state_contract_digest: plan.state_contract.digest }
  });
}
