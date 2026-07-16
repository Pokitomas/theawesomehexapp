# Archie Generation One campaign foundation

This tranche adds the deterministic constitution and manifest layer for the Archie Generation One discovery campaign. It does not dispatch workers, evaluate candidates, transfer credits, or promote production.

## Create the campaign

```text
npm run archie -- research create archie-generation-one \
  --base-sha "$(git rev-parse HEAD)" \
  --credits 100 \
  --evaluation-reserve 20 \
  --allocation research/archie-generation-one-allocation.json
```

Creation validates exactly twelve discovery lanes totaling 80 credits and a fixed 20-credit independent-evaluation reserve. It writes canonical, digest-bound artifacts under `.archie/campaigns/archie-generation-one`:

- `allocation.json`
- `campaign.json`
- `creation-receipt.json`

The campaign freezes the base SHA, a digest of the Archie CLI/campaign implementation, the constitutional policy version, and the expected hidden split algorithm, holdout rate, and salt digest. Repeating creation with identical inputs is byte-stable and idempotent. Existing drifted artifacts are never overwritten.

## Prepare and bind data

Use the existing student foundry with the constitutionally fixed split:

```text
node scripts/archie-student-foundry.mjs prepare \
  --corpus-root "$HOME/.archie/corpus" \
  --output-dir ".archie/campaigns/archie-generation-one/data" \
  --holdout-rate 0.20 \
  --split-salt "archie-generation-one-hidden-v1"
```

Then materialize the campaign:

```text
npm run archie -- research materialize \
  --campaign archie-generation-one \
  --output .archie/campaigns/archie-generation-one/lanes
```

Materialization verifies the student-pack manifest digest and the exact bytes, row counts, and digests of all four partitions. It rejects a changed base SHA, changed campaign code, altered allocation, substituted split salt/rate/algorithm, or mutated data file.

Successful materialization writes:

- `campaign-bound.json`
- twelve `archie-research-lane/v1` discovery manifests
- `independent-evaluation.json`
- `manifest-index.json`

No compute worker is required. Worker availability cannot change lane priority or transfer credits. Discovery lane manifests bind the hidden-data digest without granting hidden content access; only the independent-evaluation manifest receives judge-only hidden access.

## Inspect status

```text
npm run archie -- research status --campaign archie-generation-one
```

This tranche intentionally provides a non-watching status command. It re-verifies campaign, allocation, code/base, data, index, and every lane digest before reporting either `awaiting-data` or `materialized`. `--watch` fails closed until the later scheduler tranche owns a real watcher.

## Authority boundary

Candidates cannot write production, promote themselves, alter allocation from worker availability, or combine owner preference with capability scoring. Promotion remains an explicit later command gated by independent evaluation and exact-tree evidence.
