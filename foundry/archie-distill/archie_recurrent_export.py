#!/usr/bin/env python3
"""Strict loader for the exact Archie 114M export into recurrent mechanics."""
from __future__ import annotations

import hashlib
import pathlib
from dataclasses import fields
from typing import Any

import torch

from archie_hybrid_core import ModelConfig
from archie_recurrent_state import RecurrentArchieHybridLM

EXPORT_SCHEMA = "archie-scratch-hybrid-model/v1"
SOURCE_HEAD = "75cad4277393ebe00a9dfc45202b2e52c826b6b3"
SOURCE_CORE_BLOB = "42bff377e4ff8d05fec7f0c4ef0ed579e2900b3c"
BASELINE_EXPORT_SHA256 = "e2b829c86b1be730b8aef7617edd3b62dd819fe5bad41673e6dd284950378ded"

SOURCE_ONLY_DEFAULTS: dict[str, Any] = {
    "ssm_chunk_size": 128,
    "mixer_mode": "hybrid",
    "plastic_mode": "none",
    "plastic_rank": 16,
    "plastic_retention_floor": 0.95,
    "plastic_write_scale": 0.25,
    "plastic_state_clip": 4.0,
    "plastic_detach_every": 128,
}


def sha256_file(path: pathlib.Path, chunk_size: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def normalize_baseline_config(raw: dict[str, Any]) -> tuple[ModelConfig, dict[str, Any]]:
    if not isinstance(raw, dict):
        raise ValueError("baseline export config must be an object")
    known = {field.name for field in fields(ModelConfig)}
    unknown = set(raw) - known - set(SOURCE_ONLY_DEFAULTS)
    if unknown:
        raise ValueError(f"unsupported baseline config keys: {sorted(unknown)}")
    source_only = {key: raw.get(key, default) for key, default in SOURCE_ONLY_DEFAULTS.items()}
    if source_only["mixer_mode"] != "hybrid":
        raise ValueError("the recorded 114M lineage must use hybrid SSM/attention mixing")
    if source_only["plastic_mode"] != "none":
        raise ValueError("the recorded 114M lineage must not contain plastic-memory parameters")
    if int(source_only["ssm_chunk_size"]) < 1:
        raise ValueError("ssm_chunk_size must be positive")
    normalized = {key: value for key, value in raw.items() if key in known}
    return ModelConfig(**normalized), source_only


def load_recurrent_export(
    path: pathlib.Path,
    *,
    device: torch.device | str = "cpu",
    expected_sha256: str | None = BASELINE_EXPORT_SHA256,
) -> tuple[RecurrentArchieHybridLM, dict[str, Any]]:
    actual_sha256 = sha256_file(path)
    if expected_sha256 is not None and actual_sha256 != expected_sha256:
        raise ValueError("baseline export SHA-256 does not match the declared lineage")
    payload = torch.load(path, map_location=device, weights_only=False)
    if payload.get("schema") != EXPORT_SCHEMA:
        raise ValueError("unsupported Archie baseline export schema")
    cfg, source_only = normalize_baseline_config(payload.get("config"))
    model = RecurrentArchieHybridLM(cfg).to(device)
    model.load_state_dict(payload["model"], strict=True)
    model.eval()
    identity = {
        "schema": EXPORT_SCHEMA,
        "export_sha256": actual_sha256,
        "source_head": SOURCE_HEAD,
        "source_core_blob": SOURCE_CORE_BLOB,
        "source_only_config": source_only,
        "parameters": sum(parameter.numel() for parameter in model.parameters()),
    }
    return model, identity
