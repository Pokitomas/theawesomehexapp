#!/usr/bin/env python3
"""Training forward pass exposing the marginal value of each deliberation step."""
from __future__ import annotations

from collections.abc import Mapping

import torch
import torch.nn.functional as F

from archie_hybrid_core import PAD_ID
from archie_sidepus_organism import ArchieSidepusOrganism


def _deliberation_trajectory(
    model: ArchieSidepusOrganism,
    token_summary: torch.Tensor,
    world_summary: torch.Tensor,
    plastic_summary: torch.Tensor,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
    drive = torch.tanh(
        model.deliberation_input(torch.cat((token_summary, world_summary, plastic_summary), dim=-1))
    )
    hidden = torch.zeros_like(drive)
    cumulative_thought = torch.zeros_like(drive)
    remaining = torch.ones(hidden.size(0), device=hidden.device, dtype=torch.float32)
    weighted_thought = torch.zeros_like(hidden, dtype=torch.float32)
    expected_steps = torch.zeros_like(remaining)
    hidden_steps: list[torch.Tensor] = []
    halt_steps: list[torch.Tensor] = []
    stop_weights: list[torch.Tensor] = []
    for index in range(model.cfg.deliberation_max_steps):
        # Each recurrent step receives the unresolved residual rather than the
        # identical drive. The exposed thought is the running mean of refinements,
        # so later computation must improve an accumulated answer instead of
        # replacing the first useful thought with an unrelated recurrent state.
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
        hidden_steps.append(cumulative_thought)
        halt_steps.append(halt)
        stop_weights.append(weight)
    return (
        weighted_thought.to(token_summary.dtype),
        expected_steps.mean(),
        torch.stack(halt_steps, dim=1),
        torch.stack(stop_weights, dim=1),
        torch.stack(hidden_steps, dim=0),
    )


def _logits_for_thought(
    model: ArchieSidepusOrganism,
    mixed: torch.Tensor,
    thought: torch.Tensor,
) -> torch.Tensor:
    expanded = thought[:, None, :].expand(-1, mixed.size(1), -1)
    gate = torch.sigmoid(model.thought_gate(torch.cat((mixed, expanded), dim=-1)))
    return model.lm_head(model.norm(mixed + gate * expanded))


def pursuit_forward(
    model: ArchieSidepusOrganism,
    input_ids: torch.Tensor,
    labels: torch.Tensor | None = None,
    *,
    world_state: torch.Tensor | None = None,
    plastic_state: torch.Tensor | None = None,
) -> dict[str, torch.Tensor]:
    """Match the organism forward while retaining per-step deliberation losses."""
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
    token_summary = mixed.mean(dim=1)
    world_summary = state.mean(dim=1).to(mixed.dtype)
    plastic_summary = (
        plastic_read.mean(dim=1) if next_plastic_state is not None else torch.zeros_like(token_summary)
    )
    thought, ponder_cost, halt_probabilities, halt_weights, hidden_steps = _deliberation_trajectory(
        model, token_summary, world_summary, plastic_summary
    )
    logits = _logits_for_thought(model, mixed, thought)

    result: dict[str, torch.Tensor] = {
        "logits": logits,
        "world_state": state,
        "ponder_cost": ponder_cost,
        "thought": thought,
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
        for hidden in hidden_steps:
            step_logits = _logits_for_thought(model, mixed, hidden)
            step_losses.append(F.cross_entropy(
                step_logits[:, :-1].contiguous().float().view(-1, step_logits.size(-1)),
                targets.view(-1),
                ignore_index=PAD_ID,
            ))
        result.update(
            loss=(
                lm_loss
                + model.cfg.state_aux_weight * state_loss
                + model.cfg.deliberation_ponder_weight * ponder_cost
            ),
            lm_loss=lm_loss,
            state_loss=state_loss,
            deliberation_step_losses=torch.stack(step_losses),
        )

    pooled = world_summary + thought
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
            model.thought_gate(
                torch.cat((mixed, thought[:, None, :].expand(-1, length, -1)), dim=-1)
            )
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
