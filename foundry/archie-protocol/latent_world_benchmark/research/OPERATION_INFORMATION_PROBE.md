# Operation information probe

This successor diagnostic is owned by Linear `POK-185` and GitHub issue `#715`.
It does not modify, retrain, or replace the verified terminal winner from run
`29867827958`.

## Question

The historical factorized winner reports perfect corrected terminal state on the
canonical frozen suite but `operation_accuracy = 0.0` on intervention diversity.
That suite uses held-out operation labels `9` and `10`, while ordinary training
and frozen suites use labels `0` through `8`. The existing router is an 11-way
closed-set classifier over typed primitive and flag inputs.

The probe therefore separates two questions:

1. Does the existing router recover held-out labels? The immutable answer remains
   zero on the verified artifact.
2. Do the learned terminal hidden features preserve the compositional primitive
   and flag signature well enough for a factorized operation head?

A frozen multi-label linear probe predicts the primitive-plus-flag signature from
`concat(post-step hidden, hidden delta)`. The historical model remains frozen and
its state dictionary is hashed before and after the diagnostic.

## Run contract

From the materialized benchmark root:

```bash
PYTHONPATH=. python3 research/operation_information_probe.py \
  --campaign-root /evidence/archie-causal-mechanism-maximal-29834460894 \
  --checkpoint /evidence/terminal/factorized_w36_lr1e3__seed30260721.pt \
  --checkpoint-sha256 63e57e657121b653017213a19ddf4b2803a33aa6d4f0f0a6a1086ab62199b937 \
  --checkpoint /evidence/terminal/factorized_w36_lr1e3__seed30360724.pt \
  --checkpoint-sha256 458ae00a900aed22c5d95b023b2d4b87e8554ea5be7c03b4f271db124d4f2c29 \
  --output artifacts/operation-information-probe \
  --scale base
```

The command writes probe checkpoints with optimizer state, an evidence report,
and `SHA256SUMS`. Promotion is always `research-only-not-admitted`.

## Decision rule

- Mean intervention exact-signature accuracy at least `0.80` and bit accuracy at
  least `0.95`: permit a separate factorized/compositional operation-head
  experiment.
- Otherwise: classify the learned representation as operation-insufficient and
  stop head-only work.

This is a diagnostic gate, not an admission gate. It must not trigger
`archie-terminal-efficiency-v3` or mutate PR `#697`.
