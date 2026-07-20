# Archie typed recurrent controller

## Decision

Use a bounded recurrent controller as the next trained Archie candidate. Keep the deterministic authority and admission microkernel outside the model, but stop treating request text, attachments, memory, and thread context as one flat token stream.

The controller is research-only. It is installed only by `foundry/archie-protocol/train-kimi-reasoner.py`; admitted product files and deployment identity remain unchanged until the complete frozen runtime gate passes.

## Why the previous model plateaued

The remaining failures are not mainly missing route vocabulary. They cluster around three structural errors:

1. payload text leaks into authority decisions;
2. missing and ambiguous references are not represented as first-class states;
3. memory or thread content can dominate the requested operation instead of resolving its referenced target.

Appending `<MEMORY>` or `<THREAD>` to one encoder stream marks provenance but does not prevent bidirectional hidden-state leakage. A shared pooled vector also lets every auxiliary head read every feature. Thresholds cannot reliably recover isolation after that mixing has happened.

## Architecture

### Explicit source state

Every example serializes all four channels, even when absent:

```text
<REQUEST> apply my saved condition to the checklist
<ATTACHMENT> <ABSENT>
<MEMORY> <PRESENT> verified completion condition ...
<THREAD> <ABSENT>
```

`<ABSENT>` and `<PRESENT>` are tokenizer symbols, not inferred from an omitted marker.

### Hard segment isolation

Request, attachment, memory, and thread tokens pass through the same recurrent encoder weights in four separate masked executions. Content from one segment cannot alter another segment's hidden states.

This provides a testable invariant:

> Holding the request fixed while changing only attachment, memory, or thread payload bytes must leave authority logits exactly unchanged.

### Block-sparse lanes

The controller state contains four non-overlapping lanes:

- route lane;
- authority lane;
- context lane;
- transform lane.

Each lane has its own recurrent cell, halting distribution, normalization, and output head. No global normalization or shared halting score is allowed because either would reintroduce cross-lane influence.

The authority lane observes request state only. The context lane observes explicit segment presence and payload states. The route lane may consume contextual payloads only through request-conditioned gates initialized toward closed. This makes context earn influence when the request actually refers to it.

### Bounded internal reasoning

Each lane performs four shared-weight recurrent updates. A learned per-lane halting distribution combines the intermediate states. This adds iterative test-time computation while preserving a fixed latency and memory ceiling.

The existing autoregressive typed task-graph decoder remains downstream. Kimi-verified clause, operation, target, compound, and ordered-outcome fields remain generation supervision rather than direct runtime authority.

## Training and evaluation contract

The controller may train on the existing non-frozen corpus plus accepted Kimi augmentations. The post-freeze evaluation pack must be supplied only through `--frozen`; its prompts are removed before tokenizer fitting, train/dev splitting, and training.

Promotion still requires all of the following:

- exact legacy retention;
- untouched semantic and structural capability packs;
- authority benign/unsafe separation;
- attachment, memory, and thread present/missing behavior;
- ambiguous versus missing abstention state;
- quantized runtime parity;
- JavaScript integration parity;
- unchanged deterministic admission and execution controls.

A higher development score is not admission evidence.

## Expected falsification

This experiment is useful even if it fails. It tests whether architectural isolation plus bounded recurrent computation can turn learnable context and authority judgments into transferable behavior. Failure with clean source-grouped supervision would be evidence that the remaining bottleneck is corpus support or ontology, not merely feature leakage.
