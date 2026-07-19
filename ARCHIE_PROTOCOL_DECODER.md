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

## Scaled preset (`big`)

`--preset big` trains the same architecture at materially larger capacity:

- boundary-marked character trigrams in addition to word unigrams/bigrams;
- minimum feature count of one and a 320-unit hidden layer (~0.8M parameters,
  roughly 90x the recovered model);
- fewer epochs (220) to keep the bounded CPU budget honest, stronger weight
  decay against the added capacity.

```bash
node foundry/archie-protocol/train-protocol-decoder.mjs --preset big
```

The receipt is written to `runs/protocol-decoder-receipt.big.json` under the
same development gates and the same `promotion: not-admitted` boundary. Extra
parameters must *earn* their keep against those gates; the receipt reports the
truth either way.

## Portable int8 export and the Local Operator app

```bash
node foundry/archie-protocol/export-model.mjs --preset big
```

re-trains deterministically, quantizes `W1`/`W2` per row to int8 with per-row
scales (mirroring the sprawl report's int8 lane), evaluates float vs int8 on
the development and hard slices so the quantization cost is recorded honestly,
and writes `runs/protocol-decoder-model.big.json`.

`archie-operator/` is a dependency-free installable web app (PWA) that runs the
exported int8 weights entirely in the page — no server, no network calls after
load. Copy the export to `archie-operator/model.json` and serve the directory
statically. The app surfaces the receipt evidence (parameters, held-out and
hard-margin exact match, syntax guarantee, model digest) and repeats the claim
boundary: constrained protocol decoding only, `promotion: not-admitted`.
