#!/usr/bin/env python3
"""Deterministic checks for governed Archie descendant growth."""
from __future__ import annotations

import json
import pathlib
import tempfile
from dataclasses import asdict, replace

import torch

from archie_hybrid_core import ArchieHybridLM, PRESETS, parameter_count
from archie_regenerative_growth import (
    build_descendant,
    decide_growth,
    plan_block_mapping,
    set_trainable_scope,
    verify_birth,
)


def main() -> None:
    cfg = PRESETS["micro"]
    torch.manual_seed(7)
    parent = ArchieHybridLM(cfg)
    payload = {
        "schema": "archie-scratch-hybrid-model/v1",
        "config": asdict(cfg),
        "model": parent.state_dict(),
        "tokenizer": {"schema": "test-tokenizer", "vocab_size": cfg.vocab_size},
    }

    mapping, inserted = plan_block_mapping(cfg, cfg.attention_every)
    assert mapping == list(range(cfg.n_layers))
    assert inserted == list(range(cfg.n_layers, cfg.n_layers + cfg.attention_every))

    decision = decide_growth(
        payload,
        {
            "failed_interventions": 3,
            "plateau_relative_gain": 0.0005,
            "retention_gate": {"passed": False},
        },
        requested_multiplier=1.5,
        max_parameter_multiplier=2.2,
        minimum_failed_interventions=2,
        plateau_threshold=0.003,
        force=False,
    )
    assert decision.approved
    assert decision.target_layers > decision.source_layers

    child, target_cfg, inherited, new_indices = build_descendant(
        payload, decision.add_layers, initialization_seed=11
    )
    assert target_cfg.n_layers == cfg.n_layers + decision.add_layers
    assert inherited == mapping
    assert new_indices == inserted
    assert parameter_count(child) > parameter_count(parent)

    verification = verify_birth(
        payload, child, seeds=[1, 2, 3], sequence_length=24, tolerance=1e-6
    )
    assert verification["passed"]

    trainable = set_trainable_scope(child, new_indices, "new-capacity")
    assert 0 < trainable < parameter_count(child)
    for name, parameter in child.named_parameters():
        block_index = int(name.split(".")[1]) if name.startswith("blocks.") else None
        assert parameter.requires_grad == (block_index in new_indices)

    all_trainable = set_trainable_scope(child, new_indices, "all")
    assert all_trainable == parameter_count(child)
    assert all(parameter.requires_grad for parameter in child.parameters())

    attention_cfg = replace(cfg, mixer_mode="attention")
    attention_mapping, attention_inserted = plan_block_mapping(attention_cfg, 1)
    assert len(attention_mapping) == attention_cfg.n_layers
    assert len(attention_inserted) == 1

    rejected = decide_growth(
        payload,
        {"failed_interventions": 0, "plateau_relative_gain": 0.02},
        requested_multiplier=1.5,
        max_parameter_multiplier=2.2,
        minimum_failed_interventions=2,
        plateau_threshold=0.003,
        force=False,
    )
    assert not rejected.approved

    with tempfile.TemporaryDirectory() as temporary:
        path = pathlib.Path(temporary) / "result.json"
        result = {
            "schema": "archie-regenerative-growth-test/v1",
            "source_layers": cfg.n_layers,
            "target_layers": target_cfg.n_layers,
            "new_blocks": new_indices,
            "birth": verification,
            "trainable_new_parameters": trainable,
            "source_parameters": parameter_count(parent),
            "target_parameters": parameter_count(child),
        }
        path.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        assert json.loads(path.read_text(encoding="utf-8"))["birth"]["passed"]
        print(path.read_text(encoding="utf-8"), end="")


if __name__ == "__main__":
    main()
