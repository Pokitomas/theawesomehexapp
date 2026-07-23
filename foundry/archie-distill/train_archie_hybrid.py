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
import torch.nn.functional as F

from archie_hybrid_core import (
    BOS_ID, EOS_ID, PAD_ID, SEP_ID, ByteTokenizer, ArchieHybridLM, ModelConfig, PRESETS,
    METHOD, choose_auto_preset, parameter_count,
)
from archie_hybrid_corpus import (
    atomic_json, build_u16_corpus, iter_hf_documents, iter_local_documents,
    sha256_file, stable_json, verify_u16_corpus,
)
from archie_tokenizers import ArchieTokenizer, token_byte_lengths, tokenizer_from_metadata

SCHEMA = "archie-scratch-hybrid-training-receipt/v1"
CHECKPOINT_SCHEMA = "archie-scratch-hybrid-checkpoint/v2"
LEGACY_CHECKPOINT_SCHEMA = "archie-scratch-hybrid-checkpoint/v1"
TRAINING_CONTRACT_SCHEMA = "archie-scratch-hybrid-training-contract/v1"
SAMPLING_POLICY = "uniform-random-contiguous-window/v1"
TRAINING_CODE_FILES = (
    "train_archie_hybrid.py",
    "archie_hybrid_core.py",
    "archie_hybrid_corpus.py",
    "archie_tokenizers.py",
)
PLASTIC_CONFIG_FIELDS = {
    "plastic_mode",
    "plastic_rank",
    "plastic_retention_floor",
    "plastic_write_scale",
    "plastic_state_clip",
    "plastic_detach_every",
}


def is_plastic_upgrade(source: ModelConfig, target: ModelConfig) -> bool:
    source_values = asdict(source)
    target_values = asdict(target)
    return (
        source.plastic_mode == "none"
        and target.plastic_mode == "delta"
        and all(
            source_values[name] == target_values[name]
            for name in source_values
            if name not in PLASTIC_CONFIG_FIELDS
        )
    )


def load_initial_weights(
    model: ArchieHybridLM, payload: dict[str, Any], target: ModelConfig,
    allow_plastic_upgrade: bool,
) -> str:
    source = ModelConfig(**payload.get("config", {}))
    if source == target:
        model.load_state_dict(payload["model"])
        return "exact"
    if not allow_plastic_upgrade or not is_plastic_upgrade(source, target):
        raise SystemExit("initial model configuration does not match")
    incompatible = model.load_state_dict(payload["model"], strict=False)
    expected_missing = {
        name for name in model.state_dict()
        if name.startswith("plastic_norm.") or name.startswith("plastic_memory.")
    }
    if set(incompatible.missing_keys) != expected_missing or incompatible.unexpected_keys:
        raise SystemExit("plastic upgrade changed weights outside the new plastic module")
    return "plastic-module-added"


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
    bytes_seen: int = 0
    best_eval_loss: float = float("inf")
    best_eval_bits_per_byte: float = float("inf")


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
    torch.set_rng_state(state["torch"].cpu())
    if torch.cuda.is_available() and "cuda" in state:
        torch.cuda.set_rng_state_all([item.cpu() for item in state["cuda"]])


def training_code_identity() -> dict[str, str]:
    directory = pathlib.Path(__file__).resolve().parent
    return {name: sha256_file(directory / name) for name in TRAINING_CODE_FILES}


def build_training_contract(
    args: argparse.Namespace, cfg: ModelConfig, train_metadata: dict[str, Any],
    eval_metadata: dict[str, Any], train_lineage_digest: str,
    initialized_from: str | None, device: torch.device,
    amp_dtype: torch.dtype | None,
) -> dict[str, Any]:
    capability = None
    gpu_name = None
    if device.type == "cuda":
        capability = list(torch.cuda.get_device_capability(device))
        gpu_name = torch.cuda.get_device_name(device)
    return {
        "schema": TRAINING_CONTRACT_SCHEMA,
        "model": asdict(cfg),
        "data": {
            "train_corpus_sha256": train_metadata["sha256"],
            "train_lineage_sha256": train_lineage_digest,
            "evaluation_corpus_sha256": eval_metadata["sha256"],
            "tokenizer": train_metadata["tokenizer"],
            "initialized_from_sha256": initialized_from,
        },
        "sampling": {
            "policy": SAMPLING_POLICY,
            "sequence_length": args.seq_len,
            "seed": int(args.seed),
            "train_sampler_seed": int(args.seed),
            "evaluation_sampler_seed": int(args.seed) ^ 0xA5A5A5A5,
            "train_batch_size": args.batch_size,
            "evaluation_batch_size": args.eval_batch_size,
        },
        "optimization": {
            "optimizer": "AdamW",
            "betas": [0.9, 0.95],
            "epsilon": 1e-8,
            "fused": device.type == "cuda",
            "gradient_accumulation": args.grad_accum,
            "learning_rate": args.learning_rate,
            "weight_decay": args.weight_decay,
            "gradient_clip": args.grad_clip,
            "max_consecutive_skips": args.max_consecutive_skips,
            "loss_normalization": args.loss_normalization,
        },
        "schedule": {
            "policy": "linear-warmup-cosine-decay/v1",
            "maximum_steps": args.max_steps,
            "warmup_steps": args.warmup_steps,
            "minimum_learning_rate_ratio": args.min_lr_ratio,
        },
        "measurement": {
            "evaluation_every_steps": args.eval_every,
            "evaluation_batches": args.eval_batches,
            "checkpoint_every_steps": args.save_every,
            "log_every_steps": args.log_every,
        },
        "execution": {
            "gradient_checkpointing": args.gradient_checkpointing,
            "tf32": args.tf32,
            "compile": args.compile,
            "requested_amp_dtype": args.amp_dtype,
            "resolved_amp_dtype": str(amp_dtype) if amp_dtype is not None else None,
            "device_type": device.type,
            "gpu_name": gpu_name,
            "cuda_compute_capability": capability,
            "torch_version": torch.__version__,
            "cuda_version": torch.version.cuda,
        },
        "code_sha256": training_code_identity(),
    }


def contract_digest(contract: dict[str, Any]) -> str:
    return hashlib.sha256(stable_json(contract).encode()).hexdigest()


def contract_differences(saved: Any, current: Any, prefix: str = "") -> list[str]:
    if isinstance(saved, dict) and isinstance(current, dict):
        differences: list[str] = []
        for key in sorted(set(saved) | set(current)):
            path = f"{prefix}.{key}" if prefix else key
            if key not in saved:
                differences.append(f"{path}: missing from checkpoint")
            elif key not in current:
                differences.append(f"{path}: missing from invocation")
            else:
                differences.extend(contract_differences(saved[key], current[key], path))
        return differences
    if saved != current:
        return [f"{prefix}: checkpoint={saved!r}, invocation={current!r}"]
    return []


def save_checkpoint(path: pathlib.Path, model: torch.nn.Module,
                    optimizer: torch.optim.Optimizer,
                    scheduler: torch.optim.lr_scheduler.LRScheduler,
                    scaler: Any, train_state: TrainState,
                    train_sampler: TokenSampler, eval_sampler: TokenSampler,
                    cfg: ModelConfig, train_corpus_digest: str,
                    eval_corpus_digest: str,
                    loss_history: list[dict[str, float]],
                    training_contract: dict[str, Any],
                    training_contract_digest: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    torch.save({
        "schema": CHECKPOINT_SCHEMA,
        "model_config": asdict(cfg), "model": model.state_dict(),
        "optimizer": optimizer.state_dict(), "scheduler": scheduler.state_dict(),
        "scaler": scaler.state_dict() if scaler is not None else None,
        "train_state": asdict(train_state), "train_sampler": train_sampler.state_dict(),
        "eval_sampler": eval_sampler.state_dict(), "rng": rng_state(),
        "corpus_sha256": train_corpus_digest,
        "train_corpus_sha256": train_corpus_digest,
        "eval_corpus_sha256": eval_corpus_digest,
        "training_contract": training_contract,
        "training_contract_digest": training_contract_digest,
        "loss_history": loss_history,
    }, temporary)
    os.replace(temporary, path)


def load_checkpoint(path: pathlib.Path, model: torch.nn.Module,
                    optimizer: torch.optim.Optimizer,
                    scheduler: torch.optim.lr_scheduler.LRScheduler,
                    scaler: Any, train_sampler: TokenSampler,
                    eval_sampler: TokenSampler, cfg: ModelConfig,
                    train_corpus_digest: str, eval_corpus_digest: str,
                    device: torch.device, training_contract: dict[str, Any],
                    training_contract_digest: str, adopt_legacy: bool,
                    ) -> tuple[TrainState, list[dict[str, float]], bool]:
    payload = torch.load(path, map_location=device, weights_only=False)
    schema = payload.get("schema")
    legacy_adopted = False
    if schema == CHECKPOINT_SCHEMA:
        saved_contract = payload.get("training_contract")
        saved_digest = payload.get("training_contract_digest")
        if not isinstance(saved_contract, dict) or saved_digest != contract_digest(saved_contract):
            raise SystemExit("checkpoint training contract is missing or corrupt")
        if saved_digest != training_contract_digest:
            differences = contract_differences(saved_contract, training_contract)
            detail = "\n".join(f"  - {item}" for item in differences[:16])
            raise SystemExit(
                "checkpoint training contract does not match this invocation"
                + (f":\n{detail}" if detail else "")
            )
    elif schema == LEGACY_CHECKPOINT_SCHEMA:
        if not adopt_legacy:
            raise SystemExit(
                "legacy checkpoint has no complete training contract; inspect it, then rerun once "
                "with --adopt-legacy-checkpoint to migrate it"
            )
        legacy_adopted = True
    else:
        raise SystemExit("unsupported checkpoint schema")
    if ModelConfig(**payload.get("model_config", {})) != cfg:
        raise SystemExit("checkpoint model configuration does not match")
    saved_train_digest = payload.get("train_corpus_sha256", payload.get("corpus_sha256"))
    saved_eval_digest = payload.get("eval_corpus_sha256", saved_train_digest)
    if saved_train_digest != train_corpus_digest:
        raise SystemExit("checkpoint training-corpus digest does not match")
    if saved_eval_digest != eval_corpus_digest:
        raise SystemExit("checkpoint evaluation-corpus digest does not match")
    model.load_state_dict(payload["model"])
    optimizer.load_state_dict(payload["optimizer"])
    scheduler.load_state_dict(payload["scheduler"])
    if scaler is not None and payload.get("scaler") is not None:
        scaler.load_state_dict(payload["scaler"])
    train_sampler.load_state_dict(payload["train_sampler"])
    eval_sampler.load_state_dict(payload["eval_sampler"])
    restore_rng_state(payload["rng"])
    return (
        TrainState(**payload["train_state"]),
        list(payload.get("loss_history") or []),
        legacy_adopted,
    )


def next_token_statistics(
    logits: torch.Tensor, labels: torch.Tensor, byte_lengths: torch.Tensor
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    targets = labels[:, 1:].contiguous()
    losses = F.cross_entropy(
        logits[:, :-1].contiguous().float().view(-1, logits.size(-1)),
        targets.view(-1), ignore_index=PAD_ID, reduction="none",
    ).view_as(targets)
    valid = targets.ne(PAD_ID)
    nats = losses.masked_select(valid).sum()
    token_count = valid.sum()
    byte_count = byte_lengths[targets].masked_select(valid).sum()
    return nats, token_count, byte_count


def normalized_loss(
    nats: torch.Tensor, token_count: torch.Tensor, byte_count: torch.Tensor,
    normalization: str,
) -> torch.Tensor:
    denominator = byte_count if normalization == "byte" else token_count
    return nats / denominator.clamp(min=1)


@torch.no_grad()
def evaluate(model: ArchieHybridLM, sampler: TokenSampler, device: torch.device,
             batches: int, amp_dtype: torch.dtype | None,
             byte_lengths: torch.Tensor, normalization: str) -> dict[str, float]:
    model.eval()
    total_nats = total_tokens = total_bytes = 0.0
    for _ in range(batches):
        batch = sampler.batch(device)
        inputs = batch[:, :-1]
        with torch.autocast(device_type=device.type, dtype=amp_dtype, enabled=amp_dtype is not None):
            logits = model(inputs)["logits"]
        nats, tokens, bytes_ = next_token_statistics(logits, inputs, byte_lengths)
        total_nats += float(nats.detach().cpu())
        total_tokens += float(tokens.detach().cpu())
        total_bytes += float(bytes_.detach().cpu())
    objective_denominator = total_bytes if normalization == "byte" else total_tokens
    return {
        "loss": total_nats / max(objective_denominator, 1.0),
        "nats_per_token": total_nats / max(total_tokens, 1.0),
        "bits_per_byte": total_nats / max(total_bytes, 1.0) / math.log(2.0),
        "evaluated_tokens": total_tokens,
        "evaluated_bytes": total_bytes,
    }


def cosine_lambda(step: int, warmup: int, total: int, min_ratio: float) -> float:
    if step < warmup:
        return max((step + 1) / max(warmup, 1), 1e-3)
    progress = min(max((step - warmup) / max(total - warmup, 1), 0.0), 1.0)
    return min_ratio + 0.5 * (1.0 - min_ratio) * (1.0 + math.cos(math.pi * progress))


def corpus_lineage_digest(metadata: dict[str, Any]) -> str:
    contract = metadata.get("curriculum_contract_digest")
    if not contract:
        return str(metadata["sha256"])
    return hashlib.sha256(
        stable_json({"corpus_sha256": metadata["sha256"], "curriculum_contract": contract}).encode()
    ).hexdigest()


def train(args: argparse.Namespace, cfg: ModelConfig, corpus_path: pathlib.Path,
          output: pathlib.Path) -> dict[str, Any]:
    metadata = verify_u16_corpus(corpus_path)
    eval_corpus_path = pathlib.Path(args.eval_corpus).resolve() if args.eval_corpus else corpus_path
    eval_metadata = verify_u16_corpus(eval_corpus_path)
    if eval_metadata["tokenizer"] != metadata["tokenizer"]:
        raise SystemExit("training and evaluation corpora use different tokenizers")
    tokenizer: ArchieTokenizer = tokenizer_from_metadata(metadata["tokenizer"])
    if cfg.vocab_size != tokenizer.vocab_size:
        raise SystemExit("model vocabulary does not match corpus tokenizer")
    seed = int(args.seed)
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    device = torch.device(args.device if args.device != "auto"
                          else ("cuda" if torch.cuda.is_available() else "cpu"))
    if device.type == "cuda":
        torch.backends.cuda.matmul.allow_tf32 = args.tf32
        torch.backends.cudnn.allow_tf32 = args.tf32
        torch.cuda.reset_peak_memory_stats(device)
    model = ArchieHybridLM(cfg, gradient_checkpointing=args.gradient_checkpointing).to(device)
    params = parameter_count(model)
    if args.compile and hasattr(torch, "compile"):
        model = torch.compile(model)  # type: ignore[assignment]
    train_sampler = TokenSampler(corpus_path, args.seq_len, args.batch_size, seed)
    eval_sampler = TokenSampler(
        eval_corpus_path, args.seq_len, args.eval_batch_size, seed ^ 0xA5A5A5A5
    )
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
        if args.amp_dtype == "float32":
            amp_dtype = None
        elif args.amp_dtype == "bfloat16":
            amp_dtype = torch.bfloat16
        elif args.amp_dtype == "float16":
            amp_dtype = torch.float16
        else:
            major, _ = torch.cuda.get_device_capability(device)
            amp_dtype = torch.bfloat16 if major >= 8 and torch.cuda.is_bf16_supported() else torch.float16
        scaler = torch.amp.GradScaler("cuda", enabled=amp_dtype == torch.float16)
    byte_lengths = torch.tensor(
        token_byte_lengths(metadata["tokenizer"]), dtype=torch.long, device=device
    )
    checkpoint_path = output / "checkpoint.pt"
    train_lineage_digest = corpus_lineage_digest(metadata)
    initialized_from = sha256_file(pathlib.Path(args.init_model).resolve()) if args.init_model else None
    training_contract = build_training_contract(
        args, cfg, metadata, eval_metadata, train_lineage_digest,
        initialized_from, device, amp_dtype,
    )
    training_contract_digest = contract_digest(training_contract)
    train_state, history, resumed = TrainState(), [], False
    legacy_checkpoint_adopted = False
    warm_start_mode = None
    if checkpoint_path.exists() and not args.no_resume:
        train_state, history, legacy_checkpoint_adopted = load_checkpoint(
            checkpoint_path, model, optimizer, scheduler, scaler, train_sampler,
            eval_sampler, cfg, train_lineage_digest, eval_metadata["sha256"], device,
            training_contract, training_contract_digest, args.adopt_legacy_checkpoint,
        )
        resumed = True
        warm_start_mode = "resumed-checkpoint"
    elif args.init_model:
        init_path = pathlib.Path(args.init_model).resolve()
        init_payload = torch.load(init_path, map_location=device, weights_only=False)
        if init_payload.get("schema") != "archie-scratch-hybrid-model/v1":
            raise SystemExit("initial model schema is unsupported")
        init_tokenizer = init_payload.get("tokenizer") or ByteTokenizer.metadata()
        if init_tokenizer != metadata["tokenizer"]:
            raise SystemExit("initial model tokenizer does not match corpus tokenizer")
        raw_model = model._orig_mod if hasattr(model, "_orig_mod") else model
        warm_start_mode = load_initial_weights(
            raw_model, init_payload, cfg, args.allow_plastic_upgrade
        )
    curriculum_student = metadata.get("curriculum_student_model_sha256")
    if curriculum_student and initialized_from != curriculum_student:
        raise SystemExit("curriculum exchange belongs to a different student model")
    starting_tokens = train_state.tokens_seen
    starting_bytes = train_state.bytes_seen
    starting_step = train_state.step
    start = time.monotonic()
    deadline = start + args.deadline_minutes * 60 if args.deadline_minutes > 0 else float("inf")
    model.train()
    optimizer.zero_grad(set_to_none=True)
    stop_reason = "max_steps"
    skipped_steps = 0
    consecutive_skipped_steps = 0
    while train_state.step < args.max_steps:
        if (
            args.invocation_step_limit > 0
            and train_state.step - starting_step >= args.invocation_step_limit
        ):
            stop_reason = "invocation_step_limit"
            break
        if time.monotonic() >= deadline - args.deadline_buffer_seconds:
            stop_reason = "deadline"
            break
        aggregate_loss = 0.0
        for _ in range(args.grad_accum):
            batch = train_sampler.batch(device)
            inputs = batch[:, :-1]
            with torch.autocast(device_type=device.type, dtype=amp_dtype, enabled=amp_dtype is not None):
                logits = model(inputs)["logits"]
                nats, token_count, byte_count = next_token_statistics(
                    logits, inputs, byte_lengths
                )
                objective = normalized_loss(
                    nats, token_count, byte_count, args.loss_normalization
                )
                loss = objective / args.grad_accum
            if scaler is not None:
                scaler.scale(loss).backward()
            else:
                loss.backward()
            aggregate_loss += float(objective.detach().cpu()) / args.grad_accum
            train_state.tokens_seen += inputs.numel()
            batch_bytes = int(byte_count.detach().cpu())
            train_state.bytes_seen += batch_bytes
        if scaler is not None:
            scaler.unscale_(optimizer)
        grad_norm = float(torch.nn.utils.clip_grad_norm_(model.parameters(), args.grad_clip).detach().cpu())
        # Never let a non-finite gradient (NaN/inf) reach the optimizer: applying it
        # would irreversibly corrupt every parameter and destroy the whole run. On the
        # free-tier CPU lane a run is expensive, so skip the update, preserve the last
        # good weights, and continue. Skips are counted into the receipt for honesty.
        step_applied = math.isfinite(grad_norm) and math.isfinite(aggregate_loss)
        if step_applied:
            consecutive_skipped_steps = 0
            if scaler is not None:
                scaler.step(optimizer)
                scaler.update()
            else:
                optimizer.step()
        else:
            skipped_steps += 1
            consecutive_skipped_steps += 1
            if scaler is not None:
                scaler.update()
        optimizer.zero_grad(set_to_none=True)
        scheduler.step()
        train_state.step += 1
        record = {
            "step": float(train_state.step), "loss": aggregate_loss,
            "learning_rate": float(optimizer.param_groups[0]["lr"]),
            "grad_norm": grad_norm, "tokens_seen": float(train_state.tokens_seen),
            "bytes_seen": float(train_state.bytes_seen),
            "step_applied": step_applied,
        }
        history.append(record)
        if consecutive_skipped_steps >= args.max_consecutive_skips:
            stop_reason = "nonfinite_gradients"
            break
        if train_state.step % args.log_every == 0:
            print(json.dumps(record, sort_keys=True), flush=True)
        if train_state.step % args.eval_every == 0:
            evaluation = evaluate(
                model, eval_sampler, device, args.eval_batches, amp_dtype,
                byte_lengths, args.loss_normalization,
            )
            train_state.best_eval_loss = min(train_state.best_eval_loss, evaluation["loss"])
            train_state.best_eval_bits_per_byte = min(
                train_state.best_eval_bits_per_byte, evaluation["bits_per_byte"]
            )
            history[-1].update({f"eval_{key}": value for key, value in evaluation.items()})
            model.train()
        if train_state.step % args.save_every == 0:
            save_checkpoint(
                checkpoint_path, model, optimizer, scheduler, scaler, train_state,
                train_sampler, eval_sampler, cfg, train_lineage_digest,
                eval_metadata["sha256"], history, training_contract,
                training_contract_digest,
            )
    final_evaluation = evaluate(
        model, eval_sampler, device, args.eval_batches, amp_dtype,
        byte_lengths, args.loss_normalization,
    )
    final_eval_loss = final_evaluation["loss"]
    train_state.best_eval_loss = min(train_state.best_eval_loss, final_eval_loss)
    train_state.best_eval_bits_per_byte = min(
        train_state.best_eval_bits_per_byte, final_evaluation["bits_per_byte"]
    )
    save_checkpoint(
        checkpoint_path, model, optimizer, scheduler, scaler, train_state,
        train_sampler, eval_sampler, cfg, train_lineage_digest,
        eval_metadata["sha256"], history, training_contract,
        training_contract_digest,
    )
    raw_model = model._orig_mod if hasattr(model, "_orig_mod") else model
    export_path = output / "model.pt"
    torch.save({
        "schema": "archie-scratch-hybrid-model/v1", "config": asdict(cfg),
        "model": raw_model.state_dict(), "tokenizer": metadata["tokenizer"],
    }, export_path)
    atomic_json(output / "config.json", asdict(cfg))
    atomic_json(output / "tokenizer.json", metadata["tokenizer"])
    prompt_tokens = tokenizer.encode(args.prompt, bos=True)
    prompt = torch.tensor([prompt_tokens], dtype=torch.long, device=device)
    generated = raw_model.generate(
        prompt, args.generate_tokens, temperature=args.temperature, top_k=args.top_k
    )[0].tolist()
    sample = tokenizer.decode(generated)
    (output / "sample.txt").write_text(sample + "\n", encoding="utf-8")
    receipt = {
        "schema": SCHEMA,
        "method": f"{METHOD}:{cfg.mixer_mode}:plastic-{cfg.plastic_mode}",
        "training_origin": (
            "warm-started from an Archie scratch-hybrid model; full-parameter local next-token training"
            if initialized_from or args.init_model else
            "random initialization; raw text next-token training; no pretrained model, teacher logits, or distillation"
        ),
        "model": {
            "config": asdict(cfg), "parameters": params, "full_parameter_training": True,
            "initialized_from_sha256": initialized_from,
            "warm_start_mode": warm_start_mode,
            "checkpoint_sha256": sha256_file(checkpoint_path),
            "export_sha256": sha256_file(export_path),
        },
        "tokenizer": metadata["tokenizer"], "corpus": metadata,
        "evaluation_corpus": eval_metadata,
        "evaluation_is_independent": eval_metadata["sha256"] != metadata["sha256"],
        "training_contract": training_contract,
        "training_contract_digest": training_contract_digest,
        "optimization": {
            "step": train_state.step, "max_steps": args.max_steps,
            "tokens_seen": train_state.tokens_seen, "bytes_seen": train_state.bytes_seen,
            "batch_size": args.batch_size,
            "gradient_accumulation": args.grad_accum, "sequence_length": args.seq_len,
            "learning_rate": args.learning_rate, "weight_decay": args.weight_decay,
            "warmup_steps": args.warmup_steps,
            "loss_normalization": args.loss_normalization,
            "gradient_checkpointing": args.gradient_checkpointing,
            "tf32": args.tf32, "compile": args.compile,
            "amp_dtype": str(amp_dtype) if amp_dtype is not None else None,
            "resumed": resumed,
            "legacy_checkpoint_adopted": legacy_checkpoint_adopted,
            "invocation_step_limit": args.invocation_step_limit,
            "stop_reason": stop_reason, "loss_history": history,
            "final_eval_loss": final_eval_loss,
            "best_eval_loss": train_state.best_eval_loss,
            "final_eval_nats_per_token": final_evaluation["nats_per_token"],
            "final_eval_bits_per_byte": final_evaluation["bits_per_byte"],
            "best_eval_bits_per_byte": train_state.best_eval_bits_per_byte,
            "perplexity": math.exp(min(final_evaluation["nats_per_token"], 20.0)),
            "skipped_nonfinite_steps": skipped_steps,
            "max_consecutive_skips": args.max_consecutive_skips,
        },
        "runtime": {
            "seconds": time.monotonic() - start, "python": platform.python_version(),
            "platform": platform.platform(), "torch": torch.__version__,
            "numpy": np.__version__, "device": str(device), "cuda": torch.version.cuda,
            "gpu": torch.cuda.get_device_name(device) if device.type == "cuda" else None,
            "peak_allocated_mib": (
                torch.cuda.max_memory_allocated(device) / 2**20 if device.type == "cuda" else None
            ),
            "peak_reserved_mib": (
                torch.cuda.max_memory_reserved(device) / 2**20 if device.type == "cuda" else None
            ),
            "tokens_per_second": (
                train_state.tokens_seen - starting_tokens
            ) / max(time.monotonic() - start, 1e-9),
            "bytes_per_second": (
                train_state.bytes_seen - starting_bytes
            ) / max(time.monotonic() - start, 1e-9),
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
    eval_corpus = root / "selftest-development.u16"
    build_u16_corpus(
        eval_corpus,
        [("selftest-development", text.replace("evidence", "heldout evidence"))],
        max_tokens=None,
    )
    init_model = root / "initial-model.pt"
    initial = ArchieHybridLM(PRESETS["micro"])
    torch.save(
        {
            "schema": "archie-scratch-hybrid-model/v1",
            "config": asdict(PRESETS["micro"]),
            "model": initial.state_dict(),
        },
        init_model,
    )
    tokens = np.memmap(corpus, dtype="<u2", mode="r")
    assert int(tokens[0]) == BOS_ID and EOS_ID in tokens and SEP_ID in tokens
    del tokens
    run_root = root / "run-state"
    common = [
        sys.executable, str(pathlib.Path(__file__).resolve()), "--corpus", str(corpus),
        "--eval-corpus", str(eval_corpus), "--init-model", str(init_model),
        "--state-dir", str(run_root), "--preset", "micro", "--device", "cpu",
        "--seq-len", "12", "--batch-size", "1", "--eval-batch-size", "1",
        "--grad-accum", "1", "--learning-rate", "0.003", "--weight-decay", "0.01",
        "--warmup-steps", "1", "--save-every", "1", "--eval-every", "1",
        "--eval-batches", "1", "--log-every", "1", "--generate-tokens", "2",
        "--deadline-minutes", "0", "--seed", "7",
    ]
    first = subprocess.run(
        [*common, "--max-steps", "4", "--invocation-step-limit", "2"],
        text=True, capture_output=True,
    )
    if first.returncode:
        raise RuntimeError(first.stdout + first.stderr)
    first_receipt = json.loads((run_root / "run/training-receipt.json").read_text())
    if first_receipt["optimization"]["step"] != 2 or first_receipt["optimization"]["resumed"]:
        raise AssertionError("fresh checkpoint phase failed")
    if not first_receipt["evaluation_is_independent"]:
        raise AssertionError("independent evaluation corpus was not recorded")
    if first_receipt["model"]["initialized_from_sha256"] != sha256_file(init_model):
        raise AssertionError("warm-start model identity was not recorded")
    checkpoint_path = run_root / "run/checkpoint.pt"
    legacy_payload = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    legacy_payload["schema"] = LEGACY_CHECKPOINT_SCHEMA
    legacy_payload.pop("training_contract", None)
    legacy_payload.pop("training_contract_digest", None)
    torch.save(legacy_payload, checkpoint_path)
    rejected_legacy = subprocess.run(
        [*common, "--max-steps", "4"], text=True, capture_output=True,
    )
    if rejected_legacy.returncode == 0 or "--adopt-legacy-checkpoint" not in (
        rejected_legacy.stdout + rejected_legacy.stderr
    ):
        raise AssertionError("legacy checkpoint was not rejected by default")
    second = subprocess.run(
        [*common, "--max-steps", "4", "--adopt-legacy-checkpoint"],
        text=True, capture_output=True,
    )
    if second.returncode:
        raise RuntimeError(second.stdout + second.stderr)
    receipt = json.loads((run_root / "run/training-receipt.json").read_text())
    if receipt["optimization"]["step"] != 4 or not receipt["optimization"]["resumed"]:
        raise AssertionError("resume phase failed")
    if not receipt["optimization"]["legacy_checkpoint_adopted"]:
        raise AssertionError("legacy checkpoint adoption was not receipted")
    mismatch = subprocess.run(
        [*common, "--max-steps", "4", "--learning-rate", "0.004"],
        text=True, capture_output=True,
    )
    if mismatch.returncode == 0 or "training contract does not match" not in (
        mismatch.stdout + mismatch.stderr
    ):
        raise AssertionError("changed training geometry was not rejected")
    result = {
        "schema": "archie-scratch-hybrid-selftest/v1",
        "u16_special_ids_preserved": True, "forward": True, "backward": True,
        "checkpoint": True, "resume": True, "warm_start": True,
        "legacy_checkpoint_migration": True, "training_contract_enforced": True,
        "independent_evaluation": True, "evaluation": True, "generation": True,
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
    cli.add_argument("--eval-corpus")
    cli.add_argument("--init-model")
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
    cli.add_argument(
        "--invocation-step-limit", type=int, default=0,
        help="stop this invocation after N updates without changing the run contract",
    )
    cli.add_argument("--learning-rate", type=float, default=3e-4)
    cli.add_argument("--min-lr-ratio", type=float, default=0.1)
    cli.add_argument("--warmup-steps", type=int, default=200)
    cli.add_argument("--weight-decay", type=float, default=0.1)
    cli.add_argument("--grad-clip", type=float, default=1.0)
    cli.add_argument("--max-consecutive-skips", type=int, default=8)
    cli.add_argument("--seed", type=int, default=1337)
    cli.add_argument("--deadline-minutes", type=float, default=320)
    cli.add_argument("--deadline-buffer-seconds", type=int, default=180)
    cli.add_argument("--save-every", type=int, default=100)
    cli.add_argument("--eval-every", type=int, default=100)
    cli.add_argument("--eval-batches", type=int, default=8)
    cli.add_argument("--log-every", type=int, default=10)
    cli.add_argument("--gradient-checkpointing", action=argparse.BooleanOptionalAction, default=True)
    cli.add_argument("--tf32", action=argparse.BooleanOptionalAction, default=True)
    cli.add_argument(
        "--amp-dtype", choices=["auto", "float16", "bfloat16", "float32"], default="auto"
    )
    cli.add_argument("--compile", action=argparse.BooleanOptionalAction, default=False)
    cli.add_argument("--mixer-mode", choices=["hybrid", "attention", "ssm"], default="hybrid")
    cli.add_argument("--plastic-mode", choices=["none", "delta"], default="none")
    cli.add_argument("--plastic-rank", type=int, default=16)
    cli.add_argument("--allow-plastic-upgrade", action="store_true")
    cli.add_argument("--loss-normalization", choices=["token", "byte"], default="token")
    cli.add_argument("--no-resume", action="store_true")
    cli.add_argument(
        "--adopt-legacy-checkpoint", action="store_true",
        help="explicitly migrate one v1 checkpoint that predates strict run contracts",
    )
    cli.add_argument("--prompt", default="Archie analyzes the evidence and")
    cli.add_argument("--generate-tokens", type=int, default=128)
    cli.add_argument("--temperature", type=float, default=0.8)
    cli.add_argument("--top-k", type=int, default=40)
    return cli


def main() -> None:
    args = parser().parse_args()
    if args.invocation_step_limit < 0:
        raise SystemExit("--invocation-step-limit must be nonnegative")
    state_dir = pathlib.Path(args.state_dir).resolve()
    if args.tiny_selftest:
        selftest(state_dir)
        return
    state_dir.mkdir(parents=True, exist_ok=True)
    device = torch.device(args.device if args.device != "auto"
                          else ("cuda" if torch.cuda.is_available() else "cpu"))
    preset = choose_auto_preset(device) if args.preset == "auto" else args.preset
    corpus_path = pathlib.Path(args.corpus).resolve() if args.corpus else state_dir / "corpus.u16"
    if args.build_corpus or not corpus_path.exists():
        documents = iter_local_documents([pathlib.Path(item) for item in args.source], args.max_file_bytes)
        if args.hf_source:
            documents = itertools.chain(documents, iter_hf_documents(args.hf_source, args.seed))
        build_u16_corpus(corpus_path, documents, max_tokens=args.max_corpus_tokens)
    corpus_metadata = verify_u16_corpus(corpus_path)
    cfg = dataclasses.replace(
        PRESETS[preset],
        max_seq_len=max(PRESETS[preset].max_seq_len, args.seq_len),
        mixer_mode=args.mixer_mode,
        plastic_mode=args.plastic_mode,
        plastic_rank=args.plastic_rank,
        vocab_size=int(corpus_metadata["tokenizer"]["vocab_size"]),
    )
    receipt = train(args, cfg, corpus_path, state_dir / "run")
    if receipt["optimization"]["stop_reason"] == "deadline":
        print("deadline checkpoint saved; rerun the same command to resume", file=sys.stderr)


if __name__ == "__main__":
    main()
