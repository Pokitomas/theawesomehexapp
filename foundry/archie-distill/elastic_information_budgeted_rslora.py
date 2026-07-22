#!/usr/bin/env python3
"""Elastic, receipt-bound resume wrapper for information-budgeted RSLoRA.

The canonical trainer remains authoritative for model loading, loss construction,
tokenization, and evidence generation. This wrapper partitions the fixed optimizer
budget into durable cumulative rungs and refuses resume when lineage or complete
Trainer and optimizer state drifts.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import importlib.util
import inspect
import json
import math
import os
import pathlib
import platform
import time
from typing import Any, Iterable

RUNG_SCHEMA = "archie-elastic-information-budgeted-rslora-rung/v2"
TRAINING_PACKAGES = ("torch", "transformers", "peft", "bitsandbytes", "accelerate", "datasets")


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


def verify_manifest(root: pathlib.Path, entries: list[dict[str, Any]], expected_digest: str | None = None) -> None:
    if not entries:
        raise SystemExit("Checkpoint manifest is empty.")
    if expected_digest is not None and manifest_digest(entries) != expected_digest:
        raise SystemExit("Checkpoint manifest digest mismatch.")
    declared = {str(item.get("path") or "") for item in entries}
    actual = {item["path"] for item in file_manifest(root)}
    if declared != actual:
        raise SystemExit("Checkpoint manifest path set mismatch.")
    for item in entries:
        relative = pathlib.PurePosixPath(str(item.get("path") or ""))
        if relative.is_absolute() or ".." in relative.parts:
            raise SystemExit("Checkpoint manifest path escapes its root.")
        path = root / pathlib.Path(relative)
        if not path.is_file() or path.stat().st_size != int(item.get("bytes", -1)) or sha256(path) != item.get("sha256"):
            raise SystemExit(f"Checkpoint manifest mismatch: {path}")


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


def _required_file(checkpoint: pathlib.Path, label: str, names: tuple[str, ...]) -> str:
    for name in names:
        if (checkpoint / name).is_file():
            return name
    raise SystemExit(f"Checkpoint has no {label} state: {checkpoint}")


def checkpoint_contract(checkpoint: pathlib.Path, *, require_scaler: bool) -> dict[str, Any]:
    trainer_state = checkpoint / "trainer_state.json"
    if not trainer_state.is_file():
        raise SystemExit(f"Checkpoint has no Trainer state: {checkpoint}")
    files = {
        "trainer": "trainer_state.json",
        "optimizer": _required_file(checkpoint, "optimizer", ("optimizer.pt", "optimizer.bin")),
        "scheduler": _required_file(checkpoint, "scheduler", ("scheduler.pt", "scheduler.bin")),
        "rng": _required_file(checkpoint, "RNG", ("rng_state.pth",)),
        "model": _required_file(
            checkpoint,
            "model/adapter",
            ("adapter_model.safetensors", "adapter_model.bin", "model.safetensors", "pytorch_model.bin"),
        ),
    }
    if require_scaler:
        files["scaler"] = _required_file(checkpoint, "mixed-precision scaler", ("scaler.pt", "scaler.bin"))
    state = read_json(trainer_state)
    return {
        "files": files,
        "global_step": int(state.get("global_step", -1)),
        "epoch": state.get("epoch"),
        "scaler_required": require_scaler,
    }


def latest_checkpoint(root: pathlib.Path, *, require_scaler: bool = True) -> pathlib.Path:
    candidates = [path for path in root.glob("checkpoint-*") if path.is_dir()]
    if not candidates:
        raise SystemExit(f"No durable Trainer checkpoint found under {root}.")
    checkpoint = max(candidates, key=checkpoint_step)
    checkpoint_contract(checkpoint, require_scaler=require_scaler)
    return checkpoint


def package_identity() -> dict[str, Any]:
    versions: dict[str, Any] = {}
    for name in TRAINING_PACKAGES:
        try:
            versions[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            versions[name] = None
    try:
        import torch
        cuda = getattr(torch.version, "cuda", None)
    except Exception:
        cuda = None
    body = {"python": platform.python_version(), "packages": versions, "cuda_runtime": cuda}
    return {**body, "identity_digest": digest(body)}


def reference_cache_identity(root: pathlib.Path) -> dict[str, Any]:
    receipt_path = root / "reference-cache-receipt.json"
    receipt = read_json(receipt_path)
    verify_receipt(receipt)
    entries = file_manifest(root)
    return {
        "receipt_digest": receipt.get("receipt_digest"),
        "receipt_sha256": sha256(receipt_path),
        "manifest_digest": manifest_digest(entries),
        "manifest": entries,
    }


def training_plan_sha256(workspace: pathlib.Path) -> str | None:
    path = workspace / "training-plan.json"
    return sha256(path) if path.is_file() else None


def parent_checkpoint(
    bundle: pathlib.Path,
    *,
    rung: int,
    request_id: str,
    code_revision: str,
    shard_index: int,
    base_profile_sha256: str,
    training_config_sha256: str,
    training_plan_sha256_value: str | None,
    dataset_sha256: str,
    pair_receipt_digest: str,
    reference_cache_manifest_digest: str,
    student_directory_digest: str,
    tokenizer_identity_digest: str,
    software_identity_digest: str,
    total_steps: int,
    rung_count: int,
    require_scaler: bool,
) -> tuple[pathlib.Path, dict[str, Any]]:
    receipt_path = bundle / "elastic-rung-receipt.json"
    receipt = read_json(receipt_path)
    verify_receipt(receipt)
    expected = {
        "schema": RUNG_SCHEMA,
        "request_id": request_id,
        "code_revision": code_revision,
        "shard_index": shard_index,
        "rung": rung - 1,
        "rung_count": rung_count,
        "base_profile_sha256": base_profile_sha256,
        "training_config_sha256": training_config_sha256,
        "training_plan_sha256": training_plan_sha256_value,
        "preference_dataset_sha256": dataset_sha256,
        "pair_receipt_digest": pair_receipt_digest,
        "reference_cache_manifest_digest": reference_cache_manifest_digest,
        "student_checkpoint_directory_digest": student_directory_digest,
        "tokenizer_identity_digest": tokenizer_identity_digest,
        "software_identity_digest": software_identity_digest,
        "total_optimizer_steps": total_steps,
    }
    for key, value in expected.items():
        if receipt.get(key) != value:
            raise SystemExit(f"Parent elastic rung identity mismatch for {key}.")
    expected_previous = int(receipt.get("target_optimizer_step", -1))
    if int(receipt.get("next_optimizer_step", -1)) != expected_previous + 1:
        raise SystemExit("Parent elastic rung next-step cursor is inconsistent.")
    relative = pathlib.PurePosixPath(str(receipt.get("checkpoint", {}).get("relative_path") or ""))
    if relative.is_absolute() or ".." in relative.parts:
        raise SystemExit("Parent checkpoint path escapes its bundle.")
    checkpoint = bundle / pathlib.Path(relative)
    entries = receipt.get("checkpoint", {}).get("manifest")
    if not isinstance(entries, list):
        raise SystemExit("Parent checkpoint manifest is missing.")
    verify_manifest(checkpoint, entries, str(receipt.get("checkpoint", {}).get("manifest_digest") or ""))
    contract = checkpoint_contract(checkpoint, require_scaler=require_scaler)
    if contract != receipt.get("checkpoint", {}).get("state_contract"):
        raise SystemExit("Parent checkpoint state contract mismatch.")
    if contract["global_step"] != expected_previous or checkpoint_step(checkpoint) != expected_previous:
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
            properties = torch.cuda.get_device_properties(index)
            value["gpu"] = {
                "index": index,
                "name": torch.cuda.get_device_name(index),
                "total_memory_bytes": properties.total_memory,
                "compute_capability": [properties.major, properties.minor],
            }
    except Exception as exc:
        value["runtime_probe_error"] = f"{type(exc).__name__}: {exc}"
    return value


def sampler_receipt(
    *, pair_ids: list[str], parent_receipt: dict[str, Any] | None, state: dict[str, Any],
    row_count: int, batch_size: int, gradient_accumulation_steps: int, seed: int,
) -> dict[str, Any]:
    current_digest = digest(pair_ids)
    parent_sampler = (parent_receipt or {}).get("sampler_cursor") or {}
    parent_chain = parent_sampler.get("cumulative_chain_digest")
    parent_microbatches = int(parent_sampler.get("cumulative_microbatches", 0))
    return {
        "method": "trainer-training-step-pair-trace/v1",
        "new_pair_ids": pair_ids,
        "new_pair_ids_digest": current_digest,
        "new_microbatches": len(pair_ids),
        "cumulative_microbatches": parent_microbatches + len(pair_ids),
        "cumulative_chain_digest": digest({"parent": parent_chain, "current": current_digest}),
        "dataset_rows": row_count,
        "per_device_batch_size": batch_size,
        "gradient_accumulation_steps": gradient_accumulation_steps,
        "seed": seed,
        "data_seed": seed,
        "ignore_data_skip": False,
        "trainer_global_step": int(state.get("global_step", -1)),
        "trainer_epoch": state.get("epoch"),
    }


def train_rung(args: argparse.Namespace) -> None:
    base = load_base_module()
    profile_path = pathlib.Path(args.profile).resolve()
    training_config_path = pathlib.Path(args.training_config).resolve()
    workspace = pathlib.Path(args.workspace).resolve()
    data_path = pathlib.Path(args.preference_data).resolve()
    pair_path = pathlib.Path(args.preference_receipt).resolve()
    cache_path = pathlib.Path(args.reference_cache).resolve()
    model_dir = pathlib.Path(args.model_dir).resolve()
    output = pathlib.Path(args.output).resolve()
    if output.exists():
        raise SystemExit(f"Refusing overwrite: {output}")
    for path in (profile_path, training_config_path, data_path, pair_path):
        if not path.is_file():
            raise SystemExit(f"Missing immutable input: {path}")
    if not workspace.is_dir() or not cache_path.is_dir() or not model_dir.is_dir():
        raise SystemExit("Workspace, reference cache, and model directory must exist.")

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
    config_sha = sha256(training_config_path)
    plan_sha = training_plan_sha256(workspace)
    dataset_sha = sha256(data_path)
    pair_digest = str(pair_receipt.get("receipt_digest") or "")
    cache_identity = reference_cache_identity(cache_path)
    student_digest = str(base.directory_identity(model_dir).get("directory_digest") or "")
    tokenizer_digest = str(base.tokenizer_identity(model_dir).get("digest") or "")
    software = package_identity()
    require_scaler = True

    resume_checkpoint = None
    parent_receipt = None
    if args.rung == 0:
        if args.resume_bundle:
            raise SystemExit("Rung zero cannot consume a resume bundle.")
    else:
        if not args.resume_bundle:
            raise SystemExit("Nonzero rung requires --resume-bundle.")
        resume_checkpoint, parent_receipt = parent_checkpoint(
            pathlib.Path(args.resume_bundle).resolve(), rung=args.rung, request_id=args.request_id,
            code_revision=args.code_revision, shard_index=args.shard_index,
            base_profile_sha256=profile_sha, training_config_sha256=config_sha,
            training_plan_sha256_value=plan_sha, dataset_sha256=dataset_sha,
            pair_receipt_digest=pair_digest,
            reference_cache_manifest_digest=str(cache_identity["manifest_digest"]),
            student_directory_digest=student_digest, tokenizer_identity_digest=tokenizer_digest,
            software_identity_digest=str(software["identity_digest"]), total_steps=total_steps,
            rung_count=args.rung_count, require_scaler=require_scaler,
        )
        if checkpoint_step(resume_checkpoint) != previous_target:
            raise SystemExit("Parent checkpoint is not the exact preceding rung target.")

    output.mkdir(parents=True)
    effective_profile = json.loads(json.dumps(profile))
    effective_profile["elastic_execution"] = {
        "schema": RUNG_SCHEMA, "request_id": args.request_id, "code_revision": args.code_revision,
        "shard_index": args.shard_index, "rung": args.rung, "rung_count": args.rung_count,
        "previous_target_optimizer_step": previous_target, "target_optimizer_step": target_step,
        "total_optimizer_steps": total_steps,
    }
    effective_profile_path = output / "effective-profile.json"
    effective_profile_path.write_text(json.dumps(effective_profile, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    import transformers
    original_arguments = transformers.TrainingArguments
    original_train = transformers.Trainer.train
    original_training_step = transformers.Trainer.training_step
    original_collator = base.ForkCollator
    consumed_pair_ids: list[str] = []

    class TrackingForkCollator:
        def __init__(self, pad_token_id: int) -> None:
            self.inner = original_collator(pad_token_id)

        def __call__(self, features: list[dict[str, Any]]) -> dict[str, Any]:
            batch = self.inner(features)
            batch["__archie_pair_ids"] = [str(item.get("pair_id")) for item in features]
            return batch

    class ElasticTrainingArguments(original_arguments):
        def __init__(self, *inner_args: Any, **kwargs: Any) -> None:
            kwargs["max_steps"] = target_step
            kwargs["save_strategy"] = "steps"
            kwargs["save_steps"] = target_step
            kwargs["save_total_limit"] = 1
            kwargs["dataloader_num_workers"] = 0
            kwargs["ignore_data_skip"] = False
            if "save_only_model" in inspect.signature(original_arguments.__init__).parameters:
                kwargs["save_only_model"] = False
            super().__init__(*inner_args, **kwargs)

    def elastic_train(trainer: Any, *inner_args: Any, **kwargs: Any) -> Any:
        if resume_checkpoint is not None:
            kwargs["resume_from_checkpoint"] = str(resume_checkpoint)
        return original_train(trainer, *inner_args, **kwargs)

    def elastic_training_step(trainer: Any, model: Any, inputs: dict[str, Any], *inner_args: Any, **kwargs: Any) -> Any:
        pair_ids = inputs.pop("__archie_pair_ids", None)
        if pair_ids:
            consumed_pair_ids.extend(str(item) for item in pair_ids)
        return original_training_step(trainer, model, inputs, *inner_args, **kwargs)

    transformers.TrainingArguments = ElasticTrainingArguments
    transformers.Trainer.train = elastic_train
    transformers.Trainer.training_step = elastic_training_step
    base.ForkCollator = TrackingForkCollator
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
        transformers.Trainer.training_step = original_training_step
        base.ForkCollator = original_collator
    elapsed = time.time() - started

    checkpoint = latest_checkpoint(output / "training" / "checkpoints", require_scaler=require_scaler)
    state = read_json(checkpoint / "trainer_state.json")
    if int(state.get("global_step", -1)) != target_step:
        raise SystemExit(f"Rung ended at optimizer step {state.get('global_step')}, expected {target_step}.")
    if not consumed_pair_ids:
        raise SystemExit("No consumed pair IDs were observed during the rung.")
    checkpoint_entries = file_manifest(checkpoint)
    state_contract = checkpoint_contract(checkpoint, require_scaler=require_scaler)
    training_receipt_path = output / "training" / "training-receipt.json"
    training_receipt = read_json(training_receipt_path)
    base.verify_receipt(training_receipt)
    sampler = sampler_receipt(
        pair_ids=consumed_pair_ids, parent_receipt=parent_receipt, state=state, row_count=len(rows),
        batch_size=args.batch_size, gradient_accumulation_steps=args.gradient_accumulation_steps,
        seed=int(cfg["seed"]),
    )
    relative_checkpoint = checkpoint.relative_to(output).as_posix()
    body = {
        "schema": RUNG_SCHEMA, "request_id": args.request_id, "code_revision": args.code_revision,
        "shard_index": args.shard_index, "rung": args.rung, "rung_count": args.rung_count,
        "base_profile_sha256": profile_sha, "effective_profile_sha256": sha256(effective_profile_path),
        "training_config_sha256": config_sha, "training_plan_sha256": plan_sha,
        "preference_dataset_sha256": dataset_sha, "pair_receipt_digest": pair_digest,
        "reference_cache_receipt_digest": cache_identity["receipt_digest"],
        "reference_cache_manifest_digest": cache_identity["manifest_digest"],
        "student_checkpoint_directory_digest": student_digest, "tokenizer_identity_digest": tokenizer_digest,
        "software_identity": software, "software_identity_digest": software["identity_digest"],
        "total_optimizer_steps": total_steps, "previous_target_optimizer_step": previous_target,
        "target_optimizer_step": target_step, "next_optimizer_step": target_step + 1,
        "parent_rung_receipt_digest": parent_receipt.get("receipt_digest") if parent_receipt else None,
        "sampler_cursor": sampler,
        "checkpoint": {
            "relative_path": relative_checkpoint, "global_step": target_step,
            "state_contract": state_contract, "manifest": checkpoint_entries,
            "manifest_digest": manifest_digest(checkpoint_entries),
        },
        "training_receipt": {
            "relative_path": training_receipt_path.relative_to(output).as_posix(),
            "sha256": sha256(training_receipt_path), "receipt_digest": training_receipt.get("receipt_digest"),
        },
        "runner": runner_identity(), "elapsed_seconds": elapsed, "promotion": "not-admitted",
        "claim_boundary": "One complete optimizer-state rung finished; capability remains unevaluated until frozen comparison.",
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
    run.add_argument("--training-config", required=True)
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
