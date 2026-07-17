import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GIT_OID = /^[a-f0-9]{40,64}$/;
const clean = (value, limit = 200000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const DEFAULT_MAX_SOURCE_FILES = 64;
const DEFAULT_MAX_FILE_BYTES = 24 * 1024;
const DEFAULT_MAX_SOURCE_BYTES = 384 * 1024;
const ALWAYS_SOURCE = new Set([
  'README.md',
  'package.json',
  'ARCHIE_MIND.md',
  'ARCHIE_RUNTIME.md',
  'ARCHIE_DISTILL.md',
  'ARCHIE_MAKER_VISION.md'
]);
const TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.css', '.go', '.h', '.hpp', '.html', '.java', '.js', '.json', '.jsx',
  '.md', '.mjs', '.py', '.rb', '.rs', '.sh', '.sql', '.ts', '.tsx', '.txt', '.yaml', '.yml'
]);
const SECRET_PATH = /(^|\/)(?:\.env(?:\.|$)|[^/]*(?:secret|credential|private[-_]?key|api[-_]?key|access[-_]?token)[^/]*)|\.(?:pem|p12|pfx|key)$/i;
const EXCLUDED_PATH = /(^|\/)(?:node_modules|vendor|dist|build|coverage)(\/|$)|\.(?:lock|map|min\.js|png|jpe?g|gif|webp|ico|woff2?|ttf|zip|gz|pdf|sqlite|db)$/i;

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

function parseTreeEntries(raw) {
  return raw.split('\u0000').filter(Boolean).map((row, index) => {
    const match = row.match(/^\d+\s+blob\s+([a-f0-9]{40,64})\s+(\d+|-)\t([\s\S]+)$/);
    if (!match) throw new Error(`Repository evidence could not parse Git tree row ${index + 1}.`);
    return Object.freeze({
      oid: match[1],
      bytes: match[2] === '-' ? null : Number(match[2]),
      path: clean(match[3], 4000).replace(/\\/g, '/')
    });
  }).filter(item => item.path).sort((left, right) => left.path.localeCompare(right.path));
}

function requestTerms(request) {
  return [...new Set(clean(request, 12000).toLowerCase().split(/[^a-z0-9._/-]+/).filter(term => term.length >= 3))].slice(0, 100);
}

function sourceEligible(filename) {
  const normalized = filename.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('.') || SECRET_PATH.test(normalized) || EXCLUDED_PATH.test(normalized)) return false;
  return ALWAYS_SOURCE.has(normalized) || TEXT_EXTENSIONS.has(path.extname(normalized).toLowerCase());
}

function sourceScore(filename, terms) {
  const normalized = filename.toLowerCase();
  const basename = path.basename(normalized);
  let score = ALWAYS_SOURCE.has(filename) ? 1000 : 0;
  if (normalized.startsWith('scripts/')) score += 35;
  if (normalized.includes('/tests/') || basename.includes('.test.')) score += 20;
  if (normalized.includes('archie')) score += 35;
  if (normalized.includes('maker')) score += 25;
  if (normalized.includes('contract') || normalized.includes('schema')) score += 15;
  for (const term of terms) {
    if (basename.includes(term)) score += 70;
    else if (normalized.includes(term)) score += 30;
  }
  return score;
}

async function readSourceEvidence(root, revision, entry, remaining, maxFileBytes) {
  const budget = Math.max(0, Math.min(maxFileBytes, remaining));
  if (!budget || (Number.isFinite(entry.bytes) && entry.bytes > 4 * 1024 * 1024)) return null;
  try {
    const raw = await git(root, ['show', `${revision}:${entry.path}`], {
      maxBuffer: Math.max(4 * 1024 * 1024, Math.min(16 * 1024 * 1024, Number(entry.bytes || 0) * 2 + 1024))
    });
    if (raw.includes('\u0000')) return null;
    const bytes = Buffer.from(raw, 'utf8');
    const captured = bytes.subarray(0, budget);
    const content = captured.toString('utf8');
    const capturedBytes = Buffer.byteLength(content);
    return Object.freeze({
      path: entry.path,
      blob_oid: entry.oid,
      bytes: bytes.length,
      captured_bytes: capturedBytes,
      truncated: bytes.length > capturedBytes,
      content
    });
  } catch {
    return null;
  }
}

export async function collectRepositoryEvidence({
  repoRoot,
  baseSha,
  request = '',
  maxPaths = 12000,
  maxSourceFiles = DEFAULT_MAX_SOURCE_FILES,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  maxSourceBytes = DEFAULT_MAX_SOURCE_BYTES
} = {}) {
  const root = path.resolve(clean(repoRoot, 4000));
  const revision = clean(baseSha, 128).toLowerCase();
  if (!root) throw new Error('Repository evidence requires repoRoot.');
  if (!GIT_OID.test(revision)) throw new Error('Repository evidence requires an exact Git object ID.');
  await git(root, ['cat-file', '-e', `${revision}^{commit}`]);
  const entries = parseTreeEntries(await git(root, ['ls-tree', '-r', '-l', '-z', revision]));
  const allPaths = entries.map(item => item.path);
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

  const sourceFileLimit = Math.max(1, Math.min(256, Number(maxSourceFiles) || DEFAULT_MAX_SOURCE_FILES));
  const perFileLimit = Math.max(1024, Math.min(256 * 1024, Number(maxFileBytes) || DEFAULT_MAX_FILE_BYTES));
  const sourceByteLimit = Math.max(perFileLimit, Math.min(4 * 1024 * 1024, Number(maxSourceBytes) || DEFAULT_MAX_SOURCE_BYTES));
  const terms = requestTerms(request);
  const ranked = entries.filter(item => sourceEligible(item.path))
    .map(item => ({ ...item, relevance_score: sourceScore(item.path, terms) }))
    .sort((left, right) => right.relevance_score - left.relevance_score || left.path.localeCompare(right.path))
    .slice(0, sourceFileLimit);
  const sourceFiles = [];
  let capturedSourceBytes = 0;
  for (const entry of ranked) {
    const evidence = await readSourceEvidence(root, revision, entry, sourceByteLimit - capturedSourceBytes, perFileLimit);
    if (!evidence) continue;
    sourceFiles.push(Object.freeze({ ...evidence, relevance_score: entry.relevance_score }));
    capturedSourceBytes += evidence.captured_bytes;
    if (capturedSourceBytes >= sourceByteLimit) break;
  }
  if (!sourceFiles.length || !capturedSourceBytes) throw new Error('Repository evidence captured no readable exact-base source.');
  const recentCommits = (await git(root, ['log', '-n', '12', '--pretty=format:%H%x09%s', revision]))
    .split('\n').filter(Boolean).map(line => {
      const [sha, ...message] = line.split('\t');
      return Object.freeze({ sha: clean(sha, 128), message: clean(message.join('\t'), 1000) });
    });

  const body = {
    schema: 'archie-repository-evidence/v1',
    repository: path.basename(root),
    base_sha: revision,
    collection: 'exact-git-tree-package-and-ranked-source/v1',
    request_terms: terms,
    path_count: allPaths.length,
    included_path_count: includedPaths.length,
    truncated,
    paths: includedPaths,
    directories,
    package_scripts: scripts,
    package_dependencies: dependencies,
    source_file_count: sourceFiles.length,
    captured_source_bytes: capturedSourceBytes,
    source_limits: {
      max_files: sourceFileLimit,
      max_file_bytes: perFileLimit,
      max_total_bytes: sourceByteLimit
    },
    source_files: sourceFiles,
    recent_commits: recentCommits,
    limitations: [
      'This bundle proves repository paths, package metadata, selected source bytes, blob identities, and recent history at the exact base SHA.',
      'Source selection is request-ranked and bounded; per-file truncation is explicit and included in the evidence digest.',
      'Likely secret-bearing and non-text paths are excluded from external-teacher context.',
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
  const paths = new Set(value.paths);
  const sourceFiles = Array.isArray(value.source_files) ? value.source_files : [];
  if (!sourceFiles.length || sourceFiles.length !== Number(value.source_file_count)) throw new Error('Archie repository evidence lacks bounded source files.');
  let capturedBytes = 0;
  for (const [index, item] of sourceFiles.entries()) {
    const filename = clean(item?.path, 4000).replace(/\\/g, '/');
    if (!paths.has(filename)) throw new Error(`Archie repository source_files[${index}] path is absent from the exact tree.`);
    if (SECRET_PATH.test(filename) || !sourceEligible(filename)) throw new Error(`Archie repository source_files[${index}] is not safe text evidence.`);
    if (!GIT_OID.test(clean(item?.blob_oid, 128))) throw new Error(`Archie repository source_files[${index}] lacks a Git blob identity.`);
    const bytes = Number(item?.bytes);
    const captured = Number(item?.captured_bytes);
    const actual = Buffer.byteLength(String(item?.content ?? ''), 'utf8');
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(captured) || captured < 1 || captured !== actual || captured > bytes) throw new Error(`Archie repository source_files[${index}] byte accounting is invalid.`);
    if (Boolean(item?.truncated) !== (captured < bytes)) throw new Error(`Archie repository source_files[${index}] truncation disclosure is inconsistent.`);
    capturedBytes += captured;
  }
  if (capturedBytes !== Number(value.captured_source_bytes)) throw new Error('Archie repository source byte total is inconsistent.');
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
