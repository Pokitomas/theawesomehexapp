#!/usr/bin/env python3
"""Warm-startable dual-core Archie: existing language shell plus sparse persistent world state."""
from __future__ import annotations

import math
from collections.abc import Iterable
from dataclasses import asdict, dataclass, fields
from typing import Any

import torch
import torch.nn as nn
import torch.nn.functional as F

from archie_hybrid_core import (
    BOS_ID,
    EOS_ID,
    PAD_ID,
    SEP_ID,
    VOCAB_SIZE,
    ArchieHybridLM,
    ByteTokenizer,
    HybridBlock,
    ModelConfig,
    PRESETS as HYBRID_PRESETS,
    RMSNorm,
)

METHOD = "archie-sparse-world-state-hybrid-language/v1"
MODEL_SCHEMA = "archie-world-state-model/v1"
STATE_SCHEMA = "archie-world-state-artifact/v1"
PLASTIC_CONFIG_FIELDS = {
    "plastic_mode", "plastic_rank", "plastic_retention_floor", "plastic_write_scale",
    "plastic_state_clip", "plastic_detach_every",
}
LANGUAGE_CONFIG_FIELDS = tuple(
    field.name for field in fields(ModelConfig) if field.name not in PLASTIC_CONFIG_FIELDS
)
STATE_PARAMETER_PREFIXES = (
    "world_state_core.", "state_gate.", "state_norm.", "state_head.",
    "action_head.", "value_head.", "stop_head.",
)


@dataclass(frozen=True)
class WorldStateConfig(ModelConfig):
    event_size: int = 16
    state_slots: int = 8
    state_top_k: int = 2
    state_quant_bits: int = 8
    state_aux_weight: float = 0.25
    action_count: int = 0

    def validate(self) -> None:
        if self.d_model % self.n_heads or self.n_heads % self.n_kv_heads:
            raise ValueError("invalid attention dimensions")
        if self.event_size < 1 or self.event_size > self.max_seq_len:
            raise ValueError("event_size must be within model context")
        if self.state_slots < 2:
            raise ValueError("state_slots must be at least two")
        if not 1 <= self.state_top_k <= self.state_slots:
            raise ValueError("state_top_k must be in [1, state_slots]")
        if self.state_quant_bits not in (0, 4, 8):
            raise ValueError("state_quant_bits must be 0, 4, or 8")
        if self.state_aux_weight < 0.0:
            raise ValueError("state_aux_weight must be non-negative")
        if self.action_count < 0:
            raise ValueError("action_count must be non-negative")


def _world_preset(name: str, **updates: Any) -> WorldStateConfig:
    values = asdict(HYBRID_PRESETS[name])
    values.update(updates)
    return WorldStateConfig(**values)


PRESETS: dict[str, WorldStateConfig] = {
    "micro": _world_preset("micro", event_size=8, state_slots=4, state_top_k=1),
    "tiny": _world_preset("tiny", event_size=16, state_slots=8, state_top_k=2),
    "small": WorldStateConfig(),
}


def fake_quantize_state(state: torch.Tensor, bits: int) -> torch.Tensor:
    """Per-slot symmetric fake quantization with a straight-through estimator."""
    if bits == 0:
        return state
    qmax = (1 << (bits - 1)) - 1
    scale = state.detach().abs().amax(dim=-1, keepdim=True).clamp_min(1e-8) / qmax
    quantized = torch.clamp(torch.round(state / scale), -qmax, qmax) * scale
    if state.requires_grad:
        return state + (quantized - state).detach()
    return quantized


def quantize_state_artifact(state: torch.Tensor, bits: int) -> dict[str, Any]:
    if bits not in (4, 8):
        raise ValueError("persistent state artifacts support 4 or 8 bits")
    qmax = (1 << (bits - 1)) - 1
    source = state.detach().float().cpu()
    scale = source.abs().amax(dim=-1, keepdim=True).clamp_min(1e-8) / qmax
    values = torch.clamp(torch.round(source / scale), -qmax, qmax).to(torch.int8)
    return {"schema": STATE_SCHEMA, "bits": bits, "values": values, "scale": scale}


def dequantize_state_artifact(payload: dict[str, Any], device: torch.device | str = "cpu") -> torch.Tensor:
    if payload.get("schema") != STATE_SCHEMA or payload.get("bits") not in (4, 8):
        raise ValueError("unsupported world-state artifact")
    values, scale = payload.get("values"), payload.get("scale")
    if not isinstance(values, torch.Tensor) or values.dtype != torch.int8:
        raise ValueError("world-state values must use int8 storage")
    if not isinstance(scale, torch.Tensor) or scale.ndim != values.ndim:
        raise ValueError("world-state scale shape is invalid")
    return (values.float() * scale.float()).to(device)


class SparseWorldState(nn.Module):
    """Finite event-driven slots with sparse writes and dense content reads."""
    def __init__(self, cfg: WorldStateConfig) -> None:
        super().__init__()
        self.width = cfg.d_model
        self.slots = cfg.state_slots
        self.top_k = cfg.state_top_k
        self.quant_bits = cfg.state_quant_bits
        self.event_norm = RMSNorm(cfg.d_model)
        self.event_query = nn.Linear(cfg.d_model, cfg.d_model, bias=False)
        self.slot_keys = nn.Parameter(torch.empty(cfg.state_slots, cfg.d_model))
        self.update_gate = nn.Linear(cfg.d_model * 2, cfg.d_model)
        self.candidate = nn.Linear(cfg.d_model * 2, cfg.d_model)
        self.read_query = nn.Linear(cfg.d_model, cfg.d_model, bias=False)
        self.read_output = nn.Linear(cfg.d_model, cfg.d_model, bias=False)
        nn.init.normal_(self.slot_keys, mean=0.0, std=0.02)

    def initial_state(self, batch: int, device: torch.device) -> torch.Tensor:
        return torch.zeros(batch, self.slots, self.width, dtype=torch.float32, device=device)

    def update(self, state: torch.Tensor, event: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        event = self.event_norm(event)
        query = F.normalize(self.event_query(event).float(), dim=-1)
        keys = F.normalize(self.slot_keys.float(), dim=-1)
        route_logits = torch.einsum("bd,sd->bs", query, keys) / math.sqrt(self.width)
        _, indices = torch.topk(route_logits, self.top_k, dim=-1)
        mask = torch.zeros_like(route_logits, dtype=torch.bool).scatter_(1, indices, True)
        weights = F.softmax(route_logits.masked_fill(~mask, -torch.inf), dim=-1)
        expanded = event.float()[:, None].expand(-1, self.slots, -1)
        combined = torch.cat((state.float(), expanded), dim=-1)
        gate = torch.sigmoid(self.update_gate(combined))
        candidate = torch.tanh(self.candidate(combined))
        next_state = state.float() + weights[..., None] * gate * (candidate - state.float())
        return fake_quantize_state(next_state, self.quant_bits), weights

    def read(self, tokens: torch.Tensor, state: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        query = F.normalize(self.read_query(tokens).float(), dim=-1)
        keys = F.normalize(state.float(), dim=-1)
        scores = torch.einsum("btd,bsd->bts", query, keys) / math.sqrt(self.width)
        weights = F.softmax(scores, dim=-1)
        read = torch.einsum("bts,bsd->btd", weights, state.float())
        return self.read_output(read.to(tokens.dtype)), weights


class ArchieWorldStateLM(nn.Module):
    def __init__(self, cfg: WorldStateConfig) -> None:
        super().__init__()
        cfg.validate()
        self.cfg = cfg
        self.token_embedding = nn.Embedding(cfg.vocab_size, cfg.d_model)
        self.blocks = nn.ModuleList(HybridBlock(cfg, index) for index in range(cfg.n_layers))
        self.world_state_core = SparseWorldState(cfg)
        self.state_gate = nn.Linear(cfg.d_model * 2, cfg.d_model)
        self.state_norm = RMSNorm(cfg.d_model)
        self.state_head = nn.Linear(cfg.d_model, cfg.vocab_size, bias=False)
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
            if not name.startswith(STATE_PARAMETER_PREFIXES):
                yield parameter

    def state_parameters(self) -> Iterable[nn.Parameter]:
        for name, parameter in self.named_parameters():
            if name.startswith(STATE_PARAMETER_PREFIXES):
                yield parameter

    def set_language_shell_trainable(self, trainable: bool) -> None:
        for parameter in self.language_shell_parameters():
            parameter.requires_grad_(trainable)

    def _validate_state(self, state: torch.Tensor, batch: int, device: torch.device) -> torch.Tensor:
        expected = (batch, self.cfg.state_slots, self.cfg.d_model)
        if tuple(state.shape) != expected:
            raise ValueError(f"world state shape {tuple(state.shape)} does not match {expected}")
        return fake_quantize_state(state.to(device=device, dtype=torch.float32), self.cfg.state_quant_bits)

    def forward(
        self,
        input_ids: torch.Tensor,
        labels: torch.Tensor | None = None,
        world_state: torch.Tensor | None = None,
        return_diagnostics: bool = False,
    ) -> dict[str, torch.Tensor]:
        if input_ids.ndim != 2:
            raise ValueError("input_ids must have shape [batch, length]")
        if input_ids.size(1) > self.cfg.max_seq_len:
            raise ValueError("sequence exceeds max_seq_len")
        batch, length = input_ids.shape
        x = self.token_embedding(input_ids)
        for block in self.blocks:
            x = block(x)
        state = (
            self.initial_world_state(batch, x.device)
            if world_state is None else self._validate_state(world_state, batch, x.device)
        )
        state_read = torch.zeros_like(x)
        state_only = torch.zeros(batch, length, self.cfg.vocab_size, dtype=x.dtype, device=x.device)
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
        gate = torch.sigmoid(self.state_gate(torch.cat((x, state_read), dim=-1)))
        logits = self.lm_head(self.norm(x + gate * state_read))
        result: dict[str, torch.Tensor] = {"logits": logits, "world_state": state}
        if labels is not None:
            targets = labels[:, 1:].contiguous()
            lm_loss = F.cross_entropy(
                logits[:, :-1].contiguous().float().view(-1, logits.size(-1)),
                targets.view(-1), ignore_index=PAD_ID,
            )
            aux_losses = F.cross_entropy(
                state_only[:, :-1].contiguous().float().view(-1, state_only.size(-1)),
                targets.view(-1), ignore_index=PAD_ID, reduction="none",
            ).view_as(targets)
            positions = torch.arange(length - 1, device=x.device)[None]
            aux_mask = targets.ne(PAD_ID) & positions.ge(self.cfg.event_size)
            state_loss = aux_losses.masked_select(aux_mask).mean() if bool(aux_mask.any()) else logits.new_zeros(())
            result.update(
                loss=lm_loss + self.cfg.state_aux_weight * state_loss,
                lm_loss=lm_loss,
                state_loss=state_loss,
            )
        pooled_state = state.mean(dim=1).to(x.dtype)
        if self.action_head is not None and self.value_head is not None and self.stop_head is not None:
            result["action_logits"] = self.action_head(pooled_state)
            result["value"] = self.value_head(pooled_state).squeeze(-1)
            result["stop"] = self.stop_head(pooled_state).squeeze(-1)
        if return_diagnostics:
            routes = torch.stack(route_history, dim=1)
            result.update(
                state_routes=routes,
                state_reads=torch.cat(read_history, dim=1),
                state_gate_mean=gate.float().mean(),
                state_l2=state.float().norm(dim=-1).mean(),
                active_slot_fraction=routes.gt(0).float().mean(),
            )
        return result

    @torch.no_grad()
    def generate_with_state(
        self,
        prompt: torch.Tensor,
        max_new_tokens: int,
        *,
        world_state: torch.Tensor | None = None,
        temperature: float = 0.8,
        top_k: int = 40,
    ) -> tuple[torch.Tensor, torch.Tensor]:
        self.eval()
        tokens = prompt
        for _ in range(max_new_tokens):
            output = self(tokens[:, -self.cfg.max_seq_len:], world_state=world_state)
            logits = output["logits"][:, -1]
            logits[:, PAD_ID] = -torch.inf
            logits[:, BOS_ID] = -torch.inf
            logits = logits / max(temperature, 1e-5)
            if 0 < top_k < logits.size(-1):
                values, _ = torch.topk(logits, top_k)
                logits = logits.masked_fill(logits < values[:, -1, None], -torch.inf)
            next_token = torch.multinomial(F.softmax(logits, dim=-1), 1)
            tokens = torch.cat((tokens, next_token), dim=1)
            if bool(torch.all(next_token.eq(EOS_ID))):
                break
        final = self(tokens[:, -self.cfg.max_seq_len:], world_state=world_state)
        return tokens, final["world_state"]


def language_config_matches(source: dict[str, Any], target: WorldStateConfig) -> bool:
    target_values = asdict(target)
    return all(source.get(name) == target_values[name] for name in LANGUAGE_CONFIG_FIELDS)


def load_language_shell(model: ArchieWorldStateLM, payload: dict[str, Any]) -> dict[str, Any]:
    """Copy the exact current language shell while leaving every new state tensor untouched."""
    source_config = payload.get("config", payload.get("model_config", {}))
    if not isinstance(source_config, dict) or not language_config_matches(source_config, model.cfg):
        raise ValueError("source language configuration does not match world-state language shell")
    source = payload.get("model")
    if not isinstance(source, dict):
        raise ValueError("source model state is missing")
    target = model.state_dict()
    copied: list[str] = []
    missing: list[str] = []
    for name, tensor in target.items():
        if name.startswith(STATE_PARAMETER_PREFIXES):
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
    return {"mode": "language-shell-warm-start", "copied_tensors": len(copied)}


@torch.no_grad()
def state_dependency_metrics(
    model: ArchieWorldStateLM, input_ids: torch.Tensor, world_state: torch.Tensor
) -> dict[str, float]:
    model.eval()
    adapted = model(input_ids, world_state=world_state)["logits"].float()
    reset = model(input_ids, world_state=torch.zeros_like(world_state))["logits"].float()
    wrong = model(input_ids, world_state=-world_state)["logits"].float()
    adapted_p = F.log_softmax(adapted, dim=-1)
    reset_p = F.log_softmax(reset, dim=-1)
    wrong_p = F.log_softmax(wrong, dim=-1)
    return {
        "adapted_vs_reset_logit_mae": float((adapted - reset).abs().mean().cpu()),
        "adapted_vs_wrong_logit_mae": float((adapted - wrong).abs().mean().cpu()),
        "adapted_vs_reset_kl": float(F.kl_div(reset_p, adapted_p, log_target=True, reduction="batchmean").cpu()),
        "adapted_vs_wrong_kl": float(F.kl_div(wrong_p, adapted_p, log_target=True, reduction="batchmean").cpu()),
    }


def parameter_count(model: nn.Module) -> int:
    return sum(parameter.numel() for parameter in model.parameters())


__all__ = [
    "BOS_ID", "ByteTokenizer", "EOS_ID", "LANGUAGE_CONFIG_FIELDS", "METHOD", "MODEL_SCHEMA", "PAD_ID", "PRESETS",
    "SEP_ID", "STATE_SCHEMA", "VOCAB_SIZE", "ArchieWorldStateLM", "WorldStateConfig",
    "dequantize_state_artifact", "fake_quantize_state", "language_config_matches",
    "load_language_shell", "parameter_count", "quantize_state_artifact",
    "state_dependency_metrics",
]
