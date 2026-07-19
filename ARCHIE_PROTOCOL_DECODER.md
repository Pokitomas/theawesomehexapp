# Archie Sprawl protocol decoder

This module executes the two most concrete Next Steps from the **Archie Sprawl:
Constraint-Preserving Local Intelligence** report:

1. *"Train a compact decoder over OBSERVE, RETRIEVE, ASK, DECOMPOSE, ORDER,
   COMPARE, DRAFT, SCHEDULE, VERIFY, and STOP."*
2. *"Promote the seven failures into paired contrastive cases for negation
   scope, relation words, and mixed-intent boundaries."*

It is a **real, from-scratch, gradient-checked** training run in pure Node — no
PyTorch, ONNX, GPU, or external model. It makes **no** admission, production, or
general-competence claim. The report's own boundary is preserved: the decoder is
a constrained control artifact, not a general generator.

## What it is

A tiny autoregressive decoder that maps a natural-language task prompt to an
ordered *protocol*: a sequence of the ten opcodes ending in `STOP`.

- **Encoder** — a bag of word unigram + adjacent-bigram features (built from the
  training split only) projected through `tanh` to a hidden state.
- **Decoder** — a shared per-step MLP that predicts the next opcode from the
  prompt state, the previous opcode embedding, and the position.
- **Constrained decoding** — at every step the opcode logits are masked by an
  explicit grammar (`protocol-grammar.mjs`). Every emitted protocol is therefore
  **syntactically valid by construction**, satisfying the report's *"100%
  protocol syntax"* release requirement regardless of model quality.

Backpropagation is hand-coded and verified against finite differences in the
test suite (`max relative gradient error < 1e-4`).

## The grammar (why syntax is always 100%)

- opens with an intake opcode (`OBSERVE` or `RETRIEVE`);
- each non-`STOP` opcode appears at most once and never immediately repeats;
- `STOP` is the sole terminator; length is bounded to `[2, 6]`, with `STOP`
  forced at the cap.

Because illegal opcodes are masked to `-inf` before the arg-max, a badly trained
model still emits a *valid* protocol — it just emits the *wrong* one. Syntax and
correctness are measured separately, on purpose.

## The designed intent → protocol targets

The protocol for each intent is a **designed** target (the report calls for "a
protocol graph, not unconstrained prose"). The learned question is whether the
decoder can recover the correct protocol from prompt text alone, including on
the hard slice.

| intent | protocol |
| --- | --- |
| message | OBSERVE · DRAFT · STOP |
| objective | OBSERVE · DRAFT · VERIFY · STOP |
| next_action | OBSERVE · DECOMPOSE · STOP |
| decision | OBSERVE · COMPARE · DRAFT · STOP |
| checklist | OBSERVE · DECOMPOSE · DRAFT · STOP |
| plan | RETRIEVE · DECOMPOSE · ORDER · DRAFT · STOP |
| event | OBSERVE · SCHEDULE · DRAFT · STOP |
| errands | OBSERVE · ORDER · SCHEDULE · STOP |
| compound | OBSERVE · DECOMPOSE · ORDER · SCHEDULE · STOP |

## Hard-margin contrastive slice (Next Step #2)

The seven documented failures are promoted into paired contrastive cases on a
negation-scope, relation-word, or mixed-intent boundary. The **foil** of each
pair (the near-neighbour with the opposite correct intent) is added to training;
the exact failing prompt is held out of training entirely and evaluated as the
hard-margin slice. Bigram features give the model a limited handle on negation
scope (`not_a`, `rather_than`) that a pure unigram bag cannot represent.

## Train / development discipline

The split is **group-disjoint**: one whole surface family per intent is held out
for development, so no family straddles the split (matching the group-wise
holdout rule in `ARCHIE_TRAINING.md`). Development results are diagnostic and are
**not** promotion-eligible; the hard-margin slice is never trained.

## Acceptance gates

Declared before measurement, and **local to this decoder** — deliberately
distinct from the frozen router's route-accuracy figures in the report:

| gate | required |
| --- | --- |
| protocol syntax valid | 1.00 (by construction) |
| held-out exact match | ≥ 0.85 |
| hard-margin exact match | ≥ 0.75 |

The receipt records the measured value and a truthful pass/fail for each gate.
`promotion` is `not-admitted` regardless of the gate outcome.

## Run it

```bash
npm run archie:protocol:train
# or with explicit hyperparameters:
node foundry/archie-protocol/train-protocol-decoder.mjs --epochs 700 --seed 1234
```

The run writes a digest-addressed receipt to
`foundry/archie-protocol/runs/protocol-decoder-receipt.json` with the full loss
history, per-example decoded protocols for the development and hard-margin
slices, the gate table, and an explicit claim boundary.

## Tests

```bash
npm run test:archie:protocol
```

Covers: opcode vocabulary, grammar validity under random logits, the
finite-difference gradient check, deterministic training, hard-slice isolation,
and receipt shape.

## What this is not

- not a general or autoregressive text generator;
- not the frozen intent router (a separate, larger model in the report);
- not application execution or physical sensing;
- not admitted — a checkpoint still requires independent hidden evaluation and
  the existing admission gates.
