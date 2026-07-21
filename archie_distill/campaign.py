from __future__ import annotations

import os
import pathlib
import subprocess
import sys
import time
from typing import Any

from .core import read_json, read_jsonl, sha256_file, sha256_text, stable_json, write_json, write_jsonl

SCHEMA_CAMPAIGN = "archie-fork-repair-campaign/v1"


def round_plan(round_index: int, *, root: pathlib.Path) -> dict[str, pathlib.Path]:
    round_dir = root / f"round-{round_index:03d}"
    rollout_dir = round_dir / "on-policy"
    alchemy_dir = round_dir / "alchemy"
    training_dir = round_dir / "training"
    return {
        "round": round_dir,
        "rollout": rollout_dir,
        "repairs": rollout_dir / "on-policy-repairs.jsonl",
        "trajectories": rollout_dir / "on-policy-trajectories.jsonl",
        "alchemy": alchemy_dir,
        "lessons": alchemy_dir / "fork-repair-sft.jsonl",
        "training": training_dir,
        "adapter": training_dir / "adapter",
        "evaluation": round_dir / "evaluation-receipt.json",
    }


def _run(command: list[str], *, env: dict[str, str], log_path: pathlib.Path) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("w", encoding="utf-8") as handle:
        process = subprocess.run(
            command,
            stdout=handle,
            stderr=subprocess.STDOUT,
            text=True,
            env=env,
            check=False,
        )
    if process.returncode != 0:
        raise RuntimeError(f"Command failed with exit code {process.returncode}; inspect {log_path}")


def _cli(*parts: str) -> list[str]:
    return [sys.executable, "-m", "archie_distill.cli", *parts]


def _append_unique(target: pathlib.Path, sources: list[pathlib.Path]) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    source_receipts: list[dict[str, Any]] = []
    for source in sources:
        current = read_jsonl(source)
        source_receipts.append({"path": str(source), "sha256": sha256_file(source), "rows": len(current)})
        for row in current:
            identity = str(row.get("id") or sha256_text(stable_json(row)))
            if identity in seen:
                continue
            seen.add(identity)
            rows.append(row)
    if not rows:
        raise RuntimeError("Cumulative dataset would be empty")
    write_jsonl(target, rows)
    return {
        "path": str(target),
        "sha256": sha256_file(target),
        "rows": len(rows),
        "sources": source_receipts,
    }


def _metric(receipt_path: pathlib.Path) -> float:
    receipt = read_json(receipt_path)
    return float((receipt.get("metrics") or {}).get("combined", 0.0))


def _teacher_environment(config_path: pathlib.Path) -> list[str]:
    config = read_json(config_path)
    teachers = config.get("teachers") or []
    if not teachers:
        raise SystemExit("Campaign config must contain at least one authorized teacher")
    required = sorted({str(item.get("api_key_env")) for item in teachers if item.get("api_key_env")})
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        raise SystemExit(f"Missing teacher credential environment variables: {missing}")
    return required


def configure_parser(parser: Any) -> None:
    parser.add_argument("--config", required=True)
    parser.add_argument("--bootstrap", required=True)
    parser.add_argument("--prompts", required=True)
    parser.add_argument("--holdout", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--initial-adapter")


def run_from_args(args: Any) -> dict[str, Any]:
    config = pathlib.Path(args.config).resolve()
    bootstrap = pathlib.Path(args.bootstrap).resolve()
    prompts = pathlib.Path(args.prompts).resolve()
    holdout = pathlib.Path(args.holdout).resolve()
    model = pathlib.Path(args.model).resolve()
    output = pathlib.Path(args.output).resolve()
    initial_adapter = pathlib.Path(args.initial_adapter).resolve() if args.initial_adapter else None
    rounds = int(args.rounds)

    if rounds <= 0:
        raise SystemExit("--rounds must be positive")
    if output.exists():
        raise SystemExit(f"Refusing to overwrite existing campaign output: {output}")
    required_files = [config, bootstrap, prompts, holdout]
    missing = [str(path) for path in required_files if not path.is_file()]
    if missing:
        raise SystemExit(f"Missing campaign inputs: {missing}")
    if not model.is_dir():
        raise SystemExit(f"Local model directory is missing: {model}")
    if initial_adapter is not None and not initial_adapter.is_dir():
        raise SystemExit(f"Initial adapter directory is missing: {initial_adapter}")
    teacher_environment = _teacher_environment(config)

    output.mkdir(parents=True)
    env = dict(os.environ)
    env.setdefault("PYTHONUNBUFFERED", "1")
    env.setdefault("TOKENIZERS_PARALLELISM", "false")

    lesson_paths: list[pathlib.Path] = [bootstrap]
    trajectory_paths: list[pathlib.Path] = []
    round_receipts: list[dict[str, Any]] = []
    started = time.monotonic()

    if initial_adapter is None:
        bootstrap_dir = output / "bootstrap-training"
        _run(
            _cli(
                "train",
                "--config", str(config),
                "--dataset", str(bootstrap),
                "--model", str(model),
                "--output", str(bootstrap_dir),
            ),
            env=env,
            log_path=output / "bootstrap-training.log",
        )
        current_adapter = bootstrap_dir / "adapter"
        bootstrap_training = {
            "mode": "trained",
            "adapter": str(current_adapter),
            "receipt": {
                "path": str(bootstrap_dir / "training-receipt.json"),
                "sha256": sha256_file(bootstrap_dir / "training-receipt.json"),
            },
        }
    else:
        current_adapter = initial_adapter
        bootstrap_training = {"mode": "supplied", "adapter": str(current_adapter)}

    bootstrap_evaluation = output / "bootstrap-evaluation-receipt.json"
    _run(
        _cli(
            "evaluate",
            "--config", str(config),
            "--holdout", str(holdout),
            "--model", str(model),
            "--adapter", str(current_adapter),
            "--output", str(bootstrap_evaluation),
        ),
        env=env,
        log_path=output / "bootstrap-evaluation.log",
    )
    best_adapter: pathlib.Path = current_adapter
    best_score = _metric(bootstrap_evaluation)

    for round_index in range(rounds):
        paths = round_plan(round_index, root=output)
        paths["round"].mkdir(parents=True)

        rollout_command = _cli(
            "on-policy",
            "--config", str(config),
            "--prompts", str(prompts),
            "--model", str(model),
            "--adapter", str(current_adapter),
            "--round", str(round_index),
            "--output", str(paths["rollout"]),
        )
        if trajectory_paths:
            history_path = paths["round"] / "prior-trajectories.jsonl"
            history_receipt = _append_unique(history_path, trajectory_paths)
            rollout_command.extend(["--history", str(history_path)])
        else:
            history_receipt = None
        _run(rollout_command, env=env, log_path=paths["round"] / "on-policy.log")
        trajectory_paths.append(paths["trajectories"])

        repairs = read_jsonl(paths["repairs"])
        if not repairs:
            round_receipts.append({
                "round_index": round_index,
                "status": "converged-no-teacher-repairs",
                "adapter": str(current_adapter),
                "history": history_receipt,
            })
            break

        _run(
            _cli(
                "alchemy",
                "--config", str(config),
                "--repairs", str(paths["repairs"]),
                "--model", str(model),
                "--output", str(paths["alchemy"]),
            ),
            env=env,
            log_path=paths["round"] / "alchemy.log",
        )
        lesson_paths.append(paths["lessons"])
        cumulative_path = paths["round"] / "cumulative-sft.jsonl"
        cumulative = _append_unique(cumulative_path, lesson_paths)

        _run(
            _cli(
                "train",
                "--config", str(config),
                "--dataset", str(cumulative_path),
                "--model", str(model),
                "--output", str(paths["training"]),
            ),
            env=env,
            log_path=paths["round"] / "training.log",
        )
        current_adapter = paths["adapter"]

        _run(
            _cli(
                "evaluate",
                "--config", str(config),
                "--holdout", str(holdout),
                "--model", str(model),
                "--adapter", str(current_adapter),
                "--output", str(paths["evaluation"]),
            ),
            env=env,
            log_path=paths["round"] / "evaluation.log",
        )
        score = _metric(paths["evaluation"])
        if score > best_score:
            best_score = score
            best_adapter = current_adapter

        round_receipts.append({
            "round_index": round_index,
            "status": "completed",
            "repairs": len(repairs),
            "cumulative_dataset": cumulative,
            "adapter": str(current_adapter),
            "evaluation": {
                "path": str(paths["evaluation"]),
                "sha256": sha256_file(paths["evaluation"]),
                "combined": score,
            },
            "history": history_receipt,
        })
        write_json(output / "campaign-progress.json", {
            "schema": SCHEMA_CAMPAIGN,
            "bootstrap": bootstrap_training,
            "rounds": round_receipts,
            "best_adapter": str(best_adapter),
            "best_combined": best_score,
            "promotion": "not-admitted",
        })

    receipt: dict[str, Any] = {
        "schema": SCHEMA_CAMPAIGN,
        "method": "bootstrap-then-iterative-student-rollout-fork-repair-cumulative-qlora-sft/v1",
        "inputs": {
            "config": {"path": str(config), "sha256": sha256_file(config)},
            "bootstrap": {"path": str(bootstrap), "sha256": sha256_file(bootstrap)},
            "prompts": {"path": str(prompts), "sha256": sha256_file(prompts)},
            "holdout": {"path": str(holdout), "sha256": sha256_file(holdout)},
            "model": str(model),
            "initial_adapter": str(initial_adapter) if initial_adapter else None,
            "teacher_environment_names": teacher_environment,
        },
        "bootstrap_training": bootstrap_training,
        "bootstrap_evaluation": {
            "path": str(bootstrap_evaluation),
            "sha256": sha256_file(bootstrap_evaluation),
            "combined": _metric(bootstrap_evaluation),
        },
        "requested_rounds": rounds,
        "completed_rounds": sum(item.get("status") == "completed" for item in round_receipts),
        "rounds": round_receipts,
        "selection": {"best_adapter": str(best_adapter), "best_combined": best_score},
        "runtime_seconds": round(time.monotonic() - started, 3),
        "claim_boundary": "The campaign selects only by frozen holdout evidence and remains research-only.",
        "promotion": "not-admitted",
    }
    receipt["receipt_digest"] = sha256_text(stable_json(receipt))
    write_json(output / "campaign-receipt.json", receipt)
    return receipt
