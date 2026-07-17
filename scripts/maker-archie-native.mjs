import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createArchieLinuxCorpus } from './maker-archie-corpus.mjs';
import { createArchiePersonalBrain } from './maker-archie-brain.mjs';
import { createOpenAIArchieTeacher } from './maker-archie-openai-teacher.mjs';
import { normalizeMakerExecutionPlan } from './maker-archie-runtime-contract.mjs';

const clean = (value, limit = 12000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);

function disabled(env) {
  return /^(?:1|true|yes|on)$/i.test(clean(env?.ARCHIE_DISABLED, 20));
}

function repoKey(repoRoot) {
  const absolute = path.resolve(repoRoot);
  const name = path.basename(absolute).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repository';
  const suffix = crypto.createHash('sha256').update(absolute).digest('hex').slice(0, 12);
  return `${name}-${suffix}`;
}

function valueDigest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}

function normalizedInstruction(value) {
  return clean(value, 12000).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function resolveNativeArchiePaths(repoRoot, { env = process.env, home = os.homedir() } = {}) {
  if (!repoRoot) throw new Error('repoRoot is required.');
  const root = path.resolve(clean(env?.ARCHIE_CORPUS_ROOT) || path.join(home, '.sideways', 'archie', repoKey(repoRoot)));
  return Object.freeze({ root, model_path: path.join(root, 'models', 'native-maker-plans.json') });
}

export const normalizeReusableMakerPlan = normalizeMakerExecutionPlan;

export function nativeMakerReceiptForCorpus(receipt, { repoRoot } = {}) {
  const plan = normalizeReusableMakerPlan(receipt?.plan);
  const verification = Array.isArray(receipt?.verification) ? receipt.verification.map(item => clean(item, 1000)).filter(Boolean) : [];
  const repository = clean(receipt?.repository || repoRoot || 'default', 1000);
  const result = {
    branch: clean(receipt?.branch, 1000),
    pull_request: clean(receipt?.pull_request, 2000),
    head_sha: clean(receipt?.head_sha, 200),
    writer_summary: clean(receipt?.writer_summary, 200000),
    verification
  };
  return Object.freeze({
    schema: 'sideways-maker-runtime-platform-receipt/v1',
    platform_run_id: clean(receipt?.session_id || receipt?.platform_run_id, 300),
    state: clean(receipt?.state || (receipt?.head_sha ? 'completed' : 'unknown'), 100),
    task: {
      repository,
      request: clean(receipt?.request, 500000),
      mode: 'native-maker',
      protect: 'Human merge and deployment remain required.',
      proof: {
        base_sha: clean(receipt?.base_sha, 200),
        head_sha: clean(receipt?.head_sha, 200),
        verification
      }
    },
    components: {
      model_route: {
        receipt_digest: valueDigest(plan),
        provider: { id: 'sideways-native-maker', display_name: 'Sideways Native Maker' },
        output: { plan },
        attempts: verification.map((item, index) => ({ provider_id: 'native-verifier', status: 'completed', duration_ms: null, verification: item, sequence: index + 1 })),
        usage: { cost_usd: null }
      },
      dispatch: { ok: true, adapter: `native-maker-${clean(receipt?.selected_lane || plan?.selected_lane || 'unknown', 120)}`, output: { result } },
      control_job: { result }
    }
  });
}

function createNativeBrain({ repoRoot, env, home, clock, training }) {
  const paths = resolveNativeArchiePaths(repoRoot, { env, home });
  const corpus = createArchieLinuxCorpus({ root: paths.root, clock });
  const brain = createArchiePersonalBrain({
    corpus,
    model_path: paths.model_path,
    teacher: createOpenAIArchieTeacher({ env, clock }),
    clock,
    training: { dimensions: 1024, threshold: 0.22, minimum_margin: 0.03, ...(training || {}) }
  });
  return { paths, corpus, brain };
}

export async function recallNativeMakerPlan({ repoRoot, request, baseBranch = 'main', baseSha = '', env = process.env, home = os.homedir(), clock = Date.now, training = {} } = {}) {
  if (disabled(env)) return Object.freeze({ status: 'disabled', plan: null });
  const instruction = clean(request);
  if (!instruction) return Object.freeze({ status: 'miss', plan: null, reason: 'empty request' });
  const { paths, corpus, brain } = createNativeBrain({ repoRoot, env, home, clock, training });
  try {
    const result = await brain.plan({ subject: repoKey(repoRoot), instruction, context: { repository: path.basename(path.resolve(repoRoot)), base_branch: clean(baseBranch, 200), base_sha: clean(baseSha, 200) } }, { allow_teacher: true });
    const teacherPlan = result.state === 'teacher';
    const plan = result.state === 'local' || teacherPlan ? normalizeReusableMakerPlan(result.plan) : null;
    let executionEligible = false;
    let executionBasis = null;
    let sourceExampleIds = [];
    if (plan && result.specialist_id) {
      const model = await brain.load();
      const specialist = model.specialists.find(item => item.specialist_id === result.specialist_id);
      sourceExampleIds = Array.isArray(specialist?.source_example_ids) ? specialist.source_example_ids : [];
      if (sourceExampleIds.length) {
        const sourceSet = new Set(sourceExampleIds);
        const examples = await corpus.examples({ limit: training.limit || 100000 });
        const exact = examples.find(example => {
          if (!sourceSet.has(example.example_id) || normalizedInstruction(example.instruction) !== normalizedInstruction(instruction)) return false;
          const proof = example.compact_context?.proof;
          return Boolean(
            clean(baseSha, 200)
            && clean(proof?.base_sha, 200) === clean(baseSha, 200)
            && clean(proof?.head_sha, 200)
            && Array.isArray(proof?.verification)
            && proof.verification.some(item => clean(item, 1000))
          );
        });
        if (exact) {
          executionEligible = true;
          executionBasis = Object.freeze({
            kind: 'normalized-exact-verified-recurrence',
            example_id: exact.example_id,
            base_sha: clean(baseSha, 200)
          });
        }
      }
    }
    if (teacherPlan && plan && result.teacher_receipt) {
      executionEligible = true;
      executionBasis = Object.freeze({
        kind: 'fresh-bounded-teacher-plan',
        response_id: clean(result.teacher_receipt.response_id, 300),
        teacher_receipt_digest: clean(result.teacher_receipt.receipt_digest, 200),
        base_sha: clean(baseSha, 200)
      });
    }
    return Object.freeze({
      status: teacherPlan && plan ? 'teacher' : plan ? 'local' : 'miss',
      source: teacherPlan ? 'openai-responses-teacher' : 'native-maker-recall',
      plan,
      confidence: result.confidence ?? 0,
      margin: result.margin ?? 0,
      specialist_id: result.specialist_id ?? null,
      source_example_ids: sourceExampleIds,
      execution_eligible: executionEligible,
      execution_basis: executionBasis,
      teacher_receipt: result.teacher_receipt ?? null,
      root: paths.root,
      model_digest: result.model_digest ?? null,
      reason: teacherPlan ? 'fresh bounded teacher plan admitted to Maker gates' : plan ? (executionEligible ? null : 'recall remains advisory unless an exact verified recurrence matches the current base SHA') : `archie state ${result.state}`
    });
  } catch (error) {
    const message = clean(error?.message || error, 2000);
    if (/at least one completed archie distillation example is required/i.test(message)) return Object.freeze({ status: 'miss', plan: null, root: paths.root, reason: 'empty corpus' });
    return Object.freeze({ status: 'failed', plan: null, root: paths.root, reason: message });
  }
}

export async function rememberNativeMakerRun({ repoRoot, receipt, env = process.env, home = os.homedir(), clock = Date.now, training = {} } = {}) {
  if (disabled(env)) return Object.freeze({ status: 'disabled' });
  const { paths, corpus, brain } = createNativeBrain({ repoRoot, env, home, clock, training });
  try {
    const normalized = nativeMakerReceiptForCorpus(receipt, { repoRoot });
    const corpusReceipt = await corpus.recordMakerRun(normalized, { input: { request: normalized.task.request } });
    const model = await brain.train();
    return Object.freeze({ status: corpusReceipt.status, record_id: corpusReceipt.record_id, example_id: corpusReceipt.example_id, root: paths.root, model_digest: model.model_digest, document_count: model.document_count, specialist_count: model.specialist_count });
  } catch (error) {
    return Object.freeze({ status: 'failed', root: paths.root, error: clean(error?.message || error, 2000) });
  }
}
