import crypto from 'node:crypto';

const SHA_RE = /^[0-9a-f]{40}$/i;
const PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.git(?:\/|$))(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._@+\/-]+$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;
const ADOPTION_FAILURES = new Set(['model_or_runtime_error', 'planning_blocked', 'budget_exhausted', 'verification_blocked', 'failed', 'cancelled', 'timed_out']);
const clean = (value, limit = 20000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const sortedUnique = values => [...new Set(values)].sort();

export const PLATFORM_LANES = Object.freeze([
  { issue: 301, purpose: 'cross-repository workspace', paths: ['scripts/maker-target-workspace.mjs', 'scripts/tests/maker-target-workspace.test.mjs', 'maker/contracts/target-workspace.schema.json'] },
  { issue: 302, purpose: 'GitHub authority and repository lifecycle', paths: ['scripts/maker-github-broker.mjs', 'scripts/tests/maker-github-broker.test.mjs', 'maker/contracts/github-authority.schema.json'] },
  { issue: 303, purpose: 'bounded developer tool runtime', paths: ['maker/runtime/tool-broker.mjs', 'scripts/tests/maker-tool-broker.test.mjs', 'maker/contracts/tool-policy.schema.json'] },
  { issue: 304, purpose: 'operator cockpit', paths: ['maker/index.html', 'maker/maker.css', 'maker/maker.js', 'maker/sw.js', 'maker/manifest.webmanifest', 'scripts/tests/maker-console.test.mjs', 'scripts/tests/maker-console-phone.mjs'] },
  { issue: 305, purpose: 'CI review repair release deployment loop', paths: ['scripts/maker-delivery-loop.mjs', 'scripts/tests/maker-delivery-loop.test.mjs', 'maker/contracts/delivery-loop.schema.json'] },
  { issue: 306, purpose: 'repository intelligence', paths: ['scripts/maker-repository-intelligence.mjs', 'scripts/tests/maker-repository-intelligence.test.mjs', 'maker/contracts/repository-intelligence.schema.json'] },
  { issue: 307, purpose: 'transactional editing', paths: ['maker/runtime/edit-broker.mjs', 'scripts/tests/maker-edit-broker.test.mjs', 'maker/contracts/edit-transaction.schema.json'] },
  { issue: 308, purpose: 'recursive orchestration and memory', paths: ['scripts/maker-orchestrator.mjs', 'scripts/tests/maker-orchestrator.test.mjs', 'maker/contracts/orchestration.schema.json'] },
  { issue: 309, purpose: 'security and capability policy', paths: ['scripts/maker-security-policy.mjs', 'scripts/tests/maker-security-policy.test.mjs', 'maker/contracts/security-policy.schema.json'] },
  { issue: 310, purpose: 'evaluation and capability admission', paths: ['scripts/maker-evaluation.mjs', 'scripts/tests/maker-evaluation.test.mjs', 'maker/evaluations/capability-suite.json', 'maker/contracts/evaluation-receipt.schema.json'] },
  { issue: 311, purpose: 'local and hosted control plane', paths: ['scripts/maker-control-plane.mjs', 'scripts/maker-control-cli.mjs', 'scripts/tests/maker-control-plane.test.mjs', 'maker/contracts/control-plane.schema.json'] },
  { issue: 312, purpose: 'Linux and connector relay', paths: ['scripts/maker-linux-relay.mjs', 'scripts/tests/maker-linux-relay.test.mjs', 'maker/contracts/linux-relay.schema.json'] },
  { issue: 313, purpose: 'model provider routing', paths: ['scripts/maker-model-router.mjs', 'scripts/tests/maker-model-router.test.mjs', 'maker/contracts/model-router.schema.json'] },
  { issue: 314, purpose: 'worker fleet', paths: ['scripts/maker-worker-fleet.mjs', 'scripts/tests/maker-worker-fleet.test.mjs', 'maker/contracts/worker-fleet.schema.json'] },
  { issue: 315, purpose: 'permissioned plugin registry', paths: ['scripts/maker-plugin-registry.mjs', 'scripts/tests/maker-plugin-registry.test.mjs', 'maker/contracts/plugin-manifest.schema.json'] }
].map(lane => Object.freeze({ ...lane, paths: Object.freeze([...lane.paths]) })));

export const INTEGRATION_ORDER = Object.freeze([301, 302, 309, 306, 307, 303, 308, 313, 314, 315, 311, 305, 304, 310, 312]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]));
}

export function stableJSONStringify(value) {
  return JSON.stringify(canonical(value));
}

export function digest(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableJSONStringify(value)).digest('hex');
}

function normalizePath(value) {
  const normalized = clean(value, 1000).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!PATH_RE.test(normalized) || normalized.includes('//')) throw new Error(`Invalid repository path: ${JSON.stringify(value)}.`);
  return normalized;
}

function laneMap(lanes = PLATFORM_LANES) {
  const map = new Map();
  const pathOwners = new Map();
  for (const input of lanes) {
    const issue = Number(input.issue);
    if (!Number.isInteger(issue) || issue < 1 || map.has(issue)) throw new Error(`Invalid or duplicate source issue: ${input.issue}.`);
    const paths = sortedUnique((input.paths || []).map(normalizePath));
    if (!paths.length || !paths.some(value => value.startsWith('scripts/tests/'))) throw new Error(`Lane #${issue} must own executable tests.`);
    for (const file of paths) {
      if (pathOwners.has(file)) throw new Error(`Source lane collision: ${file} is owned by #${pathOwners.get(file)} and #${issue}.`);
      pathOwners.set(file, issue);
    }
    map.set(issue, Object.freeze({ issue, purpose: clean(input.purpose, 500), paths: Object.freeze(paths) }));
  }
  return map;
}

export function parseLeaseMarker(body = '') {
  const matches = [...String(body).matchAll(/<!--\s*sideways-(?:maker|path)-lease(?::|\/)v1\s*([\s\S]*?)-->/gi)];
  for (const match of matches.reverse()) {
    try {
      const value = JSON.parse(match[1].trim());
      if (!Array.isArray(value.owned_paths)) continue;
      return {
        schema: 'sideways-maker-lease/v1',
        session_id: clean(value.session_id || value.branch || 'source-lease', 300),
        base_branch: clean(value.base_branch || 'main', 200),
        base_sha: clean(value.base_sha, 40).toLowerCase(),
        branch: clean(value.branch, 240),
        writer_count: Number(value.writer_count),
        owned_paths: sortedUnique(value.owned_paths.map(normalizePath)),
        authority: {
          merge: clean(value.authority?.merge || 'human', 40),
          deploy: clean(value.authority?.deploy || 'human', 40)
        }
      };
    } catch {}
  }
  return null;
}

function normalizeWitness(value = {}) {
  return {
    name: clean(value.name || value.command || 'witness', 500),
    ok: value.ok === true || value.conclusion === 'success',
    head_sha: clean(value.head_sha, 40).toLowerCase() || null,
    run_id: Number(value.run_id) || null,
    evidence: clean(value.evidence || value.url || '', 2000) || null
  };
}

function normalizeAttempt(value = {}) {
  return {
    run_id: Number(value.run_id) || null,
    head_sha: clean(value.head_sha, 40).toLowerCase() || null,
    outcome: clean(value.outcome || value.conclusion || 'unknown', 120),
    evidence: clean(value.evidence || value.url || '', 2000) || null
  };
}

function normalizeMode(input = {}) {
  const requested = clean(input.mode || (input.adopted_by ? 'coordinator_adoption' : 'source_pr'), 80).toLowerCase();
  if (!['source_pr', 'coordinator_adoption'].includes(requested)) throw new Error(`Unsupported source admission mode: ${requested}.`);
  return requested;
}

export function normalizeSourceCandidate(input = {}, { lanes = PLATFORM_LANES } = {}) {
  const lanesByIssue = laneMap(lanes);
  const issue = Number(input.issue);
  const lane = lanesByIssue.get(issue);
  if (!lane) throw new Error(`Unknown Maker source lane #${input.issue}.`);
  const baseSha = clean(input.base_sha, 40).toLowerCase();
  const headSha = clean(input.head_sha, 40).toLowerCase();
  if (!SHA_RE.test(baseSha)) throw new Error(`#${issue} requires an exact base SHA.`);
  if (!SHA_RE.test(headSha)) throw new Error(`#${issue} requires an exact head SHA.`);
  const mode = normalizeMode(input);
  const lease = input.lease || parseLeaseMarker(input.body);
  const changedPaths = sortedUnique((input.changed_paths || []).map(normalizePath));
  const witnesses = (input.witnesses || []).map(normalizeWitness);
  const priorAttempts = (input.prior_attempts || []).map(normalizeAttempt);
  return Object.freeze({
    schema: 'sideways-maker-source-candidate/v2',
    mode,
    repository: clean(input.repository || 'Pokitomas/theawesomehexapp', 300),
    issue,
    purpose: lane.purpose,
    pull_request: Number(input.pull_request) || null,
    base_sha: baseSha,
    head_sha: headSha,
    branch: clean(input.branch || lease?.branch, 240),
    draft: input.draft !== false,
    mergeable: input.mergeable === true,
    adopted_by: clean(input.adopted_by, 240) || null,
    adoption_reason: clean(input.adoption_reason, 2000) || null,
    changed_paths: Object.freeze(changedPaths),
    expected_paths: lane.paths,
    lease,
    witnesses: Object.freeze(witnesses),
    prior_attempts: Object.freeze(priorAttempts),
    claim: clean(input.claim || input.summary || '', 4000) || null
  });
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateLease(candidate, errors) {
  if (!candidate.lease) {
    errors.push('missing machine-readable lease');
    return;
  }
  if (!SHA_RE.test(candidate.lease.base_sha)) errors.push('lease base is not an exact SHA');
  if (candidate.lease.base_sha !== candidate.base_sha) errors.push('lease base differs from candidate base');
  if (candidate.lease.branch !== candidate.branch) errors.push('lease branch differs from candidate branch');
  if (candidate.lease.writer_count !== 1) errors.push('lease writer_count must equal one');
  if (candidate.lease.authority.merge !== 'human' || candidate.lease.authority.deploy !== 'human') errors.push('source lane attempted to widen merge/deploy authority');
  if (!sameValues(candidate.lease.owned_paths, candidate.expected_paths)) errors.push('lease paths differ from assigned lane');
}

function validateMode(candidate, options, errors) {
  if (candidate.mode === 'source_pr') {
    if (!candidate.pull_request) errors.push('source PR number is required');
    if (!candidate.draft) errors.push('source PR must remain draft before coordinator admission');
    if (!candidate.mergeable) errors.push('source PR is not mergeable');
    if (candidate.adopted_by) errors.push('source PR candidate cannot claim coordinator adoption');
    return;
  }
  const coordinator = clean(options.coordinator_branch || 'agent/maker-execution-completion', 240);
  if (candidate.pull_request) errors.push('coordinator adoption must not fabricate a source PR');
  if (candidate.adopted_by !== coordinator) errors.push(`coordinator adoption must name ${coordinator}`);
  if (candidate.branch !== coordinator) errors.push('coordinator adoption branch differs from the authoritative integration branch');
  if (!candidate.adoption_reason) errors.push('coordinator adoption requires an exact reason');
  if (!candidate.prior_attempts.length) errors.push('coordinator adoption requires prior failed worker evidence');
  if (!candidate.prior_attempts.some(value => ADOPTION_FAILURES.has(value.outcome))) errors.push('coordinator adoption has no admissible failed-worker outcome');
  if (!candidate.prior_attempts.every(value => value.run_id || value.evidence)) errors.push('coordinator adoption prior attempts require run IDs or evidence');
}

export function validateSourceCandidate(input, options = {}) {
  const candidate = normalizeSourceCandidate(input, options);
  const errors = [];
  if (candidate.repository !== (options.repository || 'Pokitomas/theawesomehexapp')) errors.push(`wrong repository: ${candidate.repository}`);
  if (options.canonical_base && candidate.base_sha !== String(options.canonical_base).toLowerCase()) errors.push(`base mismatch: ${candidate.base_sha}`);
  if (candidate.base_sha === candidate.head_sha) errors.push('head equals base; no source implementation exists');
  if (!candidate.branch || !BRANCH_RE.test(candidate.branch)) errors.push('invalid source branch');
  validateMode(candidate, options, errors);
  validateLease(candidate, errors);
  if (!sameValues(candidate.changed_paths, candidate.expected_paths)) errors.push('changed paths differ from assigned lane');
  const testPaths = candidate.expected_paths.filter(value => value.startsWith('scripts/tests/'));
  for (const testPath of testPaths) {
    if (!candidate.changed_paths.includes(testPath)) errors.push(`missing focused test path: ${testPath}`);
  }
  if (!candidate.witnesses.length) errors.push('no executable witnesses supplied');
  if (candidate.witnesses.some(value => !value.ok)) errors.push('one or more witnesses failed');
  const exactHeadWitnesses = candidate.witnesses.filter(value => value.head_sha === candidate.head_sha);
  if (!exactHeadWitnesses.length) errors.push('no exact-head witness supplied');
  if (!candidate.witnesses.some(value => /test|verify|repository|diff/i.test(value.name))) errors.push('no test or repository verification witness supplied');
  return Object.freeze({ admitted: errors.length === 0, candidate, errors: Object.freeze(errors.sort()) });
}

function candidateCollisions(candidates) {
  const errors = [];
  const owners = new Map();
  const heads = new Map();
  for (const candidate of candidates) {
    const prior = heads.get(candidate.head_sha);
    const sharedAdoptionHead = prior && prior.mode === 'coordinator_adoption' && candidate.mode === 'coordinator_adoption' && prior.adopted_by === candidate.adopted_by;
    if (prior && !sharedAdoptionHead) errors.push(`duplicate source head ${candidate.head_sha} for #${prior.issue} and #${candidate.issue}`);
    heads.set(candidate.head_sha, candidate);
    for (const file of candidate.changed_paths) {
      if (owners.has(file)) errors.push(`candidate path collision: ${file} on #${owners.get(file)} and #${candidate.issue}`);
      owners.set(file, candidate.issue);
    }
  }
  return errors;
}

export function admitSourceCandidates(inputs = [], {
  lanes = PLATFORM_LANES,
  repository = 'Pokitomas/theawesomehexapp',
  canonical_base,
  coordinator_branch = 'agent/maker-execution-completion',
  require_all = false,
  integration_order = INTEGRATION_ORDER
} = {}) {
  laneMap(lanes);
  const validations = inputs.map(input => validateSourceCandidate(input, { lanes, repository, canonical_base, coordinator_branch }));
  const admitted = validations.filter(value => value.admitted).map(value => value.candidate);
  const errors = validations.flatMap(value => value.errors.map(error => `#${value.candidate.issue}: ${error}`));
  errors.push(...candidateCollisions(admitted));
  const issueSet = new Set(admitted.map(value => value.issue));
  if (require_all) {
    for (const lane of lanes) if (!issueSet.has(lane.issue)) errors.push(`missing admitted source lane #${lane.issue}`);
  }
  const order = integration_order.filter(issue => issueSet.has(issue));
  for (const issue of issueSet) if (!order.includes(issue)) errors.push(`admitted lane #${issue} is missing from integration order`);
  const ordered = order.map(issue => admitted.find(value => value.issue === issue));
  const receiptBody = {
    schema: 'sideways-maker-source-admission/v2',
    repository,
    canonical_base: canonical_base ? String(canonical_base).toLowerCase() : null,
    coordinator_branch,
    required_lane_count: lanes.length,
    admitted_lane_count: ordered.length,
    integration_order: order,
    candidates: ordered.map(candidate => ({
      issue: candidate.issue,
      mode: candidate.mode,
      pull_request: candidate.pull_request,
      adopted_by: candidate.adopted_by,
      adoption_reason: candidate.adoption_reason,
      base_sha: candidate.base_sha,
      head_sha: candidate.head_sha,
      branch: candidate.branch,
      changed_paths: candidate.changed_paths,
      witness_count: candidate.witnesses.length,
      prior_attempts: candidate.prior_attempts
    })),
    errors: sortedUnique(errors)
  };
  return Object.freeze({
    admitted: receiptBody.errors.length === 0 && (!require_all || ordered.length === lanes.length),
    candidates: Object.freeze(ordered),
    validations: Object.freeze(validations),
    errors: Object.freeze(receiptBody.errors),
    receipt: Object.freeze({ ...receiptBody, receipt_digest: digest(receiptBody) })
  });
}

export function assertPlatformLaneMap(lanes = PLATFORM_LANES, integrationOrder = INTEGRATION_ORDER) {
  const map = laneMap(lanes);
  const order = [...integrationOrder];
  if (order.length !== map.size || sortedUnique(order).length !== map.size) throw new Error('Integration order must contain every source issue exactly once.');
  for (const issue of order) if (!map.has(issue)) throw new Error(`Integration order references unknown issue #${issue}.`);
  return Object.freeze({ lanes: map.size, paths: [...map.values()].reduce((sum, lane) => sum + lane.paths.length, 0), order: Object.freeze(order) });
}
