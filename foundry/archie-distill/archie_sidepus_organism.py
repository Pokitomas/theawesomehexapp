#!/usr/bin/env python3
"""Integrated Archie organism with predictive persistent state and iterative retrieval.

The language shell supplies causal token features. Persistent slots are not trained to copy
those features blindly: before every event write they predict the event, and the residual
between prediction and observation controls what is stored. Deliberation is a causal
query-refine-query loop over the exact state snapshot available at each token position.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, fields
from typing import Any, Iterable

import torch
import torch.nn as nn
import torch.nn.functional as F

from archie_hybrid_core import (
    BOS_ID, EOS_ID, PAD_ID, SEP_ID, VOCAB_SIZE, ByteTokenizer, HybridBlock,
    ModelConfig, PlasticFastWeightMemory, RMSNorm,
)
from archie_world_state_core import (
    STATE_SCHEMA, SparseWorldState, WorldStateConfig, fake_quantize_state,
)

METHOD = "archie-sidepus-integrated-organism/v3-predictive-workspace"
MODEL_SCHEMA = "archie-sidepus-organism-model/v1"
ORGANISM_STATE_SCHEMA = "archie-sidepus-organism-state/v1"


@dataclass(frozen=True)
class OrganismConfig(WorldStateConfig):
    deliberation_max_steps: int = 4
    deliberation_ponder_weight: float = 0.002
    deliberation_min_halt: float = 0.05
    state_prediction_weight: float = 0.10
    state_surprise_floor: float = 0.10
    state_surprise_temperature: float = 8.0

    def validate(self) -> None:
        super().validate()
        if self.plastic_mode not in {"none", "delta"}:
            raise ValueError("plastic_mode must be none or delta")
        if self.deliberation_max_steps < 1:
            raise ValueError("deliberation_max_steps must be positive")
        if self.deliberation_ponder_weight < 0 or self.state_prediction_weight < 0:
            raise ValueError("loss weights must be non-negative")
        if not 0.0 <= self.deliberation_min_halt < 1.0:
            raise ValueError("deliberation_min_halt must be in [0, 1)")
        if self.state_surprise_floor < 0 or self.state_surprise_temperature <= 0:
            raise ValueError("surprise controls are invalid")


LANGUAGE_FIELDS = tuple(field.name for field in fields(ModelConfig) if not field.name.startswith("plastic_"))
ORGAN_PREFIXES = (
    "plastic_norm.", "plastic_memory.", "world_state_core.", "state_gate.",
    "state_norm.", "state_head.", "state_predictor.", "state_write_", "workspace_",
    "deliberation_", "thought_gate.", "action_head.", "value_head.", "stop_head.",
)


class ArchieSidepusOrganism(nn.Module):
    """Language shell plus fast plasticity, predictive slots, and iterative workspace."""

    def __init__(self, cfg: OrganismConfig) -> None:
        super().__init__()
        cfg.validate(); self.cfg = cfg
        self.token_embedding = nn.Embedding(cfg.vocab_size, cfg.d_model)
        self.blocks = nn.ModuleList(HybridBlock(cfg, index) for index in range(cfg.n_layers))
        if cfg.plastic_mode == "delta":
            self.plastic_norm: nn.Module | None = RMSNorm(cfg.d_model)
            self.plastic_memory: PlasticFastWeightMemory | None = PlasticFastWeightMemory(cfg)
        else:
            self.plastic_norm = self.plastic_memory = None

        self.world_state_core = SparseWorldState(cfg)
        self.state_gate = nn.Linear(cfg.d_model * 2, cfg.d_model)
        self.state_norm = RMSNorm(cfg.d_model)
        self.state_head = nn.Linear(cfg.d_model, cfg.vocab_size, bias=False)
        self.state_predictor = nn.Linear(cfg.d_model, cfg.d_model, bias=False)
        self.state_write_norm = RMSNorm(cfg.d_model)
        self.state_write_fuse = nn.Linear(cfg.d_model * 3, cfg.d_model)

        self.workspace_query = nn.Linear(cfg.d_model * 2, cfg.d_model, bias=False)
        self.workspace_fuse = nn.Linear(cfg.d_model * 3, cfg.d_model)
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
            if getattr(module, "bias", None) is not None: nn.init.zeros_(module.bias)

    def initial_world_state(self, batch: int, device: torch.device) -> torch.Tensor:
        return self.world_state_core.initial_state(batch, device)

    def language_shell_parameters(self) -> Iterable[nn.Parameter]:
        for name, parameter in self.named_parameters():
            if not name.startswith(ORGAN_PREFIXES): yield parameter

    def organism_parameters(self) -> Iterable[nn.Parameter]:
        for name, parameter in self.named_parameters():
            if name.startswith(ORGAN_PREFIXES): yield parameter

    def set_language_shell_trainable(self, trainable: bool) -> None:
        for parameter in self.language_shell_parameters(): parameter.requires_grad_(trainable)

    def _validate_world_state(self, state: torch.Tensor, batch: int, device: torch.device) -> torch.Tensor:
        expected = (batch, self.cfg.state_slots, self.cfg.d_model)
        if tuple(state.shape) != expected:
            raise ValueError(f"world state shape {tuple(state.shape)} does not match {expected}")
        return fake_quantize_state(state.to(device=device, dtype=torch.float32), self.cfg.state_quant_bits)

    def _predictive_state_pass(
        self, x: torch.Tensor, state: torch.Tensor,
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        """Read before write; write only a learned encoding of prediction residual."""
        batch, length, width = x.shape
        state_read = torch.zeros_like(x)
        state_only = torch.zeros(batch, length, self.cfg.vocab_size, dtype=x.dtype, device=x.device)
        snapshots = torch.zeros(batch, length, self.cfg.state_slots, width, dtype=torch.float32, device=x.device)
        route_history: list[torch.Tensor] = []
        read_history: list[torch.Tensor] = []
        prediction_losses: list[torch.Tensor] = []
        surprise_values: list[torch.Tensor] = []
        for start in range(0, length, self.cfg.event_size):
            end = min(start + self.cfg.event_size, length)
            chunk = x[:, start:end]
            snapshots[:, start:end] = state[:, None]
            read, read_weights = self.world_state_core.read(chunk, state)
            state_read[:, start:end] = read
            state_only[:, start:end] = self.state_head(self.state_norm(read))
            event = chunk.mean(dim=1)
            context = read.mean(dim=1)
            prediction = self.state_predictor(context)
            residual = self.state_write_norm(event - prediction)
            prediction_losses.append(F.mse_loss(prediction.float(), event.detach().float()))
            surprise = residual.float().pow(2).mean(dim=-1, keepdim=True).sqrt()
            surprise_values.append(surprise.mean())
            write_strength = torch.sigmoid(
                (surprise - self.cfg.state_surprise_floor) * self.cfg.state_surprise_temperature
            )
            write_event = torch.tanh(self.state_write_fuse(torch.cat((event, prediction, residual), dim=-1)))
            write_event = prediction + write_strength.to(write_event.dtype) * (write_event - prediction)
            state, route = self.world_state_core.update(state, write_event)
            route_history.append(route); read_history.append(read_weights)
        return (
            state, state_read, state_only, snapshots,
            torch.stack(route_history, dim=1),
            torch.stack(prediction_losses).mean() if prediction_losses else x.new_zeros(()),
        ) + (torch.stack(surprise_values).mean() if surprise_values else x.new_zeros(()), torch.cat(read_history, dim=1))

    def _deliberation_trajectory(
        self, token_features: torch.Tensor, state_snapshots: torch.Tensor,
        plastic_features: torch.Tensor,
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        """Each depth issues a fresh thought-conditioned query to the causal slot snapshot."""
        if token_features.ndim != 3 or state_snapshots.ndim != 4:
            raise ValueError("workspace inputs have invalid rank")
        batch, length, width = token_features.shape
        if state_snapshots.shape[:2] != (batch, length) or state_snapshots.size(-1) != width:
            raise ValueError("workspace state snapshots do not align with tokens")
        hidden = torch.zeros(batch, length, width, device=token_features.device, dtype=token_features.dtype)
        cumulative = torch.zeros_like(hidden)
        remaining = torch.ones(batch, length, device=token_features.device, dtype=torch.float32)
        weighted = torch.zeros_like(hidden, dtype=torch.float32)
        expected = torch.zeros_like(remaining)
        hidden_steps: list[torch.Tensor] = []; halt_steps: list[torch.Tensor] = []
        stop_steps: list[torch.Tensor] = []; retrieval_steps: list[torch.Tensor] = []
        keys = F.normalize(state_snapshots.float(), dim=-1)
        for index in range(self.cfg.deliberation_max_steps):
            query = F.normalize(self.workspace_query(torch.cat((token_features, cumulative), dim=-1)).float(), dim=-1)
            scores = torch.einsum("btd,btsd->bts", query, keys) / math.sqrt(width)
            weights = F.softmax(scores, dim=-1)
            retrieved = torch.einsum("bts,btsd->btd", weights, state_snapshots.float())
            retrieved = self.world_state_core.read_output(retrieved.to(token_features.dtype))
            drive = torch.tanh(self.workspace_fuse(torch.cat((token_features, retrieved, plastic_features), dim=-1)))
            proposal = self.deliberation_cell(
                (drive - cumulative).reshape(batch * length, width), hidden.reshape(batch * length, width)
            ).reshape(batch, length, width)
            hidden = hidden + (proposal - hidden) / float(index + 1)
            cumulative = cumulative + (hidden - cumulative) / float(index + 1)
            halt = torch.sigmoid(self.deliberation_halt(self.deliberation_norm(cumulative))).squeeze(-1)
            halt = self.cfg.deliberation_min_halt + (1.0 - self.cfg.deliberation_min_halt) * halt
            stop = remaining if index + 1 == self.cfg.deliberation_max_steps else remaining * halt
            weighted = weighted + stop[..., None] * cumulative.float()
            expected = expected + stop * float(index + 1)
            remaining = (remaining - stop).clamp_min(0.0)
            hidden_steps.append(cumulative); halt_steps.append(halt); stop_steps.append(stop); retrieval_steps.append(weights)
        return (
            weighted.to(token_features.dtype), expected.mean(), torch.stack(halt_steps, dim=-1),
            torch.stack(stop_steps, dim=-1), torch.stack(hidden_steps, dim=0),
            torch.stack(retrieval_steps, dim=0),
        )

    def _logits_for_thought(self, mixed: torch.Tensor, thought: torch.Tensor) -> torch.Tensor:
        gate = torch.sigmoid(self.thought_gate(torch.cat((mixed, thought), dim=-1)))
        return self.lm_head(self.norm(mixed + gate * thought))

    def forward(
        self, input_ids: torch.Tensor, labels: torch.Tensor | None = None, *,
        world_state: torch.Tensor | None = None, plastic_state: torch.Tensor | None = None,
        return_diagnostics: bool = False,
    ) -> dict[str, torch.Tensor]:
        if input_ids.ndim != 2: raise ValueError("input_ids must have shape [batch,length]")
        if input_ids.size(1) > self.cfg.max_seq_len: raise ValueError("sequence exceeds max_seq_len")
        batch, length = input_ids.shape
        x = self.token_embedding(input_ids)
        for block in self.blocks: x = block(x)
        next_plastic_state = None; plastic_read = torch.zeros_like(x)
        if self.plastic_memory is not None and self.plastic_norm is not None:
            plastic_read, next_plastic_state = self.plastic_memory(self.plastic_norm(x), plastic_state)
            x = x + plastic_read
        elif plastic_state is not None: raise ValueError("plastic state supplied to a non-plastic organism")
        state = self.initial_world_state(batch, x.device) if world_state is None else self._validate_world_state(world_state, batch, x.device)
        state, state_read, state_only, snapshots, routes, prediction_loss, surprise, reads = self._predictive_state_pass(x, state)
        state_mix_gate = torch.sigmoid(self.state_gate(torch.cat((x, state_read), dim=-1)))
        mixed = x + state_mix_gate * state_read
        thought, ponder, halt_probs, halt_weights, hidden_steps, retrieval_steps = self._deliberation_trajectory(
            mixed, snapshots, plastic_read if next_plastic_state is not None else torch.zeros_like(mixed)
        )
        logits = self._logits_for_thought(mixed, thought)
        result: dict[str, torch.Tensor] = {
            "logits": logits, "world_state": state, "ponder_cost": ponder,
            "thought": thought[:, -1], "thought_sequence": thought,
            "halt_probabilities": halt_probs, "halt_weights": halt_weights,
            "deliberation_hidden_steps": hidden_steps,
            "workspace_retrieval_weights": retrieval_steps,
            "state_prediction_loss": prediction_loss, "state_surprise": surprise,
        }
        if next_plastic_state is not None: result["plastic_state"] = next_plastic_state
        if labels is not None:
            targets = labels[:, 1:].contiguous(); valid = targets.ne(PAD_ID)
            lm_loss = F.cross_entropy(logits[:, :-1].contiguous().float().view(-1, logits.size(-1)), targets.view(-1), ignore_index=PAD_ID)
            state_token_loss = F.cross_entropy(state_only[:, :-1].contiguous().float().view(-1, state_only.size(-1)), targets.view(-1), ignore_index=PAD_ID, reduction="none").view_as(targets)
            positions = torch.arange(length - 1, device=x.device)[None]
            mask = valid & positions.ge(self.cfg.event_size)
            state_loss = state_token_loss.masked_select(mask).mean() if bool(mask.any()) else logits.new_zeros(())
            token_step_losses: list[torch.Tensor] = []; step_losses: list[torch.Tensor] = []
            for hidden_step in hidden_steps:
                step_logits = self._logits_for_thought(mixed, hidden_step)
                token_loss = F.cross_entropy(step_logits[:, :-1].contiguous().float().view(-1, step_logits.size(-1)), targets.view(-1), ignore_index=PAD_ID, reduction="none").view_as(targets)
                token_step_losses.append(token_loss)
                step_losses.append(token_loss.masked_select(valid).mean() if bool(valid.any()) else logits.new_zeros(()))
            result.update(
                loss=lm_loss + self.cfg.state_aux_weight * state_loss + self.cfg.state_prediction_weight * prediction_loss + self.cfg.deliberation_ponder_weight * ponder,
                lm_loss=lm_loss, state_loss=state_loss,
                deliberation_step_losses=torch.stack(step_losses),
                deliberation_token_losses=torch.stack(token_step_losses),
            )
        pooled = state.mean(dim=1).to(mixed.dtype) + thought[:, -1]
        if self.action_head is not None and self.value_head is not None and self.stop_head is not None:
            result["action_logits"] = self.action_head(pooled); result["value"] = self.value_head(pooled).squeeze(-1); result["stop"] = self.stop_head(pooled).squeeze(-1)
        thought_gate = torch.sigmoid(self.thought_gate(torch.cat((mixed, thought), dim=-1)))
        result.update(
            state_routes=routes, state_reads=reads,
            state_gate_mean=state_mix_gate.float().mean(), thought_gate_mean=thought_gate.float().mean(),
            state_l2=state.float().norm(dim=-1).mean(),
            plastic_l2=next_plastic_state.float().norm(dim=(-2, -1)).mean() if next_plastic_state is not None else logits.new_zeros(()),
            active_slot_fraction=routes.gt(0).float().mean(), expected_deliberation_steps=ponder,
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
    if not isinstance(source, dict): raise ValueError("source model state is missing")
    target = model.state_dict(); copied: list[str] = []; missing: list[str] = []
    for name, tensor in target.items():
        if name.startswith(ORGAN_PREFIXES): continue
        candidate = source.get(name)
        if not isinstance(candidate, torch.Tensor) or tuple(candidate.shape) != tuple(tensor.shape):
            missing.append(name); continue
        target[name] = candidate.detach().to(dtype=tensor.dtype, device=tensor.device); copied.append(name)
    if missing: raise ValueError("source language shell is incomplete: " + ", ".join(missing[:8]))
    model.load_state_dict(target)
    return {"mode": "language-shell-to-predictive-workspace", "copied_tensors": len(copied)}


def parameter_count(model: nn.Module) -> int:
    return sum(parameter.numel() for parameter in model.parameters())


__all__ = [
    "BOS_ID", "ByteTokenizer", "EOS_ID", "METHOD", "MODEL_SCHEMA", "ORGANISM_STATE_SCHEMA",
    "PAD_ID", "SEP_ID", "STATE_SCHEMA", "VOCAB_SIZE", "ArchieSidepusOrganism", "OrganismConfig",
    "language_config_matches", "load_language_shell", "parameter_count",
]
