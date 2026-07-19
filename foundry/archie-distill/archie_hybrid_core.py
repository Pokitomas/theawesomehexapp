#!/usr/bin/env python3
"""Auditable from-scratch selective-SSM/local-attention language model."""
from __future__ import annotations

import math
from collections.abc import Iterable
from dataclasses import dataclass

import torch
import torch.nn as nn
import torch.nn.functional as F

PAD_ID = 256
BOS_ID = 257
EOS_ID = 258
SEP_ID = 259
VOCAB_SIZE = 260
METHOD = "archie-selective-ssm-local-attention-from-scratch/v1"


class ByteTokenizer:
    """Deterministic UTF-8 bytes plus four explicit special tokens."""

    vocab_size = VOCAB_SIZE
    pad_token_id = PAD_ID
    bos_token_id = BOS_ID
    eos_token_id = EOS_ID
    sep_token_id = SEP_ID

    @staticmethod
    def encode(text: str, *, bos: bool = False, eos: bool = False) -> list[int]:
        ids: list[int] = [BOS_ID] if bos else []
        ids.extend(text.encode("utf-8", errors="replace"))
        if eos:
            ids.append(EOS_ID)
        return ids

    @staticmethod
    def decode(ids: Iterable[int], *, skip_special: bool = True) -> str:
        raw = bytearray()
        labels = {PAD_ID: b"<pad>", BOS_ID: b"<bos>", EOS_ID: b"<eos>", SEP_ID: b"<sep>"}
        for token in ids:
            value = int(token)
            if value < 256:
                raw.append(value)
            elif not skip_special:
                raw.extend(labels.get(value, b"<?>"))
        return raw.decode("utf-8", errors="replace")

    @staticmethod
    def metadata() -> dict[str, object]:
        return {
            "schema": "archie-byte-tokenizer/v1",
            "encoding": "utf-8-bytes",
            "vocab_size": VOCAB_SIZE,
            "special_tokens": {"pad": PAD_ID, "bos": BOS_ID, "eos": EOS_ID, "sep": SEP_ID},
        }


@dataclass(frozen=True)
class ModelConfig:
    vocab_size: int = VOCAB_SIZE
    d_model: int = 384
    n_layers: int = 12
    n_heads: int = 6
    n_kv_heads: int = 2
    d_ff: int = 1024
    ssm_expand: int = 2
    conv_kernel: int = 4
    attention_every: int = 4
    attention_window: int = 512
    dropout: float = 0.0
    max_seq_len: int = 1024
    rope_base: float = 10_000.0


PRESETS: dict[str, ModelConfig] = {
    "micro": ModelConfig(d_model=64, n_layers=2, n_heads=4, n_kv_heads=2, d_ff=192,
                         attention_every=2, attention_window=128, max_seq_len=128),
    "tiny": ModelConfig(d_model=192, n_layers=8, n_heads=6, n_kv_heads=2, d_ff=512,
                        attention_every=4, attention_window=256, max_seq_len=512),
    "small": ModelConfig(d_model=384, n_layers=12, n_heads=6, n_kv_heads=2, d_ff=1024,
                         attention_every=4, attention_window=512, max_seq_len=1024),
    "base": ModelConfig(d_model=640, n_layers=20, n_heads=10, n_kv_heads=2, d_ff=1792,
                        attention_every=4, attention_window=768, max_seq_len=1536),
    "large": ModelConfig(d_model=896, n_layers=28, n_heads=14, n_kv_heads=2, d_ff=2432,
                         attention_every=4, attention_window=1024, max_seq_len=2048),
    "xlarge": ModelConfig(d_model=1280, n_layers=36, n_heads=20, n_kv_heads=4, d_ff=3584,
                          attention_every=4, attention_window=1536, max_seq_len=3072),
}


def choose_auto_preset(device: torch.device) -> str:
    if device.type != "cuda":
        return "tiny"
    memory_gib = torch.cuda.get_device_properties(device).total_memory / 1024 ** 3
    if memory_gib >= 40:
        return "xlarge"
    if memory_gib >= 22:
        return "large"
    if memory_gib >= 14:
        return "base"
    return "small"


class RMSNorm(nn.Module):
    def __init__(self, width: int, eps: float = 1e-6) -> None:
        super().__init__()
        self.weight = nn.Parameter(torch.ones(width))
        self.eps = eps

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        scale = torch.rsqrt(x.float().pow(2).mean(dim=-1, keepdim=True) + self.eps).to(x.dtype)
        return x * scale * self.weight


class RotaryEmbedding(nn.Module):
    def __init__(self, head_dim: int, max_seq_len: int, base: float) -> None:
        super().__init__()
        if head_dim % 2:
            raise ValueError("head_dim must be even")
        inv = 1.0 / (base ** (torch.arange(0, head_dim, 2, dtype=torch.float32) / head_dim))
        frequency = torch.outer(torch.arange(max_seq_len, dtype=torch.float32), inv)
        self.register_buffer("cos", frequency.cos(), persistent=False)
        self.register_buffer("sin", frequency.sin(), persistent=False)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        length = x.size(-2)
        cos = self.cos[:length].to(dtype=x.dtype, device=x.device)[None, None]
        sin = self.sin[:length].to(dtype=x.dtype, device=x.device)[None, None]
        even, odd = x[..., 0::2], x[..., 1::2]
        return torch.stack((even * cos - odd * sin, even * sin + odd * cos), dim=-1).flatten(-2)


class LocalCausalAttention(nn.Module):
    def __init__(self, cfg: ModelConfig) -> None:
        super().__init__()
        if cfg.d_model % cfg.n_heads or cfg.n_heads % cfg.n_kv_heads:
            raise ValueError("invalid attention dimensions")
        self.n_heads = cfg.n_heads
        self.n_kv_heads = cfg.n_kv_heads
        self.head_dim = cfg.d_model // cfg.n_heads
        self.window = cfg.attention_window
        self.dropout = cfg.dropout
        self.q_proj = nn.Linear(cfg.d_model, cfg.n_heads * self.head_dim, bias=False)
        self.k_proj = nn.Linear(cfg.d_model, cfg.n_kv_heads * self.head_dim, bias=False)
        self.v_proj = nn.Linear(cfg.d_model, cfg.n_kv_heads * self.head_dim, bias=False)
        self.out_proj = nn.Linear(cfg.n_heads * self.head_dim, cfg.d_model, bias=False)
        self.rope = RotaryEmbedding(self.head_dim, cfg.max_seq_len, cfg.rope_base)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        batch, length, _ = x.shape
        q = self.q_proj(x).view(batch, length, self.n_heads, self.head_dim).transpose(1, 2)
        k = self.k_proj(x).view(batch, length, self.n_kv_heads, self.head_dim).transpose(1, 2)
        v = self.v_proj(x).view(batch, length, self.n_kv_heads, self.head_dim).transpose(1, 2)
        q, k = self.rope(q), self.rope(k)
        repeat = self.n_heads // self.n_kv_heads
        if repeat > 1:
            k = k.repeat_interleave(repeat, dim=1)
            v = v.repeat_interleave(repeat, dim=1)
        dropout = self.dropout if self.training else 0.0
        if self.window >= length:
            out = F.scaled_dot_product_attention(q, k, v, dropout_p=dropout, is_causal=True)
        else:
            position = torch.arange(length, device=x.device)
            distance = position[:, None] - position[None, :]
            allowed = (distance >= 0) & (distance < self.window)
            out = F.scaled_dot_product_attention(
                q, k, v, attn_mask=allowed[None, None], dropout_p=dropout, is_causal=False
            )
        return self.out_proj(out.transpose(1, 2).contiguous().view(batch, length, -1))


class SelectiveStateSpace(nn.Module):
    """Input-selective diagonal SSM with a chunked parallel affine scan."""

    def __init__(self, cfg: ModelConfig) -> None:
        super().__init__()
        inner = cfg.d_model * cfg.ssm_expand
        rank = max(8, cfg.d_model // 16)
        self.inner = inner
        self.kernel = cfg.conv_kernel
        self.in_proj = nn.Linear(cfg.d_model, inner * 2, bias=False)
        self.depthwise = nn.Conv1d(inner, inner, self.kernel, groups=inner, bias=True)
        self.select_in = nn.Linear(inner, rank, bias=False)
        self.select_out = nn.Linear(rank, inner * 3, bias=True)
        self.A_log = nn.Parameter(torch.empty(inner))
        self.D = nn.Parameter(torch.ones(inner))
        self.out_proj = nn.Linear(inner, cfg.d_model, bias=False)
        nn.init.uniform_(self.A_log, math.log(0.05), math.log(1.0))
        with torch.no_grad():
            self.select_out.bias[:inner].fill_(-2.0)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        projected, gate = self.in_proj(x).chunk(2, dim=-1)
        causal = F.pad(projected.transpose(1, 2), (self.kernel - 1, 0))
        mixed = F.silu(self.depthwise(causal)[..., :x.size(1)].transpose(1, 2))
        controls = self.select_out(F.silu(self.select_in(mixed)))
        dt_raw, proposal_raw, read_raw = controls.chunk(3, dim=-1)
        dt = F.softplus(dt_raw).clamp(max=8.0)
        proposal = torch.tanh(mixed + proposal_raw)
        read = torch.sigmoid(read_raw)
        rate = -torch.exp(self.A_log.float()).to(device=x.device)
        decay = torch.exp(rate[None, None] * dt.float()).clamp(min=1e-5, max=1.0)
        drive = (1.0 - decay) * proposal.float()
        state = torch.zeros(x.size(0), self.inner, dtype=torch.float32, device=x.device)
        chunks: list[torch.Tensor] = []
        for start in range(0, x.size(1), 64):
            a = decay[:, start:start + 64]
            b = drive[:, start:start + 64]
            prefix = torch.cumprod(a, dim=1).clamp_min(1e-20)
            states = prefix * (state[:, None] + torch.cumsum(b / prefix, dim=1))
            state = states[:, -1]
            chunks.append(states)
        states = torch.cat(chunks, dim=1).to(dtype=x.dtype)
        y = read * states + self.D * mixed
        return self.out_proj(y * F.silu(gate))


class SwiGLU(nn.Module):
    def __init__(self, cfg: ModelConfig) -> None:
        super().__init__()
        self.up = nn.Linear(cfg.d_model, cfg.d_ff * 2, bias=False)
        self.down = nn.Linear(cfg.d_ff, cfg.d_model, bias=False)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        value, gate = self.up(x).chunk(2, dim=-1)
        return self.down(value * F.silu(gate))


class HybridBlock(nn.Module):
    def __init__(self, cfg: ModelConfig, index: int) -> None:
        super().__init__()
        self.norm1, self.norm2 = RMSNorm(cfg.d_model), RMSNorm(cfg.d_model)
        self.mixer: nn.Module = (
            LocalCausalAttention(cfg) if (index + 1) % cfg.attention_every == 0
            else SelectiveStateSpace(cfg)
        )
        self.ffn = SwiGLU(cfg)
        self.dropout = nn.Dropout(cfg.dropout)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = x + self.dropout(self.mixer(self.norm1(x)))
        return x + self.dropout(self.ffn(self.norm2(x)))


class ArchieHybridLM(nn.Module):
    def __init__(self, cfg: ModelConfig, *, gradient_checkpointing: bool = False) -> None:
        super().__init__()
        self.cfg = cfg
        self.gradient_checkpointing = gradient_checkpointing
        self.token_embedding = nn.Embedding(cfg.vocab_size, cfg.d_model)
        self.blocks = nn.ModuleList(HybridBlock(cfg, index) for index in range(cfg.n_layers))
        self.norm = RMSNorm(cfg.d_model)
        self.lm_head = nn.Linear(cfg.d_model, cfg.vocab_size, bias=False)
        self.lm_head.weight = self.token_embedding.weight
        self.apply(self._init_weights)

    @staticmethod
    def _init_weights(module: nn.Module) -> None:
        if isinstance(module, nn.Linear):
            nn.init.normal_(module.weight, mean=0.0, std=0.02)
            if module.bias is not None:
                nn.init.zeros_(module.bias)
        elif isinstance(module, nn.Embedding):
            nn.init.normal_(module.weight, mean=0.0, std=0.02)

    def forward(self, input_ids: torch.Tensor, labels: torch.Tensor | None = None) -> dict[str, torch.Tensor]:
        if input_ids.size(1) > self.cfg.max_seq_len:
            raise ValueError("sequence exceeds max_seq_len")
        x = self.token_embedding(input_ids)
        for block in self.blocks:
            if self.gradient_checkpointing and self.training:
                x = torch.utils.checkpoint.checkpoint(block, x, use_reentrant=False)
            else:
                x = block(x)
        logits = self.lm_head(self.norm(x))
        result = {"logits": logits}
        if labels is not None:
            result["loss"] = F.cross_entropy(
                logits[:, :-1].contiguous().float().view(-1, logits.size(-1)),
                labels[:, 1:].contiguous().view(-1), ignore_index=PAD_ID,
            )
        return result

    @torch.no_grad()
    def generate(self, prompt: torch.Tensor, max_new_tokens: int,
                 temperature: float = 0.8, top_k: int = 40) -> torch.Tensor:
        self.eval()
        tokens = prompt
        for _ in range(max_new_tokens):
            logits = self(tokens[:, -self.cfg.max_seq_len:])["logits"][:, -1]
            logits[:, PAD_ID] = -float("inf")
            logits[:, BOS_ID] = -float("inf")
            logits = logits / max(temperature, 1e-5)
            if 0 < top_k < logits.size(-1):
                values, _ = torch.topk(logits, top_k)
                logits = logits.masked_fill(logits < values[:, -1, None], -float("inf"))
            next_token = torch.multinomial(F.softmax(logits, dim=-1), 1)
            tokens = torch.cat((tokens, next_token), dim=1)
            if bool(torch.all(next_token.eq(EOS_ID))):
                break
        return tokens


def parameter_count(model: nn.Module) -> int:
    return sum(parameter.numel() for parameter in model.parameters())
