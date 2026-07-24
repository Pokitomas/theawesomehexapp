#!/usr/bin/env python3
"""Training forward pass exposing the causal marginal value of each deliberation step."""
from __future__ import annotations

from collections.abc import Mapping

import torch
import torch.nn.functional as F

from archie_hybrid_core import PAD_ID
from archie_sidepus_organism import ArchieSidepusOrganism


def _deliberation_trajectory(
    model: ArchieSidepusOrganism,
    token_features: torch.Tensor,
    world_features: torch.Tensor,
    plastic_features: torch.Tensor,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
    """Return token-causal thoughts at every recurrent depth.

    Inputs have shape [batch,length,width]. Positions are flattened only for parallel
    execution of the depth recurrence; no pooling or mixing occurs across sequence time.
    """
    if not (
        token_features.shape == world_features.shape == plastic_features.shape
        and token_features.ndim == 3
    ):
        raise ValueError("deliberation features must share [batch,length,width]")
    batch, length, width = token_features.shape
    drive = torch.tanh(
        model.deliberation_input(
            torch.cat((token_features, world_features, plastic_features), dim=-1)
        )
    ).reshape(batch * length, width)
    hidden = torch.zeros_like(drive)
    cumulative_thought = torch.zeros_like(drive)
    remaining = torch.ones(drive.size(0), device=drive.device, dtype=torch.float32)
    weighted_thought = torch.zeros_like(drive, dtype=torch.float32)
    expected_steps = torch.zeros_like(remaining)
    hidden_steps: list[torch.Tensor] = []
    halt_steps: list[torch.Tensor] = []
    stop_weights: list[torch.Tensor] = []
    for index in range(model.cfg.deliberation_max_steps):
        residual = drive - cumulative_thought
        proposal = model.deliberation_cell(residual, hidden)
        hidden = hidden + (proposal - hidden) / float(index + 1)
        cumulative_thought = cumulative_thought + (
            hidden - cumulative_thought
        ) / float(index + 1)

        normalized = model.deliberation_norm(cumulative_thought)
        halt = torch.sigmoid(model.deliberation_halt(normalized)).squeeze(-1)
        halt = model.cfg.deliberation_min_halt + (1.0 - model.cfg.deliberation_min_halt) * halt
        weight = remaining if index + 1 == model.cfg.deliberation_max_steps else remaining * halt
        weighted_thought = weighted_thought + weight[:, None] * cumulative_thought.float()
        expected_steps = expected_steps + weight * float(index + 1)
        remaining = (remaining - weight).clamp_min(0.0)
        hidden_steps.append(cumulative_thought.reshape(batch, length, width))
        halt_steps.append(halt.reshape(batch, length))
        stop_weights.append(weight.reshape(batch, length))
    return (
        weighted_thought.reshape(batch, length, width).to(token_features.dtype),
        expected_steps.reshape(batch, length).mean(),
        torch.stack(halt_steps, dim=-1),
        torch.stack(stop_weights, dim=-1),
        torch.stack(hidden_steps, dim=0),
    )


def _logits_for_thought(
    model: ArchieSidepusOrganism,
    mixed: torch.Tensor,
    thought: torch.Tensor,
) -> torch.Tensor:
    if thought.shape != mixed.shape:
        raise ValueError("token-local thought must match mixed features")
    gate = torch.sigmoid(model.thought_gate(torch.cat((mixed, thought), dim=-1)))
    return model.lm_head(model.norm(mixed + gate * thought))


def pursuit_forward(
    model: ArchieSidepusOrganism,
    input_ids: torch.Tensor,
    labels: torch.Tensor | None = None,
    *,
    world_state: torch.Tensor | None = None,
    plastic_state: torch.Tensor | None = None,
) -> dict[str, torch.Tensor]:
    """Match the organism forward while retaining causal per-step deliberation losses."""
    if input_ids.ndim != 2:
        raise ValueError("input_ids must have shape [batch,length]")
    if input_ids.size(1) > model.cfg.max_seq_len:
        raise ValueError("sequence exceeds max_seq_len")
    batch, length = input_ids.shape
    x = model.token_embedding(input_ids)
    for block in model.blocks:
        x = block(x)

    next_plastic_state = None
    plastic_read = torch.zeros_like(x)
    if model.plastic_memory is not None and model.plastic_norm is not None:
        plastic_read, next_plastic_state = model.plastic_memory(model.plastic_norm(x), plastic_state)
        x = x + plastic_read
    elif plastic_state is not None:
        raise ValueError("plastic state supplied to a non-plastic organism")

    state = (
        model.initial_world_state(batch, x.device)
        if world_state is None
        else model._validate_world_state(world_state, batch, x.device)
    )
    state_read = torch.zeros_like(x)
    state_only = torch.zeros(batch, length, model.cfg.vocab_size, dtype=x.dtype, device=x.device)
    route_history: list[torch.Tensor] = []
    read_history: list[torch.Tensor] = []
    for start in range(0, length, model.cfg.event_size):
        end = min(start + model.cfg.event_size, length)
        chunk = x[:, start:end]
        read, read_weights = model.world_state_core.read(chunk, state)
        state_read[:, start:end] = read
        state_only[:, start:end] = model.state_head(model.state_norm(read))
        event = chunk.mean(dim=1)
        state, route = model.world_state_core.update(state, event)
        route_history.append(route)
        read_history.append(read_weights)

    state_mix_gate = torch.sigmoid(model.state_gate(torch.cat((x, state_read), dim=-1)))
    mixed = x + state_mix_gate * state_read
    thought_sequence, ponder_cost, halt_probabilities, halt_weights, hidden_steps = (
        _deliberation_trajectory(
            model,
            mixed,
            state_read,
            plastic_read if next_plastic_state is not None else torch.zeros_like(mixed),
        )
    )
    logits = _logits_for_thought(model, mixed, thought_sequence)
    final_thought = thought_sequence[:, -1]

    result: dict[str, torch.Tensor] = {
        "logits": logits,
        "world_state": state,
        "ponder_cost": ponder_cost,
        "thought": final_thought,
        "thought_sequence": thought_sequence,
        "halt_probabilities": halt_probabilities,
        "halt_weights": halt_weights,
        "deliberation_hidden_steps": hidden_steps,
    }
    if next_plastic_state is not None:
        result["plastic_state"] = next_plastic_state

    if labels is not None:
        targets = labels[:, 1:].contiguous()
        lm_loss = F.cross_entropy(
            logits[:, :-1].contiguous().float().view(-1, logits.size(-1)),
            targets.view(-1),
            ignore_index=PAD_ID,
        )
        state_losses = F.cross_entropy(
            state_only[:, :-1].contiguous().float().view(-1, state_only.size(-1)),
            targets.view(-1),
            ignore_index=PAD_ID,
            reduction="none",
        ).view_as(targets)
        positions = torch.arange(length - 1, device=x.device)[None]
        mask = targets.ne(PAD_ID) & positions.ge(model.cfg.event_size)
        state_loss = (
            state_losses.masked_select(mask).mean() if bool(mask.any()) else logits.new_zeros(())
        )
        step_losses: list[torch.Tensor] = []
        token_step_losses: list[torch.Tensor] = []
        valid_targets = targets.ne(PAD_ID)
        for hidden in hidden_steps:
            step_logits = _logits_for_thought(model, mixed, hidden)
            token_loss = F.cross_entropy(
                step_logits[:, :-1].contiguous().float().view(-1, step_logits.size(-1)),
                targets.view(-1),
                ignore_index=PAD_ID,
                reduction="none",
            ).view_as(targets)
            token_step_losses.append(token_loss)
            step_losses.append(
                token_loss.masked_select(valid_targets).mean()
                if bool(valid_targets.any()) else logits.new_zeros(())
            )
        result.update(
            loss=(
                lm_loss
                + model.cfg.state_aux_weight * state_loss
                + model.cfg.deliberation_ponder_weight * ponder_cost
            ),
            lm_loss=lm_loss,
            state_loss=state_loss,
            deliberation_step_losses=torch.stack(step_losses),
            deliberation_token_losses=torch.stack(token_step_losses),
        )

    pooled = state.mean(dim=1).to(mixed.dtype) + final_thought
    if model.action_head is not None and model.value_head is not None and model.stop_head is not None:
        result["action_logits"] = model.action_head(pooled)
        result["value"] = model.value_head(pooled).squeeze(-1)
        result["stop"] = model.stop_head(pooled).squeeze(-1)

    routes = torch.stack(route_history, dim=1)
    result.update(
        state_routes=routes,
        state_reads=torch.cat(read_history, dim=1),
        state_gate_mean=state_mix_gate.float().mean(),
        thought_gate_mean=torch.sigmoid(
            model.thought_gate(torch.cat((mixed, thought_sequence), dim=-1))
        ).float().mean(),
        state_l2=state.float().norm(dim=-1).mean(),
        plastic_l2=(
            next_plastic_state.float().norm(dim=(-2, -1)).mean()
            if next_plastic_state is not None else logits.new_zeros(())
        ),
        active_slot_fraction=routes.gt(0).float().mean(),
        expected_deliberation_steps=ponder_cost,
    )
    return result
