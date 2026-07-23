#!/usr/bin/env python3
"""Train the integrated Archie organism directly from sealed Sidepus object plans."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import pathlib
import platform
import random
import time
from dataclasses import asdict, dataclass
from typing import Any, Mapping

import numpy as np
import torch

from archie_hybrid_core import ByteTokenizer
from archie_hybrid_corpus import sha256_file, stable_json, verify_u16_corpus
from archie_tokenizers import token_byte_lengths, tokenizer_from_metadata
from archie_sidepus_organism import (
    MODEL_SCHEMA,
    ArchieSidepusOrganism,
    OrganismConfig,
    load_language_shell,
    parameter_count,
)
from sidepus_training_stream import PlanBatchSampler, digest_json
from train_archie_hybrid import TokenSampler, cosine_lambda, next_token_statistics

CHECKPOINT_SCHEMA = "archie-sidepus-organism-checkpoint/v1"
RECEIPT_SCHEMA = "archie-sidepus-organism-training-receipt/v1"
CONTRACT_SCHEMA = "archie-sidepus-organism-training-contract/v1"
SOURCE_MODEL_SCHEMA = "archie-scratch-hybrid-model/v1"
CODE_FILES = (
    "train_archie_sidepus_organism.py",
    "archie_sidepus_organism.py",
    "sidepus_training_stream.py",
    "archie_world_state_core.py",
    "archie_hybrid_core.py",
)


@dataclass
class TrainState:
    step: int = 0
    attempts: int = 0
    tokens_seen: int = 0
    bytes_seen: int = 0
    skipped_steps: int = 0
    consecutive_skips: int = 0
    best_retention_bits_per_byte: float = float("inf")
    best_total_loss: float = float("inf")


def rng_state() -> dict[str, Any]:
    result: dict[str, Any] = {
        "python": random.getstate(),
        "numpy": np.random.get_state(),
        "torch": torch.get_rng_state(),
    }
    if torch.cuda.is_available():
        result["cuda"] = torch.cuda.get_rng_state_all()
    return result


def restore_rng_state(state: Mapping[str, Any]) -> None:
    random.setstate(state["python"])
    np.random.set_state(state["numpy"])
    torch.set_rng_state(state["torch"].cpu())
    if torch.cuda.is_available() and "cuda" in state:
        torch.cuda.set_rng_state_all([item.cpu() for item in state["cuda"]])


def code_identity() -> dict[str, str]:
    here = pathlib.Path(__file__).resolve().parent
    return {name: sha256_file(here / name) for name in CODE_FILES}


def contract_digest(value: Mapping[str, Any]) -> str:
    return hashlib.sha256(stable_json(dict(value)).encode()).hexdigest()


def atomic_torch_save(payload: Any, path: pathlib.Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    torch.save(payload, temporary)
    os.replace(temporary, path)


def build_config(args: argparse.Namespace, source: Mapping[str, Any]) -> OrganismConfig:
    raw = source.get("config") or source.get("model_config")
    if not isinstance(raw, dict):
        raise ValueError("source model has no configuration")
    values = dict(raw)
    values.update(
        plastic_mode=args.plastic_mode,
        plastic_rank=args.plastic_rank,
        plastic_retention_floor=args.plastic_retention_floor,
        plastic_write_scale=args.plastic_write_scale,
        plastic_state_clip=args.plastic_state_clip,
        plastic_detach_every=args.plastic_detach_every,
        event_size=args.event_size,
        state_slots=args.state_slots,
        state_top_k=args.state_top_k,
        state_quant_bits=args.state_quant_bits,
        state_aux_weight=args.state_aux_weight,
        action_count=args.action_count,
        deliberation_max_steps=args.deliberation_max_steps,
        deliberation_ponder_weight=args.deliberation_ponder_weight,
        deliberation_min_halt=args.deliberation_min_halt,
    )
    return OrganismConfig(**values)


def build_contract(
    args: argparse.Namespace,
    cfg: OrganismConfig,
    source_sha: str,
    plan_receipt: Mapping[str, Any],
    retention_metadata: Mapping[str, Any],
    device: torch.device,
    amp_dtype: torch.dtype | None,
) -> dict[str, Any]:
    return {
        "schema": CONTRACT_SCHEMA,
        "model": asdict(cfg),
        "source": {
            "language_shell_sha256": source_sha,
            "plan_sha256": plan_receipt["plan_sha256"],
            "plan_receipt_digest": plan_receipt["receipt_digest"],
            "inventory_sha256": plan_receipt["inventory_sha256"],
            "retention_corpus_sha256": retention_metadata["sha256"],
        },
        "state": {
            "carry_policy": args.state_carry_policy,
            "language_freeze_steps": args.freeze_language_steps,
            "language_lr_scale": args.language_lr_scale,
        },
        "sampling": {
            "sequence_length": args.seq_len,
            "batch_size": args.batch_size,
            "prefetch_workers": args.prefetch_workers,
            "plan_order": "sealed-sequential",
        },
        "optimization": {
            "optimizer": "AdamW",
            "betas": [0.9, 0.95],
            "epsilon": 1e-8,
            "learning_rate": args.learning_rate,
            "weight_decay": args.weight_decay,
            "gradient_clip": args.grad_clip,
            "warmup_steps": args.warmup_steps,
            "maximum_steps": args.max_steps,
            "minimum_learning_rate_ratio": args.min_lr_ratio,
        },
        "execution": {
            "seed": args.seed,
            "device": str(device),
            "amp_dtype": str(amp_dtype) if amp_dtype is not None else "float32",
            "tf32": args.tf32,
            "torch": torch.__version__,
            "cuda": torch.version.cuda,
        },
        "code_sha256": code_identity(),
    }


def make_optimizer(
    model: ArchieSidepusOrganism,
    args: argparse.Namespace,
    device: torch.device,
) -> torch.optim.Optimizer:
    groups = [
        {
            "params": list(model.organism_parameters()),
            "lr": args.learning_rate,
            "name": "organism",
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


def reset_changed_domains(
    tensor: torch.Tensor | None,
    current: list[str],
    previous: list[str] | None,
    policy: str,
) -> torch.Tensor | None:
    if policy == "reset-each-window":
        return None
    if tensor is None:
        return None
    value = tensor.detach()
    if policy == "carry-with-domain-reset" and previous is not None:
        flags = [a != b for a, b in zip(current, previous)]
        if any(flags):
            value = value.clone()
            value[torch.tensor(flags, dtype=torch.bool, device=value.device)] = 0
    return value


@torch.no_grad()
def retention_evaluate(
    model: ArchieSidepusOrganism,
    sampler: TokenSampler,
    *,
    batches: int,
    device: torch.device,
    amp_dtype: torch.dtype | None,
    byte_lengths: torch.Tensor,
) -> dict[str, float]:
    model.eval()
    total_nats = total_tokens = total_bytes = 0.0
    total_state = total_ponder = 0.0
    for _ in range(batches):
        batch = sampler.batch(device)
        inputs = batch[:, :-1]
        with torch.autocast(
            device_type=device.type,
            dtype=amp_dtype,
            enabled=amp_dtype is not None,
        ):
            output = model(inputs, labels=inputs)
        nats, tokens, bytes_ = next_token_statistics(output["logits"], inputs, byte_lengths)
        total_nats += float(nats.detach().cpu())
        total_tokens += float(tokens.detach().cpu())
        total_bytes += float(bytes_.detach().cpu())
        total_state += float(output["state_loss"].detach().float().cpu())
        total_ponder += float(output["ponder_cost"].detach().float().cpu())
    return {
        "loss_per_byte": total_nats / max(total_bytes, 1.0),
        "bits_per_byte": total_nats / max(total_bytes, 1.0) / math.log(2.0),
        "nats_per_token": total_nats / max(total_tokens, 1.0),
        "state_loss": total_state / batches,
        "expected_deliberation_steps": total_ponder / batches,
        "evaluated_tokens": total_tokens,
        "evaluated_bytes": total_bytes,
    }


def export_model(
    path: pathlib.Path,
    model: ArchieSidepusOrganism,
    cfg: OrganismConfig,
    tokenizer: Mapping[str, Any],
    metadata: Mapping[str, Any],
) -> None:
    atomic_torch_save(
        {
            "schema": MODEL_SCHEMA,
            "config": asdict(cfg),
            "model": model.state_dict(),
            "tokenizer": dict(tokenizer),
            "training": dict(metadata),
        },
        path,
    )


def save_checkpoint(
    path: pathlib.Path,
    *,
    model: ArchieSidepusOrganism,
    optimizer: torch.optim.Optimizer,
    scheduler: torch.optim.lr_scheduler.LRScheduler,
    scaler: Any,
    state: TrainState,
    stream: PlanBatchSampler,
    retention_sampler: TokenSampler,
    world_state: torch.Tensor | None,
    plastic_state: torch.Tensor | None,
    previous_domains: list[str] | None,
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
            "stream_state": stream.state_dict(),
            "retention_sampler": retention_sampler.state_dict(),
            "world_state": world_state.detach().cpu() if world_state is not None else None,
            "plastic_state": plastic_state.detach().cpu() if plastic_state is not None else None,
            "previous_domains": previous_domains,
            "rng": rng_state(),
            "history": history,
            "contract": contract,
            "contract_digest": digest,
        },
        path,
    )


def load_checkpoint(
    path: pathlib.Path,
    *,
    model: ArchieSidepusOrganism,
    optimizer: torch.optim.Optimizer,
    scheduler: torch.optim.lr_scheduler.LRScheduler,
    scaler: Any,
    stream: PlanBatchSampler,
    retention_sampler: TokenSampler,
    digest: str,
    device: torch.device,
) -> tuple[
    TrainState,
    torch.Tensor | None,
    torch.Tensor | None,
    list[str] | None,
    list[dict[str, Any]],
]:
    payload = torch.load(path, map_location=device, weights_only=False)
    if payload.get("schema") != CHECKPOINT_SCHEMA:
        raise SystemExit("unsupported integrated organism checkpoint")
    saved = payload.get("contract")
    if (
        not isinstance(saved, dict)
        or payload.get("contract_digest") != contract_digest(saved)
        or payload.get("contract_digest") != digest
    ):
        raise SystemExit("integrated organism checkpoint contract mismatch")
    model.load_state_dict(payload["model"])
    optimizer.load_state_dict(payload["optimizer"])
    scheduler.load_state_dict(payload["scheduler"])
    if scaler is not None and payload.get("scaler") is not None:
        scaler.load_state_dict(payload["scaler"])
    stream.load_state_dict(payload["stream_state"])
    retention_sampler.load_state_dict(payload["retention_sampler"])
    restore_rng_state(payload["rng"])
    world = payload.get("world_state")
    plastic = payload.get("plastic_state")
    return (
        TrainState(**payload["train_state"]),
        world.to(device=device, dtype=torch.float32) if world is not None else None,
        plastic.to(device=device, dtype=torch.float32) if plastic is not None else None,
        payload.get("previous_domains"),
        list(payload.get("history") or []),
    )


def run(args: argparse.Namespace) -> dict[str, Any]:
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(args.seed)
    device = torch.device(args.device)
    if device.type == "cuda" and not torch.cuda.is_available():
        raise SystemExit("CUDA requested but unavailable")
    if device.type == "cuda":
        torch.backends.cuda.matmul.allow_tf32 = args.tf32
        torch.backends.cudnn.allow_tf32 = args.tf32
        torch.cuda.reset_peak_memory_stats(device)

    source_path = pathlib.Path(args.init_model).resolve()
    source = torch.load(source_path, map_location="cpu", weights_only=False)
    source_schema = source.get("schema")
    if source_schema not in {SOURCE_MODEL_SCHEMA, MODEL_SCHEMA}:
        raise SystemExit("integrated organism source must be Archie language or organism export")
    plan_path = pathlib.Path(args.plan).resolve()
    plan_receipt_path = pathlib.Path(args.plan_receipt).resolve()
    plan_receipt = json.loads(plan_receipt_path.read_text(encoding="utf-8"))
    retention_path = pathlib.Path(args.retention_corpus).resolve()
    retention_metadata = verify_u16_corpus(retention_path)
    tokenizer = tokenizer_from_metadata(retention_metadata["tokenizer"])
    if tokenizer.metadata() != ByteTokenizer.metadata():
        raise SystemExit("integrated Sidepus organism currently requires byte tokenizer")

    cfg = build_config(args, source)
    if source_schema == MODEL_SCHEMA:
        source_cfg = OrganismConfig(**(source.get("config") or {}))
        allowed = {"state_quant_bits", "state_aux_weight"}
        source_values = asdict(source_cfg)
        target_values = asdict(cfg)
        changed = {key for key in source_values if source_values[key] != target_values[key]}
        if changed - allowed:
            raise SystemExit(
                "organism continuation may change only state_quant_bits or state_aux_weight: "
                + ", ".join(sorted(changed))
            )
    model = ArchieSidepusOrganism(cfg).to(device)
    if source_schema == MODEL_SCHEMA:
        model.load_state_dict(source["model"])
        warm_start = {"mode": "full-organism-continuation", "copied_tensors": len(source["model"])}
    else:
        warm_start = load_language_shell(model, source)
    model.set_language_shell_trainable(args.freeze_language_steps <= 0)
    optimizer = make_optimizer(model, args, device)
    scheduler = torch.optim.lr_scheduler.LambdaLR(
        optimizer,
        lambda step: cosine_lambda(step, args.warmup_steps, args.max_steps, args.min_lr_ratio),
    )
    amp_dtype: torch.dtype | None = None
    if device.type == "cuda":
        amp_dtype = {
            "float16": torch.float16,
            "bfloat16": torch.bfloat16,
            "float32": None,
        }[args.amp_dtype]
    scaler = torch.amp.GradScaler(
        "cuda", enabled=device.type == "cuda" and amp_dtype == torch.float16
    )
    byte_lengths = torch.tensor(
        token_byte_lengths(retention_metadata["tokenizer"]),
        dtype=torch.long,
        device=device,
    )
    retention_sampler = TokenSampler(
        retention_path,
        args.retention_seq_len,
        args.retention_batch_size,
        args.seed ^ 0xA5A5A5A5,
    )

    output = pathlib.Path(args.output_dir).resolve()
    output.mkdir(parents=True, exist_ok=True)
    checkpoint_path = output / "checkpoint.pt"
    model_path = output / "archie-sidepus-organism.pt"
    best_path = output / "best-archie-sidepus-organism.pt"
    source_sha = sha256_file(source_path)
    contract = build_contract(
        args, cfg, source_sha, plan_receipt, retention_metadata, device, amp_dtype
    )
    digest = contract_digest(contract)
    state = TrainState()
    world_state = None
    plastic_state = None
    previous_domains = None
    history: list[dict[str, Any]] = []
    resumed = False

    with PlanBatchSampler(
        plan_path,
        plan_receipt_path,
        batch_size=args.batch_size,
        sequence_length=args.seq_len,
        workers=args.prefetch_workers,
        verify_objects=not args.no_verify_objects,
    ) as stream:
        if checkpoint_path.exists() and not args.no_resume:
            (
                state,
                world_state,
                plastic_state,
                previous_domains,
                history,
            ) = load_checkpoint(
                checkpoint_path,
                model=model,
                optimizer=optimizer,
                scheduler=scheduler,
                scaler=scaler,
                stream=stream,
                retention_sampler=retention_sampler,
                digest=digest,
                device=device,
            )
            resumed = True
        model.set_language_shell_trainable(state.step >= args.freeze_language_steps)

        started = time.monotonic()
        deadline = (
            started + args.deadline_minutes * 60
            if args.deadline_minutes > 0
            else float("inf")
        )
        starting_tokens = state.tokens_seen
        stop_reason = "maximum_steps"
        while state.step < args.max_steps:
            if time.monotonic() >= deadline - args.deadline_buffer_seconds:
                stop_reason = "deadline"
                break
            if state.step == args.freeze_language_steps:
                model.set_language_shell_trainable(True)
            try:
                batch, rows = stream.batch_with_rows(device)
            except StopIteration:
                stop_reason = "plan_exhausted"
                break
            domains = [str(row.get("primary_domain", "unknown")) for row in rows]
            world_input = reset_changed_domains(
                world_state, domains, previous_domains, args.state_carry_policy
            )
            plastic_input = reset_changed_domains(
                plastic_state, domains, previous_domains, args.state_carry_policy
            )
            inputs = batch[:, :-1]
            state.attempts += 1
            optimizer.zero_grad(set_to_none=True)
            with torch.autocast(
                device_type=device.type,
                dtype=amp_dtype,
                enabled=amp_dtype is not None,
            ):
                result = model(
                    inputs,
                    labels=inputs,
                    world_state=world_input,
                    plastic_state=plastic_input,
                    return_diagnostics=True,
                )
                loss = result["loss"]
            scaler.scale(loss).backward()
            scaler.unscale_(optimizer)
            grad_norm = float(
                torch.nn.utils.clip_grad_norm_(model.parameters(), args.grad_clip)
                .detach()
                .float()
                .cpu()
            )
            values = {
                "loss": float(loss.detach().float().cpu()),
                "lm_loss": float(result["lm_loss"].detach().float().cpu()),
                "state_loss": float(result["state_loss"].detach().float().cpu()),
                "ponder_cost": float(result["ponder_cost"].detach().float().cpu()),
            }
            finite = math.isfinite(grad_norm) and all(math.isfinite(v) for v in values.values())
            if finite:
                scaler.step(optimizer)
                scaler.update()
                state.consecutive_skips = 0
                world_state = result["world_state"].detach()
                plastic_output = result.get("plastic_state")
                plastic_state = plastic_output.detach() if plastic_output is not None else None
                previous_domains = domains
            else:
                scaler.update()
                state.skipped_steps += 1
                state.consecutive_skips += 1
            scheduler.step()
            state.step += 1
            state.tokens_seen += int(inputs.numel())
            _, _, byte_count = next_token_statistics(result["logits"], inputs, byte_lengths)
            state.bytes_seen += int(byte_count.detach().cpu())

            record: dict[str, Any] = {
                "step": state.step,
                "attempt": state.attempts,
                **values,
                "gradient_norm": grad_norm,
                "step_applied": finite,
                "tokens_seen": state.tokens_seen,
                "bytes_seen": state.bytes_seen,
                "plan_cursor": stream.cursor,
                "learning_rates": [float(group["lr"]) for group in optimizer.param_groups],
                "language_shell_trainable": state.step > args.freeze_language_steps,
                "domains": domains,
                "world_state_l2": float(result["state_l2"].detach().float().cpu()),
                "plastic_state_l2": float(result["plastic_l2"].detach().float().cpu()),
                "state_gate_mean": float(result["state_gate_mean"].detach().float().cpu()),
                "thought_gate_mean": float(result["thought_gate_mean"].detach().float().cpu()),
                "active_slot_fraction": float(
                    result["active_slot_fraction"].detach().float().cpu()
                ),
                "expected_deliberation_steps": float(
                    result["expected_deliberation_steps"].detach().float().cpu()
                ),
            }
            should_eval = (
                state.step == 1
                or state.step % args.eval_every == 0
                or state.step == args.max_steps
            )
            if should_eval:
                metrics = retention_evaluate(
                    model,
                    retention_sampler,
                    batches=args.retention_batches,
                    device=device,
                    amp_dtype=amp_dtype,
                    byte_lengths=byte_lengths,
                )
                record.update({f"retention_{key}": value for key, value in metrics.items()})
                previous_best = state.best_retention_bits_per_byte
                state.best_retention_bits_per_byte = min(
                    state.best_retention_bits_per_byte, metrics["bits_per_byte"]
                )
                state.best_total_loss = min(state.best_total_loss, values["loss"])
                if metrics["bits_per_byte"] <= previous_best:
                    export_model(
                        best_path,
                        model,
                        cfg,
                        retention_metadata["tokenizer"],
                        {
                            "step": state.step,
                            "contract_digest": digest,
                            "warm_start": warm_start,
                        },
                    )
                model.train()
            history.append(record)
            if state.step == 1 or state.step % args.log_every == 0 or should_eval:
                print(json.dumps(record, sort_keys=True), flush=True)
            if state.step % args.save_every == 0:
                save_checkpoint(
                    checkpoint_path,
                    model=model,
                    optimizer=optimizer,
                    scheduler=scheduler,
                    scaler=scaler,
                    state=state,
                    stream=stream,
                    retention_sampler=retention_sampler,
                    world_state=world_state,
                    plastic_state=plastic_state,
                    previous_domains=previous_domains,
                    history=history,
                    contract=contract,
                    digest=digest,
                )
            if state.consecutive_skips >= args.max_consecutive_skips:
                stop_reason = "nonfinite_gradients"
                break

        final_retention = retention_evaluate(
            model,
            retention_sampler,
            batches=args.retention_batches,
            device=device,
            amp_dtype=amp_dtype,
            byte_lengths=byte_lengths,
        )
        save_checkpoint(
            checkpoint_path,
            model=model,
            optimizer=optimizer,
            scheduler=scheduler,
            scaler=scaler,
            state=state,
            stream=stream,
            retention_sampler=retention_sampler,
            world_state=world_state,
            plastic_state=plastic_state,
            previous_domains=previous_domains,
            history=history,
            contract=contract,
            digest=digest,
        )
        export_model(
            model_path,
            model,
            cfg,
            retention_metadata["tokenizer"],
            {
                "step": state.step,
                "contract_digest": digest,
                "warm_start": warm_start,
            },
        )

    runtime = time.monotonic() - started
    receipt = {
        "schema": RECEIPT_SCHEMA,
        "method": "direct-sidepus-integrated-recurrence-plasticity-state-deliberation/v1",
        "contract": contract,
        "contract_digest": digest,
        "model": {
            "config": asdict(cfg),
            "parameters": parameter_count(model),
            "warm_start": warm_start,
            "source_sha256": source_sha,
            "model_sha256": sha256_file(model_path),
            "best_model_sha256": sha256_file(best_path) if best_path.exists() else None,
            "checkpoint_sha256": sha256_file(checkpoint_path),
        },
        "training": {
            **asdict(state),
            "resumed": resumed,
            "stop_reason": stop_reason,
            "final_retention": final_retention,
            "history": history,
        },
        "runtime": {
            "seconds": runtime,
            "tokens_per_second": (state.tokens_seen - starting_tokens) / max(runtime, 1e-9),
            "python": platform.python_version(),
            "torch": torch.__version__,
            "device": str(device),
            "gpu": torch.cuda.get_device_name(device) if device.type == "cuda" else None,
            "peak_allocated_mib": (
                torch.cuda.max_memory_allocated(device) / 2**20
                if device.type == "cuda"
                else None
            ),
        },
        "promotion": "research-candidate-not-admitted",
        "claim_boundary": (
            "The four mechanisms are executable together, but no useful recurrence, plasticity, "
            "persistent memory, or deliberation claim exists until frozen causal controls and "
            "independent replication pass."
        ),
    }
    receipt["receipt_digest"] = digest_json(receipt)
    (output / "training-receipt.json").write_text(
        json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(json.dumps(receipt, indent=2, sort_keys=True))
    return receipt


def parser() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--plan", required=True)
    cli.add_argument("--plan-receipt", required=True)
    cli.add_argument("--retention-corpus", required=True)
    cli.add_argument("--init-model", required=True)
    cli.add_argument("--output-dir", required=True)
    cli.add_argument("--seq-len", type=int, default=1024)
    cli.add_argument("--batch-size", type=int, default=1)
    cli.add_argument("--prefetch-workers", type=int, default=4)
    cli.add_argument("--max-steps", type=int, default=2500)
    cli.add_argument("--learning-rate", type=float, default=2e-4)
    cli.add_argument("--language-lr-scale", type=float, default=0.05)
    cli.add_argument("--freeze-language-steps", type=int, default=500)
    cli.add_argument("--min-lr-ratio", type=float, default=0.1)
    cli.add_argument("--warmup-steps", type=int, default=200)
    cli.add_argument("--weight-decay", type=float, default=0.1)
    cli.add_argument("--grad-clip", type=float, default=1.0)
    cli.add_argument("--max-consecutive-skips", type=int, default=8)
    cli.add_argument("--eval-every", type=int, default=100)
    cli.add_argument("--save-every", type=int, default=50)
    cli.add_argument("--log-every", type=int, default=5)
    cli.add_argument("--retention-seq-len", type=int, default=512)
    cli.add_argument("--retention-batch-size", type=int, default=1)
    cli.add_argument("--retention-batches", type=int, default=16)
    cli.add_argument("--plastic-mode", choices=("none", "delta"), default="delta")
    cli.add_argument("--plastic-rank", type=int, default=16)
    cli.add_argument("--plastic-retention-floor", type=float, default=0.95)
    cli.add_argument("--plastic-write-scale", type=float, default=0.25)
    cli.add_argument("--plastic-state-clip", type=float, default=4.0)
    cli.add_argument("--plastic-detach-every", type=int, default=128)
    cli.add_argument("--event-size", type=int, default=16)
    cli.add_argument("--state-slots", type=int, default=8)
    cli.add_argument("--state-top-k", type=int, default=2)
    cli.add_argument("--state-quant-bits", type=int, choices=(0, 4, 8), default=8)
    cli.add_argument("--state-aux-weight", type=float, default=0.35)
    cli.add_argument("--action-count", type=int, default=0)
    cli.add_argument("--deliberation-max-steps", type=int, default=4)
    cli.add_argument("--deliberation-ponder-weight", type=float, default=0.002)
    cli.add_argument("--deliberation-min-halt", type=float, default=0.05)
    cli.add_argument(
        "--state-carry-policy",
        choices=("reset-each-window", "carry-detached", "carry-with-domain-reset"),
        default="carry-with-domain-reset",
    )
    cli.add_argument("--deadline-minutes", type=float, default=330)
    cli.add_argument("--deadline-buffer-seconds", type=int, default=180)
    cli.add_argument("--seed", type=int, default=20260723)
    cli.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    cli.add_argument("--amp-dtype", choices=("float16", "bfloat16", "float32"), default="float16")
    cli.add_argument("--tf32", action=argparse.BooleanOptionalAction, default=True)
    cli.add_argument("--no-verify-objects", action="store_true")
    cli.add_argument("--no-resume", action="store_true")
    return cli


def main() -> None:
    args = parser().parse_args()
    if args.max_steps < 1 or args.batch_size < 1:
        raise SystemExit("max-steps and batch-size must be positive")
    run(args)


if __name__ == "__main__":
    main()
