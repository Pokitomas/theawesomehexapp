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
  if (!existsSync(absolutePath)) return { id, status: 'stale', evidence: [relativePath], reason: 'required repository artifact is missing' };
  const content = readFileSync(absolutePath, 'utf8');
  const missing = patterns.filter(pattern => !content.includes(pattern));
  if (missing.length) return { id, status: 'stale', evidence: [relativePath], reason: `required contract markers are missing: ${missing.join(', ')}` };
  return { id, status: 'verified', evidence: [relativePath] };
}

const externalProcedure = (id, reason, authority, command) => ({
  id,
  status: 'unknown',
  source: 'external',
  reason,
  authority,
  procedure: {
    command,
    prerequisites: ['redacted dated snapshot', 'exact authorized commit SHA', 'named human authority'],
    stop_conditions: ['secret-bearing evidence', 'commit mismatch', 'production database target', 'missing rollback or restore witness']
  }
});

export function inspectOperationsReality({ root = defaultRoot, observedAt = new Date().toISOString() } = {}) {
  const migrationsDir = path.join(root, 'migrations');
  const migrations = existsSync(migrationsDir) ? readdirSync(migrationsDir).filter(name => /^\d+_.+\.sql$/.test(name)).sort() : [];
  const repositoryFacts = [
    inspectFile(root, 'pages_workflow_least_privilege', '.github/workflows/pages.yml', ['permissions:\n  contents: read', 'pages: write', 'id-token: write', 'issues: write', 'persist-credentials: false']),
    inspectFile(root, 'pages_exact_commit_verification', '.github/workflows/pages.yml', ['actions/deploy-pages@', 'Verify deployed commit identity', 'deployment-receipt.cjs verify-live', 'Upsert successful deployment receipt']),
    inspectFile(root, 'deployment_sentinel_contract', 'scripts/deployment-receipt.cjs', ['write-sentinel', 'verify-live', 'sideways-deployment.json']),
    inspectFile(root, 'relational_schema_bootstrap', 'netlify/functions/social-entrypoint-core.mjs', ['ensureSocialSchema', 'schemaReady ||=', 'Social database schema is unavailable.']),
    inspectFile(root, 'relational_migration_runner', 'netlify/functions/social-postgres-migrations.mjs', ['social_schema_migrations', 'pg_advisory']),
    inspectFile(root, 'whole_repository_verification', 'scripts/verify-repository.mjs', ['audit/repository-verification.json', 'checked_head_sha', 'candidate_head_sha']),
    inspectFile(root, 'safe_operations_probe', 'scripts/operations-probe.mjs', ['read_only_default', 'Production database targets are forbidden', '--accept-disposable-database', '--allow-network']),
    inspectFile(root, 'operator_runbook', 'OPERATIONS_RUNBOOK.md', ['Static release', 'Relational activation', 'Disposable database proof', 'Incident and rollback'])
  ];
  if (migrations.length < 2) repositoryFacts.push({ id: 'ordered_social_migrations', status: 'stale', evidence: ['migrations/'], reason: `expected at least two ordered migrations, found ${migrations.length}` });
  else repositoryFacts.push({ id: 'ordered_social_migrations', status: 'verified', evidence: migrations.map(name => `migrations/${name}`), detail: { count: migrations.length } });

  const externalFacts = [
    externalProcedure('live_pages_served_commit', 'Requires a dated network fetch of the public deployment sentinel.', 'release authority', 'node scripts/operations-probe.mjs --snapshot evidence/operations.json --expected-sha "$SHA" --endpoint "$PUBLIC_URL" --allow-network'),
    externalProcedure('github_pages_environment_protection', 'Repository code cannot read current environment reviewers or protection settings.', 'repository administrator', 'gh api repos/$GITHUB_REPOSITORY/environments/github-pages > evidence/github-pages-environment.redacted.json'),
    externalProcedure('netlify_site_configuration', 'Repository code cannot prove the currently linked site, function deployment, or environment values.', 'hosting administrator', 'netlify status && netlify env:list --plain | sed "s/=.*$/=<redacted>/"'),
    externalProcedure('live_social_database_schema', 'Repository migrations do not prove the deployed database has applied them.', 'database authority', 'psql "$DISPOSABLE_DATABASE_URL" -v ON_ERROR_STOP=1 -c "select version from social_schema_migrations order by version"'),
    externalProcedure('database_backup_and_restore', 'Requires a dated disposable migration, backup, restore, and comparison receipt.', 'database authority', 'node scripts/operations-probe.mjs --snapshot evidence/operations.json --expected-sha "$SHA" --accept-disposable-database'),
    externalProcedure('rollback_drill', 'Requires a dated release and schema rollback exercise.', 'release authority', 'Follow OPERATIONS_RUNBOOK.md section "Incident and rollback" on a disposable target and capture redacted digests.'),
    externalProcedure('production_rate_limits', 'A safe read-only probe intentionally does not hammer a live endpoint.', 'hosting administrator', 'Run the provider-approved disposable rate-limit probe from OPERATIONS_RUNBOOK.md; never load-test production.'),
    externalProcedure('secret_values_and_rotation', 'Secret values are intentionally forbidden from evidence; only names, grants, and rotation dates may be recorded.', 'security authority', 'Capture secret names and last-rotated dates only; redact every value before probe input.'),
    externalProcedure('self_hosted_maker_runner', 'Workflow support does not prove a runner or model server is registered and online.', 'repository administrator', 'gh api repos/$GITHUB_REPOSITORY/actions/runners > evidence/runners.redacted.json'),
    externalProcedure('production_cookie_behavior', 'Static contracts do not prove browser cookie behavior on the deployed origin.', 'release authority', 'Use browser devtools on the deployed origin and record only cookie attributes, never cookie values.')
  ];

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
    stale,
    admission_rule: 'Repository evidence and deterministic procedures cannot convert an external fact to verified without a dated redacted snapshot bound to the exact authorized commit.'
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = inspectOperationsReality();
  const output = process.env.OPERATIONS_REALITY_RECEIPT;
  if (output) writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  if (report.stale.length) process.exitCode = 1;
}
