#!/usr/bin/env python3
"""Device shim for the frozen terminal-efficiency trainer.

It changes only tensor placement. Architecture, data generation, objective, successive-halving
allocation, sealed evaluator, and report schema remain owned by efficient_terminal_training.py.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import torch

from research import efficient_terminal_training as trainer


def move(value: Any, device: torch.device) -> Any:
    if torch.is_tensor(value):
        return value.to(device, non_blocking=device.type == "cuda")
    if isinstance(value, dict):
        return {key: move(item, device) for key, item in value.items()}
    if isinstance(value, list):
        return [move(item, device) for item in value]
    if isinstance(value, tuple):
        return tuple(move(item, device) for item in value)
    return value


def choose_device(name: str) -> torch.device:
    if name == "auto":
        name = "cuda" if torch.cuda.is_available() else "cpu"
    device = torch.device(name)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA was requested but torch.cuda.is_available() is false")
    return device


def install_device_transport(device: torch.device) -> None:
    original_generate = trainer.base.generate_batch
    original_build = trainer.build_model
    original_metrics = trainer._batch_metrics

    def generate_on_device(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return move(original_generate(*args, **kwargs), device)

    def build_on_device(*args: Any, **kwargs: Any) -> trainer.base.BaseModel:
        return original_build(*args, **kwargs).to(device)

    def metrics_on_device(model: trainer.base.BaseModel, cfg: trainer.base.WorldConfig, batch: dict[str, Any]) -> dict[str, float]:
        return original_metrics(model, cfg, move(batch, device))

    trainer.base.generate_batch = generate_on_device
    trainer.build_model = build_on_device
    trainer._batch_metrics = metrics_on_device


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser()
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--campaign-root", type=Path, required=True)
    p.add_argument("--scale", choices=[s.name for s in trainer.campaign.SCALES], default="base")
    p.add_argument("--seed", type=int, default=30260721)
    p.add_argument("--rung1", type=int, default=256)
    p.add_argument("--rung2", type=int, default=768)
    p.add_argument("--rung3", type=int, default=2048)
    p.add_argument("--batch-size", type=int, default=64)
    p.add_argument("--eval-batch-size", type=int, default=64)
    p.add_argument("--threads", type=int, default=4)
    p.add_argument("--device", choices=["auto", "cpu", "cuda"], default="cuda")
    return p


def main() -> None:
    args = parser().parse_args()
    device = choose_device(args.device)
    install_device_transport(device)
    report = trainer.run(args)
    report["runtime_device"] = {
        "type": device.type,
        "name": torch.cuda.get_device_name(device) if device.type == "cuda" else "cpu",
        "torch": torch.__version__,
        "cuda": torch.version.cuda,
    }
    trainer.atomic_json(report, args.output / "terminal-efficiency-report.json")
    print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    main()
