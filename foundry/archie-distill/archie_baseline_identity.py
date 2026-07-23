#!/usr/bin/env python3
"""Executable lineage capsule for the exact Archie 114M baseline."""
from __future__ import annotations

import hashlib
import json
import pathlib
from dataclasses import asdict
from typing import Any

import torch

from archie_hybrid_core import ArchieHybridLM, ModelConfig

EXPORT_SCHEMA = "archie-scratch-hybrid-model/v1"
SOURCE_HEAD = "75cad4277393ebe00a9dfc45202b2e52c826b6b3"
SOURCE_CORE_BLOB = "42bff377e4ff8d05fec7f0c4ef0ed579e2900b3c"
BASELINE_EXPORT_SHA256 = "e2b829c86b1be730b8aef7617edd3b62dd819fe5bad41673e6dd284950378ded"
CORPUS_SCHEMAS = frozenset({"archie-u16-token-corpus/v2", "archie-u16-byte-corpus/v1"})


def stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_file(path: pathlib.Path, chunk_size: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def git_blob_sha1(path: pathlib.Path) -> str:
    payload = path.read_bytes()
    header = f"blob {len(payload)}\0".encode("ascii")
    return hashlib.sha1(header + payload).hexdigest()


def verify_source_core(path: pathlib.Path | None = None) -> str:
    core_path = path or pathlib.Path(__file__).with_name("archie_hybrid_core.py")
    actual = git_blob_sha1(core_path)
    if actual != SOURCE_CORE_BLOB:
        raise ValueError(
            f"Archie source core drifted: expected git blob {SOURCE_CORE_BLOB}, got {actual}"
        )
    return actual


def normalize_baseline_config(raw: dict[str, Any]) -> ModelConfig:
    if not isinstance(raw, dict):
        raise ValueError("baseline export config must be an object")
    known = set(ModelConfig.__dataclass_fields__)
    unknown = set(raw) - known
    if unknown:
        raise ValueError(f"unsupported baseline config keys: {sorted(unknown)}")
    cfg = ModelConfig(**raw)
    if cfg.mixer_mode != "hybrid":
        raise ValueError("the recorded 114M lineage must use hybrid SSM/attention mixing")
    if cfg.plastic_mode != "none":
        raise ValueError("the recorded 114M lineage must not contain plastic-memory parameters")
    if cfg.ssm_chunk_size < 1:
        raise ValueError("ssm_chunk_size must be positive")
    return cfg


def config_digest(cfg: ModelConfig) -> str:
    return hashlib.sha256(stable_json(asdict(cfg)).encode("utf-8")).hexdigest()


def load_baseline_export(
    path: pathlib.Path,
    *,
    device: torch.device | str = "cpu",
    expected_sha256: str | None = BASELINE_EXPORT_SHA256,
) -> tuple[ArchieHybridLM, dict[str, Any]]:
    source_blob = verify_source_core()
    actual_sha256 = sha256_file(path)
    if expected_sha256 is not None and actual_sha256 != expected_sha256:
        raise ValueError("baseline export SHA-256 does not match the declared lineage")
    payload = torch.load(path, map_location=device, weights_only=False)
    if payload.get("schema") != EXPORT_SCHEMA:
        raise ValueError("unsupported Archie baseline export schema")
    cfg = normalize_baseline_config(payload.get("config"))
    model = ArchieHybridLM(cfg).to(device)
    model.load_state_dict(payload["model"], strict=True)
    model.eval()
    identity = {
        "schema": EXPORT_SCHEMA,
        "export_sha256": actual_sha256,
        "source_head": SOURCE_HEAD,
        "source_core_blob": source_blob,
        "config_digest": config_digest(cfg),
        "config": asdict(cfg),
        "parameters": sum(parameter.numel() for parameter in model.parameters()),
    }
    return model, identity
