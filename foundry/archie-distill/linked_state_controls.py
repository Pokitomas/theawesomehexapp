#!/usr/bin/env python3
"""Matched recurrent-state controls and fail-closed evidence classification."""
from __future__ import annotations

import copy
import hashlib
import json
from dataclasses import dataclass
from typing import Any

import torch

from archie_linked_state import KVState, LinkedState, SSMState


def clone_state(state: LinkedState) -> LinkedState:
    layers: list[SSMState | KVState] = []
    for layer in state.layers:
        if isinstance(layer, SSMState):
            layers.append(
                SSMState(layer.recurrent.clone(), layer.convolution.clone())
            )
        else:
            layers.append(
                KVState(
                    None if layer.keys is None else layer.keys.clone(),
                    None if layer.values is None else layer.values.clone(),
                    None if layer.valid is None else layer.valid.clone(),
                )
            )
    return LinkedState(layers, state.position.clone())


def transplant_state(donor: LinkedState) -> LinkedState:
    return clone_state(donor)


def reset_state_like(state: LinkedState) -> LinkedState:
    reset = clone_state(state)
    reset.position.zero_()
    for layer in reset.layers:
        if isinstance(layer, SSMState):
            layer.recurrent.zero_()
            layer.convolution.zero_()
        else:
            layer.keys = None
            layer.values = None
            layer.valid = None
    return reset


def shuffled_state(state: LinkedState, seed: int) -> LinkedState:
    """Apply deterministic feature permutations while preserving shapes."""
    shuffled = clone_state(state)
    generator = torch.Generator(device="cpu")
    generator.manual_seed(seed)
    for layer in shuffled.layers:
        if isinstance(layer, SSMState):
            width = layer.recurrent.size(-1)
            permutation = torch.randperm(width, generator=generator).to(
                layer.recurrent.device
            )
            layer.recurrent = layer.recurrent.index_select(-1, permutation)
            layer.convolution = layer.convolution.index_select(-2, permutation)
        elif layer.keys is not None:
            head_dim = layer.keys.size(-1)
            permutation = torch.randperm(head_dim, generator=generator).to(
                layer.keys.device
            )
            layer.keys = layer.keys.index_select(-1, permutation)
            if layer.values is None:
                raise ValueError("partial KV cache")
            layer.values = layer.values.index_select(-1, permutation)
    return shuffled


def state_digest(state: LinkedState) -> str:
    digest = hashlib.sha256()
    digest.update(state.position.detach().cpu().contiguous().numpy().tobytes())
    for layer in state.layers:
        digest.update(type(layer).__name__.encode())
        for value in vars(layer).values():
            if value is None:
                digest.update(b"<none>")
            elif isinstance(value, torch.Tensor):
                tensor = value.detach().cpu().contiguous()
                digest.update(str(tensor.dtype).encode())
                digest.update(json.dumps(list(tensor.shape)).encode())
                digest.update(tensor.numpy().tobytes())
    return digest.hexdigest()


@dataclass(frozen=True)
class ControlMetrics:
    correct_bpb: float
    reset_bpb: float
    transplant_bpb: float
    shuffled_bpb: float
    ordinary_retention_delta_bpb: float
    incremental_max_logit_error: float
    seeds: int
    heldout_sources: int

    def validate(self) -> None:
        values = (
            self.correct_bpb,
            self.reset_bpb,
            self.transplant_bpb,
            self.shuffled_bpb,
            self.ordinary_retention_delta_bpb,
            self.incremental_max_logit_error,
        )
        if not all(torch.isfinite(torch.tensor(value)).item() for value in values):
            raise ValueError("metrics must be finite")
        if self.seeds < 2 or self.heldout_sources < 4:
            raise ValueError("recurrence evidence requires multiple seeds and sources")


def classify_recurrence(metrics: ControlMetrics) -> dict[str, Any]:
    metrics.validate()
    carried_gain = metrics.reset_bpb - metrics.correct_bpb
    transplant_penalty = metrics.transplant_bpb - metrics.correct_bpb
    shuffle_penalty = metrics.shuffled_bpb - metrics.correct_bpb
    parity_ok = metrics.incremental_max_logit_error <= 2e-5
    retention_ok = metrics.ordinary_retention_delta_bpb <= 0.02
    supported = (
        carried_gain > 0.0
        and transplant_penalty > 0.0
        and shuffle_penalty > 0.0
        and parity_ok
        and retention_ok
    )
    return {
        "schema": "archie-linked-state-verdict/v1",
        "verdict": "recurrence-supported" if supported else "recurrence-not-supported",
        "promotion": "research-only-not-admitted",
        "carried_gain_bpb": carried_gain,
        "transplant_penalty_bpb": transplant_penalty,
        "shuffle_penalty_bpb": shuffle_penalty,
        "incremental_parity": parity_ok,
        "ordinary_retention": retention_ok,
        "event_clock_unblocked": supported,
        "metrics": copy.deepcopy(metrics.__dict__),
    }
