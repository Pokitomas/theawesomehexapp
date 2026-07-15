# Sideways Operations Runbook

This runbook separates repository proof from live infrastructure proof. Default procedures are read-only. Never paste secret values into snapshots, receipts, issues, pull requests, or logs. Use named human authorities for release, database, and incident decisions.

## Prerequisites

```bash
export GITHUB_REPOSITORY=Pokitomas/theawesomehexapp
export SHA="$(git rev-parse HEAD)"
node --version                    # Node 20+
npm ci                           # repository lockfile only
npm run verify:repository
npm run verify:operations
```

Stop if the checkout is dirty, `SHA` is not the intended release commit, repository verification fails, or evidence contains a credential-bearing URL or secret value.

## Evidence snapshot

Create a redacted `sideways-operations-snapshot/v1` JSON file outside the repository. It must include a canonical ISO `observed_at`, exact `authorized_commit`, named `release`, `database`, and `incident` authorities, branch/environment/app-grant facts, endpoint facts, database facts, and release/incident procedures. Every verified fact needs dated evidence. Unknown facts use `state: "unknown"` and an empty evidence array.

Validate without network or destructive execution:

```bash
node scripts/operations-probe.mjs \
  --snapshot "$HOME/sideways-evidence/operations.json" \
  --expected-sha "$SHA" \
  --now "2026-07-15T18:00:00.000Z"
```

The command emits one deterministic JSON receipt to stdout. A partial receipt exits 2; invalid or unsafe evidence exits 1.

## Static release

1. Confirm `main` points at the intended exact SHA.
2. Run `npm run verify:repository`.
3. Dispatch or allow the Pages workflow for that SHA.
4. Read the deployed `/sideways-deployment.json` sentinel and compare it to `SHA`:

```bash
export PUBLIC_URL="https://<authorized-host>"
node scripts/operations-probe.mjs \
  --snapshot "$HOME/sideways-evidence/operations.json" \
  --expected-sha "$SHA" \
  --endpoint "$PUBLIC_URL" \
  --allow-network
```

Stop on redirect, non-HTTPS public origin, missing sentinel, function error, or commit mismatch. Do not authorize rollout from a workflow success alone.

Rollback:

```bash
git revert --no-edit <admitted-merge-commit>
git push origin main
```

Then require a new Pages deployment whose sentinel equals the revert commit. Never relabel an old deployment as current.

## Relational activation

Required human authorities: hosting administrator and database authority.

1. Provision a disposable PostgreSQL database first.
2. Set `SOCIAL_DATABASE_URL` and `SOCIAL_SESSION_SECRET` only in the hosting provider secret store.
3. Record names, grants, and rotation dates—not values—in the redacted snapshot.
4. Deploy the function candidate and verify `GET /api/social?op=session` returns JSON without exposing a session value.
5. Verify cookie attributes in browser developer tools: `HttpOnly`, `SameSite=Lax`, `Secure` on HTTPS, and `Path=/`.
6. Exercise 503 behavior only on a disposable function/database pair by temporarily withholding schema access, then restore it.

Stop if a mutation targets production during proof, schema bootstrap is not fail-closed, the function silently falls back to shared Blob state for relational-only operations, or cookie values appear in evidence.

Rollback:

- Restore the previous function deployment.
- Restore the previous secret-name/grant configuration without copying values into evidence.
- Confirm relational-only operations report unavailable rather than simulating success.

## Disposable database proof

Never run the drill against production, primary, live, or a database containing user data.

```bash
export DISPOSABLE_DATABASE_URL="postgres://<redacted-disposable-target>"
# Apply repository migrations to the disposable target.
psql "$DISPOSABLE_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/001_social_postgres.sql
psql "$DISPOSABLE_DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/002_social_communities.sql
# Insert fixture-only data, then create a backup.
pg_dump --format=custom --no-owner --no-acl "$DISPOSABLE_DATABASE_URL" > /tmp/sideways-disposable.dump
# Restore into a second empty disposable database.
pg_restore --exit-on-error --no-owner --no-acl --dbname "$DISPOSABLE_RESTORE_URL" /tmp/sideways-disposable.dump
# Compare schema migration versions and fixture counts; capture digests, not rows.
```

The snapshot must set `database.target_kind` to `disposable`, include `confirmation: "I_USED_A_DISPOSABLE_DATABASE"`, and provide successful dated migration, backup, restore, and rollback witnesses. Then validate:

```bash
node scripts/operations-probe.mjs \
  --snapshot "$HOME/sideways-evidence/operations.json" \
  --expected-sha "$SHA" \
  --accept-disposable-database
```

A backup without a successful restore witness is rejected. Stop if the target name contains `prod`, `production`, `live`, or `primary`; if rollback is missing; or if evidence contains a connection string.

Database rollback:

- Drop the disposable restore target.
- Recreate it empty.
- Reapply the prior migration set.
- Restore the pre-drill dump.
- Verify migration versions and fixture-count digests.

## Branch, environment, and application grants

Repository administrator captures current settings through authenticated provider CLIs, stores them outside the repository, and redacts actor IDs when unnecessary. Required evidence covers protected branches, Pages environment reviewers, deployment branches, GitHub App permissions, Actions runners, Netlify site linkage, and environment-variable names. Unknown remains unknown until the dated snapshot is validated.

## Rate-limit and unavailable behavior

The default endpoint probe never generates load. A hosting administrator may run a provider-approved rate-limit check only against a disposable deployment with a documented request ceiling. Stop before the provider limit, on any production hostname, or when another tenant could be affected. Capture status codes and headers only.

## Incident and rollback

Incident authority declares the incident, freezes mutation, records the currently served sentinel, and selects the last admitted commit. Release authority reverts or redeploys that exact commit. Database authority performs schema rollback only from a proved backup/restore pair. After rollback:

```bash
npm run verify:repository
node scripts/operations-probe.mjs --snapshot "$SNAPSHOT" --expected-sha "$ROLLBACK_SHA" --endpoint "$PUBLIC_URL" --allow-network
```

Stop closure until the live sentinel, function availability, and database migration receipt all bind to the rollback SHA and no secret value entered evidence.
