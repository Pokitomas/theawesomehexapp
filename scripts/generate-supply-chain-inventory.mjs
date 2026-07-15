#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const root = new URL('..', import.meta.url);
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const packageJSON = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const workflowDirectory = new URL('../.github/workflows/', import.meta.url);
const actionPattern = /\buses:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([0-9a-f]{40})(?:\s+#\s*([^\s]+))?/g;

function gitHead() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

function commandVersion(command, args = ['--version']) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return String(result.stdout || result.stderr || '').trim().split(/\r?\n/)[0] || null;
}

function packageName(path, metadata) {
  if (metadata?.name) return metadata.name;
  const marker = 'node_modules/';
  const index = path.lastIndexOf(marker);
  return index >= 0 ? path.slice(index + marker.length) : path;
}

const packages = Object.entries(lock.packages || {})
  .filter(([path]) => path)
  .map(([path, metadata]) => ({
    path,
    name: packageName(path, metadata),
    version: metadata.version || null,
    resolved: metadata.resolved || null,
    integrity: metadata.integrity || null,
    dev: Boolean(metadata.dev),
    optional: Boolean(metadata.optional)
  }))
  .sort((left, right) => left.path.localeCompare(right.path));

const actions = [];
for (const workflow of readdirSync(workflowDirectory).filter(name => /\.ya?ml$/i.test(name)).sort()) {
  const source = readFileSync(new URL(`../.github/workflows/${workflow}`, import.meta.url), 'utf8');
  for (const match of source.matchAll(actionPattern)) {
    actions.push({ workflow, repository: match[1], sha: match[2], version_comment: match[3] || null });
  }
}
actions.sort((left, right) => left.workflow.localeCompare(right.workflow) || left.repository.localeCompare(right.repository) || left.sha.localeCompare(right.sha));

const inventory = {
  schema: 'sideways-supply-chain-inventory/v1',
  repository: process.env.GITHUB_REPOSITORY || 'Pokitomas/theawesomehexapp',
  checked_head_sha: process.env.CANDIDATE_HEAD_SHA || process.env.GITHUB_SHA || gitHead(),
  generated_at: new Date().toISOString(),
  package_manager: {
    name: 'npm',
    lockfile_version: lock.lockfileVersion,
    direct_dependencies: packageJSON.dependencies || {},
    direct_dev_dependencies: packageJSON.devDependencies || {},
    packages
  },
  github_actions: actions,
  runtime: {
    node: process.version,
    npm: commandVersion('npm'),
    python: commandVersion('python3') || commandVersion('python'),
    runner_os: process.env.RUNNER_OS || process.platform,
    runner_arch: process.env.RUNNER_ARCH || process.arch,
    runner_image: process.env.ImageOS || null,
    runner_image_version: process.env.ImageVersion || null
  }
};

const output = process.argv[2] || 'supply-chain-inventory.json';
writeFileSync(output, `${JSON.stringify(inventory, null, 2)}\n`);
console.log(JSON.stringify({ output, packages: packages.length, actions: actions.length, checked_head_sha: inventory.checked_head_sha }));
