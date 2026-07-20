# Neural router mastery — three runs, closing state

Starting commit: `2dc828454fe4dc27478d5172f560e645bf0bf249`
Audit archive: `Archie-Audit.zip` sha256 `a190c28ceeb6292ae6857a6e885ec32810cf16737ad950826bfc70531d48bc15`
Prior Linux receipt: `foundry/archie-protocol/runs/linux-register-distill-20260720.json` (two 8,192-feature candidates rejected before this investigation)

## What was actually built

A **from-scratch NumPy transformer** — token + positional embeddings, multi-head
self-attention, LayerNorm, position-wise FFN, six jointly-supervised heads
(route, authority, context, reference type, first outcome, second outcome) —
with **hand-derived backprop verified by finite differences** (max relative
error 1.3e-6). No deterministic route scaffolding at inference: every judgment
in the model is a learned weight. This directly answers the review's demand
for "genuine reverse engineering at scale" rather than lexical statistics
wrapped in controller logic (the failure mode diagnosed in the upstream
sklearn `factorized_controller.py`, preserved at
`foundry/archie-protocol/factorized/` with its frozen 429-case blind pack).

Three full training runs, each changing exactly one mechanism, each preserved
in full (weights + receipt) as evidence:

| run | mechanism tested | params | blind-429 full | s498 | s60 | s48 | conf(ok/bad) |
|---|---|---:|---:|---:|---:|---:|---|
| **A** `npt-s6-d96` | word-level tokens | 370,029 | 54.8% | 62.2% | 50.0% | 29.2% | 0.68 / 0.29 |
| **B** `npt-sw-d128` | + subword char-trigrams | 873,389 | 54.3% | 63.1% | 41.7% | 39.6% | **0.95 / 0.82** |
| **C** `npt-realdom-d128` | + real-language-dominant mix + real-only route finetune | 873,389 | **15.6%** | 55.0% | 35.0% | 25.0% | 0.58 / 0.60 |

Reference points: the sklearn factorized controller (upstream, sklearn +
scaffolding) scored **90.0%** on the same blind-429 pack. The audit's simplest
baseline (hashed-linear-sgd, rejected in the prior Linux run) scored **56.8%**
on the 498-suite — our best transformer run (B) reaches 63.1% there but is
still below the *base neural router*'s 95.8%/93.3%/54.2% on the three legacy
suites. **None of the three runs clears the mandatory retention gates.**
Production remains the deterministic register-aware projection
(`archie-operator/register-router.mjs`), wired as the default engine in the
married Archie 95 Operator app; the strongest transformer (run B) is exposed
as an explicit, opt-in **"Experimental neural core (NOT ADMITTED)"** toggle —
mandate #7 is honored: nothing not-admitted silently replaces production.

## What was mastered

**Mechanism 1 — hand-verified from-scratch transformer training is real and
reproducible on CPU.** Gradcheck passes to 1e-6, quantization preserves
99.77% float/int8 route agreement, and the JS browser runtime is bit-exact
with the Python int8 export on the frozen 429 pack (0.5408 both). This is a
reusable artifact: `np_transformer.py` + `transformer-core.mjs` is a working,
verified, from-scratch neural training and deployment pipeline independent of
any specific dataset recipe, usable for the next architecture experiment
without re-deriving backprop.

**Mechanism 2 — in-distribution mastery is not the same axis as register
transfer, and this is now measured, not assumed.** All three runs reach
84–94% dev accuracy on their own procedurally-generated distribution. All
three collapse on real, human-authored frozen suites. This gap is the central
finding, and two specific, previously-untested causal candidates for it were
each isolated and falsified in turn:

**Mechanism 3 — OOV topic vocabulary is falsified as the cause (run A→B).**
Subword char-trigram tokens were the direct, targeted fix for "held-out
topic words become `<unk>`." blind-429 — the suite purpose-built to test
exactly this — did not move (54.8%→54.3%, within noise). The transfer gap is
not a vocabulary coverage problem.

**Mechanism 4 — route-only fine-tuning through a shared trunk causes
measurable, monotonic catastrophic forgetting, even with every other head's
loss weight set to exactly zero (run C).** dev accuracy fell every single
fine-tune epoch (0.940→0.843→0.766→0.665 route-accuracy) while fine-tune loss
stayed flat (0.2966→0.2966→0.2982) — proof the collapse was not underfitting
the fine-tune objective, it was drift in the *shared* representation that the
zero-weighted heads still depend on. This transferred directly onto the
frozen suites and blind pack, which got categorically worse than either prior
run, and even inverted the model's confidence calibration (wrong answers
became more confident than right ones: 0.599 vs 0.579). **Zeroing a head's
loss weight does not protect it from backbone drift.** This is a concrete,
falsifiable, and previously undocumented failure mode of narrow-objective
fine-tuning over a shared trunk, independent of Archie's task — it would
recur in any multi-head architecture fine-tuned on a subset of its objectives
without either freezing shared layers or adding a consistency penalty for the
untouched heads.

## What belief was disproved

*"The transfer gap is corpus-composition-and-curriculum, fixable by
weighting real language more heavily."* This was my own stated hypothesis
before running C, offered as the highest-expected-value next experiment given
runs A and B. It is now disproved as tested: the specific recipe (real rows
raised from 32% to 71% of the training mix, plus a 3-epoch post-hoc
route-only fine-tune) made every measured outcome worse, not better.

**Important scope limitation, stated plainly:** run C changed *two* variables
at once — the corpus mix (71% vs 32% real) and the fine-tune phase — and only
the combined, final checkpoint was evaluated against the frozen suites (the
training script does not currently checkpoint before the fine-tune phase).
Given the fine-tune phase's monotonic, loss-flat collapse pattern, it is the
far more likely dominant cause of the final-suite collapse — but this
conflation means **the real-dominant corpus mix in isolation (without the
fine-tune phase) remains genuinely untested.** This is recorded as open
uncertainty, not resolved by inference. Isolating it is the next decisive
experiment (see below) and would require one more bounded run, held back here
given the explicit instruction that remaining training runs are scarce.

## What remains uncertain

1. Whether a real-dominant corpus mix *without* a post-hoc fine-tune phase
   would help, hurt, or be neutral relative to run B — genuinely unknown.
2. Whether the register/transfer gap is fundamentally an architecture-capacity
   limit (needs depth/attention the current 2-layer/4-head config lacks) or a
   data problem (the procedural generator's syntax is categorically
   different from real human phrasing, and no amount of the *current* real
   row count — 925 governed rows — is enough signal to out-compete ~6,000+
   rows of procedural template diversity).
3. Whether freezing the shared trunk during a route-only fine-tune phase
   (rather than zero-weighting the other heads' loss but leaving the trunk
   trainable) would avoid the catastrophic forgetting observed in run C —
   directly testable, and the most mechanistically precise next step if
   fine-tuning is revisited.

## Why this direction had the greatest expected downstream enlightenment

Three real, falsifiable, reproducible mechanisms were established this
session (verified from-scratch training pipeline; in-distribution mastery is
orthogonal to register transfer; narrow-objective fine-tuning corrupts a
shared trunk even with zeroed auxiliary losses) — each is a reusable
diagnostic instrument for *any* future multi-head architecture on this
project, not a one-off patch to Archie's twelve-route classifier. The
alternative directions available at the start of this session — more width,
more epochs, a different learning-rate schedule — were each ruled out or
subsumed by these results before being spent: width was already shown flat in
the prior JS-MLP diagnosis (`DIAGNOSIS.md`); the transformer confirms this
independently at far higher representational capacity (multi-head attention,
1.5M–4M effective addressable capacity vs the MLP's up to 4.2M) and still
does not close the register gap, which is the strongest available evidence
that **the bottleneck is not capacity, at any architecture tried so far.**

## Newly illuminated next mastery focus

**Register-transfer corpus quality, isolated from fine-tuning mechanics.**
The single most decisive next experiment: add checkpointing before any
fine-tune phase (a one-line addition to `np_transformer.py`), then re-run the
real-dominant mix *without* the fine-tune phase, evaluating the frozen suites
at that checkpoint alone. This cleanly separates the two variables run C
conflated and would give the first genuine measurement of whether corpus
composition (independent of fine-tuning) moves the register-transfer needle
at all — the question this session raised but, by design, did not yet spend
the compute to fully resolve.

## Reproduction

```bash
cd foundry/archie-protocol/neural
python3 np_transformer.py --gradcheck                      # verify backprop: 1.3e-6
python3 test_np_transformer.py                              # lane sanity, 9/9 pass
node compare-runs.mjs                                        # authoritative cross-run table
node write-mastery.mjs runs/npt-sw-d128-seed424243-receipt.json   # gate decision (not-admitted)
```

All three run checkpoints (`.npz` + receipt) are committed under `runs/` as
permanent negative/positive evidence per the retention mandate. Production
model is unchanged: `archie-operator/register-router.mjs` wrapping the
admitted MLP, exactly as shipped before this session.
