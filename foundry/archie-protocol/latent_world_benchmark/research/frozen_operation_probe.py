#!/usr/bin/env python3
from __future__ import annotations

import argparse
import dataclasses
import hashlib
import importlib.util
import json
import math
import os
import random
import statistics
import sys
from pathlib import Path
from typing import Any, Iterable

import torch

SCHEMA = "archie-operation-identity-frozen-probe/v1"
PROMOTION = "research-only-not-admitted"
EXPECTED_TERMINAL_ARTIFACT = {
    "id": 8510576517,
    "run_id": 29867827958,
    "job_id": 88760401498,
    "sha256": "c35cc475bcc0bb477d25ae1670dc0b4a4f4c762cc486e247766d11b0ce77c7dd",
}
EXPECTED_CAMPAIGN_ARTIFACT = {
    "id": 8504094525,
    "run_id": 29834460894,
    "sha256": "ce7cf88f5ced8d02be4bc6407ffc9be113a5adcf4c0fc7b2896b0c301b2b0203",
}
EXPECTED_TRAINER_SHA256 = "d9ddba23573e03bb6d0627adc3fec61732a355b2b38012ab4f1f4e6db6934770"
EXPECTED_CAMPAIGN_MANIFEST_SHA256 = "46ed670588fa55843ff67808fda3c67ab642ac8ffbf68b0397994a9bd5e81806"
EXPECTED_WINNER = "factorized_w36_lr1e3"
EXPECTED_CHECKPOINT_SEEDS = (30260721, 30360724)
FEATURE_NAMES = ("hidden_seq", "slot_predecode", "hidden_plus_event", "prim_plus_flags")
PROBE_SEEDS = (185001, 185019, 185071, 185113, 185197)
DEV_SPECS = (
    (4, 1851001),
    (6, 1851003),
    (8, 1851007),
    (12, 1851013),
    (16, 1851021),
    (20, 1851031),
)
RIDGE_LAMBDA = 1e-3
DEV_BATCH_SIZE = 128
T_CRITICAL_95 = {2: 12.706, 3: 4.303, 4: 3.182, 5: 2.776, 6: 2.571, 7: 2.447, 8: 2.365, 9: 2.306, 10: 2.262}


def atomic_json(value: Any, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tensor_bytes(tensor: torch.Tensor) -> bytes:
    value = tensor.detach().cpu().contiguous()
    return value.view(torch.uint8).numpy().tobytes()


def state_dict_digest(model: torch.nn.Module) -> str:
    digest = hashlib.sha256()
    for name, tensor in sorted(model.state_dict().items()):
        digest.update(name.encode("utf-8"))
        digest.update(str(tuple(tensor.shape)).encode("ascii"))
        digest.update(str(tensor.dtype).encode("ascii"))
        digest.update(tensor_bytes(tensor))
    return digest.hexdigest()


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def load_module(path: Path, name: str) -> Any:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def verify_artifact_receipt(receipt: dict[str, Any]) -> None:
    for key, expected in (("terminal", EXPECTED_TERMINAL_ARTIFACT), ("campaign", EXPECTED_CAMPAIGN_ARTIFACT)):
        actual = receipt.get(key)
        if not isinstance(actual, dict):
            raise RuntimeError(f"artifact receipt is missing {key}")
        for field, value in expected.items():
            if actual.get(field) != value:
                raise RuntimeError(f"{key} artifact {field} mismatch: expected {value!r}, got {actual.get(field)!r}")
        if actual.get("verified") is not True:
            raise RuntimeError(f"{key} artifact is not independently marked verified")


def operation_names(base: Any) -> list[str]:
    count = int(base.N_OPS)
    for attr in ("OP_NAMES", "OP_LABELS", "OPERATIONS"):
        candidate = getattr(base, attr, None)
        if isinstance(candidate, (list, tuple)) and len(candidate) == count:
            return [str(item) for item in candidate]
        if isinstance(candidate, dict) and len(candidate) == count:
            if all(isinstance(key, int) for key in candidate):
                return [str(candidate[index]) for index in range(count)]
    return [f"op_{index}" for index in range(count)]


def freeze_model(model: torch.nn.Module) -> None:
    model.eval()
    for parameter in model.parameters():
        parameter.requires_grad_(False)
    if any(parameter.requires_grad for parameter in model.parameters()):
        raise RuntimeError("failed to freeze all executor parameters")


def capture_features(model: torch.nn.Module, events: torch.Tensor, initial: torch.Tensor, trainer: Any) -> tuple[dict[str, torch.Tensor], dict[str, Any]]:
    slot_inputs: list[torch.Tensor] = []

    def hook(_module: torch.nn.Module, args: tuple[torch.Tensor, ...]) -> None:
        slot_inputs.append(args[0].detach())

    handle = model.slot_decode.register_forward_pre_hook(hook)
    try:
        with torch.no_grad():
            out = model(events, initial)
    finally:
        handle.remove()
    if len(slot_inputs) != events.size(1):
        raise RuntimeError(f"slot hook captured {len(slot_inputs)} states for {events.size(1)} events")
    slots = torch.stack(slot_inputs, dim=1)
    structured = events[..., : model.cfg.structured_dim]
    with torch.no_grad():
        event_embedding = model.event(structured)
    slices = trainer.slices(model.cfg)
    prim = structured[..., : trainer.base.N_PRIMITIVES]
    flags = structured[..., slices["flags"]]
    features = {
        "hidden_seq": out["hidden_seq"].detach(),
        "slot_predecode": slots.flatten(-2).detach(),
        "hidden_plus_event": torch.cat([out["hidden_seq"], event_embedding], dim=-1).detach(),
        "prim_plus_flags": torch.cat([prim, flags], dim=-1).detach(),
    }
    return features, out


def flatten_examples(tensor: torch.Tensor) -> torch.Tensor:
    return tensor.reshape(-1, tensor.size(-1)).to(dtype=torch.float64, device="cpu")


def extract_development(model: torch.nn.Module, trainer: Any, cfg: Any) -> tuple[dict[str, torch.Tensor], torch.Tensor]:
    collected: dict[str, list[torch.Tensor]] = {name: [] for name in FEATURE_NAMES}
    labels: list[torch.Tensor] = []
    for length, seed in DEV_SPECS:
        batch = trainer.base.generate_batch(cfg, DEV_BATCH_SIZE, length, seed, "train")
        features, _ = capture_features(model, batch["events"], batch["initial"], trainer)
        for name in FEATURE_NAMES:
            collected[name].append(flatten_examples(features[name]))
        labels.append(batch["ops"].reshape(-1).to(dtype=torch.long, device="cpu"))
    return {name: torch.cat(parts, dim=0) for name, parts in collected.items()}, torch.cat(labels, dim=0)


def stratified_indices(labels: torch.Tensor, count: int, seed: int) -> torch.Tensor:
    generator = torch.Generator(device="cpu").manual_seed(seed)
    pieces: list[torch.Tensor] = []
    for class_index in range(count):
        class_rows = torch.nonzero(labels.eq(class_index), as_tuple=False).flatten()
        if class_rows.numel() == 0:
            raise RuntimeError(f"development corpus has no examples for operation {class_index}")
        take = max(1, int(math.floor(class_rows.numel() * 0.80)))
        order = torch.randperm(class_rows.numel(), generator=generator)[:take]
        pieces.append(class_rows[order])
    rows = torch.cat(pieces)
    return rows[torch.randperm(rows.numel(), generator=generator)]


def fit_ridge_probe(features: torch.Tensor, labels: torch.Tensor, count: int, seed: int) -> dict[str, Any]:
    rows = stratified_indices(labels, count, seed)
    x = features[rows]
    y = labels[rows]
    mean = x.mean(dim=0)
    scale = x.std(dim=0, unbiased=False).clamp_min(1e-8)
    normalized = (x - mean) / scale
    design = torch.cat([normalized, torch.ones(normalized.size(0), 1, dtype=normalized.dtype)], dim=1)
    targets = torch.nn.functional.one_hot(y, num_classes=count).to(dtype=design.dtype)
    gram = design.T @ design
    penalty = torch.eye(gram.size(0), dtype=gram.dtype) * RIDGE_LAMBDA
    penalty[-1, -1] = 0.0
    weights = torch.linalg.solve(gram + penalty, design.T @ targets)
    return {
        "seed": seed,
        "mean": mean,
        "scale": scale,
        "weights": weights,
        "training_examples": int(rows.numel()),
        "feature_dimension": int(features.size(1)),
        "parameter_count": int(weights.numel()),
        "solver": "closed-form multiclass ridge least squares",
        "ridge_lambda": RIDGE_LAMBDA,
    }


def predict_probe(probe: dict[str, Any], features: torch.Tensor) -> torch.Tensor:
    normalized = (features.to(dtype=torch.float64, device="cpu") - probe["mean"]) / probe["scale"]
    design = torch.cat([normalized, torch.ones(normalized.size(0), 1, dtype=normalized.dtype)], dim=1)
    return (design @ probe["weights"]).argmax(dim=-1)


def confusion_matrix(prediction: torch.Tensor, target: torch.Tensor, count: int) -> list[list[int]]:
    encoded = target.to(torch.long) * count + prediction.to(torch.long)
    matrix = torch.bincount(encoded, minlength=count * count).reshape(count, count)
    return [[int(value) for value in row] for row in matrix.tolist()]


def per_operation_metrics(matrix: list[list[int]], names: list[str]) -> list[dict[str, Any]]:
    count = len(matrix)
    total = sum(sum(row) for row in matrix)
    output = []
    for index in range(count):
        true_positive = matrix[index][index]
        support = sum(matrix[index])
        predicted = sum(matrix[row][index] for row in range(count))
        precision = true_positive / predicted if predicted else 0.0
        recall = true_positive / support if support else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        output.append({
            "operation_index": index,
            "operation": names[index],
            "support": support,
            "prevalence": support / total if total else 0.0,
            "precision": precision,
            "recall": recall,
            "f1": f1,
        })
    return output


def wilson_interval(successes: int, total: int, z: float = 1.959963984540054) -> list[float]:
    if total <= 0:
        return [0.0, 0.0]
    p = successes / total
    denominator = 1.0 + z * z / total
    center = (p + z * z / (2 * total)) / denominator
    radius = z * math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator
    return [max(0.0, center - radius), min(1.0, center + radius)]


def seed_interval(values: Iterable[float]) -> dict[str, float]:
    data = [float(value) for value in values]
    mean = statistics.fmean(data)
    if len(data) < 2:
        return {"mean": mean, "lower": mean, "upper": mean, "standard_deviation": 0.0, "seeds": len(data)}
    deviation = statistics.stdev(data)
    critical = T_CRITICAL_95.get(len(data), 1.96)
    radius = critical * deviation / math.sqrt(len(data))
    return {
        "mean": mean,
        "lower": max(0.0, mean - radius),
        "upper": min(1.0, mean + radius),
        "standard_deviation": deviation,
        "seeds": len(data),
    }


def classify_result(hidden_accuracy: float, prim_accuracy: float, development_accuracy: float) -> str:
    if development_accuracy >= 0.80 and hidden_accuracy < 0.20:
        return "development-success-untouched-collapse"
    if hidden_accuracy >= max(0.20, prim_accuracy + 0.05):
        return "execution-representation-contains-linearly-recoverable-operation-information"
    return "operation-identity-not-linearly-represented-in-execution-state"


def metrics_from_output(out: dict[str, Any], batch: dict[str, torch.Tensor], cfg: Any, base: Any) -> dict[str, float]:
    predicted_slots, predicted_sources, predicted_authority, predicted_queue = base.decode_state(out["state"], cfg)
    target_slots, target_sources, target_authority, target_queue = base.decode_state(batch["trajectory"], cfg)
    slot_ok = predicted_slots.eq(target_slots)
    nonqueue_ok = slot_ok.all(-1) & predicted_sources.eq(target_sources).all(-1) & predicted_authority.eq(target_authority)
    queue_ok = predicted_queue.eq(target_queue).all(-1)
    full_ok = nonqueue_ok & queue_ok
    length = batch["events"].size(1)
    first = []
    for row in range(batch["events"].size(0)):
        bad = (~full_ok[row]).nonzero()
        first.append(length if bad.numel() == 0 else int(bad[0, 0]))
    op_accuracy = out["op_logits"].argmax(-1).eq(batch["ops"]).float().mean()
    change_accuracy = out["change_logits"].sigmoid().gt(0.5).eq(batch["changed_cells"].gt(0.5)).float().mean()
    return {
        "exact_terminal": float(nonqueue_ok[:, -1].float().mean()),
        "full_exact_terminal": float(full_ok[:, -1].float().mean()),
        "slot_accuracy": float(slot_ok[:, -1].float().mean()),
        "trajectory_slot_accuracy": float(slot_ok.float().mean()),
        "trajectory_full_exact": float(full_ok.float().mean()),
        "first_divergence_fraction": statistics.fmean(first) / length,
        "operation_accuracy": float(op_accuracy),
        "change_accuracy": float(change_accuracy),
        "examples": float(batch["events"].size(0)),
    }


def hash_output(digest: Any, suite: str, artifact: str, out: dict[str, Any]) -> None:
    digest.update(suite.encode("utf-8"))
    digest.update(artifact.encode("utf-8"))
    for key in ("state", "queue_full", "op_logits", "change_logits", "hidden_seq"):
        tensor = out[key]
        digest.update(key.encode("ascii"))
        digest.update(str(tuple(tensor.shape)).encode("ascii"))
        digest.update(str(tensor.dtype).encode("ascii"))
        digest.update(tensor_bytes(tensor))


def evaluate_once(
    model: torch.nn.Module,
    trainer: Any,
    cfg: Any,
    campaign_root: Path,
    scale: str,
    probes: dict[str, list[dict[str, Any]]],
    development_labels: torch.Tensor,
    names: list[str],
) -> dict[str, Any]:
    manifest = load_json(campaign_root / "campaign-manifest.json")
    suites: dict[str, Any] = {}
    heldout_features: dict[str, list[torch.Tensor]] = {name: [] for name in FEATURE_NAMES}
    heldout_labels: list[torch.Tensor] = []
    heldout_router: list[torch.Tensor] = []
    prediction_digest = hashlib.sha256()

    for suite in trainer.campaign.SUITES:
        records = [record for record in manifest["corpus"] if record["scale"] == scale and record["suite"] == suite.name]
        metrics = []
        for record in records:
            artifact = campaign_root / record["artifact"]
            if sha256_file(artifact) != record["artifact_sha256"]:
                raise RuntimeError(f"frozen batch digest mismatch: {artifact}")
            batch = torch.load(artifact, map_location="cpu", weights_only=False)
            features, out = capture_features(model, batch["events"], batch["initial"], trainer)
            metrics.append(metrics_from_output(out, batch, cfg, trainer.base))
            hash_output(prediction_digest, suite.name, record["artifact"], out)
            if suite.name == "intervention_diversity":
                for feature_name in FEATURE_NAMES:
                    heldout_features[feature_name].append(flatten_examples(features[feature_name]))
                heldout_labels.append(batch["ops"].reshape(-1).to(dtype=torch.long, device="cpu"))
                heldout_router.append(out["op_logits"].argmax(-1).reshape(-1).to(dtype=torch.long, device="cpu"))
        suites[suite.name] = trainer._aggregate(metrics)

    terminal_summary = trainer._aggregate([suites[suite.name] for suite in trainer.campaign.SUITES])
    target = torch.cat(heldout_labels)
    router_prediction = torch.cat(heldout_router)
    feature_matrix = {name: torch.cat(parts) for name, parts in heldout_features.items()}
    count = int(trainer.base.N_OPS)

    majority_index = int(torch.bincount(development_labels, minlength=count).argmax())
    majority_prediction = torch.full_like(target, majority_index)
    methods: dict[str, Any] = {}

    for method_name, prediction in (("existing_prim_flags_router", router_prediction), ("development_majority", majority_prediction)):
        matrix = confusion_matrix(prediction, target, count)
        correct = int(prediction.eq(target).sum())
        methods[method_name] = {
            "accuracy": correct / target.numel(),
            "accuracy_wilson_95": wilson_interval(correct, int(target.numel())),
            "confusion_matrix": matrix,
            "per_operation": per_operation_metrics(matrix, names),
        }

    for feature_name, feature_probes in probes.items():
        seed_results = []
        for probe in feature_probes:
            prediction = predict_probe(probe, feature_matrix[feature_name])
            matrix = confusion_matrix(prediction, target, count)
            correct = int(prediction.eq(target).sum())
            seed_results.append({
                "seed": probe["seed"],
                "accuracy": correct / target.numel(),
                "accuracy_wilson_95": wilson_interval(correct, int(target.numel())),
                "confusion_matrix": matrix,
                "per_operation": per_operation_metrics(matrix, names),
            })
        methods[f"linear_probe_{feature_name}"] = {
            "accuracy_across_seeds_95": seed_interval(result["accuracy"] for result in seed_results),
            "seeds": seed_results,
            "feature_dimension": feature_probes[0]["feature_dimension"],
            "parameter_count": feature_probes[0]["parameter_count"],
            "solver": feature_probes[0]["solver"],
            "ridge_lambda": feature_probes[0]["ridge_lambda"],
        }

    prevalence = torch.bincount(target, minlength=count).to(torch.float64) / target.numel()
    per_operation_baselines = [
        {
            "operation_index": index,
            "operation": names[index],
            "always_predict_this_operation_accuracy": float(prevalence[index]),
            "support": int((target == index).sum()),
        }
        for index in range(count)
    ]
    return {
        "terminal": {
            "manifest_sha256": manifest["manifest_sha256"],
            "metric_correction": "full_exact_terminal includes queue occupancy and queue identity; legacy exact_terminal omitted queue",
            "suites": suites,
            "summary": terminal_summary,
            "prediction_sha256": prediction_digest.hexdigest(),
        },
        "operation": {
            "untouched_suite": "intervention_diversity",
            "examples": int(target.numel()),
            "methods": methods,
            "per_operation_baselines": per_operation_baselines,
        },
    }


def serializable_probe_training(probes: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    return {
        feature: [
            {
                "seed": probe["seed"],
                "training_examples": probe["training_examples"],
                "feature_dimension": probe["feature_dimension"],
                "parameter_count": probe["parameter_count"],
                "solver": probe["solver"],
                "ridge_lambda": probe["ridge_lambda"],
            }
            for probe in values
        ]
        for feature, values in probes.items()
    }


def run(args: argparse.Namespace) -> dict[str, Any]:
    torch.set_num_threads(max(1, min(args.threads, os.cpu_count() or 1)))
    torch.use_deterministic_algorithms(True)
    random.seed(185)
    torch.manual_seed(185)

    receipt = load_json(args.artifact_receipt)
    verify_artifact_receipt(receipt)
    if sha256_file(args.archived_trainer) != EXPECTED_TRAINER_SHA256:
        raise RuntimeError("archived terminal trainer source digest mismatch")
    if sha256_file(args.campaign_root / "campaign-manifest.json") != EXPECTED_CAMPAIGN_MANIFEST_SHA256:
        raise RuntimeError("canonical campaign manifest digest mismatch")

    trainer = load_module(args.archived_trainer, "pok185_archived_terminal_trainer")
    terminal_root = args.terminal_root
    report_path = terminal_root / "terminal-efficiency-report.json"
    terminal_report = load_json(report_path)
    if terminal_report["promotion"] != PROMOTION or terminal_report["winner"]["name"] != EXPECTED_WINNER:
        raise RuntimeError("terminal artifact is not the immutable research-only winner")
    records = terminal_report["records"]
    if tuple(sorted(record["seed"] for record in records)) != EXPECTED_CHECKPOINT_SEEDS:
        raise RuntimeError("terminal artifact checkpoint seed set mismatch")

    cfg = trainer.campaign.scale_by_name(terminal_report["scale"]).world
    names = operation_names(trainer.base)
    checkpoint_reports = []
    for record in sorted(records, key=lambda item: item["seed"]):
        checkpoint_path = terminal_root / record["checkpoint"]
        if sha256_file(checkpoint_path) != record["checkpoint_sha256"]:
            raise RuntimeError(f"checkpoint digest mismatch: {checkpoint_path}")
        checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
        if checkpoint["promotion"] != PROMOTION or checkpoint["arm"]["name"] != EXPECTED_WINNER:
            raise RuntimeError("checkpoint identity or promotion mismatch")
        if dataclasses.asdict(cfg) != checkpoint["world"]:
            raise RuntimeError("checkpoint world configuration mismatch")

        model = trainer.build_model(checkpoint["arm"]["kind"], cfg, checkpoint["arm"]["width"])
        model.load_state_dict(checkpoint["state_dict"], strict=True)
        freeze_model(model)
        parameter_digest_before = state_dict_digest(model)
        development_features, development_labels = extract_development(model, trainer, cfg)
        probes = {
            feature_name: [
                fit_ridge_probe(development_features[feature_name], development_labels, int(trainer.base.N_OPS), seed)
                for seed in PROBE_SEEDS
            ]
            for feature_name in FEATURE_NAMES
        }
        evaluation = evaluate_once(model, trainer, cfg, args.campaign_root, terminal_report["scale"], probes, development_labels, names)
        parameter_digest_after = state_dict_digest(model)
        if parameter_digest_after != parameter_digest_before:
            raise RuntimeError("frozen executor parameters changed during probe fitting or evaluation")
        if evaluation["terminal"]["suites"] != record["sealed_canonical"]["suites"]:
            raise RuntimeError("sealed per-suite terminal metrics differ bit-for-bit from the immutable report")
        if evaluation["terminal"]["summary"] != record["sealed_canonical"]["summary"]:
            raise RuntimeError("sealed terminal summary differs bit-for-bit from the immutable report")

        methods = evaluation["operation"]["methods"]
        hidden_accuracy = methods["linear_probe_hidden_seq"]["accuracy_across_seeds_95"]["mean"]
        prim_accuracy = methods["linear_probe_prim_plus_flags"]["accuracy_across_seeds_95"]["mean"]
        dev_hidden = statistics.fmean(
            float(predict_probe(probe, development_features["hidden_seq"]).eq(development_labels).double().mean())
            for probe in probes["hidden_seq"]
        )
        checkpoint_reports.append({
            "checkpoint": checkpoint_path.name,
            "checkpoint_sha256": record["checkpoint_sha256"],
            "seed": record["seed"],
            "steps": checkpoint["steps"],
            "executor_parameters": sum(parameter.numel() for parameter in model.parameters()),
            "executor_parameter_sha256_before": parameter_digest_before,
            "executor_parameter_sha256_after": parameter_digest_after,
            "all_executor_parameters_frozen": True,
            "probe_training": serializable_probe_training(probes),
            "development": {
                "examples": int(development_labels.numel()),
                "specifications": [{"length": length, "seed": seed, "split": "train", "batch_size": DEV_BATCH_SIZE} for length, seed in DEV_SPECS],
                "hidden_seq_training_accuracy_mean": dev_hidden,
            },
            "evaluation": evaluation,
            "phase_a_classification": classify_result(hidden_accuracy, prim_accuracy, dev_hidden),
        })

    hidden_means = [
        record["evaluation"]["operation"]["methods"]["linear_probe_hidden_seq"]["accuracy_across_seeds_95"]["mean"]
        for record in checkpoint_reports
    ]
    classifications = sorted({record["phase_a_classification"] for record in checkpoint_reports})
    report = {
        "schema": SCHEMA,
        "promotion": PROMOTION,
        "repository_sha": args.repository_sha,
        "phase": "POK-185 Phase A frozen operation-information diagnostic",
        "executor_training_performed": False,
        "untouched_suite_evaluations_per_checkpoint": 1,
        "artifact_receipt": receipt,
        "source_identities": {
            "archived_trainer": str(args.archived_trainer),
            "archived_trainer_sha256": EXPECTED_TRAINER_SHA256,
            "terminal_report_sha256": sha256_file(report_path),
            "campaign_manifest_sha256": EXPECTED_CAMPAIGN_MANIFEST_SHA256,
            "latent_world_benchmark_sha256": sha256_file(Path(trainer.base.__file__)),
            "full_budget_campaign_sha256": sha256_file(Path(trainer.campaign.__file__)),
        },
        "operation_names": names,
        "probe_contract": {
            "feature_sets": list(FEATURE_NAMES),
            "probe_seeds": list(PROBE_SEEDS),
            "solver": "closed-form multiclass ridge least squares",
            "ridge_lambda": RIDGE_LAMBDA,
            "development_only_fit": True,
            "untouched_suite": "intervention_diversity",
            "no_heldout_tuning": True,
        },
        "checkpoints": checkpoint_reports,
        "aggregate": {
            "hidden_seq_accuracy_mean_across_checkpoints": statistics.fmean(hidden_means),
            "checkpoint_classifications": classifications,
            "next_boundary": (
                "readout-recovery-only" if classifications == ["execution-representation-contains-linearly-recoverable-operation-information"]
                else "stop-head-only-work-and-redesign-representation-objective"
                if classifications == ["operation-identity-not-linearly-represented-in-execution-state"]
                else "publish-negative-compositional-collapse-and-redesign-objective"
                if classifications == ["development-success-untouched-collapse"]
                else "mixed-checkpoint-result-requires-review-before-any-training"
            ),
        },
        "interpretation_boundary": "Perfect terminal state is not evidence of latent-program discovery. This diagnostic changes no production or admission state.",
    }
    args.output.mkdir(parents=True, exist_ok=True)
    atomic_json(report, args.output / "diagnostic-report.json")
    atomic_json(report["source_identities"], args.output / "source-identities.json")
    atomic_json(report["artifact_receipt"], args.output / "artifact-receipt.json")
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--terminal-root", type=Path, required=True)
    parser.add_argument("--campaign-root", type=Path, required=True)
    parser.add_argument("--archived-trainer", type=Path, required=True)
    parser.add_argument("--artifact-receipt", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--repository-sha", required=True)
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()
    print(json.dumps(run(args), sort_keys=True))


if __name__ == "__main__":
    main()
