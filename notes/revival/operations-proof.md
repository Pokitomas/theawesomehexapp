# Operations reality proof

- Parent: #223
- Lane: #230
- Branch: `revival/operations-proof`
- Base: `main@ffcdda7bdcb6d2b7411b6c4965adf8837cb5a86a`
- State: executable repository inventory; external drills still required

## Implemented first beat

`node scripts/operations-reality-report.mjs` emits a dated, machine-readable receipt that separates facts provable from the exact repository tree from facts that remain external and unknown.

The report fails when a required repository contract becomes stale. It currently proves:

- Pages workflow defaults to read-only authority and scopes Pages/OIDC/issues writes to the push-only deploy job;
- checkout credentials are not persisted in deployment-capable jobs;
- Pages deploy verifies the served exact commit before writing the canonical deployment receipt;
- the deployment sentinel helper and contract exist;
- relational social traffic is blocked until ordered schema bootstrap succeeds;
- ordered SQL migrations and the PostgreSQL migration runner exist;
- the whole-repository verifier binds receipts to checked and candidate heads.

It intentionally leaves these as `unknown` without dated external evidence:

- the commit currently served by the public Pages endpoint;
- GitHub Pages environment protection and reviewers;
- linked Netlify site/function/environment configuration;
- production database schema state;
- backup and restore success;
- rollback drills;
- production rate limits;
- secret values and rotation;
- self-hosted Maker runner/model availability;
- deployed-origin cookie behavior.

## Proof commands

```sh
npm run verify:operations
npm run verify:repository
```

The operations suite is part of `audit/repository-verification.json`, so repository admission now fails if repository-visible deployment or migration claims drift.

## Remaining operational work

Run disposable, dated network/database/rollback checks under #230. Do not promote an `unknown` fact to `verified` from repository prose, an old issue receipt, or configuration names alone.

No merge or deployment authority.