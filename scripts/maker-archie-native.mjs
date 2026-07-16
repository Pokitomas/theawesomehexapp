import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createArchieLinuxCorpus } from './maker-archie-corpus.mjs';
import { createArchiePersonalBrain } from './maker-archie-brain.mjs';

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

export function resolveNativeArchiePaths(repoRoot, { env = process.env, home = os.homedir() } = {}) {
  if (!repoRoot) throw new Error('repoRoot is required.');
  const root = path.resolve(clean(env?.ARCHIE_CORPUS_ROOT) || path.join(home, '.sideways', 'archie', repoKey(repoRoot)));
  return Object.freeze({ root, model_path: path.join(root, 'models', 'native-maker-plans.json') });
}

export function normalizeReusableMakerPlan(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const title = clean(value.title, 200);
  const selectedLane = clean(value.selected_lane, 120);
  const whyNow = clean(value.why_now, 4000);
  const branchSlug = clean(value.branch_slug || title, 160);
  const ownedPaths = [...new Set((Array.isArray(value.owned_paths) ? value.owned_paths : []).map(item => clean(item, 1000)).filter(Boolean))];
  const deferred = (Array.isArray(value.deferred) ? value.deferred : []).map(item => clean(item, 2000)).filter(Boolean).slice(0, 100);
  if (!title || !selectedLane || !whyNow || !branchSlug || !ownedPaths.length) return null;
  return Object.freeze({ ...value, title, selected_lane: selectedLane, why_now: whyNow, branch_slug: branchSlug, owned_paths: ownedPaths, deferred });
}

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
    task: { repository, request: clean(receipt?.request, 500000), mode: 'native-maker', protect: 'Human merge and deployment remain required.' },
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
    clock,
    training: { dimensions: 1024, threshold: 0.22, minimum_margin: 0.03, ...(training || {}) }
  });
  return { paths, corpus, brain };
}

export async function recallNativeMakerPlan({ repoRoot, request, baseBranch = 'main', env = process.env, home = os.homedir(), clock = Date.now, training = {} } = {}) {
  if (disabled(env)) return Object.freeze({ status: 'disabled', plan: null });
  const instruction = clean(request);
  if (!instruction) return Object.freeze({ status: 'miss', plan: null, reason: 'empty request' });
  const { paths, brain } = createNativeBrain({ repoRoot, env, home, clock, training });
  try {
    const result = await brain.plan({ subject: repoKey(repoRoot), instruction, context: { repository: path.basename(path.resolve(repoRoot)), base_branch: clean(baseBranch, 200) } }, { allow_teacher: false });
    const plan = result.state === 'local' ? normalizeReusableMakerPlan(result.plan) : null;
    return Object.freeze({ status: plan ? 'local' : 'miss', plan, confidence: result.confidence ?? 0, margin: result.margin ?? 0, specialist_id: result.specialist_id ?? null, root: paths.root, model_digest: result.model_digest ?? null, reason: plan ? null : `archie state ${result.state}` });
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
