import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createArchieLinuxCorpus } from './maker-archie-corpus.mjs';
import { createArchiePersonalBrain } from './maker-archie-brain.mjs';
import { createOpenAIArchieTeacher, isOpenAIArchieTeacherConfigured } from './maker-archie-openai-teacher.mjs';
import { archieMakerValueDigest, normalizeMakerExecutionPlan } from './maker-archie-runtime-contract.mjs';
import { collectRepositoryEvidence } from './maker-archie-repository-evidence.mjs';

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
  return archieMakerValueDigest(value);
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

function teacherDecision(receipt) {
  const decision = receipt?.archie_decision;
  return decision?.state === 'teacher' || decision?.execution_basis?.kind === 'fresh-bounded-teacher-plan' ? decision : null;
}

function localDecision(receipt) {
  const decision = receipt?.archie_decision;
  return decision?.state === 'local' || decision?.execution_basis?.kind === 'normalized-exact-verified-recurrence' ? decision : null;
}

export function nativeMakerReceiptForCorpus(receipt, { repoRoot } = {}) {
  const plan = normalizeReusableMakerPlan(receipt?.plan);
  const verification = Array.isArray(receipt?.verification) ? receipt.verification.map(item => clean(item, 1000)).filter(Boolean) : [];
  const repository = clean(receipt?.repository || repoRoot || 'default', 1000);
  const decision = teacherDecision(receipt);
  const teacherReceipt = decision?.teacher_receipt || null;
  const teacherResponseId = clean(teacherReceipt?.response_id || decision?.execution_basis?.response_id, 300) || null;
  const teacherReceiptDigest = clean(teacherReceipt?.receipt_digest || decision?.execution_basis?.teacher_receipt_digest, 200) || null;
  const repositoryEvidenceDigest = clean(teacherReceipt?.repository_evidence_digest || decision?.repository_evidence_digest || decision?.execution_basis?.repository_evidence_digest, 200) || null;
  const result = {
    branch: clean(receipt?.branch, 1000),
    pull_request: clean(receipt?.pull_request, 2000),
    head_sha: clean(receipt?.head_sha, 200),
    writer_summary: clean(receipt?.writer_summary, 200000),
    verification,
    teacher_response_id: teacherResponseId,
    teacher_receipt_digest: teacherReceiptDigest,
    repository_evidence_digest: repositoryEvidenceDigest
  };
  const state = clean(receipt?.state || (receipt?.head_sha ? 'completed' : 'unknown'), 100);
  return Object.freeze({
    schema: 'sideways-maker-runtime-platform-receipt/v1',
    platform_run_id: clean(receipt?.session_id || receipt?.platform_run_id, 300),
    state,
    task: {
      repository,
      request: clean(receipt?.request, 500000),
      mode: 'native-maker',
      protect: 'Human merge and deployment remain required.',
      proof: {
        base_sha: clean(receipt?.base_sha, 200),
        head_sha: clean(receipt?.head_sha, 200),
        verification,
        plan_digest: plan ? valueDigest(plan) : null,
        teacher_response_id: result.teacher_response_id,
        teacher_receipt_digest: result.teacher_receipt_digest,
        repository_evidence_digest: result.repository_evidence_digest
      }
    },
    components: {
      model_route: {
        receipt_digest: teacherReceiptDigest || valueDigest(plan),
        provider: decision
          ? { id: clean(teacherReceipt?.model || 'bounded-teacher', 300), display_name: 'OpenAI bounded Archie teacher', engine_label: clean(teacherReceipt?.teacher || 'openai-responses', 300) }
          : { id: 'sideways-native-maker', display_name: 'Sideways Native Maker' },
        output: { plan },
        attempts: [
          ...(decision ? [{ provider_id: clean(teacherReceipt?.model || 'bounded-teacher', 300), status: 'completed', duration_ms: null, response_id: teacherResponseId }] : []),
          ...verification.map((item, index) => ({ provider_id: 'native-verifier', status: 'completed', duration_ms: null, verification: item, sequence: index + 1 }))
        ],
        usage: { cost_usd: null }
      },
      dispatch: { ok: state === 'completed', adapter: `native-maker-${clean(receipt?.selected_lane || plan?.selected_lane || 'unknown', 120)}`, output: { result } },
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
    training: {
      dimensions: 8192,
      threshold: 0.22,
      minimum_margin: 0.03,
      negative_suppression_threshold: 0.55,
      negative_penalty: 0.65,
      duplicate_weight_cap: 5,
      reliability_prior_alpha: 1,
      reliability_prior_beta: 1,
      reliability_floor: 0.6,
      reliability_activation_min: 3,
      calibrate_operating_point: true,
      cross_validation_folds: 5,
      cross_validation_minimum_documents: 4,
      cross_validation_target_precision: 0.9,
      limit: 250000,
      ...(training || {})
    }
  });
  return { paths, corpus, brain };
}

export async function recallNativeMakerPlan({ repoRoot, request, baseBranch = 'main', baseSha = '', env = process.env, home = os.homedir(), clock = Date.now, training = {} } = {}) {
  if (disabled(env)) return Object.freeze({ status: 'disabled', plan: null });
  const instruction = clean(request);
  if (!instruction) return Object.freeze({ status: 'miss', plan: null, reason: 'empty request' });
  const { paths, corpus, brain } = createNativeBrain({ repoRoot, env, home, clock, training });
  try {
    const repositoryEvidence = isOpenAIArchieTeacherConfigured(env)
      ? await collectRepositoryEvidence({
          repoRoot,
          baseSha,
          request: instruction,
          maxPaths: Number(env.ARCHIE_REPOSITORY_EVIDENCE_MAX_PATHS || 12000),
          maxSourceFiles: Number(env.ARCHIE_REPOSITORY_EVIDENCE_MAX_SOURCE_FILES || 64),
          maxFileBytes: Number(env.ARCHIE_REPOSITORY_EVIDENCE_MAX_FILE_BYTES || 24576),
          maxSourceBytes: Number(env.ARCHIE_REPOSITORY_EVIDENCE_MAX_SOURCE_BYTES || 393216)
        })
      : null;
    const result = await brain.plan({
      subject: repoKey(repoRoot),
      instruction,
      context: {
        repository: path.basename(path.resolve(repoRoot)),
        base_branch: clean(baseBranch, 200),
        base_sha: clean(baseSha, 200),
        repository_evidence: repositoryEvidence
      }
    }, { allow_teacher: true });
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
        const examples = await corpus.examples({ limit: training.limit || 250000 });
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
          executionBasis = Object.freeze({ kind: 'normalized-exact-verified-recurrence', example_id: exact.example_id, base_sha: clean(baseSha, 200) });
        }
      }
    }
    if (teacherPlan && plan && result.teacher_receipt && repositoryEvidence) {
      const receiptEvidenceMatches = result.teacher_receipt.repository_evidence_digest === repositoryEvidence.evidence_digest;
      executionEligible = receiptEvidenceMatches;
      if (receiptEvidenceMatches) {
        executionBasis = Object.freeze({
          kind: 'fresh-bounded-teacher-plan',
          response_id: clean(result.teacher_receipt.response_id, 300),
          teacher_receipt_digest: clean(result.teacher_receipt.receipt_digest, 200),
          repository_evidence_digest: repositoryEvidence.evidence_digest,
          base_sha: clean(baseSha, 200)
        });
      }
    }
    return Object.freeze({
      status: teacherPlan && plan ? 'teacher' : plan ? 'local' : 'miss',
      source: teacherPlan ? 'openai-responses-teacher' : 'native-maker-recall',
      plan,
      confidence: result.confidence ?? 0,
      similarity_confidence: result.similarity_confidence ?? result.confidence ?? 0,
      calibrated_confidence: result.calibrated_confidence ?? result.confidence ?? 0,
      raw_confidence: result.raw_confidence ?? result.confidence ?? 0,
      negative_score: result.negative_score ?? 0,
      negative_suppressed: result.negative_suppressed ?? false,
      margin: result.margin ?? 0,
      reliability: result.reliability ?? null,
      specialist_id: result.specialist_id ?? null,
      source_example_ids: sourceExampleIds,
      execution_eligible: executionEligible,
      execution_basis: executionBasis,
      teacher_receipt: result.teacher_receipt ?? null,
      repository_evidence_digest: repositoryEvidence?.evidence_digest || null,
      root: paths.root,
      model_digest: result.model_digest ?? null,
      reason: teacherPlan
        ? (executionEligible ? 'fresh evidence-bound teacher plan admitted to Maker gates' : 'teacher plan lacked exact repository-evidence binding')
        : plan
          ? (executionEligible ? null : 'recall remains advisory unless an exact verified recurrence matches the current base SHA')
          : `archie state ${result.state}`
    });
  } catch (error) {
    const message = clean(error?.message || error, 2000);
    if (/at least one completed archie distillation example is required/i.test(message)) return Object.freeze({ status: 'miss', plan: null, root: paths.root, reason: 'empty corpus' });
    return Object.freeze({ status: 'failed', plan: null, root: paths.root, reason: message });
  }
}

async function assertTeacherPromotion(corpus, receipt, normalized) {
  const decision = teacherDecision(receipt);
  if (!decision) return null;
  const teacherReceipt = decision.teacher_receipt || null;
  const responseId = clean(teacherReceipt?.response_id || decision.execution_basis?.response_id, 300);
  const receiptDigest = clean(teacherReceipt?.receipt_digest || decision.execution_basis?.teacher_receipt_digest, 200);
  const evidenceDigest = clean(teacherReceipt?.repository_evidence_digest || decision.repository_evidence_digest || decision.execution_basis?.repository_evidence_digest, 200);
  if (!responseId || !receiptDigest || !evidenceDigest) throw new Error('Teacher promotion lacks the original teacher response, receipt, or evidence identity.');
  if (teacherReceipt) {
    if (teacherReceipt.request_digest !== valueDigest(clean(receipt.request, 500000))) throw new Error('Teacher promotion request digest mismatch.');
    if (teacherReceipt.plan_digest !== valueDigest(normalizeReusableMakerPlan(receipt.plan))) throw new Error('Teacher promotion plan digest mismatch.');
    if (clean(teacherReceipt.base_sha, 200) !== clean(receipt.base_sha, 200)) throw new Error('Teacher promotion base SHA mismatch.');
  }
  if (decision.execution_basis?.response_id !== responseId) throw new Error('Teacher promotion response ID mismatch.');
  if (decision.execution_basis?.teacher_receipt_digest !== receiptDigest) throw new Error('Teacher promotion receipt digest mismatch.');
  if (clean(decision.execution_basis?.repository_evidence_digest || decision.repository_evidence_digest, 200) !== evidenceDigest) throw new Error('Teacher promotion repository evidence mismatch.');
  const pending = await corpus.findBySourceRunId(responseId, { kind: 'archie_teacher_plan' });
  if (!pending || pending.outcome !== 'proposed') throw new Error('Teacher promotion has no matching pending proposal.');
  if (clean(pending.input?.text, 500000) !== clean(receipt.request, 500000)) throw new Error('Teacher promotion pending request mismatch.');
  if (valueDigest(pending.output?.plan) !== valueDigest(normalizeReusableMakerPlan(receipt.plan))) throw new Error('Teacher promotion pending plan mismatch.');
  if (clean(pending.source?.route_digest, 200) !== receiptDigest) throw new Error('Teacher promotion pending receipt identity mismatch.');
  if (clean(pending.input?.context?.base_sha, 200) !== clean(receipt.base_sha, 200)) throw new Error('Teacher promotion pending base SHA mismatch.');
  if (clean(pending.input?.context?.repository_evidence?.evidence_digest, 200) !== evidenceDigest) throw new Error('Teacher promotion pending repository evidence mismatch.');
  if (normalized.state === 'completed') {
    if (!clean(receipt.head_sha, 200)) throw new Error('Teacher promotion requires a completed head SHA.');
    if (!normalized.task.proof.verification.length) throw new Error('Teacher promotion requires nonempty independent verification.');
  }
  return pending;
}

export async function rememberNativeMakerRun({ repoRoot, receipt, env = process.env, home = os.homedir(), clock = Date.now, training = {} } = {}) {
  if (disabled(env)) return Object.freeze({ status: 'disabled' });
  const { paths, corpus, brain } = createNativeBrain({ repoRoot, env, home, clock, training });
  try {
    const normalized = nativeMakerReceiptForCorpus(receipt, { repoRoot });
    await assertTeacherPromotion(corpus, receipt, normalized);
    const corpusReceipt = await corpus.recordMakerRun(normalized, { input: { request: normalized.task.request } });
    const local = localDecision(receipt);
    const reuseReceipt = local?.specialist_id
      ? await brain.recordPlanOutcome({
          specialist_id: local.specialist_id,
          task: {
            subject: repoKey(repoRoot),
            instruction: normalized.task.request,
            context: {
              repository: normalized.task.repository,
              base_sha: normalized.task.proof.base_sha,
              head_sha: normalized.task.proof.head_sha,
              verification: normalized.task.proof.verification
            }
          },
          plan: normalized.components.model_route.output.plan,
          state: normalized.state,
          model_digest: local.model_digest,
          plan_digest: local.plan_digest || normalized.task.proof.plan_digest,
          run_id: normalized.platform_run_id,
          receipt
        })
      : null;
    const shouldRetrain = corpusReceipt.status !== 'deduplicated' || (reuseReceipt && reuseReceipt.status !== 'deduplicated');
    if (normalized.state !== 'completed') {
      let model = null;
      try { model = shouldRetrain ? await brain.train() : await brain.load(); }
      catch (error) {
        if (!/at least one completed archie distillation example is required/i.test(clean(error?.message || error, 2000))) throw error;
      }
      return Object.freeze({
        status: corpusReceipt.status,
        learning_disposition: local ? 'negative-evidence-and-local-reliability-recorded' : 'negative-evidence-recorded',
        record_id: corpusReceipt.record_id,
        example_id: corpusReceipt.example_id,
        reuse_record_id: reuseReceipt?.record_id || null,
        root: paths.root,
        model_digest: model?.model_digest || null,
        document_count: model?.document_count || 0,
        unique_document_count: model?.unique_document_count || 0,
        negative_document_count: model?.negative_document_count || 1,
        specialist_count: model?.specialist_count || 0,
        reliability_evidence_count: model?.reliability_evidence_count || 0
      });
    }
    const model = shouldRetrain ? await brain.train() : await brain.load();
    return Object.freeze({
      status: corpusReceipt.status,
      learning_disposition: teacherDecision(receipt)
        ? 'teacher-proposal-promoted-after-verification'
        : local
          ? 'verified-local-reuse-recorded'
          : 'verified-run-admitted',
      record_id: corpusReceipt.record_id,
      example_id: corpusReceipt.example_id,
      reuse_record_id: reuseReceipt?.record_id || null,
      root: paths.root,
      model_digest: model.model_digest,
      document_count: model.document_count,
      unique_document_count: model.unique_document_count,
      negative_document_count: model.negative_document_count,
      specialist_count: model.specialist_count,
      reliability_evidence_count: model.reliability_evidence_count
    });
  } catch (error) {
    return Object.freeze({ status: 'failed', root: paths.root, error: clean(error?.message || error, 2000) });
  }
}
