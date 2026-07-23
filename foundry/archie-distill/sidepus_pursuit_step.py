#!/usr/bin/env python3
"""One pursuit optimization step with causal and compute counterfactuals."""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

import torch
import torch.nn.functional as F

from archie_sidepus_organism import ArchieSidepusOrganism
from sidepus_pursuit_objectives import halt_entropy, kl_to_shell, shell_logits


@dataclass
class StepOutput:
    result: dict[str, torch.Tensor]
    values: dict[str, float]
    state_utility: float
    reset_lm_loss: float
    wrong_lm_loss: float
    target_deliberation: float
    gradient_norm: float
    finite: bool


def train_step(
    *, model: ArchieSidepusOrganism, optimizer: torch.optim.Optimizer,
    scaler: Any, inputs: torch.Tensor, world_input: torch.Tensor | None,
    plastic_input: torch.Tensor | None, wrong_world: torch.Tensor | None,
    wrong_plastic: torch.Tensor | None, rows: Sequence[Mapping[str, Any]],
    stream: Any, args: Any, step: int, device: torch.device,
    amp_dtype: torch.dtype | None,
) -> StepOutput:
    optimizer.zero_grad(set_to_none=True)
    has_prior_state = world_input is not None or plastic_input is not None
    has_foreign_state = wrong_world is not None or wrong_plastic is not None
    counterfactual = has_prior_state and step % args.counterfactual_every == 0
    interference = step % args.interference_every == 0
    with torch.autocast(device_type=device.type, dtype=amp_dtype, enabled=amp_dtype is not None):
        result = model(
            inputs, labels=inputs, world_state=world_input,
            plastic_state=plastic_input, return_diagnostics=True,
        )
        correct_lm = result["lm_loss"]
        state_order = correct_lm.new_zeros(())
        state_utility, reset_value, wrong_value = 0.0, float("nan"), float("nan")
        if counterfactual:
            with torch.no_grad():
                reset = model(inputs, labels=inputs, world_state=None, plastic_state=None)
                reset_lm = reset["lm_loss"].detach()
                reference = reset_lm
                reset_value = float(reset_lm.float().cpu())
                if has_foreign_state:
                    wrong = model(
                        inputs,
                        labels=inputs,
                        world_state=wrong_world,
                        plastic_state=wrong_plastic,
                    )
                    wrong_lm = wrong["lm_loss"].detach()
                    reference = torch.minimum(reference, wrong_lm)
                    wrong_value = float(wrong_lm.float().cpu())
            state_order = F.relu(args.state_margin + correct_lm - reference)
            state_utility = float((reference - correct_lm.detach()).float().cpu())
        target_steps = stream.target_deliberation(rows)
        compute_floor = F.relu(correct_lm.new_tensor(target_steps) - result["expected_deliberation_steps"])
        entropy = halt_entropy(result)
        interference_loss = correct_lm.new_zeros(())
        if interference:
            with torch.no_grad():
                teacher = shell_logits(model, inputs)
            interference_loss = kl_to_shell(result["logits"], teacher)
        loss = (
            result["loss"]
            + args.state_order_weight * state_order
            + args.deliberation_floor_weight * compute_floor
            + args.interference_weight * interference_loss
            - args.halt_entropy_weight * entropy
        )
    scaler.scale(loss).backward()
    scaler.unscale_(optimizer)
    gradient_norm = float(
        torch.nn.utils.clip_grad_norm_(model.parameters(), args.grad_clip).detach().float().cpu()
    )
    values = {
        "loss": float(loss.detach().float().cpu()),
        "base_loss": float(result["loss"].detach().float().cpu()),
        "lm_loss": float(correct_lm.detach().float().cpu()),
        "state_loss": float(result["state_loss"].detach().float().cpu()),
        "ponder_cost": float(result["ponder_cost"].detach().float().cpu()),
        "state_order_loss": float(state_order.detach().float().cpu()),
        "deliberation_floor_loss": float(compute_floor.detach().float().cpu()),
        "halt_entropy": float(entropy.detach().float().cpu()),
        "interference_kl": float(interference_loss.detach().float().cpu()),
        "causal_state_available": float(has_prior_state),
        "causal_state_compared": float(counterfactual),
        "foreign_state_available": float(has_foreign_state),
        "foreign_state_compared": float(counterfactual and has_foreign_state),
    }
    finite = math.isfinite(gradient_norm) and all(math.isfinite(value) for value in values.values())
    return StepOutput(
        result=result, values=values, state_utility=state_utility,
        reset_lm_loss=reset_value, wrong_lm_loss=wrong_value,
        target_deliberation=target_steps, gradient_norm=gradient_norm, finite=finite,
    )
