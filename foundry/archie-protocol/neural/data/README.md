# Neural router training/eval data (committed for reproducibility)

These files were missing from the repository, which meant a fresh session
could not reproduce runs A/B/C/D/E without independently re-deriving them from
`Archie-Audit.zip` — a real execution boundary hit and correctly reported
(rather than guessed around) by a parallel session on this branch
(`ISOLATION_PLAN.md`). Committing the exact bytes closes that gap.

## Files

- **`route-train-v6.json`** (925 rows, sha256 `38d9df9c...`) — the governed
  training corpus: real-language prompts labeled with one of the 12 routes,
  deduplicated and capped per route, deterministically dedup-merged from the
  audit's governed corpus and the repository's authored `protocol-corpus.mjs`.
  Contains no attached-file contents, no filesystem paths, no PII — task
  prompts and route labels only. This is what `--real-rows` in
  `np_transformer.py` consumes.
- **`suite-80.json`** (80 cases, sha256 `e212ec5e...`) — the reconstructed
  head-to-head admission suite used to compare against the Q6 1.7B checkpoint
  (see `foundry/archie-protocol/train-route-model.mjs`'s `--suite` flag).
  Frozen; excluded from all training by normalized exact match.
- **`router-v2-original-heldout.jsonl`** (498 cases, sha256 `188d6733...`),
  **`router-real-v2-heldout.jsonl`** (60 cases, sha256 `72c0d30a...` —
  matches the digest recorded independently in the prior mastery run's
  `exact-baseline-replay.json`, confirming chain of custody),
  **`router-real-v3-final.jsonl`** (48 cases, sha256 `cb9131ea...`) — the
  three frozen legacy suites every candidate in this project is measured
  against. Frozen; excluded from all training by normalized exact match.

## Provenance

Derived from `Archie-Audit.zip` (sha256
`a190c28ceeb6292ae6857a6e885ec32810cf16737ad950826bfc70531d48bc15`), an
external export not itself committed to this repository. These are the exact
files consumed by `foundry/archie-protocol/neural/np_transformer.py --real-rows
... --legacy-dir ...` and `--frozen-pack` for runs A through E documented in
`NEURAL_MASTERY.md`.

## Reproduction

```bash
cd foundry/archie-protocol/neural
python3 np_transformer.py --scale 5 --epochs 10 --d 128 --layers 2 --heads 4 --tmax 84 \
  --lr 2.2e-3 --drop 0.1 --real-rows data/route-train-v6.json --real-repeat 5 \
  --legacy-dir data --tag npt-reproduce
```
