#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const SNAPSHOT_SCHEMA = 'sideways-swarm-snapshot/v1';
export const PLAN_SCHEMA = 'sideways-swarm-integration-plan/v1';

const ACTIVE_STATES = new Set(['open']);
const PASSING_CI = new Set(['success', 'passed']);
const HOLD_CI = new Set(['failure', 'failed', 'cancelled', 'action_required']);
const MANAGED_BRANCH_PREFIXES = ['agent/', 'maker/', 'copilot/'];
const SECRET_KEY = /(secret|token|password|credential|private[_-]?key|api[_-]?key)/i;

function fail(message) {
  throw new Error(message);
}

function cleanString(value, field, { required = true, max = 4000 } = {}) {
  const result = String(value ?? '').replace(/\u0000/g, '').trim();
  if (required && !result) fail(`${field} is required.`);
  if (result.length > max) fail(`${field} exceeds ${max} characters.`);
  return result;
}

function assertSafeObject(value, path = '$', seen = new Set()) {
  if (value === null || value === undefined) return;
  if (typeof value !== 'object') return;
  if (seen.has(value)) fail(`${path} contains a cycle.`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSafeObject(entry, `${path}[${index}]`, seen));
  } else {
    for (const [key, entry] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) fail(`${path}.${key} is secret-bearing and cannot enter a swarm snapshot.`);
      assertSafeObject(entry, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function digest(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function normalizePath(value) {
  let path = cleanString(value, 'path', { max: 1000 }).replace(/\\/g, '/').replace(/^\.\//, '');
  if (path === '*' || path === '**' || path === '**/*') return '**';
  if (path.startsWith('/') || /^[A-Za-z]:\//.test(path)) fail(`Path must be repository-relative: ${path}`);
  const parts = path.split('/').filter(Boolean);
  if (parts.some(part => part === '.' || part === '..')) fail(`Path traversal is not allowed: ${path}`);
  const wildcard = path.indexOf('*');
  if (wildcard !== -1 && !path.endsWith('/**')) fail(`Only terminal /** wildcards are supported: ${path}`);
  path = parts.join('/');
  if (path.endsWith('/**')) path = path.slice(0, -3).replace(/\/$/, '');
  return path || '**';
}

export function normalizePaths(values, field = 'paths') {
  if (!Array.isArray(values)) fail(`${field} must be an array.`);
  const paths = [...new Set(values.map(normalizePath))].sort();
  if (paths.includes('**')) return ['**'];
  return paths;
}

function pathContains(prefix, target) {
  return prefix === target || target.startsWith(`${prefix}/`);
}

export function pathsOverlap(left, right) {
  const a = normalizePath(left);
  const b = normalizePath(right);
  if (a === '**' || b === '**') return true;
  return pathContains(a, b) || pathContains(b, a);
}

function intersectionPaths(leftPaths, rightPaths) {
  const result = [];
  for (const left of leftPaths) {
    for (const right of rightPaths) {
      if (pathsOverlap(left, right)) result.push([left, right]);
    }
  }
  return result;
}

function normalizeCI(value = {}) {
  const status = cleanString(value.status ?? 'unknown', 'ci.status', { max: 40 }).toLowerCase();
  return {
    status,
    exact_head: value.exact_head === undefined ? false : Boolean(value.exact_head),
    run_count: Number.isInteger(value.run_count) && value.run_count >= 0 ? value.run_count : 0
  };
}

function normalizeLease(value, branch) {
  if (!value) return null;
  if (typeof value !== 'object' || Array.isArray(value)) fail(`Lease for ${branch} must be an object.`);
  const ownedPaths = normalizePaths(value.owned_paths ?? [], `lease.owned_paths for ${branch}`);
  if (ownedPaths.length === 0) fail(`Lease for ${branch} must own at least one path.`);
  return {
    owned_paths: ownedPaths,
    writer_count: value.writer_count === undefined ? 1 : Number(value.writer_count),
    base_sha: value.base_sha ? cleanString(value.base_sha, `lease.base_sha for ${branch}`, { max: 100 }) : null,
    authority: {
      merge: cleanString(value.authority?.merge ?? 'human', `lease.authority.merge for ${branch}`, { max: 40 }),
      deploy: cleanString(value.authority?.deploy ?? 'human', `lease.authority.deploy for ${branch}`, { max: 40 })
    }
  };
}

function normalizePR(value, snapshotBaseSha) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Each PR must be an object.');
  const number = Number(value.number);
  if (!Number.isInteger(number) || number <= 0) fail('PR number must be a positive integer.');
  const branch = cleanString(value.branch ?? value.head ?? '', `PR #${number} branch`, { max: 300 });
  const changedPaths = normalizePaths(value.changed_paths ?? [], `PR #${number} changed_paths`);
  const lease = normalizeLease(value.lease, branch);
  return {
    number,
    title: cleanString(value.title ?? `PR #${number}`, `PR #${number} title`, { max: 500 }),
    branch,
    head_sha: cleanString(value.head_sha, `PR #${number} head_sha`, { max: 100 }),
    base_sha: cleanString(value.base_sha ?? snapshotBaseSha, `PR #${number} base_sha`, { max: 100 }),
    state: cleanString(value.state ?? 'open', `PR #${number} state`, { max: 40 }).toLowerCase(),
    draft: value.draft === undefined ? true : Boolean(value.draft),
    role: cleanString(value.role ?? 'worker', `PR #${number} role`, { max: 80 }).toLowerCase(),
    composition_target: Boolean(value.composition_target),
    changed_paths: changedPaths,
    lease,
    ci: normalizeCI(value.ci),
    review_status: cleanString(value.review_status ?? 'none', `PR #${number} review_status`, { max: 80 }).toLowerCase(),
    depends_on: [...new Set((value.depends_on ?? []).map(Number))].filter(Number.isInteger).sort((a, b) => a - b),
    explicitly_stopped: Boolean(value.explicitly_stopped)
  };
}

export function validateSnapshot(input) {
  assertSafeObject(input);
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Snapshot must be an object.');
  if (input.schema !== SNAPSHOT_SCHEMA) fail(`Snapshot schema must be ${SNAPSHOT_SCHEMA}.`);
  const baseSha = cleanString(input.base_sha, 'base_sha', { max: 100 });
  const prs = (input.prs ?? []).map(value => normalizePR(value, baseSha));
  const seen = new Set();
  for (const pr of prs) {
    if (seen.has(pr.number)) fail(`Duplicate PR #${pr.number}.`);
    seen.add(pr.number);
  }
  for (const pr of prs) {
    for (const dependency of pr.depends_on) {
      if (!seen.has(dependency)) fail(`PR #${pr.number} depends on unknown PR #${dependency}.`);
      if (dependency === pr.number) fail(`PR #${pr.number} cannot depend on itself.`);
    }
  }
  return {
    schema: SNAPSHOT_SCHEMA,
    repository: cleanString(input.repository ?? 'unknown/unknown', 'repository', { max: 300 }),
    base_branch: cleanString(input.base_branch ?? 'main', 'base_branch', { max: 200 }),
    base_sha: baseSha,
    prs: prs.sort((a, b) => a.number - b.number)
  };
}

function managedBranch(branch) {
  return MANAGED_BRANCH_PREFIXES.some(prefix => branch.startsWith(prefix));
}

function blocker(code, pr, detail, paths = []) {
  return {
    code,
    pr: pr.number,
    detail,
    paths: [...new Set(paths)].sort()
  };
}

function prBlockers(pr, snapshot) {
  const blockers = [];
  if (!ACTIVE_STATES.has(pr.state) && !pr.explicitly_stopped) blockers.push(blocker('inactive_without_stop_receipt', pr, `state=${pr.state}`));
  if (pr.base_sha !== snapshot.base_sha) blockers.push(blocker('stale_base_sha', pr, `expected ${snapshot.base_sha}, got ${pr.base_sha}`));
  if (managedBranch(pr.branch) && !pr.lease) blockers.push(blocker('missing_lease', pr, `managed branch ${pr.branch} has no lease`));
  if (pr.lease) {
    if (pr.lease.base_sha && pr.lease.base_sha !== snapshot.base_sha) blockers.push(blocker('stale_lease_base_sha', pr, `expected ${snapshot.base_sha}, got ${pr.lease.base_sha}`));
    if (pr.lease.writer_count !== 1) blockers.push(blocker('writer_count_not_one', pr, `writer_count=${pr.lease.writer_count}`));
    if (pr.lease.authority.merge !== 'human' || pr.lease.authority.deploy !== 'human') blockers.push(blocker('authority_widened', pr, 'merge and deploy authority must remain human'));
    const undeclared = pr.changed_paths.filter(path => !pr.lease.owned_paths.some(owned => pathsOverlap(path, owned)));
    if (undeclared.length) blockers.push(blocker('changed_path_outside_lease', pr, 'changed paths are not covered by the lease', undeclared));
  }
  if (pr.review_status === 'changes_requested') blockers.push(blocker('changes_requested', pr, 'review changes are still requested'));
  if (HOLD_CI.has(pr.ci.status)) blockers.push(blocker('ci_not_admissible', pr, `ci.status=${pr.ci.status}`));
  if (PASSING_CI.has(pr.ci.status) && !pr.ci.exact_head) blockers.push(blocker('ci_not_exact_head', pr, 'passing CI is not tied to the current head'));
  if (!PASSING_CI.has(pr.ci.status) && !HOLD_CI.has(pr.ci.status) && pr.ci.status !== 'pending') blockers.push(blocker('ci_unknown', pr, `ci.status=${pr.ci.status}`));
  return blockers;
}

function overlapRecord(left, right, kind, pairs) {
  return {
    left_pr: left.number,
    right_pr: right.number,
    kind,
    pairs: pairs.map(([a, b]) => ({ left: a, right: b })).sort((a, b) => `${a.left}\0${a.right}`.localeCompare(`${b.left}\0${b.right}`))
  };
}

export function analyzeOverlaps(prs) {
  const overlaps = [];
  for (let i = 0; i < prs.length; i += 1) {
    for (let j = i + 1; j < prs.length; j += 1) {
      const left = prs[i];
      const right = prs[j];
      const changedPairs = intersectionPaths(left.changed_paths, right.changed_paths);
      if (changedPairs.length) overlaps.push(overlapRecord(left, right, 'changed_path', changedPairs));
      if (left.lease && right.lease) {
        const leasePairs = intersectionPaths(left.lease.owned_paths, right.lease.owned_paths);
        if (leasePairs.length) overlaps.push(overlapRecord(left, right, 'lease', leasePairs));
      }
    }
  }
  return overlaps.sort((a, b) => `${a.left_pr}:${a.right_pr}:${a.kind}`.localeCompare(`${b.left_pr}:${b.right_pr}:${b.kind}`));
}

function connectedComponents(numbers, overlaps) {
  const adjacency = new Map(numbers.map(number => [number, new Set()]));
  for (const overlap of overlaps) {
    adjacency.get(overlap.left_pr)?.add(overlap.right_pr);
    adjacency.get(overlap.right_pr)?.add(overlap.left_pr);
  }
  const seen = new Set();
  const components = [];
  for (const number of [...numbers].sort((a, b) => a - b)) {
    if (seen.has(number)) continue;
    const stack = [number];
    const component = [];
    seen.add(number);
    while (stack.length) {
      const current = stack.pop();
      component.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (!seen.has(neighbor)) {
          seen.add(neighbor);
          stack.push(neighbor);
        }
      }
    }
    components.push(component.sort((a, b) => a - b));
  }
  return components;
}

function dependencyCycles(prs) {
  const byNumber = new Map(prs.map(pr => [pr.number, pr]));
  const visiting = new Set();
  const visited = new Set();
  const cycles = [];
  function visit(number, path) {
    if (visiting.has(number)) {
      const index = path.indexOf(number);
      cycles.push(path.slice(index).concat(number));
      return;
    }
    if (visited.has(number)) return;
    visiting.add(number);
    const pr = byNumber.get(number);
    for (const dependency of pr?.depends_on ?? []) visit(dependency, path.concat(number));
    visiting.delete(number);
    visited.add(number);
  }
  for (const pr of prs) visit(pr.number, []);
  return cycles;
}

function uniqueOverlapPaths(overlaps) {
  const paths = [];
  for (const overlap of overlaps) {
    for (const pair of overlap.pairs) paths.push(pair.left === pair.right ? pair.left : `${pair.left} ↔ ${pair.right}`);
  }
  return [...new Set(paths)].sort();
}

function buildStages(admissiblePrs, heldPrs, overlaps) {
  const admissibleSet = new Set(admissiblePrs.map(pr => pr.number));
  const admissibleOverlaps = overlaps.filter(item => admissibleSet.has(item.left_pr) && admissibleSet.has(item.right_pr));
  const components = connectedComponents(admissiblePrs.map(pr => pr.number), admissibleOverlaps);
  const byNumber = new Map(admissiblePrs.map(pr => [pr.number, pr]));
  const stages = [];

  for (const component of components) {
    const componentOverlaps = admissibleOverlaps.filter(item => component.includes(item.left_pr) && component.includes(item.right_pr));
    if (component.length === 1 && componentOverlaps.length === 0) {
      const pr = byNumber.get(component[0]);
      stages.push({
        type: 'independent_candidate',
        prs: [pr.number],
        target_pr: null,
        reason: 'No changed-path or lease overlap with another admissible PR.',
        conflict_paths: []
      });
      continue;
    }
    const targets = component.map(number => byNumber.get(number)).filter(pr => pr.composition_target);
    if (targets.length !== 1) {
      stages.push({
        type: 'coordinator_hold',
        prs: component,
        target_pr: null,
        reason: targets.length === 0 ? 'Overlapping component has no declared composition target.' : 'Overlapping component has multiple composition targets.',
        conflict_paths: uniqueOverlapPaths(componentOverlaps)
      });
      continue;
    }
    const target = targets[0];
    stages.push({
      type: 'coordinator_compose',
      prs: component.filter(number => number !== target.number),
      target_pr: target.number,
      reason: 'Compose predecessor deltas into the declared target, resolve shared paths once, then rerun exact-head verification on the resulting tree.',
      conflict_paths: uniqueOverlapPaths(componentOverlaps)
    });
  }

  if (heldPrs.length) {
    stages.push({
      type: 'held_recovery',
      prs: heldPrs.map(pr => pr.number).sort((a, b) => a - b),
      target_pr: null,
      reason: 'These PRs must clear their blockers before entering composition.',
      conflict_paths: uniqueOverlapPaths(overlaps.filter(item => heldPrs.some(pr => pr.number === item.left_pr || pr.number === item.right_pr)))
    });
  }

  const order = { independent_candidate: 0, coordinator_compose: 1, coordinator_hold: 2, held_recovery: 3 };
  return stages.sort((a, b) => (order[a.type] - order[b.type]) || (a.prs[0] ?? 0) - (b.prs[0] ?? 0));
}

export function buildIntegrationPlan(input) {
  const snapshot = validateSnapshot(input);
  const allBlockers = snapshot.prs.flatMap(pr => prBlockers(pr, snapshot));
  const blockedNumbers = new Set(allBlockers.map(item => item.pr));
  const heldPrs = snapshot.prs.filter(pr => blockedNumbers.has(pr.number));
  const admissiblePrs = snapshot.prs.filter(pr => !blockedNumbers.has(pr.number));
  const overlaps = analyzeOverlaps(snapshot.prs);
  const cycles = dependencyCycles(snapshot.prs);
  const globalBlockers = cycles.map(cycle => ({ code: 'dependency_cycle', prs: cycle, detail: `Dependency cycle: ${cycle.join(' -> ')}` }));
  const stages = buildStages(admissiblePrs, heldPrs, overlaps);
  const unresolvedStages = stages.filter(stage => stage.type === 'coordinator_hold');
  const status = allBlockers.length || globalBlockers.length || unresolvedStages.length ? 'held' : 'ready_for_coordinator_composition';
  const normalizedSnapshot = {
    schema: snapshot.schema,
    repository: snapshot.repository,
    base_branch: snapshot.base_branch,
    base_sha: snapshot.base_sha,
    prs: snapshot.prs
  };
  return {
    schema: PLAN_SCHEMA,
    repository: snapshot.repository,
    base_branch: snapshot.base_branch,
    base_sha: snapshot.base_sha,
    snapshot_sha256: digest(normalizedSnapshot),
    status,
    admissible_prs: admissiblePrs.map(pr => pr.number),
    held_prs: heldPrs.map(pr => pr.number),
    blockers: allBlockers.sort((a, b) => `${a.pr}:${a.code}`.localeCompare(`${b.pr}:${b.code}`)),
    global_blockers: globalBlockers,
    overlaps,
    stages,
    coordinator_rules: {
      merge_authority: 'human',
      deploy_authority: 'human',
      force_push: false,
      shared_paths_written_once: true,
      exact_head_verification_after_composition: true,
      moved_head_invalidates_receipt: true
    }
  };
}

function parseArgs(argv) {
  const options = { input: '', output: '', pretty: true };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--input') options.input = argv[++index] ?? '';
    else if (value === '--output') options.output = argv[++index] ?? '';
    else if (value === '--compact') options.pretty = false;
    else if (value === '--help' || value === '-h') options.help = true;
    else fail(`Unknown option: ${value}`);
  }
  return options;
}

function usage() {
  return [
    'Usage: node scripts/swarm-integration-plan.mjs --input snapshot.json [--output plan.json] [--compact]',
    '',
    `Input schema: ${SNAPSHOT_SCHEMA}`,
    `Output schema: ${PLAN_SCHEMA}`,
    '',
    'This command is read-only except for the explicitly requested output file.'
  ].join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.input) fail('--input is required.');
  const raw = JSON.parse(await readFile(options.input, 'utf8'));
  const plan = buildIntegrationPlan(raw);
  const text = options.pretty ? `${JSON.stringify(plan, null, 2)}\n` : `${JSON.stringify(plan)}\n`;
  if (options.output) await writeFile(options.output, text, { flag: 'wx' });
  else process.stdout.write(text);
  if (plan.status === 'held') process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(JSON.stringify({ ok: false, error: String(error?.message ?? error) }, null, 2));
    process.exitCode = 1;
  });
}
