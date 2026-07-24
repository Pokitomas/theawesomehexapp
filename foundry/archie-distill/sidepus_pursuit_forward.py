#!/usr/bin/env python3
"""Pursuit forward path for the predictive Sidepus workspace.

The organism owns the causal state snapshots, prediction-error writes, iterative slot
queries, per-depth logits, and halt distributions. Keeping one implementation prevents
the training court from silently evaluating a different architecture than inference.
"""
from __future__ import annotations

import torch

from archie_sidepus_organism import ArchieSidepusOrganism


def pursuit_forward(
    model: ArchieSidepusOrganism,
    input_ids: torch.Tensor,
    labels: torch.Tensor | None = None,
    *,
    world_state: torch.Tensor | None = None,
    plastic_state: torch.Tensor | None = None,
) -> dict[str, torch.Tensor]:
    result = model(
        input_ids,
        labels=labels,
        world_state=world_state,
        plastic_state=plastic_state,
        return_diagnostics=True,
    )
    required = {
        "logits",
        "world_state",
        "thought_sequence",
        "halt_probabilities",
        "halt_weights",
        "deliberation_hidden_steps",
        "state_prediction_loss",
        "state_surprise",
    }
    if labels is not None:
        required.update({"deliberation_step_losses", "deliberation_token_losses"})
    missing = sorted(required - set(result))
    if missing:
        raise RuntimeError("predictive workspace forward omitted: " + ", ".join(missing))
    return result
