#!/usr/bin/env python3
"""One pursuit optimization step with causal, retention, and value-of-computation pressure."""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

import torch
import torch.nn.functional as F

from archie_sidepus_organism import ArchieSidepusOrganism
from sidepus_pursuit_forward import pursuit_forward
from sidepus_pursuit_objectives import halt_entropy, kl_to_shell, shell_logits


@dataclass
class StepOutput:
    result: dict[str, torch.Tensor]
    values: dict[str, Any]
    state_utility: float
    reset_lm_loss: float
    wrong_lm_loss: float
    target_deliberation: float
    gradient_norm: float
    finite: bool


def train_step(
    *, model: ArchieSidepusOrganism, optimizer: torch.optim.Optimizer,
    scaler: Any, inputs: torch.Tensor, world_input: torch.Tensor | None,
    plastic_input: torch.Tensor | None, rows: Sequence[Mapping[str, Any]],
    stream: Any, args: Any, step: int, device: torch.device,
    amp_dtype: torch.dtype | None,
) -> StepOutput:
    optimizer.zero_grad(set_to_none=True)
    threads = [str(row.get("state_thread_id", row["intent_id"])) for row in rows]
    wrong_world, wrong_plastic, foreign_threads = stream.foreign_state(threads, device)
    has_prior_state = world_input is not None or plastic_input is not None
    has_foreign_state = wrong_world is not None or wrong_plastic is not None
    counterfactual = has_prior_state and step % args.counterfactual_every == 0
    interference = step % args.interference_every == 0
    with torch.autocast(device_type=device.type, dtype=amp_dtype, enabled=amp_dtype is not None):
        result = pursuit_forward(
            model,
            inputs,
            labels=inputs,
            world_state=world_input,
            plastic_state=plastic_input,
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

        step_losses = result["deliberation_step_losses"]
        step_numbers = torch.arange(
            1, step_losses.numel() + 1, device=step_losses.device, dtype=step_losses.dtype
        )
        oracle_scores = step_losses.detach() + args.deliberation_compute_cost * (step_numbers - 1.0)
        oracle_index = int(torch.argmin(oracle_scores).item())

        # Do not let the halt head erase later computation before the recurrent
        # transition has learned to refine anything. The training floor decays
        # from the maximum depth to one over the configured warmup.
        warmup_fraction = min(1.0, float(step) / max(1.0, float(args.deliberation_halt_warmup_steps)))
        curriculum_floor = 1 + int(round(
            (step_losses.numel() - 1) * (1.0 - warmup_fraction)
        ))
        supervised_index = max(oracle_index, curriculum_floor - 1)
        target_steps = float(supervised_index + 1)

        stop_distribution = result["halt_weights"].float().mean(dim=0).clamp_min(1e-8)
        stop_distribution = stop_distribution / stop_distribution.sum()
        policy_loss = -torch.log(stop_distribution[supervised_index])

        # Later thoughts are trained as refinements. Penalize any adjacent step
        # that fails to improve by the declared margin instead of merely averaging
        # all step losses, which previously rewarded four copies of a bad trajectory.
        if step_losses.numel() > 1:
            trajectory_loss = F.relu(
                step_losses[1:] - step_losses[:-1]
                + args.deliberation_improvement_margin
            ).mean()
        else:
            trajectory_loss = step_losses.new_zeros(())

        best_index = int(torch.argmin(step_losses.detach()).item())
        marginal_gain = step_losses[0].detach() - step_losses[best_index].detach()
        compute_floor = F.relu(
            correct_lm.new_tensor(target_steps)
            - result["expected_deliberation_steps"]
        )
        entropy = halt_entropy(result)

        interference_loss = correct_lm.new_zeros(())
        if interference:
            with torch.no_grad():
                teacher = shell_logits(model, inputs)
            interference_loss = kl_to_shell(result["logits"], teacher)
        loss = (
            result["loss"]
            + args.state_order_weight * state_order
            + args.deliberation_policy_weight * policy_loss
            + args.deliberation_trajectory_weight * trajectory_loss
            + args.deliberation_floor_weight * compute_floor
            + args.interference_weight * interference_loss
            - args.halt_entropy_weight * entropy
        )
    scaler.scale(loss).backward()
    scaler.unscale_(optimizer)
    gradient_norm = float(
        torch.nn.utils.clip_grad_norm_(model.parameters(), args.grad_clip).detach().float().cpu()
    )
    values: dict[str, Any] = {
        "loss": float(loss.detach().float().cpu()),
        "base_loss": float(result["loss"].detach().float().cpu()),
        "lm_loss": float(correct_lm.detach().float().cpu()),
        "state_loss": float(result["state_loss"].detach().float().cpu()),
        "ponder_cost": float(result["ponder_cost"].detach().float().cpu()),
        "state_order_loss": float(state_order.detach().float().cpu()),
        "deliberation_policy_loss": float(policy_loss.detach().float().cpu()),
        "deliberation_trajectory_loss": float(trajectory_loss.detach().float().cpu()),
        "deliberation_floor_loss": float(compute_floor.detach().float().cpu()),
        "deliberation_marginal_gain": float(marginal_gain.float().cpu()),
        "oracle_deliberation_steps": target_steps,
        "deliberation_step_losses": [
            float(value.detach().float().cpu()) for value in step_losses
        ],
        "halt_stop_weights": [
            float(value.detach().float().cpu()) for value in stop_distribution
        ],
        "halt_entropy": float(entropy.detach().float().cpu()),
        "interference_kl": float(interference_loss.detach().float().cpu()),
        "causal_state_available": float(has_prior_state),
        "causal_state_compared": float(counterfactual),
        "foreign_state_available": float(has_foreign_state),
        "foreign_state_compared": float(counterfactual and has_foreign_state),
        "foreign_state_threads": foreign_threads or [],
    }
    finite_scalars = [value for value in values.values() if isinstance(value, float)]
    finite = math.isfinite(gradient_norm) and all(math.isfinite(value) for value in finite_scalars)
    if finite:
        stream.remember_state(threads, result["world_state"], result.get("plastic_state"))
    return StepOutput(
        result=result, values=values, state_utility=state_utility,
        reset_lm_loss=reset_value, wrong_lm_loss=wrong_value,
        target_deliberation=target_steps, gradient_norm=gradient_norm, finite=finite,
    )
