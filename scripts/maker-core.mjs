import path from 'node:path';

export const MAKER_SCHEMA = 'sideways-maker-lease/v1';
export const MAKER_MARKER = 'sideways-maker-lease:v1';

export const MAKER_LANES = Object.freeze([
  Object.freeze({
    id: 'product',
    title: 'product journey and frontend UX',
    scope: 'Inspect the root reader through private archive journey, first-run behavior, phone UX, accessibility, and visible incomplete product nodes. Read only. Do not propose runtime or security work except where it directly blocks this journey.'
  }),
  Object.freeze({
    id: 'social',
    title: 'social API to visible product reachability',
    scope: 'Inspect canonical social authority, API entrypoints, public projections, viewer operations, and whether implemented server behavior is actually reachable from consumer product surfaces. Read only. Do not review general frontend polish or Maker runtime.'
  }),
  Object.freeze({
    id: 'operator',
    title: 'Maker and coding-agent runtime',
    scope: 'Inspect Maker, Codex and other local coding-agent activation, repository context, worktree ergonomics, tests, receipts, and automation boundaries. Read only. Do not assess ordinary product UX or social semantics.'
  }),
  Object.freeze({
    id: 'hostile',
    title: 'hostile full-stack and operations review',
    scope: 'Inspect security, supply chain, workflow permissions, storage/network failure behavior, operational claims, test gaps, and collision hazards. Read only. Do not redesign product features unless a concrete security or operational defect requires it.'
  })
]);

export const laneReportSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['lane', 'summary', 'evidence', 'priority', 'recommended_lane', 'owned_paths', 'risks'],
  properties: {
    lane: { type: 'string' },
    summary: { type: 'string' },
    evidence: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'finding'],
        properties: {
          path: { type: 'string' },
          finding: { type: 'string' }
        }
      }
    },
    priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
    recommended_lane: { type: 'string' },
    owned_paths: { type: 'array', minItems: 1, maxItems: 40, items: { type: 'string' } },
    risks: { type: 'array', maxItems: 20, items: { type: 'string' } }
  }
});

export const planSchema = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['title', 'branch_slug', 'selected_lane', 'why_now', 'owned_paths', 'implementation_prompt', 'focused_tests', 'deferred'],
  properties: {
    title: { type: 'string' },
    branch_slug: { type: 'string' },
    selected_lane: { type: 'string', enum: MAKER_LANES.map(value => value.id) },
    why_now: { type: 'string' },
    owned_paths: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string' } },
    implementation_prompt: { type: 'string' },
    focused_tests: { type: 'array', maxItems: 20, items: { type: 'string' } },
    deferred: { type: 'array', maxItems: 30, items: { type: 'string' } }
  }
});

export function slugify(value, fallback = 'work') {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || fallback;
}

export function parseMakerArgs(argv) {
  const options = {
    request: '',
    base: 'main',
    agent: 'codex',
    commandJson: process.env.MAKER_AGENT_COMMAND_JSON || '',
    keepWorktree: false,
    localOnly: false,
    noInstall: false,
    dryRun: false,
    help: false
  };
  const requestParts = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--base') options.base = argv[++index] || '';
    else if (value === '--agent') options.agent = argv[++index] || '';
    else if (value === '--command-json') options.commandJson = argv[++index] || '';
    else if (value === '--keep-worktree') options.keepWorktree = true;
    else if (value === '--local-only') options.localOnly = true;
    else if (value === '--no-install') options.noInstall = true;
    else if (value === '--dry-run') options.dryRun = true;
    else if (value === '--help' || value === '-h') options.help = true;
    else if (value.startsWith('--')) throw new Error(`Unknown Maker option: ${value}`);
    else requestParts.push(value);
  }
  options.request = requestParts.join(' ').trim();
  if (!options.base) throw new Error('--base requires a branch name.');
  if (!['codex', 'command'].includes(options.agent)) throw new Error('--agent must be codex or command.');
  if (options.agent === 'command' && !options.commandJson) throw new Error('--agent command requires --command-json or MAKER_AGENT_COMMAND_JSON.');
  return options;
}

export function normalizeLeasePath(value) {
  let raw = String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!raw) throw new Error('Maker lease paths cannot be empty.');
  if (raw === '*' || raw === '**' || raw === '**/*') return '**';
  if (raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) throw new Error(`Maker lease path must be repository-relative: ${raw}`);
  const parts = raw.split('/').filter(Boolean);
  if (parts.some(part => part === '..' || part === '.')) throw new Error(`Maker lease path cannot traverse directories: ${raw}`);
  const wildcardAt = raw.indexOf('*');
  if (wildcardAt !== -1 && !raw.endsWith('/**')) throw new Error(`Maker lease supports only exact paths, directory prefixes, or /** suffixes: ${raw}`);
  raw = parts.join('/');
  if (raw.endsWith('/**')) raw = raw.slice(0, -3).replace(/\/$/, '');
  if (!raw) return '**';
  return raw;
}

export function normalizeLeasePaths(values) {
  const input = Array.isArray(values) && values.length ? values : ['**'];
  const normalized = [...new Set(input.map(normalizeLeasePath))];
  if (normalized.includes('**')) return ['**'];
  return normalized.sort();
}

function isPrefixPath(prefix, target) {
  return target === prefix || target.startsWith(`${prefix}/`);
}

export function pathsOverlap(left, right) {
  const a = normalizeLeasePath(left);
  const b = normalizeLeasePath(right);
  if (a === '**' || b === '**') return true;
  return isPrefixPath(a, b) || isPrefixPath(b, a);
}

export function leasesOverlap(leftPaths, rightPaths) {
  const left = normalizeLeasePaths(leftPaths);
  const right = normalizeLeasePaths(rightPaths);
  return left.some(a => right.some(b => pathsOverlap(a, b)));
}

export function buildLease({ sessionId, request, branch, baseBranch, baseSha, ownedPaths, selectedLane, createdAt = new Date().toISOString() }) {
  const lease = {
    schema: MAKER_SCHEMA,
    session_id: String(sessionId),
    request: String(request).slice(0, 4000),
    branch: String(branch),
    base_branch: String(baseBranch),
    base_sha: String(baseSha),
    created_at: String(createdAt),
    selected_lane: String(selectedLane),
    owned_paths: normalizeLeasePaths(ownedPaths),
    writer_count: 1,
    authority: {
      merge: 'human',
      deploy: 'human',
      secrets: 'never-in-prompt-or-receipt'
    }
  };
  assertLease(lease);
  return lease;
}

export function assertLease(value) {
  if (!value || typeof value !== 'object') throw new Error('Maker lease must be an object.');
  if (value.schema !== MAKER_SCHEMA) throw new Error(`Maker lease schema must be ${MAKER_SCHEMA}.`);
  for (const key of ['session_id', 'request', 'branch', 'base_branch', 'base_sha', 'created_at', 'selected_lane']) {
    if (!String(value[key] || '').trim()) throw new Error(`Maker lease is missing ${key}.`);
  }
  if (!String(value.branch).startsWith('maker/')) throw new Error('Maker branch must start with maker/.');
  if (value.writer_count !== 1) throw new Error('Maker lease must authorize exactly one writer.');
  value.owned_paths = normalizeLeasePaths(value.owned_paths);
  return value;
}

export function leaseMarker(lease) {
  assertLease(lease);
  return `<!-- ${MAKER_MARKER}\n${JSON.stringify(lease)}\n-->`;
}

export function parseLeaseMarker(body) {
  const pattern = new RegExp(`<!--\\s*${MAKER_MARKER.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*\\n([\\s\\S]*?)\\n-->`, 'm');
  const match = pattern.exec(String(body || ''));
  if (!match) return null;
  return assertLease(JSON.parse(match[1]));
}

export function buildLanePrompt({ request, lane, head }) {
  return [
    `You are the read-only ${lane.title} specialist for a repository-wide Maker run.`,
    `Repository HEAD at assessment: ${head}.`,
    `Founder request: ${request}`,
    '',
    lane.scope,
    '',
    'Inspect the repository deeply. Do not edit, create branches, commit, push, open PRs, or change GitHub state.',
    'Return only the JSON object required by the supplied output schema.',
    'owned_paths must describe the smallest plausible exclusive write lease for your recommended implementation lane. Use repository-relative exact files or directory prefixes; use ** only when truly repository-wide.'
  ].join('\n');
}

export function buildIntegratorPrompt({ request, head, reports }) {
  return [
    'You are the read-only primary engineer synthesizing four non-overlapping repository assessments.',
    `Repository HEAD: ${head}.`,
    `Founder request: ${request}`,
    '',
    'Choose exactly one highest-leverage code-local implementation lane. Prefer completion of visible product or operator reachability over documentation-only work. Do not edit anything.',
    'The plan must be implementable by one writer in one isolated worktree. owned_paths are an exclusive collision lease and must be as narrow as reality allows.',
    'implementation_prompt must tell the writer to inspect current code, implement end-to-end, run focused tests, run npm run verify:repository, inspect the diff, and stop at a draft PR without merge or deployment.',
    '',
    `Lane reports:\n${JSON.stringify(reports, null, 2)}`,
    '',
    'Return only the JSON object required by the supplied output schema.'
  ].join('\n');
}

export function buildWriterPrompt({ request, head, plan, reports, lease }) {
  return [
    'You are the only writer for this Maker session. Work aggressively but remain inside the leased repository paths unless a test or manifest must be updated to admit the same behavior.',
    `Base HEAD: ${head}.`,
    `Founder request: ${request}`,
    `Exclusive lease: ${lease.owned_paths.join(', ')}`,
    '',
    plan.implementation_prompt,
    '',
    'Hard rules:',
    '- inspect before changing; preserve unrelated work;',
    '- use the full repository and terminal capability available in this worktree;',
    '- do not create another writer or edit a second worktree;',
    '- never print, commit, or request credentials;',
    '- do not merge, deploy, force-push, or change repository settings;',
    '- run focused tests, then npm run verify:repository;',
    '- leave the worktree with the complete patch and a final concise receipt.',
    '',
    `Synthesized plan:\n${JSON.stringify(plan, null, 2)}`,
    '',
    `Read-only reports:\n${JSON.stringify(reports, null, 2)}`
  ].join('\n');
}

export function codexExecArgs({ workspace, sandbox, outputPath, schemaPath = '', json = true }) {
  const args = [
    'exec',
    '--cd', workspace,
    '--sandbox', sandbox,
    '--ask-for-approval', 'never',
    '--ephemeral',
    '--color', 'never'
  ];
  if (json) args.push('--json');
  if (schemaPath) args.push('--output-schema', schemaPath);
  if (outputPath) args.push('--output-last-message', outputPath);
  args.push('-');
  return args;
}

export function parseCommandArgv(value) {
  let parsed;
  try { parsed = JSON.parse(String(value || '')); }
  catch (error) { throw new Error(`Invalid agent command JSON: ${error.message}`); }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some(item => typeof item !== 'string' || !item)) {
    throw new Error('Agent command JSON must be a non-empty JSON array of strings.');
  }
  return parsed;
}

export function expandCommandArgv(argv, values) {
  return argv.map(item => item.replace(/\{(workspace|output|schema|role)\}/g, (_, key) => String(values[key] || '')));
}

export function safeSessionDirectory(root, sessionId) {
  return path.join(root, slugify(sessionId, 'session'));
}
