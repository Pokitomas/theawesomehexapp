# Archie Evidence Kernel

This repository has been retired to its empirically supported core.

The previous live tree mixed model research, product surfaces, sample applications, compatibility layers, generated authority machinery, duplicate runtimes, and historical experiments. Those files remain recoverable in Git history and archival pull requests, but they no longer occupy the working repository.

Deletion from the live tree is not deletion of evidence. The retirement ancestry joins the exact three-PR stack and replaces its working tree with one narrow research kernel.

## Authoritative stack

| Lane | Pull request | Bound head | Authority | Merge state |
|---|---:|---|---|---|
| Exact baseline and fixed evaluation | #736 | `29146af157abecd7e1fc29cee9bf1b1377cd1654` | Exact historical source, tokenizer/corpus compatibility, lineage capsule, owner-local input attestation command, and fixed-evaluation contract; manifests remain unsealed | Blocked |
| Exact-source linked recurrence | #738 | `1ecf72bbb9563ebf1bfc815674a3c1f414e670b5` | Checkpoint-compatible recurrent mechanics and owner-local full/incremental parity command | Blocked |
| Event Clock authorization | #740 | `b6950c35c41448a0ca50e0bd268302949113e546` | Preregistration and fail-closed authorization only | Gate-only |

The bound baseline identities are:

```text
training source head   75cad4277393ebe00a9dfc45202b2e52c826b6b3
source core git blob   42bff377e4ff8d05fec7f0c4ef0ed579e2900b3c
model export sha256    e2b829c86b1be730b8aef7617edd3b62dd819fe5bad41673e6dd284950378ded
```

## What exists

- The byte-identical historical `archie_hybrid_core.py`.
- Native `archie-u16-token-corpus/v2` loading with explicit legacy-v1 compatibility.
- An executable lineage capsule that verifies source identity, export identity, normalized configuration, and configuration digest.
- Owner-local input attestation and fixed-window evaluation commands.
- Checkpoint-compatible SSM and local-attention recurrence with explicit state, reset, transplant, shuffle, and TBPTT controls.
- An owner-local command that compares real-checkpoint full and incremental logits and emits a fail-closed parity receipt.
- A preregistered 20M–30M Event Clock candidate gate.

## What does not exist

- No admitted general Archie model.
- No repository-bundled `e2b829c8…` checkpoint.
- No sealed nine-domain fixed evaluation.
- No produced real-checkpoint recurrence parity receipt or positive recurrence result.
- No Event Clock implementation or weights.
- No 2B authorization.
- No product-runtime capability claim.

## Live tree

```text
MODEL_REGISTRY.json
README.md
eval/                         fixed-domain blockers and manifest contract
foundry/archie-distill/       exact baseline, evaluation, and recurrence
maker/evaluations/            recurrence preregistration
research/event_clock/         Event Clock protocol and authorization gate
scripts/verify-model-registry.mjs
.github/workflows/verify.yml
```

Anything absent from this map is historical, not silently authoritative.

## Structural verification

The repository CI deliberately proves contracts rather than pretending to execute missing owner-local artifacts.

```bash
node scripts/verify-model-registry.mjs
python -m py_compile foundry/archie-distill/*.py research/event_clock/*.py
python research/event_clock/test_gate.py
```

With PyTorch and NumPy available, run the mechanics tests:

```bash
python -m unittest discover -s foundry/archie-distill -p 'test_archie_*.py'
```

These tests prove code mechanics. They do not prove checkpoint capability.

## Owner-local evidence

Input attestation:

```bash
python foundry/archie-distill/archie_fixed_eval.py attest \
  --model /exact/path/archie-lm-114m-v1.pt \
  --corpus /exact/path/development.u16 \
  --output /exact/path/archie-fixed-eval-input-receipt.json \
  --device cuda
```

Exact-checkpoint recurrence parity:

```bash
python foundry/archie-distill/archie_recurrent_parity.py \
  --model /exact/path/archie-lm-114m-v1.pt \
  --corpus /exact/path/development.u16 \
  --offset 100000 \
  --length 512 \
  --tolerance 0.0001 \
  --output /exact/path/archie-recurrent-parity-receipt.json \
  --device cuda
```

Fixed evaluation remains blocked until all nine manifests are operator-sealed against the exact corpus.

## Merge authority

1. Do not merge the baseline lane until the real input receipt exists and all nine manifests are sealed.
2. Do not merge the recurrence lane until real `e2b829c8…` parity passes and matched carried/reset/transplant/shuffle evidence exists.
3. Do not implement Event Clock until the recurrence report clears every preregistered threshold for at least three distinct seeds.
4. Do not translate code readiness into model capability.
5. Do not restore retired subsystems into this repository without a separately bounded artifact, owner, test surface, and evidence claim.

The repository is now a model-evidence kernel, not a portfolio of mutually competing Archie definitions.
