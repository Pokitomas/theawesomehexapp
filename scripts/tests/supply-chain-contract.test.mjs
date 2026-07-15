import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('../..', import.meta.url);
const workflowDir = new URL('../../.github/workflows/', import.meta.url);
const workflowFiles = readdirSync(workflowDir)
  .filter(name => /\.ya?ml$/i.test(name))
  .sort();

function workflow(name) {
  return readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8');
}

test('package manifest and lock agree on direct dependencies', () => {
  const packageJSON = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(lock.lockfileVersion, 3);
  assert.deepEqual(lock.packages?.['']?.dependencies || {}, packageJSON.dependencies || {});
  assert.deepEqual(lock.packages?.['']?.devDependencies || {}, packageJSON.devDependencies || {});
  assert.equal(lock.packages?.['node_modules/playwright-core']?.version, packageJSON.devDependencies?.['playwright-core']);
});

test('workflows never perform mutable npm installation', () => {
  const violations = [];
  for (const name of workflowFiles) {
    const source = workflow(name);
    source.split('\n').forEach((line, index) => {
      if (/\bnpm\s+install\b/.test(line)) violations.push(`${name}:${index + 1}:${line.trim()}`);
      if (/playwright-core@/.test(line)) violations.push(`${name}:${index + 1}:${line.trim()}`);
    });
  }
  assert.deepEqual(violations, []);
});

test('read-only proof workflows disable persisted checkout credentials', () => {
  const mutable = new Set(['coordination-ticks.yml', 'pages.yml', 'weave-lasso.yml']);
  const violations = [];
  for (const name of workflowFiles) {
    if (mutable.has(name)) continue;
    const source = workflow(name);
    const checkoutCount = [...source.matchAll(/uses:\s*actions\/checkout@/g)].length;
    const disabledCount = [...source.matchAll(/persist-credentials:\s*false/g)].length;
    if (checkoutCount && disabledCount < checkoutCount) violations.push(`${name}: ${checkoutCount} checkout(s), ${disabledCount} credential disable(s)`);
  }
  assert.deepEqual(violations, []);
});
