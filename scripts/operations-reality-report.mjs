#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function checkedHead(root) {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

function inspectFile(root, id, relativePath, patterns = []) {
  const absolutePath = path.join(root, relativePath);
  if (!existsSync(absolutePath)) {
    return { id, status: 'stale', evidence: [relativePath], reason: 'required repository artifact is missing' };
  }
  const content = readFileSync(absolutePath, 'utf8');
  const missing = patterns.filter(pattern => !content.includes(pattern));
  if (missing.length) {
    return {
      id,
      status: 'stale',
      evidence: [relativePath],
      reason: `required contract markers are missing: ${missing.join(', ')}`
    };
  }
  return { id, status: 'verified', evidence: [relativePath] };
}

export function inspectOperationsReality({ root = defaultRoot, observedAt = new Date().toISOString() } = {}) {
  const migrationsDir = path.join(root, 'migrations');
  const migrations = existsSync(migrationsDir)
    ? readdirSync(migrationsDir).filter(name => /^\d+_.+\.sql$/.test(name)).sort()
    : [];

  const repositoryFacts = [
    inspectFile(root, 'pages_workflow_least_privilege', '.github/workflows/pages.yml', [
      'permissions:\n  contents: read',
      'pages: write',
      'id-token: write',
      'issues: write',
      'persist-credentials: false'
    ]),
    inspectFile(root, 'pages_exact_commit_verification', '.github/workflows/pages.yml', [
      'actions/deploy-pages@',
      'Verify deployed commit identity',
      'deployment-receipt.cjs verify-live',
      'Upsert successful deployment receipt'
    ]),
    inspectFile(root, 'deployment_sentinel_contract', 'scripts/deployment-receipt.cjs', [
      'write-sentinel',
      'verify-live',
      'sideways-deployment.json'
    ]),
    inspectFile(root, 'relational_schema_bootstrap', 'netlify/functions/social-entrypoint-core.mjs', [
      'ensureSocialSchema',
      'schemaReady ||=',
      'Social database schema is unavailable.'
    ]),
    inspectFile(root, 'relational_migration_runner', 'netlify/functions/social-postgres-migrations.mjs', [
      'social_schema_migrations',
      'pg_advisory'
    ]),
    inspectFile(root, 'whole_repository_verification', 'scripts/verify-repository.mjs', [
      'audit/repository-verification.json',
      'checked_head_sha',
      'candidate_head_sha'
    ])
  ];

  if (migrations.length < 2) {
    repositoryFacts.push({
      id: 'ordered_social_migrations',
      status: 'stale',
      evidence: ['migrations/'],
      reason: `expected at least two ordered migrations, found ${migrations.length}`
    });
  } else {
    repositoryFacts.push({
      id: 'ordered_social_migrations',
      status: 'verified',
      evidence: migrations.map(name => `migrations/${name}`),
      detail: { count: migrations.length }
    });
  }

  const externalFacts = [
    ['live_pages_served_commit', 'Requires a dated network fetch of the public deployment sentinel.'],
    ['github_pages_environment_protection', 'Repository code cannot read environment reviewers or protection settings.'],
    ['netlify_site_configuration', 'Repository code cannot prove the current linked site, function deployment, or environment values.'],
    ['live_social_database_schema', 'Repository migrations do not prove the production database has applied them.'],
    ['database_backup_and_restore', 'No dated disposable backup and restore receipt is present.'],
    ['rollback_drill', 'No dated deployment or schema rollback exercise is present.'],
    ['production_rate_limits', 'No live endpoint rate-limit observation is present.'],
    ['secret_values_and_rotation', 'Secret names may be referenced, but values and rotation state are intentionally unavailable.'],
    ['self_hosted_maker_runner', 'Repository workflow support does not prove a runner or model server is registered and online.'],
    ['production_cookie_behavior', 'Static contracts do not prove browser cookie behavior on the deployed origin.']
  ].map(([id, reason]) => ({ id, status: 'unknown', source: 'external', reason }));

  const verified = repositoryFacts.filter(item => item.status === 'verified');
  const stale = repositoryFacts.filter(item => item.status === 'stale');

  return {
    schema: 'sideways-operations-reality/v1',
    repository: process.env.GITHUB_REPOSITORY || 'Pokitomas/theawesomehexapp',
    checked_head_sha: checkedHead(root),
    observed_at: observedAt,
    status: stale.length ? 'failed' : externalFacts.length ? 'partial' : 'verified',
    verified,
    unknown: externalFacts,
    stale
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = inspectOperationsReality();
  const output = process.env.OPERATIONS_REALITY_RECEIPT;
  if (output) writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (report.stale.length) process.exitCode = 1;
}
