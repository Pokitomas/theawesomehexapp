#!/usr/bin/env python3
"""Empirical stress test for ARCHIE_ADAPTIVE_DEPTH_VERIFIER.md.

Synthetic (no real Qwen3 weights involved) validation of three claims made
in that document:

1. Sequence-level Learn-Then-Test achieves the promised
   Pr[TV > tau | skip] <= alpha coverage at rate >= 1 - delta across
   independent calibration draws (Sections 3.1-3.2).
2. The naive per-token-pooled calibration that an earlier draft of the
   document used (and that Section 3.1 now explicitly rejects) violates
   that coverage more often than delta -- it is not a strawman, it visibly
   breaks.
3. The Section 3.5 "honest gap" is real: a threshold calibrated on
   teacher-forced data measurably fails to control risk once skip
   decisions compound live, and a single round of on-policy recalibration
   measurably recovers it.

Everything here is a statistical simulation of the TV/s_t relationship the
document assumes, not a run of the actual model. It validates the math, not
Archie's empirical skip rate -- see Section 5 of the document for that
distinction.
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


def true_risk_and_skip_rate(lam: float, population):
    lookups = [seq_loss_lookup(s) for s in population]
    ells = [ell(lam) for ell, _ in lookups]
    skips = [sk(lam) for _, sk in lookups]
    total_bad_tokens = sum(e * T for e in ells)
    total_skip_tokens = sum(sk * T for sk in skips)
    r_cond = (total_bad_tokens / total_skip_tokens) if total_skip_tokens > 0 else 0.0
    return r_cond, statistics.mean(skips)


def part_a(rng: random.Random):
    n_cal = 300
    n_trials = 250
    n_holdout = 4000
    seq_offset_sd = 0.05

    holdout = [make_teacher_forced_sequence(rng, seq_offset_sd) for _ in range(n_holdout)]

    seq_violations = 0
    naive_violations = 0
    seq_skip_rates = []
    naive_skip_rates = []
    seq_lambdas = []
    naive_lambdas = []

    for _ in range(n_trials):
        cal = [make_teacher_forced_sequence(rng, seq_offset_sd) for _ in range(n_cal)]
        lam_seq = calibrate(cal, GRID, DELTA)
        lam_naive = calibrate_naive_token_pooled(cal, GRID, DELTA)
        seq_lambdas.append(lam_seq)
        naive_lambdas.append(lam_naive)

        r_seq, sk_seq = true_risk_and_skip_rate(lam_seq, holdout)
        r_naive, sk_naive = true_risk_and_skip_rate(lam_naive, holdout)
        seq_skip_rates.append(sk_seq)
        naive_skip_rates.append(sk_naive)
        if r_seq > ALPHA:
            seq_violations += 1
        if r_naive > ALPHA:
            naive_violations += 1

    return {
        "n_trials": n_trials,
        "n_cal_per_trial": n_cal,
        "n_holdout": n_holdout,
        "target_delta": DELTA,
        "target_alpha": ALPHA,
        "sequence_level": {
            "violation_rate": seq_violations / n_trials,
            "mean_skip_rate": statistics.mean(seq_skip_rates),
            "mean_lambda_hat": statistics.mean(seq_lambdas),
        },
        "naive_token_pooled": {
            "violation_rate": naive_violations / n_trials,
            "mean_skip_rate": statistics.mean(naive_skip_rates),
            "mean_lambda_hat": statistics.mean(naive_lambdas),
        },
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
    n_cal = 300
    n_holdout = 4000
    n_trials = 60
    seq_offset_sd = 0.05
    compounding_shift = 0.10

    tf_cal = [make_teacher_forced_sequence(rng, seq_offset_sd) for _ in range(n_cal)]
    lam_tf = calibrate(tf_cal, GRID, DELTA)

    live_risks_tf = []
    live_skip_rates_tf = []
    live_risks_onpolicy = []
    live_skip_rates_onpolicy = []
    onpolicy_lambdas = []

    for _ in range(n_trials):
        live_pop_tf_lambda = [make_compounding_rollout(rng, lam_tf, compounding_shift) for _ in range(n_holdout)]
        r_live_tf, sk_live_tf = true_risk_and_skip_rate(lam_tf, live_pop_tf_lambda)
        live_risks_tf.append(r_live_tf)
        live_skip_rates_tf.append(sk_live_tf)

        onpolicy_cal = [make_compounding_rollout(rng, lam_tf, compounding_shift) for _ in range(n_cal)]
        lam_onpolicy = calibrate(onpolicy_cal, GRID, DELTA)
        onpolicy_lambdas.append(lam_onpolicy)

        live_pop_onpolicy = [make_compounding_rollout(rng, lam_onpolicy, compounding_shift) for _ in range(n_holdout)]
        r_live_onpolicy, sk_live_onpolicy = true_risk_and_skip_rate(lam_onpolicy, live_pop_onpolicy)
        live_risks_onpolicy.append(r_live_onpolicy)
        live_skip_rates_onpolicy.append(sk_live_onpolicy)

    return {
        "n_trials": n_trials,
        "n_cal_per_trial": n_cal,
        "n_holdout_per_trial": n_holdout,
        "compounding_shift": compounding_shift,
        "target_alpha": ALPHA,
        "lambda_hat_teacher_forced": lam_tf,
        "teacher_forced_threshold_deployed_live": {
            "mean_realized_risk": statistics.mean(live_risks_tf),
            "violation_rate": sum(1 for r in live_risks_tf if r > ALPHA) / n_trials,
            "mean_skip_rate": statistics.mean(live_skip_rates_tf),
        },
        "single_round_onpolicy_recalibration": {
            "mean_lambda_hat": statistics.mean(onpolicy_lambdas),
            "mean_realized_risk": statistics.mean(live_risks_onpolicy),
            "violation_rate": sum(1 for r in live_risks_onpolicy if r > ALPHA) / n_trials,
            "mean_skip_rate": statistics.mean(live_skip_rates_onpolicy),
        },
    }


def part_c(rng: random.Random):
    """Does iterating the Section 3.5 on-policy fix actually converge to safety?
    Tested two ways, both starting from the teacher-forced lambda_hat: (i) each
    round recalibrates on fresh data from only the latest round's rollouts
    (discard history), (ii) each round recalibrates on the union of every
    round's rollouts so far, matching the textbook DAgger aggregation strategy.
    Run as `n_chains` independent chains of `n_rounds` rounds each so the
    reported convergence-or-not is a statistic, not one anecdote."""
    n_chains = 12
    n_rounds = 5
    n_cal = 200
    n_holdout = 1500
    compounding_shift = 0.10
    seq_offset_sd = 0.05

    tf_cal = [make_teacher_forced_sequence(rng, seq_offset_sd) for _ in range(n_cal)]
    lam0 = calibrate(tf_cal, GRID, DELTA)

    discard_final_risks = []
    aggregate_final_risks = []
    discard_violation_at_round = [0] * n_rounds
    aggregate_violation_at_round = [0] * n_rounds

    for _ in range(n_chains):
        lam_discard = lam0
        for r in range(n_rounds):
            pop = [make_compounding_rollout(rng, lam_discard, compounding_shift) for _ in range(n_holdout)]
            risk, _ = true_risk_and_skip_rate(lam_discard, pop)
            if risk > ALPHA:
                discard_violation_at_round[r] += 1
            cal = [make_compounding_rollout(rng, lam_discard, compounding_shift) for _ in range(n_cal)]
            lam_discard = calibrate(cal, GRID, DELTA)
        final_pop = [make_compounding_rollout(rng, lam_discard, compounding_shift) for _ in range(n_holdout)]
        final_risk, _ = true_risk_and_skip_rate(lam_discard, final_pop)
        discard_final_risks.append(final_risk)

        lam_agg = lam0
        aggregated = []
        for r in range(n_rounds):
            pop = [make_compounding_rollout(rng, lam_agg, compounding_shift) for _ in range(n_holdout)]
            risk, _ = true_risk_and_skip_rate(lam_agg, pop)
            if risk > ALPHA:
                aggregate_violation_at_round[r] += 1
            aggregated.extend(make_compounding_rollout(rng, lam_agg, compounding_shift) for _ in range(n_cal))
            lam_agg = calibrate(aggregated, GRID, DELTA)
        final_pop_agg = [make_compounding_rollout(rng, lam_agg, compounding_shift) for _ in range(n_holdout)]
        final_risk_agg, _ = true_risk_and_skip_rate(lam_agg, final_pop_agg)
        aggregate_final_risks.append(final_risk_agg)

    return {
        "n_chains": n_chains,
        "n_rounds": n_rounds,
        "n_cal_per_round": n_cal,
        "n_holdout_per_round": n_holdout,
        "compounding_shift": compounding_shift,
        "target_alpha": ALPHA,
        "lambda_hat_round0": lam0,
        "discard_history_each_round": {
            "violation_rate_per_round": [v / n_chains for v in discard_violation_at_round],
            "mean_final_risk": statistics.mean(discard_final_risks),
        },
        "dagger_style_aggregate_each_round": {
            "violation_rate_per_round": [v / n_chains for v in aggregate_violation_at_round],
            "mean_final_risk": statistics.mean(aggregate_final_risks),
        },
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
    }
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
