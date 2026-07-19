#!/usr/bin/env python3
"""Train Archie HybridLM from random initialization on deterministic uint16 corpora."""
from __future__ import annotations

import argparse
import dataclasses
import hashlib
import itertools
import json
import math
import os
import pathlib
import platform
import random
import shutil
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from typing import Any

import numpy as np
import torch

from archie_hybrid_core import (
    BOS_ID, EOS_ID, SEP_ID, ByteTokenizer, ArchieHybridLM, ModelConfig, PRESETS,
    METHOD, choose_auto_preset, parameter_count,
)
from archie_hybrid_corpus import (
    atomic_json, build_u16_corpus, iter_hf_documents, iter_local_documents,
    sha256_file, stable_json, verify_u16_corpus,
)

SCHEMA = "archie-scratch-hybrid-training-receipt/v1"


class TokenSampler:
    def __init__(self, path: pathlib.Path, seq_len: int, batch_size: int, seed: int) -> None:
        self.tokens = np.memmap(path, dtype="<u2", mode="r")
        if len(self.tokens) <= seq_len + 1:
            raise ValueError("corpus is shorter than one training sequence")
        self.seq_len, self.batch_size = seq_len, batch_size
        self.rng = random.Random(seed)

    def state_dict(self) -> object:
        return self.rng.getstate()

    def load_state_dict(self, state: object) -> None:
        self.rng.setstate(state)  # type: ignore[arg-type]

    def batch(self, device: torch.device) -> torch.Tensor:
        maximum = len(self.tokens) - self.seq_len - 1
        rows = []
        for _ in range(self.batch_size):
            offset = self.rng.randint(0, maximum)
            rows.append(np.asarray(self.tokens[offset:offset + self.seq_len + 1], dtype=np.int64))
        return torch.from_numpy(np.stack(rows)).to(device=device, non_blocking=device.type == "cuda")


@dataclass
class TrainState:
    step: int = 0
    tokens_seen: int = 0
    best_eval_loss: float = float("inf")


def rng_state() -> dict[str, Any]:
    state: dict[str, Any] = {
        "python": random.getstate(), "numpy": np.random.get_state(),
        "torch": torch.get_rng_state(),
    }
    if torch.cuda.is_available():
        state["cuda"] = torch.cuda.get_rng_state_all()
    return state


def restore_rng_state(state: dict[str, Any]) -> None:
    random.setstate(state["python"])
    np.random.set_state(state["numpy"])
    torch.set_rng_state(state["torch"])
    if torch.cuda.is_available() and "cuda" in state:
        torch.cuda.set_rng_state_all(state["cuda"])


def save_checkpoint(path: pathlib.Path, model: torch.nn.Module,
                    optimizer: torch.optim.Optimizer,
                    scheduler: torch.optim.lr_scheduler.LRScheduler,
                    scaler: Any, train_state: TrainState,
                    train_sampler: TokenSampler, eval_sampler: TokenSampler,
                    cfg: ModelConfig, corpus_digest: str,
                    loss_history: list[dict[str, float]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    torch.save({
        "schema": "archie-scratch-hybrid-checkpoint/v1",
        "model_config": asdict(cfg), "model": model.state_dict(),
        "optimizer": optimizer.state_dict(), "scheduler": scheduler.state_dict(),
        "scaler": scaler.state_dict() if scaler is not None else None,
        "train_state": asdict(train_state), "train_sampler": train_sampler.state_dict(),
        "eval_sampler": eval_sampler.state_dict(), "rng": rng_state(),
        "corpus_sha256": corpus_digest, "loss_history": loss_history,
    }, temporary)
    os.replace(temporary, path)


def load_checkpoint(path: pathlib.Path, model: torch.nn.Module,
                    optimizer: torch.optim.Optimizer,
                    scheduler: torch.optim.lr_scheduler.LRScheduler,
                    scaler: Any, train_sampler: TokenSampler,
                    eval_sampler: TokenSampler, cfg: ModelConfig,
                    corpus_digest: str, device: torch.device
                    ) -> tuple[TrainState, list[dict[str, float]]]:
    payload = torch.load(path, map_location=device, weights_only=False)
    if payload.get("schema") != "archie-scratch-hybrid-checkpoint/v1":
        raise SystemExit("unsupported checkpoint schema")
    if payload.get("model_config") != asdict(cfg):
        raise SystemExit("checkpoint model configuration does not match")
    if payload.get("corpus_sha256") != corpus_digest:
        raise SystemExit("checkpoint corpus digest does not match")
    model.load_state_dict(payload["model"])
    optimizer.load_state_dict(payload["optimizer"])
    scheduler.load_state_dict(payload["scheduler"])
    if scaler is not None and payload.get("scaler") is not None:
        scaler.load_state_dict(payload["scaler"])
    train_sampler.load_state_dict(payload["train_sampler"])
    eval_sampler.load_state_dict(payload["eval_sampler"])
    restore_rng_state(payload["rng"])
    return TrainState(**payload["train_state"]), list(payload.get("loss_history") or [])


@torch.no_grad()
def evaluate(model: ArchieHybridLM, sampler: TokenSampler, device: torch.device,
             batches: int, amp_dtype: torch.dtype | None) -> float:
    model.eval()
    losses = []
    for _ in range(batches):
        batch = sampler.batch(device)
        with torch.autocast(device_type=device.type, dtype=amp_dtype, enabled=amp_dtype is not None):
            loss = model(batch[:, :-1], batch[:, 1:])["loss"]
        losses.append(float(loss.detach().cpu()))
    return sum(losses) / max(len(losses), 1)


def cosine_lambda(step: int, warmup: int, total: int, min_ratio: float) -> float:
    if step < warmup:
        return max((step + 1) / max(warmup, 1), 1e-3)
    progress = min(max((step - warmup) / max(total - warmup, 1), 0.0), 1.0)
    return min_ratio + 0.5 * (1.0 - min_ratio) * (1.0 + math.cos(math.pi * progress))


def train(args: argparse.Namespace, cfg: ModelConfig, corpus_path: pathlib.Path,
          output: pathlib.Path) -> dict[str, Any]:
    metadata = verify_u16_corpus(corpus_path)
    seed = int(args.seed)
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    device = torch.device(args.device if args.device != "auto"
                          else ("cuda" if torch.cuda.is_available() else "cpu"))
    if device.type == "cuda":
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
    model = ArchieHybridLM(cfg, gradient_checkpointing=args.gradient_checkpointing).to(device)
    params = parameter_count(model)
    if args.compile and hasattr(torch, "compile"):
        model = torch.compile(model)  # type: ignore[assignment]
    train_sampler = TokenSampler(corpus_path, args.seq_len, args.batch_size, seed)
    eval_sampler = TokenSampler(corpus_path, args.seq_len, args.eval_batch_size, seed ^ 0xA5A5A5A5)
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=args.learning_rate, betas=(0.9, 0.95), eps=1e-8,
        weight_decay=args.weight_decay, fused=device.type == "cuda",
    )
    scheduler = torch.optim.lr_scheduler.LambdaLR(
        optimizer, lambda step: cosine_lambda(
            step, args.warmup_steps, args.max_steps, args.min_lr_ratio
        )
    )
    amp_dtype: torch.dtype | None = None
    scaler = None
    if device.type == "cuda":
        amp_dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
        scaler = torch.amp.GradScaler("cuda", enabled=amp_dtype == torch.float16)
    checkpoint_path = output / "checkpoint.pt"
    train_state, history, resumed = TrainState(), [], False
    if checkpoint_path.exists() and not args.no_resume:
        train_state, history = load_checkpoint(
            checkpoint_path, model, optimizer, scheduler, scaler, train_sampler,
            eval_sampler, cfg, metadata["sha256"], device,
        )
        resumed = True
    start = time.monotonic()
    deadline = start + args.deadline_minutes * 60 if args.deadline_minutes > 0 else float("inf")
    model.train()
    optimizer.zero_grad(set_to_none=True)
    stop_reason = "max_steps"
    while train_state.step < args.max_steps:
        if time.monotonic() >= deadline - args.deadline_buffer_seconds:
            stop_reason = "deadline"
            break
        aggregate_loss = 0.0
        for _ in range(args.grad_accum):
            batch = train_sampler.batch(device)
            inputs, labels = batch[:, :-1], batch[:, 1:]
            with torch.autocast(device_type=device.type, dtype=amp_dtype, enabled=amp_dtype is not None):
                loss = model(inputs, labels)["loss"] / args.grad_accum
            if scaler is not None:
                scaler.scale(loss).backward()
            else:
                loss.backward()
            aggregate_loss += float(loss.detach().cpu())
            train_state.tokens_seen += inputs.numel()
        if scaler is not None:
            scaler.unscale_(optimizer)
        grad_norm = float(torch.nn.utils.clip_grad_norm_(model.parameters(), args.grad_clip).detach().cpu())
        if scaler is not None:
            scaler.step(optimizer)
            scaler.update()
        else:
            optimizer.step()
        optimizer.zero_grad(set_to_none=True)
        scheduler.step()
        train_state.step += 1
        record = {
            "step": float(train_state.step), "loss": aggregate_loss,
            "learning_rate": float(optimizer.param_groups[0]["lr"]),
            "grad_norm": grad_norm, "tokens_seen": float(train_state.tokens_seen),
        }
        history.append(record)
        if train_state.step % args.log_every == 0:
            print(json.dumps(record, sort_keys=True), flush=True)
        if train_state.step % args.eval_every == 0:
            eval_loss = evaluate(model, eval_sampler, device, args.eval_batches, amp_dtype)
            train_state.best_eval_loss = min(train_state.best_eval_loss, eval_loss)
            history[-1]["eval_loss"] = eval_loss
            model.train()
        if train_state.step % args.save_every == 0:
            save_checkpoint(
                checkpoint_path, model, optimizer, scheduler, scaler, train_state,
                train_sampler, eval_sampler, cfg, metadata["sha256"], history,
            )
    final_eval_loss = evaluate(model, eval_sampler, device, args.eval_batches, amp_dtype)
    train_state.best_eval_loss = min(train_state.best_eval_loss, final_eval_loss)
    save_checkpoint(
        checkpoint_path, model, optimizer, scheduler, scaler, train_state,
        train_sampler, eval_sampler, cfg, metadata["sha256"], history,
    )
    raw_model = model._orig_mod if hasattr(model, "_orig_mod") else model
    export_path = output / "model.pt"
    torch.save({
        "schema": "archie-scratch-hybrid-model/v1", "config": asdict(cfg),
        "model": raw_model.state_dict(),
    }, export_path)
    atomic_json(output / "config.json", asdict(cfg))
    atomic_json(output / "tokenizer.json", ByteTokenizer.metadata())
    prompt = torch.tensor([ByteTokenizer.encode(args.prompt, bos=True)], dtype=torch.long, device=device)
    generated = raw_model.generate(
        prompt, args.generate_tokens, temperature=args.temperature, top_k=args.top_k
    )[0].tolist()
    sample = ByteTokenizer.decode(generated)
    (output / "sample.txt").write_text(sample + "\n", encoding="utf-8")
    receipt = {
        "schema": SCHEMA, "method": METHOD,
        "training_origin": "random initialization; raw text next-token training; no pretrained model, teacher logits, or distillation",
        "model": {
            "config": asdict(cfg), "parameters": params, "full_parameter_training": True,
            "checkpoint_sha256": sha256_file(checkpoint_path),
            "export_sha256": sha256_file(export_path),
        },
        "tokenizer": ByteTokenizer.metadata(), "corpus": metadata,
        "optimization": {
            "step": train_state.step, "max_steps": args.max_steps,
            "tokens_seen": train_state.tokens_seen, "batch_size": args.batch_size,
            "gradient_accumulation": args.grad_accum, "sequence_length": args.seq_len,
            "learning_rate": args.learning_rate, "weight_decay": args.weight_decay,
            "warmup_steps": args.warmup_steps,
            "gradient_checkpointing": args.gradient_checkpointing,
            "amp_dtype": str(amp_dtype) if amp_dtype is not None else None,
            "resumed": resumed, "stop_reason": stop_reason, "loss_history": history,
            "final_eval_loss": final_eval_loss,
            "best_eval_loss": train_state.best_eval_loss,
            "perplexity": math.exp(min(final_eval_loss, 20.0)),
        },
        "runtime": {
            "seconds": time.monotonic() - start, "python": platform.python_version(),
            "platform": platform.platform(), "torch": torch.__version__,
            "numpy": np.__version__, "device": str(device), "cuda": torch.version.cuda,
            "gpu": torch.cuda.get_device_name(device) if device.type == "cuda" else None,
        },
        "sample": sample, "promotion": "not-admitted",
        "claim_boundary": "A from-scratch neural model was trained and exported. Capability beyond measured loss and samples remains unproven until independent evaluation.",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    receipt["receipt_digest"] = hashlib.sha256(stable_json(receipt).encode()).hexdigest()
    atomic_json(output / "training-receipt.json", receipt)
    print(json.dumps(receipt, indent=2, sort_keys=True))
    return receipt


def selftest(root: pathlib.Path) -> dict[str, Any]:
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    corpus = root / "selftest.u16"
    text = (
        "Archie reasons from evidence and emits verifiable plans. "
        "Selective state spaces remember context while local attention resolves relations.\n"
    ) * 128
    metadata = build_u16_corpus(corpus, [("selftest", text)], max_tokens=None)
    tokens = np.memmap(corpus, dtype="<u2", mode="r")
    assert int(tokens[0]) == BOS_ID and EOS_ID in tokens and SEP_ID in tokens
    del tokens
    run_root = root / "run-state"
    common = [
        sys.executable, str(pathlib.Path(__file__).resolve()), "--corpus", str(corpus),
        "--state-dir", str(run_root), "--preset", "micro", "--device", "cpu",
        "--seq-len", "24", "--batch-size", "1", "--eval-batch-size", "1",
        "--grad-accum", "1", "--learning-rate", "0.003", "--weight-decay", "0.01",
        "--warmup-steps", "1", "--save-every", "1", "--eval-every", "1",
        "--eval-batches", "1", "--log-every", "1", "--generate-tokens", "4",
        "--deadline-minutes", "0", "--seed", "7",
    ]
    first = subprocess.run([*common, "--max-steps", "2"], text=True, capture_output=True)
    if first.returncode:
        raise RuntimeError(first.stdout + first.stderr)
    first_receipt = json.loads((run_root / "run/training-receipt.json").read_text())
    if first_receipt["optimization"]["step"] != 2 or first_receipt["optimization"]["resumed"]:
        raise AssertionError("fresh checkpoint phase failed")
    second = subprocess.run([*common, "--max-steps", "4"], text=True, capture_output=True)
    if second.returncode:
        raise RuntimeError(second.stdout + second.stderr)
    receipt = json.loads((run_root / "run/training-receipt.json").read_text())
    if receipt["optimization"]["step"] != 4 or not receipt["optimization"]["resumed"]:
        raise AssertionError("resume phase failed")
    result = {
        "schema": "archie-scratch-hybrid-selftest/v1",
        "u16_special_ids_preserved": True, "forward": True, "backward": True,
        "checkpoint": True, "resume": True, "evaluation": True, "generation": True,
        "corpus_sha256": metadata["sha256"], "model_parameters": receipt["model"]["parameters"],
        "final_step": receipt["optimization"]["step"],
        "tokens_seen": receipt["optimization"]["tokens_seen"],
        "final_eval_loss": receipt["optimization"]["final_eval_loss"],
        "receipt_digest": receipt["receipt_digest"], "sample": receipt["sample"],
    }
    atomic_json(root / "selftest-result.json", result)
    print(json.dumps(result, indent=2, sort_keys=True))
    return result


def parser() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--tiny-selftest", action="store_true")
    cli.add_argument("--state-dir", default="archie_scratch_state")
    cli.add_argument("--corpus")
    cli.add_argument("--build-corpus", action="store_true")
    cli.add_argument("--source", action="append", default=[])
    cli.add_argument("--hf-source", action="append", default=[])
    cli.add_argument("--max-corpus-tokens", type=int)
    cli.add_argument("--max-file-bytes", type=int, default=8 << 20)
    cli.add_argument("--preset", choices=["auto", *PRESETS], default="auto")
    cli.add_argument("--device", default="auto")
    cli.add_argument("--seq-len", type=int, default=512)
    cli.add_argument("--batch-size", type=int, default=2)
    cli.add_argument("--eval-batch-size", type=int, default=2)
    cli.add_argument("--grad-accum", type=int, default=8)
    cli.add_argument("--max-steps", type=int, default=10_000)
    cli.add_argument("--learning-rate", type=float, default=3e-4)
    cli.add_argument("--min-lr-ratio", type=float, default=0.1)
    cli.add_argument("--warmup-steps", type=int, default=200)
    cli.add_argument("--weight-decay", type=float, default=0.1)
    cli.add_argument("--grad-clip", type=float, default=1.0)
    cli.add_argument("--seed", type=int, default=1337)
    cli.add_argument("--deadline-minutes", type=float, default=320)
    cli.add_argument("--deadline-buffer-seconds", type=int, default=180)
    cli.add_argument("--save-every", type=int, default=100)
    cli.add_argument("--eval-every", type=int, default=100)
    cli.add_argument("--eval-batches", type=int, default=8)
    cli.add_argument("--log-every", type=int, default=10)
    cli.add_argument("--gradient-checkpointing", action=argparse.BooleanOptionalAction, default=True)
    cli.add_argument("--compile", action=argparse.BooleanOptionalAction, default=False)
    cli.add_argument("--no-resume", action="store_true")
    cli.add_argument("--prompt", default="Archie analyzes the evidence and")
    cli.add_argument("--generate-tokens", type=int, default=128)
    cli.add_argument("--temperature", type=float, default=0.8)
    cli.add_argument("--top-k", type=int, default=40)
    return cli


def main() -> None:
    args = parser().parse_args()
    state_dir = pathlib.Path(args.state_dir).resolve()
    if args.tiny_selftest:
        selftest(state_dir)
        return
    state_dir.mkdir(parents=True, exist_ok=True)
    device = torch.device(args.device if args.device != "auto"
                          else ("cuda" if torch.cuda.is_available() else "cpu"))
    preset = choose_auto_preset(device) if args.preset == "auto" else args.preset
    cfg = dataclasses.replace(PRESETS[preset], max_seq_len=max(PRESETS[preset].max_seq_len, args.seq_len))
    corpus_path = pathlib.Path(args.corpus).resolve() if args.corpus else state_dir / "corpus.u16"
    if args.build_corpus or not corpus_path.exists():
        documents = iter_local_documents([pathlib.Path(item) for item in args.source], args.max_file_bytes)
        if args.hf_source:
            documents = itertools.chain(documents, iter_hf_documents(args.hf_source, args.seed))
        build_u16_corpus(corpus_path, documents, max_tokens=args.max_corpus_tokens)
    receipt = train(args, cfg, corpus_path, state_dir / "run")
    if receipt["optimization"]["stop_reason"] == "deadline":
        print("deadline checkpoint saved; rerun the same command to resume", file=sys.stderr)


if __name__ == "__main__":
    main()
