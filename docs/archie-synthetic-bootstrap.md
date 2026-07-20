# Archie synthetic reasoning bootstrap

Source tree: `main@19723c58ba9db322a39db573c06cc6cf5e737beb`

## Product decision

Archie's proven deterministic local router remains the primary product path. The trained artifact in this lane is retained only as an offline shadow candidate. It is not copied into `archie/`, bundled into the phone product, used to choose live routes, or represented as an admitted model.

That is the strongest current product decision: preserve the simple one-input/one-response local assistant while adding honest neural evidence without weakening routing, authority, or exact-tree guarantees.

## What was actually trained

`foundry/archie-reasoner/synthetic_bootstrap.py` performs real CPU gradient training from random initialization. The student has:

- a UTF-8 byte tokenizer;
- position-aware bidirectional GRU encoding;
- an autoregressive GRU decoder over Archie protocol actions;
- auxiliary route, authority, context, and transform heads;
- 43,706 parameters;
- symmetric per-tensor int8 export.

The committed selected model is `model.int8.json`. Its exact SHA-256 is:

```text
7bd31b5d67c24b5e16d9ef65bb35bf31d918bd5d25a18ef73f0538fc33595f5b
```

Two independent seeds each completed 252 optimizer steps and changed all 27 trainable tensors.

## Data boundary

The corpus is deterministic synthetic supervision generated from the repository's twelve-route Archie protocol. It contains:

- 864 training rows;
- 216 development rows;
- 288 held-out rows;
- explicit allow/deny authority examples;
- ready/missing/ambiguous context examples;
- attachment, memory, thread, and transform markers;
- lexical holdout templates distinct from the core training templates.

No private audit archive, conversation export, or retained user record was available to this execution. None was invented or claimed. The exact split digests are recorded in `tournament-receipt.json` and both per-seed receipts.

## Results

| Seed | Quantized route accuracy | Quantized authority accuracy | Quantized context accuracy | Quantized guarded protocol exact | Selected |
|---:|---:|---:|---:|---:|:---:|
| 3407 | 0.364583 | 0.920139 | 0.875000 | 0.434028 | yes |
| 20260720 | 0.378472 | 0.920139 | 0.871528 | 0.427083 | no |

Seed 3407 wins only under the declared plan-generation selection rule: quantized guarded-protocol exact first, then route accuracy, context accuracy, and artifact size. The alternative seed routes slightly better but generates the exact guarded action sequence less often.

## Admission decision

The candidate is rejected for product admission.

The lane requires at least 0.80 route accuracy and 0.80 guarded-protocol exact before further admission review. The selected quantized candidate reaches 0.364583 and 0.434028. It also has only synthetic supervision and no untouched real-corpus evaluation.

The resulting state is therefore:

```text
real training: yes
changed tensors: yes
quantized artifact: yes
candidate preserved: yes
primary product router: unchanged
production admission: denied
promotion: not-admitted
```

## Preserved negative evidence

`experiment-ledger.json` records three compute-window expirations, the failed four-epoch two-seed run, an intermediate rejected candidate, the selected shadow candidate, and the non-selected comparison seed. A timeout or weak candidate is not rewritten as progress.

## Reproduce

From the repository root with Python, NumPy, and PyTorch installed:

```bash
python foundry/archie-reasoner/synthetic_bootstrap.py \
  --output .local/archie-synthetic-bootstrap \
  --seeds 3407,20260720 \
  --epochs 18
```

This regenerates data from seed `20260720`, trains both candidates, exports int8 artifacts, and emits full receipts. Floating-point byte identity can vary across PyTorch builds and hardware; dataset identities, configuration, seeds, gradient steps, metrics, and produced artifact digests remain explicit in each run receipt.

## Next valid neural step

A future lane may train the merged generative reasoner on an explicitly supplied real audit corpus. It must remove frozen prompt bytes before tokenizer fitting and training, preserve a truly untouched evaluation pack, compare against the current deterministic router, prove authority and clarification behavior, and retain `promotion:not-admitted` unless every admission gate passes.
