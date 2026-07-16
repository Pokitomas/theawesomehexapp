# Archie derivational runtime carrier

This branch is a transparent source carrier only. Never merge or deploy this branch.

## Exact source patch

Concatenate these files in lexical order:

```bash
cat .maker/archie-derivation.patch.part.{00..13} > /tmp/archie-derivation.patch
```

Required SHA-256:

```text
0f73f00b7bddc259bd9e48599934c8e03d8dd1c33640b4d7ef2c2fb44c6ee770
```

The patch changes exactly these 19 production paths:

```text
.github/workflows/pages.yml
.github/workflows/repository-gate.yml
ARCHIE_DERIVATION.md
audit/archie-derivation-benchmark.md
audit/archie-frontier-baseline.md
maker/contracts/archie-derivation.schema.json
maker/contracts/archie-planner.schema.json
maker/index.html
scripts/maker-archie-brain.mjs
scripts/maker-archie-corpus.mjs
scripts/maker-archie-derivation.mjs
scripts/maker-archie-operator.mjs
scripts/maker-archie-planner.mjs
scripts/tests/maker-archie-derivation.test.mjs
scripts/tests/maker-archie-planner.test.mjs
test-harness/archie-derivation-benchmark.mjs
test-harness/archie-frontier-benchmark.mjs
test-harness/lib/schema-validator.mjs
test-harness/schema-contract.test.mjs
```

After applying the patch, replace the production README and package command surface with:

```bash
cp .maker/README.derivational.md README.md
cp .maker/package.derivational.json package.json
```

The reconciled package must preserve the current native Maker bridge:

```text
maker = node scripts/maker-archie-launch.mjs
maker:raw = node scripts/maker.mjs
```

It must also retain the current native Archie test lane and add the derivation, contract, benchmark, and verification commands.

Delete every carrier file before committing the implementation. The implementation PR must contain no `.maker/archie-derivation.patch.part.*`, `.maker/README.derivational.md`, `.maker/package.derivational.json`, or this manifest.

## Required proof

```bash
npm ci --ignore-scripts
npm run test:contracts
npm run test:archie
npm run benchmark:derivation -- --no-write
npm run benchmark:archie
npm run test:maker
npm run test:foundry
npm run test:authority
npm run verify:quality
npm run verify:release
npm run verify:repository
```

Open one non-draft implementation PR to `main`. Do not merge or deploy automatically.
