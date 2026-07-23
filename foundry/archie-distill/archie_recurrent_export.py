#!/usr/bin/env python3
"""Strict loader for the exact Archie 114M export into recurrent mechanics."""
from __future__ import annotations

import pathlib
from typing import Any

import torch

from archie_baseline_identity import (
    BASELINE_EXPORT_SHA256,
    EXPORT_SCHEMA,
    SOURCE_CORE_BLOB,
    SOURCE_HEAD,
    config_digest,
    normalize_baseline_config as normalize_exact_config,
    sha256_file,
    verify_source_core,
)
from archie_hybrid_core import ModelConfig
from archie_recurrent_state import RecurrentArchieHybridLM

SOURCE_ONLY_FIELDS = (
    "ssm_chunk_size",
    "mixer_mode",
    "plastic_mode",
    "plastic_rank",
    "plastic_retention_floor",
    "plastic_write_scale",
    "plastic_state_clip",
    "plastic_detach_every",
)


def normalize_baseline_config(raw: dict[str, Any]) -> tuple[ModelConfig, dict[str, Any]]:
    cfg = normalize_exact_config(raw)
    return cfg, {key: getattr(cfg, key) for key in SOURCE_ONLY_FIELDS}


def load_recurrent_export(
    path: pathlib.Path,
    *,
    device: torch.device | str = "cpu",
    expected_sha256: str | None = BASELINE_EXPORT_SHA256,
) -> tuple[RecurrentArchieHybridLM, dict[str, Any]]:
    source_blob = verify_source_core()
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
        "source_core_blob": source_blob,
        "config_digest": config_digest(cfg),
        "source_only_config": source_only,
        "parameters": sum(parameter.numel() for parameter in model.parameters()),
    }
    if identity["source_core_blob"] != SOURCE_CORE_BLOB:
        raise ValueError("recurrent loader is not running against the bound source core")
    return model, identity
