#!/usr/bin/env python3
"""Train Archie with active pursuit, causal-state pressure, and bounded Sidepus streaming."""
from __future__ import annotations

import json
import pathlib
import platform
import random
import time
from dataclasses import asdict
from typing import Any

import numpy as np
import torch

from archie_hybrid_core import ByteTokenizer
from archie_hybrid_corpus import sha256_file, verify_u16_corpus
from archie_tokenizers import token_byte_lengths, tokenizer_from_metadata
from archie_sidepus_organism import MODEL_SCHEMA, ArchieSidepusOrganism, OrganismConfig, load_language_shell, parameter_count
from sidepus_pursuit_objectives import METHOD, contract_digest, pursuit_contract
from sidepus_pursuit_plan import digest_json
from sidepus_pursuit_step import train_step
from sidepus_pursuit_stream import PursuitExperienceStream
from train_archie_hybrid import TokenSampler, cosine_lambda, next_token_statistics
from train_archie_sidepus_organism import (
    RECEIPT_SCHEMA, SOURCE_MODEL_SCHEMA, TrainState, build_config, export_model,
    load_checkpoint, make_optimizer, reset_changed_domains, retention_evaluate, save_checkpoint,
)

BASELINE_SCHEMA = "archie-sidepus-pursuit-retention-baseline/v1"


def _write_json_atomic(path: pathlib.Path, value: dict[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)


def sealed_baseline_retention(
    *, path: pathlib.Path, model: ArchieSidepusOrganism, retention_path: pathlib.Path,
    args: Any, contract_digest_value: str, source_sha: str, device: torch.device,
    amp_dtype: torch.dtype | None, byte_lengths: torch.Tensor,
) -> dict[str, float]:
    """Create once from the untouched initialized organism and never redefine on resume."""
    if path.exists():
        payload = json.loads(path.read_text(encoding="utf-8"))
        body = dict(payload)
        expected_digest = body.pop("baseline_digest", None)
        if (
            payload.get("schema") != BASELINE_SCHEMA
            or expected_digest != digest_json(body)
            or payload.get("contract_digest") != contract_digest_value
            or payload.get("source_sha256") != source_sha
            or payload.get("retention_corpus_sha256") != sha256_file(retention_path)
        ):
            raise SystemExit("sealed pursuit retention baseline does not match this contract")
        metrics = payload.get("metrics")
        if not isinstance(metrics, dict):
            raise SystemExit("sealed pursuit retention baseline has no metrics")
        return {str(key): float(value) for key, value in metrics.items()}

    baseline_sampler = TokenSampler(
        retention_path,
        args.retention_seq_len,
        args.retention_batch_size,
        args.seed ^ 0x5A5A5A5A,
    )
    metrics = retention_evaluate(
        model,
        baseline_sampler,
        batches=args.retention_batches,
        device=device,
        amp_dtype=amp_dtype,
        byte_lengths=byte_lengths,
    )
    payload: dict[str, Any] = {
        "schema": BASELINE_SCHEMA,
        "contract_digest": contract_digest_value,
        "source_sha256": source_sha,
        "retention_corpus_sha256": sha256_file(retention_path),
        "sampler_seed": args.seed ^ 0x5A5A5A5A,
        "metrics": metrics,
        "claim_boundary": (
            "This baseline is measured once before pursuit updates and is immutable across resumes. "
            "It prevents a damaged resumed model from redefining its own retention reference."
        ),
    }
    payload["baseline_digest"] = digest_json(payload)
    _write_json_atomic(path, payload)
    return metrics


def run(args: Any) -> dict[str, Any]:
    random.seed(args.seed); np.random.seed(args.seed); torch.manual_seed(args.seed)
    if torch.cuda.is_available(): torch.cuda.manual_seed_all(args.seed)
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
        raise SystemExit("pursuit source must be Archie language or organism export")
    plan_path, plan_receipt_path = pathlib.Path(args.plan).resolve(), pathlib.Path(args.plan_receipt).resolve()
    plan_receipt = json.loads(plan_receipt_path.read_text(encoding="utf-8"))
    retention_path = pathlib.Path(args.retention_corpus).resolve()
    retention_metadata = verify_u16_corpus(retention_path)
    tokenizer = tokenizer_from_metadata(retention_metadata["tokenizer"])
    if tokenizer.metadata() != ByteTokenizer.metadata():
        raise SystemExit("pursuit organism currently requires byte tokenizer")

    cfg = build_config(args, source)
    if source_schema == MODEL_SCHEMA:
        source_cfg = OrganismConfig(**(source.get("config") or {}))
        allowed = {"state_quant_bits", "state_aux_weight"}
        changed = {key for key, value in asdict(source_cfg).items() if value != asdict(cfg)[key]}
        if changed - allowed:
            raise SystemExit("organism continuation changed unsupported fields: " + ", ".join(sorted(changed)))
    model = ArchieSidepusOrganism(cfg).to(device)
    if source_schema == MODEL_SCHEMA:
        model.load_state_dict(source["model"])
        warm_start = {"mode": "full-organism-continuation", "copied_tensors": len(source["model"])}
    else:
        warm_start = load_language_shell(model, source)
    model.set_language_shell_trainable(args.freeze_language_steps <= 0)
    optimizer = make_optimizer(model, args, device)
    scheduler = torch.optim.lr_scheduler.LambdaLR(
        optimizer, lambda step: cosine_lambda(step, args.warmup_steps, args.max_steps, args.min_lr_ratio)
    )
    amp_dtype: torch.dtype | None = None
    if device.type == "cuda":
        amp_dtype = {"float16": torch.float16, "bfloat16": torch.bfloat16, "float32": None}[args.amp_dtype]
    scaler = torch.amp.GradScaler("cuda", enabled=device.type == "cuda" and amp_dtype == torch.float16)
    byte_lengths = torch.tensor(token_byte_lengths(retention_metadata["tokenizer"]), dtype=torch.long, device=device)
    retention_sampler = TokenSampler(
        retention_path, args.retention_seq_len, args.retention_batch_size, args.seed ^ 0xA5A5A5A5
    )

    output = pathlib.Path(args.output_dir).resolve(); output.mkdir(parents=True, exist_ok=True)
    checkpoint_path, model_path = output / "checkpoint.pt", output / "archie-sidepus-pursuit.pt"
    best_path = output / "best-archie-sidepus-pursuit.pt"
    baseline_path = output / "retention-baseline.json"
    source_sha = sha256_file(source_path)
    contract = pursuit_contract(args, cfg, source_sha, plan_receipt, retention_metadata, device, amp_dtype)
    digest = contract_digest(contract)
    state, world_state, plastic_state, previous_threads = TrainState(), None, None, None
    history: list[dict[str, Any]] = []
    resumed = False

    with PursuitExperienceStream(
        plan_path, plan_receipt_path, state_dir=pathlib.Path(args.sidepus_state),
        cache_dir=pathlib.Path(args.cache_dir), cache_bytes=args.cache_bytes,
        batch_size=args.batch_size, sequence_length=args.seq_len,
        workers=args.prefetch_workers, lookahead=args.pursuit_lookahead,
        seed=args.seed, ledger=output / "materialization-ledger.jsonl",
    ) as stream:
        if checkpoint_path.exists() and not args.no_resume:
            state, world_state, plastic_state, previous_threads, history = load_checkpoint(
                checkpoint_path, model=model, optimizer=optimizer, scheduler=scheduler,
                scaler=scaler, stream=stream, retention_sampler=retention_sampler,
                digest=digest, device=device,
            )
            resumed = True
        model.set_language_shell_trainable(state.step >= args.freeze_language_steps)
        if resumed and not baseline_path.exists():
            raise SystemExit("cannot resume pursuit training without its original sealed retention baseline")
        baseline_retention = sealed_baseline_retention(
            path=baseline_path,
            model=model,
            retention_path=retention_path,
            args=args,
            contract_digest_value=digest,
            source_sha=source_sha,
            device=device,
            amp_dtype=amp_dtype,
            byte_lengths=byte_lengths,
        )
        model.train()
        started = time.monotonic()
        deadline = started + args.deadline_minutes * 60 if args.deadline_minutes > 0 else float("inf")
        starting_tokens, stop_reason = state.tokens_seen, "maximum_steps"
        best_composite, latest_retention_tax = -float("inf"), 0.0
        if history:
            best_composite = max(float(row.get("composite", -float("inf"))) for row in history)
            latest_retention_tax = float(history[-1].get("retention_tax", 0.0))

        while state.step < args.max_steps:
            if time.monotonic() >= deadline - args.deadline_buffer_seconds:
                stop_reason = "deadline"; break
            if state.step == args.freeze_language_steps:
                model.set_language_shell_trainable(True)
            try:
                batch, rows = stream.batch_with_rows(device)
            except StopIteration:
                stop_reason = "plan_exhausted"; break
            domains = [str(row.get("primary_domain", "unknown")) for row in rows]
            threads = [str(row.get("state_thread_id", row["intent_id"])) for row in rows]
            world_input = reset_changed_domains(
                world_state, threads, previous_threads, args.state_carry_policy
            )
            plastic_input = reset_changed_domains(
                plastic_state, threads, previous_threads, args.state_carry_policy
            )
            inputs = batch[:, :-1]
            state.attempts += 1
            step_output = train_step(
                model=model, optimizer=optimizer, scaler=scaler, inputs=inputs,
                world_input=world_input, plastic_input=plastic_input, rows=rows,
                stream=stream, args=args, step=state.step, device=device, amp_dtype=amp_dtype,
            )
            result, values = step_output.result, step_output.values
            if step_output.finite:
                scaler.step(optimizer); scaler.update(); state.consecutive_skips = 0
                world_state = result["world_state"].detach()
                plastic_output = result.get("plastic_state")
                plastic_state = plastic_output.detach() if plastic_output is not None else None
                previous_threads = threads
            else:
                scaler.update(); state.skipped_steps += 1; state.consecutive_skips += 1
            scheduler.step(); state.step += 1; state.tokens_seen += int(inputs.numel())
            _, _, byte_count = next_token_statistics(result["logits"], inputs, byte_lengths)
            state.bytes_seen += int(byte_count.detach().cpu())

            should_eval = state.step == 1 or state.step % args.eval_every == 0 or state.step == args.max_steps
            retention_metrics: dict[str, float] | None = None
            if should_eval:
                retention_metrics = retention_evaluate(
                    model, retention_sampler, batches=args.retention_batches,
                    device=device, amp_dtype=amp_dtype, byte_lengths=byte_lengths,
                )
                latest_retention_tax = max(
                    0.0, retention_metrics["bits_per_byte"] / max(baseline_retention["bits_per_byte"], 1e-9) - 1.0
                )
                model.train()
            stream.feedback(
                rows,
                loss=values["lm_loss"],
                state_utility=step_output.state_utility,
                deliberation=values["ponder_cost"],
                interference=values["interference_kl"],
                retention_tax=latest_retention_tax if should_eval else None,
            )
            composite = (
                step_output.state_utility - args.retention_tax_weight * latest_retention_tax
                - 0.1 * abs(values["ponder_cost"] - step_output.target_deliberation)
                - 0.05 * values["interference_kl"] - 0.01 * values["lm_loss"]
            )
            if should_eval and composite > best_composite:
                best_composite = composite
                export_model(best_path, model, cfg, retention_metadata["tokenizer"], {
                    "step": state.step, "contract_digest": digest,
                    "warm_start": warm_start, "composite": composite,
                })

            record: dict[str, Any] = {
                "step": state.step, "attempt": state.attempts, **values,
                "gradient_norm": step_output.gradient_norm, "step_applied": step_output.finite,
                "tokens_seen": state.tokens_seen, "bytes_seen": state.bytes_seen,
                "plan_cursor": stream.cursor,
                "learning_rates": [float(group["lr"]) for group in optimizer.param_groups],
                "language_shell_trainable": state.step >= args.freeze_language_steps,
                "domains": domains,
                "state_threads": threads,
                "sequence_indices": [row.get("sequence_index") for row in rows],
                "intent_ids": [row["intent_id"] for row in rows],
                "state_utility": step_output.state_utility,
                "reset_lm_loss": step_output.reset_lm_loss,
                "wrong_lm_loss": step_output.wrong_lm_loss,
                "target_deliberation_steps": step_output.target_deliberation,
                "retention_tax": latest_retention_tax, "composite": composite,
                "world_state_l2": float(result["state_l2"].detach().float().cpu()),
                "plastic_state_l2": float(result["plastic_l2"].detach().float().cpu()),
                "state_gate_mean": float(result["state_gate_mean"].detach().float().cpu()),
                "thought_gate_mean": float(result["thought_gate_mean"].detach().float().cpu()),
                "active_slot_fraction": float(result["active_slot_fraction"].detach().float().cpu()),
                "expected_deliberation_steps": float(result["expected_deliberation_steps"].detach().float().cpu()),
                "stream": stream.snapshot(),
            }
            if retention_metrics is not None:
                record.update({f"retention_{key}": value for key, value in retention_metrics.items()})
            history.append(record)
            if state.step == 1 or state.step % args.log_every == 0 or should_eval:
                print(json.dumps(record, sort_keys=True), flush=True)
            if state.step % args.save_every == 0:
                save_checkpoint(
                    checkpoint_path, model=model, optimizer=optimizer, scheduler=scheduler,
                    scaler=scaler, state=state, stream=stream, retention_sampler=retention_sampler,
                    world_state=world_state, plastic_state=plastic_state,
                    previous_domains=previous_threads, history=history,
                    contract=contract, digest=digest,
                )
            if state.consecutive_skips >= args.max_consecutive_skips:
                stop_reason = "nonfinite_gradients"; break

        final_retention = retention_evaluate(
            model, retention_sampler, batches=args.retention_batches,
            device=device, amp_dtype=amp_dtype, byte_lengths=byte_lengths,
        )
        save_checkpoint(
            checkpoint_path, model=model, optimizer=optimizer, scheduler=scheduler,
            scaler=scaler, state=state, stream=stream, retention_sampler=retention_sampler,
            world_state=world_state, plastic_state=plastic_state,
            previous_domains=previous_threads, history=history,
            contract=contract, digest=digest,
        )
        export_model(model_path, model, cfg, retention_metadata["tokenizer"], {
            "step": state.step, "contract_digest": digest, "warm_start": warm_start,
        })
        stream_snapshot = stream.snapshot()

    runtime = time.monotonic() - started
    receipt = {
        "schema": RECEIPT_SCHEMA, "method": METHOD, "contract": contract,
        "contract_digest": digest,
        "model": {
            "config": asdict(cfg), "parameters": parameter_count(model), "warm_start": warm_start,
            "source_sha256": source_sha, "model_sha256": sha256_file(model_path),
            "best_model_sha256": sha256_file(best_path) if best_path.exists() else None,
            "checkpoint_sha256": sha256_file(checkpoint_path),
        },
        "training": {
            **asdict(state), "resumed": resumed, "stop_reason": stop_reason,
            "baseline_retention": baseline_retention,
            "baseline_retention_path": str(baseline_path),
            "baseline_retention_sha256": sha256_file(baseline_path),
            "final_retention": final_retention,
            "history": history, "best_composite": best_composite,
        },
        "stream": stream_snapshot,
        "runtime": {
            "seconds": runtime,
            "tokens_per_second": (state.tokens_seen - starting_tokens) / max(runtime, 1e-9),
            "python": platform.python_version(), "torch": torch.__version__, "device": str(device),
            "gpu": torch.cuda.get_device_name(device) if device.type == "cuda" else None,
            "peak_allocated_mib": torch.cuda.max_memory_allocated(device) / 2**20 if device.type == "cuda" else None,
        },
        "promotion": "research-candidate-not-admitted",
        "claim_boundary": (
            "Pursuit selection, streaming materialization, causal-state pressure, and compute anti-collapse are executable. "
            "No intelligence or developmental superiority claim exists until matched evaluation and replication pass."
        ),
    }
    receipt["receipt_digest"] = digest_json(receipt)
    _write_json_atomic(output / "training-receipt.json", receipt)
    print(json.dumps(receipt, indent=2, sort_keys=True))
    return receipt


def main() -> None:
    from sidepus_pursuit_cli import parser
    args = parser().parse_args()
    if args.max_steps < 1 or args.batch_size < 1 or args.cache_bytes < 1:
        raise SystemExit("max-steps, batch-size, and cache-bytes must be positive")
    run(args)


if __name__ == "__main__":
    main()
