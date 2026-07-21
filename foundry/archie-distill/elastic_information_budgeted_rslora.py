#!/usr/bin/env python3
"""Elastic, receipt-bound resume wrapper for the information-budgeted RSLoRA trainer.

The canonical trainer remains the source of model, loss, tokenization, and evidence logic.
This wrapper only partitions its fixed optimizer budget into durable rungs that can move
between compatible external CUDA runners without losing model or optimizer state.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import os
import pathlib
import platform
import time
from typing import Any, Iterable

RUNG_SCHEMA = "archie-elastic-information-budgeted-rslora-rung/v1"


def stable(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(value: Any) -> str:
    raw = value if isinstance(value, bytes) else (value.encode() if isinstance(value, str) else stable(value).encode())
    return hashlib.sha256(raw).hexdigest()


def sha256(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def read_json(path: pathlib.Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise SystemExit(f"{path} must contain a JSON object.")
    return value


def verify_receipt(value: dict[str, Any]) -> str:
    body = dict(value)
    claimed = str(body.pop("receipt_digest", ""))
    if len(claimed) != 64 or digest(body) != claimed:
        raise SystemExit("Elastic rung receipt digest mismatch.")
    return claimed


def file_manifest(root: pathlib.Path) -> list[dict[str, Any]]:
    if not root.is_dir():
        raise SystemExit(f"Missing directory for manifest: {root}")
    return [
        {"path": path.relative_to(root).as_posix(), "bytes": path.stat().st_size, "sha256": sha256(path)}
        for path in sorted(root.rglob("*"))
        if path.is_file()
    ]


def manifest_digest(entries: Iterable[dict[str, Any]]) -> str:
    return digest(list(entries))


def load_base_module() -> Any:
    path = pathlib.Path(__file__).resolve().with_name("information_budgeted_rslora.py")
    spec = importlib.util.spec_from_file_location("archie_information_budgeted_rslora", path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"Unable to import canonical trainer: {path}")
    module = importlib.util.module_from_spec(spec)
    import sys
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def optimizer_steps(row_count: int, batch_size: int, gradient_accumulation_steps: int, epochs: float) -> int:
    if row_count < 1 or batch_size < 1 or gradient_accumulation_steps < 1 or epochs <= 0:
        raise SystemExit("Invalid optimizer-budget inputs.")
    batches = math.ceil(row_count / batch_size)
    updates_per_epoch = math.ceil(batches / gradient_accumulation_steps)
    return max(1, math.ceil(updates_per_epoch * epochs))


def rung_targets(total_steps: int, rung_count: int) -> list[int]:
    if total_steps < 1 or rung_count < 1:
        raise SystemExit("total_steps and rung_count must be positive.")
    if rung_count > total_steps:
        raise SystemExit(f"Cannot split {total_steps} optimizer steps into {rung_count} nonempty rungs.")
    targets = [math.ceil(total_steps * (index + 1) / rung_count) for index in range(rung_count)]
    if targets[-1] != total_steps or any(left >= right for left, right in zip(targets, targets[1:])):
        raise SystemExit("Elastic rung targets are not strictly increasing.")
    return targets


def checkpoint_step(path: pathlib.Path) -> int:
    try:
        return int(path.name.rsplit("-", 1)[1])
    except (IndexError, ValueError) as exc:
        raise SystemExit(f"Invalid Trainer checkpoint name: {path.name}") from exc


def latest_checkpoint(root: pathlib.Path) -> pathlib.Path:
    candidates = [path for path in root.glob("checkpoint-*") if path.is_dir()]
    if not candidates:
        raise SystemExit(f"No durable Trainer checkpoint found under {root}.")
    checkpoint = max(candidates, key=checkpoint_step)
    required = [checkpoint / "trainer_state.json"]
    if not any((checkpoint / name).is_file() for name in ("optimizer.pt", "optimizer.bin")):
        raise SystemExit(f"Checkpoint has no optimizer state: {checkpoint}")
    for path in required:
        if not path.is_file():
            raise SystemExit(f"Checkpoint is incomplete: {path}")
    return checkpoint


def verify_manifest(root: pathlib.Path, entries: list[dict[str, Any]], expected_digest: str | None = None) -> None:
    if not entries:
        raise SystemExit("Checkpoint manifest is empty.")
    if expected_digest is not None and manifest_digest(entries) != expected_digest:
        raise SystemExit("Checkpoint manifest digest mismatch.")
    for item in entries:
        path = root / str(item.get("path") or "")
        if not path.is_file() or path.stat().st_size != int(item.get("bytes", -1)) or sha256(path) != item.get("sha256"):
            raise SystemExit(f"Checkpoint manifest mismatch: {path}")


def parent_checkpoint(
    bundle: pathlib.Path,
    *,
    rung: int,
    request_id: str,
    shard_index: int,
    base_profile_sha256: str,
    dataset_sha256: str,
    pair_receipt_digest: str,
    student_directory_digest: str,
    total_steps: int,
    rung_count: int,
) -> tuple[pathlib.Path, dict[str, Any]]:
    receipt_path = bundle / "elastic-rung-receipt.json"
    receipt = read_json(receipt_path)
    verify_receipt(receipt)
    expected = {
        "schema": RUNG_SCHEMA,
        "request_id": request_id,
        "shard_index": shard_index,
        "rung": rung - 1,
        "rung_count": rung_count,
        "base_profile_sha256": base_profile_sha256,
        "preference_dataset_sha256": dataset_sha256,
        "pair_receipt_digest": pair_receipt_digest,
        "student_checkpoint_directory_digest": student_directory_digest,
        "total_optimizer_steps": total_steps,
    }
    for key, value in expected.items():
        if receipt.get(key) != value:
            raise SystemExit(f"Parent elastic rung identity mismatch for {key}.")
    relative = pathlib.PurePosixPath(str(receipt.get("checkpoint", {}).get("relative_path") or ""))
    if relative.is_absolute() or ".." in relative.parts:
        raise SystemExit("Parent checkpoint path escapes its bundle.")
    checkpoint = bundle / pathlib.Path(relative)
    entries = receipt.get("checkpoint", {}).get("manifest")
    if not isinstance(entries, list):
        raise SystemExit("Parent checkpoint manifest is missing.")
    verify_manifest(checkpoint, entries, str(receipt.get("checkpoint", {}).get("manifest_digest") or ""))
    state = read_json(checkpoint / "trainer_state.json")
    if int(state.get("global_step", -1)) != int(receipt.get("target_optimizer_step", -2)):
        raise SystemExit("Parent checkpoint global step does not match its receipt.")
    return checkpoint, receipt


def runner_identity() -> dict[str, Any]:
    value: dict[str, Any] = {
        "provider": os.environ.get("ARCHIE_COMPUTE_PROVIDER", "unlabeled-external-runner"),
        "runner_name": os.environ.get("RUNNER_NAME"),
        "runner_os": os.environ.get("RUNNER_OS"),
        "runner_arch": os.environ.get("RUNNER_ARCH"),
        "runner_labels": [item for item in os.environ.get("ARCHIE_RUNNER_LABELS", "").split(",") if item],
        "python": platform.python_version(),
        "platform": platform.platform(),
    }
    try:
        import torch
        value["torch"] = getattr(torch, "__version__", None)
        value["cuda"] = getattr(torch.version, "cuda", None)
        if torch.cuda.is_available():
            index = torch.cuda.current_device()
            value["gpu"] = {
                "index": index,
                "name": torch.cuda.get_device_name(index),
                "total_memory_bytes": torch.cuda.get_device_properties(index).total_memory,
            }
    except Exception as exc:
        value["runtime_probe_error"] = f"{type(exc).__name__}: {exc}"
    return value


def train_rung(args: argparse.Namespace) -> None:
    base = load_base_module()
    profile_path = pathlib.Path(args.profile).resolve()
    workspace = pathlib.Path(args.workspace).resolve()
    data_path = pathlib.Path(args.preference_data).resolve()
    pair_path = pathlib.Path(args.preference_receipt).resolve()
    cache_path = pathlib.Path(args.reference_cache).resolve()
    model_dir = pathlib.Path(args.model_dir).resolve()
    output = pathlib.Path(args.output).resolve()
    if output.exists():
        raise SystemExit(f"Refusing overwrite: {output}")
    profile = read_json(profile_path)
    pair_receipt = read_json(pair_path)
    base.verify_receipt(pair_receipt)
    rows = base.read_jsonl(data_path, required=True)
    cfg = profile.get("training") or {}
    total_steps = optimizer_steps(len(rows), args.batch_size, args.gradient_accumulation_steps, float(cfg["epochs"]))
    targets = rung_targets(total_steps, args.rung_count)
    if args.rung < 0 or args.rung >= len(targets):
        raise SystemExit("Rung index is outside the declared campaign.")
    target_step = targets[args.rung]
    previous_target = 0 if args.rung == 0 else targets[args.rung - 1]
    profile_sha = sha256(profile_path)
    dataset_sha = sha256(data_path)
    pair_digest = str(pair_receipt.get("receipt_digest") or "")
    student_digest = str(base.directory_identity(model_dir).get("directory_digest") or "")
    resume_checkpoint = None
    parent_receipt = None
    if args.rung == 0:
        if args.resume_bundle:
            raise SystemExit("Rung zero cannot consume a resume bundle.")
    else:
        if not args.resume_bundle:
            raise SystemExit("Nonzero rung requires --resume-bundle.")
        resume_checkpoint, parent_receipt = parent_checkpoint(
            pathlib.Path(args.resume_bundle).resolve(),
            rung=args.rung,
            request_id=args.request_id,
            shard_index=args.shard_index,
            base_profile_sha256=profile_sha,
            dataset_sha256=dataset_sha,
            pair_receipt_digest=pair_digest,
            student_directory_digest=student_digest,
            total_steps=total_steps,
            rung_count=args.rung_count,
        )
        if checkpoint_step(resume_checkpoint) != previous_target:
            raise SystemExit("Parent checkpoint is not the exact preceding rung target.")

    output.mkdir(parents=True)
    effective_profile = json.loads(json.dumps(profile))
    effective_profile.setdefault("elastic_execution", {})
    effective_profile["elastic_execution"] = {
        "schema": RUNG_SCHEMA,
        "request_id": args.request_id,
        "shard_index": args.shard_index,
        "rung": args.rung,
        "rung_count": args.rung_count,
        "target_optimizer_step": target_step,
        "total_optimizer_steps": total_steps,
    }
    effective_profile_path = output / "effective-profile.json"
    effective_profile_path.write_text(json.dumps(effective_profile, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    import transformers
    original_arguments = transformers.TrainingArguments
    original_train = transformers.Trainer.train

    class ElasticTrainingArguments(original_arguments):
        def __init__(self, *inner_args: Any, **kwargs: Any) -> None:
            kwargs["max_steps"] = target_step
            kwargs["save_strategy"] = "steps"
            kwargs["save_steps"] = target_step
            kwargs["save_total_limit"] = 1
            super().__init__(*inner_args, **kwargs)

    def elastic_train(trainer: Any, *inner_args: Any, **kwargs: Any) -> Any:
        if resume_checkpoint is not None:
            kwargs["resume_from_checkpoint"] = str(resume_checkpoint)
        return original_train(trainer, *inner_args, **kwargs)

    transformers.TrainingArguments = ElasticTrainingArguments
    transformers.Trainer.train = elastic_train
    started = time.time()
    try:
        namespace = argparse.Namespace(
            profile=str(effective_profile_path), workspace=str(workspace), preference_data=str(data_path),
            preference_receipt=str(pair_path), reference_cache=str(cache_path), model_dir=str(model_dir),
            output=str(output / "training"), max_seq_length=args.max_seq_length,
            prompt_replay_tokens=args.prompt_replay_tokens, prompt_head_tokens=args.prompt_head_tokens,
            shared_prefix_replay_tokens=args.shared_prefix_replay_tokens,
            max_divergence_tokens=args.max_divergence_tokens,
            gradient_accumulation_steps=args.gradient_accumulation_steps, batch_size=args.batch_size,
            beta=args.beta, causal_margin=args.causal_margin, sft_weight=args.sft_weight,
        )
        base.train_command(namespace)
    finally:
        transformers.TrainingArguments = original_arguments
        transformers.Trainer.train = original_train
    elapsed = time.time() - started

    checkpoint = latest_checkpoint(output / "training" / "checkpoints")
    state = read_json(checkpoint / "trainer_state.json")
    if int(state.get("global_step", -1)) != target_step:
        raise SystemExit(f"Rung ended at optimizer step {state.get('global_step')}, expected {target_step}.")
    checkpoint_entries = file_manifest(checkpoint)
    training_receipt_path = output / "training" / "training-receipt.json"
    training_receipt = read_json(training_receipt_path)
    base.verify_receipt(training_receipt)
    relative_checkpoint = checkpoint.relative_to(output).as_posix()
    body = {
        "schema": RUNG_SCHEMA,
        "request_id": args.request_id,
        "code_revision": args.code_revision,
        "shard_index": args.shard_index,
        "rung": args.rung,
        "rung_count": args.rung_count,
        "base_profile_sha256": profile_sha,
        "effective_profile_sha256": sha256(effective_profile_path),
        "preference_dataset_sha256": dataset_sha,
        "pair_receipt_digest": pair_digest,
        "reference_cache_receipt_digest": read_json(cache_path / "reference-cache-receipt.json").get("receipt_digest"),
        "student_checkpoint_directory_digest": student_digest,
        "total_optimizer_steps": total_steps,
        "previous_target_optimizer_step": previous_target,
        "target_optimizer_step": target_step,
        "parent_rung_receipt_digest": parent_receipt.get("receipt_digest") if parent_receipt else None,
        "checkpoint": {
            "relative_path": relative_checkpoint,
            "global_step": target_step,
            "manifest": checkpoint_entries,
            "manifest_digest": manifest_digest(checkpoint_entries),
        },
        "training_receipt": {
            "relative_path": training_receipt_path.relative_to(output).as_posix(),
            "sha256": sha256(training_receipt_path),
            "receipt_digest": training_receipt.get("receipt_digest"),
        },
        "runner": runner_identity(),
        "elapsed_seconds": elapsed,
        "promotion": "not-admitted",
        "claim_boundary": "One durable optimizer-state rung completed; capability remains unevaluated until final frozen comparison.",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    receipt = {**body, "receipt_digest": digest(body)}
    (output / "elastic-rung-receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2, sort_keys=True))


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    sub = value.add_subparsers(dest="command", required=True)
    run = sub.add_parser("train-rung")
    run.add_argument("--profile", required=True)
    run.add_argument("--workspace", required=True)
    run.add_argument("--preference-data", required=True)
    run.add_argument("--preference-receipt", required=True)
    run.add_argument("--reference-cache", required=True)
    run.add_argument("--model-dir", required=True)
    run.add_argument("--output", required=True)
    run.add_argument("--resume-bundle")
    run.add_argument("--request-id", required=True)
    run.add_argument("--code-revision", required=True)
    run.add_argument("--shard-index", type=int, required=True)
    run.add_argument("--rung", type=int, required=True)
    run.add_argument("--rung-count", type=int, required=True)
    run.add_argument("--max-seq-length", type=int, default=896)
    run.add_argument("--prompt-replay-tokens", type=int, default=384)
    run.add_argument("--prompt-head-tokens", type=int, default=32)
    run.add_argument("--shared-prefix-replay-tokens", type=int, default=96)
    run.add_argument("--max-divergence-tokens", type=int, default=384)
    run.add_argument("--gradient-accumulation-steps", type=int, default=8)
    run.add_argument("--batch-size", type=int, default=1)
    run.add_argument("--beta", type=float, default=0.1)
    run.add_argument("--causal-margin", type=float, default=0.2)
    run.add_argument("--sft-weight", type=float, default=0.35)
    run.set_defaults(function=train_rung)
    return value


def main() -> None:
    args = parser().parse_args()
    args.function(args)


if __name__ == "__main__":
    main()
