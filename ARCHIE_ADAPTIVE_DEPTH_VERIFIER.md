# Adaptive-depth layer skipping: closing the FLOP Trap and the Over-Pessimism Trap

This document is a design and a proof, backed by a synthetic simulation (Section 6) and
compiled into a labeled set of theorems, propositions, and findings (Section 7), not a
shipped feature. No inference code in this repository currently skips layers. Nothing here
is admitted evidence under the `archie-candidate-completion-manifest/v1` process in
`ARCHIE_ARCHITECTURE_EXPERIMENTS.md` — the simulation validates the calibration math against
a statistical model of the problem, not Archie's real weights. It exists so that if
adaptive-depth decoding is built for Archie, it is built on a scheme whose failure modes
were found by trying to break it, not discovered in production.

Four rounds of self-correction are visible below rather than smoothed over. (1) An
adversarial pass found three errors in the prose, including an outright false safety claim
in Section 1. (2) A first simulation pass found the proposed fix for a claimed compounding
gap (Section 3.5) was itself broken. (3) Building on that simulation surfaced something
underneath both of the first two rounds: the Theorem in Section 3.2 had been proving a
*joint* probability while stating, in English, a *conditional* one — a real bug, not a
wording issue, that had survived round 1's falsification pass undetected and had made round
2's "compounding gap" and "aggregation diverges" findings both look considerably more
dramatic than what was actually proven ever promised. Fixing that changed which of round 2's
numbers hold up (two of three didn't). (4) The honest fix for the joint/conditional gap —
calibrate the conditional risk directly — was tried three ways and collapsed every time, at
first; pushed further, a fourth construction (a better-suited estimator, a tighter
concentration inequality, and a corrected search procedure that turned out to matter
independently of both) actually works, at roughly 100x the calibration data — turning what
looked like a dead end into a quantified, working answer (Theorem 4). A document that only
shows the final clean version of this is indistinguishable from one that never checked; this
one shows the failed attempts too, including its own, and what it took to get past them.

## 1. The problem, stated precisely

Let the base model have `L` transformer layers. For a decoding step `t`:

- `p_t` = the output distribution from the full `L`-layer forward pass.
- `q_t` = the output distribution obtained by exiting early, after only `L - k` layers,
  and applying the (shared or calibrated) LM head to that intermediate hidden state.

We want to skip the last `k` layers whenever it is safe to do so, where "safe" means the
generation is not meaningfully degraded. The natural safety condition is a bound on total
variation distance, `TV(q_t, p_t) <= tau`, because of the variational (Scheffé)
characterization of `TV`: for *every* event `A` over the vocabulary — "the correct token,"
"a toxic token," "a grammatically valid continuation," anything —

```
| Pr_{q_t}(A) - Pr_{p_t}(A) | <= TV(q_t, p_t)
```

so bounding `TV` bounds the worst-case probability shift for any downstream property of
interest, not just one hand-picked one. This is the correct justification, and it is
weaker than it might sound: **small `TV` does not guarantee greedy-argmax agreement.** Take
`q_t = (0.501, 0.499)`, `p_t = (0.499, 0.501)`: `TV(q_t, p_t) = 0.002`, yet the argmax flips
with certainty. Near a tie, an arbitrarily small mass shift changes the greedy decision,
so a TV budget alone does not certify greedy decoding at ties — it certifies *distributional*
closeness, not decision agreement at unstable points. (The full model is itself unstable at
those ties; this is a property of argmax, not a gap specific to skipping layers. Sampling-based
decoding, where the relevant quantity is the coupling disagreement probability, is where a TV
bound has direct operational meaning.)

Two failure modes were identified against any design that answers "is it safe to skip?"
with a learned network `V_t`:

1. **The FLOP Trap.** If `V_t` must be an accurate estimator of `TV(q_t, p_t)` across long
   generations, it needs enough capacity to approximate a function of the *full* model's
   behavior — but it only gets to see the shallow state. Pushed hard enough for accuracy,
   its cost approaches the cost of the layers it's supposed to be saving. At 3.5 layers of
   cost to save 4 layers, the scheme is dead on arrival.
2. **The Over-Pessimism Trap.** If `V_t` is kept cheap, the only way to make its safety
   claim honest is to pad it with margin. A cheap, honest-but-conservative bound spikes
   above `tau` most of the time, and the scheduler falls back to full depth on the large
   majority of tokens, destroying the speedup it was built to deliver.

These are not independent bugs to patch around — they are two horns of the same dilemma:
**an online, per-token function that must both be cheap and be an accurate, non-conservative
certificate of an unseen full-depth computation is asking for something that does not
exist.** The fix is to stop asking `V_t` to be that function.

## 2. The escape: move the hard part offline, keep the online part free

Nothing computed online needs to estimate `TV(q_t, p_t)`. It only needs to produce a
scalar `s_t` from quantities the shallow pass *already computed*, such that `s_t` is
monotonically informative about `TV(q_t, p_t)` — bigger `s_t` means safer to skip. The
actual safety guarantee is established once, offline, by calibrating a threshold on `s_t`
against a labeled sample where both `q_t` and `p_t` are known (because during calibration
we can afford to run the full `L`-layer model — it's a one-time, amortized cost, not a
per-token one).

### 2.1 Candidate statistics `s_t` (all effectively free)

Each of these is a byproduct of the shallow pass and needs no additional transformer layer:

| Statistic | Definition | Extra cost vs. one transformer layer |
|---|---|---|
| Softmax response | `s_t = max_v q_t(v)` | `0` — already computed to produce `q_t` |
| Hidden-state saturation | `s_t = cos(h_t^{(L-k)}, h_t^{(L-k-1)})` | `O(d)` dot product |
| Linear probe | `s_t = sigmoid(w^T h_t^{(L-k)})` | `O(d)` |

A standard transformer layer costs on the order of `12 * d^2` FLOPs per token (attention +
4x-expansion MLP). A linear probe costs `O(d)`. For Qwen3-1.7B (`d ~= 2048`), the ratio is

```
cost(s_t) / cost(one layer) ~= d / (12 * d^2) = 1 / (12 * d) ~= 1 / 24576
```

so `s_t` costs roughly **0.00004 layers**, not 3.5. This is what actually defeats the FLOP
Trap: not a smaller `V_t`, but the recognition that the online component doesn't need to be
a network at all — it needs to be a statistic, with all its capacity spent offline where
capacity is cheap.

### 2.2 What `s_t` is *not* asked to do

`s_t` is never asked to output a calibrated probability or a bound. It is only asked to be
*monotonically associated* with `TV(q_t, p_t)` — i.e., thresholding it at different cutoffs
traces out a risk/skip-rate tradeoff curve. Producing a well-ranked scalar is a much weaker
and cheaper requirement than producing an accurate estimator, and it is the only property
the calibration step in Section 3 relies on.

## 3. Calibration: Learn-Then-Test, not hand-tuned margin

This is the same principle behind Confident Adaptive Language Modeling (Schuster et al.,
NeurIPS 2022) and Learn-Then-Test / Risk-Controlling Prediction Sets (Angelopoulos et al.,
2021-2022): pick the *least conservative* threshold that still gives a valid,
distribution-free guarantee, instead of padding a cheap estimator with margin by hand.

### 3.1 Setup

Two separate knobs, not one, and they must not be conflated (an earlier draft of this
document conflated them): `alpha` is the *risk budget* — the maximum tolerable rate of
"skipped and shouldn't have been" among skip decisions — and `delta` is the *calibration
confidence* — how often the offline calibration procedure itself is allowed to fail to
deliver a threshold that actually achieves that budget. The guarantee we want is:

```
with probability >= 1 - delta over the calibration draw,
    Pr_{t ~ D}[ TV(q_t, p_t) > tau | skip at t ] <= alpha
```

`tau` is the TV tolerance from Section 1. If the caller only wants to think in terms of one
number (matching the original `Pr[TV <= tau] >= 1 - delta` framing), set `alpha = delta`; the
two-knob form is kept explicit here because collapsing it silently is exactly the kind of
notational sleight that makes a "proof" look tighter than it is.

**This is the guarantee wanted, stated with `|` (conditional). It is not exactly the
guarantee Section 3.2 proves** — that Theorem delivers the `AND` (joint) version instead,
which is weaker. Section 3.2 explains precisely why, and Section 3.6 covers what happened
when calibrating the conditional version directly was actually attempted.

Fix a finite grid of candidate thresholds `lambda_1 > lambda_2 > ... > lambda_M` over the
range of `s_t`. The decision rule at threshold `lambda` is:

```
skip_lambda(t) = 1{ s_t >= lambda }
```

Draw `n` i.i.d. calibration units offline by running *both* the shallow and full model.
**The i.i.d. unit must be the whole sequence, not the token.** Tokens within one generation
are highly dependent (each hidden state depends on all previous ones), so pooling per-token
`(s_t, TV_t)` pairs from many positions in the same rollout and treating them as `n`
independent draws is invalid — it understates variance and the concentration bound below no
longer holds at its stated level. Instead: draw `n` i.i.d. sequences from the target
distribution, and for sequence `i` define the *sequence-averaged* loss

```
ell_i(lambda) = (1 / T_i) * sum_{t=1}^{T_i} 1{ s_{i,t} >= lambda } * 1{ TV_{i,t} > tau }
```

`ell_i(lambda) in [0,1]` is now a genuine i.i.d. sample across `i = 1..n` (the standard
device also used in CALM to handle within-sequence dependence). The risk we control is

```
R(lambda) = E[ ell_i(lambda) ]
```

which upper-bounds the token-level `Pr[TV_t > tau AND skip_lambda(t)]` by Jensen/Fubini
when sequence lengths are treated as fixed or independent of the loss.

### 3.2 Monotonicity is the whole trick

Because `skip_lambda(t)` only shrinks as `lambda` increases (higher threshold = skip less
often = skip only on the safest cases as ranked by `s_t`), `R(lambda)` is **non-increasing
in `lambda`** by construction. This monotone structure is exactly what Learn-Then-Test
needs to turn a single concentration inequality into a valid selection procedure without
an exhaustive multiple-testing correction:

1. For each `lambda_j` on the grid, compute the empirical risk `R_hat(lambda_j)` from the
   calibration sample and a `(1 - delta)`-upper confidence bound `R_plus(lambda_j)` via a
   Hoeffding-Bentkus concentration bound (valid because `ell_i in [0,1]` is bounded, i.i.d.
   across *sequences* per the fix in 3.1). `R_hat` is pathwise non-increasing in `lambda` for
   a fixed calibration sample (raising `lambda` can only turn indicator terms off), and the
   Hoeffding-Bentkus slack term does not depend on `lambda`, so `R_plus` inherits the same
   monotonicity — this is what licenses skipping the multiple-testing correction below.
2. Walk the grid from the most conservative `lambda_1` downward. `lambda_hat` is the smallest
   `lambda_j` such that `R_plus(lambda_{j'}) <= alpha` for every `j' <= j` — equivalently
   (by the monotonicity in step 1) the first point, scanning from `lambda_1` down, where
   `R_plus` would exceed `alpha` if you went one step further.
3. Fixed-sequence testing along a monotone grid controls the family-wise error at level
   `delta` with a *single* test at the selected point, not a Bonferroni correction over all
   `M` grid points — this is what keeps the calibration itself statistically efficient.

**Theorem (informal, corrected — see the callout below).** With probability at least
`1 - delta` over the draw of the calibration set, the selected `lambda_hat` satisfies

```
Pr_{t ~ D}[ TV(q_t, p_t) > tau  AND  skip at t ] <= alpha
```

**This is a joint/marginal probability, not the conditional `Pr[TV > tau | skip] <= alpha`
stated in every earlier version of this theorem.** They are not the same quantity, and an
error surviving one full falsification pass (the earlier "Fix three real gaps" revision)
mislabeled the one for the other: Section 3.1's own derivation, two paragraphs up, correctly
identifies `ell_i(lambda)`'s expectation as bounding the token-level
`Pr[TV_t > tau AND skip_lambda(t)]` — the word is "AND". This box previously wrote `|` two
sections later and called it the same result. It is not. `Pr[A and B] = Pr[A|B] * Pr[B]`, and
`Pr[B] = ` the skip rate is typically well below 1, so the joint guarantee actually proved
here is *weaker* than the conditional one a reader would naturally want — bounding "how often
we skip badly, averaged over every token including the ones we didn't skip" is a real but
different promise than "given we skipped, how likely were we wrong." Section 3.6 below covers
what happened when this got fixed for real: the "obvious" fix (calibrate the conditional risk
directly) was tried, and it does not simply work.

Setting `alpha = delta` recovers the single-parameter framing `Pr[TV AND skip] <= 1 - delta`
this document originally claimed matched the problem statement's `Pr[TV <= tau] >= 1 - delta`
— it does not match it exactly, for the reason above, but the bound is still real and still a
*property of a threshold chosen once offline*, not a value computed per token. `V_t` in the
original framing is replaced by the pair `(s_t, lambda_hat)`, where `s_t` is free and
`lambda_hat` is a constant baked in after calibration.

*Proof sketch.* Each `ell_i(lambda)` is an i.i.d. bounded random variable across sequences
`i`, with mean `R(lambda) = Pr[TV > tau AND skip_lambda]`. The Hoeffding-Bentkus bound gives,
for any fixed `lambda`, a p-value for the null `R(lambda) > alpha` that is valid regardless of
the true distribution of `(s_i, TV_i)`, using only boundedness of `ell_i` in `[0,1]`. Because
`R(lambda)` is non-increasing in `lambda` (Section 3.2, step 1), rejecting the null at the
single boundary point `lambda_hat` implies rejection at every `lambda >= lambda_hat` as well
(a graphical/fixed-sequence argument), so testing only the boundary controls the family-wise
error over the whole "skip region" `[lambda_hat, lambda_1]` at level `delta`, without paying
a `1/M` Bonferroni factor for the grid size. This is the standard Learn-Then-Test argument
(Angelopoulos et al., 2021, "Learn Then Test: Calibrating Predictive Algorithms to Achieve
Risk Control"); it is reproduced here only to make explicit that nothing in it requires
`s_t` to be accurate — only bounded and monotonically thresholdable. This part of the proof
was never wrong; only the English sentence describing which quantity it proves was. &#8718;

### 3.3 Why this specifically kills the Over-Pessimism Trap

The trap was: a cheap, honest bound has to be padded with margin, so it fires constantly.
Learn-Then-Test never pads by hand. It searches the monotone frontier for the *smallest*
`lambda` — i.e. the *most aggressive, lowest-fallback* rule — that the calibration data can
certify at the target confidence. The resulting fallback rate is not a designer's guess;
it's a number you read off the calibration run (e.g. "at `tau = 0.05`, `alpha = 0.01`,
`delta = 0.01`, the calibrated rule skips X% of tokens on the calibration distribution"). If that number is
still bad, that is a real, measured fact about the statistic `s_t` and the model — the
correct response is to try a better-ranked `s_t` (Section 2.1 lists three cheap options in
increasing power) or to condition the threshold (Section 3.4), not to hand-tune margin into
an opaque sub-network.

### 3.4 Long-horizon drift: condition, don't globalize

A single global `lambda` must be conservative enough for the *worst* regime a token can be
in (e.g. late in a long generation, where compounding error makes `TV(q_t, p_t)` typically
larger). That worst-case pooling is itself a source of over-pessimism. Fix it with
group-conditional ("Mondrian") calibration instead of a global threshold:

- Partition calibration points into buckets `b` by a cheap, already-available feature —
  generation-step bucket, or entropy bucket of `q_t`.
- Run the Section 3.2 procedure independently per bucket to get `lambda_hat_b`, splitting
  the confidence budget `delta = sum_b delta_b` across buckets (a Bonferroni split across a
  small, fixed number of buckets is cheap because the number of buckets is small, unlike
  the earlier grid, which fixed-sequence testing already handles for free).
- At inference, look up the threshold for the current token's bucket: `lambda_hat_{b(t)}`.

Each bucket now gets a threshold no more conservative than *its own* worst case requires,
instead of inheriting the worst case of every other bucket.

### 3.5 The honest gap: teacher-forced calibration vs. a live, compounding rollout

Section 3.2's theorem holds for calibration data collected by *teacher forcing*: at every
step `t`, both `q_t` and `p_t` are computed from the same reference context (e.g. a fixed
held-out continuation), independent of any earlier skip decision. That is not what happens
in deployment. Once the policy is live, if it skips at step `t`, every later hidden state
`h_{t'}^{(*)}` for `t' > t` is computed from a context that itself came from the shallow
path at `t` — a context the full model never actually produced. This is an on-policy /
off-policy mismatch (the same mechanism as exposure bias in imitation learning): the
calibration set and the deployment-time input distribution to later steps are not the same
distribution once skip decisions compound, so the i.i.d.-sequences assumption in 3.1 is
violated by construction for any sequence containing more than one skip.

This is precisely the "across long horizons" clause in the original FLOP Trap statement,
and Section 3.2 alone does not close it. Two candidate ways to close it were identified:

1. **On-policy calibration.** Collect the calibration set by running the *adaptive* policy
   itself, not the teacher-forced full model, so `(s_i, TV_i)` are drawn from the actual
   rollout distribution the final policy will produce. This is a fixed-point / DAgger-style
   idea: calibrate, deploy, verify the resulting rollout distribution matches what was
   calibrated against, or iterate.
2. **An explicit stability assumption.** Assume the full model is `beta`-Lipschitz from
   hidden-state perturbation to output TV: `TV(p_t(h), p_t(h')) <= beta * ||h - h'||`. A
   per-step skip error bounded by `tau` then induces a bounded perturbation to the next
   context, and a triangle-inequality/telescoping argument bounds the *accumulated*
   divergence after `T` steps by something like `T * beta * tau` — which grows with `T`, so
   it does **not** automatically make long-horizon generation safe just because each step is
   individually calibrated. Not tested here; `beta` is an empirical property of the specific
   model.

Option 1 was tested — see Section 6 — twice, because the first pass measured the wrong
thing. Given the joint-vs-conditional correction in Section 3.2, re-read this section's
"gap" claim carefully: what compounding actually does to the *proven* quantity
(`Pr[TV > tau AND skip]`) is real but modest in the simulation — it does not blow the budget.
What it does to the *unproven, but operationally meaningful* quantity
(`Pr[TV > tau | skip]`) is much larger, because compounding drives the skip rate down (the
statistic partially recognizes corrupted context and avoids it) while the joint risk barely
moves, and conditional = joint / skip-rate amplifies that. An earlier version of this section
reported a dramatic "on-policy recalibration doesn't fix it, and DAgger-style aggregation
catastrophically diverges" finding, checked against the conditional criterion — that
divergence was itself measured against a target the calibrator never controlled, so it
overstated the picture. Checked against what is actually proven (joint), both discard-based
and aggregate-based on-policy recalibration stay within budget in Section 6's numbers, though
aggregation is still directionally worse (about 5x the final joint risk of discarding).
Read Section 6 for the numbers, and Section 3.6 for the more serious problem this correction
surfaced.

### 3.6 The obvious fix doesn't work — the fourth attempt does, at a quantified cost

If the theorem in 3.2 only proves the joint guarantee, the fix sounds simple: calibrate the
conditional risk directly instead. Define, per sequence, the loss as that sequence's own
conditional bad-rate among the tokens it actually skips (excluding sequences that skip
nothing at a given `lambda`, since they carry no information about the conditional risk), and
run the same Learn-Then-Test machinery on that.

This was implemented and tested (Section 6, Part F) and it does not simply work: at the same
calibration budget that gives the joint calibrator a healthy skip rate, this "separate ratio
estimator" (Cochran, 1977, calls the per-sequence-averaged ratio this; the alternative below
is what Cochran calls the "combined ratio estimator") collapses to skipping almost nothing.
The mechanism is variance, not a coding mistake: a sequence that skips only one or two tokens
contributes a coarse, high-variance per-sequence ratio (0, 1/2, or 1 — nothing in between), and
Hoeffding's bound, which only uses boundedness in `[0,1]` and not the true variance, pays for
that coarseness by demanding far more calibration data than the joint formulation needs. A
second attempt — bounding the ratio of the numerator and denominator *sums* (not per-sequence
ratios) via range-scaled Hoeffding — failed even harder, because the range `[0, T]` is a much
looser scale than the values the sums actually take. Swapping in empirical-Bernstein for the
per-sequence-ratio construction (Section 6, Part H) is genuinely tighter, not a null result,
but still nowhere near enough at realistic budgets — a third failure.

**A fourth attempt works.** Two things were wrong with the ratio-of-sums attempt, not one.
First, it used range-scaled Hoeffding, which — as just noted — is much looser than the values
involved warrant; swapping in empirical-Bernstein on the raw per-sequence *counts* (not
ratios) fixes that, and also switches to the more sample-efficient estimator in the first
place (the combined ratio estimator is standardly more efficient than the separate one when
unit sizes — here, skip counts per sequence — vary a lot, which they do). Second, and less
obviously: the grid search itself was invalid for a Bernstein-based ratio-of-sums construction.
`calibrate()` and `calibrate_conditional()` can walk the grid and stop at the first failure
because their UCB's slack term does not depend on `lambda`, which is what makes `R_plus`
provably monotone (Section 3.2) and licenses skipping a multiple-testing correction. Empirical-
Bernstein's slack depends on `lambda` through the empirical variance, which is not monotone as
small-denominator sequences enter and leave the qualifying set — checked directly, "stop at
first failure" *does* stop at a transient bad point and silently discards genuinely safe
lambdas further down (an actual observed instance: a spurious failure at `lambda=0.99` masked
25 valid passing points down to `lambda=0.835`, out of a naive-search result that reported
total collapse). The valid fix without assuming monotonicity: Bonferroni across all `M` grid
points — test each at `delta/(2M)`, scan the whole grid, keep the most aggressive lambda that
passes its own test. This is a validity requirement, not an optimization; the non-Bonferroni
version of this same construction reported much better numbers that were not actually valid.

Combining both fixes (Section 6, Part I) closes most of the gap: at `n_cal=30,000` — 100x
Theorem 1's budget, not 33x — the combined-ratio-estimator, Bernstein-bounded,
Bonferroni-corrected calibrator reaches **31.5% skip rate at 0.092 mean conditional risk**,
matching (and technically exceeding) joint calibration's 31.3% at `n_cal=300`, while actually
delivering the stronger, previously-unproven guarantee. It still collapses to 0% at
`n_cal=300/1,000/3,000` — the fix has a real, steep data cost, not a free lunch — but the
practical version of Open Problem 4 ("does *any* efficient-enough construction exist, or is
the conditional guarantee simply out of reach") has an answer, and it's yes, at roughly 100x
the joint guarantee's calibration budget in this parameter regime. Section 7 states this
precisely, including what is and is not established by it.

## 4. Online algorithm

```
# Offline, once, amortized over all future inference.
# Calibration unit is a whole sequence (3.1), teacher-forced (the gap in 3.5 applies).
for i in 1..n:
    run full L-layer forward pass on calibration sequence i, teacher-forced
    for t in 1..T_i:
        record s_{i,t} (from the shallow intermediate state, computed for free along the way)
        record TV_{i,t} = TV(q_{i,t}, p_{i,t})
        record bucket_{i,t}
    ell_i(lambda, b) = mean_t [ 1{s_{i,t} >= lambda} * 1{TV_{i,t} > tau} * 1{bucket_{i,t} == b} ]
for each bucket b:
    lambda_hat[b] = learn_then_test(
        {ell_i(., b) : i = 1..n}, alpha=alpha, delta=delta_b, grid=Lambda,
    )
persist lambda_hat  # a small lookup table, not a network

# Online, per decoding step t:
run layers 1..(L-k), producing h_t^{(L-k)} and q_t   # unavoidable, this is the "shallow" cost
s_t = softmax_response(q_t)                          # or saturation / linear probe; O(d) or O(1)
b = bucket(t)
if s_t >= lambda_hat[b]:
    emit from q_t                                     # skip last k layers
else:
    run layers (L-k+1)..L, emit from p_t               # fall back to full depth
```

The only thing that changed relative to the naive "train a `V_t` network" plan is that the
online branch is a lookup-table comparison, and the entire statistical burden of proving
`(1-delta)`-safety moved into a calibration step that pays its cost once, not per token.

## 5. What this does not claim

- **`calibrate()` (Theorem 1) does not control `Pr[TV > tau | skip]`, the conditional risk a
  user actually cares about.** It controls the joint/marginal `Pr[TV > tau AND skip] <= alpha`
  instead, which is a real but weaker statement — see the corrected Theorem in 3.2 for exactly
  what changed and why an earlier version of this document claimed the stronger, unproven
  thing. If you deploy `calibrate()`'s threshold and want the conditional guarantee, you do
  not have it; you have Theorem 4's construction available instead, at Theorem 4's cost.
- This does not claim `n_cal=30,000` is the minimum cost of an efficient conditional-risk
  calibrator (Theorem 4) — only that it is *a* cost that works, via one specific construction
  (combined ratio estimator, empirical-Bernstein, Bonferroni-corrected search). No sample-
  complexity lower bound is established; three cheaper, more naive constructions failed first
  (Section 6, Parts F and H), and the true minimum achievable cost remains open.
- This does not claim any particular skip rate or realized speedup for Archie's Qwen3-1.7B
  candidate. That number depends on how well the chosen `s_t` ranks `TV(q_t, p_t)` for this
  specific model and task distribution, and is only knowable by running the calibration
  procedure in Section 3 against real data and reporting `lambda_hat` and the resulting
  empirical skip rate — an `archie-metrics-receipt/v1`-style artifact, not a claim in this
  file.
- This does not claim a strict *per-token* certificate, even for the joint quantity that is
  proven: no O(d) statistic can promise that without occasionally being wrong, by a
  no-free-lunch argument identical in spirit to the FLOP Trap itself — a function cheap
  enough to be free cannot also certify individual full-depth outcomes it never computed.
- This does not claim the Section 3.2 guarantee (joint risk) is unaffected by compounding
  skip decisions across a multi-step generation, only that Section 6's simulation found the
  effect modest and non-violating in the parameter regime tested (mean joint risk 0.031
  under live compounding vs. a 0.10 budget). It does claim, with more confidence, that the
  *conditional* risk drifts substantially further under the same compounding (up to 40% over
  its nominal budget in every trial tested) — a real effect, just one that was never actually
  guaranteed by the calibrated quantity in the first place.
- This does not claim aggregating on-policy calibration data across rounds is safe in
  general, only that it did not cross the proven (joint) safety line in the specific
  parameter regime and chain lengths tested here, while still producing meaningfully higher
  realized risk than discarding stale rounds. An earlier version of this document reported
  aggregation catastrophically diverging; that was an artifact of checking the wrong
  criterion, corrected in Section 6.
- Distribution shift between the calibration sample and live traffic more generally (not
  just the compounding mechanism in 3.5) voids the guarantee, same as any calibration-based
  method (conformal prediction, LTT, RCPS). Recalibration cadence is an operational question
  this document does not answer.
- This does not claim small `TV` certifies greedy-argmax agreement near a tie (Section 1) —
  only that it bounds the probability shift of any fixed downstream event.

## 6. Simulated validation

Reproducible via `scripts/adaptive-depth-ltt-sim.py` (stdlib-only Python; raw output
committed alongside it as `scripts/adaptive-depth-ltt-sim.output.json`). This is a
synthetic statistical simulation of the `(s_t, TV_t)` relationship Sections 2-3 assume —
`s_t` a noisy, imperfect, monotonically-informative proxy for `TV_t` (Pearson correlation
`~= -0.57` by construction) — **not a run of Archie or any real model.** It validates the
calibration math, not a real skip rate; see Section 5. All numbers below are from one
`tau=0.08, alpha=0.10, delta=0.05` configuration, sequences of `T=40` tokens, and are the
**second** round of this simulation — the first round is described below because the bug
that invalidated it is itself the most useful finding of this section.

**A bug in this file, not just in the earlier document text.** The first round of this
simulation checked every "did the calibration hold" question against `conditional_risk`
(`Pr[TV>tau | skip]`) — matching what the document's Theorem claimed at the time. Section 3.2
now corrects that theorem: `calibrate()` only ever controls `joint_risk`
(`Pr[TV>tau AND skip]`). Once that was noticed (by directly printing what `calibrate()`
actually bounds versus what was being checked, not by inspection), every downstream number
needed re-deriving with the right criterion, and two of the first round's headline results
did not survive:

- Part A originally reported the naive per-token-pooled calibrator failing 250/250 times.
  Checked against `joint_risk` instead, at the same intra-sequence correlation strength used
  throughout that run, it failed **0/250** times — the naive calibrator's real invalidity
  hadn't been exposed by that test at all; the "250/250" was an artifact of checking the wrong
  quantity, which happened to look dramatic by coincidence.
- Part C originally reported that aggregating on-policy calibration data across rounds
  (DAgger-style) catastrophically diverges (0% to 100% violation by round 2). Checked against
  `joint_risk`, neither the discard nor the aggregate strategy violated its budget in any
  round, across 12 chains — though aggregation still produced meaningfully higher realized
  risk (see below), just not over the line.

Neither of these is a retraction of "the document had bugs" — it is the same finding one
level deeper: the falsification-and-fix cycle in this document's history had already caught
three real errors in the *prose*; this round caught one in the *code*, and it was large
enough to invalidate the headline number from two of three simulation parts. The fixed
results follow, plus one new part (F) that would not have existed without this correction.

An earlier version of the cheap statistic itself also had a bug — `s_t = clip(1 - TV_t +
noise, 0, 1)` put over 10% of probability mass exactly at `s_t=1.0` regardless of `TV_t`,
silently breaking every result downstream of it. Caught by checking the marginal
distribution of `s_t`, not by the calibration procedure. Replaced with a logistic-squashed
statistic with no boundary mass (Section 2.1's construction is schematic; this is one
concrete instantiation for the simulation). Two real implementation bugs surviving into a
document that had already gone through one falsification pass is itself worth sitting with.

**Part A — does the Section 3.1 fix hold, and does the rejected naive version actually
break, checked correctly?** Fixing the criterion required fixing the test, too: naive
pooling's invalidity is a function of intra-sequence correlation strength, and the original
fixed correlation level (`seq_offset_sd=0.05`) was too weak to expose it fairly. Swept
instead, 80 independent calibration draws per level (`n=300` sequences each), each against a
4,000-sequence holdout, violations checked against `joint_risk > alpha`:

| intra-sequence correlation (`seq_offset_sd`) | sequence-level violation rate | naive-pooled violation rate | naive mean skip rate |
|---|---|---|---|
| 0.05 | 0 / 80 | 0 / 80 | 55.3% |
| 0.15 | 0 / 80 | 0 / 80 | 55.2% |
| 0.30 | 0 / 80 | **8 / 80 (10%)** | 58.5% |

The valid calibrator stays safe regardless of correlation strength, as the theorem promises.
The naive calibrator's real failure rate climbs with correlation strength, exactly as the
mechanism in Section 3.1 predicts (it understates variance in proportion to how dependent the
pooled "samples" actually are) — and is invisible at weak correlation, which is exactly why
checking the wrong criterion at one arbitrary correlation level produced a misleading result
the first time.

**Part B — what does compounding actually do to the proven guarantee, versus the
operationally meaningful one?** Teacher-forced `lambda_hat ~= 0.79` deployed on live rollouts
where a skipped-and-actually-bad token shifts every later token's difficulty upward for the
rest of the sequence (absorbing corruption), 60 independent trials, both quantities reported:

| | mean `joint_risk` (proven target, `<= 0.10`) | joint violations | mean `conditional_risk` (unproven, wanted) | conditional violations | skip rate |
|---|---|---|---|---|---|
| Teacher-forced threshold, deployed live | 0.031 | **0 / 60** | 0.141 | 60 / 60 | 22.2% |
| + one round of on-policy recalibration | 0.028 | **0 / 60** | 0.130 | 60 / 60 | 21.6% |

What's actually proven holds up well under compounding — the joint risk barely moves and
never crosses budget. What isn't proven, and what a user actually cares about, drifts a lot:
conditional risk rises to 40% over its nominal budget in every trial, driven mostly by
compounding pushing the skip rate down (the statistic partly recognizes corrupted context and
avoids it) while joint risk stays flat, and conditional = joint / skip-rate amplifies that
drop. Section 3.6 is the direct consequence: since the conditional risk is the thing that
actually matters and it does drift here, the fix is to calibrate it directly — and that fix
does not simply work.

**Part C — does on-policy recalibration converge, checked against the right criterion, and
does discarding vs. aggregating history matter?** 12 independent chains of 5 rounds each:

| strategy | joint violation rate by round (0..4) | mean final joint risk | mean final conditional risk (fyi) |
|---|---|---|---|
| Recalibrate each round on only that round's data (discard history) | `0,0,0,0,0` | **0.013** | 0.078 |
| Recalibrate on the union of every round's data (DAgger-style aggregation) | `0,0,0,0,0` | **0.068** | 0.257 |

Both strategies hold the proven (joint) guarantee — no violations, either way. But aggregation
is still directionally worse by about 5x on the same measure, and dramatically worse on the
conditional measure it isn't controlling either. The mechanism from the retracted first-round
finding is plausible but now understood to be a matter of degree, not a cliff: an aggregated
pool mixes calibration data from earlier, less-drifted versions of the policy with the
current round's, understating how far the current round has moved — this pushes the
aggregated threshold more aggressive than the discard strategy's, without (in this parameter
regime) actually crossing the safety line on the quantity that's proven.

**Part F — does calibrating the conditional risk directly, the actual fix for the
Section 3.2 gap, work?** Same teacher-forced setup as Part A, same `n_cal=300` budget, 60
trials, violations checked against `conditional_risk > alpha` (the quantity these calibrators
are trying to control):

| calibrator | mean skip rate | conditional violation rate |
|---|---|---|
| `calibrate()` (joint-targeting, evaluated against conditional anyway) | 31.5% | 0 / 60 |
| `calibrate_conditional()` (per-sequence ratio, the "obvious" fix) | **0.0%** | 0 / 60 |
| ratio-of-sums via range-scaled Hoeffding (a second attempt) | **0.0%** | 0 / 60 |

Both direct attempts at conditional-risk calibration collapse to skipping nothing at all —
0% violation because 0% skip, the Over-Pessimism Trap in its purest form. Interestingly, the
joint-targeting calibrator, merely evaluated against the conditional criterion it was never
designed for, doesn't violate it either at this budget (0/60) — its 3.3% violation rate seen
in an earlier, smaller check (n_trials=60 at a different seed) suggests this is close to the
edge, not a coincidence-proof property. Section 3.6 has the mechanism: per-sequence
conditional-rate estimates are much higher-variance than the joint estimator's per-sequence
loss, and Hoeffding's range-only bound pays heavily for that. This is the genuinely open
problem this investigation surfaces, not a solved one.

**Part G — is there an actual formula behind Part A's violation-rate trend, or just a
direction?** Kish's design effect (Kish, 1965): pooling `T` intra-cluster-correlated
observations as if independent overstates the effective sample size by a factor
`DEFF = 1 + (T-1)*rho`, `rho` the intraclass correlation. Measured directly (one-way ANOVA
ICC estimator) at the same three correlation levels as Part A, `n=2000` sequences each:

| `seq_offset_sd` | measured `rho` | `DEFF` | naive assumes `n*T` | design-effect-corrected `n_eff` | true `n` |
|---|---|---|---|---|---|
| 0.05 | 0.360 | 15.0 | 80,000 | 5,325 (2.66x true `n`) | 2,000 |
| 0.15 | 0.828 | 33.3 | 80,000 | 2,402 (1.20x true `n`) | 2,000 |
| 0.30 | 0.953 | 38.2 | 80,000 | 2,097 (1.05x true `n`) | 2,000 |

The design-effect-corrected effective sample size converges toward the true sequence count as
correlation strengthens — the same mechanism, not just the same direction, as Part A's
naive-pooling violation-rate trend. This is a cited, standard result from clustered-sampling
theory, not derived from scratch here; it explains Part A's trend rather than independently
re-proving it, and was not carried through the Hoeffding-Bentkus argument itself to produce an
exact violation-probability formula for this specific calibrator (Section 7, Proposition 2,
states precisely what is and is not established by this).

**Part H — does empirical-Bernstein actually fix conditional-risk calibration, the way
Open Problem 4 speculated it might?** Tried, not just flagged. Swapped `calibrate_conditional`'s
Hoeffding UCB for the empirical-Bernstein bound (Maurer & Pontil, 2009), which uses the
per-sequence ratios' *sample variance* instead of only their `[0,1]` range, holding everything
else fixed. Swept the calibration budget, 20 trials per budget, against a shared 4,000-sequence
holdout:

| `n_cal` | Hoeffding-conditional skip rate | Bernstein-conditional skip rate | for reference: joint `calibrate()` at `n_cal=300` |
|---|---|---|---|
| 300 | 0.0% | 0.0% | 31.3% |
| 1,000 | 0.0% | **1.1%** | — |
| 3,000 | 7.0% | **8.5%** | — |
| 10,000 | 10.2% | **10.9%** | — |

Bernstein is genuinely, measurably tighter than Hoeffding at every budget where either gives a
nonzero answer — real, not noise, and directionally exactly what the variance-aware argument in
Section 3.6 predicted. It does not fix the `n_cal=300` collapse (still 0% skip), and by
`n_cal=10,000` — 33x the data joint calibration needed for 31.3% — the Bernstein/Hoeffding gap
has narrowed to roughly the width of run-to-run noise, while conditional calibration's skip
rate is still a third of what joint calibration got with a fraction of the data. The
per-sequence-ratio construction's coarseness (Section 3.6: a sequence with one skipped token
contributes a `{0,1}` outcome, not a continuum) is enough to swallow most of what a tighter
concentration inequality can offer on top of it. This part's answer to "was Bernstein the
missing piece": no, by itself — real help, wrong order of magnitude. Part I changes the
estimator, not just the inequality.

**Part I — does the combined ratio estimator (Cochran, 1977), correctly bounded and
correctly searched, actually close the gap?** `calibrate_combined_ratio_bernstein`: empirical-
Bernstein on the raw per-sequence numerator/denominator *counts* (not per-sequence ratios),
with a Bonferroni-corrected full-grid scan (`delta/(2M)` per point) rather than the
break-at-first-failure walk that is only valid under the monotonicity Section 3.2 relies on
and that this construction does not have. 12 trials per budget, plus one budget beyond Part
H's range:

| `n_cal` | skip rate | mean conditional risk | conditional violations |
|---|---|---|---|
| 300 | 0.0% | 0.0% | 0 / 12 |
| 1,000 | 0.0% | 0.0% | 0 / 12 |
| 3,000 | 0.0% | 0.0% | 0 / 12 |
| 10,000 | 28.1% | 0.082 | 0 / 12 |
| **30,000** | **31.5%** | **0.092** | **0 / 12** |

At `n_cal=30,000` this matches — technically slightly exceeds — joint calibration's 31.3% skip
rate at `n_cal=300` (Part A), while controlling the conditional risk that calibration never
covered. It is not a free lunch (still 0% at the first three budgets; the transition is steep,
not gradual, somewhere between 3,000 and 10,000), and it is not a proof that 100x is the
*necessary* cost, only that it is *sufficient* via this specific construction. But the
practical form of Open Problem 4 — does a working, distribution-free conditional-risk
calibrator exist at all, at a cost someone could actually pay — now has a yes, with a number
attached, where three earlier attempts had a flat no.

## 7. Unified theorem statements

Everything above compiled into one place, each claim labeled by what it actually is —
proven, proven-and-verified, empirical-only, or open — because collapsing these into
undifferentiated "theorems" is the exact failure this document already had to correct once
(Section 3.2). Read the status line before the guarantee line.

**Theorem 1 (Sequence-level joint-risk calibration).** *Status: proven (Section 3.2), and
empirically observed to hold across every configuration tested in Section 6 — several
hundred independent calibration draws across Parts A/B/C, zero violations.*

Let `s_t` be any `[0,1]`-valued statistic computed from the shallow forward pass that need
only be monotonically thresholdable against `TV(q_t, p_t)`, not accurate. Draw `n` i.i.d.
calibration sequences under teacher forcing, each of length `T`, and select `lambda_hat` via
the sequence-averaged Learn-Then-Test procedure of Sections 3.1-3.2 (grid walk, Hoeffding-
Bentkus upper confidence bound, monotone fixed-sequence stopping at level `delta`). Then

```
with probability >= 1 - delta over the calibration draw:
    Pr_{t ~ D}[ TV(q_t, p_t) > tau  AND  skip_{lambda_hat}(t) ] <= alpha
```

This is the corrected form of the guarantee this entire document is built on. It is *not*
`Pr[TV > tau | skip] <= alpha` — see Theorem 4 for that quantity.

**Proposition 2 (Token-level pooling's failure has a name and a formula).** *Status: the
underlying design-effect result is a proven, standard fact from clustered-sampling theory
(Kish, 1965); its application to explain this specific calibrator's failure is a derivation
verified empirically (Section 6, Part G), not an independently re-proven bound.*

If calibration instead pools `n*T` per-token samples as independent, and tokens within a
sequence have intraclass correlation `rho` (Section 6, Part G's ANOVA estimator) on the loss,
the Hoeffding-Bentkus slack computed with those `n*T` claimed degrees of freedom understates
the slack the true effective sample size `n*T / DEFF` would justify, where
`DEFF = 1 + (T-1)*rho`. The resulting threshold's true violation probability is therefore not
controlled at level `delta`, worsening as `rho` grows — confirmed directly (Section 6, Parts A
and G together): naive-pooling's real violation rate climbed `0% -> 0% -> 10%` as `rho`
(measured, not assumed) rose `0.36 -> 0.83 -> 0.95`, exactly tracking `DEFF`'s prediction that
naive pooling's *effective* sample size approaches the valid procedure's `n` — not its own
assumed `n*T` — as correlation strengthens.

**Empirical Finding 3 (Compounding: the proven guarantee holds, the wanted one does not).**
*Status: simulation-only, one synthetic generative model, one compounding mechanism, not a
theorem.*

Under an absorbing compounding model (Section 3.5) where a bad skip decision persistently
raises the difficulty of every later token in the sequence, deploying a teacher-forced
`lambda_hat` live left Theorem 1's guarantee intact — `0/60` joint-risk violations, mean
`0.031` against a `0.10` budget — while the conditional risk `Pr[TV > tau | skip]`, never
covered by Theorem 1, rose to a mean of `0.141` and exceeded the same nominal budget in
`60/60` trials. Section 3.5's Lipschitz-based worst-case bound (`~= T * beta * tau`, growing
with `T`) remains the only attempted *formal* treatment of long-horizon compounding, with
`beta` unmeasured and the bound unverified for tightness.

**Theorem 4 (Conditional-risk calibration is achievable, at a quantified cost).** *Status:
resolved in the practical sense (a working construction was found and empirically verified);
open in the theoretical sense (no lower bound establishes that this construction's cost is
necessary, only that it is sufficient). Three earlier natural constructions failed first,
and the reasons for each failure are established with more confidence than the fourth one's
success.*

Does a distribution-free procedure exist achieving `Pr[TV > tau | skip] <= alpha` with
probability `>= 1 - delta`, at a calibration budget in reach of Theorem 1's (`n_cal` on the
order of 300 sequences)? At *that specific budget*, no construction tried here achieves it.
At a larger budget, yes:

1. A per-sequence ratio estimator with a Hoeffding bound (Section 6, Part F) — collapses at
   `n_cal=300` (a sequence with one skipped token contributes a coarse `{0,1}` outcome, high
   variance).
2. A ratio-of-sums bounded via two range-scaled Hoeffding bounds (Section 6, Part F) — fails
   even harder, and — checked directly with a valid, non-monotonicity-dependent search — still
   fails even at `n_cal=30,000`; the count range `[0, T]` really is too loose a scale for this
   bound, independent of any search-procedure issue.
3. The same per-sequence ratio estimator with empirical-Bernstein instead of Hoeffding
   (Section 6, Part H) — genuinely tighter, still collapses at practical budgets: only a third
   of joint calibration's skip rate even at 33x the data.
4. **The combined ratio estimator (Cochran, 1977) — sums, not per-sequence ratios — bounded
   with empirical-Bernstein on the raw counts, searched via a Bonferroni-corrected full grid
   scan instead of the break-at-first-failure walk that requires monotonicity this
   construction doesn't have (Section 6, Part I).** This one works: `31.5%` skip rate at
   `0.092` mean conditional risk, `n_cal=30,000` — matching joint calibration's `31.3%` at
   `n_cal=300`, at roughly 100x the data, with zero conditional violations across the trials
   run. It still collapses to 0% at `n_cal <= 3,000` — the transition is steep, not gradual.

What separated success from failure was not one factor but three, independently confirmed:
the *estimator* (combined-ratio beats separate-ratio when unit sizes vary, a standard survey-
sampling result, not derived here), the *concentration inequality* (Bernstein beats Hoeffding
when true variance is well below the worst case, confirmed by comparing #2 against #4's
Bernstein-bounded version of the same ratio-of-sums idea), and the *search procedure*
(Bonferroni beats an invalid monotonicity assumption — checked directly: a spurious failure at
one `lambda` masked 25 genuinely safe points immediately below it in one calibration draw).
Getting any one of the three wrong reproduces one of constructions #1-3's failures even while
holding the other two fixed; #4 required getting all three right at once, and was only found
by testing each factor in isolation after the first three attempts, not by reasoning it out in
advance.

This does not prove `n_cal=30,000` is the *minimum* cost of an efficient conditional-risk
calibrator — only that it is *a* cost that works, via *this* construction. A genuine sample-
complexity lower bound, which would turn "achievable at this cost" into "this cost is
necessary," is not established here and is the actual remaining open problem. What is
established: the practical question this section opened with — does an efficient-enough
conditional-risk calibrator exist at all, or is the conditional guarantee simply out of reach
by these methods — has a yes, with a number attached, not a shrug.

## 8. References

- Schuster, Fisch, Gupta, Chan, Berant, Metzler, et al., "Confident Adaptive Language
  Modeling" (CALM), NeurIPS 2022 — early exit via a free per-token confidence measure
  calibrated with a distribution-free procedure.
- Angelopoulos, Bates, Candes, Jordan, Lei, "Learn Then Test: Calibrating Predictive
  Algorithms to Achieve Risk Control," 2021.
- Angelopoulos, Bates, Fisch, Lei, Schuster, "Conformal Risk Control," 2022.
- Elhoushi et al., "LayerSkip: Enabling Early Exit Inference and Self-Speculative Decoding,"
  2024 — shared-head early exit plus self-speculative verification, the closest existing
  system-level analog to Section 4's online loop.
- Ross, Gordon, Bagnell, "A Reduction of Imitation Learning and Structured Prediction to
  No-Regret Online Learning" (DAgger), 2011 — the data-aggregation strategy Section 6, Part C
  tests against a discard-and-refresh alternative; aggregation was directionally worse but,
  once measured against the quantity actually calibrated, did not diverge in this simulation
  (an earlier version of this document reported a divergence, which did not survive the
  joint/conditional correction in Section 3.2).
- Maurer, Pontil, "Empirical Bernstein Bounds and Sample Variance Penalization," 2009 — a
  variance-aware concentration bound, tried in Section 6, Part H against the conditional-risk
  calibration collapse from Part F: measurably tighter than Hoeffding, not enough to close
  the gap to joint calibration's sample efficiency.
- Kish, L., "Survey Sampling," 1965 — source of the design effect (`DEFF = 1 + (m-1)*rho`)
  underlying Section 6 Part G / Section 7 Proposition 2's explanation of why naive per-token
  pooling's real violation rate scales with intra-sequence correlation strength.
- Shrout, Fleiss, "Intraclass Correlations: Uses in Assessing Rater Reliability," 1979 — the
  one-way random-effects ANOVA intraclass-correlation estimator used to measure `rho` directly
  in Section 6, Part G, rather than assuming a value.
- Cochran, W. G., "Sampling Techniques," 3rd ed., 1977 — source of the combined-ratio-
  estimator-vs-separate-ratio-estimator distinction underlying Theorem 4 / Section 6, Part I:
  summing numerator and denominator across units before dividing is standardly more efficient
  than averaging per-unit ratios when unit sizes vary, which is exactly what let Part I's
  construction succeed where Part F's per-sequence-ratio attempt (Cochran's "separate" form)
  did not.
