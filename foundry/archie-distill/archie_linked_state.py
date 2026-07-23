#!/usr/bin/env python3
"""Exact incremental SSM/KV execution for ArchieHybridLM.

This module is additive: it reuses the baseline model's parameters and exposes
carried state without changing the baseline checkpoint format.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import torch
import torch.nn.functional as F

from archie_hybrid_core import (
    PAD_ID,
    ArchieHybridLM,
    LocalCausalAttention,
    SelectiveStateSpace,
)


@dataclass
class SSMState:
    recurrent: torch.Tensor
    convolution: torch.Tensor


@dataclass
class KVState:
    keys: torch.Tensor | None
    values: torch.Tensor | None
    valid: torch.Tensor | None


@dataclass
class LinkedState:
    layers: list[SSMState | KVState]
    position: torch.Tensor

    def detach(self) -> "LinkedState":
        detached: list[SSMState | KVState] = []
        for layer in self.layers:
            if isinstance(layer, SSMState):
                detached.append(
                    SSMState(layer.recurrent.detach(), layer.convolution.detach())
                )
            else:
                detached.append(
                    KVState(
                        None if layer.keys is None else layer.keys.detach(),
                        None if layer.values is None else layer.values.detach(),
                        None if layer.valid is None else layer.valid.detach(),
                    )
                )
        return LinkedState(detached, self.position.detach())


def initial_linked_state(
    model: ArchieHybridLM,
    batch_size: int,
    device: torch.device,
) -> LinkedState:
    layers: list[SSMState | KVState] = []
    for block in model.blocks:
        mixer = block.mixer
        if isinstance(mixer, SelectiveStateSpace):
            layers.append(
                SSMState(
                    recurrent=torch.zeros(
                        batch_size, mixer.inner, dtype=torch.float32, device=device
                    ),
                    convolution=torch.zeros(
                        batch_size,
                        mixer.inner,
                        max(mixer.kernel - 1, 0),
                        dtype=model.token_embedding.weight.dtype,
                        device=device,
                    ),
                )
            )
        elif isinstance(mixer, LocalCausalAttention):
            layers.append(KVState(None, None, None))
        else:
            raise TypeError(f"unsupported mixer type: {type(mixer).__name__}")
    return LinkedState(
        layers=layers,
        position=torch.zeros(batch_size, dtype=torch.long, device=device),
    )


def _reset_rows(state: LinkedState, reset: torch.Tensor) -> None:
    if reset.dtype != torch.bool or reset.ndim != 1:
        raise ValueError("reset rows must be a rank-one boolean tensor")
    if not bool(reset.any()):
        return
    state.position = torch.where(reset, torch.zeros_like(state.position), state.position)
    for layer in state.layers:
        if isinstance(layer, SSMState):
            layer.recurrent = layer.recurrent.masked_fill(reset[:, None], 0)
            if layer.convolution.numel():
                layer.convolution = layer.convolution.masked_fill(reset[:, None, None], 0)
        elif layer.valid is not None:
            layer.valid = layer.valid & ~reset[:, None]


def _rotate_at_position(
    values: torch.Tensor,
    mixer: LocalCausalAttention,
    position: torch.Tensor,
) -> torch.Tensor:
    cos = mixer.rope.cos[position].to(values.device, values.dtype)[:, None, None, :]
    sin = mixer.rope.sin[position].to(values.device, values.dtype)[:, None, None, :]
    even, odd = values[..., 0::2], values[..., 1::2]
    return torch.stack(
        (even * cos - odd * sin, even * sin + odd * cos), dim=-1
    ).flatten(-2)


def _attention_step(
    mixer: LocalCausalAttention,
    x: torch.Tensor,
    cache: KVState,
    position: torch.Tensor,
) -> tuple[torch.Tensor, KVState]:
    batch = x.size(0)
    q = mixer.q_proj(x).view(batch, 1, mixer.n_heads, mixer.head_dim).transpose(1, 2)
    k = mixer.k_proj(x).view(batch, 1, mixer.n_kv_heads, mixer.head_dim).transpose(1, 2)
    v = mixer.v_proj(x).view(batch, 1, mixer.n_kv_heads, mixer.head_dim).transpose(1, 2)
    q = _rotate_at_position(q, mixer, position)
    k = _rotate_at_position(k, mixer, position)

    if cache.keys is None:
        keys, values = k, v
        valid = torch.ones(batch, 1, dtype=torch.bool, device=x.device)
    else:
        if cache.values is None or cache.valid is None:
            raise ValueError("partial KV cache")
        keys = torch.cat((cache.keys, k), dim=2)
        values = torch.cat((cache.values, v), dim=2)
        valid = torch.cat(
            (cache.valid, torch.ones(batch, 1, dtype=torch.bool, device=x.device)),
            dim=1,
        )
    if keys.size(2) > mixer.window:
        keys = keys[:, :, -mixer.window :]
        values = values[:, :, -mixer.window :]
        valid = valid[:, -mixer.window :]

    repeat = mixer.n_heads // mixer.n_kv_heads
    attn_keys = keys.repeat_interleave(repeat, dim=1) if repeat > 1 else keys
    attn_values = values.repeat_interleave(repeat, dim=1) if repeat > 1 else values
    mask = valid[:, None, None, :]
    out = F.scaled_dot_product_attention(
        q,
        attn_keys,
        attn_values,
        attn_mask=mask,
        dropout_p=mixer.dropout if mixer.training else 0.0,
        is_causal=False,
    )
    projected = mixer.out_proj(
        out.transpose(1, 2).contiguous().view(batch, 1, -1)
    )
    return projected, KVState(keys, values, valid)


def _ssm_step(
    mixer: SelectiveStateSpace,
    x: torch.Tensor,
    state: SSMState,
) -> tuple[torch.Tensor, SSMState]:
    projected, gate = mixer.in_proj(x).chunk(2, dim=-1)
    current = projected[:, 0]
    if mixer.kernel > 1:
        window = torch.cat((state.convolution, current[:, :, None]), dim=-1)
    else:
        window = current[:, :, None]
    mixed = F.silu(mixer.depthwise(window).squeeze(-1))
    next_convolution = (
        window[:, :, 1:] if mixer.kernel > 1 else window[:, :, :0]
    )

    controls = mixer.select_out(F.silu(mixer.select_in(mixed)))
    dt_raw, proposal_raw, read_raw = controls.chunk(3, dim=-1)
    dt = F.softplus(dt_raw).clamp(max=8.0)
    proposal = torch.tanh(mixed + proposal_raw)
    read = torch.sigmoid(read_raw)
    rate = -torch.exp(mixer.A_log.float()).to(device=x.device)
    decay = torch.exp(rate[None] * dt.float()).clamp(min=1e-5, max=1.0)
    recurrent = decay * state.recurrent + (1.0 - decay) * proposal.float()
    y = read * recurrent.to(x.dtype) + mixer.D * mixed
    output = mixer.out_proj((y * F.silu(gate[:, 0]))[:, None])
    return output, SSMState(recurrent, next_convolution)


def linked_forward(
    model: ArchieHybridLM,
    input_ids: torch.Tensor,
    *,
    state: LinkedState | None = None,
    reset_mask: torch.Tensor | None = None,
    labels: torch.Tensor | None = None,
    detach_state: bool = False,
) -> dict[str, Any]:
    if input_ids.ndim != 2:
        raise ValueError("input_ids must have shape [batch, time]")
    batch, length = input_ids.shape
    if length < 1:
        raise ValueError("linked execution requires at least one token")
    if state is None:
        state = initial_linked_state(model, batch, input_ids.device)
    if len(state.layers) != len(model.blocks) or state.position.shape != (batch,):
        raise ValueError("linked state does not match model or batch")
    if reset_mask is None:
        reset_mask = torch.zeros(
            batch, length, dtype=torch.bool, device=input_ids.device
        )
    if reset_mask.shape != (batch, length) or reset_mask.dtype != torch.bool:
        raise ValueError("reset_mask must be boolean [batch, time]")

    outputs: list[torch.Tensor] = []
    for token_index in range(length):
        _reset_rows(state, reset_mask[:, token_index])
        x = model.token_embedding(input_ids[:, token_index : token_index + 1])
        next_layers: list[SSMState | KVState] = []
        for block, layer_state in zip(model.blocks, state.layers, strict=True):
            normalized = block.norm1(x)
            if isinstance(block.mixer, SelectiveStateSpace):
                if not isinstance(layer_state, SSMState):
                    raise TypeError("SSM block received KV state")
                mixed, next_layer = _ssm_step(block.mixer, normalized, layer_state)
            elif isinstance(block.mixer, LocalCausalAttention):
                if not isinstance(layer_state, KVState):
                    raise TypeError("attention block received SSM state")
                mixed, next_layer = _attention_step(
                    block.mixer, normalized, layer_state, state.position
                )
            else:
                raise TypeError(f"unsupported mixer type: {type(block.mixer).__name__}")
            x = x + block.dropout(mixed)
            x = x + block.dropout(block.ffn(block.norm2(x)))
            next_layers.append(next_layer)
        state.layers = next_layers
        outputs.append(model.lm_head(model.norm(x)))
        state.position = state.position + 1

    logits = torch.cat(outputs, dim=1)
    result: dict[str, Any] = {
        "logits": logits,
        "linked_state": state.detach() if detach_state else state,
    }
    if labels is not None:
        if labels.shape != input_ids.shape:
            raise ValueError("labels must match input_ids")
        result["loss"] = F.cross_entropy(
            logits[:, :-1].contiguous().float().view(-1, logits.size(-1)),
            labels[:, 1:].contiguous().view(-1),
            ignore_index=PAD_ID,
        )
    return result


@torch.no_grad()
def incremental_generate(
    model: ArchieHybridLM,
    prompt: torch.Tensor,
    max_new_tokens: int,
    *,
    temperature: float = 0.8,
    top_k: int = 40,
) -> torch.Tensor:
    model.eval()
    result = linked_forward(model, prompt)
    state = result["linked_state"]
    tokens = prompt
    logits = result["logits"][:, -1]
    for _ in range(max_new_tokens):
        logits = logits.clone()
        logits[:, PAD_ID] = -float("inf")
        logits = logits / max(temperature, 1e-5)
        if 0 < top_k < logits.size(-1):
            values, _ = torch.topk(logits, top_k)
            logits = logits.masked_fill(logits < values[:, -1, None], -float("inf"))
        next_token = torch.multinomial(F.softmax(logits, dim=-1), 1)
        tokens = torch.cat((tokens, next_token), dim=1)
        step = linked_forward(model, next_token, state=state)
        state = step["linked_state"]
        logits = step["logits"][:, -1]
    return tokens
