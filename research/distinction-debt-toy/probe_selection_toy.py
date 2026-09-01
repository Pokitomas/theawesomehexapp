"""Minimal, runnable toy for the "scalar risk vs. probe selection" claim.

Setup (deliberately small enough to hand-check):

  Each trial has a hidden reference future (a, b), a, b in {0,1}, drawn
  uniformly. The cheap runtime observes only s = a; b is invisible unless
  a probe reveals it. The correct action is y* = a XOR b, so the cheap
  state alone never determines the answer: for a fixed s, both b=0 and
  b=1 remain possible until something resolves it. That's the aliasing
  the "kernel_collision" column checks for.

  Two unit-cost probes are available: m_a (re-reveals a, which the
  runtime already knows -> uninformative) and m_b (reveals b -> resolves
  the ambiguity completely). "addr_error" checks whether an arm spent a
  probe on the uninformative one.

  Arms:
    always-refuse    never answers.
    action-only      guesses action=a (i.e. assumes b=0), no probing,
                      no gating -> answers from an unresolved cell every time.
    scalar-risk       has a risk score but no directional information, so
                      when it decides to probe it picks m_a or m_b at random.
    full-history      resolves fully but by redundantly re-reading both
                      bits twice each (4 probe-units, 4x the state of a
                      single scalar/selector).
    exact-quotient    knows structurally that b is the informative bit and
                      queries only m_b.
    always-reference  never touches the cheap artifact; pays a fixed
                      full-reference cost (5 units) and is always correct.

This is a toy, not a simulation of anything in this repository. It exists
to make the "a scalar risk bound can be safe but pick the wrong probe"
claim checkable by running code instead of asserting it in prose.
"""

import random
from collections import Counter

SEED = 20260726
N = 30
PROBE_COST = 1
FULL_REFERENCE_COST = 5


def y_star(a, b):
    return a ^ b


def run_action_only(a, b):
    action = a  # implicitly assumes b == 0
    wrong = action != y_star(a, b)
    return dict(proposed=True, accepted=True, wrong=wrong, cost=0, probes=0,
                kernel_collision=True, addr_error=False, reason="malformed")


def run_scalar_risk(a, b, rng):
    probe = rng.choice(["a", "b"])
    if probe == "b":
        action = y_star(a, b)
        return dict(proposed=True, accepted=True, wrong=False, cost=PROBE_COST,
                    probes=1, kernel_collision=False, addr_error=False, reason=None)
    action = a  # queried the uninformative probe, defaulted to assuming b == 0
    wrong = action != y_star(a, b)
    return dict(proposed=True, accepted=True, wrong=wrong, cost=PROBE_COST,
                probes=1, kernel_collision=True, addr_error=True, reason="wrong-probe")


def run_full_history(a, b):
    return dict(proposed=True, accepted=True, wrong=False, cost=4 * PROBE_COST,
                probes=4, kernel_collision=False, addr_error=False, reason=None)


def run_exact_quotient(a, b):
    return dict(proposed=True, accepted=True, wrong=False, cost=PROBE_COST,
                probes=1, kernel_collision=False, addr_error=False, reason=None)


def run_always_reference(a, b):
    return dict(proposed=True, accepted=True, wrong=False, cost=FULL_REFERENCE_COST,
                probes=0, kernel_collision=False, addr_error=False, reason=None)


def run_always_refuse(a, b):
    return dict(proposed=False, accepted=False, wrong=False, cost=0, probes=0,
                kernel_collision=False, addr_error=False, reason="refused")


PARSIM = {
    "always-refuse": "-",
    "action-only": "-",
    "scalar-risk": "1.0x",
    "full-history": "4.0x",
    "exact-quotient": "1.0x",
    "always-reference": "-",
}


def main():
    rng = random.Random(SEED)
    trials = [(rng.randint(0, 1), rng.randint(0, 1)) for _ in range(N)]
    scalar_rng = random.Random(SEED + 1)

    arms = {
        "always-refuse": lambda a, b: run_always_refuse(a, b),
        "action-only": lambda a, b: run_action_only(a, b),
        "scalar-risk": lambda a, b: run_scalar_risk(a, b, scalar_rng),
        "full-history": lambda a, b: run_full_history(a, b),
        "exact-quotient": lambda a, b: run_exact_quotient(a, b),
        "always-reference": lambda a, b: run_always_reference(a, b),
    }

    header = ("arm", "prop", "acc", "wrong%", "R_kernel", "R_addr", "parsim", "probes", "top rejection")
    rows = [header]

    for name, fn in arms.items():
        results = [fn(a, b) for (a, b) in trials]
        proposed = sum(r["proposed"] for r in results)
        accepted = sum(r["accepted"] for r in results)
        wrong = sum(r["wrong"] for r in results)
        kernel = sum(r["kernel_collision"] for r in results)
        addr = sum(r["addr_error"] for r in results)
        avg_probes = sum(r["probes"] for r in results) / N
        reasons = Counter(r["reason"] for r in results if r["reason"])
        top = ",".join(f"{k}:{v}" for k, v in reasons.most_common(2)) or "-"

        def pct(x, denom):
            return f"{100 * x / denom:.0f}%" if denom else "-"

        rows.append((
            name,
            str(proposed),
            str(accepted),
            pct(wrong, accepted),
            pct(kernel, accepted),
            pct(addr, accepted),
            PARSIM[name],
            f"{avg_probes:.1f}",
            top,
        ))

    widths = [max(len(r[i]) for r in rows) for i in range(len(header))]
    for r in rows:
        print("  ".join(c.ljust(w) for c, w in zip(r, widths)))


if __name__ == "__main__":
    main()
