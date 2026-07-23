#!/usr/bin/env python3
"""Resumable mixed-precision training for Archie's persistent world-state core."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import pathlib
import platform
import random
import shutil
import tempfile
import time
from dataclasses import asdict, dataclass
from typing import Any

import numpy as np
import torch
import torch.utils.checkpoint

from archie_tokenizers import tokenizer_from_metadata
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

RECEIPT_SCHEMA = "archie-world-state-maximal-training-receipt/v1"
CHECKPOINT_SCHEMA = "archie-world-state-maximal-checkpoint/v1"
CONTRACT_SCHEMA = "archie-world-state-maximal-contract/v1"


def stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def code_identity() -> dict[str, str]:
    here = pathlib.Path(__file__).resolve().parent
    names = (
        pathlib.Path(__file__).name,
        "archie_world_state_core.py",
        "archie_hybrid_core.py",
        "archie_tokenizers.py",
    )
    return {name: sha256_file(here / name) for name in names}


class TokenSampler:
    def __init__(self, path: pathlib.Path, seq_len: int, batch_size: int, seed: int) -> None:
        self.tokens = np.memmap(path, dtype="<u2", mode="r")
        if len(self.tokens) <= seq_len + 1:
            raise ValueError("corpus is shorter than one training sequence")
        self.seq_len = seq_len
        self.batch_size = batch_size
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
            rows.append(
                np.asarray(self.tokens[offset:offset + self.seq_len + 1], dtype=np.int64)
            )
        return torch.from_numpy(np.stack(rows)).to(
            device=device, non_blocking=device.type == "cuda"
        )


@dataclass
class TrainState:
    step: int = 0
    attempts: int = 0
    tokens_seen: int = 0
    best_eval_loss: float = float("inf")
    best_state_effect: float = 0.0
    consecutive_skips: int = 0
    skipped_steps: int = 0


def rng_state() -> dict[str, Any]:
    result: dict[str, Any] = {
        "python": random.getstate(),
        "numpy": np.random.get_state(),
        "torch": torch.get_rng_state(),
    }
    if torch.cuda.is_available():
        result["cuda"] = torch.cuda.get_rng_state_all()
    return result


def restore_rng_state(state: dict[str, Any]) -> None:
    random.setstate(state["python"])
    np.random.set_state(state["numpy"])
    torch.set_rng_state(state["torch"].cpu())
    if torch.cuda.is_available() and "cuda" in state:
        torch.cuda.set_rng_state_all([item.cpu() for item in state["cuda"]])


def tokenizer_metadata(payload: dict[str, Any] | None) -> dict[str, Any]:
    if payload and isinstance(payload.get("tokenizer"), dict):
        return dict(payload["tokenizer"])
    return {
        "schema": "archie-byte-tokenizer/v1",
        "encoding": "utf-8-bytes",
        "vocab_size": ByteTokenizer.vocab_size,
        "special_tokens": {"pad": 256, "bos": 257, "eos": 258, "sep": 259},
    }


def build_config(
    args: argparse.Namespace, source_payload: dict[str, Any] | None
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
        raise ValueError("seq_len exceeds the preserved language-shell context")
    values.update(
        event_size=args.event_size,
        state_slots=args.state_slots,
        state_top_k=args.state_top_k,
        state_quant_bits=args.state_quant_bits,
        state_aux_weight=args.state_aux_weight,
        action_count=args.action_count,
    )
    return WorldStateConfig(**values)


def initialize_model(
    model: ArchieWorldStateLM, payload: dict[str, Any] | None
) -> dict[str, Any] | None:
    if payload is None:
        return None
    if payload.get("schema") == MODEL_SCHEMA:
        source_config = payload.get("config")
        source_state = payload.get("model")
        if not isinstance(source_config, dict) or not isinstance(source_state, dict):
            raise ValueError("world-state source is incomplete")
        source_values = dict(source_config)
        target_values = asdict(model.cfg)
        for allowed_difference in ("state_quant_bits", "state_aux_weight"):
            source_values.pop(allowed_difference, None)
            target_values.pop(allowed_difference, None)
        if source_values != target_values:
            raise ValueError(
                "world-state continuation may change only state_quant_bits or state_aux_weight"
            )
        model.load_state_dict(source_state)
        return {"mode": "full-world-state-warm-start", "copied_tensors": len(source_state)}
    return load_language_shell(model, payload)


def enable_gradient_checkpointing(model: ArchieWorldStateLM) -> None:
    """Checkpoint every language block without changing state-dict names."""
    for block in model.blocks:
        if getattr(block, "_archie_gradient_checkpointed", False):
            continue
        original_forward = block.forward

        def checkpointed_forward(
            x: torch.Tensor,
            _original=original_forward,
            _model=model,
        ) -> torch.Tensor:
            if _model.training and torch.is_grad_enabled():
                return torch.utils.checkpoint.checkpoint(
                    _original, x, use_reentrant=False
                )
            return _original(x)

        block.forward = checkpointed_forward  # type: ignore[method-assign]
        block._archie_gradient_checkpointed = True  # type: ignore[attr-defined]


def resolve_amp_dtype(name: str, device: torch.device) -> torch.dtype | None:
    if device.type != "cuda" or name == "float32":
        return None
    if name == "auto":
        return torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    return {"float16": torch.float16, "bfloat16": torch.bfloat16}[name]


def make_optimizer(
    model: ArchieWorldStateLM,
    args: argparse.Namespace,
    device: torch.device,
) -> torch.optim.Optimizer:
    groups = [
        {
            "params": list(model.state_parameters()),
            "lr": args.learning_rate,
            "name": "world-state",
        },
        {
            "params": list(model.language_shell_parameters()),
            "lr": args.learning_rate * args.language_lr_scale,
            "name": "language-shell",
        },
    ]
    kwargs = {
        "betas": (0.9, 0.95),
        "eps": 1e-8,
        "weight_decay": args.weight_decay,
    }
    if device.type == "cuda":
        try:
            return torch.optim.AdamW(groups, fused=True, **kwargs)
        except (TypeError, RuntimeError):
            pass
    return torch.optim.AdamW(groups, **kwargs)


def schedule_factor(step: int, args: argparse.Namespace) -> float:
    if args.warmup_steps > 0 and step < args.warmup_steps:
        return max((step + 1) / args.warmup_steps, 1e-8)
    progress = (step - args.warmup_steps) / max(args.steps - args.warmup_steps, 1)
    progress = min(max(progress, 0.0), 1.0)
    cosine = 0.5 * (1.0 + math.cos(math.pi * progress))
    return args.min_lr_ratio + (1.0 - args.min_lr_ratio) * cosine


def build_contract(
    args: argparse.Namespace,
    cfg: WorldStateConfig,
    train_path: pathlib.Path,
    eval_path: pathlib.Path,
    source_path: pathlib.Path | None,
    device: torch.device,
    amp_dtype: torch.dtype | None,
) -> dict[str, Any]:
    return {
        "schema": CONTRACT_SCHEMA,
        "config": asdict(cfg),
        "data": {
            "train_sha256": sha256_file(train_path),
            "eval_sha256": sha256_file(eval_path),
            "initialize_from_sha256": sha256_file(source_path) if source_path else None,
        },
        "optimization": {
            "steps": args.steps,
            "batch_size": args.batch_size,
            "eval_batch_size": args.eval_batch_size,
            "sequence_length": args.seq_len,
            "gradient_accumulation": args.grad_accum,
            "learning_rate": args.learning_rate,
            "language_lr_scale": args.language_lr_scale,
            "weight_decay": args.weight_decay,
            "gradient_clip": args.grad_clip,
            "warmup_steps": args.warmup_steps,
            "minimum_lr_ratio": args.min_lr_ratio,
            "freeze_language_steps": args.freeze_language_steps,
            "maximum_consecutive_skips": args.max_consecutive_skips,
        },
        "execution": {
            "seed": args.seed,
            "gradient_checkpointing": args.gradient_checkpointing,
            "requested_amp_dtype": args.amp_dtype,
            "resolved_amp_dtype": str(amp_dtype) if amp_dtype is not None else "float32",
            "device_type": device.type,
            "torch_version": torch.__version__,
            "cuda_version": torch.version.cuda,
        },
        "code_sha256": code_identity(),
    }


def contract_digest(contract: dict[str, Any]) -> str:
    return hashlib.sha256(stable_json(contract).encode()).hexdigest()


def atomic_torch_save(payload: Any, path: pathlib.Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    torch.save(payload, temporary)
    os.replace(temporary, path)


def save_checkpoint(
    path: pathlib.Path,
    model: ArchieWorldStateLM,
    optimizer: torch.optim.Optimizer,
    scheduler: torch.optim.lr_scheduler.LRScheduler,
    scaler: Any,
    state: TrainState,
    train_sampler: TokenSampler,
    eval_sampler: TokenSampler,
    history: list[dict[str, Any]],
    contract: dict[str, Any],
    digest: str,
) -> None:
    atomic_torch_save(
        {
            "schema": CHECKPOINT_SCHEMA,
            "model": model.state_dict(),
            "optimizer": optimizer.state_dict(),
            "scheduler": scheduler.state_dict(),
            "scaler": scaler.state_dict() if scaler is not None else None,
            "train_state": asdict(state),
            "train_sampler": train_sampler.state_dict(),
            "eval_sampler": eval_sampler.state_dict(),
            "rng": rng_state(),
            "history": history,
            "contract": contract,
            "contract_digest": digest,
        },
        path,
    )


def load_checkpoint(
    path: pathlib.Path,
    model: ArchieWorldStateLM,
    optimizer: torch.optim.Optimizer,
    scheduler: torch.optim.lr_scheduler.LRScheduler,
    scaler: Any,
    train_sampler: TokenSampler,
    eval_sampler: TokenSampler,
    digest: str,
    device: torch.device,
) -> tuple[TrainState, list[dict[str, Any]]]:
    payload = torch.load(path, map_location=device, weights_only=False)
    if payload.get("schema") != CHECKPOINT_SCHEMA:
        raise SystemExit("unsupported world-state checkpoint")
    saved_contract = payload.get("contract")
    if (
        not isinstance(saved_contract, dict)
        or payload.get("contract_digest") != contract_digest(saved_contract)
        or payload.get("contract_digest") != digest
    ):
        raise SystemExit("world-state checkpoint contract does not match this invocation")
    model.load_state_dict(payload["model"])
    optimizer.load_state_dict(payload["optimizer"])
    scheduler.load_state_dict(payload["scheduler"])
    if scaler is not None and payload.get("scaler") is not None:
        scaler.load_state_dict(payload["scaler"])
    train_sampler.load_state_dict(payload["train_sampler"])
    eval_sampler.load_state_dict(payload["eval_sampler"])
    restore_rng_state(payload["rng"])
    return TrainState(**payload["train_state"]), list(payload.get("history") or [])


@torch.no_grad()
def evaluate(
    model: ArchieWorldStateLM,
    sampler: TokenSampler,
    batches: int,
    device: torch.device,
    amp_dtype: torch.dtype | None,
) -> dict[str, float]:
    model.eval()
    totals = {"loss": 0.0, "lm_loss": 0.0, "state_loss": 0.0}
    diagnostic: dict[str, float] = {}
    for index in range(batches):
        batch = sampler.batch(device)
        with torch.autocast(
            device_type=device.type,
            dtype=amp_dtype,
            enabled=amp_dtype is not None,
        ):
            output = model(batch, batch, return_diagnostics=index == 0)
        for name in totals:
            totals[name] += float(output[name].float().cpu())
        if index == 0:
            split = min(max(model.cfg.event_size, batch.size(1) // 2), batch.size(1) - 1)
            support = batch[:1, :split]
            query = batch[:1, split:]
            support_state = model(support)["world_state"]
            diagnostic.update(state_dependency_metrics(model, query, support_state))
            diagnostic.update(
                state_gate_mean=float(output["state_gate_mean"].float().cpu()),
                state_l2=float(output["state_l2"].float().cpu()),
                active_slot_fraction=float(output["active_slot_fraction"].float().cpu()),
            )
    result = {name: value / max(batches, 1) for name, value in totals.items()}
    result["bits_per_token"] = result["lm_loss"] / math.log(2.0)
    result.update(diagnostic)
    return result


def export_model(
    path: pathlib.Path,
    model: ArchieWorldStateLM,
    cfg: WorldStateConfig,
    metadata: dict[str, Any],
    warm_start: dict[str, Any] | None,
    training: dict[str, Any],
) -> None:
    atomic_torch_save(
        {
            "schema": MODEL_SCHEMA,
            "config": asdict(cfg),
            "model": model.state_dict(),
            "tokenizer": metadata,
            "warm_start": warm_start,
            "training": training,
        },
        path,
    )


def run(args: argparse.Namespace) -> dict[str, Any]:
    torch.manual_seed(args.seed)
    random.seed(args.seed)
    np.random.seed(args.seed)
    device = torch.device(args.device)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise SystemExit("CUDA was requested but is unavailable")
    if device.type == "cuda":
        torch.backends.cuda.matmul.allow_tf32 = args.tf32
        torch.backends.cudnn.allow_tf32 = args.tf32
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()

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
    warm_start = initialize_model(model, source_payload)
    if warm_start is not None and source_path is not None:
        warm_start["source_sha256"] = sha256_file(source_path)
    if args.gradient_checkpointing:
        enable_gradient_checkpointing(model)
    model.set_language_shell_trainable(args.freeze_language_steps <= 0)

    optimizer = make_optimizer(model, args, device)
    scheduler = torch.optim.lr_scheduler.LambdaLR(
        optimizer, lr_lambda=lambda step: schedule_factor(step, args)
    )
    amp_dtype = resolve_amp_dtype(args.amp_dtype, device)
    scaler = torch.amp.GradScaler(
        "cuda", enabled=device.type == "cuda" and amp_dtype == torch.float16
    )
    train_sampler = TokenSampler(train_path, args.seq_len, args.batch_size, args.seed)
    eval_sampler = TokenSampler(
        eval_path, args.seq_len, args.eval_batch_size, args.seed ^ 0xA5A5A5A5
    )
    contract = build_contract(
        args, cfg, train_path, eval_path, source_path, device, amp_dtype
    )
    digest = contract_digest(contract)
    checkpoint_path = output_dir / "checkpoint.pt"
    model_path = output_dir / "archie-world-state.pt"
    best_path = output_dir / "best-archie-world-state.pt"
    state = TrainState()
    history: list[dict[str, Any]] = []
    resumed = False
    if checkpoint_path.exists() and not args.no_resume:
        state, history = load_checkpoint(
            checkpoint_path,
            model,
            optimizer,
            scheduler,
            scaler,
            train_sampler,
            eval_sampler,
            digest,
            device,
        )
        resumed = True
    model.set_language_shell_trainable(state.step >= args.freeze_language_steps)

    started = time.monotonic()
    starting_tokens = state.tokens_seen
    stop_reason = "maximum_steps"
    invocation_updates = 0
    while state.step < args.steps:
        if args.invocation_step_limit and invocation_updates >= args.invocation_step_limit:
            stop_reason = "invocation_step_limit"
            break
        if args.deadline_minutes > 0:
            remaining = args.deadline_minutes * 60 - (time.monotonic() - started)
            if remaining <= args.deadline_buffer_seconds:
                stop_reason = "deadline"
                break
        if state.step == args.freeze_language_steps:
            model.set_language_shell_trainable(True)

        model.train()
        optimizer.zero_grad(set_to_none=True)
        aggregate = {"loss": 0.0, "lm_loss": 0.0, "state_loss": 0.0}
        batch_tokens = 0
        state.attempts += 1
        for _ in range(args.grad_accum):
            batch = train_sampler.batch(device)
            batch_tokens += batch.numel()
            with torch.autocast(
                device_type=device.type,
                dtype=amp_dtype,
                enabled=amp_dtype is not None,
            ):
                output = model(batch, batch)
                scaled_loss = output["loss"] / args.grad_accum
            scaler.scale(scaled_loss).backward()
            for name in aggregate:
                aggregate[name] += float(output[name].detach().float().cpu()) / args.grad_accum

        scaler.unscale_(optimizer)
        grad_norm = float(
            torch.nn.utils.clip_grad_norm_(model.parameters(), args.grad_clip)
            .detach()
            .float()
            .cpu()
        )
        finite = math.isfinite(grad_norm) and all(
            math.isfinite(value) for value in aggregate.values()
        )
        if finite:
            scaler.step(optimizer)
            scaler.update()
            state.consecutive_skips = 0
        else:
            state.skipped_steps += 1
            state.consecutive_skips += 1
            scaler.update()
        scheduler.step()
        state.step += 1
        invocation_updates += 1
        state.tokens_seen += batch_tokens
        record: dict[str, Any] = {
            "step": state.step,
            "attempt": state.attempts,
            "tokens_seen": state.tokens_seen,
            "gradient_norm": grad_norm,
            "step_applied": finite,
            "language_shell_trainable": state.step > args.freeze_language_steps,
            "learning_rates": [float(group["lr"]) for group in optimizer.param_groups],
            **{f"train_{name}": value for name, value in aggregate.items()},
        }

        should_eval = (
            state.step == 1
            or state.step % args.eval_every == 0
            or state.step == args.steps
        )
        if should_eval:
            metrics = evaluate(
                model, eval_sampler, args.eval_batches, device, amp_dtype
            )
            record.update({f"eval_{name}": value for name, value in metrics.items()})
            previous_best = state.best_eval_loss
            state.best_eval_loss = min(state.best_eval_loss, metrics["lm_loss"])
            state_effect = metrics.get("adapted_vs_wrong_logit_mae", 0.0)
            state.best_state_effect = max(state.best_state_effect, state_effect)
            if metrics["lm_loss"] <= previous_best:
                export_model(
                    best_path,
                    model,
                    cfg,
                    tokenizer_metadata(source_payload),
                    warm_start,
                    {"step": state.step, "contract_digest": digest},
                )
            model.train()
        history.append(record)
        if state.step == 1 or state.step % args.log_every == 0 or should_eval:
            print(json.dumps(record, sort_keys=True), flush=True)
        if state.step % args.save_every == 0:
            save_checkpoint(
                checkpoint_path,
                model,
                optimizer,
                scheduler,
                scaler,
                state,
                train_sampler,
                eval_sampler,
                history,
                contract,
                digest,
            )
        if state.consecutive_skips >= args.max_consecutive_skips:
            stop_reason = "nonfinite_gradients"
            break

    final_metrics = evaluate(model, eval_sampler, args.eval_batches, device, amp_dtype)
    save_checkpoint(
        checkpoint_path,
        model,
        optimizer,
        scheduler,
        scaler,
        state,
        train_sampler,
        eval_sampler,
        history,
        contract,
        digest,
    )
    export_model(
        model_path,
        model,
        cfg,
        tokenizer_metadata(source_payload),
        warm_start,
        {"step": state.step, "contract_digest": digest},
    )

    sample = None
    if args.generate_tokens > 0:
        tokenizer = tokenizer_from_metadata(tokenizer_metadata(source_payload))
        prompt_ids = tokenizer.encode(args.prompt, bos=True)
        prompt = torch.tensor([prompt_ids], dtype=torch.long, device=device)
        generated, _ = model.generate_with_state(
            prompt,
            args.generate_tokens,
            temperature=args.temperature,
            top_k=args.top_k,
        )
        sample = tokenizer.decode(generated[0].tolist())
        (output_dir / "sample.txt").write_text(sample + "\n", encoding="utf-8")

    runtime_seconds = time.monotonic() - started
    receipt = {
        "schema": RECEIPT_SCHEMA,
        "method": "resumable-mixed-precision-sparse-world-state-probation/v1",
        "model_sha256": sha256_file(model_path),
        "best_model_sha256": sha256_file(best_path) if best_path.exists() else None,
        "checkpoint_sha256": sha256_file(checkpoint_path),
        "contract": contract,
        "contract_digest": digest,
        "warm_start": warm_start,
        "training": {
            **asdict(state),
            "resumed": resumed,
            "stop_reason": stop_reason,
            "invocation_updates": invocation_updates,
            "final_metrics": final_metrics,
            "history": history,
        },
        "runtime": {
            "seconds": runtime_seconds,
            "tokens_per_second": (
                state.tokens_seen - starting_tokens
            ) / max(runtime_seconds, 1e-9),
            "python": platform.python_version(),
            "platform": platform.platform(),
            "torch": torch.__version__,
            "device": str(device),
            "gpu": torch.cuda.get_device_name(device) if device.type == "cuda" else None,
            "peak_allocated_mib": (
                torch.cuda.max_memory_allocated(device) / 2**20
                if device.type == "cuda"
                else None
            ),
            "peak_reserved_mib": (
                torch.cuda.max_memory_reserved(device) / 2**20
                if device.type == "cuda"
                else None
            ),
        },
        "sample": sample,
        "promotion": "research-candidate-not-admitted",
        "claim_boundary": (
            "The run may establish a trained low-bit persistent-state candidate. "
            "Breakthrough requires frozen correct-state versus reset and wrong-state gains, "
            "matched baseline retention, replication, and practical throughput."
        ),
    }
    receipt["receipt_digest"] = hashlib.sha256(stable_json(receipt).encode()).hexdigest()
    (output_dir / "receipt.json").write_text(
        json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(json.dumps(receipt, indent=2, sort_keys=True))
    return receipt


def selftest() -> None:
    from archie_hybrid_core import ArchieHybridLM

    with tempfile.TemporaryDirectory() as temporary:
        root = pathlib.Path(temporary)
        tokens = np.asarray(
            ([257] + list(b"persistent state maps evidence to action ") + [258, 259]) * 48,
            dtype="<u2",
        )
        train = root / "train.u16"
        eval_path = root / "eval.u16"
        tokens.tofile(train)
        np.roll(tokens, 7).tofile(eval_path)
        source_model = ArchieHybridLM(PRESETS["micro"])
        source = root / "source.pt"
        torch.save(
            {
                "schema": "archie-scratch-hybrid-model/v1",
                "config": asdict(PRESETS["micro"]),
                "model": source_model.state_dict(),
                "tokenizer": tokenizer_metadata(None),
            },
            source,
        )
        common = dict(
            train_corpus=str(train),
            eval_corpus=str(eval_path),
            output_dir=str(root / "q8"),
            preset="micro",
            initialize_from=str(source),
            steps=4,
            batch_size=1,
            eval_batch_size=1,
            seq_len=24,
            grad_accum=1,
            eval_every=1,
            eval_batches=1,
            learning_rate=1e-3,
            language_lr_scale=0.1,
            weight_decay=0.0,
            grad_clip=1.0,
            warmup_steps=1,
            min_lr_ratio=0.1,
            freeze_language_steps=2,
            save_every=1,
            log_every=10,
            max_consecutive_skips=2,
            seed=9,
            device="cpu",
            amp_dtype="float32",
            gradient_checkpointing=True,
            tf32=False,
            event_size=8,
            state_slots=4,
            state_top_k=1,
            state_quant_bits=8,
            state_aux_weight=0.25,
            action_count=0,
            deadline_minutes=0.0,
            deadline_buffer_seconds=0,
            invocation_step_limit=2,
            no_resume=False,
            generate_tokens=0,
            prompt="Archie",
            temperature=0.8,
            top_k=20,
        )
        first = run(argparse.Namespace(**common))
        assert first["training"]["step"] == 2
        common["invocation_step_limit"] = 0
        second = run(argparse.Namespace(**common))
        assert second["training"]["step"] == 4
        assert second["training"]["resumed"]
        q8_model = pathlib.Path(common["output_dir"]) / "archie-world-state.pt"
        q4 = dict(common)
        q4.update(
            output_dir=str(root / "q4"),
            initialize_from=str(q8_model),
            steps=1,
            freeze_language_steps=0,
            state_quant_bits=4,
            invocation_step_limit=0,
        )
        third = run(argparse.Namespace(**q4))
        assert third["warm_start"]["mode"] == "full-world-state-warm-start"
        print(
            json.dumps(
                {
                    "selftest": "passed",
                    "resume": True,
                    "gradient_checkpointing": True,
                    "mixed_precision_path": True,
                    "q8_to_q4_continuation": True,
                },
                sort_keys=True,
            )
        )


def parser() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--train-corpus")
    cli.add_argument("--eval-corpus")
    cli.add_argument("--output-dir")
    cli.add_argument("--preset", choices=sorted(PRESETS), default="small")
    cli.add_argument("--initialize-from")
    cli.add_argument("--steps", type=int, default=12_000)
    cli.add_argument("--batch-size", type=int, default=1)
    cli.add_argument("--eval-batch-size", type=int, default=1)
    cli.add_argument("--seq-len", type=int, default=1024)
    cli.add_argument("--grad-accum", type=int, default=12)
    cli.add_argument("--eval-every", type=int, default=250)
    cli.add_argument("--eval-batches", type=int, default=8)
    cli.add_argument("--learning-rate", type=float, default=2e-4)
    cli.add_argument("--language-lr-scale", type=float, default=0.1)
    cli.add_argument("--weight-decay", type=float, default=0.1)
    cli.add_argument("--grad-clip", type=float, default=1.0)
    cli.add_argument("--warmup-steps", type=int, default=500)
    cli.add_argument("--min-lr-ratio", type=float, default=0.1)
    cli.add_argument("--freeze-language-steps", type=int, default=3000)
    cli.add_argument("--save-every", type=int, default=100)
    cli.add_argument("--log-every", type=int, default=10)
    cli.add_argument("--max-consecutive-skips", type=int, default=8)
    cli.add_argument("--seed", type=int, default=20260723)
    cli.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    cli.add_argument(
        "--amp-dtype",
        choices=("auto", "float16", "bfloat16", "float32"),
        default="auto",
    )
    cli.add_argument(
        "--gradient-checkpointing",
        action=argparse.BooleanOptionalAction,
        default=True,
    )
    cli.add_argument("--tf32", action=argparse.BooleanOptionalAction, default=True)
    cli.add_argument("--event-size", type=int, default=16)
    cli.add_argument("--state-slots", type=int, default=8)
    cli.add_argument("--state-top-k", type=int, default=2)
    cli.add_argument("--state-quant-bits", type=int, choices=(0, 4, 8), default=8)
    cli.add_argument("--state-aux-weight", type=float, default=0.25)
    cli.add_argument("--action-count", type=int, default=0)
    cli.add_argument("--deadline-minutes", type=float, default=330)
    cli.add_argument("--deadline-buffer-seconds", type=int, default=180)
    cli.add_argument("--invocation-step-limit", type=int, default=0)
    cli.add_argument("--no-resume", action="store_true")
    cli.add_argument("--generate-tokens", type=int, default=32)
    cli.add_argument("--prompt", default="Archie updates its state from verified evidence and")
    cli.add_argument("--temperature", type=float, default=0.8)
    cli.add_argument("--top-k", type=int, default=40)
    cli.add_argument("--selftest", action="store_true")
    return cli


def main() -> None:
    args = parser().parse_args()
    if args.selftest:
        selftest()
        return
    if not args.train_corpus or not args.eval_corpus or not args.output_dir:
        parser().error("--train-corpus, --eval-corpus, and --output-dir are required")
    if args.steps < 1 or args.batch_size < 1 or args.grad_accum < 1:
        raise SystemExit("steps, batch-size, and grad-accum must be positive")
    if not 0.0 <= args.language_lr_scale <= 1.0:
        raise SystemExit("language-lr-scale must be in [0, 1]")
    run(args)


if __name__ == "__main__":
    main()
