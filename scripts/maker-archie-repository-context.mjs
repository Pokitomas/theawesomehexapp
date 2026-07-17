import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
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

async function git(root, args) {
  const result = await execFileAsync('git', args, { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  return clean(result.stdout, 16 * 1024 * 1024);
}

async function readEvidence(root, filename, remaining) {
  const absolute = path.join(root, filename);
  try {
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) return null;
    const budget = Math.max(0, Math.min(MAX_FILE_BYTES, remaining));
    if (!budget) return null;
    const handle = await fs.open(absolute, 'r');
    try {
      const buffer = Buffer.alloc(budget);
      const { bytesRead } = await handle.read(buffer, 0, budget, 0);
      const body = buffer.subarray(0, bytesRead).toString('utf8');
      if (body.includes('\u0000')) return null;
      return {
        path: filename,
        bytes: stat.size,
        truncated: stat.size > bytesRead,
        content: body
      };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

export async function buildArchieRepositoryContext({ repoRoot, request, baseBranch = 'main', baseSha = '' } = {}) {
  if (!repoRoot) throw new Error('repoRoot is required.');
  const root = path.resolve(repoRoot);
  const terms = requestTerms(request);
  const tracked = (await git(root, ['ls-files'])).split('\n').map(value => value.trim()).filter(isEligibleFile);
  const ranked = tracked
    .map(filename => ({ filename, score: scoreFile(filename, terms) }))
    .sort((left, right) => right.score - left.score || left.filename.localeCompare(right.filename))
    .slice(0, MAX_FILES);

  const files = [];
  let capturedBytes = 0;
  for (const item of ranked) {
    const evidence = await readEvidence(root, item.filename, MAX_TOTAL_BYTES - capturedBytes);
    if (!evidence) continue;
    files.push({ ...evidence, relevance_score: item.score });
    capturedBytes += Buffer.byteLength(evidence.content);
    if (capturedBytes >= MAX_TOTAL_BYTES) break;
  }

  const status = await git(root, ['status', '--short']);
  const recent = await git(root, ['log', '-n', '12', '--pretty=format:%H%x09%s']);
  return Object.freeze({
    schema: 'archie-repository-context/v1',
    repository: path.basename(root),
    base_branch: clean(baseBranch, 200),
    base_sha: clean(baseSha, 200),
    request_terms: terms,
    tracked_file_count: tracked.length,
    captured_file_count: files.length,
    captured_bytes: capturedBytes,
    worktree_status: status || 'clean',
    recent_commits: recent.split('\n').filter(Boolean).map(line => {
      const [sha, ...message] = line.split('\t');
      return { sha, message: message.join('\t') };
    }),
    files
  });
}
