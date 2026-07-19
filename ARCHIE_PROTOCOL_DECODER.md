# Archie protocol decoder

This lane trains a small deterministic text classifier that maps one request to one fixed, auditable protocol. It is not a language model and does not generate prose.

## What it does

The decoder recognizes ten narrow request intents and emits only tokens from this grammar:

`OBSERVE RETRIEVE COMPARE DECOMPOSE ORDER SCHEDULE DRAFT STOP`

The output always terminates with `STOP`. Response execution remains separate and must enforce its own permissions.

## Model

- lowercase word unigrams and adjacent bigrams;
- minimum feature count of two;
- one 32-unit `tanh` hidden layer;
- full deterministic JavaScript forward and backward passes;
- cross-entropy training with weight decay and cosine learning-rate decay;
- no external model, API, tokenizer, or dependency.

## Evaluation truth

The original seven hard-margin prompts were inspected during development. They are therefore recorded as `hard-development`, not as an independent admission set. Exact prompt overlap with training is prohibited by regression tests, but semantic adaptation still means these cases cannot establish independent generalization.

`gates_passed` means only that decoder-local development thresholds were crossed. Every receipt remains `promotion: not-admitted` until a separately authored and frozen admission pack is executed without adaptive retraining.

## Run

```bash
node foundry/archie-protocol/train-protocol-decoder.mjs
node --test foundry/archie-protocol/tests/protocol-decoder.test.mjs
```

The receipt is written to `foundry/archie-protocol/runs/protocol-decoder-receipt.json` with deterministic model and receipt digests.
