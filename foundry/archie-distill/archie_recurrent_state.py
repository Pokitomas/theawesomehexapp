#!/usr/bin/env python3
"""Explicit linked recurrent state for the Archie hybrid byte language model.

This module is additive: it preserves the baseline state-dict namespace while
providing one-token/chunk stepping, SSM state, local-attention KV caches,
document resets, and matched state controls.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Sequence

import torch
import torch.nn.functional as F

from archie_hybrid_core import (
    ArchieHybridLM,
    HybridBlock,
    LocalCausalAttention,
    ModelConfig,
    PAD_ID,
    SelectiveStateSpace,
)


@dataclass
class SSMState:
    recurrent: torch.Tensor
    convolution: torch.Tensor


@dataclass
class KVState:
    key: torch.Tensor
    value: torch.Tensor
    valid: torch.Tensor
    position: torch.Tensor


@dataclass
class RecurrentState:
    ssm: list[SSMState | None]
    kv: list[KVState | None]


def _reset_rows(value: torch.Tensor, reset: torch.Tensor) -> torch.Tensor:
    if not bool(reset.any()):
        return value
    result = value.clone()
    result[reset] = 0
    return result


def _validate_reset_mask(reset_mask: torch.Tensor | None, batch: int, length: int, device: torch.device) -> torch.Tensor:
    if reset_mask is None:
        return torch.zeros(batch, length, dtype=torch.bool, device=device)
    mask = reset_mask.to(device=device, dtype=torch.bool)
    if mask.ndim == 1:
        if tuple(mask.shape) != (batch,):
            raise ValueError("one-dimensional reset_mask must have shape [batch]")
        expanded = torch.zeros(batch, length, dtype=torch.bool, device=device)
        expanded[:, 0] = mask
        return expanded
    if tuple(mask.shape) != (batch, length):
        raise ValueError("reset_mask must have shape [batch] or [batch, length]")
    return mask


class RecurrentSelectiveStateSpace(SelectiveStateSpace):
    """SelectiveStateSpace with exact causal convolution and diagonal-state carry."""

    def initial_state(self, batch: int, device: torch.device, dtype: torch.dtype) -> SSMState:
        return SSMState(
            recurrent=torch.zeros(batch, self.inner, device=device, dtype=torch.float32),
            convolution=torch.zeros(
                batch, self.inner, max(self.kernel - 1, 0), device=device, dtype=dtype
            ),
        )

    def step(
        self,
        x: torch.Tensor,
        state: SSMState | None = None,
        reset_mask: torch.Tensor | None = None,
    ) -> tuple[torch.Tensor, SSMState]:
        if x.ndim != 3:
            raise ValueError("SSM step expects [batch, length, width]")
        batch, length, _ = x.shape
        resets = _validate_reset_mask(reset_mask, batch, length, x.device)
        current = state or self.initial_state(batch, x.device, x.dtype)
        expected_recurrent = (batch, self.inner)
        expected_convolution = (batch, self.inner, max(self.kernel - 1, 0))
        if tuple(current.recurrent.shape) != expected_recurrent:
            raise ValueError(f"SSM recurrent state has shape {tuple(current.recurrent.shape)}, expected {expected_recurrent}")
        if tuple(current.convolution.shape) != expected_convolution:
            raise ValueError(f"SSM convolution state has shape {tuple(current.convolution.shape)}, expected {expected_convolution}")
        recurrent = current.recurrent.to(device=x.device, dtype=torch.float32)
        convolution = current.convolution.to(device=x.device, dtype=x.dtype)
        outputs: list[torch.Tensor] = []
        rate = -torch.exp(self.A_log.float()).to(device=x.device)
        for index in range(length):
            reset = resets[:, index]
            recurrent = _reset_rows(recurrent, reset)
            convolution = _reset_rows(convolution, reset)
            token = x[:, index:index + 1]
            projected, gate = self.in_proj(token).chunk(2, dim=-1)
            projected_channels = projected.transpose(1, 2)
            history = torch.cat((convolution, projected_channels), dim=-1)
            convolved = F.conv1d(
                history,
                self.depthwise.weight,
                self.depthwise.bias,
                groups=self.inner,
            ).transpose(1, 2)
            mixed = F.silu(convolved)
            controls = self.select_out(F.silu(self.select_in(mixed)))
            dt_raw, proposal_raw, read_raw = controls.chunk(3, dim=-1)
            dt = F.softplus(dt_raw).clamp(max=8.0)
            proposal = torch.tanh(mixed + proposal_raw)
            read = torch.sigmoid(read_raw)
            decay = torch.exp(rate[None, None] * dt.float()).clamp(min=1e-5, max=1.0)
            drive = (1.0 - decay) * proposal.float()
            recurrent = decay[:, 0] * recurrent + drive[:, 0]
            states = recurrent[:, None].to(dtype=x.dtype)
            y = read * states + self.D * mixed
            outputs.append(self.out_proj(y * F.silu(gate)))
            convolution = history[..., 1:] if self.kernel > 1 else history[..., :0]
        return torch.cat(outputs, dim=1), SSMState(recurrent=recurrent, convolution=convolution)


class RecurrentLocalCausalAttention(LocalCausalAttention):
    """Local attention with per-row validity and absolute-position KV carry."""

    def initial_state(self, batch: int, device: torch.device, dtype: torch.dtype) -> KVState:
        shape = (batch, self.n_kv_heads, 0, self.head_dim)
        return KVState(
            key=torch.empty(shape, device=device, dtype=dtype),
            value=torch.empty(shape, device=device, dtype=dtype),
            valid=torch.empty(batch, 0, device=device, dtype=torch.bool),
            position=torch.zeros(batch, device=device, dtype=torch.long),
        )

    def _rotary_at(self, x: torch.Tensor, position: torch.Tensor) -> torch.Tensor:
        if bool((position < 0).any()) or bool((position >= self.rope.cos.size(0)).any()):
            raise ValueError("incremental position exceeds configured rotary table")
        cos = self.rope.cos[position].to(device=x.device, dtype=x.dtype)[:, None, None]
        sin = self.rope.sin[position].to(device=x.device, dtype=x.dtype)[:, None, None]
        even, odd = x[..., 0::2], x[..., 1::2]
        return torch.stack((even * cos - odd * sin, even * sin + odd * cos), dim=-1).flatten(-2)

    def step(
        self,
        x: torch.Tensor,
        state: KVState | None = None,
        reset_mask: torch.Tensor | None = None,
    ) -> tuple[torch.Tensor, KVState]:
        if x.ndim != 3:
            raise ValueError("attention step expects [batch, length, width]")
        batch, length, _ = x.shape
        resets = _validate_reset_mask(reset_mask, batch, length, x.device)
        current = state or self.initial_state(batch, x.device, x.dtype)
        if current.key.shape[:2] != (batch, self.n_kv_heads) or current.key.shape != current.value.shape:
            raise ValueError("KV cache shape is incompatible with this attention layer")
        if tuple(current.valid.shape) != (batch, current.key.size(2)):
            raise ValueError("KV validity mask does not match cache length")
        if tuple(current.position.shape) != (batch,):
            raise ValueError("KV position must have shape [batch]")
        key = current.key.to(device=x.device, dtype=x.dtype)
        value = current.value.to(device=x.device, dtype=x.dtype)
        valid = current.valid.to(device=x.device)
        position = current.position.to(device=x.device)
        outputs: list[torch.Tensor] = []
        repeat = self.n_heads // self.n_kv_heads
        for index in range(length):
            reset = resets[:, index]
            if bool(reset.any()):
                valid = valid.clone()
                valid[reset] = False
                position = position.clone()
                position[reset] = 0
            token = x[:, index:index + 1]
            query = self.q_proj(token).view(batch, 1, self.n_heads, self.head_dim).transpose(1, 2)
            new_key = self.k_proj(token).view(batch, 1, self.n_kv_heads, self.head_dim).transpose(1, 2)
            new_value = self.v_proj(token).view(batch, 1, self.n_kv_heads, self.head_dim).transpose(1, 2)
            query = self._rotary_at(query, position)
            new_key = self._rotary_at(new_key, position)
            key = torch.cat((key, new_key), dim=2)
            value = torch.cat((value, new_value), dim=2)
            valid = torch.cat((valid, torch.ones(batch, 1, dtype=torch.bool, device=x.device)), dim=1)
            if key.size(2) > self.window:
                key = key[:, :, -self.window:]
                value = value[:, :, -self.window:]
                valid = valid[:, -self.window:]
            attended_key = key.repeat_interleave(repeat, dim=1) if repeat > 1 else key
            attended_value = value.repeat_interleave(repeat, dim=1) if repeat > 1 else value
            allowed = valid[:, None, None, :]
            out = F.scaled_dot_product_attention(
                query,
                attended_key,
                attended_value,
                attn_mask=allowed,
                dropout_p=self.dropout if self.training else 0.0,
                is_causal=False,
            )
            outputs.append(self.out_proj(out.transpose(1, 2).contiguous().view(batch, 1, -1)))
            position = position + 1
        return torch.cat(outputs, dim=1), KVState(key=key, value=value, valid=valid, position=position)


class RecurrentHybridBlock(HybridBlock):
    def __init__(self, cfg: ModelConfig, index: int) -> None:
        super().__init__(cfg, index)
        if isinstance(self.mixer, LocalCausalAttention):
            self.mixer = RecurrentLocalCausalAttention(cfg)
        elif isinstance(self.mixer, SelectiveStateSpace):
            self.mixer = RecurrentSelectiveStateSpace(cfg)
        else:
            raise TypeError(f"unsupported recurrent mixer {type(self.mixer).__name__}")

    def step(
        self,
        x: torch.Tensor,
        ssm_state: SSMState | None,
        kv_state: KVState | None,
        reset_mask: torch.Tensor,
    ) -> tuple[torch.Tensor, SSMState | None, KVState | None]:
        normalized = self.norm1(x)
        if isinstance(self.mixer, RecurrentSelectiveStateSpace):
            mixed, ssm_state = self.mixer.step(normalized, ssm_state, reset_mask)
        elif isinstance(self.mixer, RecurrentLocalCausalAttention):
            mixed, kv_state = self.mixer.step(normalized, kv_state, reset_mask)
        else:  # pragma: no cover - constructor rejects this
            raise TypeError("block mixer is not recurrent")
        x = x + self.dropout(mixed)
        x = x + self.dropout(self.ffn(self.norm2(x)))
        return x, ssm_state, kv_state


class RecurrentArchieHybridLM(ArchieHybridLM):
    """Checkpoint-compatible Archie model with explicit recurrent stepping."""

    def __init__(self, cfg: ModelConfig, *, gradient_checkpointing: bool = False) -> None:
        super().__init__(cfg, gradient_checkpointing=gradient_checkpointing)
        if getattr(cfg, "plastic_mode", "none") != "none":
            raise ValueError("linked recurrence is isolated from the superseded plastic-memory lane")
        for index in range(len(self.blocks)):
            block = RecurrentHybridBlock(cfg, index)
            block.apply(self._init_weights)
            self.blocks[index] = block

    def initial_recurrent_state(self, batch: int, device: torch.device, dtype: torch.dtype) -> RecurrentState:
        ssm: list[SSMState | None] = []
        kv: list[KVState | None] = []
        for block in self.blocks:
            mixer = block.mixer
            if isinstance(mixer, RecurrentSelectiveStateSpace):
                ssm.append(mixer.initial_state(batch, device, dtype))
                kv.append(None)
            elif isinstance(mixer, RecurrentLocalCausalAttention):
                ssm.append(None)
                kv.append(mixer.initial_state(batch, device, dtype))
            else:  # pragma: no cover
                raise TypeError("non-recurrent block")
        return RecurrentState(ssm=ssm, kv=kv)

    def step(
        self,
        input_ids: torch.Tensor,
        ssm_state: Sequence[SSMState | None] | None = None,
        kv_cache: Sequence[KVState | None] | None = None,
        reset_mask: torch.Tensor | None = None,
    ) -> tuple[torch.Tensor, list[SSMState | None], list[KVState | None]]:
        if input_ids.ndim != 2:
            raise ValueError("model.step expects token IDs with shape [batch, length]")
        if input_ids.size(1) < 1:
            raise ValueError("model.step requires at least one token")
        batch, length = input_ids.shape
        resets = _validate_reset_mask(reset_mask, batch, length, input_ids.device)
        if ssm_state is None and kv_cache is None:
            initial = self.initial_recurrent_state(batch, input_ids.device, self.token_embedding.weight.dtype)
            ssm = initial.ssm
            kv = initial.kv
        elif ssm_state is None or kv_cache is None:
            raise ValueError("ssm_state and kv_cache must be supplied together")
        else:
            if len(ssm_state) != len(self.blocks) or len(kv_cache) != len(self.blocks):
                raise ValueError("state list length must equal model layer count")
            ssm, kv = list(ssm_state), list(kv_cache)
        logits: list[torch.Tensor] = []
        for index in range(length):
            x = self.token_embedding(input_ids[:, index:index + 1])
            token_reset = resets[:, index:index + 1]
            for layer, block in enumerate(self.blocks):
                x, ssm[layer], kv[layer] = block.step(x, ssm[layer], kv[layer], token_reset)
            logits.append(self.lm_head(self.norm(x)))
        return torch.cat(logits, dim=1), ssm, kv

    @torch.no_grad()
    def incremental_generate(
        self,
        prompt: torch.Tensor,
        max_new_tokens: int,
        temperature: float = 0.8,
        top_k: int = 40,
    ) -> torch.Tensor:
        self.eval()
        logits, ssm, kv = self.step(prompt)
        tokens = prompt
        for _ in range(max_new_tokens):
            next_logits = logits[:, -1] / max(temperature, 1e-5)
            next_logits[:, PAD_ID] = -float("inf")
            if 0 < top_k < next_logits.size(-1):
                values, _ = torch.topk(next_logits, top_k)
                next_logits = next_logits.masked_fill(next_logits < values[:, -1, None], -float("inf"))
            token = torch.multinomial(F.softmax(next_logits, dim=-1), 1)
            tokens = torch.cat((tokens, token), dim=1)
            logits, ssm, kv = self.step(token, ssm, kv)
        return tokens


def detach_state(state: RecurrentState) -> RecurrentState:
    return RecurrentState(
        ssm=[
            None if item is None else SSMState(item.recurrent.detach(), item.convolution.detach())
            for item in state.ssm
        ],
        kv=[
            None if item is None else KVState(
                item.key.detach(), item.value.detach(), item.valid.detach(), item.position.detach()
            )
            for item in state.kv
        ],
    )


def transplant_state(state: RecurrentState, permutation: torch.Tensor) -> RecurrentState:
    return RecurrentState(
        ssm=[
            None if item is None else SSMState(
                item.recurrent.index_select(0, permutation),
                item.convolution.index_select(0, permutation),
            )
            for item in state.ssm
        ],
        kv=[
            None if item is None else KVState(
                item.key.index_select(0, permutation),
                item.value.index_select(0, permutation),
                item.valid.index_select(0, permutation),
                item.position.index_select(0, permutation),
            )
            for item in state.kv
        ],
    )


def shuffle_state_channels(state: RecurrentState, generator: torch.Generator) -> RecurrentState:
    shuffled: list[SSMState | None] = []
    for item in state.ssm:
        if item is None:
            shuffled.append(None)
            continue
        order = torch.randperm(item.recurrent.size(1), generator=generator, device=item.recurrent.device)
        shuffled.append(SSMState(item.recurrent[:, order], item.convolution[:, order]))
    return RecurrentState(ssm=shuffled, kv=list(state.kv))


def state_from_lists(ssm: Sequence[SSMState | None], kv: Sequence[KVState | None]) -> RecurrentState:
    return RecurrentState(list(ssm), list(kv))


def linked_cross_entropy(
    model: RecurrentArchieHybridLM,
    segments: Iterable[torch.Tensor],
    detach_between_segments: bool = True,
) -> tuple[torch.Tensor, RecurrentState]:
    state: RecurrentState | None = None
    losses: list[torch.Tensor] = []
    for segment in segments:
        if segment.ndim != 2 or segment.size(1) < 2:
            raise ValueError("linked segments must have shape [batch, length>=2]")
        logits, ssm, kv = model.step(
            segment[:, :-1],
            None if state is None else state.ssm,
            None if state is None else state.kv,
        )
        loss = F.cross_entropy(logits.float().reshape(-1, logits.size(-1)), segment[:, 1:].reshape(-1))
        losses.append(loss)
        state = state_from_lists(ssm, kv)
        if detach_between_segments:
            state = detach_state(state)
    if not losses or state is None:
        raise ValueError("at least one linked segment is required")
    return torch.stack(losses).mean(), state
