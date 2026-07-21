from __future__ import annotations

import argparse
import dataclasses
import hashlib
import importlib.util
import json
import os
import random
import statistics
import sys
import time
from pathlib import Path
from types import ModuleType
from typing import Any

from .checkpoints import RunIdentity, require_identity, write_checkpoint_metadata


def _load_training_module(source_root: Path) -> ModuleType:
    path = source_root / "foundry/archie-protocol/latent_world_benchmark/research/efficient_terminal_training.py"
    spec = importlib.util.spec_from_file_location("squeeze_upstream_terminal", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load allowlisted training entrypoint")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _to_device(value: Any, device: Any) -> Any:
    import torch

    if isinstance(value, torch.Tensor):
        return value.to(device, non_blocking=True)
    if isinstance(value, dict):
        return {k: _to_device(v, device) for k, v in value.items()}
    if isinstance(value, list):
        return [_to_device(v, device) for v in value]
    if isinstance(value, tuple):
        return tuple(_to_device(v, device) for v in value)
    return value


def _patch_batches(module: ModuleType, device: Any) -> None:
    original = module.base.generate_batch

    def generate_batch(*args: Any, **kwargs: Any) -> Any:
        return _to_device(original(*args, **kwargs), device)

    module.base.generate_batch = generate_batch


def _save_state(path: Path, module: ModuleType, identity: RunIdentity, payload: dict[str, Any]) -> None:
    import torch

    path.parent.mkdir(parents=True, exist_ok=True)
    state = {
        "schema": "squeeze-terminal-state-v1",
        "identity": identity.as_dict(),
        **payload,
        "python_random_state": random.getstate(),
        "torch_rng_state": torch.get_rng_state(),
        "cuda_rng_state": torch.cuda.get_rng_state_all(),
        "promotion": module.PROMOTION,
    }
    temporary = path.with_suffix(".tmp")
    torch.save(state, temporary)
    os.replace(temporary, path)


def _load_state(path: Path, identity: RunIdentity, device: Any) -> dict[str, Any]:
    import torch

    state = torch.load(path, map_location=device, weights_only=False)
    if state.get("schema") != "squeeze-terminal-state-v1":
        raise RuntimeError("unknown relay state schema")
    require_identity(identity, state.get("identity", {}))
    if state.get("promotion") != "research-only-not-admitted":
        raise RuntimeError("promotion changed in relay state")
    random.setstate(state["python_random_state"])
    torch.set_rng_state(state["torch_rng_state"].cpu())
    torch.cuda.set_rng_state_all(state["cuda_rng_state"])
    return state


def _serialize_trials(trials: dict[tuple[str, int], dict[str, Any]]) -> dict[str, Any]:
    result = {}
    for (arm_name, seed), trial in trials.items():
        result[f"{arm_name}::{seed}"] = {
            "arm": dataclasses.asdict(trial["arm"]),
            "seed": seed,
            "step": trial["step"],
            "history": trial["history"],
            "event_tokens": trial["event_tokens"],
            "metrics": trial.get("metrics"),
            "model_state": trial["model"].state_dict(),
            "optimizer_state": trial["optimizer"].state_dict(),
        }
    return result


def _restore_trials(module: ModuleType, cfg: Any, raw: dict[str, Any], device: Any) -> dict[tuple[str, int], dict[str, Any]]:
    import torch

    arms = {arm.name: arm for arm in module.ARMS}
    result = {}
    for record in raw.values():
        arm = arms[record["arm"]["name"]]
        model = module.build_model(arm.kind, cfg, arm.width).to(device)
        optimizer = torch.optim.AdamW(model.parameters(), lr=arm.lr, weight_decay=1e-4)
        model.load_state_dict(record["model_state"])
        optimizer.load_state_dict(record["optimizer_state"])
        result[(arm.name, int(record["seed"]))] = {
            "arm": arm,
            "seed": int(record["seed"]),
            "model": model,
            "optimizer": optimizer,
            "step": int(record["step"]),
            "history": list(record["history"]),
            "event_tokens": int(record["event_tokens"]),
            "metrics": record.get("metrics"),
        }
    return result


def _one_step(module: ModuleType, trial: dict[str, Any], cfg: Any, batch_size: int) -> None:
    import torch

    step = trial["step"]
    lengths = (4, 6, 8) if step < 256 else ((6, 8, 12, 14) if step < 768 else (8, 12, 16, 20))
    length = lengths[step % len(lengths)]
    batch = module.base.generate_batch(cfg, batch_size, length, trial["seed"] * 1_000_003 + step * 17, "train")
    optimizer = trial["optimizer"]
    model = trial["model"]
    optimizer.zero_grad(set_to_none=True)
    out = model(batch["events"], batch["initial"])
    loss, parts = module.terminal_weighted_loss(out, batch, cfg)
    if not torch.isfinite(loss):
        raise RuntimeError("non-finite loss")
    loss.backward()
    grad = float(torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0))
    optimizer.step()
    trial["step"] += 1
    trial["event_tokens"] += length * batch_size
    if trial["step"] == 1 or trial["step"] % 128 == 0:
        trial["history"].append({"step": trial["step"], "loss": float(loss.detach()), "grad_norm": grad, **parts})


def _frozen_eval(module: ModuleType, model: Any, cfg: Any, campaign_root: Path, scale: str, device: Any) -> dict[str, Any]:
    import torch

    manifest = json.loads((campaign_root / "campaign-manifest.json").read_text(encoding="utf-8"))
    suites = {}
    for suite in module.campaign.SUITES:
        records = [r for r in manifest["corpus"] if r["scale"] == scale and r["suite"] == suite.name]
        metrics = []
        for record in records:
            artifact = campaign_root / record["artifact"]
            if module.sha256_file(artifact) != record["artifact_sha256"]:
                raise RuntimeError(f"frozen batch digest mismatch: {artifact}")
            batch = _to_device(torch.load(artifact, map_location="cpu", weights_only=False), device)
            metrics.append(module._batch_metrics(model, cfg, batch))
        suites[suite.name] = module._aggregate(metrics)
    summary = module._aggregate([suites[s.name] for s in module.campaign.SUITES])
    return {
        "manifest_sha256": manifest["manifest_sha256"],
        "metric_correction": "full_exact_terminal includes queue occupancy and queue identity; legacy exact_terminal omitted queue",
        "suites": suites,
        "summary": summary,
    }


def run(args: argparse.Namespace) -> dict[str, Any]:
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is required")
    device = torch.device("cuda:0")
    module = _load_training_module(args.source_root)
    _patch_batches(module, device)
    identity = RunIdentity(**json.loads(args.identity_json))
    cfg = module.campaign.scale_by_name(args.scale).world
    rung_steps = [192, 640, 1536]
    seeds = [30260721, 30360724]
    state_path = args.checkpoint_root / "terminal-state.pt"
    trials: dict[tuple[str, int], dict[str, Any]] = {}
    active = list(module.ARMS)
    start_rung = 0
    resume_count = 0
    started = time.monotonic()

    if args.resume:
        if not state_path.exists():
            raise RuntimeError("resume requested without checkpoint")
        state = _load_state(state_path, identity, device)
        trials = _restore_trials(module, cfg, state["trials"], device)
        active_names = state["active"]
        active = [arm for arm in module.ARMS if arm.name in active_names]
        start_rung = int(state["rung_index"])
        resume_count = int(state.get("resume_count", 0)) + 1

    def persist(rung_index: int) -> None:
        total_steps = sum(t["step"] for t in trials.values())
        total_tokens = sum(t["event_tokens"] for t in trials.values())
        _save_state(
            state_path,
            module,
            identity,
            {
                "rung_index": rung_index,
                "active": [arm.name for arm in active],
                "trials": _serialize_trials(trials),
                "resume_count": resume_count,
            },
        )
        write_checkpoint_metadata(
            args.checkpoint_root,
            identity,
            optimizer_steps=total_steps,
            event_tokens=total_tokens,
            allocation_rung=min(rung_index + 1, len(rung_steps)),
            resume_count=resume_count,
            state_file=state_path.name,
        )

    for rung_index in range(start_rung, len(rung_steps)):
        stop = rung_steps[rung_index]
        for arm in list(active):
            for seed in seeds:
                key = (arm.name, seed)
                if key not in trials:
                    torch.manual_seed(seed)
                    random.seed(seed)
                    model = module.build_model(arm.kind, cfg, arm.width).to(device)
                    optimizer = torch.optim.AdamW(model.parameters(), lr=arm.lr, weight_decay=1e-4)
                    trials[key] = {"arm": arm, "seed": seed, "model": model, "optimizer": optimizer, "step": 0, "history": [], "event_tokens": 0}
                trial = trials[key]
                while trial["step"] < stop:
                    _one_step(module, trial, cfg, 64)
                    if trial["step"] % args.checkpoint_interval == 0:
                        persist(rung_index)
                trial["metrics"] = module.evaluate(trial["model"], cfg, [seed + 700_001, seed + 700_019], batch_size=32)
                persist(rung_index)

        grouped = []
        for arm in active:
            values = [trials[(arm.name, seed)]["metrics"]["score"] for seed in seeds]
            grouped.append((statistics.fmean(values), arm))
        grouped.sort(key=lambda item: item[0], reverse=True)
        active = [arm for _, arm in grouped[: [3, 2, 1][rung_index]]]
        module.atomic_json(
            {
                "schema": module.SCHEMA,
                "rung": rung_index + 1,
                "steps": stop,
                "ranking": [{"arm": arm.name, "mean_score": score} for score, arm in grouped],
                "promoted": [arm.name for arm in active],
                "promotion": module.PROMOTION,
            },
            args.output / f"rung-{rung_index + 1}.json",
        )
        persist(rung_index + 1)

    winner = active[0]
    records = []
    args.output.mkdir(parents=True, exist_ok=True)
    for seed in seeds:
        trial = trials[(winner.name, seed)]
        checkpoint = args.output / f"{winner.name}__seed{seed}.pt"
        params = sum(parameter.numel() for parameter in trial["model"].parameters())
        torch.save(
            {
                "schema": module.SCHEMA,
                "arm": dataclasses.asdict(winner),
                "world": dataclasses.asdict(cfg),
                "seed": seed,
                "steps": trial["step"],
                "state_dict": trial["model"].state_dict(),
                "optimizer_state": trial["optimizer"].state_dict(),
                "scheduler_state": None,
                "scaler_state": None,
                "python_random_state": random.getstate(),
                "torch_rng_state": torch.get_rng_state(),
                "cuda_rng_state": torch.cuda.get_rng_state_all(),
                "allocation_rung": len(rung_steps),
                "event_tokens": trial["event_tokens"],
                "identity": identity.as_dict(),
                "promotion": module.PROMOTION,
            },
            checkpoint,
        )
        sealed = _frozen_eval(module, trial["model"], cfg, args.campaign_root, args.scale, device)
        records.append(
            {
                "arm": winner.name,
                "seed": seed,
                "steps": trial["step"],
                "parameters": params,
                "event_tokens": trial["event_tokens"],
                "estimated_training_flops": int(6 * params * trial["event_tokens"]),
                "dev": trial["metrics"],
                "sealed_canonical": sealed,
                "history": trial["history"],
                "checkpoint": checkpoint.name,
                "checkpoint_sha256": module.sha256_file(checkpoint),
            }
        )
    torch.cuda.synchronize()
    report = {
        "schema": module.SCHEMA,
        "promotion": module.PROMOTION,
        "scale": args.scale,
        "winner": dataclasses.asdict(winner),
        "rung_steps": rung_steps,
        "seeds": seeds,
        "elapsed_seconds": time.monotonic() - started,
        "resume_count": resume_count,
        "device": str(device),
        "gpu_name": torch.cuda.get_device_name(0),
        "records": records,
        "selection_rule": "successive halving on generated development seeds; sealed canonical corpus is used only after arm selection",
        "historical_audit": module.historical_audit(args.campaign_root, args.scale),
        "known_boundary": "compact factorized neuro-symbolic executor; exact structural transport is supplied and admission remains prohibited",
        "relay_identity_sha256": identity.digest(),
    }
    module.atomic_json(report, args.output / "terminal-efficiency-report.json")
    persist(len(rung_steps))
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--campaign-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--checkpoint-root", type=Path, required=True)
    parser.add_argument("--identity-json", required=True)
    parser.add_argument("--checkpoint-interval", type=int, default=64)
    parser.add_argument("--scale", choices=["base"], default="base")
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    print(json.dumps(run(args), sort_keys=True))


if __name__ == "__main__":
    main()
