# Archie Reasoner architecture and evaluation

## Purpose

The existing Archie route model chooses one of twelve task modes. The reasoner research lane
adds a learned sequence model that can express an ordered task graph and a final response plan.
It is deliberately above, not a replacement for, the admitted narrow router.

The training target is generated from governed route labels, route protocol templates, optional
attachment/memory/thread context, authority metadata, context state, and transform metadata.
This makes the supervision auditable. It also limits the claim: the model learns a compact plan
language rather than open-ended world knowledge.

## Data boundary

Training input comes from caller-supplied JSON or JSONL. The three audit route suites,
reconstructed suite-80, and any extra `--frozen` packs are normalized into an exact-prompt set.
Matching rows are removed before the train/development split. SentencePiece is trained only on
the remaining training partition, so frozen prompt bytes do not enter vocabulary fitting.

The receipt records counts and digests, not the private audit corpus.

## Architecture

`ArchieReasoner` is a from-scratch PyTorch attentive recurrent sequence model:

- shared token embedding and tied language-model head;
- packed bidirectional-GRU source encoder;
- masked mean-pooled encoder representation;
- attention-conditioned GRU decoder that reuses recurrent state during generation;
- auxiliary route, authority, context, and transform heads;
- greedy sequence decoding for deterministic evaluation.

The full preset is width 256 with four bidirectional encoder and four decoder layers, plus a
768-unit attention-fusion block. The diagnostic and small presets reduce compute; the large preset
tests whether added depth/width changes shared failure modes.

## Objective

The total loss is:

```text
L = 1.00 * generation_ce
  + 0.45 * route_ce
  + 0.25 * authority_ce
  + 0.25 * context_ce
  + 0.10 * transform_ce
```

Generation cross-entropy uses label smoothing. AdamW uses a `3e-4` full-preset learning rate,
warmup, cosine decay, gradient clipping, optional CUDA AMP, and deterministic checkpoint/resume.

## Authority and abstention

Authority and clarification are not conflated:

- `authority=deny` means the system must not proceed;
- `authority=allow, context=missing` means it may ask for required information;
- `authority=allow, context=ambiguous` means it may clarify ambiguity;
- only `authority=allow, context=ready` may produce a non-clarify plan.

The decoder is supervised on this distinction, but generation is not trusted as the sole
safety mechanism. The auxiliary heads are evaluated independently. Denial, missing/ambiguous
context, malformed graph JSON, or a generated abstention forces a canonical clarify graph.

## Calibration

After each epoch, a single positive temperature is fitted on development route logits by
minimizing negative log likelihood. The selected checkpoint stores that scalar. Frozen suites
are evaluated after selection and are never used to fit the temperature or select architecture.

## Metrics

Development and frozen receipts report:

- task-graph parse rate;
- joint graph/plan exact rate;
- route accuracy and per-route counts;
- route negative log likelihood;
- authority accuracy;
- context accuracy;
- response-action accuracy;
- forced-clarify recall;
- bounded error examples.

The TF-IDF baseline provides a lexical route/authority/context/transform floor. It is not
compared as though it could generate task graphs.

## Promotion

Every artifact is `promotion:not-admitted`. A candidate cannot be promoted merely because it
beats another development candidate. Promotion requires a separately authored untouched
admission pack, exact digest verification, quantized/runtime parity where applicable, and a
product integration change outside this research lease.
