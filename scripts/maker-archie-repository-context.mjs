import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const clean = (value, limit = 12000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const MAX_FILES = 64;
const MAX_FILE_BYTES = 24 * 1024;
const MAX_TOTAL_BYTES = 384 * 1024;
const ALWAYS = new Set([
  'README.md',
  'package.json',
  'ARCHIE_RUNTIME.md',
  'ARCHIE_DISTILL.md',
  'PRODUCT_PORTFOLIO.md',
  'HANDOFF.md'
]);
const TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.css', '.go', '.h', '.hpp', '.html', '.java', '.js', '.json', '.jsx',
  '.md', '.mjs', '.py', '.rb', '.rs', '.sh', '.sql', '.ts', '.tsx', '.txt', '.yaml', '.yml'
]);

function requestTerms(request) {
  return [...new Set(clean(request, 12000).toLowerCase().split(/[^a-z0-9._/-]+/).filter(term => term.length >= 3))].slice(0, 80);
}

function isEligibleFile(filename) {
  const normalized = filename.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('.') || normalized.includes('/node_modules/')) return false;
  if (/\.(?:lock|map|min\.js|png|jpe?g|gif|webp|ico|woff2?|ttf|zip|gz|pdf|sqlite|db)$/i.test(normalized)) return false;
  return ALWAYS.has(normalized) || TEXT_EXTENSIONS.has(path.extname(normalized).toLowerCase());
}

function scoreFile(filename, terms) {
  const normalized = filename.toLowerCase();
  const basename = path.basename(normalized);
  let score = ALWAYS.has(filename) ? 1000 : 0;
  if (normalized.startsWith('scripts/')) score += 35;
  if (normalized.includes('/tests/') || basename.includes('.test.')) score += 20;
  if (normalized.includes('archie')) score += 30;
  if (normalized.includes('maker')) score += 25;
  for (const term of terms) {
    if (basename.includes(term)) score += 70;
    else if (normalized.includes(term)) score += 30;
  }
  return score;
}

async function git(root, args, { maxBuffer = 16 * 1024 * 1024 } = {}) {
  const result = await execFileAsync('git', args, { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer });
  return String(result.stdout ?? '');
}

async function readEvidence(root, baseSha, filename, remaining) {
  const budget = Math.max(0, Math.min(MAX_FILE_BYTES, remaining));
  if (!budget) return null;
  try {
    const raw = await git(root, ['show', `${baseSha}:${filename}`], { maxBuffer: Math.max(MAX_FILE_BYTES * 2, budget * 2) });
    if (raw.includes('\u0000')) return null;
    const content = raw.slice(0, budget);
    return {
      path: filename,
      bytes: Buffer.byteLength(raw),
      truncated: Buffer.byteLength(raw) > Buffer.byteLength(content),
      content
    };
  } catch {
    return null;
  }
}

export async function buildArchieRepositoryContext({ repoRoot, request, baseBranch = 'main', baseSha = '' } = {}) {
  if (!repoRoot) throw new Error('repoRoot is required.');
  if (!clean(baseSha, 200)) throw new Error('baseSha is required for exact repository grounding.');
  const root = path.resolve(repoRoot);
  const terms = requestTerms(request);
  await git(root, ['cat-file', '-e', `${baseSha}^{commit}`]);
  const tracked = (await git(root, ['ls-tree', '-r', '--name-only', baseSha]))
    .split('\n')
    .map(value => value.trim())
    .filter(isEligibleFile);
  const ranked = tracked
    .map(filename => ({ filename, score: scoreFile(filename, terms) }))
    .sort((left, right) => right.score - left.score || left.filename.localeCompare(right.filename))
    .slice(0, MAX_FILES);

  const files = [];
  let capturedBytes = 0;
  for (const item of ranked) {
    const evidence = await readEvidence(root, baseSha, item.filename, MAX_TOTAL_BYTES - capturedBytes);
    if (!evidence) continue;
    files.push({ ...evidence, relevance_score: item.score });
    capturedBytes += Buffer.byteLength(evidence.content);
    if (capturedBytes >= MAX_TOTAL_BYTES) break;
  }

  const recent = await git(root, ['log', '-n', '12', '--pretty=format:%H%x09%s', baseSha]);
  return Object.freeze({
    schema: 'archie-repository-context/v1',
    repository: path.basename(root),
    base_branch: clean(baseBranch, 200),
    base_sha: clean(baseSha, 200),
    source: 'exact-git-commit',
    request_terms: terms,
    tracked_file_count: tracked.length,
    captured_file_count: files.length,
    captured_bytes: capturedBytes,
    recent_commits: recent.split('\n').filter(Boolean).map(line => {
      const [sha, ...message] = line.split('\t');
      return { sha, message: message.join('\t') };
    }),
    files
  });
}
