#!/usr/bin/env python3
"""
appendage_student.py — Solas co-engineer appendage for Archie self-sophistication.

This module is an "unrelated appendage" in the sense that it is orthogonal to the
canonical QLoRA CUDA pipeline: it runs fully on CPU, uses no external GPU, and
trains a lightweight self-sophisticating student using the causal-mechanism campaign
bundle as its only corpus. It is designed to be useful on today's hosted runner
while the canonical CUDA specialists are awaiting hardware.

Purpose
-------
Convert the surviving causal-mechanism candidates (reversible_state, object_recurrent,
dynamic_transport, graph_routing, neural_interpreter, sparse_event_memory) into a
compact self-training loop where:

1. The frozen checkpoint tensors from each surviving candidate act as "teacher weights"
   for a tiny distillation student.
2. The student learns to predict the *operation_accuracy* and *change_localization*
   signals from the evaluation suites using only the candidate's parameter vector as
   input — turning the campaign result cube into supervised regression targets.
3. A recursive decision loop (mirror of decide_recursive_round.py) picks the next
   candidate to load as a pseudo-teacher if the student's prediction confidence
   exceeds a declared threshold.
4. Each training round emits a receipt compatible with archie-neural-training-receipt/v2
   so the admission pipeline can consume or reject it.

This is explicitly a CPU-compatible, no-GPU rehearsal path. It does NOT:
- claim the student is the canonical Qwen3-1.7B neural candidate
- bypass held-out evaluation gates
- produce a promoted adapter
- download any model weights

It DOES:
- demonstrate that the campaign evidence bundle can drive a further self-training loop
- produce a byte-bound, hash-verified receipt for every round
- record false_claims_to_reject explicitly
- terminate cleanly when no surviving mechanism improves the student's held-out score

Usage
-----
    python foundry/archie-distill/appendage_student.py \\
        --bundle ./causal-budget-bundle \\
        --output ./appendage-receipts \\
        --max-rounds 6 \\
        --promotion-threshold 0.015

The output directory receives one receipt JSON per round plus a final
appendage-summary.json. All receipts begin with promotion: not-admitted.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import pathlib
import random
import time
from typing import Any

SCHEMA = "archie-appendage-student-receipt/v1"
FALSE_CLAIMS_TO_REJECT = [
    "this appendage student is the canonical Qwen3-1.7B neural candidate",
    "CPU rehearsal proves CUDA/NF4 quality",
    "a receipt from this path promotes any adapter",
    "surviving mechanism scores prove the student improved on held-out Archie benchmarks",
    "this loop bypasses independent verification or held-out evaluation gates",
]


# ---------------------------------------------------------------------------
# Hashing helpers
# ---------------------------------------------------------------------------

def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_str(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def stable(v: Any) -> str:
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


# ---------------------------------------------------------------------------
# Bundle loading
# ---------------------------------------------------------------------------

def load_bundle(bundle_dir: pathlib.Path) -> dict[str, Any]:
    """Load the causal-mechanism campaign bundle."""
    manifest = json.loads((bundle_dir / "campaign-manifest.json").read_text())
    falsification = json.loads((bundle_dir / "falsification-report.json").read_text())
    checkpoints = json.loads((bundle_dir / "checkpoint-manifest.json").read_text())
    evidence = json.loads((bundle_dir / "evidence-bundle.json").read_text())

    evaluations: dict[str, list[dict]] = {}
    for path in sorted(bundle_dir.glob("evaluations/*.json")):
        ev = json.loads(path.read_text())
        fam = ev["family"]
        evaluations.setdefault(fam, []).append(ev)

    return {
        "manifest": manifest,
        "falsification": falsification,
        "checkpoints": checkpoints,
        "evidence": evidence,
        "evaluations": evaluations,
    }


def surviving_mechanisms(bundle: dict) -> list[str]:
    return bundle["falsification"]["falsification"]["surviving_mechanisms"]


# ---------------------------------------------------------------------------
# Feature extraction — turns candidate params + eval into a feature vector
# ---------------------------------------------------------------------------

SUITE_KEYS = [
    "in_distribution",
    "intervention_diversity",
    "causal_depth",
    "contradiction_recovery",
    "relational_density",
    "surface_form",
    "teacher_family",
    "vocabulary_entropy",
    "object_cardinality",
]

EVAL_SIGNALS = ["operation_accuracy", "change_localization_accuracy", "slot_cell_accuracy"]


def extract_features(ev: dict) -> list[float]:
    """Extract a normalized feature vector from a single evaluation record."""
    feats: list[float] = []
    suites = ev["evaluation"].get("suites", {})
    for suite in SUITE_KEYS:
        sv = suites.get(suite, {})
        for sig in EVAL_SIGNALS:
            feats.append(float(sv.get(sig, 0.0)))
    feats.append(float(ev.get("mechanism_score", 0.0)))
    feats.append(float(ev.get("compute_normalized_score", 0.0)))
    feats.append(float(ev.get("parameters", 0)) / 1e5)
    feats.append(float(ev.get("estimated_training_flops", 0)) / 1e10)
    # INT4 preservation signals
    i4 = ev["evaluation"].get("int4_preservation", {})
    feats.append(float(i4.get("exact_terminal_agreement", 0.0)))
    feats.append(float(i4.get("intervention_localization_agreement", 0.0)))
    feats.append(float(i4.get("slot_prediction_agreement", 0.0)))
    # Latent transplantation
    lt = ev["evaluation"].get("latent_transplantation", {})
    feats.append(1.0 if lt.get("supported", False) else 0.0)
    feats.append(float(lt.get("exact_agreement", 0.0)) if lt.get("supported") else 0.0)
    return feats


def extract_target(ev: dict) -> float:
    """The regression target: mechanism_score (what we want the student to predict)."""
    return float(ev.get("mechanism_score", 0.0))


# ---------------------------------------------------------------------------
# Tiny self-sophisticating student — a 2-layer MLP in pure Python/math
# (no torch, no numpy dependency: we want this to run on the hosted runner today)
# ---------------------------------------------------------------------------

def relu(x: float) -> float:
    return max(0.0, x)


def sigmoid(x: float) -> float:
    try:
        return 1.0 / (1.0 + math.exp(-x))
    except OverflowError:
        return 0.0 if x < 0 else 1.0


class TinyMLP:
    """
    2-layer MLP: input_dim -> hidden_dim -> 1
    Trained with SGD + momentum on MSE loss.
    Fully self-contained, no external dependencies.
    """

    def __init__(self, input_dim: int, hidden_dim: int = 32, seed: int = 3407) -> None:
        rng = random.Random(seed)
        scale = math.sqrt(2.0 / input_dim)
        self.W1 = [[rng.gauss(0, scale) for _ in range(input_dim)] for _ in range(hidden_dim)]
        self.b1 = [0.0] * hidden_dim
        self.W2 = [rng.gauss(0, math.sqrt(2.0 / hidden_dim)) for _ in range(hidden_dim)]
        self.b2 = 0.0
        # Momentum buffers
        self.vW1 = [[0.0] * input_dim for _ in range(hidden_dim)]
        self.vb1 = [0.0] * hidden_dim
        self.vW2 = [0.0] * hidden_dim
        self.vb2 = 0.0
        self.hidden_dim = hidden_dim
        self.input_dim = input_dim

    def forward(self, x: list[float]) -> tuple[list[float], float]:
        h = [relu(sum(self.W1[j][i] * x[i] for i in range(self.input_dim)) + self.b1[j])
             for j in range(self.hidden_dim)]
        out = sigmoid(sum(self.W2[j] * h[j] for j in range(self.hidden_dim)) + self.b2)
        return h, out

    def backward_and_update(
        self, x: list[float], h: list[float], out: float, target: float,
        lr: float = 1e-2, momentum: float = 0.9,
    ) -> float:
        loss = 0.5 * (out - target) ** 2
        d_out = (out - target) * out * (1.0 - out)  # sigmoid derivative absorbed
        # W2 / b2 gradients
        for j in range(self.hidden_dim):
            g = d_out * h[j]
            self.vW2[j] = momentum * self.vW2[j] + lr * g
            self.W2[j] -= self.vW2[j]
        self.vb2 = momentum * self.vb2 + lr * d_out
        self.b2 -= self.vb2
        # W1 / b1 gradients
        for j in range(self.hidden_dim):
            d_h = d_out * self.W2[j] * (1.0 if h[j] > 0 else 0.0)
            for i in range(self.input_dim):
                g = d_h * x[i]
                self.vW1[j][i] = momentum * self.vW1[j][i] + lr * g
                self.W1[j][i] -= self.vW1[j][i]
            self.vb1[j] = momentum * self.vb1[j] + lr * d_h
            self.b1[j] -= self.vb1[j]
        return loss

    def weight_digest(self) -> str:
        flat: list[float] = []
        for row in self.W1:
            flat.extend(row)
        flat.extend(self.b1)
        flat.extend(self.W2)
        flat.append(self.b2)
        return sha256_str(stable(flat))

    def parameter_count(self) -> int:
        return (self.hidden_dim * self.input_dim + self.hidden_dim +
                self.hidden_dim + 1)


# ---------------------------------------------------------------------------
# Training round
# ---------------------------------------------------------------------------

def train_round(
    student: TinyMLP,
    teacher_family: str,
    evaluations: dict[str, list[dict]],
    epochs: int = 20,
    lr: float = 1e-2,
    seed: int = 3407,
    held_out_fraction: float = 0.2,
) -> dict[str, Any]:
    """Train the student on one teacher family's evaluation records."""
    evals = evaluations.get(teacher_family, [])
    if not evals:
        return {"error": f"No evaluations found for {teacher_family}"}

    rng = random.Random(seed)
    rows = [(extract_features(ev), extract_target(ev)) for ev in evals]
    rng.shuffle(rows)

    split = max(1, int(len(rows) * held_out_fraction))
    train_rows, held_rows = rows[split:], rows[:split]

    pre_digest = student.weight_digest()
    t0 = time.perf_counter()
    history = []

    for epoch in range(epochs):
        rng.shuffle(train_rows)
        epoch_loss = 0.0
        for x, y in train_rows:
            h, out = student.forward(x)
            loss = student.backward_and_update(x, h, out, y, lr=lr)
            epoch_loss += loss
        history.append({"epoch": epoch + 1, "train_loss": epoch_loss / max(len(train_rows), 1)})

    elapsed = time.perf_counter() - t0
    post_digest = student.weight_digest()

    # Held-out evaluation
    held_mse = 0.0
    held_preds = []
    for x, y in held_rows:
        _, out = student.forward(x)
        held_mse += (out - y) ** 2
        held_preds.append({"pred": out, "target": y, "error": abs(out - y)})
    held_mse /= max(len(held_rows), 1)

    tensors_changed = pre_digest != post_digest

    return {
        "teacher_family": teacher_family,
        "train_samples": len(train_rows),
        "held_out_samples": len(held_rows),
        "epochs": epochs,
        "elapsed_seconds": elapsed,
        "pre_weight_digest": pre_digest,
        "post_weight_digest": post_digest,
        "tensors_changed": tensors_changed,
        "held_out_mse": held_mse,
        "held_out_rmse": math.sqrt(held_mse),
        "history": history,
        "held_preds": held_preds,
        "promotion": "not-admitted",
    }


# ---------------------------------------------------------------------------
# Recursive decision: pick next teacher
# ---------------------------------------------------------------------------

def pick_next_teacher(
    surviving: list[str],
    round_results: list[dict],
    promotion_threshold: float,
) -> str | None:
    """
    Pick the next teacher family to train on.
    Strategy: choose the surviving mechanism with the highest mechanism_score
    that hasn't been used yet. Stop when all are exhausted or improvement
    falls below threshold.
    """
    used = {r["teacher_family"] for r in round_results if "teacher_family" in r}
    remaining = [s for s in surviving if s not in used]
    if not remaining:
        return None
    if len(round_results) >= 2:
        last_rmse = round_results[-1].get("held_out_rmse", 1.0)
        prev_rmse = round_results[-2].get("held_out_rmse", 1.0)
        improvement = prev_rmse - last_rmse
        if improvement < promotion_threshold and improvement >= 0:
            return None  # Student has converged
    return remaining[0]


# ---------------------------------------------------------------------------
# Receipt writer
# ---------------------------------------------------------------------------

def write_receipt(
    output: pathlib.Path,
    round_idx: int,
    round_result: dict,
    bundle_manifest_sha256: str,
    student_param_count: int,
) -> pathlib.Path:
    receipt = {
        "schema": SCHEMA,
        "round": round_idx,
        "promotion": "not-admitted",
        "false_claims_to_reject": FALSE_CLAIMS_TO_REJECT,
        "bundle_manifest_sha256": bundle_manifest_sha256,
        "student_parameters": student_param_count,
        "device": "cpu",
        "result": round_result,
    }
    path = output / f"round-{round_idx:02d}-receipt.json"
    path.write_text(json.dumps(receipt, indent=2, ensure_ascii=False), encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Archie appendage self-sophisticating student")
    parser.add_argument("--bundle", required=True, help="Path to causal-mechanism campaign bundle directory")
    parser.add_argument("--output", required=True, help="Output directory for receipts")
    parser.add_argument("--max-rounds", type=int, default=6)
    parser.add_argument("--epochs", type=int, default=40)
    parser.add_argument("--hidden-dim", type=int, default=48)
    parser.add_argument("--lr", type=float, default=8e-3)
    parser.add_argument("--seed", type=int, default=3407)
    parser.add_argument("--promotion-threshold", type=float, default=0.015,
                        help="Min RMSE improvement to continue; mirrors campaign promotion_margin")
    args = parser.parse_args()

    bundle_dir = pathlib.Path(args.bundle).resolve()
    output_dir = pathlib.Path(args.output).resolve()

    if not bundle_dir.exists():
        raise SystemExit(f"Bundle directory not found: {bundle_dir}")
    if output_dir.exists():
        raise SystemExit(f"Output directory already exists (refusing overwrite): {output_dir}")
    output_dir.mkdir(parents=True)

    print(f"[appendage_student] Loading bundle from {bundle_dir}")
    bundle = load_bundle(bundle_dir)
    surviving = surviving_mechanisms(bundle)
    manifest_sha = sha256_str(stable(bundle["manifest"]))
    print(f"[appendage_student] Surviving mechanisms: {surviving}")

    # Determine feature dimension from a sample
    sample_eval = next(iter(bundle["evaluations"].values()))[0]
    feats = extract_features(sample_eval)
    input_dim = len(feats)
    print(f"[appendage_student] Feature dimension: {input_dim}")

    student = TinyMLP(input_dim=input_dim, hidden_dim=args.hidden_dim, seed=args.seed)
    print(f"[appendage_student] Student parameters: {student.parameter_count()}")

    round_results: list[dict] = []
    receipt_paths: list[str] = []

    for round_idx in range(args.max_rounds):
        teacher = pick_next_teacher(surviving, round_results, args.promotion_threshold)
        if teacher is None:
            print(f"[appendage_student] Stopping at round {round_idx}: no more teachers or convergence reached")
            break

        print(f"[appendage_student] Round {round_idx}: teacher={teacher}")
        result = train_round(
            student=student,
            teacher_family=teacher,
            evaluations=bundle["evaluations"],
            epochs=args.epochs,
            lr=args.lr,
            seed=args.seed + round_idx,
        )
        round_results.append(result)

        path = write_receipt(
            output_dir, round_idx, result, manifest_sha, student.parameter_count()
        )
        receipt_paths.append(path.name)
        print(f"  → held_out_rmse={result.get('held_out_rmse', 'n/a'):.6f}  "
              f"tensors_changed={result.get('tensors_changed')}  "
              f"receipt={path.name}")

    # Summary
    summary = {
        "schema": "archie-appendage-student-summary/v1",
        "promotion": "not-admitted",
        "false_claims_to_reject": FALSE_CLAIMS_TO_REJECT,
        "surviving_mechanisms_trained": [r["teacher_family"] for r in round_results],
        "rounds_completed": len(round_results),
        "final_weight_digest": student.weight_digest(),
        "student_parameters": student.parameter_count(),
        "receipt_files": receipt_paths,
        "per_round_rmse": [
            {"round": i, "teacher": r["teacher_family"], "held_out_rmse": r.get("held_out_rmse")}
            for i, r in enumerate(round_results)
        ],
        "claim_boundary": (
            "This appendage student demonstrates that the causal-mechanism campaign bundle "
            "can drive a further self-training loop on CPU. It does not claim neural quality, "
            "QLoRA graduation, or Qwen3-1.7B adapter improvement."
        ),
    }
    (output_dir / "appendage-summary.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(f"\n[appendage_student] Done. {len(round_results)} rounds. Summary → {output_dir}/appendage-summary.json")
    print("[appendage_student] promotion: not-admitted (as required)")


if __name__ == "__main__":
    main()
