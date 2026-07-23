#!/usr/bin/env python3
"""Train the sparse world-state core around an existing Archie language shell."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import pathlib
import random
import tempfile
from dataclasses import asdict
from typing import Any

import numpy as np
import torch

from archie_world_state_core import (
    ByteTokenizer,
    LANGUAGE_CONFIG_FIELDS,
    MODEL_SCHEMA,
    PRESETS,
    ArchieWorldStateLM,
    WorldStateConfig,
    load_language_shell,
    parameter_count,
    state_dependency_metrics,
)

RECEIPT_SCHEMA = "archie-world-state-training-receipt/v1"


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class TokenSampler:
    def __init__(self, path: pathlib.Path, seq_len: int, batch_size: int, seed: int) -> None:
        self.tokens = np.memmap(path, dtype="<u2", mode="r")
        if len(self.tokens) <= seq_len + 1:
            raise ValueError("corpus is shorter than one training sequence")
        self.seq_len = seq_len
        self.batch_size = batch_size
        self.rng = random.Random(seed)

    def batch(self, device: torch.device) -> torch.Tensor:
        maximum = len(self.tokens) - self.seq_len - 1
        rows = []
        for _ in range(self.batch_size):
            offset = self.rng.randint(0, maximum)
            rows.append(np.asarray(self.tokens[offset:offset + self.seq_len + 1], dtype=np.int64))
        return torch.from_numpy(np.stack(rows)).to(device)


def tokenizer_metadata(payload: dict[str, Any] | None) -> dict[str, Any]:
    if payload and isinstance(payload.get("tokenizer"), dict):
        return dict(payload["tokenizer"])
    return {
        "schema": "archie-byte-tokenizer/v1",
        "encoding": "utf-8-bytes",
        "vocab_size": ByteTokenizer.vocab_size,
        "special_tokens": {"pad": 256, "bos": 257, "eos": 258, "sep": 259},
    }


def evaluate(model: ArchieWorldStateLM, sampler: TokenSampler, batches: int) -> dict[str, float]:
    model.eval()
    total_loss = 0.0
    total_state = 0.0
    probe = None
    with torch.no_grad():
        for _ in range(batches):
            batch = sampler.batch(next(model.parameters()).device)
            output = model(batch, batch)
            total_loss += float(output["lm_loss"].cpu())
            total_state += float(output["state_loss"].cpu())
            if probe is None:
                split = max(model.cfg.event_size, batch.size(1) // 2)
                split = min(split, batch.size(1) - 1)
                support = batch[:, :split]
                query = batch[:, split:]
                state = model(support)["world_state"]
                probe = state_dependency_metrics(model, query, state)
    mean_loss = total_loss / max(batches, 1)
    result = {
        "loss": mean_loss,
        "bits_per_token": mean_loss / math.log(2.0),
        "state_loss": total_state / max(batches, 1),
    }
    result.update(probe or {})
    return result


def build_config(
    args: argparse.Namespace, source_payload: dict[str, Any] | None = None
) -> WorldStateConfig:
    values = asdict(PRESETS[args.preset])
    if source_payload is not None:
        source_config = source_payload.get("config", source_payload.get("model_config", {}))
        if not isinstance(source_config, dict):
            raise ValueError("initial model configuration is missing")
        for name in LANGUAGE_CONFIG_FIELDS:
            if name not in source_config:
                raise ValueError(f"initial model configuration is missing {name}")
            values[name] = source_config[name]
    if args.seq_len + 1 > int(values["max_seq_len"]):
        raise ValueError("seq_len exceeds the preserved language shell context")
    values.update(
        event_size=args.event_size,
        state_slots=args.state_slots,
        state_top_k=args.state_top_k,
        state_quant_bits=args.state_quant_bits,
        state_aux_weight=args.state_aux_weight,
        action_count=args.action_count,
    )
    return WorldStateConfig(**values)


def run(args: argparse.Namespace) -> dict[str, Any]:
    torch.manual_seed(args.seed)
    random.seed(args.seed)
    np.random.seed(args.seed)
    device = torch.device(args.device)
    train_path = pathlib.Path(args.train_corpus).resolve()
    eval_path = pathlib.Path(args.eval_corpus).resolve()
    output_dir = pathlib.Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    source_payload = None
    source_path = None
    if args.initialize_from:
        source_path = pathlib.Path(args.initialize_from).resolve()
        source_payload = torch.load(source_path, map_location="cpu", weights_only=False)
    cfg = build_config(args, source_payload)
    model = ArchieWorldStateLM(cfg).to(device)
    warm_start = None
    if source_payload is not None and source_path is not None:
        warm_start = load_language_shell(model, source_payload)
        warm_start["source_sha256"] = sha256_file(source_path)
    if args.freeze_language_steps > 0:
        model.set_language_shell_trainable(False)
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=args.learning_rate, weight_decay=args.weight_decay,
        betas=(0.9, 0.95), eps=1e-8,
    )
    train_sampler = TokenSampler(train_path, args.seq_len, args.batch_size, args.seed)
    eval_sampler = TokenSampler(eval_path, args.seq_len, args.eval_batch_size, args.seed ^ 0xA5A5)
    history: list[dict[str, float]] = []
    for step in range(1, args.steps + 1):
        if step == args.freeze_language_steps + 1 and args.freeze_language_steps > 0:
            model.set_language_shell_trainable(True)
        model.train()
        batch = train_sampler.batch(device)
        output = model(batch, batch)
        optimizer.zero_grad(set_to_none=True)
        output["loss"].backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), args.grad_clip)
        optimizer.step()
        if step == 1 or step % args.eval_every == 0 or step == args.steps:
            metrics = evaluate(model, eval_sampler, args.eval_batches)
            metrics.update(step=float(step), train_loss=float(output["loss"].detach().cpu()))
            history.append(metrics)
    model_path = output_dir / "archie-world-state.pt"
    payload = {
        "schema": MODEL_SCHEMA,
        "config": asdict(cfg),
        "model": model.state_dict(),
        "tokenizer": tokenizer_metadata(source_payload),
        "warm_start": warm_start,
    }
    torch.save(payload, model_path)
    receipt = {
        "schema": RECEIPT_SCHEMA,
        "method": "sparse-event-world-state-with-language-shell-probation/v1",
        "model_sha256": sha256_file(model_path),
        "train_corpus_sha256": sha256_file(train_path),
        "eval_corpus_sha256": sha256_file(eval_path),
        "config": asdict(cfg),
        "parameters": parameter_count(model),
        "warm_start": warm_start,
        "freeze_language_steps": args.freeze_language_steps,
        "history": history,
        "promotion": "research-candidate-not-admitted",
        "claim_boundary": (
            "This run proves only that the current language shell can be preserved while a bounded, "
            "quantized recurrent state path is trained. Promotion still requires frozen correct-state "
            "versus wrong-state transfer and matched-resource retention evidence."
        ),
    }
    receipt_path = output_dir / "receipt.json"
    receipt_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return receipt


def selftest() -> None:
    with tempfile.TemporaryDirectory() as temporary:
        root = pathlib.Path(temporary)
        tokens = np.asarray(([257] + list(b"stateful world model ") + [258, 259]) * 30, dtype="<u2")
        train = root / "train.u16"
        eval_ = root / "eval.u16"
        tokens.tofile(train)
        tokens[::-1].copy().tofile(eval_)
        args = argparse.Namespace(
            train_corpus=str(train), eval_corpus=str(eval_), output_dir=str(root / "out"),
            preset="micro", initialize_from=None, steps=2, batch_size=2, eval_batch_size=2,
            seq_len=24, eval_every=1, eval_batches=1, learning_rate=1e-3,
            weight_decay=0.0, grad_clip=1.0, freeze_language_steps=1, seed=9, device="cpu",
            event_size=8, state_slots=4, state_top_k=1, state_quant_bits=8,
            state_aux_weight=0.25, action_count=0,
        )
        receipt = run(args)
        assert pathlib.Path(args.output_dir, "archie-world-state.pt").exists()
        assert len(receipt["history"]) == 2
        assert all(math.isfinite(item["loss"]) for item in receipt["history"])
        print(json.dumps({"selftest": "passed", "model_sha256": receipt["model_sha256"]}))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--train-corpus")
    parser.add_argument("--eval-corpus")
    parser.add_argument("--output-dir")
    parser.add_argument("--preset", choices=sorted(PRESETS), default="micro")
    parser.add_argument("--initialize-from")
    parser.add_argument("--steps", type=int, default=1000)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--eval-batch-size", type=int, default=8)
    parser.add_argument("--seq-len", type=int, default=128)
    parser.add_argument("--eval-every", type=int, default=100)
    parser.add_argument("--eval-batches", type=int, default=8)
    parser.add_argument("--learning-rate", type=float, default=3e-4)
    parser.add_argument("--weight-decay", type=float, default=0.1)
    parser.add_argument("--grad-clip", type=float, default=1.0)
    parser.add_argument("--freeze-language-steps", type=int, default=250)
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--event-size", type=int, default=16)
    parser.add_argument("--state-slots", type=int, default=8)
    parser.add_argument("--state-top-k", type=int, default=2)
    parser.add_argument("--state-quant-bits", type=int, choices=(0, 4, 8), default=8)
    parser.add_argument("--state-aux-weight", type=float, default=0.25)
    parser.add_argument("--action-count", type=int, default=0)
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()
    if args.selftest:
        selftest()
        return
    if not args.train_corpus or not args.eval_corpus or not args.output_dir:
        parser.error("--train-corpus, --eval-corpus, and --output-dir are required")
    print(json.dumps(run(args), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
