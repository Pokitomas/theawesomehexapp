import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GIT_OID = /^[a-f0-9]{40,64}$/;
const clean = (value, limit = 200000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function stable(value) {
  return JSON.stringify(canonical(value));
}

export function repositoryEvidenceDigest(value) {
  const body = { ...(value || {}) };
  delete body.evidence_digest;
  return crypto.createHash('sha256').update(stable(body)).digest('hex');
}

function parentDirectories(filename) {
  const output = [];
  let current = path.posix.dirname(filename);
  while (current && current !== '.') {
    output.push(current);
    current = path.posix.dirname(current);
  }
  return output;
}

async function git(root, args, { maxBuffer = 32 * 1024 * 1024 } = {}) {
  const result = await execFileAsync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer,
    windowsHide: true
  });
  return String(result.stdout || '');
}

async function showJSON(root, baseSha, filename) {
  try {
    return JSON.parse(await git(root, ['show', `${baseSha}:${filename}`], { maxBuffer: 4 * 1024 * 1024 }));
  } catch {
    return null;
  }
}

export async function collectRepositoryEvidence({ repoRoot, baseSha, maxPaths = 12000 } = {}) {
  const root = path.resolve(clean(repoRoot, 4000));
  const revision = clean(baseSha, 128).toLowerCase();
  if (!root) throw new Error('Repository evidence requires repoRoot.');
  if (!GIT_OID.test(revision)) throw new Error('Repository evidence requires an exact Git object ID.');
  await git(root, ['cat-file', '-e', `${revision}^{commit}`]);
  const raw = await git(root, ['ls-tree', '-r', '--name-only', '-z', revision]);
  const allPaths = raw.split('\u0000').map(value => clean(value, 4000).replace(/\\/g, '/')).filter(Boolean).sort();
  const limit = Math.max(100, Math.min(100000, Number(maxPaths) || 12000));
  const includedPaths = allPaths.slice(0, limit);
  const truncated = includedPaths.length !== allPaths.length;
  const directories = [...new Set(includedPaths.flatMap(parentDirectories))].sort();
  const packageJSON = includedPaths.includes('package.json') ? await showJSON(root, revision, 'package.json') : null;
  const scripts = packageJSON?.scripts && typeof packageJSON.scripts === 'object' && !Array.isArray(packageJSON.scripts)
    ? Object.fromEntries(Object.entries(packageJSON.scripts).map(([name, command]) => [clean(name, 300), clean(command, 4000)]).sort(([left], [right]) => left.localeCompare(right)))
    : {};
  const dependencies = [...new Set([
    ...Object.keys(packageJSON?.dependencies || {}),
    ...Object.keys(packageJSON?.devDependencies || {})
  ].map(value => clean(value, 300)).filter(Boolean))].sort();
  const body = {
    schema: 'archie-repository-evidence/v1',
    repository: path.basename(root),
    base_sha: revision,
    collection: 'git-ls-tree-and-git-show',
    path_count: allPaths.length,
    included_path_count: includedPaths.length,
    truncated,
    paths: includedPaths,
    directories,
    package_scripts: scripts,
    package_dependencies: dependencies,
    limitations: [
      'This bundle proves repository names and package metadata at the exact base SHA.',
      'It does not prove runtime behavior, test success, semantic correctness, or deployment state.'
    ]
  };
  return Object.freeze({ ...body, evidence_digest: repositoryEvidenceDigest(body) });
}

export function validateRepositoryEvidence(value, { expectedBaseSha = null } = {}) {
  if (!value || value.schema !== 'archie-repository-evidence/v1') throw new Error('Archie repository evidence is missing or unsupported.');
  if (!GIT_OID.test(clean(value.base_sha, 128).toLowerCase())) throw new Error('Archie repository evidence lacks an exact base SHA.');
  if (expectedBaseSha && clean(value.base_sha, 128).toLowerCase() !== clean(expectedBaseSha, 128).toLowerCase()) throw new Error('Archie repository evidence is stale for the active base SHA.');
  if (value.truncated === true) throw new Error('Archie repository evidence is truncated and cannot grant execution admission.');
  if (!Array.isArray(value.paths) || value.paths.length !== Number(value.included_path_count) || Number(value.path_count) !== value.paths.length) throw new Error('Archie repository evidence path counts are inconsistent.');
  if (value.evidence_digest !== repositoryEvidenceDigest(value)) throw new Error('Archie repository evidence integrity check failed.');
  return value;
}

function commandPathReferences(command) {
  const text = clean(command, 4000);
  const matches = text.match(/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)+\.(?:mjs|cjs|js|jsx|ts|tsx|json|py|sh|yml|yaml)/g) || [];
  return [...new Set(matches.map(value => value.replace(/^\.\//, '')))];
}

export function assertPlanGroundedInRepositoryEvidence(plan, evidenceInput) {
  const evidence = validateRepositoryEvidence(evidenceInput);
  const paths = new Set(evidence.paths);
  const directories = new Set(evidence.directories || []);
  const grounded = [];
  for (const ownedPath of Array.isArray(plan?.owned_paths) ? plan.owned_paths : []) {
    const candidate = clean(ownedPath, 4000).replace(/^\.\//, '').replace(/\\/g, '/').replace(/\/$/, '');
    const parent = path.posix.dirname(candidate);
    if (candidate === '**') throw new Error('Teacher plans cannot use a repository-wide lease.');
    if (!paths.has(candidate) && !directories.has(candidate) && (parent === '.' || !directories.has(parent))) {
      throw new Error(`Teacher plan path is not grounded in repository evidence: ${candidate}.`);
    }
    grounded.push(candidate);
  }
  const testReferences = [];
  for (const command of Array.isArray(plan?.focused_tests) ? plan.focused_tests : []) {
    const npmRun = clean(command, 4000).match(/\bnpm\s+run\s+([A-Za-z0-9:_-]+)/);
    if (npmRun && !Object.hasOwn(evidence.package_scripts || {}, npmRun[1])) throw new Error(`Teacher focused test references unknown npm script: ${npmRun[1]}.`);
    for (const filename of commandPathReferences(command)) {
      if (!paths.has(filename)) throw new Error(`Teacher focused test references a path absent from repository evidence: ${filename}.`);
      testReferences.push(filename);
    }
  }
  return Object.freeze({
    grounded_paths: grounded.sort(),
    grounded_test_references: [...new Set(testReferences)].sort(),
    repository_evidence_digest: evidence.evidence_digest
  });
}
