#!/usr/bin/env python3
from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
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

SCHEMA = "archie-operation-information-probe/v1"
PROMOTION = "research-only-not-admitted"
DEFAULT_PROBE_SEEDS = (40260721, 40360724, 40460727)


def atomic_json(value: Any, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def state_dict_sha256(state_dict: dict[str, torch.Tensor]) -> str:
    h = hashlib.sha256()
    for name in sorted(state_dict):
        tensor = state_dict[name].detach().cpu().contiguous()
        h.update(name.encode("utf-8"))
        h.update(str(tensor.dtype).encode("ascii"))
        h.update(str(tuple(tensor.shape)).encode("ascii"))
        h.update(tensor.numpy().tobytes())
    return h.hexdigest()


def operation_signature(events: torch.Tensor, cfg: base.WorldConfig) -> torch.Tensor:
    structured = events[..., : cfg.structured_dim]
    signature_slices = terminal.slices(cfg)
    primitives = structured[..., : base.N_PRIMITIVES]
    flags = structured[..., signature_slices["flags"]]
    return torch.cat([primitives, flags], dim=-1)


def hidden_features(hidden_seq: torch.Tensor) -> torch.Tensor:
    previous = torch.cat([torch.zeros_like(hidden_seq[:, :1]), hidden_seq[:, :-1]], dim=1)
    return torch.cat([hidden_seq, hidden_seq - previous], dim=-1)


def label_signature_audit(labels: torch.Tensor, signatures: torch.Tensor) -> dict[str, Any]:
    flat_labels = labels.reshape(-1).cpu()
    flat_signatures = signatures.reshape(-1, signatures.size(-1)).cpu()
    by_label: dict[str, Any] = {}
    for label in sorted(int(value) for value in torch.unique(flat_labels)):
        selected = flat_signatures[flat_labels.eq(label)]
        unique, counts = torch.unique(selected, dim=0, return_counts=True)
        order = counts.argsort(descending=True)
        by_label[str(label)] = {
            "examples": int(selected.size(0)),
            "unique_signatures": int(unique.size(0)),
            "signatures": [
                {"bits": [int(bit) for bit in unique[index].tolist()], "examples": int(counts[index])}
                for index in order
            ],
        }
    return {
        "labels": sorted(int(value) for value in torch.unique(flat_labels)),
        "examples": int(flat_labels.numel()),
        "by_label": by_label,
    }


def collect_generated_features(
    model: base.BaseModel,
    cfg: base.WorldConfig,
    *,
    seed: int,
    batches: int,
    batch_size: int,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    feature_rows: list[torch.Tensor] = []
    signature_rows: list[torch.Tensor] = []
    label_rows: list[torch.Tensor] = []
    lengths = (4, 6, 8, 12, 16, 20)
    model.eval()
    with torch.no_grad():
        for index in range(batches):
            length = lengths[index % len(lengths)]
            batch = base.generate_batch(cfg, batch_size, length, seed + index * 1009, "train")
            out = model(batch["events"], batch["initial"])
            feature_rows.append(hidden_features(out["hidden_seq"]).reshape(-1, out["hidden_seq"].size(-1) * 2).cpu())
            signature_rows.append(operation_signature(batch["events"], cfg).reshape(-1, base.N_PRIMITIVES + 4).cpu())
            label_rows.append(batch["ops"].reshape(-1).cpu())
    return torch.cat(feature_rows), torch.cat(signature_rows), torch.cat(label_rows)


def frozen_intervention_records(campaign_root: Path, scale: str) -> list[dict[str, Any]]:
    manifest_path = campaign_root / "campaign-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    records = [
        record
        for record in manifest["corpus"]
        if record["scale"] == scale and record["suite"] == "intervention_diversity"
    ]
    if not records:
        raise RuntimeError(f"no frozen intervention-diversity records for scale {scale}")
    for record in records:
        artifact = campaign_root / record["artifact"]
        observed = sha256_file(artifact)
        if observed != record["artifact_sha256"]:
            raise RuntimeError(f"frozen batch digest mismatch: {artifact}")
    return records


def collect_frozen_features(
    model: base.BaseModel,
    cfg: base.WorldConfig,
    campaign_root: Path,
    scale: str,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, dict[str, float], str]:
    feature_rows: list[torch.Tensor] = []
    signature_rows: list[torch.Tensor] = []
    label_rows: list[torch.Tensor] = []
    baseline_metrics: list[dict[str, float]] = []
    records = frozen_intervention_records(campaign_root, scale)
    model.eval()
    with torch.no_grad():
        for record in records:
            batch = torch.load(campaign_root / record["artifact"], map_location="cpu", weights_only=False)
            out = model(batch["events"], batch["initial"])
            feature_rows.append(hidden_features(out["hidden_seq"]).reshape(-1, out["hidden_seq"].size(-1) * 2).cpu())
            signature_rows.append(operation_signature(batch["events"], cfg).reshape(-1, base.N_PRIMITIVES + 4).cpu())
            label_rows.append(batch["ops"].reshape(-1).cpu())
            baseline_metrics.append(terminal._batch_metrics(model, cfg, batch))
    manifest = json.loads((campaign_root / "campaign-manifest.json").read_text(encoding="utf-8"))
    return (
        torch.cat(feature_rows),
        torch.cat(signature_rows),
        torch.cat(label_rows),
        terminal._aggregate(baseline_metrics),
        manifest["manifest_sha256"],
    )


class SignatureProbe(nn.Module):
    def __init__(self, input_dim: int, output_dim: int) -> None:
        super().__init__()
        self.linear = nn.Linear(input_dim, output_dim)

    def forward(self, value: torch.Tensor) -> torch.Tensor:
        return self.linear(value)


def evaluate_probe(probe: SignatureProbe, features: torch.Tensor, targets: torch.Tensor) -> dict[str, Any]:
    probe.eval()
    with torch.no_grad():
        logits = probe(features)
        predicted = logits.sigmoid().ge(0.5)
        truth = targets.ge(0.5)
        bit_accuracy = predicted.eq(truth).float().mean()
        exact = predicted.eq(truth).all(-1).float().mean()
        per_bit = predicted.eq(truth).float().mean(0)
        confusion = []
        for index in range(targets.size(-1)):
            p = predicted[:, index]
            t = truth[:, index]
            confusion.append({
                "index": index,
                "true_positive": int((p & t).sum()),
                "false_positive": int((p & ~t).sum()),
                "true_negative": int((~p & ~t).sum()),
                "false_negative": int((~p & t).sum()),
                "accuracy": float(per_bit[index]),
            })
        return {
            "bit_accuracy": float(bit_accuracy),
            "exact_signature_accuracy": float(exact),
            "per_bit_accuracy": [float(value) for value in per_bit],
            "confusion": confusion,
            "examples": int(targets.size(0)),
        }


def fit_probe(
    train_features: torch.Tensor,
    train_targets: torch.Tensor,
    *,
    seed: int,
    steps: int,
    batch_size: int,
    learning_rate: float,
) -> tuple[SignatureProbe, torch.optim.Optimizer, list[dict[str, float]]]:
    torch.manual_seed(seed)
    random.seed(seed)
    probe = SignatureProbe(train_features.size(-1), train_targets.size(-1))
    positive = train_targets.sum(0)
    negative = train_targets.size(0) - positive
    pos_weight = (negative / positive.clamp_min(1.0)).clamp(1.0, 20.0)
    optimizer = torch.optim.AdamW(probe.parameters(), lr=learning_rate, weight_decay=1e-4)
    generator = torch.Generator().manual_seed(seed + 17)
    history: list[dict[str, float]] = []
    for step in range(steps):
        indices = torch.randint(0, train_features.size(0), (batch_size,), generator=generator)
        optimizer.zero_grad(set_to_none=True)
        logits = probe(train_features[indices])
        loss = F.binary_cross_entropy_with_logits(logits, train_targets[indices], pos_weight=pos_weight)
        if not torch.isfinite(loss):
            raise RuntimeError("non-finite probe loss")
        loss.backward()
        grad_norm = float(torch.nn.utils.clip_grad_norm_(probe.parameters(), 1.0))
        optimizer.step()
        if step == 0 or (step + 1) % 100 == 0 or step + 1 == steps:
            history.append({"step": step + 1, "loss": float(loss.detach()), "grad_norm": grad_norm})
    return probe, optimizer, history


def load_frozen_model(
    checkpoint_path: Path,
    expected_sha256: str,
) -> tuple[base.BaseModel, base.WorldConfig, dict[str, Any], str]:
    observed_sha256 = sha256_file(checkpoint_path)
    if observed_sha256 != expected_sha256:
        raise RuntimeError(f"checkpoint digest mismatch: {checkpoint_path}")
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    if checkpoint.get("schema") != terminal.SCHEMA:
        raise RuntimeError(f"unexpected checkpoint schema: {checkpoint.get('schema')}")
    if checkpoint.get("promotion") != PROMOTION:
        raise RuntimeError(f"unexpected checkpoint promotion: {checkpoint.get('promotion')}")
    arm = checkpoint.get("arm", {})
    if arm.get("name") != "factorized_w36_lr1e3" or arm.get("kind") != "factorized_full_state":
        raise RuntimeError(f"unexpected checkpoint arm: {arm}")
    cfg = base.WorldConfig(**checkpoint["world"])
    model = terminal.build_model(arm["kind"], cfg, int(arm["width"]))
    model.load_state_dict(checkpoint["state_dict"], strict=True)
    model.eval()
    for parameter in model.parameters():
        parameter.requires_grad_(False)
    if not checkpoint.get("optimizer_state", {}).get("state"):
        raise RuntimeError("historical winner checkpoint has empty optimizer state")
    return model, cfg, checkpoint, observed_sha256


def run(args: argparse.Namespace) -> dict[str, Any]:
    torch.set_num_threads(max(1, min(args.threads, os.cpu_count() or 1)))
    if len(args.checkpoint) != len(args.checkpoint_sha256):
        raise ValueError("--checkpoint and --checkpoint-sha256 counts must match")
    args.output.mkdir(parents=True, exist_ok=False)
    started = time.monotonic()
    checkpoint_records: list[dict[str, Any]] = []

    for checkpoint_path, expected_sha256 in zip(args.checkpoint, args.checkpoint_sha256, strict=True):
        model, cfg, checkpoint, observed_sha256 = load_frozen_model(checkpoint_path, expected_sha256)
        frozen_before = state_dict_sha256(model.state_dict())
        train_features, train_signatures, train_labels = collect_generated_features(
            model,
            cfg,
            seed=args.train_seed,
            batches=args.train_batches,
            batch_size=args.train_batch_size,
        )
        test_features, test_signatures, test_labels, baseline_metrics, manifest_sha256 = collect_frozen_features(
            model,
            cfg,
            args.campaign_root,
            args.scale,
        )
        train_audit = label_signature_audit(train_labels, train_signatures)
        test_audit = label_signature_audit(test_labels, test_signatures)
        unseen_labels = sorted(set(test_audit["labels"]) - set(train_audit["labels"]))
        overlap_labels = sorted(set(test_audit["labels"]) & set(train_audit["labels"]))

        probe_records: list[dict[str, Any]] = []
        for probe_seed in args.probe_seed:
            probe, optimizer, history = fit_probe(
                train_features,
                train_signatures,
                seed=probe_seed,
                steps=args.probe_steps,
                batch_size=args.probe_batch_size,
                learning_rate=args.probe_learning_rate,
            )
            train_metrics = evaluate_probe(probe, train_features, train_signatures)
            intervention_metrics = evaluate_probe(probe, test_features, test_signatures)
            probe_name = f"probe__checkpoint-seed{checkpoint['seed']}__probe-seed{probe_seed}.pt"
            probe_path = args.output / probe_name
            torch.save({
                "schema": SCHEMA,
                "promotion": PROMOTION,
                "checkpoint_sha256": observed_sha256,
                "campaign_manifest_sha256": manifest_sha256,
                "checkpoint_seed": checkpoint["seed"],
                "probe_seed": probe_seed,
                "feature_definition": "concat(post-step terminal hidden, post-step hidden delta)",
                "signature_definition": "typed primitive one-hot plus four benchmark flags",
                "state_dict": probe.state_dict(),
                "optimizer_state": optimizer.state_dict(),
                "steps": args.probe_steps,
            }, probe_path)
            probe_records.append({
                "probe_seed": probe_seed,
                "steps": args.probe_steps,
                "history": history,
                "train": train_metrics,
                "intervention_diversity": intervention_metrics,
                "checkpoint": probe_name,
                "checkpoint_sha256": sha256_file(probe_path),
            })

        frozen_after = state_dict_sha256(model.state_dict())
        if frozen_before != frozen_after:
            raise RuntimeError("frozen winner parameters changed during diagnostic")
        exact_values = [record["intervention_diversity"]["exact_signature_accuracy"] for record in probe_records]
        bit_values = [record["intervention_diversity"]["bit_accuracy"] for record in probe_records]
        mean_exact = statistics.fmean(exact_values)
        mean_bit = statistics.fmean(bit_values)
        if mean_exact >= args.signature_exact_gate and mean_bit >= args.signature_bit_gate:
            verdict = "compositional-operation-signal-present-factorized-head-next"
        else:
            verdict = "operation-representation-insufficient-head-only-falsified"
        checkpoint_records.append({
            "historical_checkpoint": checkpoint_path.name,
            "historical_checkpoint_sha256": observed_sha256,
            "historical_checkpoint_seed": checkpoint["seed"],
            "historical_checkpoint_steps": checkpoint["steps"],
            "historical_optimizer_state_nonempty": bool(checkpoint["optimizer_state"].get("state")),
            "historical_state_dict_sha256_before": frozen_before,
            "historical_state_dict_sha256_after": frozen_after,
            "world": dataclasses.asdict(cfg),
            "campaign_manifest_sha256": manifest_sha256,
            "train_support": train_audit,
            "intervention_support": test_audit,
            "unseen_intervention_labels": unseen_labels,
            "overlap_labels": overlap_labels,
            "existing_router_intervention_metrics": baseline_metrics,
            "probe_records": probe_records,
            "mean_intervention_signature_exact": mean_exact,
            "mean_intervention_signature_bit_accuracy": mean_bit,
            "verdict": verdict,
        })

    overall_exact = statistics.fmean(record["mean_intervention_signature_exact"] for record in checkpoint_records)
    overall_bit = statistics.fmean(record["mean_intervention_signature_bit_accuracy"] for record in checkpoint_records)
    verdicts = sorted(set(record["verdict"] for record in checkpoint_records))
    report = {
        "schema": SCHEMA,
        "promotion": PROMOTION,
        "historical_terminal_run": 29867827958,
        "historical_terminal_artifact": 8510576517,
        "historical_terminal_artifact_digest": "c35cc475bcc0bb477d25ae1670dc0b4a4f4c762cc486e247766d11b0ce77c7dd",
        "canonical_campaign_run": 29834460894,
        "canonical_campaign_artifact": 8504094525,
        "scale": args.scale,
        "probe_configuration": {
            "train_seed": args.train_seed,
            "train_batches": args.train_batches,
            "train_batch_size": args.train_batch_size,
            "probe_seeds": args.probe_seed,
            "probe_steps": args.probe_steps,
            "probe_batch_size": args.probe_batch_size,
            "probe_learning_rate": args.probe_learning_rate,
            "signature_exact_gate": args.signature_exact_gate,
            "signature_bit_gate": args.signature_bit_gate,
        },
        "feature_definition": "concat(post-step terminal hidden, post-step hidden delta)",
        "signature_definition": "typed primitive one-hot plus four benchmark flags",
        "records": checkpoint_records,
        "overall_mean_intervention_signature_exact": overall_exact,
        "overall_mean_intervention_signature_bit_accuracy": overall_bit,
        "verdicts": verdicts,
        "interpretation": (
            "The existing 11-way router is a closed-set classifier. Intervention-diversity uses held-out labels; "
            "signature recovery tests compositional operation information without changing the historical winner."
        ),
        "elapsed_seconds": time.monotonic() - started,
    }
    atomic_json(report, args.output / "operation-information-report.json")
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
    parser.add_argument("--train-seed", type=int, default=50260721)
    parser.add_argument("--train-batches", type=int, default=48)
    parser.add_argument("--train-batch-size", type=int, default=64)
    parser.add_argument("--probe-seed", type=int, action="append", default=None)
    parser.add_argument("--probe-steps", type=int, default=800)
    parser.add_argument("--probe-batch-size", type=int, default=512)
    parser.add_argument("--probe-learning-rate", type=float, default=3e-3)
    parser.add_argument("--signature-exact-gate", type=float, default=0.80)
    parser.add_argument("--signature-bit-gate", type=float, default=0.95)
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()
    if args.probe_seed is None:
        args.probe_seed = list(DEFAULT_PROBE_SEEDS)
    print(json.dumps(run(args), sort_keys=True))


if __name__ == "__main__":
    main()
