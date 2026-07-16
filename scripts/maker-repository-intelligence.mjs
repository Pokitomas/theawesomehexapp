import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  digest,
  inspectFilesystemEntry,
  normalizeRelativePath,
  redactSecrets,
  scanSecrets
} from './maker-security-policy.mjs';

const execFileDefault = promisify(execFileCallback);
const MAP_SCHEMA = 'sideways-maker-repository-map/v1';
const IMPACT_SCHEMA = 'sideways-maker-impact-report/v1';
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_FILES = 25000;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

const clean = (value, limit = 20000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, limit);
const nowISO = () => new Date().toISOString();
const sortedUnique = values => [...new Set(values)].sort();

const LANGUAGE_BY_EXTENSION = Object.freeze({
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.py': 'Python', '.pyi': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.kt': 'Kotlin', '.kts': 'Kotlin',
  '.rb': 'Ruby', '.php': 'PHP', '.cs': 'C#', '.c': 'C', '.h': 'C/C++ Header', '.cc': 'C++', '.cpp': 'C++', '.hpp': 'C/C++ Header',
  '.swift': 'Swift', '.scala': 'Scala', '.sh': 'Shell', '.bash': 'Shell', '.zsh': 'Shell', '.ps1': 'PowerShell',
  '.sql': 'SQL', '.graphql': 'GraphQL', '.gql': 'GraphQL', '.html': 'HTML', '.css': 'CSS', '.scss': 'SCSS', '.less': 'Less',
  '.vue': 'Vue', '.svelte': 'Svelte', '.ex': 'Elixir', '.exs': 'Elixir', '.erl': 'Erlang', '.hrl': 'Erlang',
  '.lua': 'Lua', '.r': 'R', '.dart': 'Dart', '.zig': 'Zig', '.sol': 'Solidity', '.tf': 'Terraform', '.hcl': 'HCL',
  '.md': 'Markdown', '.mdx': 'Markdown', '.json': 'JSON', '.jsonl': 'JSONL', '.yaml': 'YAML', '.yml': 'YAML', '.toml': 'TOML', '.xml': 'XML'
});
const LANGUAGE_BY_BASENAME = Object.freeze({
  Dockerfile: 'Dockerfile', Makefile: 'Make', Rakefile: 'Ruby', Gemfile: 'Ruby', Jenkinsfile: 'Groovy'
});
const MANIFESTS = Object.freeze({
  'package.json': { ecosystem: 'node', kind: 'manifest' },
  'package-lock.json': { ecosystem: 'node', kind: 'lockfile' },
  'pnpm-lock.yaml': { ecosystem: 'node', kind: 'lockfile' },
  'yarn.lock': { ecosystem: 'node', kind: 'lockfile' },
  'bun.lockb': { ecosystem: 'node', kind: 'lockfile' },
  'pyproject.toml': { ecosystem: 'python', kind: 'manifest' },
  'requirements.txt': { ecosystem: 'python', kind: 'manifest' },
  'poetry.lock': { ecosystem: 'python', kind: 'lockfile' },
  'Pipfile': { ecosystem: 'python', kind: 'manifest' },
  'Pipfile.lock': { ecosystem: 'python', kind: 'lockfile' },
  'go.mod': { ecosystem: 'go', kind: 'manifest' },
  'go.sum': { ecosystem: 'go', kind: 'lockfile' },
  'Cargo.toml': { ecosystem: 'rust', kind: 'manifest' },
  'Cargo.lock': { ecosystem: 'rust', kind: 'lockfile' },
  'pom.xml': { ecosystem: 'maven', kind: 'manifest' },
  'build.gradle': { ecosystem: 'gradle', kind: 'manifest' },
  'build.gradle.kts': { ecosystem: 'gradle', kind: 'manifest' },
  'Gemfile': { ecosystem: 'ruby', kind: 'manifest' },
  'Gemfile.lock': { ecosystem: 'ruby', kind: 'lockfile' },
  'composer.json': { ecosystem: 'php', kind: 'manifest' },
  'composer.lock': { ecosystem: 'php', kind: 'lockfile' },
  'mix.exs': { ecosystem: 'elixir', kind: 'manifest' },
  'pubspec.yaml': { ecosystem: 'dart', kind: 'manifest' },
  'Package.swift': { ecosystem: 'swift', kind: 'manifest' },
  'Dockerfile': { ecosystem: 'container', kind: 'build' },
  'docker-compose.yml': { ecosystem: 'container', kind: 'orchestration' },
  'docker-compose.yaml': { ecosystem: 'container', kind: 'orchestration' },
  'Makefile': { ecosystem: 'make', kind: 'build' }
});
const TEST_PATTERNS = [
  /(^|\/)(test|tests|spec|specs|__tests__)(\/|$)/i,
  /(?:^|[._-])(test|spec)\.[^.\/]+$/i,
  /_test\.go$/i,
  /tests?\.rs$/i
];
const GENERATED_PATTERNS = [
  /(^|\/)(dist|build|coverage|target|out|vendor|third_party|third-party|generated|gen)(\/|$)/i,
  /(?:\.min\.js|\.map|\.lock|\.generated\.|\.g\.dart|_generated\.)$/i
];
const VENDOR_PATTERNS = [/(^|\/)(vendor|third_party|third-party|external|deps)(\/|$)/i];
const SECRET_PATH_PATTERNS = [/(^|\/)\.env(?:\.|$)/i, /(?:^|\/)(credentials?|secrets?)(?:\.|\/|$)/i, /\.(?:pem|p12|pfx|key)$/i];
const DOCUMENTATION_PATTERNS = [/(^|\/)(README|CONTRIBUTING|ARCHITECTURE|DESIGN|SECURITY|CHANGELOG|LICENSE)(?:\.|$)/i, /(^|\/)docs?(\/|$)/i];

function languageFor(relative) {
  const basename = path.posix.basename(relative);
  return LANGUAGE_BY_BASENAME[basename] || LANGUAGE_BY_EXTENSION[path.posix.extname(basename).toLowerCase()] || 'Other';
}

function isTestFile(relative) {
  return TEST_PATTERNS.some(pattern => pattern.test(relative));
}

function isGenerated(relative) {
  return GENERATED_PATTERNS.some(pattern => pattern.test(relative));
}

function isVendor(relative) {
  return VENDOR_PATTERNS.some(pattern => pattern.test(relative));
}

function isSecretPath(relative) {
  return SECRET_PATH_PATTERNS.some(pattern => pattern.test(relative));
}

function isDocumentation(relative) {
  return DOCUMENTATION_PATTERNS.some(pattern => pattern.test(relative));
}

function manifestKind(relative) {
  const basename = path.posix.basename(relative);
  return MANIFESTS[basename] || null;
}

function normalizeOptions(input = {}) {
  const baseSha = clean(input.base_sha, 40).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(baseSha)) throw new Error('Repository intelligence requires an exact base SHA.');
  const repository = clean(input.repository, 300);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Repository intelligence requires owner/repository.');
  return Object.freeze({
    repository,
    base_sha: baseSha,
    branch: clean(input.branch || 'main', 240),
    max_files: Math.max(1, Math.min(200000, Number(input.max_files || DEFAULT_MAX_FILES))),
    max_total_bytes: Math.max(1024, Math.min(4 * 1024 * 1024 * 1024, Number(input.max_total_bytes || DEFAULT_MAX_TOTAL_BYTES))),
    max_file_bytes: Math.max(1024, Math.min(MAX_TEXT_BYTES, Number(input.max_file_bytes || MAX_TEXT_BYTES))),
    include_generated: input.include_generated === true,
    include_vendor: input.include_vendor === true
  });
}

function exactGitEnv() {
  return { PATH: process.env.PATH || '', HOME: process.env.HOME || '', LC_ALL: 'C', LANG: 'C', NO_COLOR: '1' };
}

async function runGit(executor, root, args) {
  const value = await executor('git', args, { cwd: root, env: exactGitEnv(), maxBuffer: 64 * 1024 * 1024, timeout: 120000, windowsHide: true });
  return clean(value.stdout, 64 * 1024 * 1024);
}

async function trackedFiles(executor, root) {
  const output = await runGit(executor, root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  return output.split('\0').map(value => value.trim()).filter(Boolean).map(normalizeRelativePath);
}

function parsePackageManifest(text, relative) {
  try {
    const value = JSON.parse(text);
    const scripts = Object.entries(value.scripts || {}).map(([name, command]) => ({ name, command: clean(redactSecrets(command), 2000), command_digest: digest(String(command)) }));
    const dependencySections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
    const dependencies = [];
    for (const section of dependencySections) {
      for (const [name, version] of Object.entries(value[section] || {})) dependencies.push({ name, version: clean(version, 300), section });
    }
    return {
      path: relative,
      ecosystem: 'node',
      package_name: clean(value.name, 300) || null,
      package_type: clean(value.type, 80) || null,
      private: value.private === true,
      engines: redactSecrets(value.engines || {}),
      workspaces: Array.isArray(value.workspaces) ? value.workspaces : value.workspaces?.packages || [],
      scripts,
      dependencies,
      parse_error: null
    };
  } catch (error) {
    return { path: relative, ecosystem: 'node', scripts: [], dependencies: [], parse_error: clean(error.message, 500) };
  }
}

function parseSimpleManifest(text, relative, metadata) {
  const dependencies = [];
  if (metadata.ecosystem === 'python' && path.posix.basename(relative) === 'requirements.txt') {
    for (const line of text.split(/\r?\n/)) {
      const value = line.trim();
      if (!value || value.startsWith('#') || value.startsWith('-')) continue;
      const match = value.match(/^([A-Za-z0-9_.-]+)(.*)$/);
      if (match) dependencies.push({ name: match[1], version: clean(match[2], 300), section: 'requirements' });
    }
  } else if (metadata.ecosystem === 'go') {
    for (const match of text.matchAll(/^\s*require\s+([^\s]+)\s+([^\s]+)$/gm)) dependencies.push({ name: match[1], version: match[2], section: 'require' });
  } else if (metadata.ecosystem === 'rust') {
    let inDependencies = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*\[dependencies/.test(line)) inDependencies = true;
      else if (/^\s*\[/.test(line)) inDependencies = false;
      else if (inDependencies) {
        const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
        if (match) dependencies.push({ name: match[1], version: clean(match[2], 300), section: 'dependencies' });
      }
    }
  }
  return { path: relative, ecosystem: metadata.ecosystem, scripts: [], dependencies, parse_error: null };
}

function parseCodeowners(text) {
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts.length >= 2) rules.push({ pattern: parts[0], owners: parts.slice(1) });
  }
  return rules;
}

function ownerPatternMatches(relative, patternInput) {
  let pattern = String(patternInput || '').trim();
  if (!pattern) return false;
  if (pattern.startsWith('/')) pattern = pattern.slice(1);
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§§').replace(/\*/g, '[^/]*').replace(/§§/g, '.*').replace(/\?/g, '.');
  const suffix = pattern.endsWith('/') ? '.*' : '';
  return new RegExp(`^${escaped}${suffix}$`).test(relative) || (!pattern.includes('/') && new RegExp(`(^|/)${escaped}${suffix}$`).test(relative));
}

function ownersFor(relative, rules) {
  let owners = [];
  for (const rule of rules) if (ownerPatternMatches(relative, rule.pattern)) owners = [...rule.owners];
  return owners;
}

function extractImports(language, text) {
  const values = [];
  const patterns = language === 'JavaScript' || language === 'TypeScript'
    ? [/(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g, /require\(\s*['"]([^'"]+)['"]\s*\)/g, /import\(\s*['"]([^'"]+)['"]\s*\)/g]
    : language === 'Python'
      ? [/^\s*from\s+([A-Za-z0-9_.]+)\s+import\s+/gm, /^\s*import\s+([A-Za-z0-9_., ]+)/gm]
      : language === 'Go'
        ? [/^\s*"([^"]+)"\s*$/gm]
        : language === 'Rust'
          ? [/^\s*(?:use|mod)\s+([A-Za-z0-9_:]+)/gm]
          : [];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) {
    for (const value of String(match[1]).split(',').map(item => item.trim()).filter(Boolean)) values.push(value);
  }
  return sortedUnique(values).slice(0, 5000);
}

function extractSymbols(language, text) {
  const symbols = [];
  const add = (kind, name, line) => {
    if (name && symbols.length < 5000) symbols.push({ kind, name: clean(name, 300), line });
  };
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    let match;
    if (['JavaScript', 'TypeScript'].includes(language)) {
      match = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/); if (match) add('function', match[1], index + 1);
      match = line.match(/^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/); if (match) add('class', match[1], index + 1);
      match = line.match(/^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/); if (match) add('export', match[1], index + 1);
    } else if (language === 'Python') {
      match = line.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/); if (match) add('function', match[1], index + 1);
      match = line.match(/^\s*class\s+([A-Za-z_]\w*)/); if (match) add('class', match[1], index + 1);
    } else if (language === 'Go') {
      match = line.match(/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/); if (match) add('function', match[1], index + 1);
      match = line.match(/^\s*type\s+([A-Za-z_]\w*)\s+/); if (match) add('type', match[1], index + 1);
    } else if (language === 'Rust') {
      match = line.match(/^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)/); if (match) add('function', match[1], index + 1);
      match = line.match(/^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/); if (match) add('type', match[1], index + 1);
    } else if (['Java', 'Kotlin', 'C#', 'C++', 'C'].includes(language)) {
      match = line.match(/^\s*(?:public|private|protected|internal|static|final|abstract|virtual|async|constexpr|inline|extern|class|struct|interface|enum|[A-Za-z_][\w<>:, ]+)\s+([A-Za-z_]\w*)\s*\(/); if (match) add('callable', match[1], index + 1);
    }
  });
  return symbols;
}

function resolveInternalImport(source, specifier, trackedSet) {
  if (!specifier.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(source), specifier));
  const candidates = [
    base,
    ...Object.keys(LANGUAGE_BY_EXTENSION).map(extension => `${base}${extension}`),
    ...Object.keys(LANGUAGE_BY_EXTENSION).map(extension => `${base}/index${extension}`)
  ];
  return candidates.find(candidate => trackedSet.has(candidate)) || null;
}

function testCommandsFromManifests(manifests) {
  const commands = [];
  for (const manifest of manifests) {
    if (manifest.ecosystem === 'node') {
      for (const script of manifest.scripts || []) {
        if (/test|verify|check|lint|type|build|e2e|integration|unit/i.test(script.name)) commands.push({ source: manifest.path, name: script.name, command: `npm run ${script.name}`, declared_command_digest: script.command_digest });
      }
    }
  }
  return commands;
}

function inferCommands(files, manifests) {
  const commands = testCommandsFromManifests(manifests);
  const basenames = new Set(files.map(file => path.posix.basename(file.path)));
  if (basenames.has('pyproject.toml') || basenames.has('requirements.txt')) commands.push({ source: 'inference', name: 'python-tests', command: 'python -m pytest', inferred: true });
  if (basenames.has('go.mod')) commands.push({ source: 'inference', name: 'go-tests', command: 'go test ./...', inferred: true });
  if (basenames.has('Cargo.toml')) commands.push({ source: 'inference', name: 'rust-tests', command: 'cargo test', inferred: true });
  if (basenames.has('pom.xml')) commands.push({ source: 'inference', name: 'maven-tests', command: 'mvn test', inferred: true });
  if (basenames.has('build.gradle') || basenames.has('build.gradle.kts')) commands.push({ source: 'inference', name: 'gradle-tests', command: './gradlew test', inferred: true });
  if (basenames.has('Makefile')) commands.push({ source: 'inference', name: 'make', command: 'make test', inferred: true });
  return commands;
}

function parseWorkflow(relative, text) {
  const name = text.match(/^name:\s*(.+)$/m)?.[1]?.trim() || path.posix.basename(relative);
  const permissions = [];
  let inPermissions = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^permissions:\s*$/.test(line)) { inPermissions = true; continue; }
    if (inPermissions && /^\S/.test(line)) inPermissions = false;
    if (inPermissions) {
      const match = line.match(/^\s+([A-Za-z-]+):\s*([^#]+?)\s*$/);
      if (match) permissions.push({ scope: match[1], level: match[2] });
    }
  }
  const triggers = [];
  for (const value of ['push', 'pull_request', 'workflow_dispatch', 'issues', 'issue_comment', 'schedule', 'workflow_run']) if (new RegExp(`^\\s*${value}:`, 'm').test(text)) triggers.push(value);
  return { path: relative, name: clean(name.replace(/^['"]|['"]$/g, ''), 300), triggers, permissions };
}

function hotspotScore(file, importerCount, reverseCount, symbolCount, ownerCount) {
  let score = 0;
  score += Math.min(30, Math.round(Math.log2(Math.max(1, file.bytes)) * 2));
  score += Math.min(25, importerCount * 3);
  score += Math.min(15, reverseCount * 2);
  score += Math.min(15, symbolCount);
  if (file.test) score -= 5;
  if (!ownerCount) score += 5;
  if (file.generated || file.vendor) score -= 20;
  if (file.secret_path) score += 20;
  return Math.max(0, Math.min(100, score));
}

export class RepositoryIntelligence {
  constructor({ root, security_policy, fs_impl = fs, executor = execFileDefault, clock = nowISO } = {}) {
    if (!root) throw new Error('Repository intelligence requires a checkout root.');
    if (!security_policy?.decide) throw new Error('Repository intelligence requires a security policy.');
    this.root = path.resolve(root);
    this.security = security_policy;
    this.fs = fs_impl;
    this.executor = executor;
    this.clock = clock;
    this.map = null;
  }

  #authorize(pathValue = '.') {
    const decision = this.security.decide({ capability: 'read.repository', origin: 'worker_attestation', context: { path: pathValue } });
    if (!decision.allowed) throw new Error(`Repository intelligence denied: ${decision.reason}.`);
    return decision;
  }

  async inspect(input = {}) {
    const options = normalizeOptions(input);
    const head = (await runGit(this.executor, this.root, ['rev-parse', 'HEAD'])).trim().toLowerCase();
    if (head !== options.base_sha) throw new Error(`Repository checkout HEAD ${head} differs from requested base ${options.base_sha}.`);
    const status = await runGit(this.executor, this.root, ['status', '--short', '--untracked-files=all']);
    const allTracked = await trackedFiles(this.executor, this.root);
    const selected = [];
    let totalBytes = 0;
    let truncated = false;
    for (const relative of allTracked.sort()) {
      if (selected.length >= options.max_files || totalBytes >= options.max_total_bytes) { truncated = true; break; }
      if (!options.include_generated && isGenerated(relative)) continue;
      if (!options.include_vendor && isVendor(relative)) continue;
      const absolute = path.resolve(this.root, ...relative.split('/'));
      if (absolute !== this.root && !absolute.startsWith(`${this.root}${path.sep}`)) continue;
      let stat;
      try { stat = await this.fs.lstat(absolute); } catch { continue; }
      const inspection = inspectFilesystemEntry({ path: relative, type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'special', symlink: stat.isSymbolicLink(), nlink: stat.nlink, size: stat.size, max_bytes: options.max_file_bytes });
      if (!inspection.allowed || !stat.isFile()) continue;
      totalBytes += stat.size;
      if (totalBytes > options.max_total_bytes) { truncated = true; break; }
      selected.push({ relative, absolute, stat });
    }

    const trackedSet = new Set(allTracked);
    const files = [];
    const manifests = [];
    const workflows = [];
    let codeowners = [];
    const importsByFile = new Map();
    const symbolsByFile = new Map();
    const languageBytes = new Map();
    const languageFiles = new Map();
    const secretFindings = [];

    for (const entry of selected) {
      const relative = entry.relative;
      const language = languageFor(relative);
      const test = isTestFile(relative);
      const generated = isGenerated(relative);
      const vendor = isVendor(relative);
      const secretPath = isSecretPath(relative);
      const documentation = isDocumentation(relative);
      const metadata = manifestKind(relative);
      const readDecision = this.#authorize(relative);
      let text = null;
      let contentDigest = null;
      let lineCount = null;
      let secretCount = 0;
      if (entry.stat.size <= options.max_file_bytes && !secretPath) {
        try {
          text = await this.fs.readFile(entry.absolute, 'utf8');
          contentDigest = digest(text);
          lineCount = text.split(/\r?\n/).length;
          const findings = scanSecrets(text);
          secretCount = findings.length;
          for (const finding of findings.slice(0, 100)) secretFindings.push({ path: relative, id: finding.id, fingerprint: finding.fingerprint, length: finding.length });
        } catch { text = null; }
      }
      const file = {
        path: relative,
        language,
        bytes: entry.stat.size,
        lines: lineCount,
        content_digest: contentDigest,
        test,
        generated,
        vendor,
        documentation,
        secret_path: secretPath,
        secret_finding_count: secretCount,
        manifest: metadata,
        owners: [],
        read_decision_digest: readDecision.decision_digest
      };
      files.push(file);
      languageBytes.set(language, (languageBytes.get(language) || 0) + entry.stat.size);
      languageFiles.set(language, (languageFiles.get(language) || 0) + 1);
      if (text !== null) {
        if (metadata?.kind === 'manifest') manifests.push(path.posix.basename(relative) === 'package.json' ? parsePackageManifest(text, relative) : parseSimpleManifest(text, relative, metadata));
        if (relative.startsWith('.github/workflows/') && /\.ya?ml$/i.test(relative)) workflows.push(parseWorkflow(relative, text));
        if (['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'].includes(relative)) codeowners = parseCodeowners(text);
        const imports = extractImports(language, text);
        importsByFile.set(relative, imports.map(specifier => ({ specifier, target: resolveInternalImport(relative, specifier, trackedSet) })));
        symbolsByFile.set(relative, extractSymbols(language, text));
      } else {
        importsByFile.set(relative, []);
        symbolsByFile.set(relative, []);
      }
    }

    for (const file of files) file.owners = ownersFor(file.path, codeowners);
    const reverse = new Map(files.map(file => [file.path, []]));
    for (const [source, imports] of importsByFile) for (const edge of imports) if (edge.target && reverse.has(edge.target)) reverse.get(edge.target).push(source);
    const tests = files.filter(file => file.test).map(file => file.path);
    const commands = inferCommands(files, manifests);
    const fileRecords = files.map(file => {
      const imports = importsByFile.get(file.path) || [];
      const internalImports = imports.filter(value => value.target);
      const reverseImports = sortedUnique(reverse.get(file.path) || []);
      const symbols = symbolsByFile.get(file.path) || [];
      const score = hotspotScore(file, internalImports.length, reverseImports.length, symbols.length, file.owners.length);
      return {
        ...file,
        imports,
        internal_import_count: internalImports.length,
        reverse_imports: reverseImports,
        symbols,
        hotspot_score: score
      };
    });
    const hotspots = fileRecords.filter(file => file.hotspot_score > 0).sort((left, right) => right.hotspot_score - left.hotspot_score || left.path.localeCompare(right.path)).slice(0, 100).map(file => ({ path: file.path, score: file.hotspot_score, reverse_import_count: file.reverse_imports.length, symbol_count: file.symbols.length, test: file.test, owners: file.owners }));
    const languages = [...languageBytes].map(([name, bytes]) => ({ name, bytes, files: languageFiles.get(name) || 0 })).sort((left, right) => right.bytes - left.bytes || left.name.localeCompare(right.name));
    const body = {
      schema: MAP_SCHEMA,
      repository: options.repository,
      base_sha: options.base_sha,
      branch: options.branch,
      checkout_dirty: Boolean(status.trim()),
      dirty_status_digest: status.trim() ? digest(status) : null,
      limits: { max_files: options.max_files, max_total_bytes: options.max_total_bytes, max_file_bytes: options.max_file_bytes },
      observed: { tracked_candidates: allTracked.length, files: fileRecords.length, bytes: totalBytes, truncated },
      languages,
      manifests,
      workflows,
      codeowners,
      files: fileRecords,
      tests,
      commands,
      hotspots,
      secret_findings: secretFindings,
      generated_at: this.clock()
    };
    this.map = Object.freeze({ ...body, map_digest: digest(body) });
    return this.map;
  }

  impact(pathInput, mapInput = this.map) {
    if (!mapInput) throw new Error('Repository map is not available.');
    const relative = normalizeRelativePath(pathInput);
    const file = mapInput.files.find(value => value.path === relative);
    if (!file) throw new Error(`Repository map does not contain ${relative}.`);
    const affected = new Set([relative]);
    const queue = [...file.reverse_imports];
    while (queue.length && affected.size < 5000) {
      const candidate = queue.shift();
      if (affected.has(candidate)) continue;
      affected.add(candidate);
      const record = mapInput.files.find(value => value.path === candidate);
      for (const reverse of record?.reverse_imports || []) queue.push(reverse);
    }
    const likelyTests = mapInput.files.filter(value => value.test && (affected.has(value.path) || value.imports.some(edge => edge.target && affected.has(edge.target)))).map(value => value.path);
    const relevantCommands = mapInput.commands.filter(command => /test|verify|check|lint|type|build|e2e|integration|unit/i.test(command.name || command.command));
    const body = {
      schema: IMPACT_SCHEMA,
      repository: mapInput.repository,
      base_sha: mapInput.base_sha,
      target: relative,
      target_digest: file.content_digest,
      owners: file.owners,
      direct_importers: file.reverse_imports,
      affected_paths: [...affected].sort(),
      likely_tests: sortedUnique(likelyTests),
      verification_commands: relevantCommands,
      risk: {
        hotspot_score: file.hotspot_score,
        generated: file.generated,
        vendor: file.vendor,
        secret_path: file.secret_path,
        secret_finding_count: file.secret_finding_count,
        public_symbol_count: file.symbols.length
      },
      generated_at: this.clock()
    };
    return Object.freeze({ ...body, impact_digest: digest(body) });
  }
}
