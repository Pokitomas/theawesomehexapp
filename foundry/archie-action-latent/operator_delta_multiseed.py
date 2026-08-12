#!/usr/bin/env python3
"""Multi-seed replication for the latent-displacement inverse-dynamics ablation."""
from __future__ import annotations

import argparse
import importlib.util
import json
import statistics
import sys
import tempfile
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
ABLATION_PATH = HERE / "operator_delta_ablation.py"


def load_ablation():
    spec = importlib.util.spec_from_file_location("archie_operator_delta_ablation_multiseed", ABLATION_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {ABLATION_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


A = load_ablation()


def motor_court_passed(court: dict[str, Any]) -> bool:
    """Accept the actual motor-court contract instead of inventing a `pass` key."""
    return bool(
        not court.get("inverse_failures")
        and not court.get("continuity_failures")
        and float(court.get("inverse_pass_rate", 0.0)) == 1.0
        and float(court.get("continuity_pass_rate", 0.0)) == 1.0
        and int(court.get("steps", 0)) > 0
        and int(court.get("latent_code_count", 0)) > 1
        and bool(court.get("ledger_sha256"))
    )


def run_multiseed(
    seeds: list[int], *, steps: int, codes: int, epochs: int, lr: float, device: str
) -> dict[str, Any]:
    if len(set(seeds)) != len(seeds) or not seeds:
        raise ValueError("seeds must be a non-empty unique list")
    runs: list[dict[str, Any]] = []
    motor_courts: list[dict[str, Any]] = []
    for seed in seeds:
        with tempfile.TemporaryDirectory(prefix=f"archie-delta-seed-{seed}-") as tmp:
            root = Path(tmp)
            ledger = root / "motor.jsonl"
            motor = A.CORE.load_motor_module()
            court = motor.run_court(root / "world", ledger, steps, seed)
            motor_courts.append({
                "seed": seed,
                "passed": motor_court_passed(court),
                "inverse_pass_rate": court.get("inverse_pass_rate"),
                "continuity_pass_rate": court.get("continuity_pass_rate"),
                "latent_code_count": court.get("latent_code_count"),
                "ledger_sha256": court.get("ledger_sha256"),
            })
            if not motor_court_passed(court):
                raise RuntimeError(f"motor court failed for seed {seed}: {court}")
            run = A.run_ablation(
                ledger, codes=codes, epochs=epochs, lr=lr, seed=seed, device=device
            )
            runs.append(run)

    forward_ratios = [float(run["delta_over_endpoint_test_forward_mse"]) for run in runs]
    inverse_ratios = [float(run["delta_over_endpoint_test_inverse_mse"]) for run in runs]
    nmi_deltas = [
        float(run["delta_only"]["latent_vs_hand_effect_nmi"])
        - float(run["endpoint_delta"]["latent_vs_hand_effect_nmi"])
        for run in runs
    ]
    wins = sum(1 for ratio in forward_ratios if ratio < 1.0)
    strong_wins = sum(1 for ratio in forward_ratios if ratio <= 0.8)
    all_valid = all(bool(run["pass"]) for run in runs)
    median_forward = statistics.median(forward_ratios)
    median_inverse = statistics.median(inverse_ratios)
    median_nmi_gain = statistics.median(nmi_deltas)
    promotion_candidate = bool(
        all_valid
        and wins >= max(1, len(runs) - 1)
        and strong_wins >= (len(runs) + 1) // 2
        and median_forward <= 0.8
        and median_inverse <= 0.8
        and median_nmi_gain > 0.0
    )
    return {
        "schema": "archie-action-latent/operator-delta-multiseed-v1",
        "seeds": seeds,
        "steps_per_seed": steps,
        "epochs": epochs,
        "codes": codes,
        "motor_courts": motor_courts,
        "runs": runs,
        "forward_mse_ratios_delta_over_endpoint": forward_ratios,
        "inverse_mse_ratios_delta_over_endpoint": inverse_ratios,
        "nmi_gains_delta_minus_endpoint": nmi_deltas,
        "delta_forward_wins": wins,
        "delta_strong_forward_wins": strong_wins,
        "median_forward_mse_ratio": median_forward,
        "median_inverse_mse_ratio": median_inverse,
        "median_effect_nmi_gain": median_nmi_gain,
        "promotion_candidate": promotion_candidate,
        "pass": all_valid and all(item["passed"] for item in motor_courts),
        "claim_boundary": (
            "PASS establishes only that every matched seed produced a valid comparison after an exact motor court. "
            "promotion_candidate means displacement-only replicated within this isolated filesystem motor ecology; "
            "it is not yet promotion into the resident or packed-stream model."
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seeds", default="5601,5602,5603,5604,5605")
    parser.add_argument("--steps", type=int, default=400)
    parser.add_argument("--codes", type=int, default=8)
    parser.add_argument("--epochs", type=int, default=80)
    parser.add_argument("--lr", type=float, default=3e-3)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--output")
    args = parser.parse_args()
    seeds = [int(value.strip()) for value in args.seeds.split(",") if value.strip()]
    result = run_multiseed(
        seeds, steps=args.steps, codes=args.codes, epochs=args.epochs, lr=args.lr, device=args.device
    )
    text = json.dumps(result, indent=2, sort_keys=True)
    if args.output:
        path = Path(args.output).expanduser().resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text + "\n", "utf-8")
    print(text)
    raise SystemExit(0 if result["pass"] else 1)


if __name__ == "__main__":
    main()
