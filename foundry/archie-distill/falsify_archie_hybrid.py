#!/usr/bin/env python3
"""Equal-budget falsification tournament for hybrid, Transformer, and pure SSM models."""
from __future__ import annotations

import argparse
import gc
import hashlib
import json
import pathlib
import random
import time
from dataclasses import asdict
from typing import Any

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from archie_hybrid_core import (
    ArchieHybridLM,
    LocalCausalAttention,
    ModelConfig,
    RMSNorm,
    SelectiveStateSpace,
    SwiGLU,
    parameter_count,
)
from archie_hybrid_corpus import atomic_json, sha256_file, stable_json, verify_u16_corpus

SCHEMA = "archie-architecture-falsification-receipt/v1"
ARMS = ("hybrid", "transformer", "ssm")


class UniformBlock(nn.Module):
    def __init__(self, cfg: ModelConfig, architecture: str) -> None:
        super().__init__()
        self.norm1 = RMSNorm(cfg.d_model)
        self.norm2 = RMSNorm(cfg.d_model)
        self.mixer = LocalCausalAttention(cfg) if architecture == "transformer" else SelectiveStateSpace(cfg)
        self.ffn = SwiGLU(cfg)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = x + self.mixer(self.norm1(x))
        return x + self.ffn(self.norm2(x))


class UniformLM(nn.Module):
    def __init__(self, cfg: ModelConfig, architecture: str) -> None:
        super().__init__()
        self.token_embedding = nn.Embedding(cfg.vocab_size, cfg.d_model)
        self.blocks = nn.ModuleList(UniformBlock(cfg, architecture) for _ in range(cfg.n_layers))
        self.norm = RMSNorm(cfg.d_model)
        self.lm_head = nn.Linear(cfg.d_model, cfg.vocab_size, bias=False)
        self.lm_head.weight = self.token_embedding.weight
        self.apply(self._init)

    @staticmethod
    def _init(module: nn.Module) -> None:
        if isinstance(module, nn.Linear):
            nn.init.normal_(module.weight, mean=0.0, std=0.02)
            if module.bias is not None:
                nn.init.zeros_(module.bias)
        elif isinstance(module, nn.Embedding):
            nn.init.normal_(module.weight, mean=0.0, std=0.02)

    def forward(self, ids: torch.Tensor) -> dict[str, torch.Tensor]:
        x = self.token_embedding(ids)
        for block in self.blocks:
            x = block(x)
        logits = self.lm_head(self.norm(x))
        loss = F.cross_entropy(
            logits[:, :-1].float().reshape(-1, logits.size(-1)),
            ids[:, 1:].reshape(-1),
        )
        return {"logits": logits, "loss": loss}


class Sampler:
    def __init__(self, path: pathlib.Path, seq_len: int, batch_size: int, seed: int) -> None:
        self.tokens = np.memmap(path, dtype="<u2", mode="r")
        self.seq_len = seq_len
        self.batch_size = batch_size
        self.rng = random.Random(seed)
        if len(self.tokens) <= seq_len + 1:
            raise SystemExit("corpus is shorter than one benchmark sequence")

    def batch(self, device: torch.device) -> torch.Tensor:
        maximum = len(self.tokens) - self.seq_len - 1
        rows = []
        for _ in range(self.batch_size):
            offset = self.rng.randint(0, maximum)
            rows.append(np.asarray(self.tokens[offset:offset + self.seq_len + 1], dtype=np.int64))
        return torch.from_numpy(np.stack(rows)).to(device)


def make_config(width: int, layers: int, seq_len: int) -> ModelConfig:
    heads = max(2, width // 32)
    while width % heads or (width // heads) % 2:
        heads -= 1
    kv_heads = 1 if heads < 4 else 2
    while heads % kv_heads:
        kv_heads -= 1
    return ModelConfig(
        d_model=width,
        n_layers=layers,
        n_heads=heads,
        n_kv_heads=kv_heads,
        d_ff=max(64, int(round(width * 8 / 3 / 16)) * 16),
        attention_every=4,
        attention_window=min(seq_len + 1, 256),
        max_seq_len=seq_len + 1,
    )


def instantiate(architecture: str, cfg: ModelConfig) -> nn.Module:
    return ArchieHybridLM(cfg) if architecture == "hybrid" else UniformLM(cfg, architecture)


def model_loss(model: nn.Module, architecture: str, batch: torch.Tensor) -> torch.Tensor:
    return model(batch, batch)["loss"] if architecture == "hybrid" else model(batch)["loss"]


def fit_budget(architecture: str, budget: int, layers: int, seq_len: int,
               tolerance: float) -> tuple[ModelConfig, int]:
    candidates: list[tuple[int, ModelConfig, int]] = []
    upper = int(budget * (1 + tolerance))
    for width in range(32, 1025, 4):
        cfg = make_config(width, layers, seq_len)
        model = instantiate(architecture, cfg)
        count = parameter_count(model)
        candidates.append((abs(count - budget), cfg, count))
        del model
        gc.collect()
        if count > upper and len(candidates) > 2:
            break
    candidates.sort(key=lambda item: (item[0], item[2] > budget, item[2]))
    _, cfg, count = candidates[0]
    if abs(count - budget) / budget > tolerance:
        raise SystemExit(f"{architecture} cannot fit parameter budget within tolerance: {count} vs {budget}")
    return cfg, count


def set_seed(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def evaluate(model: nn.Module, architecture: str, sampler: Sampler,
             device: torch.device, batches: int) -> float:
    model.eval()
    losses = []
    with torch.no_grad():
        for _ in range(batches):
            losses.append(float(model_loss(model, architecture, sampler.batch(device)).detach().cpu()))
    model.train()
    return sum(losses) / len(losses)


def train_arm(args: argparse.Namespace) -> dict[str, Any]:
    corpus = pathlib.Path(args.corpus).resolve()
    metadata = verify_u16_corpus(corpus)
    output = pathlib.Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    device = torch.device(args.device if args.device != "auto" else ("cuda" if torch.cuda.is_available() else "cpu"))
    cfg, realized = fit_budget(args.architecture, args.parameter_budget, args.layers, args.seq_len, args.parameter_tolerance)
    set_seed(args.seed)
    model = instantiate(args.architecture, cfg).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate, betas=(0.9, 0.95), weight_decay=args.weight_decay)
    train_sampler = Sampler(corpus, args.seq_len, args.batch_size, args.seed)
    eval_sampler = Sampler(corpus, args.seq_len, args.eval_batch_size, args.seed ^ 0x5A5A5A5A)
    initial_eval = evaluate(model, args.architecture, eval_sampler, device, args.eval_batches)
    history: list[dict[str, float]] = []
    tokens_seen = 0
    started = time.monotonic()
    deadline = started + args.deadline_minutes * 60 if args.deadline_minutes else float("inf")
    stop_reason = "max_steps"

    for step in range(1, args.max_steps + 1):
        if time.monotonic() >= deadline - args.deadline_buffer_seconds:
            stop_reason = "deadline"
            break
        optimizer.zero_grad(set_to_none=True)
        total = 0.0
        for _ in range(args.grad_accum):
            batch = train_sampler.batch(device)
            loss = model_loss(model, args.architecture, batch) / args.grad_accum
            loss.backward()
            total += float(loss.detach().cpu())
            tokens_seen += batch[:, 1:].numel()
        grad_norm = float(torch.nn.utils.clip_grad_norm_(model.parameters(), args.grad_clip).detach().cpu())
        optimizer.step()
        record = {"step": step, "loss": total, "grad_norm": grad_norm, "tokens_seen": tokens_seen}
        if step % args.eval_every == 0:
            record["eval_loss"] = evaluate(model, args.architecture, eval_sampler, device, args.eval_batches)
        history.append(record)
        if step % args.log_every == 0:
            print(json.dumps(record, sort_keys=True), flush=True)

    elapsed = time.monotonic() - started
    final_eval = evaluate(model, args.architecture, eval_sampler, device, args.eval_batches)
    model_path = output / "model.pt"
    torch.save({"schema": "archie-falsification-model/v1", "architecture": args.architecture,
                "config": asdict(cfg), "model": model.state_dict()}, model_path)
    receipt = {
        "schema": SCHEMA,
        "architecture": args.architecture,
        "protocol": {
            "corpus_sha256": metadata["sha256"], "seed": args.seed,
            "parameter_budget": args.parameter_budget, "parameter_tolerance": args.parameter_tolerance,
            "realized_parameters": realized, "layers": args.layers, "sequence_length": args.seq_len,
            "batch_size": args.batch_size, "gradient_accumulation": args.grad_accum,
            "max_steps": args.max_steps, "learning_rate": args.learning_rate,
            "weight_decay": args.weight_decay, "eval_batches": args.eval_batches,
        },
        "model_config": asdict(cfg),
        "result": {
            "initial_eval_loss": initial_eval, "final_eval_loss": final_eval,
            "loss_improvement": initial_eval - final_eval, "tokens_seen": tokens_seen,
            "steps_completed": len(history), "wall_seconds": elapsed,
            "tokens_per_second": tokens_seen / max(elapsed, 1e-9),
            "stop_reason": stop_reason, "history": history,
        },
        "artifacts": {"model_sha256": sha256_file(model_path)},
        "runtime": {"device": str(device), "torch": torch.__version__, "cuda": torch.version.cuda},
        "promotion": "not-admitted",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    receipt["receipt_digest"] = hashlib.sha256(stable_json(receipt).encode()).hexdigest()
    atomic_json(output / "receipt.json", receipt)
    print(json.dumps(receipt, indent=2, sort_keys=True))
    return receipt


def aggregate(args: argparse.Namespace) -> dict[str, Any]:
    receipts = [json.loads(pathlib.Path(path).read_text(encoding="utf-8")) for path in args.receipt]
    if len(receipts) != 3 or {item["architecture"] for item in receipts} != set(ARMS):
        raise SystemExit("aggregate requires exactly hybrid, transformer, and ssm receipts")
    keys = ["corpus_sha256", "seed", "parameter_budget", "parameter_tolerance", "layers",
            "sequence_length", "batch_size", "gradient_accumulation", "max_steps",
            "learning_rate", "weight_decay", "eval_batches"]
    anchor = receipts[0]["protocol"]
    for receipt in receipts[1:]:
        for key in keys:
            if receipt["protocol"][key] != anchor[key]:
                raise SystemExit(f"protocol mismatch for {key}")
    steps = {item["result"]["steps_completed"] for item in receipts}
    tokens = {item["result"]["tokens_seen"] for item in receipts}
    reasons = {item["result"]["stop_reason"] for item in receipts}
    if len(steps) != 1 or len(tokens) != 1:
        raise SystemExit("arms completed unequal training budgets")
    if reasons != {"max_steps"}:
        raise SystemExit("all arms must complete max_steps before a verdict")

    ranked = sorted(receipts, key=lambda item: item["result"]["final_eval_loss"])
    margin = ranked[1]["result"]["final_eval_loss"] - ranked[0]["result"]["final_eval_loss"]
    verdict = "unresolved" if margin < args.practical_margin else f"{ranked[0]['architecture']}-win"
    report = {
        "schema": "archie-architecture-falsification-report/v1",
        "protocol": {key: anchor[key] for key in keys},
        "completed_steps": next(iter(steps)), "completed_tokens": next(iter(tokens)),
        "practical_margin": args.practical_margin,
        "ranking": [{
            "architecture": item["architecture"],
            "final_eval_loss": item["result"]["final_eval_loss"],
            "tokens_per_second": item["result"]["tokens_per_second"],
            "parameters": item["protocol"]["realized_parameters"],
            "receipt_digest": item["receipt_digest"],
        } for item in ranked],
        "verdict": verdict,
        "hybrid_hypothesis_falsified": verdict in {"transformer-win", "ssm-win"},
        "promotion": "not-admitted",
    }
    report["report_digest"] = hashlib.sha256(stable_json(report).encode()).hexdigest()
    atomic_json(pathlib.Path(args.output), report)
    print(json.dumps(report, indent=2, sort_keys=True))
    return report


def parser() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(description=__doc__)
    sub = cli.add_subparsers(dest="command", required=True)
    train = sub.add_parser("train")
    train.add_argument("--architecture", choices=ARMS, required=True)
    train.add_argument("--corpus", required=True)
    train.add_argument("--output", required=True)
    train.add_argument("--parameter-budget", type=int, default=4_000_000)
    train.add_argument("--parameter-tolerance", type=float, default=0.03)
    train.add_argument("--layers", type=int, default=8)
    train.add_argument("--seq-len", type=int, default=256)
    train.add_argument("--batch-size", type=int, default=2)
    train.add_argument("--eval-batch-size", type=int, default=2)
    train.add_argument("--grad-accum", type=int, default=4)
    train.add_argument("--max-steps", type=int, default=1000)
    train.add_argument("--learning-rate", type=float, default=3e-4)
    train.add_argument("--weight-decay", type=float, default=0.1)
    train.add_argument("--grad-clip", type=float, default=1.0)
    train.add_argument("--eval-every", type=int, default=50)
    train.add_argument("--eval-batches", type=int, default=8)
    train.add_argument("--log-every", type=int, default=10)
    train.add_argument("--seed", type=int, default=1337)
    train.add_argument("--device", default="auto")
    train.add_argument("--deadline-minutes", type=float, default=320)
    train.add_argument("--deadline-buffer-seconds", type=int, default=180)
    aggregate_parser = sub.add_parser("aggregate")
    aggregate_parser.add_argument("--receipt", action="append", required=True)
    aggregate_parser.add_argument("--practical-margin", type=float, default=0.02)
    aggregate_parser.add_argument("--output", required=True)
    return cli


def main() -> None:
    args = parser().parse_args()
    train_arm(args) if args.command == "train" else aggregate(args)


if __name__ == "__main__":
    main()
