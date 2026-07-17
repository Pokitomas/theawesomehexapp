import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { RepositoryIntelligence } from '../maker-repository-intelligence.mjs';
import { MakerSecurityPolicy, digest } from '../maker-security-policy.mjs';

const execFileAsync = promisify(execFile);
const CLOCK = () => '2026-07-16T00:00:00.000Z';

async function git(root, args) {
  return execFileAsync('git', args, { cwd: root, maxBuffer: 8 * 1024 * 1024 });
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-intelligence-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, ['init']);
  await git(root, ['config', 'user.name', 'Maker Test']);
  await git(root, ['config', 'user.email', 'maker@example.test']);
  const files = {
    'package.json': JSON.stringify({
      name: 'intelligence-fixture',
      private: true,
      type: 'module',
      scripts: {
        test: 'node --test test/*.test.mjs',
        verify: 'npm run test && npm run lint',
        lint: 'node scripts/lint.mjs',
        start: 'node src/app.mjs'
      },
      dependencies: { leftpad: '1.0.0' },
      devDependencies: { eslint: '9.0.0' }
    }, null, 2) + '\n',
    'package-lock.json': '{"lockfileVersion":3}\n',
    'src/core.mjs': 'export function core(value) { return value + 1; }\nexport class CoreThing {}\n',
    'src/service.mjs': "import { core } from './core.mjs';\nexport function service(value) { return core(value); }\n",
    'src/app.mjs': "import { service } from './service.mjs';\nconsole.log(service(1));\n",
    'src/leak.mjs': "export const accidental = 'github_pat_123456789012345678901234567890';\n",
    'test/core.test.mjs': "import { core } from '../src/core.mjs';\nexport function testCore() { return core(1) === 2; }\n",
    'scripts/lint.mjs': "export function lint() { return true; }\n",
    '.github/workflows/ci.yml': 'name: CI\non:\n  pull_request:\npermissions:\n  contents: read\n  checks: write\njobs:\n  test:\n    runs-on: ubuntu-latest\n',
    '.github/CODEOWNERS': '/src/ @acme/core\n*.md @acme/docs\n',
    'README.md': '# Architecture\nThe app imports a service and a core.\n',
    '.env': 'DATABASE_URL=postgres://user:pass@localhost/db\n',
    'dist/generated.js': 'export const generated = true;\n',
    'vendor/external.js': 'export const vendored = true;\n'
  };
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, ...relative.split('/'));
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, 'utf8');
  }
  await fs.symlink(path.join(root, 'README.md'), path.join(root, 'src', 'readme-link.md'));
  await git(root, ['add', '--all']);
  await git(root, ['commit', '-m', 'fixture']);
  const { stdout } = await git(root, ['rev-parse', 'HEAD']);
  return { root, sha: stdout.trim().toLowerCase(), token: 'github_pat_123456789012345678901234567890' };
}

function intelligence(root, overrides = {}) {
  return new RepositoryIntelligence({
    root,
    security_policy: overrides.security || new MakerSecurityPolicy({ clock: CLOCK }),
    clock: CLOCK
  });
}

function options(sha, overrides = {}) {
  return {
    repository: 'acme/widgets',
    base_sha: sha,
    branch: 'main',
    ...overrides
  };
}

test('exact checkout map discovers languages, manifests, commands, workflows, owners, symbols, and tests', async t => {
  const { root, sha } = await fixture(t);
  const map = await intelligence(root).inspect(options(sha));
  assert.equal(map.schema, 'sideways-maker-repository-map/v1');
  assert.equal(map.base_sha, sha);
  assert.equal(map.checkout_dirty, false);
  assert.match(map.map_digest, /^[0-9a-f]{64}$/);
  assert.match(map.read_authority_digest, /^[0-9a-f]{64}$/);
  assert.ok(map.languages.some(value => value.name === 'JavaScript'));
  const manifest = map.manifests.find(value => value.path === 'package.json');
  assert.equal(manifest.package_name, 'intelligence-fixture');
  assert.ok(manifest.dependencies.some(value => value.name === 'leftpad'));
  assert.ok(map.commands.some(value => value.command === 'npm run test'));
  assert.ok(map.commands.some(value => value.command === 'npm run verify'));
  assert.ok(map.tests.includes('test/core.test.mjs'));
  const workflow = map.workflows.find(value => value.path === '.github/workflows/ci.yml');
  assert.equal(workflow.name, 'CI');
  assert.ok(workflow.triggers.includes('pull_request'));
  assert.deepEqual(workflow.permissions, [{ scope: 'contents', level: 'read' }, { scope: 'checks', level: 'write' }]);
  const core = map.files.find(value => value.path === 'src/core.mjs');
  assert.deepEqual(core.owners, ['@acme/core']);
  assert.ok(core.symbols.some(value => value.name === 'core'));
  assert.ok(core.symbols.some(value => value.name === 'CoreThing'));
  assert.ok(core.reverse_imports.includes('src/service.mjs'));
  assert.ok(core.reverse_imports.includes('test/core.test.mjs'));
  assert.ok(map.hotspots.some(value => value.path === 'src/core.mjs'));
});

test('internal imports resolve to tracked files and impact traverses reverse dependencies into likely tests', async t => {
  const { root, sha } = await fixture(t);
  const mapper = intelligence(root);
  const map = await mapper.inspect(options(sha));
  const service = map.files.find(value => value.path === 'src/service.mjs');
  assert.ok(service.imports.some(value => value.specifier === './core.mjs' && value.target === 'src/core.mjs'));
  const app = map.files.find(value => value.path === 'src/app.mjs');
  assert.ok(app.imports.some(value => value.target === 'src/service.mjs'));
  const impact = mapper.impact('src/core.mjs');
  assert.equal(impact.target, 'src/core.mjs');
  assert.ok(impact.affected_paths.includes('src/service.mjs'));
  assert.ok(impact.affected_paths.includes('src/app.mjs'));
  assert.ok(impact.likely_tests.includes('test/core.test.mjs'));
  assert.ok(impact.verification_commands.some(value => value.command === 'npm run test'));
  assert.deepEqual(impact.owners, ['@acme/core']);
  assert.match(impact.impact_digest, /^[0-9a-f]{64}$/);
});

test('secret paths are never read and secret findings expose fingerprints rather than values', async t => {
  const { root, sha, token } = await fixture(t);
  const map = await intelligence(root).inspect(options(sha));
  const env = map.files.find(value => value.path === '.env');
  assert.equal(env.secret_path, true);
  assert.equal(env.content_digest, null);
  assert.equal(env.lines, null);
  const leak = map.files.find(value => value.path === 'src/leak.mjs');
  assert.ok(leak.secret_finding_count >= 1);
  assert.ok(map.secret_findings.some(value => value.path === 'src/leak.mjs' && /^[0-9a-f]{16}$/.test(value.fingerprint)));
  assert.ok(!JSON.stringify(map).includes(token));
  assert.ok(!JSON.stringify(map).includes('postgres://user:pass'));
});

test('generated, vendor, and symlink content are excluded by default and explicitly includable', async t => {
  const { root, sha } = await fixture(t);
  const defaults = await intelligence(root).inspect(options(sha));
  assert.equal(defaults.files.some(value => value.path === 'dist/generated.js'), false);
  assert.equal(defaults.files.some(value => value.path === 'vendor/external.js'), false);
  assert.equal(defaults.files.some(value => value.path === 'src/readme-link.md'), false);
  const expanded = await intelligence(root).inspect(options(sha, { include_generated: true, include_vendor: true }));
  assert.equal(expanded.files.find(value => value.path === 'dist/generated.js').generated, true);
  assert.equal(expanded.files.find(value => value.path === 'vendor/external.js').vendor, true);
  assert.equal(expanded.files.some(value => value.path === 'src/readme-link.md'), false);
});

test('wrong exact revision fails before repository evidence is admitted', async t => {
  const { root } = await fixture(t);
  await assert.rejects(intelligence(root).inspect(options('f'.repeat(40))), /differs from requested base/);
  await assert.rejects(intelligence(root).inspect({ repository: 'bad', base_sha: 'f'.repeat(40) }), /owner\/repository/);
  await assert.rejects(intelligence(root).inspect({ repository: 'acme/widgets', base_sha: 'main' }), /exact base SHA/);
});

test('dirty checkout is visible only through a digest and does not fabricate a clean map', async t => {
  const { root, sha } = await fixture(t);
  await fs.writeFile(path.join(root, 'src', 'core.mjs'), 'external dirty change\n', 'utf8');
  const map = await intelligence(root).inspect(options(sha));
  assert.equal(map.checkout_dirty, true);
  assert.match(map.dirty_status_digest, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(map).includes(' M src/core.mjs'));
  assert.equal(map.files.find(value => value.path === 'src/core.mjs').content_digest, digest('external dirty change\n'));
});

test('file and byte budgets truncate deterministically instead of silently scanning forever', async t => {
  const { root, sha } = await fixture(t);
  const map = await intelligence(root).inspect(options(sha, { max_files: 3, max_total_bytes: 1024 * 1024 }));
  assert.equal(map.observed.files, 3);
  assert.equal(map.observed.truncated, true);
  const names = map.files.map(value => value.path);
  assert.deepEqual(names, [...names].sort());
});

test('malformed manifests preserve parse failure evidence and inferred verification commands', async t => {
  const { root, sha } = await fixture(t);
  await fs.writeFile(path.join(root, 'package.json'), '{not-json\n', 'utf8');
  const map = await intelligence(root).inspect(options(sha));
  const manifest = map.manifests.find(value => value.path === 'package.json');
  assert.match(manifest.parse_error, /JSON/);
  assert.deepEqual(manifest.scripts, []);
  assert.equal(map.checkout_dirty, true);
});

test('maps are reproducible for the same checkout and fixed observation time', async t => {
  const { root, sha } = await fixture(t);
  const first = await intelligence(root).inspect(options(sha));
  const second = await intelligence(root).inspect(options(sha));
  assert.equal(first.map_digest, second.map_digest);
  assert.deepEqual(first.languages, second.languages);
  assert.deepEqual(first.hotspots, second.hotspots);
});

test('impact refuses paths absent from the admitted exact map', async t => {
  const { root, sha } = await fixture(t);
  const mapper = intelligence(root);
  await mapper.inspect(options(sha));
  assert.throws(() => mapper.impact('missing.mjs'), /does not contain/);
  assert.throws(() => mapper.impact('../escape'), /repository-relative/);
});
