# POK-47 native implementation handoff

This branch is owned directly from the active ChatGPT engineering session. Hosted Linear coding sessions are disabled for this ticket to prevent duplicate work.

## Implemented behavior

- compatibility-preserving extraction of shared Archie CLI argument and JSON-output helpers;
- `archie research create`, `archie research materialize`, and non-watching `archie research status` routing;
- exact Generation One allocation with twelve discovery lanes totaling 80 credits plus an immutable 20-credit independent-evaluation reserve;
- deterministic campaign, allocation, creation receipt, bound campaign, lane, and materialization digests;
- hidden student-pack split binding by salt digest, holdout rate, algorithm, manifest digest, exact file bytes, file digests, and row counts;
- worker-free materialization of twelve discovery manifests plus one independent-evaluation manifest;
- fail-closed base SHA, code digest, allocation, split, and data drift checks;
- owner preference retained as a separate zero-weight axis;
- explicit production-write and self-promotion denial in every lane.

## Validation target

`npm run test:archie` includes `scripts/tests/maker-archie-research-campaign.test.mjs` through the existing `maker-archie-*.test.mjs` glob. The focused file covers deterministic/idempotent creation, exact allocation enforcement, worker-free 12+1 materialization, and drift rejection.

## Remaining work after this checkpoint

1. Run the complete repository test gates on an actual checkout and repair any cross-suite compatibility failures.
2. Review generated JSON contracts against the repository's schema registry or validation conventions and wire them there if required.
3. Publish the exact checkpoint SHA for POK-49 before it adds worker CLI routing.
