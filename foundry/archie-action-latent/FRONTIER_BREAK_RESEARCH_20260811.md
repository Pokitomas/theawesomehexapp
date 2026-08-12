# ARCHIE frontier-break research — 2026-08-11

This note is a research contract, not a claim that ARCHIE is already a novel model.
The goal is to attack the strongest version of the local-frontier prompt by
turning each absolute into a falsifiable mechanism instead of repeating it as a
wish.

## 1. Memory wall: attack data motion, but do not pretend software can become a memristor

A 2025 Nature Computational Science hardware study, *Analog in-memory computing
attention mechanism for fast and energy-efficient large language models*
(Leroux et al.; DOI 10.1038/s43588-025-00854-1; arXiv:2409.19315), implements a
writable analog gain-cell attention memory and reports very large modeled
latency/energy improvements over GPU attention. The same work explicitly deals
with analog non-idealities and cannot directly map an arbitrary pretrained
model without adaptation.

ARCHIE consequence: on the RTX 2060, optimize the *software analogue* of this
idea: minimize bytes moved per useful state transition, keep recurrent state
resident, fuse update/read operations, and make `bytes_moved / predictive_bit`
a first-class court. Do not describe that as literal compute-in-memory.

## 2. "Eliminate floating point" is the wrong abstraction

The useful target is not a religious ban on floats. It is a representation
whose algebra matches the invariants we need while minimizing movement,
precision, and repair cost. Monomial carriers are interesting because exact
permutation/sign/power-of-two transformations have cheap inverses and do not
accumulate ordinary multiply-add drift. They remain a hypothesis until a
matched learned baseline wins on prediction/generalization or state cost.

Next court: compare learned dense, low-rank, monomial, and mixed operator banks
under equal state bytes and equal transition budget. Measure predictive error,
inverse error, update FLOPs, state bytes, and multi-seed stability. Promotion is
Pareto, not aesthetic.

## 3. Zero hallucination: verify *claims*, not every token

Formal verification is powerful only inside a formalized domain. Recent work
continues to show that generating formally accepted proofs is difficult rather
than solved: FormalProofBench (arXiv:2603.26996) evaluates graduate-level Lean 4
proof production and reports the strongest evaluated foundation model at 33.5%
accuracy. This is evidence for an external checker boundary, not evidence that
every open-world sentence can be made theorem-like.

ARCHIE consequence: language is a lossy projection. Internally represent
candidate claims with provenance and type:

- `formal`: must carry a checker receipt before promotion;
- `observed`: must carry a sensor/backend receipt;
- `empirical`: must carry a court/result lineage;
- `hypothesis`: may be emitted, but cannot masquerade as any of the above.

The semantic adapter may remain probabilistic. The *promotion boundary* must be
mechanical. This is more useful than forcing every connective word through an
axiom checker.

## 4. Infinite context: break the impossible statement first

For a finite B-bit resident state there are at most 2^B distinguishable states.
An arbitrary binary history of length L has 2^L possibilities. For L>B, a
lossless injective map of every history into the resident state is impossible.
`information_budget_court.py` turns that counting fact into an executable
collision/retrieval witness and keeps a positive control: finite sufficient
statistics can summarize an arbitrarily long stream exactly for the queries
they are sufficient for.

This does not kill recurrent memory. ARMT work (Rodkin et al., arXiv:2407.04841;
Kuzmin et al., arXiv:2607.11614) demonstrates that associative recurrent memory
can process very long contexts with constant resident memory on selected tasks.
The correct research target is therefore **task-sufficient resident state**, not
"zero-loss arbitrary history in one fixed vector."

`surprise_residual_memory.py` adds the exact escape hatch: bounded predictive
state plus append-only surprise residuals. Structured streams can have sparse
residual growth; random streams correctly consume near-linear exterior storage.
The system preserves truth instead of silently forgetting and hallucinating.

## Candidate architecture: dynamical interior, episodic exterior, checked projection

```
sensor/action transition
        |
        v
bounded dynamical interior  <---- learned consequence operators
        |  prediction
        +---- expected -----> consolidate/update resident state
        |
        +---- surprise -----> exact residual / episodic exterior
                                  |
query ----------------------------+---- content-addressed retrieval
        |
        v
claim graph + provenance
        |
        +---- formal verifier / empirical court / backend receipt
        |
        v
language / code / GUI adapters
```

The local LLM is currently an adapter/scaffold. The research succeeds only if a
sub-language state system earns measurable capability that would survive
replacing the decoder.

## Promotion courts

1. **Memory truth:** exact replay/retrieval versus resident-state bytes and
   exterior residual bytes over predictable, shifting, adversarial, and random
   streams.
2. **Action semantics:** latent action code must predict held-out consequences
   better than matched surface-label and random-code controls over >=5 seeds.
3. **Operator algebra:** compare dense/low-rank/monomial/mixed banks under equal
   byte and update budgets; no promotion from exact inverses alone.
4. **Belief revision:** treatment/control causal traces must show that fresh
   anomaly evidence changes recovery selection on held-out incident lineages.
5. **Grounded output:** formal/observed/empirical claims must fail closed when
   their proof source disappears or contradicts them.
6. **Foreground coexistence:** all research/training courts run while terminal
   semantic TTFT, barge-in cancellation, and presence epochs remain inside their
   measured latency envelope.
7. **Hardware direction:** profile bytes moved, cache misses, kernel launches,
   and achieved memory bandwidth before inventing a new kernel. A claimed FLOP
   reduction that increases data motion is not a win.

## Rule for novelty

A mechanism is novel-for-ARCHIE only after a matched baseline loses on a metric
that matters (capability, exactness, adaptation speed, state bytes, data motion,
latency, or energy proxy) and the result replicates. A new name, algebra, or
composition is not enough.
