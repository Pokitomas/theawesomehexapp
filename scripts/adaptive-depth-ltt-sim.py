#!/usr/bin/env python3
"""Empirical stress test for ARCHIE_ADAPTIVE_DEPTH_VERIFIER.md.

Synthetic (no real Qwen3 weights involved) simulation of the (s_t, TV_t)
relationship the document assumes. Two rounds of findings live here, in order:

Round 1 (Parts A-C): validated the Section 3.1 fix against the naive per-token
calibration it replaced, and investigated a claimed compounding gap under live
rollout with on-policy recalibration.

Round 2 (Part F, and the corrections now baked into Parts A-C): re-examining
round 1 found calibrate() only ever controls joint_risk = Pr[bad AND skip], not
conditional_risk = Pr[bad | skip] -- the quantity the document's Theorem in
Section 3.2 actually claims, and the one operationally meaningful to a user
("given we skipped, how likely were we wrong"). Round 1's compounding-gap and
aggregation-divergence numbers were computed by checking conditional_risk
against a calibrator that only ever targeted joint_risk -- a real bug in this
file, not a real divergence in the calibrated guarantee. Round 2 fixes that
(Parts A-C now check joint_risk, and separately report conditional_risk without
conflating the two), and Part F then tries the "obvious" fix -- calibrate
conditional_risk directly -- and finds it collapses to near-zero skip rate at
the same calibration budget: conditional-risk calibration is a substantially
harder, higher-variance statistical problem than joint-risk calibration, and
that gap is not resolved by this file. See the document's Section 6.
"""
from __future__ import annotations

import bisect
import json
import math
import random
import statistics
from dataclasses import dataclass

TAU = 0.08
ALPHA = 0.10
DELTA = 0.05
T = 40
GRID = [1.0 - i / 200 for i in range(201)]  # 1.00 down to 0.00, step 0.005
SEED = 20260725


def hoeffding_ucb(mean: float, n: int, delta: float) -> float:
    slack = math.sqrt(math.log(1.0 / delta) / (2.0 * n))
    return min(1.0, mean + slack)


@dataclass
class Sequence:
    s: list  # cheap statistic per token
    tv: list  # true TV per token
    bad: list  # 1{tv > tau} per token


def sample_base_difficulty(rng: random.Random) -> float:
    return rng.betavariate(1.0, 15.0)  # mean ~0.0625, most tokens "easy"


def logistic(x: float) -> float:
    if x > 30:
        return 1.0
    if x < -30:
        return 0.0
    return 1.0 / (1.0 + math.exp(-x))


# s_t is a logistic-squashed, noisy readout of "is d_t below tau" -- informative
# (Pearson r(s, d) ~= -0.57 empirically) but deliberately imperfect, and never
# saturates at exactly 0/1 (an earlier version used clip(1-d+noise, 0, 1), which
# put >10% of mass exactly at s=1.0 regardless of d and silently broke the
# calibration; this was caught by the diagnostic in this file's history, not
# assumed away).
LOGIT_K = 20.0
LOGIT_NOISE_SD = 1.5


def make_teacher_forced_sequence(rng: random.Random, seq_offset_sd: float) -> Sequence:
    offset = rng.gauss(0.0, seq_offset_sd)  # shared per-sequence latent -> intra-sequence dependence
    s, tv, bad = [], [], []
    for _ in range(T):
        d = min(1.0, max(0.0, sample_base_difficulty(rng) + offset))
        noisy_s = logistic(LOGIT_K * (TAU - d) + rng.gauss(0.0, LOGIT_NOISE_SD))
        s.append(noisy_s)
        tv.append(d)
        bad.append(1.0 if d > TAU else 0.0)
    return Sequence(s, tv, bad)


def seq_loss_lookup(seq: Sequence):
    """Returns a function lambda -> ell(lambda) = mean_t 1{s_t>=lambda}*bad_t via sort + bisect."""
    pairs = sorted(zip(seq.s, seq.bad))
    s_sorted = [p[0] for p in pairs]
    bad_sorted = [p[1] for p in pairs]
    n = len(bad_sorted)
    suffix_bad = [0.0] * (n + 1)
    for i in range(n - 1, -1, -1):
        suffix_bad[i] = suffix_bad[i + 1] + bad_sorted[i]

    def ell(lam: float) -> float:
        idx = bisect.bisect_left(s_sorted, lam)
        return suffix_bad[idx] / n

    def skip_rate(lam: float) -> float:
        idx = bisect.bisect_left(s_sorted, lam)
        return (n - idx) / n

    return ell, skip_rate


def calibrate(sequences, grid, delta: float):
    """Sequence-level LTT: sequence-averaged ell_i(lambda), walk grid from conservative
    (lambda=1.0) down, stop at the last point before R_plus would exceed alpha."""
    lookups = [seq_loss_lookup(s) for s in sequences]
    n = len(sequences)
    lambda_hat = grid[0]
    for lam in grid:
        r_hat = sum(ell(lam) for ell, _ in lookups) / n
        r_plus = hoeffding_ucb(r_hat, n, delta)
        if r_plus <= ALPHA:
            lambda_hat = lam
        else:
            break
    return lambda_hat


def seq_conditional_lookup(seq: Sequence):
    """Per-lambda (bad_and_skip_count, skip_count) for one sequence, via the same
    sort-once-then-bisect trick as seq_loss_lookup, but keeping counts unnormalized
    so the caller can form a genuine conditional rate (not a joint one)."""
    pairs = sorted(zip(seq.s, seq.bad))
    s_sorted = [p[0] for p in pairs]
    bad_sorted = [p[1] for p in pairs]
    n = len(bad_sorted)
    suffix_bad = [0.0] * (n + 1)
    for i in range(n - 1, -1, -1):
        suffix_bad[i] = suffix_bad[i + 1] + bad_sorted[i]

    def counts(lam: float):
        idx = bisect.bisect_left(s_sorted, lam)
        skip_count = n - idx
        bad_and_skip_count = suffix_bad[idx]
        return bad_and_skip_count, skip_count

    return counts


def calibrate_conditional(sequences, grid, delta: float):
    """Correctly targets Pr[bad | skip] <= alpha (what Section 3.2's theorem actually
    claims), instead of calibrate()'s Pr[bad AND skip] <= alpha (what calibrate()
    actually controls -- these coincide only when skip rate is near 1, and diverge
    badly otherwise: see the joint-vs-conditional gap this function exists to close).

    Per sequence i, if it has at least one skipped token at threshold lambda, its
    loss is that sequence's OWN conditional bad-rate among its skipped tokens:
    ell_i(lambda) = (bad-and-skip count in i) / (skip count in i). Sequences with
    zero skipped tokens at this lambda contribute no information about the
    conditional risk and are excluded from both the mean and the sample size used
    in the Hoeffding bound -- using the wrong n here (e.g. all n sequences instead
    of the n_eff that actually skipped) would silently reintroduce a version of the
    same joint/conditional confusion this function is meant to fix.

    This gives a valid distribution-free bound on the SEQUENCE-averaged conditional
    rate among sequences that skip at least once -- not exactly the TOKEN-level
    population ratio Pr[bad|skip] (a ratio of sums, not a mean of ratios), which can
    differ from this when skip counts vary a lot between sequences. Close enough to
    be the right target to calibrate against; not claimed to be identical.
    """
    lookups = [seq_conditional_lookup(s) for s in sequences]
    lambda_hat = grid[0]
    for lam in grid:
        rates = []
        for counts in lookups:
            bad_and_skip, skip_count = counts(lam)
            if skip_count > 0:
                rates.append(bad_and_skip / skip_count)
        n_eff = len(rates)
        if n_eff == 0:
            lambda_hat = lam  # nobody skipped at this lambda: vacuously within budget
            continue
        r_hat = sum(rates) / n_eff
        r_plus = hoeffding_ucb(r_hat, n_eff, delta)
        if r_plus <= ALPHA:
            lambda_hat = lam
        else:
            break
    return lambda_hat


def empirical_bernstein_ucb(values, delta: float) -> float:
    """Maurer & Pontil (2009): for i.i.d. X_i in [0,1], a tighter alternative to Hoeffding
    that uses the *sample* variance instead of only the range. Section 3.6/7 flagged this
    as the untried next step for the conditional-risk calibration collapse -- Hoeffding's
    range-only bound treats a per-sequence ratio the same whether its true variance is
    tiny or close to the Bernoulli worst case of 1/4, and per-sequence ratios here are
    often close to that worst case (a sequence with one skipped token contributes a
    {0,1} outcome). Needs n>=2 to estimate a variance at all."""
    n = len(values)
    if n <= 1:
        return 1.0
    mean = sum(values) / n
    var = sum((x - mean) ** 2 for x in values) / (n - 1)
    term1 = math.sqrt(2.0 * var * math.log(2.0 / delta) / n)
    term2 = 7.0 * math.log(2.0 / delta) / (3.0 * (n - 1))
    return min(1.0, mean + term1 + term2)


def calibrate_conditional_bernstein(sequences, grid, delta: float):
    """Same target and same per-sequence-ratio construction as calibrate_conditional(),
    with the Hoeffding UCB swapped for the empirical-Bernstein one above -- isolates
    whether the concentration inequality was the bottleneck, holding everything else
    (including the sequence-averaged-ratio formulation's own bias-vs-the-true-ratio-
    of-sums, noted in calibrate_conditional's docstring) fixed."""
    lookups = [seq_conditional_lookup(s) for s in sequences]
    lambda_hat = grid[0]
    for lam in grid:
        rates = []
        for counts in lookups:
            bad_and_skip, skip_count = counts(lam)
            if skip_count > 0:
                rates.append(bad_and_skip / skip_count)
        n_eff = len(rates)
        if n_eff == 0:
            lambda_hat = lam
            continue
        if empirical_bernstein_ucb(rates, delta) <= ALPHA:
            lambda_hat = lam
        else:
            break
    return lambda_hat


def bernstein_ucb_raw(values, b: float, delta: float) -> float:
    """Empirical-Bernstein UCB for values bounded in [0, b] (not normalized to [0,1] --
    used for raw per-sequence counts, which live in [0, T])."""
    n = len(values)
    if n <= 1:
        return b
    mean = sum(values) / n
    var = sum((x - mean) ** 2 for x in values) / (n - 1)
    term1 = math.sqrt(2.0 * var * math.log(2.0 / delta) / n)
    term2 = 7.0 * b * math.log(2.0 / delta) / (3.0 * (n - 1))
    return mean + term1 + term2


def bernstein_lcb_raw(values, b: float, delta: float) -> float:
    n = len(values)
    if n <= 1:
        return 0.0
    mean = sum(values) / n
    var = sum((x - mean) ** 2 for x in values) / (n - 1)
    term1 = math.sqrt(2.0 * var * math.log(2.0 / delta) / n)
    term2 = 7.0 * b * math.log(2.0 / delta) / (3.0 * (n - 1))
    return max(0.0, mean - term1 - term2)


def calibrate_combined_ratio_bernstein(sequences, grid, delta: float):
    """A fourth attempt at conditional-risk calibration, found only after the first
    "ratio-of-sums" attempt (calibrate_ratio_of_sums_range_scaled, tested in Part F) was
    dismissed as a dead end. Two things were wrong with that dismissal, not one:

    1. It bounded numerator and denominator sums with plain (range-scaled) Hoeffding,
       which is loose the same way calibrate_conditional's per-sequence-Hoeffding was
       loose -- fixed here by using empirical-Bernstein (the raw, unnormalized version
       above) on the per-sequence COUNTS instead of ratios. This also isolates the
       actual known-better estimator: survey sampling calls U_sum/V_sum the "combined
       ratio estimator" and the per-sequence mean-of-ratios the "separate ratio
       estimator" (Cochran, 1977); the combined estimator is standardly more efficient
       when unit sizes (here, skip counts per sequence) vary, which they do heavily.
    2. The grid search itself was invalid for this construction. calibrate() and
       calibrate_conditional() can walk the grid and stop at the first failure because
       their UCB's slack term does not depend on lambda, which makes R_plus provably
       monotone (Section 3.2) -- the empirical-Bernstein slack DOES depend on lambda
       (through the empirical variance, which is not monotone as small-denominator
       sequences enter and leave the qualifying set), so "stop at first failure" can
       -- and, checked directly, does -- stop at a transient bad point and silently
       discard genuinely safe lambdas further down. The valid fix without assuming
       monotonicity: Bonferroni across all M grid points (test each at delta/(2M), the
       extra factor of 2 for the two one-sided U/V bounds), scan the WHOLE grid, keep
       the most aggressive (smallest) lambda that passes its own test. This is a
       genuine validity requirement, not an optimization -- the non-Bonferroni version
       of this exact function scored much better numbers that were not actually valid.
    """
    lookups = [seq_conditional_lookup(s) for s in sequences]
    M = len(grid)
    per_point_delta = delta / (2.0 * M)
    lambda_hat = grid[0]
    for lam in grid:
        us, vs = [], []
        for counts in lookups:
            u, v = counts(lam)
            us.append(u)
            vs.append(v)
        if sum(vs) == 0:
            continue  # vacuous (nobody skips): grid[0] already covers this case
        u_plus = bernstein_ucb_raw(us, T, per_point_delta)
        v_minus = bernstein_lcb_raw(vs, T, per_point_delta)
        if v_minus <= 0:
            continue  # denominator not yet certifiable at this lambda; keep scanning
        if u_plus / v_minus <= ALPHA:
            lambda_hat = lam  # scan the whole grid; take the most aggressive pass
    return lambda_hat


def calibrate_naive_token_pooled(sequences, grid, delta: float):
    """The rejected earlier-draft approach: treat every token as an independent sample,
    using n*T as the effective sample size instead of n."""
    lookups = [seq_loss_lookup(s) for s in sequences]
    n_tokens = len(sequences) * T
    lambda_hat = grid[0]
    for lam in grid:
        total_bad = sum(ell(lam) * T for ell, _ in lookups)  # count, not mean
        r_hat = total_bad / n_tokens
        r_plus = hoeffding_ucb(r_hat, n_tokens, delta)
        if r_plus <= ALPHA:
            lambda_hat = lam
        else:
            break
    return lambda_hat


def risk_breakdown(lam: float, population):
    """Returns (joint_risk, conditional_risk, skip_rate) at threshold `lam`.

    joint_risk = Pr[bad AND skip] -- this is what calibrate() and
    calibrate_naive_token_pooled() actually control (it is exactly R_hat(lambda)
    evaluated on `population`), and is the correct quantity to check when asking
    "did the calibration guarantee hold." conditional_risk = Pr[bad | skip] -- the
    quantity a user actually cares about ("given we skipped, how likely were we
    wrong"), which calibrate() does NOT target. These were conflated in an earlier
    version of this file: violations were checked against conditional_risk while
    the calibrators only ever controlled joint_risk. That bug made Section 3.5's
    compounding gap look far more severe than the proven guarantee's actual
    behavior under compounding (see the module docstring and Section 6 of the
    document). Both are returned here, deliberately, so callers cannot repeat that
    mistake by only having access to one of them.
    """
    lookups = [seq_loss_lookup(s) for s in population]
    ells = [ell(lam) for ell, _ in lookups]
    skips = [sk(lam) for _, sk in lookups]
    joint_risk = statistics.mean(ells)
    total_bad_tokens = sum(e * T for e in ells)
    total_skip_tokens = sum(sk * T for sk in skips)
    conditional_risk = (total_bad_tokens / total_skip_tokens) if total_skip_tokens > 0 else 0.0
    return joint_risk, conditional_risk, statistics.mean(skips)


def part_a(rng: random.Random):
    """Violations are checked against joint_risk -- the quantity calibrate() and
    calibrate_naive_token_pooled() actually target -- not conditional_risk, which
    neither calibrator controls (conditional_risk is still reported, descriptively).

    Swept over intra-sequence correlation strength (seq_offset_sd) rather than one
    fixed value. An earlier version of this function fixed seq_offset_sd=0.05 and,
    checked against joint_risk, found the naive per-token-pooled calibrator did NOT
    violate its budget in 250/250 trials -- the opposite of the intended
    demonstration. That was not a wrong result, it was an unfair test: naive
    pooling's invalidity is a statement about how much it understates variance
    from intra-sequence dependence, and 0.05 was too weak a correlation to expose
    it against the correct criterion (it only looked like it broke when checked,
    incorrectly, against conditional_risk in that earlier version). Sweeping
    correlation strength shows the actual mechanism -- naive pooling's violation
    rate should climb with correlation strength while the valid calibrator's does
    not -- instead of relying on one number that happened to look dramatic for the
    wrong reason.
    """
    n_cal = 300
    n_trials = 80
    n_holdout = 4000
    seq_offset_sds = [0.05, 0.15, 0.30]

    results = {}
    for seq_offset_sd in seq_offset_sds:
        holdout = [make_teacher_forced_sequence(rng, seq_offset_sd) for _ in range(n_holdout)]

        seq_violations = 0
        naive_violations = 0
        seq_skip_rates, naive_skip_rates = [], []
        seq_lambdas, naive_lambdas = [], []
        seq_conditional_risks, naive_conditional_risks = [], []

        for _ in range(n_trials):
            cal = [make_teacher_forced_sequence(rng, seq_offset_sd) for _ in range(n_cal)]
            lam_seq = calibrate(cal, GRID, DELTA)
            lam_naive = calibrate_naive_token_pooled(cal, GRID, DELTA)
            seq_lambdas.append(lam_seq)
            naive_lambdas.append(lam_naive)

            joint_seq, cond_seq, sk_seq = risk_breakdown(lam_seq, holdout)
            joint_naive, cond_naive, sk_naive = risk_breakdown(lam_naive, holdout)
            seq_skip_rates.append(sk_seq)
            naive_skip_rates.append(sk_naive)
            seq_conditional_risks.append(cond_seq)
            naive_conditional_risks.append(cond_naive)
            if joint_seq > ALPHA:
                seq_violations += 1
            if joint_naive > ALPHA:
                naive_violations += 1

        results[f"seq_offset_sd_{seq_offset_sd}"] = {
            "sequence_level": {
                "violation_rate": seq_violations / n_trials,
                "mean_skip_rate": statistics.mean(seq_skip_rates),
                "mean_lambda_hat": statistics.mean(seq_lambdas),
                "mean_conditional_risk_fyi": statistics.mean(seq_conditional_risks),
            },
            "naive_token_pooled": {
                "violation_rate": naive_violations / n_trials,
                "mean_skip_rate": statistics.mean(naive_skip_rates),
                "mean_lambda_hat": statistics.mean(naive_lambdas),
                "mean_conditional_risk_fyi": statistics.mean(naive_conditional_risks),
            },
        }

    return {
        "n_trials_per_correlation_level": n_trials,
        "n_cal_per_trial": n_cal,
        "n_holdout": n_holdout,
        "target_delta": DELTA,
        "target_alpha": ALPHA,
        "violation_criterion": "joint_risk > alpha (the quantity actually calibrated)",
        "by_correlation_strength": results,
    }


def make_compounding_rollout(rng: random.Random, lam: float, compounding_shift: float):
    """Live rollout: once a token is skipped-and-bad under threshold `lam`, every
    later token in the sequence is drawn from a shifted ("corrupted context")
    distribution -- corruption is absorbing, because context accumulates in an
    autoregressive model rather than resetting each step. This is the mechanism
    Section 3.5 names: the input distribution to later tokens depends on the
    policy's own past decisions, which teacher-forced calibration never sees.
    (An earlier, non-absorbing version of this function -- corruption affecting
    only the immediately next token -- showed almost no effect at any shift
    magnitude: with corruption this rare and this short-lived, its contribution
    to a population average washes out. That was a modeling bug, not a finding;
    fixed here.)"""
    s, tv, bad = [], [], []
    corrupted = False
    for _ in range(T):
        base = sample_base_difficulty(rng)
        d = min(1.0, max(0.0, base + (compounding_shift if corrupted else 0.0)))
        noisy_s = logistic(LOGIT_K * (TAU - d) + rng.gauss(0.0, LOGIT_NOISE_SD))
        s.append(noisy_s)
        tv.append(d)
        is_bad = 1.0 if d > TAU else 0.0
        bad.append(is_bad)
        skipped = noisy_s >= lam
        corrupted = corrupted or (skipped and is_bad == 1.0)  # absorbing
    return Sequence(s, tv, bad)


def part_b(rng: random.Random):
    """Reports joint_risk (the actual calibration target -- expect it to mostly hold)
    and conditional_risk (the intuitive "given we skipped, were we wrong" quantity --
    NOT what was calibrated, and the one that drifts visibly under compounding) side
    by side, with separate violation counts for each. Collapsing these into one
    number, as an earlier version of this file did, is exactly the bug Part A's
    docstring warns about, and it manufactured a false "the proof breaks under
    compounding" conclusion: the proof (joint_risk <= alpha) mostly held; a
    quantity that was never proved (conditional_risk <= alpha) did not."""
    n_cal = 300
    n_holdout = 4000
    n_trials = 60
    seq_offset_sd = 0.05
    compounding_shift = 0.10

    tf_cal = [make_teacher_forced_sequence(rng, seq_offset_sd) for _ in range(n_cal)]
    lam_tf = calibrate(tf_cal, GRID, DELTA)

    joint_tf, cond_tf, skip_tf = [], [], []
    joint_on, cond_on, skip_on = [], [], []
    onpolicy_lambdas = []

    for _ in range(n_trials):
        live_pop_tf_lambda = [make_compounding_rollout(rng, lam_tf, compounding_shift) for _ in range(n_holdout)]
        j, c, sk = risk_breakdown(lam_tf, live_pop_tf_lambda)
        joint_tf.append(j); cond_tf.append(c); skip_tf.append(sk)

        onpolicy_cal = [make_compounding_rollout(rng, lam_tf, compounding_shift) for _ in range(n_cal)]
        lam_onpolicy = calibrate(onpolicy_cal, GRID, DELTA)
        onpolicy_lambdas.append(lam_onpolicy)

        live_pop_onpolicy = [make_compounding_rollout(rng, lam_onpolicy, compounding_shift) for _ in range(n_holdout)]
        j2, c2, sk2 = risk_breakdown(lam_onpolicy, live_pop_onpolicy)
        joint_on.append(j2); cond_on.append(c2); skip_on.append(sk2)

    return {
        "n_trials": n_trials,
        "n_cal_per_trial": n_cal,
        "n_holdout_per_trial": n_holdout,
        "compounding_shift": compounding_shift,
        "target_alpha": ALPHA,
        "lambda_hat_teacher_forced": lam_tf,
        "teacher_forced_threshold_deployed_live": {
            "mean_joint_risk": statistics.mean(joint_tf),
            "joint_violation_rate": sum(1 for r in joint_tf if r > ALPHA) / n_trials,
            "mean_conditional_risk": statistics.mean(cond_tf),
            "conditional_violation_rate": sum(1 for r in cond_tf if r > ALPHA) / n_trials,
            "mean_skip_rate": statistics.mean(skip_tf),
        },
        "single_round_onpolicy_recalibration": {
            "mean_lambda_hat": statistics.mean(onpolicy_lambdas),
            "mean_joint_risk": statistics.mean(joint_on),
            "joint_violation_rate": sum(1 for r in joint_on if r > ALPHA) / n_trials,
            "mean_conditional_risk": statistics.mean(cond_on),
            "conditional_violation_rate": sum(1 for r in cond_on if r > ALPHA) / n_trials,
            "mean_skip_rate": statistics.mean(skip_on),
        },
    }


def part_c(rng: random.Random):
    """Does iterating on-policy recalibration converge, and does discarding stale
    rounds vs. aggregating them (textbook DAgger) matter? Violations are checked
    against joint_risk, the quantity actually calibrated (an earlier version of
    this function checked conditional_risk instead, and reported both strategies
    catastrophically diverging under compounding -- that was the same joint/
    conditional bug as Part B, not a real divergence: see part_f for what actually
    remains hard here). mean_conditional_risk is still reported per strategy,
    descriptively, since it is the quantity a deployer would actually care about
    even though it is not what is being controlled."""
    n_chains = 12
    n_rounds = 5
    n_cal = 200
    n_holdout = 1500
    compounding_shift = 0.10
    seq_offset_sd = 0.05

    tf_cal = [make_teacher_forced_sequence(rng, seq_offset_sd) for _ in range(n_cal)]
    lam0 = calibrate(tf_cal, GRID, DELTA)

    discard_final_joint, discard_final_cond = [], []
    aggregate_final_joint, aggregate_final_cond = [], []
    discard_violation_at_round = [0] * n_rounds
    aggregate_violation_at_round = [0] * n_rounds

    for _ in range(n_chains):
        lam_discard = lam0
        for r in range(n_rounds):
            pop = [make_compounding_rollout(rng, lam_discard, compounding_shift) for _ in range(n_holdout)]
            joint, _, _ = risk_breakdown(lam_discard, pop)
            if joint > ALPHA:
                discard_violation_at_round[r] += 1
            cal = [make_compounding_rollout(rng, lam_discard, compounding_shift) for _ in range(n_cal)]
            lam_discard = calibrate(cal, GRID, DELTA)
        final_pop = [make_compounding_rollout(rng, lam_discard, compounding_shift) for _ in range(n_holdout)]
        joint_f, cond_f, _ = risk_breakdown(lam_discard, final_pop)
        discard_final_joint.append(joint_f)
        discard_final_cond.append(cond_f)

        lam_agg = lam0
        aggregated = []
        for r in range(n_rounds):
            pop = [make_compounding_rollout(rng, lam_agg, compounding_shift) for _ in range(n_holdout)]
            joint, _, _ = risk_breakdown(lam_agg, pop)
            if joint > ALPHA:
                aggregate_violation_at_round[r] += 1
            aggregated.extend(make_compounding_rollout(rng, lam_agg, compounding_shift) for _ in range(n_cal))
            lam_agg = calibrate(aggregated, GRID, DELTA)
        final_pop_agg = [make_compounding_rollout(rng, lam_agg, compounding_shift) for _ in range(n_holdout)]
        joint_fa, cond_fa, _ = risk_breakdown(lam_agg, final_pop_agg)
        aggregate_final_joint.append(joint_fa)
        aggregate_final_cond.append(cond_fa)

    return {
        "n_chains": n_chains,
        "n_rounds": n_rounds,
        "n_cal_per_round": n_cal,
        "n_holdout_per_round": n_holdout,
        "compounding_shift": compounding_shift,
        "target_alpha": ALPHA,
        "violation_criterion": "joint_risk > alpha (the quantity actually calibrated)",
        "lambda_hat_round0": lam0,
        "discard_history_each_round": {
            "joint_violation_rate_per_round": [v / n_chains for v in discard_violation_at_round],
            "mean_final_joint_risk": statistics.mean(discard_final_joint),
            "mean_final_conditional_risk_fyi": statistics.mean(discard_final_cond),
        },
        "dagger_style_aggregate_each_round": {
            "joint_violation_rate_per_round": [v / n_chains for v in aggregate_violation_at_round],
            "mean_final_joint_risk": statistics.mean(aggregate_final_joint),
            "mean_final_conditional_risk_fyi": statistics.mean(aggregate_final_cond),
        },
    }


def part_f(rng: random.Random):
    """The real fix for the Part A/B/C joint-vs-conditional gap would be to just
    calibrate the conditional risk directly -- calibrate_conditional() does exactly
    that, correctly (per-sequence ratio among sequences that skip at least once,
    Hoeffding on that). This tests whether that "obvious fix" is actually usable:
    same teacher-forced setup as Part A, same n_cal budget, compare the two
    calibrators' skip rate and achieved conditional risk across repeated trials.

    Two variants of conditional calibration are checked at the same n_cal=300
    budget calibrate() uses successfully: calibrate_conditional (per-sequence
    ratio) and a second, worse attempt tried during this investigation --
    ratio-of-sums via a range-scaled (0..T) Hoeffding bound on the numerator and
    denominator separately -- included to show it is not merely "the wrong
    formula," a structurally different construction fails even harder."""
    n_cal = 300
    n_trials = 60
    n_holdout = 4000
    seq_offset_sd = 0.05

    def calibrate_ratio_of_sums(sequences, grid, delta):
        lookups = [seq_conditional_lookup(s) for s in sequences]
        n = len(sequences)
        lambda_hat = grid[0]
        for lam in grid:
            us, vs = [], []
            for counts in lookups:
                u, v = counts(lam)
                us.append(u)
                vs.append(v)
            u_mean = sum(us) / n
            v_mean = sum(vs) / n
            slack = T * math.sqrt(math.log(2.0 / delta) / (2 * n))
            u_plus = u_mean + slack
            v_minus = v_mean - slack
            if v_minus <= 0:
                break
            if u_plus / v_minus <= ALPHA:
                lambda_hat = lam
            else:
                break
        return lambda_hat

    holdout = [make_teacher_forced_sequence(rng, seq_offset_sd) for _ in range(n_holdout)]

    joint_skip, joint_cond_violation = [], 0
    cond_skip, cond_cond_violation = [], 0
    ratio_skip, ratio_cond_violation = [], 0

    for _ in range(n_trials):
        cal = [make_teacher_forced_sequence(rng, seq_offset_sd) for _ in range(n_cal)]

        lam_joint = calibrate(cal, GRID, DELTA)
        _, cond_j, sk_j = risk_breakdown(lam_joint, holdout)
        joint_skip.append(sk_j)
        if cond_j > ALPHA:
            joint_cond_violation += 1

        lam_cond = calibrate_conditional(cal, GRID, DELTA)
        _, cond_c, sk_c = risk_breakdown(lam_cond, holdout)
        cond_skip.append(sk_c)
        if cond_c > ALPHA:
            cond_cond_violation += 1

        lam_ratio = calibrate_ratio_of_sums(cal, GRID, DELTA)
        _, cond_r, sk_r = risk_breakdown(lam_ratio, holdout)
        ratio_skip.append(sk_r)
        if cond_r > ALPHA:
            ratio_cond_violation += 1

    return {
        "n_trials": n_trials,
        "n_cal_per_trial": n_cal,
        "n_holdout": n_holdout,
        "target_alpha": ALPHA,
        "note": "violation here is checked against conditional_risk, the quantity these "
                "calibrators are actually trying to control (unlike Parts A-C's joint check)",
        "joint_calibrate_evaluated_against_conditional": {
            "mean_skip_rate": statistics.mean(joint_skip),
            "conditional_violation_rate": joint_cond_violation / n_trials,
        },
        "calibrate_conditional_per_sequence_ratio": {
            "mean_skip_rate": statistics.mean(cond_skip),
            "conditional_violation_rate": cond_cond_violation / n_trials,
        },
        "calibrate_ratio_of_sums_range_scaled": {
            "mean_skip_rate": statistics.mean(ratio_skip),
            "conditional_violation_rate": ratio_cond_violation / n_trials,
        },
    }


def intraclass_correlation(sequences) -> float:
    """One-way random-effects ANOVA intraclass correlation of TV across tokens within a
    sequence: rho = (MSB - MSW) / (MSB + (T-1)*MSW). Standard estimator (see e.g. Shrout
    & Fleiss 1979); used here only to quantify how correlated the "samples" naive
    per-token pooling treats as independent actually are."""
    n = len(sequences)
    all_vals = [v for s in sequences for v in s.tv]
    grand_mean = statistics.mean(all_vals)
    ssb = T * sum((statistics.mean(s.tv) - grand_mean) ** 2 for s in sequences)
    ssw = sum((v - statistics.mean(s.tv)) ** 2 for s in sequences for v in s.tv)
    msb = ssb / (n - 1)
    msw = ssw / (n * (T - 1))
    return (msb - msw) / (msb + (T - 1) * msw)


def part_g(rng: random.Random):
    """Part A found naive per-token-pooled calibration's real violation rate climbs with
    intra-sequence correlation strength (seq_offset_sd). This checks whether that trend
    has an actual formula behind it, not just a direction: Kish's design effect
    (Kish, 1965, "Survey Sampling") says that pooling m=T correlated-within-cluster
    observations as if independent overstates the effective sample size by a factor
    DEFF = 1 + (T-1)*rho, where rho is the intraclass correlation. If that's the real
    mechanism, the design-effect-corrected effective sample size (n*T/DEFF) should track
    the number of sequences n -- not the naive n*T -- and should track it more closely as
    rho grows, exactly mirroring why the violation rate in Part A grows with
    seq_offset_sd."""
    n = 2000
    seq_offset_sds = [0.05, 0.15, 0.30]
    results = {}
    for sd in seq_offset_sds:
        seqs = [make_teacher_forced_sequence(rng, sd) for _ in range(n)]
        rho = intraclass_correlation(seqs)
        deff = 1 + (T - 1) * rho
        n_eff_naive_assumes = n * T
        n_eff_design_effect_corrected = n * T / deff
        results[f"seq_offset_sd_{sd}"] = {
            "intraclass_correlation_rho": rho,
            "design_effect_1_plus_T_minus_1_rho": deff,
            "n_eff_naive_pooling_assumes": n_eff_naive_assumes,
            "n_eff_design_effect_corrected": n_eff_design_effect_corrected,
            "n_true_sequence_count": n,
            "corrected_estimate_over_true_n_ratio": n_eff_design_effect_corrected / n,
        }
    return {
        "n_sequences": n,
        "note": "corrected_estimate_over_true_n_ratio -> 1 as rho -> 1 confirms the "
                "mechanism: naive pooling's claimed n*T degrees of freedom are, after "
                "the standard design-effect correction, worth barely more than the n "
                "sequences Section 3.1 says to use, and the gap between naive and "
                "corrected shrinks as correlation strengthens -- matching Part A's "
                "violation-rate trend without needing to re-derive it from scratch.",
        "by_correlation_strength": results,
    }


def part_h(rng: random.Random):
    """Open Problem 4 flagged empirical-Bernstein as the untried next attempt at fixing
    conditional-risk calibration's collapse. This tries it -- swap Hoeffding for
    empirical-Bernstein in calibrate_conditional, holding the per-sequence-ratio
    construction fixed, and sweep the calibration budget to see whether it closes the
    gap to calibrate()'s n_cal=300 joint-risk performance, narrows it, or does neither."""
    n_trials = 20
    n_holdout = 4000
    seq_offset_sd = 0.05
    n_cals = [300, 1000, 3000, 10000]

    results = {}
    for n_cal in n_cals:
        holdout = [make_teacher_forced_sequence(rng, seq_offset_sd) for _ in range(n_holdout)]
        hoeffding_skip, hoeffding_cond = [], []
        bernstein_skip, bernstein_cond = [], []
        for _ in range(n_trials):
            cal = [make_teacher_forced_sequence(rng, seq_offset_sd) for _ in range(n_cal)]
            lam_h = calibrate_conditional(cal, GRID, DELTA)
            lam_b = calibrate_conditional_bernstein(cal, GRID, DELTA)
            _, cond_h, sk_h = risk_breakdown(lam_h, holdout)
            _, cond_b, sk_b = risk_breakdown(lam_b, holdout)
            hoeffding_skip.append(sk_h); hoeffding_cond.append(cond_h)
            bernstein_skip.append(sk_b); bernstein_cond.append(cond_b)
        results[f"n_cal_{n_cal}"] = {
            "hoeffding_conditional": {
                "mean_skip_rate": statistics.mean(hoeffding_skip),
                "mean_conditional_risk": statistics.mean(hoeffding_cond),
            },
            "bernstein_conditional": {
                "mean_skip_rate": statistics.mean(bernstein_skip),
                "mean_conditional_risk": statistics.mean(bernstein_cond),
            },
        }

    return {
        "n_trials_per_budget": n_trials,
        "n_holdout_per_budget": n_holdout,
        "target_alpha": ALPHA,
        "for_reference_joint_calibrate_at_n_cal_300_skip_rate": 0.313,  # Part A, seq_offset_sd=0.05
        "by_calibration_budget": results,
    }


def part_i(rng: random.Random):
    """Part H's Hoeffding/Bernstein comparison both used the per-sequence-ratio
    construction ("separate ratio estimator"). This checks calibrate_combined_ratio_
    bernstein -- the combined-ratio-estimator + Bernstein + Bonferroni-corrected-grid
    construction found while investigating Part F/H further -- across the same budget
    sweep, plus one larger budget, to see whether picking a better-suited estimator
    (not just a better inequality on top of the same estimator) actually closes more
    of the gap to calibrate()'s joint-risk efficiency."""
    n_trials = 12
    n_holdout = 4000
    seq_offset_sd = 0.05
    n_cals = [300, 1000, 3000, 10000, 30000]

    results = {}
    for n_cal in n_cals:
        holdout = [make_teacher_forced_sequence(rng, seq_offset_sd) for _ in range(n_holdout)]
        skip, cond, violations = [], [], 0
        for _ in range(n_trials):
            cal = [make_teacher_forced_sequence(rng, seq_offset_sd) for _ in range(n_cal)]
            lam = calibrate_combined_ratio_bernstein(cal, GRID, DELTA)
            _, c, s = risk_breakdown(lam, holdout)
            skip.append(s)
            cond.append(c)
            if c > ALPHA:
                violations += 1
        results[f"n_cal_{n_cal}"] = {
            "mean_skip_rate": statistics.mean(skip),
            "mean_conditional_risk": statistics.mean(cond),
            "conditional_violation_rate": violations / n_trials,
        }

    return {
        "n_trials_per_budget": n_trials,
        "n_holdout_per_budget": n_holdout,
        "target_alpha": ALPHA,
        "for_reference_joint_calibrate_at_n_cal_300_skip_rate": 0.313,
        "for_reference_part_h_bernstein_per_sequence_ratio_at_n_cal_10000_skip_rate": 0.109,
        "by_calibration_budget": results,
    }


def main():
    rng = random.Random(SEED)
    result = {
        "seed": SEED,
        "tau": TAU,
        "alpha": ALPHA,
        "delta": DELTA,
        "tokens_per_sequence": T,
        "part_a_sequence_vs_naive_calibration": part_a(rng),
        "part_b_teacher_forced_vs_onpolicy": part_b(rng),
        "part_c_does_iterating_onpolicy_recalibration_converge": part_c(rng),
        "part_f_does_calibrating_the_conditional_risk_directly_work": part_f(rng),
        "part_g_design_effect_explains_the_naive_pooling_violation_trend": part_g(rng),
        "part_h_does_empirical_bernstein_fix_conditional_calibration": part_h(rng),
        "part_i_does_the_combined_ratio_estimator_do_better": part_i(rng),
    }
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
