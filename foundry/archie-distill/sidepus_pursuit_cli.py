#!/usr/bin/env python3
"""CLI contract for Archie Sidepus pursuit training."""
from __future__ import annotations

import argparse
import torch


def parser() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--plan", required=True); cli.add_argument("--plan-receipt", required=True)
    cli.add_argument("--sidepus-state", required=True); cli.add_argument("--cache-dir", required=True)
    cli.add_argument("--cache-bytes", type=int, default=8 << 30)
    cli.add_argument("--retention-corpus", required=True); cli.add_argument("--init-model", required=True)
    cli.add_argument("--output-dir", required=True); cli.add_argument("--seq-len", type=int, default=1024)
    cli.add_argument("--batch-size", type=int, default=1); cli.add_argument("--prefetch-workers", type=int, default=4)
    cli.add_argument("--pursuit-lookahead", type=int, default=64); cli.add_argument("--max-steps", type=int, default=2500)
    cli.add_argument("--learning-rate", type=float, default=2e-4); cli.add_argument("--language-lr-scale", type=float, default=0.02)
    cli.add_argument("--freeze-language-steps", type=int, default=1000); cli.add_argument("--min-lr-ratio", type=float, default=0.1)
    cli.add_argument("--warmup-steps", type=int, default=200); cli.add_argument("--weight-decay", type=float, default=0.1)
    cli.add_argument("--grad-clip", type=float, default=1.0); cli.add_argument("--max-consecutive-skips", type=int, default=8)
    cli.add_argument("--eval-every", type=int, default=100); cli.add_argument("--save-every", type=int, default=50)
    cli.add_argument("--log-every", type=int, default=5); cli.add_argument("--retention-seq-len", type=int, default=512)
    cli.add_argument("--retention-batch-size", type=int, default=1); cli.add_argument("--retention-batches", type=int, default=16)
    cli.add_argument("--plastic-mode", choices=("none", "delta"), default="delta"); cli.add_argument("--plastic-rank", type=int, default=16)
    cli.add_argument("--plastic-retention-floor", type=float, default=0.97); cli.add_argument("--plastic-write-scale", type=float, default=0.15)
    cli.add_argument("--plastic-state-clip", type=float, default=3.0); cli.add_argument("--plastic-detach-every", type=int, default=128)
    cli.add_argument("--event-size", type=int, default=16); cli.add_argument("--state-slots", type=int, default=12)
    cli.add_argument("--state-top-k", type=int, default=3); cli.add_argument("--state-quant-bits", type=int, choices=(0,4,8), default=8)
    cli.add_argument("--state-aux-weight", type=float, default=0.20); cli.add_argument("--action-count", type=int, default=0)
    cli.add_argument("--deliberation-max-steps", type=int, default=4); cli.add_argument("--deliberation-ponder-weight", type=float, default=0.0002)
    cli.add_argument("--deliberation-min-halt", type=float, default=0.01); cli.add_argument("--counterfactual-every", type=int, default=4)
    cli.add_argument("--state-margin", type=float, default=0.02); cli.add_argument("--state-order-weight", type=float, default=0.5)
    cli.add_argument("--deliberation-floor-weight", type=float, default=0.05); cli.add_argument("--halt-entropy-weight", type=float, default=0.002)
    cli.add_argument("--interference-every", type=int, default=8); cli.add_argument("--interference-weight", type=float, default=0.1)
    cli.add_argument("--retention-tax-weight", type=float, default=2.0)
    cli.add_argument("--state-carry-policy", choices=("reset-each-window","carry-detached","carry-with-domain-reset"), default="carry-detached")
    cli.add_argument("--deadline-minutes", type=float, default=330); cli.add_argument("--deadline-buffer-seconds", type=int, default=180)
    cli.add_argument("--seed", type=int, default=20260723); cli.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    cli.add_argument("--amp-dtype", choices=("float16","bfloat16","float32"), default="float16")
    cli.add_argument("--tf32", action=argparse.BooleanOptionalAction, default=True); cli.add_argument("--no-resume", action="store_true")
    return cli
