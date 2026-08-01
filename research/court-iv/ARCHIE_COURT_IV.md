# ARCHIE Court IV

**Execution of Court III's handoff against the shipped event-semidirect model**

Status: executed locally · stdlib-only · no checkpoint, no corpus, no GPU
Harness: `archie_court_iv.py` → `archie_court_iv_results.json`
Contracts: `test_archie_court_iv.py` (24 tests)
Runtime: 6.4 s

> **Which model this is about.** The subject is the 45.7 M-parameter
> `ArchieEventSemidirectLM` byte model described in
> `ARCHIE_COMPLETE_EVERYTHING_AUDIT.txt`, which lives outside this repository.
> It is **not** the repository's canonical candidate
> (`archie-qwen3-1.7b-information-budgeted-rslora-v1`, see `00-ARCHIE-MODEL/`).
> Nothing here changes that candidate's status.

---

## 0. Verdict

Court III asked the next court to regularize the solver exponent β. Executed
against the *shipped* model, that program is vacuous: **β = 0 structurally, at
every length, for reasons that cannot be trained away.** The shipped event
law is affine in the state, so Court III's own Proposition E applies exactly and
one correction round is sufficient — and in fact zero are needed, because the
associative scan *is* the exact solver.

That is the unification. The Court I–III argument has been about a nonlinear
Lane B and its round economics. The model that actually exists is Lane A only.
It does not have the disease the last three courts were diagnosing.

What it does have is a different and more immediate problem, which no previous
court measured because no previous court looked at the shipped hyperparameters:

> The retention normalizer makes memory and noncommutative transport mutually
> exclusive. The Heisenberg mechanism — the entire architectural novelty — is
> confined to fibers that forget within about two tokens.

And a bounding fact that costs nothing to check and invalidates the window:

> No fiber can span the 512-token training window. The retention ceiling caps
> the slowest fiber at a 500-token 1/e horizon before the gate, the transport,
> or training are considered at all.

| Claim | Court IV | Executed finding |
|---|---|---|
| Composition law is the exact semidirect product | **Confirmed** | associativity defect 4.4e-16 over 400 trials |
| Serial ≡ Hillis–Steele ≡ balanced tree | **Confirmed** | max gap 2.7e-15 over 96 events |
| Retention is a strict contraction | **Confirmed** | ‖qN‖∞ ≤ c·σ(a) < c < 1 over 2000 draws |
| Parameter total is 45,697,024 | **Confirmed** | reconstructs exactly; implies conv bias = False |
| Court III's β program applies here | **Refuted** | β = 0 at T = 64…1024, three seeds |
| β is universal (Court II's 0.61) | **Refuted again** | comparator spans 0.21–0.95 across three seeds |
| Cancellation scalar is a monoid | **Refuted** | 100 % of 1000 trials break associativity |
| Model can use its 512-token window | **Refuted** | structural horizon ceiling is 500 tokens |
| Transport is freely available | **Refuted** | 128-token horizon buys 0.95 % of transport range |

---

## 1. What was verified, exactly

The transition algebra is what the audit says it is. Re-derived and executed:

    F₂(F₁(s)) = q₂N₂(q₁N₁s + w₁) + w₂ = (q₂q₁)(N₂N₁)s + (q₂N₂w₁ + w₂)

with `N₂N₁ = N(x₂+x₁, y₂+y₁, z₂+z₁+x₂y₁)`, so the group is the semidirect
product **R>0 ⋉ H₃** acting affinely. Associativity holds to machine precision,
and all three parenthesizations of the prefix reduction agree — the parallel
scan is exact, not approximate.

The contraction certificate also holds, and is tighter than the audit states.
The exact infinity-norm of the linear part is

    ‖qN(x,y,z)‖∞ = q · max(1+|x|+|z|, 1+|y|)

which the shipped denominator `(1+|x|+|y|+|z|)` over-bounds. So

    ‖qN‖∞ ≤ c_i · σ(a) < c_i < 1

is guaranteed for every reachable coefficient. The memory provably cannot
amplify. That part of the design is correct and it is the reason the model is
numerically safe.

**Parameter reconciliation.** The stated shapes sum to exactly 45,697,024 only
if the depthwise convolution carries no bias term. That closes the audit's
count and recovers a detail the audit did not state. Distribution:

| component | parameters | share |
|---|---:|---:|
| coefficient output head (2048 → 10752) | 22,030,848 | 48.2 % |
| readout in (4608 → 2048) | 9,439,232 | 20.7 % |
| three 2048×2048 blocks (local / coefficient hidden / readout hidden) | 12,589,056 | 27.5 % |
| everything else (embedding, conv, norms, output, initial state) | 1,637,888 | 3.6 % |

Nearly half the model exists to turn a 7-byte causal window into event
coefficients.

---

## 2. Lane admission: the semigroup clause, not the compact-group clause

Court III's Proposition A requires a group with **compact closure** to obtain an
invariant inner product. R>0 ⋉ H₃ is solvable and noncompact, so Proposition A
does not apply to this model — and does not need to. Lane A's second admission
criterion is a *proven closed semigroup*, and that is what the contraction
certificate establishes.

This matters because it removes a temptation. Court III's orthogonality
discussion invites the reading "make the carrier orthogonal or it is unsafe."
The shipped model is safe by contraction instead of by orthogonality, which is a
legitimate and different route. It also means the model is *deliberately
forgetful* — Lane B semantics on a Lane A solver.

## 3. The β program does not apply

Executed with Court III's own predict-correct oracle
(`δ_{t+1} = J_t δ_t + [f(M_t,x_t) − M_{t+1}]`, `M ← M + δ`) from a maximally
wrong all-zero boundary guess:

| system | T=64 | 128 | 256 | 512 | 1024 | β |
|---|---:|---:|---:|---:|---:|---:|
| ARCHIE event-semidirect, seed 0 | 1 | 1 | 1 | 1 | 1 | **0.000** |
| ARCHIE event-semidirect, seed 1 | 1 | 1 | 1 | 1 | 1 | **0.000** |
| ARCHIE event-semidirect, seed 2 | 1 | 1 | 1 | 1 | 1 | **0.000** |
| residual-tanh comparator, seed 0 | 11 | 20 | 40 | 79 | — | 0.953 |
| residual-tanh comparator, seed 1 | 8 | 8 | 8 | 13 | — | 0.210 |
| residual-tanh comparator, seed 2 | 12 | 21 | 42 | 83 | — | 0.937 |

The comparator reproduces and widens Court III's central result: β is not a
constant of the architecture, it is a property of the particular dynamics, and
across three seeds of one recipe it spans 0.21 to 0.95. Court II's 0.61 remains
refuted.

The shipped model sits outside that entire discussion. Its coefficients
`(q, x, y, z, w)` are produced from a 7-token causal window and **never read the
recurrent state**, so the recurrence is affine and its first-order model is
exact. `L_growth` is identically zero for it at every β_target. Implemented and
tested anyway (`growth_penalty`, `block_record`) — for the Lane B this model
does not yet have.

## 4. The cancellation certificate, and a working repair

Reproduced Court III §4 at 1000 trials: the proposed scalar merge broke
associativity in **100 %** of trials, median gap 3.07, max 35.1.

Repair A is implemented and holds: carry `(log gain bound, log source sum)` and
merge with `(g₂+g₁, logaddexp(g₂+S₁, S₂))`. Associativity defect 8.9e-16 —
associative by construction, because log-sum-exp is. The cost is measured
honestly: the bound is already **1.90× loose at the median after two factors**
(3.63× at p95), which is exactly the cancellation blindness Court III predicted.

None of this is needed by the shipped model. Its retention is a *positive
scalar*, so prefix gains multiply exactly and the log-gain is additive with zero
looseness. The certificate problem is a Lane B/C problem.

---

## 5. The finding that actually matters: memory and transport are exclusive

Write the per-token decay rate as `r = −log q`:

    r = λ_i + softplus(−a) + log(1 + |x| + |y| + |z|)
        ─────   ──────────   ─────────────────────────
        design    gate            transport toll

Three separate things spend from one budget, and the design term is the smallest.

**(a) The gate swamps the designed spectrum at initialization.** The retention
bias is 4.0, so `softplus(−4) = 0.01815`. The slowest fiber's own design rate is
`λ_min = 0.002`. The gate therefore contributes **90 % of the slowest fiber's
total decay** before training begins.

| retention bias | slowest-fiber half-life | retained over 512 tokens |
|---|---:|---:|
| 4.0 (shipped) | 34.4 tokens | 3.3e-5 |
| 8.0 | 296.8 tokens | 0.302 |
| saturated | 346.6 tokens | 0.359 |

At initialization the model's memory is ~50 tokens, not 512, and the entire
`linspace(0.002, 0.2)` spectrum is compressed into the top of its range. The
model must first learn to drive `a₀` up before any of the designed long-memory
fibers exist at all.

**(b) Transport is priced in memory, and the price is nearly all of it.** Under
the shipped normalizer, holding a given horizon caps how much of the ±0.2
transport range a fiber may use:

| target horizon | shipped | exact ‖N‖∞ | decoupled |
|---|---:|---:|---:|
| 32 tokens | 4.9 % of range | 7.4 % | 100 % |
| 128 tokens | **0.95 %** | 1.45 % | 100 % |
| 512 tokens | 0 % | 0 % | 0 % (see (c)) |

Run it the other way: a fiber using the **full** transport range has an
effective horizon of **2.1 tokens**. The noncommutative `x₂y₁` term — the one
mechanism that distinguishes this architecture from a diagonal gated linear RNN
— is available only to fibers that have already forgotten everything. Switching
to the exact ‖N‖∞ denominator is free and strictly tighter, but only moves
0.95 % to 1.45 %. It is not the fix.

**(c) The window is unreachable regardless.** `1/λ_min = 500 < 512`. Even with a
saturated gate and zero transport, no fiber reaches the training window. This is
a property of the `linspace` lower bound alone.

### The proposed fix: scale-free transport

Cap each fiber's transport at its own decay rate, `τ_i = κ·λ_i`, and drop the
denominator. Then the accumulated transport over a fiber's *own* horizon is κ
for every fiber, and the worst-case prefix-operator norm becomes
fiber-independent:

| κ | slowest fiber (λ=0.002) | fastest (λ=0.2) | bound spread across fibers |
|---|---:|---:|---:|
| 0.5 | horizon 500, bound 1.000 | horizon 5, bound 0.982 | **1.02×** |
| 1.0 | horizon 500, bound 1.313 | horizon 5, bound 1.276 | **1.03×** |
| 2.0 | horizon 500, bound 2.613 | horizon 5, bound 1.276 | 2.05× (clamp binds) |

The mechanism: the Heisenberg part is nilpotent, so a k-step prefix grows only
**polynomially** (degree 2) while the scalar part decays geometrically. Per-step
contraction was never necessary for boundedness — only `q < 1` is. Setting
`τ ∝ λ` makes `sup_k e^{−λk}(1+τk)²` a function of κ alone.

For contrast, simply deleting the denominator without rescaling transport
(`decoupled`) stays bounded but with a worst-case prefix norm of **2754** for the
slowest fiber. Bounded, but not a guarantee worth having. κ ≈ 1.0 is the
defensible setting.

### Recommended changes, in priority order

1. **`retention_bias: 4.0 → 8.0`.** One constant. Raises initial slowest-fiber
   retention over the training window from 3.3e-5 to 0.30. Lowest risk, largest
   immediate effect.
2. **`linspace(0.002, 0.2) → linspace(0.0005, 0.2)`** (or lower) so the slow end
   actually exceeds the 512-token window instead of stopping 12 tokens short.
3. **Scale-free transport `τ_i = κλ_i`, κ ≈ 1.0, denominator removed.** Frees the
   Heisenberg mechanism from the memory toll while keeping a uniform bound.
   Larger change; run it as an A/B against (1)+(2) alone, because it is the only
   one of the three that alters the reachable function class.

All three are hyperparameter-level. None changes the composition law, so the
Triton `associative_scan` kernel is untouched.

---

## 5b. First measured corpus baseline (added 2026-08-01)

Measured on 64,000,000 tokens of `development.u16` — the real held-out split,
not synthetic data. Evidence: `corpus_baseline_evidence.json`.

| what | context available | BPB |
|---|---:|---:|
| uniform over 256 | none | 8.0000 |
| order-0 byte frequencies | none | 5.4439 |
| gzip -9 | 32 KB | 1.4337 |
| **ARCHIE (training loss, ~step 26k)** | **512 B** | **~1.21** |
| bzip2 -9 | 900 KB | 1.2369 |
| xz -9e | 64 MB | 0.9794 |

The model reaches **bzip2-class compression with ~1758× less context** and
gzip-class with 64× less. It loses only to `xz`, whose entire advantage is
long-range reuse across a 64 MB dictionary.

That is exactly the signature §5 predicts. Linux kernel source is enormously
redundant *at long range* — repeated license headers, near-identical driver
scaffolding, identifiers recurring across files — and that is precisely the
redundancy a 512-byte window cannot reach and a 64 MB dictionary harvests for
free. The model is not losing because its local modeling is weak; per byte of
context it is the strongest thing in the table.

**Caveat, load-bearing:** the model row is *training* loss standing in for
held-out BPB. The run consumes 307,200,000 of 1,563,218,387 available training
tokens (19.6% of one epoch, no byte repeated), so memorization pressure is low
and the two should be close — but that is an argument, not a measurement.
Replace it with a real `development.u16` evaluation before concluding anything.

If the §5 hyperparameter ladder works, this table is where it should show up:
a model that can actually hold 512 tokens, rather than ~50, should close most of
the 0.23 BPB gap to `xz` without any change to the composition law.

## 6. What Court IV does **not** establish

This harness measures the transition algebra and its hyperparameters. It does
not touch the checkpoint. Specifically it does **not** establish:

- any next-byte loss, bits-per-byte, or capability number;
- any comparison against any baseline;
- that the recommended changes improve task loss — only that they remove
  structural constraints that currently bind;
- anything about the corpus provenance gap the audit left open.

**The honest answer to "is my model good" is that the question is still open,
and the audit cannot close it.** The audit is an excellent *architectural*
recovery — exact sources, exact shapes, exact equations, exact training command
— and it contains **zero evaluation evidence**. There is no held-out
bits-per-byte on `development.u16`, and no baseline to compare against.

Two structural facts predict a ceiling, and should be stated as predictions
rather than measurements:

- **Depth 1.** There is one recurrent layer. Features → coefficients → scan →
  readout → logits, no stacking. The only state-path nonlinearity is the single
  bilinear `x₂y₁` term. Compositional depth has to be simulated across fibers
  rather than across layers.
- **Second-order reach.** The `z` coordinate accumulates `Σ_{u>t} x_u y_t` — a
  decaying second-order Volterra term, i.e. pairwise products between two scalar
  channels of the *same* fiber. This is genuinely more than a linear RNN, and
  genuinely less than content-based retrieval: 1536 independent scalar bilinear
  products cannot express a query·key match over arbitrary vectors without
  spending many fibers on it.

## 7. The next court's shortest path

Court IV's handoff is much smaller than Court III's, because the expensive
questions are now cheap ones:

1. **Measure bits-per-byte on `development.u16`** for the step-3500 checkpoint.
   Compare against (a) an order-8 byte n-gram with backoff, and (b) a
   parameter-matched and FLOP-matched small transformer. Until this exists,
   every other question is premature. This is the answer to "is it good."
2. **Ablate the Heisenberg term.** Set `transport_scale = 0` and retrain. If BPB
   is unchanged, the model is a diagonal gated linear RNN wearing a Heisenberg
   costume and §5 explains why. This is the single highest-information
   experiment available.
3. **Run the §5.1–5.3 hyperparameter ladder** — bias 8.0; extended linspace;
   scale-free transport — as three matched runs against the current baseline.
4. **Measure the learned retention distribution** in the step-3500 checkpoint.
   Plot realized `q` against `c_i`. This tests §5(a) directly on real weights:
   if the trained gate sits near σ(4), the model never escaped the initialization
   horizon.
5. **Write the generation CLI.** The audit is right that it does not exist for
   `ArchieEventSemidirectLM` and that the recovered `generate()` belongs to
   `ArchieCausalPatchLM`. It is mechanical — the scan is exact, so incremental
   decoding is a single event compose per token — but it is new code and should
   be labeled as new code.
6. **Close the corpus provenance gap** from `/home/awesomekai/archie-sidepus-public-v2/export`,
   which the audit identifies as the likely location of the acquisition receipts.

Items 1 and 2 are worth more than everything Courts I–III produced, because they
are the only ones that can make the architecture fail on its merits.

---

## Appendix. Reproduction

```bash
python research/court-iv/archie_court_iv.py     # 6.4 s, writes the results JSON
python research/court-iv/test_archie_court_iv.py # 24 contract tests
```

Standard library only — no numpy, no torch, no CUDA. The experiments use the
shipped hyperparameters from the launch-time audit: `transport_scale = 0.2`,
`write_scale = 1.0`, retention ceilings `exp(-linspace(0.002, 0.2))`, retention
bias `4.0`, 1536 fibers × 3 coordinates.

**Claim boundary.** Every number in this document is a property of the
transition algebra and its hyperparameters, computed from the architecture
recorded in the launch-time audit. Nothing here is a capability measurement, a
benchmark, or an admission decision.
