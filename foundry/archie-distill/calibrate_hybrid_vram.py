#!/usr/bin/env python3
from __future__ import annotations

import argparse
import dataclasses
import json
import time

import torch

from archie_hybrid_core import PRESETS, ArchieHybridLM, parameter_count


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--preset", choices=PRESETS, default="small")
    parser.add_argument("--batch", type=int, required=True)
    parser.add_argument("--seq-len", type=int, default=512)
    parser.add_argument("--grad-accum", type=int, default=1)
    parser.add_argument("--mixer-mode", choices=["hybrid", "attention", "ssm"], default="hybrid")
    parser.add_argument("--plastic-mode", choices=["none", "delta"], default="none")
    parser.add_argument("--plastic-rank", type=int, default=16)
    parser.add_argument("--amp-dtype", choices=["float16", "bfloat16", "float32"], default="float16")
    parser.add_argument("--tf32", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--compile", action=argparse.BooleanOptionalAction, default=False)
    parser.add_argument(
        "--gradient-checkpointing", action=argparse.BooleanOptionalAction, default=True
    )
    args = parser.parse_args()
    if not torch.cuda.is_available():
        raise SystemExit("CUDA is required for VRAM calibration")
    config = dataclasses.replace(
        PRESETS[args.preset], mixer_mode=args.mixer_mode,
        plastic_mode=args.plastic_mode, plastic_rank=args.plastic_rank,
    )
    if args.seq_len > config.max_seq_len:
        raise SystemExit("sequence exceeds preset maximum")
    torch.manual_seed(1)
    torch.backends.cuda.matmul.allow_tf32 = args.tf32
    torch.backends.cudnn.allow_tf32 = args.tf32
    torch.cuda.empty_cache()
    torch.cuda.reset_peak_memory_stats()
    model = ArchieHybridLM(config, gradient_checkpointing=args.gradient_checkpointing).cuda()
    if args.compile and hasattr(torch, "compile"):
        model = torch.compile(model)
    optimizer = torch.optim.AdamW(model.parameters(), lr=3e-4, fused=True)
    amp_dtype = {
        "float16": torch.float16,
        "bfloat16": torch.bfloat16,
        "float32": None,
    }[args.amp_dtype]
    scaler = torch.amp.GradScaler("cuda", enabled=amp_dtype == torch.float16)
    optimizer.zero_grad(set_to_none=True)
    started = time.monotonic()
    loss_value = 0.0
    for _ in range(args.grad_accum):
        tokens = torch.randint(
            0, config.vocab_size, (args.batch, args.seq_len + 1), device="cuda"
        )
        with torch.autocast("cuda", dtype=amp_dtype, enabled=amp_dtype is not None):
            loss = model(tokens[:, :-1], tokens[:, :-1])["loss"] / args.grad_accum
        scaler.scale(loss).backward()
        loss_value += float(loss.detach())
    scaler.unscale_(optimizer)
    gradient_norm = float(torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0).cpu())
    scaler.step(optimizer)
    scaler.update()
    torch.cuda.synchronize()
    print(
        json.dumps(
            {
                "preset": args.preset,
                "mixer_mode": args.mixer_mode,
                "plastic_mode": args.plastic_mode,
                "amp_dtype": args.amp_dtype,
                "tf32": args.tf32,
                "compile": args.compile,
                "parameters": parameter_count(model),
                "batch": args.batch,
                "sequence_length": args.seq_len,
                "gradient_accumulation": args.grad_accum,
                "gradient_checkpointing": args.gradient_checkpointing,
                "tokens_per_update": args.batch * args.seq_len * args.grad_accum,
                "loss": loss_value,
                "gradient_norm": gradient_norm,
                "seconds": time.monotonic() - started,
                "peak_allocated_mib": torch.cuda.max_memory_allocated() / 2**20,
                "peak_reserved_mib": torch.cuda.max_memory_reserved() / 2**20,
                "gpu": torch.cuda.get_device_name(0),
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
