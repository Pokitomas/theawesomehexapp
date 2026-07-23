#!/usr/bin/env python3
"""Integrated Archie organism: language shell, plastic fast weights, persistent world state,
and differentiable adaptive deliberation.

This module is an executable research candidate. The mechanisms are jointly available;
no capability claim follows until matched controls and frozen evaluations pass.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, fields
from typing import Any, Iterable

import torch
import torch.nn as nn
import torch.nn.functional as F

from archie_hybrid_core import (
    BOS_ID,
    EOS_ID,
    PAD_ID,
    SEP_ID,
    VOCAB_SIZE,
    ByteTokenizer,
    HybridBlock,
    ModelConfig,
    PlasticFastWeightMemory,
    RMSNorm,
)
from archie_world_state_core import (
    STATE_SCHEMA,
    SparseWorldState,
    WorldStateConfig,
    fake_quantize_state,
)

METHOD = "archie-sidepus-integrated-organism/v2-causal-deliberation"
MODEL_SCHEMA = "archie-sidepus-organism-model/v1"
ORGANISM_STATE_SCHEMA = "archie-sidepus-organism-state/v1"


@dataclass(frozen=True)
class OrganismConfig(WorldStateConfig):
    deliberation_max_steps: int = 4
    deliberation_ponder_weight: float = 0.002
    deliberation_min_halt: float = 0.05

    def validate(self) -> None:
        super().validate()
        if self.plastic_mode not in {"none", "delta"}:
            raise ValueError("plastic_mode must be none or delta")
        if self.deliberation_max_steps < 1:
            raise ValueError("deliberation_max_steps must be positive")
        if self.deliberation_ponder_weight < 0:
            raise ValueError("deliberation_ponder_weight must be non-negative")
        if not 0.0 <= self.deliberation_min_halt < 1.0:
            raise ValueError("deliberation_min_halt must be in [0, 1)")


LANGUAGE_FIELDS = tuple(field.name for field in fields(ModelConfig) if not field.name.startswith("plastic_"))
ORGAN_PREFIXES = (
    "plastic_norm.",
    "plastic_memory.",
    "world_state_core.",
    "state_gate.",
    "state_norm.",
    "state_head.",
    "deliberation_",
    "thought_gate.",
    "action_head.",
    "value_head.",
    "stop_head.",
)


class ArchieSidepusOrganism(nn.Module):
    """One model exposing three state timescales plus causal adaptive computation."""

    def __init__(self, cfg: OrganismConfig) -> None:
        super().__init__()
        cfg.validate()
        self.cfg = cfg
        self.token_embedding = nn.Embedding(cfg.vocab_size, cfg.d_model)
        self.blocks = nn.ModuleList(HybridBlock(cfg, index) for index in range(cfg.n_layers))

        if cfg.plastic_mode == "delta":
            self.plastic_norm: nn.Module | None = RMSNorm(cfg.d_model)
            self.plastic_memory: PlasticFastWeightMemory | None = PlasticFastWeightMemory(cfg)
        else:
            self.plastic_norm = None
            self.plastic_memory = None

        self.world_state_core = SparseWorldState(cfg)
        self.state_gate = nn.Linear(cfg.d_model * 2, cfg.d_model)
        self.state_norm = RMSNorm(cfg.d_model)
        self.state_head = nn.Linear(cfg.d_model, cfg.vocab_size, bias=False)

        self.deliberation_input = nn.Linear(cfg.d_model * 3, cfg.d_model)
        self.deliberation_cell = nn.GRUCell(cfg.d_model, cfg.d_model)
        self.deliberation_norm = RMSNorm(cfg.d_model)
        self.deliberation_halt = nn.Linear(cfg.d_model, 1)
        self.thought_gate = nn.Linear(cfg.d_model * 2, cfg.d_model)

        self.norm = RMSNorm(cfg.d_model)
        self.lm_head = nn.Linear(cfg.d_model, cfg.vocab_size, bias=False)
        self.lm_head.weight = self.token_embedding.weight

        if cfg.action_count:
            self.action_head: nn.Module | None = nn.Linear(cfg.d_model, cfg.action_count)
            self.value_head: nn.Module | None = nn.Linear(cfg.d_model, 1)
            self.stop_head: nn.Module | None = nn.Linear(cfg.d_model, 1)
        else:
            self.action_head = self.value_head = self.stop_head = None
        self.apply(self._init_weights)

    @staticmethod
    def _init_weights(module: nn.Module) -> None:
        if isinstance(module, (nn.Linear, nn.Embedding)):
            nn.init.normal_(module.weight, mean=0.0, std=0.02)
            if getattr(module, "bias", None) is not None:
                nn.init.zeros_(module.bias)

    def initial_world_state(self, batch: int, device: torch.device) -> torch.Tensor:
        return self.world_state_core.initial_state(batch, device)

    def language_shell_parameters(self) -> Iterable[nn.Parameter]:
        for name, parameter in self.named_parameters():
            if not name.startswith(ORGAN_PREFIXES):
                yield parameter

    def organism_parameters(self) -> Iterable[nn.Parameter]:
        for name, parameter in self.named_parameters():
            if name.startswith(ORGAN_PREFIXES):
                yield parameter

    def set_language_shell_trainable(self, trainable: bool) -> None:
        for parameter in self.language_shell_parameters():
            parameter.requires_grad_(trainable)

    def _validate_world_state(
        self, state: torch.Tensor, batch: int, device: torch.device
    ) -> torch.Tensor:
        expected = (batch, self.cfg.state_slots, self.cfg.d_model)
        if tuple(state.shape) != expected:
            raise ValueError(f"world state shape {tuple(state.shape)} does not match {expected}")
        return fake_quantize_state(
            state.to(device=device, dtype=torch.float32), self.cfg.state_quant_bits
        )

    def _deliberate(
        self,
        token_features: torch.Tensor,
        world_features: torch.Tensor,
        plastic_features: torch.Tensor,
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        """Refine one thought per causal token position.

        Every input tensor is [batch, length, width] and is already prefix-causal.
        Flattening batch and position lets the depth recurrence remain vectorized without
        allowing any position to summarize or receive information from a later token.
        """
        if not (
            token_features.shape == world_features.shape == plastic_features.shape
            and token_features.ndim == 3
        ):
            raise ValueError("deliberation features must share [batch,length,width]")
        batch, length, width = token_features.shape
        drive = torch.tanh(
            self.deliberation_input(
                torch.cat((token_features, world_features, plastic_features), dim=-1)
            )
        ).reshape(batch * length, width)
        hidden = torch.zeros_like(drive)
        cumulative_thought = torch.zeros_like(drive)
        remaining = torch.ones(drive.size(0), device=drive.device, dtype=torch.float32)
        thought = torch.zeros_like(drive, dtype=torch.float32)
        expected_steps = torch.zeros_like(remaining)
        halt_history: list[torch.Tensor] = []
        for index in range(self.cfg.deliberation_max_steps):
            residual = drive - cumulative_thought
            proposal = self.deliberation_cell(residual, hidden)
            hidden = hidden + (proposal - hidden) / float(index + 1)
            cumulative_thought = cumulative_thought + (
                hidden - cumulative_thought
            ) / float(index + 1)

            halt = torch.sigmoid(
                self.deliberation_halt(self.deliberation_norm(cumulative_thought))
            ).squeeze(-1)
            halt = self.cfg.deliberation_min_halt + (
                1.0 - self.cfg.deliberation_min_halt
            ) * halt
            if index + 1 == self.cfg.deliberation_max_steps:
                weight = remaining
            else:
                weight = remaining * halt
            thought = thought + weight[:, None] * cumulative_thought.float()
            expected_steps = expected_steps + weight * float(index + 1)
            remaining = (remaining - weight).clamp_min(0.0)
            halt_history.append(halt.reshape(batch, length))
        return (
            thought.reshape(batch, length, width).to(token_features.dtype),
            expected_steps.reshape(batch, length).mean(),
            torch.stack(halt_history, dim=-1),
        )

    def forward(
        self,
        input_ids: torch.Tensor,
        labels: torch.Tensor | None = None,
        *,
        world_state: torch.Tensor | None = None,
        plastic_state: torch.Tensor | None = None,
        return_diagnostics: bool = False,
    ) -> dict[str, torch.Tensor]:
        if input_ids.ndim != 2:
            raise ValueError("input_ids must have shape [batch,length]")
        if input_ids.size(1) > self.cfg.max_seq_len:
            raise ValueError("sequence exceeds max_seq_len")
        batch, length = input_ids.shape
        x = self.token_embedding(input_ids)
        for block in self.blocks:
            x = block(x)

        next_plastic_state = None
        plastic_read = torch.zeros_like(x)
        if self.plastic_memory is not None and self.plastic_norm is not None:
            plastic_read, next_plastic_state = self.plastic_memory(
                self.plastic_norm(x), plastic_state
            )
            x = x + plastic_read
        elif plastic_state is not None:
            raise ValueError("plastic state supplied to a non-plastic organism")

        state = (
            self.initial_world_state(batch, x.device)
            if world_state is None
            else self._validate_world_state(world_state, batch, x.device)
        )
        state_read = torch.zeros_like(x)
        state_only = torch.zeros(
            batch, length, self.cfg.vocab_size, dtype=x.dtype, device=x.device
        )
        route_history: list[torch.Tensor] = []
        read_history: list[torch.Tensor] = []
        for start in range(0, length, self.cfg.event_size):
            end = min(start + self.cfg.event_size, length)
            chunk = x[:, start:end]
            read, read_weights = self.world_state_core.read(chunk, state)
            state_read[:, start:end] = read
            state_only[:, start:end] = self.state_head(self.state_norm(read))
            event = chunk.mean(dim=1)
            state, route = self.world_state_core.update(state, event)
            route_history.append(route)
            read_history.append(read_weights)

        state_mix_gate = torch.sigmoid(self.state_gate(torch.cat((x, state_read), dim=-1)))
        mixed = x + state_mix_gate * state_read
        thought_sequence, ponder_cost, halt_history = self._deliberate(
            mixed,
            state_read,
            plastic_read if next_plastic_state is not None else torch.zeros_like(mixed),
        )
        thought_gate = torch.sigmoid(
            self.thought_gate(torch.cat((mixed, thought_sequence), dim=-1))
        )
        logits = self.lm_head(self.norm(mixed + thought_gate * thought_sequence))
        final_thought = thought_sequence[:, -1]

        result: dict[str, torch.Tensor] = {
            "logits": logits,
            "world_state": state,
            "ponder_cost": ponder_cost,
            "thought": final_thought,
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
            mask = targets.ne(PAD_ID) & positions.ge(self.cfg.event_size)
            state_loss = (
                state_losses.masked_select(mask).mean()
                if bool(mask.any())
                else logits.new_zeros(())
            )
            result.update(
                loss=(
                    lm_loss
                    + self.cfg.state_aux_weight * state_loss
                    + self.cfg.deliberation_ponder_weight * ponder_cost
                ),
                lm_loss=lm_loss,
                state_loss=state_loss,
            )

        pooled = state.mean(dim=1).to(mixed.dtype) + final_thought
        if self.action_head is not None and self.value_head is not None and self.stop_head is not None:
            result["action_logits"] = self.action_head(pooled)
            result["value"] = self.value_head(pooled).squeeze(-1)
            result["stop"] = self.stop_head(pooled).squeeze(-1)

        if return_diagnostics:
            routes = torch.stack(route_history, dim=1)
            result.update(
                state_routes=routes,
                state_reads=torch.cat(read_history, dim=1),
                state_gate_mean=state_mix_gate.float().mean(),
                thought_gate_mean=thought_gate.float().mean(),
                state_l2=state.float().norm(dim=-1).mean(),
                plastic_l2=(
                    next_plastic_state.float().norm(dim=(-2, -1)).mean()
                    if next_plastic_state is not None
                    else logits.new_zeros(())
                ),
                active_slot_fraction=routes.gt(0).float().mean(),
                halt_probabilities=halt_history,
                expected_deliberation_steps=ponder_cost,
                thought_sequence=thought_sequence,
            )
        return result


def language_config_matches(source: dict[str, Any], target: OrganismConfig) -> bool:
    target_values = asdict(target)
    return all(source.get(name) == target_values[name] for name in LANGUAGE_FIELDS)


def load_language_shell(model: ArchieSidepusOrganism, payload: dict[str, Any]) -> dict[str, Any]:
    source_config = payload.get("config", payload.get("model_config", {}))
    if not isinstance(source_config, dict) or not language_config_matches(source_config, model.cfg):
        raise ValueError("source language configuration does not match organism shell")
    source = payload.get("model")
    if not isinstance(source, dict):
        raise ValueError("source model state is missing")
    target = model.state_dict()
    copied: list[str] = []
    missing: list[str] = []
    for name, tensor in target.items():
        if name.startswith(ORGAN_PREFIXES):
            continue
        candidate = source.get(name)
        if not isinstance(candidate, torch.Tensor) or tuple(candidate.shape) != tuple(tensor.shape):
            missing.append(name)
            continue
        target[name] = candidate.detach().to(dtype=tensor.dtype, device=tensor.device)
        copied.append(name)
    if missing:
        raise ValueError("source language shell is incomplete: " + ", ".join(missing[:8]))
    model.load_state_dict(target)
    return {"mode": "language-shell-to-integrated-organism", "copied_tensors": len(copied)}


def parameter_count(model: nn.Module) -> int:
    return sum(parameter.numel() for parameter in model.parameters())


__all__ = [
    "BOS_ID",
    "ByteTokenizer",
    "EOS_ID",
    "METHOD",
    "MODEL_SCHEMA",
    "ORGANISM_STATE_SCHEMA",
    "PAD_ID",
    "SEP_ID",
    "STATE_SCHEMA",
    "VOCAB_SIZE",
    "ArchieSidepusOrganism",
    "OrganismConfig",
    "language_config_matches",
    "load_language_shell",
    "parameter_count",
]
