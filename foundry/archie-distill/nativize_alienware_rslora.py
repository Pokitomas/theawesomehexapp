#!/usr/bin/env python3
"""Convert a verified external RSLoRA rung bundle into a minimal native envelope.

This command is intentionally CPU-only and dependency-free. It never loads the base
model or adapter tensors. It verifies immutable evidence produced by the CUDA host,
then copies only the files needed by native verification/fusion consumers.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import shutil
import tempfile
from typing import Any

SCHEMA = "archie-native-external-rslora/v1"
REQUIRED_RECEIPT_SCHEMA = "archie-elastic-information-budgeted-rslora-rung/v2"
REQUIRED_CHECKPOINT_ROLES = {"trainer", "optimizer", "scheduler", "rng", "model"}


def stable(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def digest(value: Any) -> str:
    raw = value if isinstance(value, bytes) else stable(value)
    return hashlib.sha256(raw).hexdigest()


def sha256(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def read_object(path: pathlib.Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise SystemExit(f"Expected JSON object: {path}")
    return value


def verify_receipt(receipt: dict[str, Any]) -> str:
    body = dict(receipt)
    claimed = str(body.pop("receipt_digest", ""))
    if len(claimed) != 64 or digest(body) != claimed:
        raise SystemExit("External rung receipt digest mismatch.")
    return claimed


def safe_relative(raw: str) -> pathlib.PurePosixPath:
    value = pathlib.PurePosixPath(raw)
    if not raw or value.is_absolute() or ".." in value.parts:
        raise SystemExit(f"Unsafe bundle path: {raw!r}")
    return value


def verify_checkpoint(bundle: pathlib.Path, receipt: dict[str, Any]) -> pathlib.Path:
    checkpoint = receipt.get("checkpoint") or {}
    relative = safe_relative(str(checkpoint.get("relative_path") or ""))
    root = bundle / pathlib.Path(relative)
    if not root.is_dir():
        raise SystemExit("External checkpoint directory is missing.")
    contract = checkpoint.get("state_contract") or {}
    roles = set((contract.get("files") or {}).keys())
    if not REQUIRED_CHECKPOINT_ROLES.issubset(roles):
        raise SystemExit("Checkpoint lacks complete trainer/optimizer/scheduler/RNG/model state.")
    entries = checkpoint.get("manifest")
    if not isinstance(entries, list) or not entries:
        raise SystemExit("Checkpoint manifest is missing.")
    if digest(entries) != str(checkpoint.get("manifest_digest") or ""):
        raise SystemExit("Checkpoint manifest digest mismatch.")
    declared: set[str] = set()
    for item in entries:
        rel = safe_relative(str(item.get("path") or ""))
        declared.add(rel.as_posix())
        path = root / pathlib.Path(rel)
        if not path.is_file():
            raise SystemExit(f"Checkpoint file is missing: {rel}")
        if path.stat().st_size != int(item.get("bytes", -1)) or sha256(path) != item.get("sha256"):
            raise SystemExit(f"Checkpoint file identity mismatch: {rel}")
    actual = {path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file()}
    if actual != declared:
        raise SystemExit("Checkpoint path set differs from its manifest.")
    return root


def copy_verified(source: pathlib.Path, destination: pathlib.Path) -> dict[str, Any]:
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    return {"path": destination.name, "bytes": destination.stat().st_size, "sha256": sha256(destination)}


def nativize(bundle: pathlib.Path, output: pathlib.Path, request_id: str) -> dict[str, Any]:
    if output.exists():
        raise SystemExit(f"Refusing overwrite: {output}")
    receipt_path = bundle / "elastic-rung-receipt.json"
    receipt = read_object(receipt_path)
    source_digest = verify_receipt(receipt)
    if receipt.get("schema") != REQUIRED_RECEIPT_SCHEMA:
        raise SystemExit("Unsupported external rung schema.")
    if receipt.get("promotion") != "not-admitted":
        raise SystemExit("External bundle crossed the non-admission boundary.")
    if str(receipt.get("request_id") or "") != request_id:
        raise SystemExit("Request identity mismatch.")
    checkpoint_root = verify_checkpoint(bundle, receipt)

    training = receipt.get("training_receipt") or {}
    training_rel = safe_relative(str(training.get("relative_path") or ""))
    training_path = bundle / pathlib.Path(training_rel)
    if not training_path.is_file() or sha256(training_path) != training.get("sha256"):
        raise SystemExit("Training receipt identity mismatch.")

    output.mkdir(parents=True)
    payload = output / "payload"
    payload.mkdir()
    files = [
        copy_verified(receipt_path, payload / "external-rung-receipt.json"),
        copy_verified(training_path, payload / "training-receipt.json"),
    ]
    adapter_files = []
    for name in ("adapter_model.safetensors", "adapter_model.bin", "adapter_config.json"):
        matches = sorted(checkpoint_root.rglob(name))
        if matches:
            target = payload / name
            adapter_files.append(copy_verified(matches[0], target))
    if not any(item["path"].startswith("adapter_model.") for item in adapter_files):
        raise SystemExit("No adapter tensor file exists in the verified checkpoint.")
    files.extend(adapter_files)

    native_body = {
        "schema": SCHEMA,
        "request_id": request_id,
        "source": {
            "receipt_digest": source_digest,
            "code_revision": receipt.get("code_revision"),
            "shard_index": receipt.get("shard_index"),
            "rung": receipt.get("rung"),
            "rung_count": receipt.get("rung_count"),
            "target_optimizer_step": receipt.get("target_optimizer_step"),
            "base_profile_sha256": receipt.get("base_profile_sha256"),
            "preference_dataset_sha256": receipt.get("preference_dataset_sha256"),
            "student_checkpoint_directory_digest": receipt.get("student_checkpoint_directory_digest"),
            "tokenizer_identity_digest": receipt.get("tokenizer_identity_digest"),
        },
        "payload_manifest": files,
        "payload_manifest_digest": digest(files),
        "connector_reduction": {
            "accepted_transport": "single-http-body-or-local-directory",
            "native_dependencies": ["python-standard-library"],
            "discarded_runtime_metadata": ["provider", "runner_name", "runner_labels", "cloud_credentials"],
            "cuda_required": False,
            "model_loading_required": False,
        },
        "promotion": "not-admitted",
        "claim_boundary": "Verified external training bytes were normalized; capability and admission remain unevaluated.",
    }
    native = {**native_body, "receipt_digest": digest(native_body)}
    (output / "native-receipt.json").write_text(json.dumps(native, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return native


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--request-id", required=True)
    args = parser.parse_args()
    result = nativize(pathlib.Path(args.bundle).resolve(), pathlib.Path(args.output).resolve(), args.request_id)
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
