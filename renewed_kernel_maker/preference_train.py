from __future__ import annotations

import hashlib
import json
import math
from typing import Any

try:
    from .core import canonical, receipt
    from .synthetic_pref import generate_tasks, preference_pair, synthesize_candidate
except ImportError:
    from core import canonical, receipt
    from synthetic_pref import generate_tasks, preference_pair, synthesize_candidate

FEATURES = ("tests", "receipts", "regressions", "latency", "actions")


def features(candidate: dict[str, Any]) -> dict[str, float]:
    return {
        "tests": float(candidate["tests_passed"]),
        "receipts": float(candidate["receipts_ok"]),
        "regressions": -float(candidate["regressions"]),
        "latency": -float(candidate["latency_ms"]) / 500.0,
        "actions": -float(len(candidate.get("actions") or ())) / 16.0,
    }


def diff(pair: dict[str, Any]) -> list[float]:
    a = features(pair["chosen"])
    b = features(pair["rejected"])
    return [a[k] - b[k] for k in FEATURES]


def sigmoid(x: float) -> float:
    if x >= 0:
        z = math.exp(-x)
        return 1.0 / (1.0 + z)
    z = math.exp(x)
    return z / (1.0 + z)


def accuracy(weights: list[float], pairs: list[dict[str, Any]]) -> float:
    if not pairs:
        return 0.0
    return sum(sum(w * v for w, v in zip(weights, diff(pair))) > 0.0 for pair in pairs) / len(pairs)


def logloss(weights: list[float], pairs: list[dict[str, Any]]) -> float:
    if not pairs:
        return 0.0
    total = 0.0
    for pair in pairs:
        margin = sum(w * v for w, v in zip(weights, diff(pair)))
        p = min(1.0 - 1e-12, max(1e-12, sigmoid(margin)))
        total -= math.log(p)
    return total / len(pairs)


def heldout_pairs() -> list[dict[str, Any]]:
    _, heldout = generate_tasks()
    return [
        preference_pair(task, synthesize_candidate(task, 2), synthesize_candidate(task, 3))
        for task in heldout
    ]


def train_pairwise(
    pairs: list[dict[str, Any]],
    *,
    epochs: int = 160,
    lr: float = 0.04,
    l2: float = 0.002,
) -> dict[str, Any]:
    """Deterministic pairwise preference optimization.

    This is real optimization over synthetic preference pairs, but it is a tiny
    transparent scorer rather than a language-model RLHF claim.
    """
    w = [0.0 for _ in FEATURES]
    losses: list[float] = []
    for _ in range(max(1, int(epochs))):
        for pair in pairs:
            x = diff(pair)
            margin = sum(a * b for a, b in zip(w, x))
            scale = sigmoid(margin) - 1.0
            for i, xv in enumerate(x):
                grad = scale * xv + l2 * w[i]
                w[i] -= lr * grad
        losses.append(logloss(w, pairs))
    fitted = {k: round(v, 10) for k, v in zip(FEATURES, w)}
    return {
        "weights": fitted,
        "loss_first": losses[0],
        "loss_last": losses[-1],
        "epochs": max(1, int(epochs)),
        "lr": lr,
        "l2": l2,
        "model_sha256": hashlib.sha256(canonical(fitted)).hexdigest(),
    }


def court() -> dict[str, Any]:
    train_tasks, heldout_tasks = generate_tasks()
    train_pairs = [
        preference_pair(task, synthesize_candidate(task, 0), synthesize_candidate(task, 1))
        for task in train_tasks
    ]
    eval_pairs = heldout_pairs()
    run1 = train_pairwise(train_pairs)
    run2 = train_pairwise(json.loads(json.dumps(train_pairs)))
    w = [float(run1["weights"][k]) for k in FEATURES]
    train_acc = accuracy(w, train_pairs)
    heldout_acc = accuracy(w, eval_pairs)
    train_ids = {t.id for t in train_tasks}
    heldout_ids = {t.id for t in heldout_tasks}
    overlap = sorted(train_ids & heldout_ids)
    return receipt("synthetic.preference_training_court", {
        "optimizer": "deterministic-pairwise-logistic",
        "train_pairs": len(train_pairs),
        "heldout_pairs": len(eval_pairs),
        "split_overlap": overlap,
        "loss_first": run1["loss_first"],
        "loss_last": run1["loss_last"],
        "loss_decreased": run1["loss_last"] < run1["loss_first"],
        "train_accuracy": train_acc,
        "heldout_accuracy": heldout_acc,
        "deterministic": run1["model_sha256"] == run2["model_sha256"],
        "model_sha256": run1["model_sha256"],
        "weights": run1["weights"],
        "passes": (
            not overlap
            and run1["loss_last"] < run1["loss_first"]
            and run1["model_sha256"] == run2["model_sha256"]
            and train_acc >= 0.75
            and heldout_acc >= 0.5
        ),
        "claim": "real synthetic preference optimization of a tiny transparent scorer; not language-model RLHF",
    })


if __name__ == "__main__":
    print(json.dumps(court(), indent=2))
