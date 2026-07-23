#!/usr/bin/env python3
"""Gated small-scale Archie Event Clock research prototype.

Training or evidence publication must call `verify_recurrence_receipt` first.
The model implementation alone is not evidence that recurrence or event clocks work.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import torch
import torch.nn as nn
import torch.nn.functional as F

from archie_hybrid_core import (
    PAD_ID,
    VOCAB_SIZE,
    ModelConfig,
    RMSNorm,
    SelectiveStateSpace,
    SwiGLU,
)


GATE_SCHEMA = "archie-linked-state-verdict/v1"
MODEL_SCHEMA = "archie-event-clock-model/v0"


@dataclass(frozen=True)
class EventClockConfig:
    vocab_size: int = VOCAB_SIZE
    d_model: int = 448
    byte_layers: int = 7
    d_ff: int = 1280
    ssm_expand: int = 2
    ssm_chunk_size: int = 128
    conv_kernel: int = 4
    max_seq_len: int = 1024
    event_rate_target: float = 0.125
    event_rate_floor: float = 0.02
    event_rate_ceiling: float = 0.35
    reconstruction_weight: float = 0.10
    future_weight: float = 0.15
    rate_weight: float = 0.05
    state_delta_dim: int = 64
    future_horizon: int = 32

    def validate(self) -> None:
        if self.byte_layers < 1 or self.d_model < 16 or self.d_ff < self.d_model:
            raise ValueError("invalid Event Clock dimensions")
        if not 0.0 < self.event_rate_floor < self.event_rate_target < self.event_rate_ceiling < 1.0:
            raise ValueError("invalid event-rate bounds")
        if self.future_horizon < 1:
            raise ValueError("future_horizon must be positive")


class EventByteBlock(nn.Module):
    def __init__(self, cfg: EventClockConfig) -> None:
        super().__init__()
        base = ModelConfig(
            vocab_size=cfg.vocab_size,
            d_model=cfg.d_model,
            n_layers=1,
            n_heads=1,
            n_kv_heads=1,
            d_ff=cfg.d_ff,
            ssm_expand=cfg.ssm_expand,
            ssm_chunk_size=cfg.ssm_chunk_size,
            conv_kernel=cfg.conv_kernel,
            attention_every=2,
            attention_window=cfg.max_seq_len,
            mixer_mode="ssm",
            dropout=0.0,
            max_seq_len=cfg.max_seq_len,
        )
        self.norm1 = RMSNorm(cfg.d_model)
        self.mixer = SelectiveStateSpace(base)
        self.norm2 = RMSNorm(cfg.d_model)
        self.ffn = SwiGLU(base)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = x + self.mixer(self.norm1(x))
        return x + self.ffn(self.norm2(x))


class EventClockLM(nn.Module):
    def __init__(self, cfg: EventClockConfig) -> None:
        super().__init__()
        cfg.validate()
        self.cfg = cfg
        self.embedding = nn.Embedding(cfg.vocab_size, cfg.d_model)
        self.byte_blocks = nn.ModuleList(EventByteBlock(cfg) for _ in range(cfg.byte_layers))
        self.byte_norm = RMSNorm(cfg.d_model)
        self.boundary_head = nn.Linear(cfg.d_model, 1)
        self.event_projection = nn.Linear(cfg.d_model, cfg.d_model, bias=False)
        self.slow_cell = nn.GRUCell(cfg.d_model, cfg.d_model)
        self.slow_norm = RMSNorm(cfg.d_model)
        self.decoder = nn.Linear(cfg.d_model * 2, cfg.d_model, bias=False)
        self.lm_head = nn.Linear(cfg.d_model, cfg.vocab_size, bias=False)
        self.lm_head.weight = self.embedding.weight
        self.reconstruction_head = nn.Linear(cfg.d_model, cfg.d_model)
        self.future_head = nn.Linear(cfg.d_model, cfg.vocab_size)
        self.state_delta_head = nn.Linear(cfg.d_model, cfg.state_delta_dim)

    def parameter_count(self) -> int:
        return sum(parameter.numel() for parameter in self.parameters())

    def _slow_scan(
        self,
        byte_state: torch.Tensor,
        boundary_probability: torch.Tensor,
    ) -> tuple[torch.Tensor, torch.Tensor]:
        batch, length, width = byte_state.shape
        slow = torch.zeros(batch, width, dtype=byte_state.dtype, device=byte_state.device)
        slow_states: list[torch.Tensor] = []
        hard = (boundary_probability >= 0.5).to(byte_state.dtype)
        hard = hard.clone()
        hard[:, -1] = 1.0
        gate = hard + boundary_probability - boundary_probability.detach()
        projected = self.event_projection(byte_state)
        for index in range(length):
            candidate = self.slow_cell(projected[:, index], slow)
            amount = gate[:, index : index + 1]
            slow = amount * candidate + (1.0 - amount) * slow
            slow_states.append(slow)
        return torch.stack(slow_states, dim=1), hard

    def forward(
        self,
        input_ids: torch.Tensor,
        labels: torch.Tensor | None = None,
    ) -> dict[str, Any]:
        if input_ids.ndim != 2 or input_ids.size(1) < 2:
            raise ValueError("input_ids must be [batch, time>=2]")
        if input_ids.size(1) > self.cfg.max_seq_len:
            raise ValueError("sequence exceeds max_seq_len")
        byte_state = self.embedding(input_ids)
        for block in self.byte_blocks:
            byte_state = block(byte_state)
        byte_state = self.byte_norm(byte_state)
        boundary_probability = torch.sigmoid(self.boundary_head(byte_state)).squeeze(-1)
        slow_state, hard_boundaries = self._slow_scan(byte_state, boundary_probability)
        decoded = self.decoder(torch.cat((byte_state, self.slow_norm(slow_state)), dim=-1))
        logits = self.lm_head(F.silu(decoded))
        event_rate = hard_boundaries.mean()
        result: dict[str, Any] = {
            "schema": MODEL_SCHEMA,
            "logits": logits,
            "boundary_probability": boundary_probability,
            "hard_boundaries": hard_boundaries,
            "slow_state": slow_state,
            "state_delta": self.state_delta_head(slow_state),
            "event_rate": event_rate,
        }
        if labels is not None:
            if labels.shape != input_ids.shape:
                raise ValueError("labels must match input_ids")
            byte_loss = F.cross_entropy(
                logits[:, :-1].contiguous().float().view(-1, logits.size(-1)),
                labels[:, 1:].contiguous().view(-1),
                ignore_index=PAD_ID,
            )
            event_weight = hard_boundaries[..., None]
            reconstructed = self.reconstruction_head(slow_state)
            reconstruction_loss = (
                ((reconstructed - byte_state.detach()).float().pow(2) * event_weight)
                .sum()
                / event_weight.sum().clamp_min(1.0)
                / byte_state.size(-1)
            )
            horizon = min(self.cfg.future_horizon, input_ids.size(1) - 1)
            future_logits = self.future_head(slow_state[:, :-horizon])
            future_targets = labels[:, horizon:]
            future_loss = F.cross_entropy(
                future_logits.contiguous().float().view(-1, future_logits.size(-1)),
                future_targets.contiguous().view(-1),
                ignore_index=PAD_ID,
            )
            rate_loss = (boundary_probability.mean() - self.cfg.event_rate_target).pow(2)
            total = (
                byte_loss
                + self.cfg.reconstruction_weight * reconstruction_loss
                + self.cfg.future_weight * future_loss
                + self.cfg.rate_weight * rate_loss
            )
            result.update(
                {
                    "loss": total,
                    "byte_loss": byte_loss,
                    "reconstruction_loss": reconstruction_loss,
                    "future_loss": future_loss,
                    "rate_loss": rate_loss,
                }
            )
        return result


def verify_recurrence_receipt(path: str | Path) -> dict[str, Any]:
    receipt_path = Path(path)
    raw = receipt_path.read_bytes()
    receipt = json.loads(raw)
    if receipt.get("schema") != GATE_SCHEMA:
        raise SystemExit("unsupported recurrence receipt schema")
    if receipt.get("verdict") != "recurrence-supported":
        raise SystemExit("Event Clock remains blocked: recurrence was not supported")
    if receipt.get("event_clock_unblocked") is not True:
        raise SystemExit("Event Clock remains blocked by recurrence receipt")
    if receipt.get("promotion") != "research-only-not-admitted":
        raise SystemExit("recurrence receipt crossed the research-only boundary")
    metrics = receipt.get("metrics")
    if not isinstance(metrics, dict):
        raise SystemExit("recurrence receipt is missing metrics")
    if int(metrics.get("seeds", 0)) < 2 or int(metrics.get("heldout_sources", 0)) < 4:
        raise SystemExit("recurrence evidence is too small to unblock Event Clock")
    verified = dict(receipt)
    verified["source_sha256"] = hashlib.sha256(raw).hexdigest()
    return verified


def model_receipt(model: EventClockLM, recurrence_receipt: dict[str, Any]) -> dict[str, Any]:
    parameters = model.parameter_count()
    if not 20_000_000 <= parameters <= 30_000_000:
        raise ValueError(f"prototype parameter count {parameters} is outside 20-30M")
    return {
        "schema": "archie-event-clock-preflight/v0",
        "model_config": asdict(model.cfg),
        "parameters": parameters,
        "recurrence_receipt_sha256": recurrence_receipt["source_sha256"],
        "status": "gated-prototype-untrained",
        "promotion": "research-only-not-admitted",
        "claim_boundary": "Architecture and objectives exist; no Event Clock training or capability result is claimed.",
    }
