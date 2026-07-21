#!/usr/bin/env python3
from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import math
import os
import random
import statistics
import time
from pathlib import Path
from typing import Any

import torch
import torch.nn as nn
import torch.nn.functional as F

import latent_world_benchmark as base
import full_budget_campaign as campaign
import research.efficient_terminal_training as terminal
import research.operation_information_probe as diagnostic

SCHEMA = "archie-operation-recovery/v1"
PROMOTION = "research-only-not-admitted"
DEFAULT_RECOVERY_SEEDS = (60260721, 60360724, 60460727)


def atomic_json(value: Any, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def sha256_file(path: Path) -> str:
    return diagnostic.sha256_file(path)


def semantic_operation_registry() -> torch.Tensor:
    """Benchmark-declared operation signatures, independent of frozen examples.

    Columns are the nine typed primitive controls followed by the four operation
    flags. Labels 9 and 10 are held-out conjunctions of already declared controls.
    """
    registry = torch.zeros(base.N_OPS, base.N_PRIMITIVES + 4, dtype=torch.float32)

    def set_signature(label: int, primitives: tuple[int, ...], flags: tuple[int, ...] = ()) -> None:
        for primitive in primitives:
            registry[label, primitive] = 1.0
        for flag in flags:
            registry[label, base.N_PRIMITIVES + flag] = 1.0

    set_signature(0, (base.P_WRITE,))
    set_signature(1, (base.P_WRITE, base.P_READ), (0,))
    set_signature(2, (base.P_WRITE, base.P_NEGATE))
    set_signature(3, (base.P_WRITE, base.P_READ, base.P_SWAP), (0,))
    set_signature(4, (base.P_SOURCE,), (1,))
    set_signature(5, (base.P_AUTH,))
    set_signature(6, (base.P_QUEUE,))
    set_signature(7, (base.P_CORRECT,), (2,))
    set_signature(8, ())
    set_signature(9, (base.P_WRITE, base.P_READ, base.P_NEGATE), (0, 3))
    set_signature(10, (base.P_WRITE, base.P_SOURCE, base.P_CONDITIONAL), (1, 3))
    return registry


def registry_sha256(registry: torch.Tensor) -> str:
    payload = json.dumps(registry.int().tolist(), separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


class SharedBitOperationEncoder(nn.Module):
    """A tied per-control encoder that composes across unseen bit positions.

    The same scalar network is applied to every primitive/flag bit. Training on
    ordinary operations therefore teaches the shared 0/1 representation without
    requiring examples of the held-out conjunction labels.
    """

    def __init__(self, hidden: int = 12) -> None:
        super().__init__()
        self.hidden = hidden
        self.bit_encoder = nn.Sequential(
            nn.Linear(1, hidden),
            nn.GELU(),
            nn.Linear(hidden, 1),
        )

    def forward(self, signature_bits: torch.Tensor) -> torch.Tensor:
        return self.bit_encoder(signature_bits.unsqueeze(-1)).squeeze(-1)


def decode_operation_labels(signature_logits: torch.Tensor, registry: torch.Tensor) -> torch.Tensor:
    probabilities = signature_logits.sigmoid()
    distance = (probabilities[:, None, :] - registry[None, :, :]).square().mean(-1)
    return distance.argmin(-1)


def collect_training_signatures(
    cfg: base.WorldConfig,
    *,
    seed: int,
    batches: int,
    batch_size: int,
) -> tuple[torch.Tensor, torch.Tensor, int]:
    signatures: list[torch.Tensor] = []
    labels: list[torch.Tensor] = []
    event_tokens = 0
    lengths = (4, 6, 8, 12, 16, 20)
    for index in range(batches):
        length = lengths[index % len(lengths)]
        batch = base.generate_batch(cfg, batch_size, length, seed + index * 1009, "train")
        signatures.append(diagnostic.operation_signature(batch["events"], cfg).reshape(-1, base.N_PRIMITIVES + 4))
        labels.append(batch["ops"].reshape(-1))
        event_tokens += batch_size * length
    return torch.cat(signatures).float(), torch.cat(labels).long(), event_tokens


def validate_registry(signatures: torch.Tensor, labels: torch.Tensor, registry: torch.Tensor) -> dict[str, Any]:
    expected = registry[labels]
    mismatches = ~expected.eq(signatures).all(-1)
    return {
        "examples": int(labels.numel()),
        "labels": sorted(int(value) for value in torch.unique(labels)),
        "mismatches": int(mismatches.sum()),
        "valid": not bool(mismatches.any()),
    }


def fit_recovery_adapter(
    signatures: torch.Tensor,
    *,
    seed: int,
    steps: int,
    batch_size: int,
    learning_rate: float,
    hidden: int,
) -> tuple[SharedBitOperationEncoder, torch.optim.Optimizer, list[dict[str, float]], int]:
    torch.manual_seed(seed)
    random.seed(seed)
    model = SharedBitOperationEncoder(hidden=hidden)
    optimizer = torch.optim.AdamW(model.parameters(), lr=learning_rate, weight_decay=1e-4)
    positive = signatures.sum(0)
    negative = signatures.size(0) - positive
    pos_weight = (negative / positive.clamp_min(1.0)).clamp(1.0, 20.0)
    generator = torch.Generator().manual_seed(seed + 31)
    history: list[dict[str, float]] = []
    sampled_tokens = 0
    model.train()
    for step in range(steps):
        indices = torch.randint(0, signatures.size(0), (batch_size,), generator=generator)
        batch = signatures[indices]
        sampled_tokens += int(batch.size(0))
        optimizer.zero_grad(set_to_none=True)
        logits = model(batch)
        loss = F.binary_cross_entropy_with_logits(logits, batch, pos_weight=pos_weight)
        if not torch.isfinite(loss):
            raise RuntimeError("non-finite operation-recovery loss")
        loss.backward()
        grad_norm = float(torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0))
        optimizer.step()
        if step == 0 or (step + 1) % 32 == 0 or step + 1 == steps:
            predicted = logits.sigmoid().ge(0.5)
            exact = predicted.eq(batch.ge(0.5)).all(-1).float().mean()
            bit_accuracy = predicted.eq(batch.ge(0.5)).float().mean()
            history.append({
                "step": step + 1,
                "loss": float(loss.detach()),
                "grad_norm": grad_norm,
                "batch_exact_signature": float(exact),
                "batch_bit_accuracy": float(bit_accuracy),
            })
    return model, optimizer, history, sampled_tokens


def confusion_matrix(true_labels: torch.Tensor, predicted_labels: torch.Tensor) -> dict[str, dict[str, int]]:
    result: dict[str, dict[str, int]] = {}
    for truth in sorted(int(value) for value in torch.unique(true_labels)):
        selected = predicted_labels[true_labels.eq(truth)]
        result[str(truth)] = {
            str(prediction): int(selected.eq(prediction).sum())
            for prediction in sorted(int(value) for value in torch.unique(selected))
        }
    return result


def evaluate_recovery(
    frozen_model: base.BaseModel,
    adapter: SharedBitOperationEncoder,
    cfg: base.WorldConfig,
    campaign_root: Path,
    scale: str,
    registry: torch.Tensor,
) -> dict[str, Any]:
    metric_rows: list[dict[str, float]] = []
    true_rows: list[torch.Tensor] = []
    predicted_rows: list[torch.Tensor] = []
    signature_exact_rows: list[torch.Tensor] = []
    signature_bit_rows: list[torch.Tensor] = []
    registry_audits: list[dict[str, Any]] = []
    adapter.eval()
    frozen_model.eval()
    with torch.no_grad():
        for record in diagnostic.frozen_intervention_records(campaign_root, scale):
            batch = torch.load(campaign_root / record["artifact"], map_location="cpu", weights_only=False)
            out = frozen_model(batch["events"], batch["initial"])
            metric_rows.append(terminal._batch_metrics(frozen_model, cfg, batch))
            signatures = diagnostic.operation_signature(batch["events"], cfg).reshape(-1, base.N_PRIMITIVES + 4)
            labels = batch["ops"].reshape(-1)
            registry_audits.append(validate_registry(signatures, labels, registry))
            logits = adapter(signatures)
            predicted = decode_operation_labels(logits, registry)
            predicted_bits = logits.sigmoid().ge(0.5)
            true_bits = signatures.ge(0.5)
            true_rows.append(labels)
            predicted_rows.append(predicted)
            signature_exact_rows.append(predicted_bits.eq(true_bits).all(-1))
            signature_bit_rows.append(predicted_bits.eq(true_bits).float())

    true_labels = torch.cat(true_rows)
    predicted_labels = torch.cat(predicted_rows)
    exact_signature = torch.cat(signature_exact_rows).float().mean()
    bit_accuracy = torch.cat(signature_bit_rows).float().mean()
    terminal_metrics = terminal._aggregate(metric_rows)
    return {
        "operation_accuracy": float(predicted_labels.eq(true_labels).float().mean()),
        "signature_exact_accuracy": float(exact_signature),
        "signature_bit_accuracy": float(bit_accuracy),
        "operation_confusion": confusion_matrix(true_labels, predicted_labels),
        "true_labels": sorted(int(value) for value in torch.unique(true_labels)),
        "examples": int(true_labels.numel()),
        "registry_audits": registry_audits,
        "terminal": terminal_metrics,
    }


def mean_ci95(values: list[float]) -> dict[str, float]:
    mean = statistics.fmean(values)
    if len(values) < 2:
        return {"mean": mean, "low": mean, "high": mean, "n": len(values)}
    stderr = statistics.stdev(values) / math.sqrt(len(values))
    radius = 1.96 * stderr
    return {"mean": mean, "low": max(0.0, mean - radius), "high": min(1.0, mean + radius), "n": len(values)}


def run(args: argparse.Namespace) -> dict[str, Any]:
    torch.set_num_threads(max(1, min(args.threads, os.cpu_count() or 1)))
    if len(args.checkpoint) != len(args.checkpoint_sha256):
        raise ValueError("--checkpoint and --checkpoint-sha256 counts must match")
    args.output.mkdir(parents=True, exist_ok=False)
    registry = semantic_operation_registry()
    registry_digest = registry_sha256(registry)
    started = time.monotonic()
    records: list[dict[str, Any]] = []

    for checkpoint_path, expected_sha256 in zip(args.checkpoint, args.checkpoint_sha256, strict=True):
        frozen_model, cfg, checkpoint, observed_sha256 = diagnostic.load_frozen_model(checkpoint_path, expected_sha256)
        historical_before = diagnostic.state_dict_sha256(frozen_model.state_dict())
        train_signatures, train_labels, generated_event_tokens = collect_training_signatures(
            cfg,
            seed=args.train_seed,
            batches=args.train_batches,
            batch_size=args.train_batch_size,
        )
        train_registry_audit = validate_registry(train_signatures, train_labels, registry)
        if not train_registry_audit["valid"]:
            raise RuntimeError(f"declared semantic registry disagrees with generated training operations: {train_registry_audit}")
        if set(train_registry_audit["labels"]) != set(range(9)):
            raise RuntimeError(f"unexpected ordinary operation support: {train_registry_audit['labels']}")

        for recovery_seed in args.recovery_seed:
            stage_started = time.monotonic()
            adapter, optimizer, history, sampled_tokens = fit_recovery_adapter(
                train_signatures,
                seed=recovery_seed,
                steps=args.steps,
                batch_size=args.batch_size,
                learning_rate=args.learning_rate,
                hidden=args.hidden,
            )
            evaluation = evaluate_recovery(frozen_model, adapter, cfg, args.campaign_root, args.scale, registry)
            if not all(audit["valid"] for audit in evaluation["registry_audits"]):
                raise RuntimeError("declared semantic registry disagrees with frozen intervention operations")
            parameters = sum(parameter.numel() for parameter in adapter.parameters())
            checkpoint_name = f"operation-recovery__terminal-seed{checkpoint['seed']}__seed{recovery_seed}.pt"
            adapter_path = args.output / checkpoint_name
            torch.save({
                "schema": SCHEMA,
                "promotion": PROMOTION,
                "historical_terminal_run": 29867827958,
                "historical_terminal_artifact": 8510576517,
                "historical_checkpoint_sha256": observed_sha256,
                "historical_checkpoint_seed": checkpoint["seed"],
                "historical_checkpoint_steps": checkpoint["steps"],
                "campaign_manifest_sha256": json.loads((args.campaign_root / "campaign-manifest.json").read_text(encoding="utf-8"))["manifest_sha256"],
                "semantic_registry": registry.int().tolist(),
                "semantic_registry_sha256": registry_digest,
                "adapter_kind": "shared-bit-compositional-operation-encoder",
                "adapter_hidden": args.hidden,
                "adapter_parameters": parameters,
                "recovery_seed": recovery_seed,
                "steps": args.steps,
                "sampled_operation_tokens": sampled_tokens,
                "state_dict": adapter.state_dict(),
                "optimizer_state": optimizer.state_dict(),
            }, adapter_path)
            terminal_metrics = evaluation["terminal"]
            gate_passed = (
                evaluation["operation_accuracy"] >= args.operation_gate
                and terminal_metrics["full_exact_terminal"] >= args.full_exact_gate
                and terminal_metrics["trajectory_full_exact"] >= args.trajectory_gate
                and terminal_metrics["slot_accuracy"] >= args.slot_gate
            )
            records.append({
                "historical_checkpoint": checkpoint_path.name,
                "historical_checkpoint_sha256": observed_sha256,
                "historical_checkpoint_seed": checkpoint["seed"],
                "historical_checkpoint_steps": checkpoint["steps"],
                "historical_optimizer_state_nonempty": bool(checkpoint["optimizer_state"].get("state")),
                "historical_state_dict_sha256_before": historical_before,
                "historical_state_dict_sha256_after": diagnostic.state_dict_sha256(frozen_model.state_dict()),
                "recovery_seed": recovery_seed,
                "adapter_parameters": parameters,
                "steps": args.steps,
                "generated_training_event_tokens": generated_event_tokens,
                "sampled_operation_tokens": sampled_tokens,
                "estimated_training_flops": int(6 * parameters * sampled_tokens),
                "elapsed_seconds": time.monotonic() - stage_started,
                "history": history,
                "train_registry_audit": train_registry_audit,
                "evaluation": evaluation,
                "gate_passed": gate_passed,
                "checkpoint": checkpoint_name,
                "checkpoint_sha256": sha256_file(adapter_path),
            })

    for record in records:
        if record["historical_state_dict_sha256_before"] != record["historical_state_dict_sha256_after"]:
            raise RuntimeError("historical terminal executor changed during operation recovery")

    operation_values = [record["evaluation"]["operation_accuracy"] for record in records]
    full_exact_values = [record["evaluation"]["terminal"]["full_exact_terminal"] for record in records]
    trajectory_values = [record["evaluation"]["terminal"]["trajectory_full_exact"] for record in records]
    slot_values = [record["evaluation"]["terminal"]["slot_accuracy"] for record in records]
    all_passed = all(record["gate_passed"] for record in records)
    report = {
        "schema": SCHEMA,
        "promotion": PROMOTION,
        "historical_terminal_run": 29867827958,
        "historical_terminal_artifact": 8510576517,
        "historical_terminal_artifact_digest": "c35cc475bcc0bb477d25ae1670dc0b4a4f4c762cc486e247766d11b0ce77c7dd",
        "phase_a_run": 29873890061,
        "phase_a_artifact": 8512254404,
        "phase_a_verdict": "operation-representation-insufficient-head-only-falsified",
        "canonical_campaign_run": 29834460894,
        "canonical_campaign_artifact": 8504094525,
        "semantic_registry": registry.int().tolist(),
        "semantic_registry_sha256": registry_digest,
        "architecture": "shared tied scalar encoder over explicit typed primitive and flag controls; historical terminal executor frozen",
        "configuration": {
            "scale": args.scale,
            "train_seed": args.train_seed,
            "train_batches": args.train_batches,
            "train_batch_size": args.train_batch_size,
            "recovery_seeds": args.recovery_seed,
            "steps": args.steps,
            "batch_size": args.batch_size,
            "learning_rate": args.learning_rate,
            "hidden": args.hidden,
            "operation_gate": args.operation_gate,
            "full_exact_gate": args.full_exact_gate,
            "trajectory_gate": args.trajectory_gate,
            "slot_gate": args.slot_gate,
        },
        "records": records,
        "confidence_intervals": {
            "operation_accuracy": mean_ci95(operation_values),
            "full_exact_terminal": mean_ci95(full_exact_values),
            "trajectory_full_exact": mean_ci95(trajectory_values),
            "slot_accuracy": mean_ci95(slot_values),
        },
        "all_records_passed": all_passed,
        "verdict": "operation-recovery-gate-passed" if all_passed else "operation-recovery-gate-failed",
        "known_boundary": (
            "Operation recovery uses explicitly exposed typed primitive/flag controls and a declared compositional registry. "
            "It does not show that the terminal hidden state learned operation identity or a latent program."
        ),
        "elapsed_seconds": time.monotonic() - started,
    }
    atomic_json(report, args.output / "operation-recovery-report.json")
    inventory = []
    for path in sorted(args.output.rglob("*")):
        if path.is_file() and path.name != "SHA256SUMS":
            inventory.append(f"{sha256_file(path)}  {path.relative_to(args.output)}")
    (args.output / "SHA256SUMS").write_text("\n".join(inventory) + "\n", encoding="utf-8")
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--campaign-root", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path, action="append", required=True)
    parser.add_argument("--checkpoint-sha256", action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--scale", choices=[scale.name for scale in campaign.SCALES], default="base")
    parser.add_argument("--train-seed", type=int, default=70260721)
    parser.add_argument("--train-batches", type=int, default=32)
    parser.add_argument("--train-batch-size", type=int, default=64)
    parser.add_argument("--recovery-seed", type=int, action="append", default=None)
    parser.add_argument("--steps", type=int, default=192)
    parser.add_argument("--batch-size", type=int, default=1024)
    parser.add_argument("--learning-rate", type=float, default=1e-2)
    parser.add_argument("--hidden", type=int, default=12)
    parser.add_argument("--operation-gate", type=float, default=0.80)
    parser.add_argument("--full-exact-gate", type=float, default=0.99)
    parser.add_argument("--trajectory-gate", type=float, default=0.99)
    parser.add_argument("--slot-gate", type=float, default=0.99)
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()
    if args.recovery_seed is None:
        args.recovery_seed = list(DEFAULT_RECOVERY_SEEDS)
    print(json.dumps(run(args), sort_keys=True))


if __name__ == "__main__":
    main()
