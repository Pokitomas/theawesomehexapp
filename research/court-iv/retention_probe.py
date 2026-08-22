#!/usr/bin/env python3
"""Court IV item 4: did the trained model escape its initialization horizon?

ARCHIE_COURT_IV.md section 5(a) predicts that with `retention_bias = 4.0`, the
sigmoid gate contributes ~90% of the slowest fiber's per-token decay, pinning the
model near a 34-token half-life at initialization. The model has to *learn* its
way out by driving the retention logits up. This probe reads a checkpoint and
checks whether it did.

    python research/court-iv/retention_probe.py path/to/checkpoint.pt

Reads the checkpoint's state dict only -- it does not need the model class, the
corpus, or a GPU, and it does not touch a running training job.

The reported retention is the **bias-only** retention: what q would be if the
input-dependent part of the coefficient head were zero. It is a per-fiber
operating point, not the realized per-token q, which also depends on the input.
Treat it as the fiber's resting horizon. Use --full with a model module to
measure realized q on real data.

NOTE ON TESTING: the arithmetic here comes from `archie_semidirect.py`, which is
covered by `test_archie_court_iv.py`. The checkpoint-loading shell around it has
NOT been run against a real checkpoint -- this environment has no torch. Expect
to adjust `--retention-key` / `--ceiling-key` if shape discovery misses.
"""

from __future__ import annotations

import argparse
import math
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import archie_semidirect as arch  # noqa: E402

FIBERS = arch.FIBERS
EVENT_VALUES = arch.EVENT_VALUES_PER_FIBER
COEFFICIENT_OUT = FIBERS * EVENT_VALUES  # 10752


def find_by_shape(state, numel, name_hint=None):
    """Locate a 1-D tensor of a given length, preferring a name hint."""
    hits = [
        (key, tensor)
        for key, tensor in state.items()
        if getattr(tensor, "ndim", None) == 1 and tensor.numel() == numel
    ]
    if not hits:
        return None, None
    if name_hint:
        for key, tensor in hits:
            if name_hint in key.lower():
                return key, tensor
    return hits[-1] if len(hits) > 1 else hits[0]


def percentiles(values, points=(0, 1, 5, 25, 50, 75, 95, 99, 100)):
    ordered = sorted(values)
    last = len(ordered) - 1
    return {p: ordered[min(last, max(0, round(p / 100 * last)))] for p in points}


def describe(label, retentions, training_window):
    horizons = [arch.effective_horizon(q) for q in retentions]
    halves = [arch.half_life(q) for q in retentions]
    retained = [q**training_window for q in retentions]

    print(f"\n=== {label} ===")
    pq = percentiles(retentions)
    ph = percentiles(horizons)
    print(f"{'pct':>5} {'retention q':>13} {'1/e horizon':>13} {'half-life':>11}")
    for p in sorted(pq):
        print(f"{p:>4}% {pq[p]:>13.6f} {ph[p]:>13.1f} {arch.half_life(pq[p]):>11.1f}")

    reach = sum(1 for h in horizons if h >= training_window)
    quarter = sum(1 for h in horizons if h >= training_window / 4)
    print(f"\nfibers with horizon >= {training_window:5d} tokens: "
          f"{reach:5d} / {len(retentions)}  ({reach/len(retentions)*100:.2f}%)")
    print(f"fibers with horizon >= {training_window//4:5d} tokens: "
          f"{quarter:5d} / {len(retentions)}  ({quarter/len(retentions)*100:.2f}%)")
    print(f"max half-life: {max(halves):.1f} tokens")
    print(f"mean retained fraction over {training_window} tokens: "
          f"{sum(retained)/len(retained):.3e}")
    return max(halves)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkpoint", type=pathlib.Path)
    parser.add_argument("--training-window", type=int, default=512)
    parser.add_argument("--retention-key", default=None,
                        help="explicit state-dict key for the coefficient-head bias")
    parser.add_argument("--ceiling-key", default=None,
                        help="explicit state-dict key for the retention-ceiling buffer")
    args = parser.parse_args()

    try:
        import torch
    except ImportError:
        print("error: this probe needs torch to read the checkpoint", file=sys.stderr)
        return 2

    blob = torch.load(args.checkpoint, map_location="cpu", weights_only=False)
    state = blob
    for key in ("model", "state_dict", "model_state_dict"):
        if isinstance(state, dict) and key in state and isinstance(state[key], dict):
            state = state[key]
            break
    if not isinstance(state, dict):
        print("error: could not find a state dict in the checkpoint", file=sys.stderr)
        return 2

    if args.retention_key:
        bias = state[args.retention_key]
    else:
        key, bias = find_by_shape(state, COEFFICIENT_OUT, "bias")
        if bias is None:
            print(f"error: no 1-D tensor of length {COEFFICIENT_OUT} found. "
                  f"Pass --retention-key. Candidates:", file=sys.stderr)
            for name, tensor in state.items():
                if getattr(tensor, "ndim", None) == 1:
                    print(f"  {name}  {tuple(tensor.shape)}", file=sys.stderr)
            return 2
        print(f"coefficient-head bias: {key}  {tuple(bias.shape)}")

    if args.ceiling_key:
        ceilings = [float(v) for v in state[args.ceiling_key]]
    else:
        key, buffer = find_by_shape(state, FIBERS, "ceil")
        if buffer is None:
            print(f"no length-{FIBERS} buffer found; using the audited "
                  f"exp(-linspace({arch.RETENTION_RATE_MIN}, {arch.RETENTION_RATE_MAX}))")
            ceilings = arch.retention_rate_ceilings(FIBERS)
        else:
            print(f"retention ceilings:    {key}  {tuple(buffer.shape)}")
            ceilings = [float(v) for v in buffer]

    grouped = bias.reshape(FIBERS, EVENT_VALUES)
    retention_logits = [float(v) for v in grouped[:, 0]]
    transport_logits = [[float(v) for v in grouped[:, i]] for i in (1, 2, 3)]

    print(f"\ncheckpoint: {args.checkpoint}")
    print(f"retention logits: min {min(retention_logits):.4f}  "
          f"median {sorted(retention_logits)[FIBERS//2]:.4f}  "
          f"max {max(retention_logits):.4f}")
    print(f"(initialized at {arch.RETENTION_BIAS})")

    trained = [
        arch.normalizer_shipped(c, a, 0.0, 0.0, 0.0)
        for c, a in zip(ceilings, retention_logits)
    ]
    at_init = [
        arch.normalizer_shipped(c, arch.RETENTION_BIAS, 0.0, 0.0, 0.0)
        for c in ceilings
    ]
    ceiling_only = [
        arch.normalizer_shipped(c, 30.0, 0.0, 0.0, 0.0) for c in ceilings
    ]

    init_max = describe("AT INITIALIZATION (bias 4.0)", at_init, args.training_window)
    trained_max = describe("THIS CHECKPOINT (learned bias)", trained, args.training_window)
    ceiling_max = describe("DESIGN CEILING (saturated gate)", ceiling_only, args.training_window)

    print("\n=== transport operating point ===")
    for axis, logits in zip("xyz", transport_logits):
        magnitudes = [arch.TRANSPORT_SCALE * abs(math.tanh(v)) for v in logits]
        pm = percentiles(magnitudes, (50, 95, 100))
        print(f"  {axis}: median {pm[50]:.5f}  p95 {pm[95]:.5f}  max {pm[100]:.5f}  "
              f"(range cap {arch.TRANSPORT_SCALE})")

    print("\n=== verdict ===")
    escaped = trained_max > 2.0 * init_max
    headroom = (ceiling_max - trained_max) / ceiling_max * 100
    print(f"longest half-life: init {init_max:.1f} -> trained {trained_max:.1f} "
          f"-> design ceiling {ceiling_max:.1f} tokens")
    print(f"unused headroom against the design ceiling: {headroom:.1f}%")
    if escaped:
        print("ESCAPED: the model drove retention well past its initialization.\n"
              "  Section 5(a)'s bias fix is less urgent than predicted; the\n"
              "  transport toll in 5(b) is then the binding constraint.")
    else:
        print("PINNED: retention is still near its initialization operating point.\n"
              "  Court IV section 5(a) predicted this. Raising retention_bias to 8.0\n"
              "  is a one-constant change that moves the resting half-life from ~34\n"
              "  to ~297 tokens, and costs one restart rather than a redesign.")
    print("\nCaveat: this is the bias-only resting point, not realized per-token q.\n"
          "A model can hold a low resting retention and still gate up on demand.\n"
          "Confirm on real data before acting.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
