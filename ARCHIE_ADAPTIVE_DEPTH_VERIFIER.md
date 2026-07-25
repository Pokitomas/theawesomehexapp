# Adaptive-depth layer skipping: closing the FLOP Trap and the Over-Pessimism Trap

This document is a design and a proof, not a shipped feature. No inference code in this
repository currently skips layers. Nothing here is admitted evidence under the
`archie-candidate-completion-manifest/v1` process in `ARCHIE_ARCHITECTURE_EXPERIMENTS.md`.
It exists so that if adaptive-depth decoding is built for Archie, it is built on a scheme
that cannot fail in either of the two ways below, instead of being discovered to fail
after the fact.

## 1. The problem, stated precisely

Let the base model have `L` transformer layers. For a decoding step `t`:

- `p_t` = the output distribution from the full `L`-layer forward pass.
- `q_t` = the output distribution obtained by exiting early, after only `L - k` layers,
  and applying the (shared or calibrated) LM head to that intermediate hidden state.

We want to skip the last `k` layers whenever it is safe to do so, where "safe" means the
generation is not meaningfully degraded. The natural safety condition is a bound on total
variation distance, `TV(q_t, p_t) <= tau`, because `TV` upper-bounds the probability that
sampling (or greedy argmax) from `q_t` disagrees with sampling from `p_t`.

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

Fix a finite grid of candidate thresholds `lambda_1 > lambda_2 > ... > lambda_M` over the
range of `s_t`. The decision rule at threshold `lambda` is:

```
skip_lambda(t) = 1{ s_t >= lambda }
```

Draw `n` i.i.d. calibration examples offline by running *both* the shallow and full model:
`(s_i, TV_i)` for `i = 1..n`, where `TV_i = TV(q_i, p_i)` is the true divergence at that
calibration point. Define the per-decision loss for a target tolerance `tau`:

```
ell_i(lambda) = 1{ s_i >= lambda } * 1{ TV_i > tau }
```

i.e. `ell_i(lambda)` fires only when the rule *would have skipped* and skipping *would have
been wrong*. The risk we actually need to control is

```
R(lambda) = Pr[ TV_t > tau  AND  skip_lambda(t) ]  -- more precisely, conditional on skipping:
R_cond(lambda) = Pr[ TV_t > tau | skip_lambda(t) ]
```

### 3.2 Monotonicity is the whole trick

Because `skip_lambda(t)` only shrinks as `lambda` increases (higher threshold = skip less
often = skip only on the safest cases as ranked by `s_t`), `R(lambda)` is **non-increasing
in `lambda`** by construction. This monotone structure is exactly what Learn-Then-Test
needs to turn a single concentration inequality into a valid selection procedure without
an exhaustive multiple-testing correction:

1. For each `lambda_j` on the grid, compute the empirical risk `R_hat(lambda_j)` from the
   calibration sample and a `(1 - delta)`-upper confidence bound `R_plus(lambda_j)` via a
   Hoeffding-Bentkus concentration bound (valid because `ell_i in {0,1}` is bounded).
2. Walk the grid from the most conservative `lambda_1` toward the most aggressive `lambda_M`
   and stop at the first (i.e. smallest, most aggressive) `lambda_j` for which
   `R_plus(lambda_j) <= delta_target` *and* every `lambda_{j'} > lambda_j` already passed.
   Call this `lambda_hat`.
3. Fixed-sequence testing along a monotone grid controls the family-wise error at level
   `delta` with a *single* test at the selected point, not a Bonferroni correction over all
   `M` grid points — this is what keeps the calibration itself statistically efficient.

**Theorem (informal).** With probability at least `1 - delta` over the draw of the
calibration set, the selected `lambda_hat` satisfies

```
Pr_{t ~ D}[ TV(q_t, p_t) > tau  |  skip at t ] <= delta_target
```

i.e. `Pr[TV(q_t, p_t) <= tau | skip] >= 1 - delta_target`, distribution-free, with no
assumption on the shape of `p_t`, `q_t`, or `s_t` beyond boundedness of the loss. This is
the requested guarantee `Pr[TV <= tau] >= 1 - delta` — but note precisely what changed: the
bound is a *property of a threshold chosen once offline*, not a value computed per token.
`V_t` in the original framing is replaced by the pair `(s_t, lambda_hat)`, where `s_t` is
free and `lambda_hat` is a constant baked in after calibration.

*Proof sketch.* Each `ell_i(lambda)` is an i.i.d. Bernoulli-like bounded random variable
with mean `R(lambda)`. The Hoeffding-Bentkus bound gives, for any fixed `lambda`, a p-value
for the null `R(lambda) > delta_target` that is valid regardless of the true distribution of
`(s_i, TV_i)`, using only boundedness of `ell_i` in `[0,1]`. Because `R(lambda)` is
non-increasing in `lambda`, rejecting the null at the single boundary point `lambda_hat`
implies rejection at every `lambda >= lambda_hat` as well (a graphical/fixed-sequence
argument), so testing only the boundary controls the family-wise error over the whole
"skip region" `[lambda_hat, lambda_1]` at level `delta`, without paying a `1/M` Bonferroni
factor for the grid size. This is the standard Learn-Then-Test argument (Angelopoulos et
al., 2021, "Learn Then Test: Calibrating Predictive Algorithms to Achieve Risk Control");
it is reproduced here only to make explicit that nothing in it requires `s_t` to be
accurate — only bounded and monotonically thresholdable. &#8718;

### 3.3 Why this specifically kills the Over-Pessimism Trap

The trap was: a cheap, honest bound has to be padded with margin, so it fires constantly.
Learn-Then-Test never pads by hand. It searches the monotone frontier for the *smallest*
`lambda` — i.e. the *most aggressive, lowest-fallback* rule — that the calibration data can
certify at the target confidence. The resulting fallback rate is not a designer's guess;
it's a number you read off the calibration run (e.g. "at `tau = 0.05`, `delta = 0.01`, the
calibrated rule skips X% of tokens on the calibration distribution"). If that number is
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

## 4. Online algorithm

```
# Offline, once, amortized over all future inference:
for i in 1..n:
    run full L-layer forward pass on calibration example i
    record s_i (from the shallow intermediate state, computed for free along the way)
    record TV_i = TV(q_i, p_i)
    record bucket_i
for each bucket b:
    lambda_hat[b] = learn_then_test(
        {(s_i, TV_i) : bucket_i == b}, tau=tau, delta=delta_b, grid=Lambda,
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

- This does not claim any particular skip rate or realized speedup for Archie's Qwen3-1.7B
  candidate. That number depends on how well the chosen `s_t` ranks `TV(q_t, p_t)` for this
  specific model and task distribution, and is only knowable by running the calibration
  procedure in Section 3 against real data and reporting `lambda_hat` and the resulting
  empirical skip rate — an `archie-metrics-receipt/v1`-style artifact, not a claim in this
  file.
- This does not claim a strict *per-token* certificate. The guarantee proved in Section 3.2
  is a conditional-probability guarantee over the calibration distribution
  (`Pr[TV > tau | skip] <= delta`), which is the correct and load-bearing formalization for
  a decoding pipeline, but it is not a proof that no single skip decision is ever wrong —
  no O(d) statistic can promise that without occasionally being wrong, by a no-free-lunch
  argument identical in spirit to the FLOP Trap itself: a function cheap enough to be free
  cannot also certify individual full-depth outcomes it never computed.
- Distribution shift between the calibration sample and live traffic voids the guarantee,
  same as any calibration-based method (conformal prediction, LTT, RCPS). Recalibration
  cadence is an operational question this document does not answer.

## 6. References

- Schuster, Fisch, Gupta, Chan, Berant, Metzler, et al., "Confident Adaptive Language
  Modeling" (CALM), NeurIPS 2022 — early exit via a free per-token confidence measure
  calibrated with a distribution-free procedure.
- Angelopoulos, Bates, Candes, Jordan, Lei, "Learn Then Test: Calibrating Predictive
  Algorithms to Achieve Risk Control," 2021.
- Angelopoulos, Bates, Fisch, Lei, Schuster, "Conformal Risk Control," 2022.
- Elhoushi et al., "LayerSkip: Enabling Early Exit Inference and Self-Speculative Decoding,"
  2024 — shared-head early exit plus self-speculative verification, the closest existing
  system-level analog to Section 4's online loop.
