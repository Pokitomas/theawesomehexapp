#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { WorkspaceError, sha256, stableJSONStringify } from './archie-workspace-core.mjs';

export const ARCHIE_SOURCE_HOST_INVENTORY_SCHEMA = 'archie-source-host-inventory/v1';
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '.archie', 'coverage', 'test-results', 'playwright-report']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.jsonl', '.md', '.html', '.css', '.scss',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.sh', '.bash', '.zsh', '.ps1', '.yml', '.yaml',
  '.toml', '.ini', '.env', '.sql', '.graphql', '.txt'
]);
const SIGNALS = Object.freeze([
  { signal: 'github-api-host', pattern: /api\.github\.com/gi },
  { signal: 'github-web-host', pattern: /github\.com/gi },
  { signal: 'github-token', pattern: /\bGITHUB_TOKEN\b|\bGH_TOKEN\b|\bgithub[_-]?token\b/gi },
  { signal: 'github-actions', pattern: /\bgithub\.actions\b|\.github\/workflows|actions\/checkout|workflow_dispatch/gi },
  { signal: 'github-issue-or-pr', pattern: /\bGitHub (?:Issues?|Pull Requests?|PRs?)\b|\/issues\/|\/pulls?\//gi },
  { signal: 'github-cli', pattern: /(?:^|[\s"'`])gh\s+(?:api|issue|pr|run|workflow|repo)\b/gim },
  { signal: 'browser-only-state', pattern: /\blocalStorage\b|\bsessionStorage\b|indexedDB/gi },
  { signal: 'source-host-canonical-language', pattern: /(?:canonical|database|queue|event log|workspace identity|authoritative state).{0,100}(?:GitHub|issue|pull request|actions|pages)/gi }
]);
const RUNTIME_HINT = /(?:fetch\s*\(|https?:\/\/api\.github\.com|octokit|github[_-]?token|\bgh\s+api\b|localStorage|sessionStorage|indexedDB)/i;
const AUTHORITY_HINT = /(?:canonical|database|queue|event log|workspace|identity|receipt|artifact|review|approval|promotion|rollback|run state|task graph)/i;
const ADAPTER_HINT = /(?:github|source-host|remote|sync|import|export|adapter)/i;

function relative(filename, root) {
  return path.relative(root, filename).replaceAll('\\', '/');
}

function category(filename) {
  const normalized = filename.toLowerCase();
  if (normalized.startsWith('.github/workflows/')) return 'ci';
  if (normalized.includes('/tests/') || normalized.endsWith('.test.mjs') || normalized.endsWith('.test.js')) return 'test';
  if (normalized.endsWith('.md') || normalized.startsWith('docs/')) return 'documentation';
  if (normalized.includes('github') || normalized.includes('source-host')) return 'adapter-or-migration';
  if (normalized.startsWith('scripts/') || normalized.startsWith('server/') || normalized.startsWith('src/')) return 'runtime';
  if (normalized.startsWith('studio/') || normalized.startsWith('public/') || normalized.endsWith('.html')) return 'surface';
  return 'repository-support';
}

function lineNumber(source, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (source.charCodeAt(index) === 10) line += 1;
  return line;
}

function snippetAt(source, offset, length) {
  const start = Math.max(0, source.lastIndexOf('\n', offset - 1) + 1);
  const newline = source.indexOf('\n', offset + length);
  const end = newline === -1 ? source.length : newline;
  return source.slice(start, end).trim().replace(/\s+/g, ' ').slice(0, 320);
}

function classifyFinding({ filename, source, signal, offset, snippet }) {
  const fileCategory = category(filename);
  const nearby = source.slice(Math.max(0, offset - 500), Math.min(source.length, offset + 700));
  const runtimeDependency = fileCategory === 'runtime' && RUNTIME_HINT.test(nearby);
  const authorityLanguage = AUTHORITY_HINT.test(nearby) || signal === 'source-host-canonical-language';
  const adapterLanguage = ADAPTER_HINT.test(path.basename(filename)) || /optional adapter|import\/export|compatibility|migration/i.test(nearby);
  let disposition = 'allowed-reference';
  let risk = 'informational';
  if (fileCategory === 'ci') {
    disposition = 'allowed-ci';
    risk = 'informational';
  } else if (fileCategory === 'documentation' || fileCategory === 'test') {
    disposition = 'allowed-nonruntime';
    risk = authorityLanguage ? 'review' : 'informational';
  } else if (signal === 'browser-only-state' && runtimeDependency && authorityLanguage) {
    disposition = 'canonical-runtime-blocker';
    risk = 'blocker';
  } else if (runtimeDependency && authorityLanguage && !adapterLanguage) {
    disposition = 'canonical-runtime-blocker';
    risk = 'blocker';
  } else if (runtimeDependency) {
    disposition = adapterLanguage ? 'optional-adapter-candidate' : 'runtime-migration-candidate';
    risk = adapterLanguage ? 'bounded' : 'review';
  } else if (fileCategory === 'surface' && signal === 'browser-only-state') {
    disposition = 'surface-state-migration-candidate';
    risk = 'review';
  } else if (adapterLanguage) {
    disposition = 'optional-adapter-candidate';
    risk = 'bounded';
  }
  return Object.freeze({ file_category: fileCategory, disposition, risk, snippet });
}

async function walk(root, current = root, files = []) {
  const children = await fs.readdir(current, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    if (SKIP_DIRECTORIES.has(child.name)) continue;
    const absolute = path.join(current, child.name);
    if (child.isSymbolicLink()) continue;
    if (child.isDirectory()) {
      await walk(root, absolute, files);
      continue;
    }
    if (!child.isFile()) continue;
    const extension = path.extname(child.name).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension) && child.name !== 'Dockerfile' && !child.name.startsWith('Dockerfile.')) continue;
    const stats = await fs.stat(absolute);
    if (stats.size > MAX_FILE_BYTES) continue;
    files.push(absolute);
  }
  return files;
}

export async function inventorySourceHostAuthority({ root = process.cwd(), replacementReceipts = [] } = {}) {
  const selectedRoot = path.resolve(root);
  const files = await walk(selectedRoot);
  const findings = [];
  for (const absolute of files) {
    const filename = relative(absolute, selectedRoot);
    const source = await fs.readFile(absolute, 'utf8').catch(() => null);
    if (source === null) continue;
    for (const definition of SIGNALS) {
      definition.pattern.lastIndex = 0;
      let match;
      while ((match = definition.pattern.exec(source))) {
        const snippet = snippetAt(source, match.index, match[0].length);
        const classification = classifyFinding({ filename, source, signal: definition.signal, offset: match.index, snippet });
        findings.push(Object.freeze({
          finding_id: `finding_${sha256(`${filename}\0${definition.signal}\0${match.index}`).slice(0, 20)}`,
          path: filename,
          line: lineNumber(source, match.index),
          signal: definition.signal,
          match_digest: sha256(match[0]),
          ...classification
        }));
        if (findings.length > 20_000) throw new WorkspaceError('Source-host inventory exceeded 20000 findings.');
      }
    }
  }
  findings.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line || left.signal.localeCompare(right.signal));
  const receiptIds = new Set(replacementReceipts.map(value => String(value || '').trim()).filter(Boolean));
  const counts = {};
  for (const finding of findings) counts[finding.disposition] = (counts[finding.disposition] || 0) + 1;
  const blockers = findings.filter(finding => finding.disposition === 'canonical-runtime-blocker');
  const body = {
    schema: ARCHIE_SOURCE_HOST_INVENTORY_SCHEMA,
    scanned_root: '.',
    scanned_file_count: files.length,
    finding_count: findings.length,
    counts,
    blocker_count: blockers.length,
    replacement_receipts: [...receiptIds].sort(),
    deletion_ready: blockers.length === 0,
    findings,
    migration_law: 'A source-host-canonical path may be deleted only after an executable Archie-native replacement and equivalence receipt exist. CI, documentation, and optional adapter references do not become canonical merely by mentioning GitHub.',
    claim_boundary: 'This is a static authority inventory, not proof that every matched path executes. Classification is conservative and every blocker requires code-level confirmation before deletion.'
  };
  body.inventory_digest = sha256(stableJSONStringify(body));
  return Object.freeze(body);
}

function argument(argv, name, fallback = null) {
  const index = argv.lastIndexOf(name);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new WorkspaceError(`${name} requires a value.`);
  return value;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`archie-source-host-inventory\n\nUsage:\n  archie-source-host-inventory [--root <repository>] [--output <report.json>] [--fail-on-blocker]\n\nThe report distinguishes canonical runtime blockers from migration candidates, optional adapters, CI, tests, documentation, and nonruntime references. It never deletes code automatically.\n`);
    return null;
  }
  const report = await inventorySourceHostAuthority({ root: argument(argv, '--root', process.cwd()) });
  const output = argument(argv, '--output');
  if (output) {
    const target = path.resolve(output);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (argv.includes('--fail-on-blocker') && report.blocker_count) process.exitCode = 2;
  return report;
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) {
  main().catch(error => {
    process.stderr.write(`archie-source-host-inventory: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
