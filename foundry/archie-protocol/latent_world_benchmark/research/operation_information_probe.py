#!/usr/bin/env python3
from __future__ import annotations

import argparse
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
import efficient_terminal_training as terminal

SCHEMA = "archie-operation-information-probe/v1"
PROBE_CHECKPOINT_SCHEMA = "archie-operation-linear-probe/v1"
PROMOTION = "research-only-not-admitted"
PHASE = "A"
DEFAULT_PROBE_SEEDS = (4_081_701, 4_081_702, 4_081_703, 4_081_704, 4_081_705)


def atomic_json(value: Any, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tensor_state_sha256(state_dict: dict[str, torch.Tensor]) -> str:
    digest = hashlib.sha256()
    for name in sorted(state_dict):
        tensor = state_dict[name].detach().cpu().contiguous()
        digest.update(name.encode("utf-8"))
        digest.update(str(tensor.dtype).encode("ascii"))
        digest.update(json.dumps(list(tensor.shape)).encode("ascii"))
        digest.update(tensor.numpy().tobytes())
    return digest.hexdigest()


def resolve_inventory_path(root: Path, relative: str) -> Path:
    relative_path = Path(relative.lstrip("*"))
    if relative_path.is_absolute() or ".." in relative_path.parts:
        raise RuntimeError(f"unsafe terminal inventory path: {relative}")
    artifact_root = root.parents[1] if len(root.parents) >= 2 else root.parent
    candidates = (root / relative_path, artifact_root / relative_path)
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise RuntimeError(
        "terminal inventory file missing: "
        + " or ".join(str(candidate) for candidate in candidates)
    )


def verify_sha256_inventory(root: Path) -> None:
    inventory = root / "SHA256SUMS"
    if not inventory.is_file():
        raise RuntimeError(f"missing terminal SHA256SUMS: {inventory}")
    for raw_line in inventory.read_text(encoding="utf-8").splitlines():
        if not raw_line.strip():
            continue
        expected, relative = raw_line.split(maxsplit=1)
        path = resolve_inventory_path(root, relative)
        observed = sha256_file(path)
        if observed != expected:
            raise RuntimeError(f"terminal digest mismatch: {relative}: {observed} != {expected}")


def load_terminal_records(terminal_root: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    verify_sha256_inventory(terminal_root)
    report_path = terminal_root / "terminal-efficiency-report.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    if report.get("schema") != terminal.SCHEMA:
        raise RuntimeError(f"unexpected terminal schema: {report.get('schema')}")
    if report.get("promotion") != PROMOTION:
        raise RuntimeError(f"terminal promotion escalation: {report.get('promotion')}")
    winner = report.get("winner", {})
    if winner.get("kind") != "factorized_full_state":
        raise RuntimeError(f"Phase A requires the factorized winner, got: {winner}")
    records = report.get("records", [])
    if len(records) != 2:
        raise RuntimeError(f"expected exactly two final winner records, got {len(records)}")
    for record in records:
        checkpoint = terminal_root / record["checkpoint"]
        observed = sha256_file(checkpoint)
        if observed != record["checkpoint_sha256"]:
            raise RuntimeError(f"winner checkpoint digest mismatch: {checkpoint.name}")
    return report, records


def load_frozen_model(checkpoint_path: Path) -> tuple[dict[str, Any], base.WorldConfig, terminal.FullStateFactorizedInterpreter]:
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    if checkpoint.get("schema") != terminal.SCHEMA:
        raise RuntimeError(f"unexpected checkpoint schema: {checkpoint.get('schema')}")
    if checkpoint.get("promotion") != PROMOTION:
        raise RuntimeError(f"checkpoint promotion escalation: {checkpoint.get('promotion')}")
    arm = checkpoint["arm"]
    if arm.get("kind") != "factorized_full_state":
        raise RuntimeError(f"unexpected checkpoint kind: {arm}")
    cfg = base.WorldConfig(**checkpoint["world"])
    model = terminal.build_model(arm["kind"], cfg, arm["width"])
    model.load_state_dict(checkpoint["state_dict"], strict=True)
    model.eval()
    for parameter in model.parameters():
        parameter.requires_grad_(False)
    return checkpoint, cfg, model


def router_latent(
    model: terminal.FullStateFactorizedInterpreter,
    cfg: base.WorldConfig,
    events: torch.Tensor,
) -> torch.Tensor:
    structured = events[..., : cfg.structured_dim]
    slices = terminal.slices(cfg)
    operation_features = torch.cat(
        [structured[..., : base.N_PRIMITIVES], structured[..., slices["flags"]]], dim=-1
    )
    with torch.no_grad():
        return model.router[1](model.router[0](operation_features)).detach()


def existing_router_logits(
    model: terminal.FullStateFactorizedInterpreter,
    latent: torch.Tensor,
) -> torch.Tensor:
    with torch.no_grad():
        return model.router[2](latent).detach()


def balanced_indices(labels: torch.Tensor, classes: int, seed: int) -> torch.Tensor:
    generator = torch.Generator().manual_seed(seed)
    class_indices: list[torch.Tensor] = []
    minimum = min(int(labels.eq(class_id).sum()) for class_id in range(classes))
    if minimum <= 0:
        missing = [class_id for class_id in range(classes) if not bool(labels.eq(class_id).any())]
        raise RuntimeError(f"development probe data lacks operation classes: {missing}")
    for class_id in range(classes):
        indices = labels.eq(class_id).nonzero(as_tuple=False).flatten()
        order = torch.randperm(indices.numel(), generator=generator)[:minimum]
        class_indices.append(indices[order])
    combined = torch.cat(class_indices)
    return combined[torch.randperm(combined.numel(), generator=generator)]


def collect_development_features(
    model: terminal.FullStateFactorizedInterpreter,
    cfg: base.WorldConfig,
    probe_seed: int,
    batches_per_split: int,
    batch_size: int,
) -> tuple[torch.Tensor, torch.Tensor, dict[str, int]]:
    feature_rows: list[torch.Tensor] = []
    label_rows: list[torch.Tensor] = []
    raw_counts = {str(class_id): 0 for class_id in range(base.N_OPS)}
    for split_index, split in enumerate(("train", "unseen_intervention")):
        for batch_index in range(batches_per_split):
            seed = probe_seed + split_index * 100_000 + batch_index * 1_009
            batch = base.generate_batch(cfg, batch_size, 8, seed, split)
            feature_rows.append(router_latent(model, cfg, batch["events"]).reshape(-1, model.router[0].out_features))
            labels = batch["ops"].reshape(-1)
            label_rows.append(labels)
            for class_id in range(base.N_OPS):
                raw_counts[str(class_id)] += int(labels.eq(class_id).sum())
    features = torch.cat(feature_rows)
    labels = torch.cat(label_rows)
    indices = balanced_indices(labels, base.N_OPS, probe_seed + 77)
    return features[indices], labels[indices], raw_counts


def frozen_intervention_records(campaign_root: Path, scale: str) -> list[dict[str, Any]]:
    manifest_path = campaign_root / "campaign-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    records = sorted(
        [
            record
            for record in manifest["corpus"]
            if record["scale"] == scale and record["suite"] == "intervention_diversity"
        ],
        key=lambda record: record["artifact"],
    )
    if not records:
        raise RuntimeError("canonical campaign has no intervention-diversity records")
    for record in records:
        artifact = campaign_root / record["artifact"]
        if sha256_file(artifact) != record["artifact_sha256"]:
            raise RuntimeError(f"frozen intervention digest mismatch: {artifact}")
    return records


def collect_frozen_intervention_features(
    model: terminal.FullStateFactorizedInterpreter,
    cfg: base.WorldConfig,
    campaign_root: Path,
    scale: str,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, str]:
    features: list[torch.Tensor] = []
    logits: list[torch.Tensor] = []
    labels: list[torch.Tensor] = []
    corpus_digest = hashlib.sha256()
    for record in frozen_intervention_records(campaign_root, scale):
        artifact = campaign_root / record["artifact"]
        batch = torch.load(artifact, map_location="cpu", weights_only=False)
        latent = router_latent(model, cfg, batch["events"])
        features.append(latent.reshape(-1, latent.shape[-1]))
        logits.append(existing_router_logits(model, latent).reshape(-1, base.N_OPS))
        labels.append(batch["ops"].reshape(-1))
        corpus_digest.update(record["artifact_sha256"].encode("ascii"))
    return torch.cat(features), torch.cat(logits), torch.cat(labels), corpus_digest.hexdigest()


def train_linear_probe(
    features: torch.Tensor,
    labels: torch.Tensor,
    seed: int,
    steps: int,
    learning_rate: float,
    weight_decay: float,
) -> tuple[nn.Linear, torch.optim.AdamW, list[dict[str, float]]]:
    torch.manual_seed(seed)
    random.seed(seed)
    probe = nn.Linear(features.shape[-1], base.N_OPS)
    optimizer = torch.optim.AdamW(probe.parameters(), lr=learning_rate, weight_decay=weight_decay)
    history: list[dict[str, float]] = []
    for step in range(steps):
        optimizer.zero_grad(set_to_none=True)
        logits = probe(features)
        loss = F.cross_entropy(logits, labels)
        if not torch.isfinite(loss):
            raise RuntimeError("non-finite probe loss")
        loss.backward()
        gradient_norm = float(torch.nn.utils.clip_grad_norm_(probe.parameters(), 1.0))
        optimizer.step()
        if step == 0 or (step + 1) % 64 == 0 or step + 1 == steps:
            accuracy = float(probe(features).argmax(-1).eq(labels).float().mean())
            history.append(
                {
                    "step": step + 1,
                    "loss": float(loss.detach()),
                    "gradient_norm": gradient_norm,
                    "development_accuracy": accuracy,
                }
            )
    return probe.eval(), optimizer, history


def wilson_interval(successes: int, total: int, z: float = 1.959963984540054) -> list[float]:
    if total <= 0:
        return [0.0, 0.0]
    proportion = successes / total
    denominator = 1.0 + z * z / total
    center = (proportion + z * z / (2.0 * total)) / denominator
    margin = z * math.sqrt((proportion * (1.0 - proportion) + z * z / (4.0 * total)) / total) / denominator
    return [max(0.0, center - margin), min(1.0, center + margin)]


def classification_metrics(logits: torch.Tensor, labels: torch.Tensor) -> dict[str, Any]:
    predictions = logits.argmax(-1)
    classes = int(logits.shape[-1])
    confusion = torch.zeros(classes, classes, dtype=torch.int64)
    for target, prediction in zip(labels.tolist(), predictions.tolist()):
        confusion[target, prediction] += 1
    correct = int(predictions.eq(labels).sum())
    per_operation: dict[str, Any] = {}
    for class_id in sorted(set(labels.tolist())):
        mask = labels.eq(class_id)
        class_total = int(mask.sum())
        class_correct = int(predictions[mask].eq(class_id).sum())
        per_operation[str(class_id)] = {
            "examples": class_total,
            "correct": class_correct,
            "accuracy": class_correct / class_total,
            "wilson_95": wilson_interval(class_correct, class_total),
        }
    return {
        "examples": int(labels.numel()),
        "correct": correct,
        "accuracy": correct / int(labels.numel()),
        "wilson_95": wilson_interval(correct, int(labels.numel())),
        "confusion_matrix": confusion.tolist(),
        "per_operation": per_operation,
    }


def write_inventory(root: Path) -> None:
    lines = []
    for path in sorted(item for item in root.rglob("*") if item.is_file() and item.name != "SHA256SUMS"):
        lines.append(f"{sha256_file(path)}  {path.relative_to(root).as_posix()}")
    (root / "SHA256SUMS").write_text("\n".join(lines) + "\n", encoding="utf-8")


def run(args: argparse.Namespace) -> dict[str, Any]:
    torch.set_num_threads(max(1, min(args.threads, os.cpu_count() or 1)))
    started = time.monotonic()
    output = args.output
    if output.exists():
        raise RuntimeError(f"refusing to overwrite output directory: {output}")
    output.mkdir(parents=True)

    terminal_report, terminal_records = load_terminal_records(args.terminal_root)
    campaign_manifest = json.loads((args.campaign_root / "campaign-manifest.json").read_text(encoding="utf-8"))
    gate = {
        "mean_probe_operation_accuracy_gte": args.minimum_mean_accuracy,
        "minimum_seed_accuracy_gte": args.minimum_seed_accuracy,
        "terminal_model_state_unchanged": True,
    }
    result: dict[str, Any] = {
        "schema": SCHEMA,
        "phase": PHASE,
        "promotion": PROMOTION,
        "probe_kind": "linear readout trained on the frozen 48-dimensional router latent",
        "router_latent": "GELU(router.0(primitive factors + validity flags))",
        "development_data": "generated development examples only; balanced across all 11 operation classes",
        "frozen_evaluation": "untouched canonical intervention-diversity corpus",
        "configuration": {
            "scale": args.scale,
            "probe_seeds": args.probe_seeds,
            "development_batches_per_split": args.dev_batches_per_split,
            "development_batch_size": args.dev_batch_size,
            "probe_steps": args.probe_steps,
            "learning_rate": args.learning_rate,
            "weight_decay": args.weight_decay,
            "threads": args.threads,
        },
        "falsification_gate": gate,
        "source_identity": {
            "terminal_report_sha256": sha256_file(args.terminal_root / "terminal-efficiency-report.json"),
            "terminal_schema": terminal_report["schema"],
            "terminal_winner": terminal_report["winner"],
            "terminal_promotion": terminal_report["promotion"],
            "campaign_manifest_sha256": campaign_manifest["manifest_sha256"],
        },
        "checkpoints": [],
    }

    for record in terminal_records:
        checkpoint_path = args.terminal_root / record["checkpoint"]
        checkpoint, cfg, model = load_frozen_model(checkpoint_path)
        model_digest_before = tensor_state_sha256(model.state_dict())
        frozen_features, existing_logits, frozen_labels, frozen_corpus_digest = collect_frozen_intervention_features(
            model, cfg, args.campaign_root, args.scale
        )
        checkpoint_result: dict[str, Any] = {
            "checkpoint": checkpoint_path.name,
            "checkpoint_sha256": sha256_file(checkpoint_path),
            "training_seed": checkpoint["seed"],
            "steps": checkpoint["steps"],
            "world": checkpoint["world"],
            "arm": checkpoint["arm"],
            "historical_sealed_summary": record["sealed_canonical"]["summary"],
            "frozen_intervention_corpus_digest": frozen_corpus_digest,
            "existing_operation_readout": classification_metrics(existing_logits, frozen_labels),
            "probes": [],
        }
        for probe_seed in args.probe_seeds:
            development_features, development_labels, raw_counts = collect_development_features(
                model,
                cfg,
                probe_seed,
                args.dev_batches_per_split,
                args.dev_batch_size,
            )
            probe, optimizer, history = train_linear_probe(
                development_features,
                development_labels,
                probe_seed,
                args.probe_steps,
                args.learning_rate,
                args.weight_decay,
            )
            with torch.no_grad():
                development_metrics = classification_metrics(probe(development_features), development_labels)
                frozen_metrics = classification_metrics(probe(frozen_features), frozen_labels)
            probe_name = f"{checkpoint_path.stem}__probe-seed{probe_seed}.pt"
            probe_path = output / probe_name
            torch.save(
                {
                    "schema": PROBE_CHECKPOINT_SCHEMA,
                    "promotion": PROMOTION,
                    "phase": PHASE,
                    "source_checkpoint": checkpoint_path.name,
                    "source_checkpoint_sha256": sha256_file(checkpoint_path),
                    "source_model_state_sha256": model_digest_before,
                    "campaign_manifest_sha256": campaign_manifest["manifest_sha256"],
                    "probe_seed": probe_seed,
                    "probe_steps": args.probe_steps,
                    "probe_state_dict": probe.state_dict(),
                    "optimizer_state": optimizer.state_dict(),
                    "development_metrics": development_metrics,
                    "frozen_intervention_metrics": frozen_metrics,
                },
                probe_path,
            )
            checkpoint_result["probes"].append(
                {
                    "probe_seed": probe_seed,
                    "raw_development_class_counts": raw_counts,
                    "balanced_development_examples": int(development_labels.numel()),
                    "development_metrics": development_metrics,
                    "frozen_intervention_metrics": frozen_metrics,
                    "history": history,
                    "probe_checkpoint": probe_name,
                    "probe_checkpoint_sha256": sha256_file(probe_path),
                }
            )
        model_digest_after = tensor_state_sha256(model.state_dict())
        if model_digest_after != model_digest_before:
            raise RuntimeError("frozen terminal model state changed during Phase A")
        accuracies = [probe["frozen_intervention_metrics"]["accuracy"] for probe in checkpoint_result["probes"]]
        checkpoint_result["summary"] = {
            "mean_probe_operation_accuracy": statistics.fmean(accuracies),
            "minimum_probe_operation_accuracy": min(accuracies),
            "maximum_probe_operation_accuracy": max(accuracies),
            "existing_operation_accuracy": checkpoint_result["existing_operation_readout"]["accuracy"],
            "terminal_model_state_sha256_before": model_digest_before,
            "terminal_model_state_sha256_after": model_digest_after,
            "terminal_model_state_unchanged": True,
        }
        result["checkpoints"].append(checkpoint_result)

    all_accuracies = [
        probe["frozen_intervention_metrics"]["accuracy"]
        for checkpoint in result["checkpoints"]
        for probe in checkpoint["probes"]
    ]
    mean_accuracy = statistics.fmean(all_accuracies)
    minimum_accuracy = min(all_accuracies)
    head_only_permitted = (
        mean_accuracy >= args.minimum_mean_accuracy and minimum_accuracy >= args.minimum_seed_accuracy
    )
    result["decision"] = {
        "mean_probe_operation_accuracy": mean_accuracy,
        "minimum_probe_operation_accuracy": minimum_accuracy,
        "classification": (
            "readout-or-operation-objective failure"
            if head_only_permitted
            else "operation-insufficient frozen representation"
        ),
        "head_only_recovery_permitted": head_only_permitted,
        "next_stage": (
            "bounded head-only operation recovery with state-preservation guardrails"
            if head_only_permitted
            else "stop head-only work and redesign operation-aware representation learning"
        ),
        "admission_changed": False,
        "production_changed": False,
    }
    result["elapsed_seconds"] = time.monotonic() - started
    atomic_json(result, output / "operation-information-probe-report.json")
    write_inventory(output)
    return result


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Probe operation identity in the frozen terminal winner router latent.")
    parser.add_argument("--campaign-root", type=Path, required=True)
    parser.add_argument("--terminal-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--scale", default="base")
    parser.add_argument("--probe-seeds", type=int, nargs="+", default=list(DEFAULT_PROBE_SEEDS))
    parser.add_argument("--dev-batches-per-split", type=int, default=4)
    parser.add_argument("--dev-batch-size", type=int, default=64)
    parser.add_argument("--probe-steps", type=int, default=256)
    parser.add_argument("--learning-rate", type=float, default=0.05)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--minimum-mean-accuracy", type=float, default=0.80)
    parser.add_argument("--minimum-seed-accuracy", type=float, default=0.75)
    parser.add_argument("--threads", type=int, default=4)
    return parser.parse_args()


if __name__ == "__main__":
    report = run(parse_args())
    print(json.dumps(report, indent=2, sort_keys=True))
