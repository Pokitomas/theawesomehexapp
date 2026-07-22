#!/usr/bin/env python3
"""Governed function-preserving growth for Archie Hybrid students.

This lane turns a rejected student's measured failure into a bounded descendant
experiment. It never treats parameter count as improvement: the child must be
behaviorally equivalent at birth, added capacity trains under probation, and the
final model is promotable only when frozen capability and retention gates pass.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import pathlib
import random
import time
from dataclasses import asdict, dataclass
from typing import Any, Iterable

import numpy as np
import torch

from archie_hybrid_core import ArchieHybridLM, ModelConfig, parameter_count
from archie_hybrid_corpus import atomic_json, stable_json, verify_u16_corpus
from archie_tokenizers import token_byte_lengths
from train_archie_hybrid import TokenSampler, evaluate, next_token_statistics, normalized_loss

MODEL_SCHEMA = "archie-scratch-hybrid-model/v1"
GROWTH_SCHEMA = "archie-function-preserving-growth/v1"
DECISION_SCHEMA = "archie-regenerative-decision/v1"
CYCLE_SCHEMA = "archie-regenerative-cycle/v1"


@dataclass(frozen=True)
class GrowthDecision:
    approved: bool
    reason: str
    add_layers: int
    source_layers: int
    target_layers: int
    source_parameters: int
    estimated_target_parameters: int
    failed_interventions: int
    plateau_relative_gain: float | None
    parameter_multiplier: float
    evidence_digest: str | None


@dataclass(frozen=True)
class PhaseResult:
    phase: str
    seed: int
    steps: int
    trainable_parameters: int
    tokens_seen: int
    seconds: float
    bits_per_byte: float
    relative_gain_vs_parent: float
    peak_allocated_mib: float | None
    model_sha256: str


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(1 << 20):
            digest.update(block)
    return digest.hexdigest()


def digest_json(value: Any) -> str:
    return hashlib.sha256(stable_json(value).encode("utf-8")).hexdigest()


def load_model_payload(path: pathlib.Path) -> dict[str, Any]:
    payload = torch.load(path, map_location="cpu", weights_only=False)
    if payload.get("schema") != MODEL_SCHEMA:
        raise ValueError(f"unsupported Archie model schema in {path}")
    if "config" not in payload or "model" not in payload:
        raise ValueError(f"model payload is incomplete: {path}")
    return payload


def distribute(total: int, buckets: int) -> list[int]:
    if total < 0 or buckets < 1:
        raise ValueError("invalid distribution request")
    base, remainder = divmod(total, buckets)
    return [base + (1 if index < remainder else 0) for index in range(buckets)]


def plan_block_mapping(cfg: ModelConfig, add_layers: int) -> tuple[list[int], list[int]]:
    """Map parent blocks into a larger topology without changing mixer families."""
    if add_layers < 1:
        raise ValueError("add_layers must be positive")
    source_layers = cfg.n_layers
    if cfg.mixer_mode == "hybrid":
        group = cfg.attention_every
        if group < 1 or source_layers % group or add_layers % group:
            raise ValueError(
                "hybrid growth requires source and added layer counts divisible by attention_every"
            )
        source_groups = source_layers // group
        extra_after = distribute(add_layers // group, source_groups)
        mapping: list[int] = [-1] * source_layers
        inserted: list[int] = []
        cursor = 0
        for source_group in range(source_groups):
            source_start = source_group * group
            for offset in range(group):
                mapping[source_start + offset] = cursor
                cursor += 1
            for _ in range(extra_after[source_group]):
                inserted.extend(range(cursor, cursor + group))
                cursor += group
    else:
        extra_after = distribute(add_layers, source_layers)
        mapping = [-1] * source_layers
        inserted = []
        cursor = 0
        for source_index in range(source_layers):
            mapping[source_index] = cursor
            cursor += 1
            for _ in range(extra_after[source_index]):
                inserted.append(cursor)
                cursor += 1
    if cursor != source_layers + add_layers or any(index < 0 for index in mapping):
        raise AssertionError("growth mapping is incomplete")
    return mapping, inserted


def zero_residual_branch(block: torch.nn.Module) -> None:
    """Make one residual block an exact identity while retaining trainable internals."""
    mixer_out = getattr(getattr(block, "mixer", None), "out_proj", None)
    ffn_down = getattr(getattr(block, "ffn", None), "down", None)
    if mixer_out is None or ffn_down is None:
        raise TypeError("Archie block does not expose zeroable residual outputs")
    with torch.no_grad():
        mixer_out.weight.zero_()
        if mixer_out.bias is not None:
            mixer_out.bias.zero_()
        ffn_down.weight.zero_()
        if ffn_down.bias is not None:
            ffn_down.bias.zero_()


def build_descendant(
    parent_payload: dict[str, Any], add_layers: int, initialization_seed: int
) -> tuple[ArchieHybridLM, ModelConfig, list[int], list[int]]:
    source_cfg = ModelConfig(**parent_payload["config"])
    mapping, inserted = plan_block_mapping(source_cfg, add_layers)
    target_cfg = ModelConfig(**{**asdict(source_cfg), "n_layers": source_cfg.n_layers + add_layers})
    torch.manual_seed(initialization_seed)
    child = ArchieHybridLM(target_cfg)
    child_state = child.state_dict()
    for source_name, value in parent_payload["model"].items():
        if source_name.startswith("blocks."):
            _, raw_index, suffix = source_name.split(".", 2)
            target_name = f"blocks.{mapping[int(raw_index)]}.{suffix}"
        else:
            target_name = source_name
        if target_name not in child_state:
            raise ValueError(f"parent tensor has no descendant target: {source_name}")
        if tuple(child_state[target_name].shape) != tuple(value.shape):
            raise ValueError(f"shape changed for inherited tensor: {source_name}")
        child_state[target_name].copy_(value)
    child.load_state_dict(child_state)
    for index in inserted:
        zero_residual_branch(child.blocks[index])
    return child, target_cfg, mapping, inserted


@torch.inference_mode()
def verify_birth(
    parent_payload: dict[str, Any], child: ArchieHybridLM, *, seeds: Iterable[int],
    sequence_length: int, tolerance: float,
) -> dict[str, Any]:
    parent_cfg = ModelConfig(**parent_payload["config"])
    parent = ArchieHybridLM(parent_cfg)
    parent.load_state_dict(parent_payload["model"])
    parent.eval()
    child.eval()
    length = min(sequence_length, parent_cfg.max_seq_len, child.cfg.max_seq_len)
    if length < 2:
        raise ValueError("birth verification needs at least two tokens")
    maxima: list[float] = []
    means: list[float] = []
    exact = True
    used_seeds = [int(seed) for seed in seeds]
    for seed in used_seeds:
        generator = torch.Generator(device="cpu").manual_seed(seed)
        tokens = torch.randint(
            0, parent_cfg.vocab_size, (2, length), generator=generator, dtype=torch.long
        )
        parent_logits = parent(tokens)["logits"]
        child_logits = child(tokens)["logits"]
        delta = (parent_logits - child_logits).abs()
        maxima.append(float(delta.max()))
        means.append(float(delta.mean()))
        exact = exact and torch.equal(parent_logits, child_logits)
    maximum = max(maxima, default=float("inf"))
    return {
        "schema": "archie-growth-birth-verification/v1",
        "seeds": used_seeds,
        "sequence_length": length,
        "max_absolute_logit_delta": maximum,
        "mean_absolute_logit_delta": sum(means) / max(len(means), 1),
        "bit_exact": exact,
        "tolerance": tolerance,
        "passed": math.isfinite(maximum) and maximum <= tolerance,
    }


def estimate_target_parameters(parent_payload: dict[str, Any], add_layers: int) -> int:
    child, _, _, _ = build_descendant(parent_payload, add_layers, initialization_seed=0)
    return parameter_count(child)


def recursively_find_numbers(value: Any, prefix: str = "") -> dict[str, float]:
    found: dict[str, float] = {}
    if isinstance(value, dict):
        for key, item in value.items():
            path = f"{prefix}.{key}" if prefix else str(key)
            found.update(recursively_find_numbers(item, path))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            found.update(recursively_find_numbers(item, f"{prefix}[{index}]"))
    elif isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value)):
        found[prefix] = float(value)
    return found


def infer_failed_interventions(evidence: dict[str, Any]) -> int:
    explicit = evidence.get("failed_interventions")
    if isinstance(explicit, int) and explicit >= 0:
        return explicit
    failures = 0
    if evidence.get("passed") is False or evidence.get("status") in {"failed", "rejected"}:
        failures += 1
    for key, value in evidence.items():
        if key in {"passed", "status", "failed_interventions"}:
            continue
        lowered = str(key).lower()
        if isinstance(value, dict):
            failures += infer_failed_interventions(value)
        elif isinstance(value, list):
            for item in value:
                if isinstance(item, dict):
                    failures += infer_failed_interventions(item)
        elif value is False and any(token in lowered for token in ("pass", "gate", "promot")):
            failures += 1
    return failures


def infer_plateau(evidence: dict[str, Any]) -> float | None:
    for key in (
        "plateau_relative_gain", "recent_relative_gain", "relative_improvement",
        "selected_relative_effect_vs_baseline",
    ):
        value = evidence.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return float(value)
    numbers = recursively_find_numbers(evidence)
    candidates = [
        value for path, value in numbers.items()
        if any(token in path.lower() for token in ("relative_gain", "relative_effect", "improvement"))
    ]
    return min(candidates, key=abs) if candidates else None


def choose_add_layers(cfg: ModelConfig, requested_multiplier: float) -> int:
    desired = max(1, math.ceil(cfg.n_layers * (requested_multiplier - 1.0)))
    quantum = cfg.attention_every if cfg.mixer_mode == "hybrid" else 1
    return int(math.ceil(desired / quantum) * quantum)


def decide_growth(
    parent_payload: dict[str, Any], evidence: dict[str, Any] | None, *,
    requested_multiplier: float, max_parameter_multiplier: float,
    minimum_failed_interventions: int, plateau_threshold: float, force: bool,
) -> GrowthDecision:
    cfg = ModelConfig(**parent_payload["config"])
    source_parameters = parameter_count(ArchieHybridLM(cfg))
    evidence = evidence or {}
    failed = infer_failed_interventions(evidence)
    plateau = infer_plateau(evidence)
    add_layers = choose_add_layers(cfg, requested_multiplier)
    estimated = estimate_target_parameters(parent_payload, add_layers)
    multiplier = estimated / max(source_parameters, 1)
    evidence_digest = digest_json(evidence) if evidence else None
    structural_signal = failed >= minimum_failed_interventions and (
        plateau is None or plateau <= plateau_threshold
    )
    within_budget = multiplier <= max_parameter_multiplier
    approved = force or (structural_signal and within_budget)
    if force and not within_budget:
        approved = False
        reason = "forced growth still exceeds the declared parameter budget"
    elif force:
        reason = "explicitly forced bounded growth experiment"
    elif not structural_signal:
        reason = "evidence does not yet distinguish a capacity ceiling from a teaching failure"
    elif not within_budget:
        reason = "candidate exceeds the declared parameter multiplier"
    else:
        reason = "repeated failed interventions plus a measured plateau justify a descendant trial"
    return GrowthDecision(
        approved=approved, reason=reason, add_layers=add_layers,
        source_layers=cfg.n_layers, target_layers=cfg.n_layers + add_layers,
        source_parameters=source_parameters, estimated_target_parameters=estimated,
        failed_interventions=failed, plateau_relative_gain=plateau,
        parameter_multiplier=multiplier, evidence_digest=evidence_digest,
    )


def set_trainable_scope(model: ArchieHybridLM, new_block_indices: list[int], scope: str) -> int:
    for parameter in model.parameters():
        parameter.requires_grad_(scope == "all")
    if scope == "new-capacity":
        for index in new_block_indices:
            for parameter in model.blocks[index].parameters():
                parameter.requires_grad_(True)
    elif scope != "all":
        raise ValueError(f"unsupported trainable scope: {scope}")
    count = sum(parameter.numel() for parameter in model.parameters() if parameter.requires_grad)
    if count < 1:
        raise ValueError("trainable scope selected no parameters")
    return count


def resolve_amp(device: torch.device, requested: str) -> torch.dtype | None:
    if device.type != "cuda" or requested == "float32":
        return None
    if requested == "bfloat16":
        if not torch.cuda.is_bf16_supported():
            raise ValueError("bfloat16 requested on unsupported CUDA hardware")
        return torch.bfloat16
    if requested == "float16":
        return torch.float16
    major, _ = torch.cuda.get_device_capability(device)
    return torch.bfloat16 if major >= 8 and torch.cuda.is_bf16_supported() else torch.float16


def fixed_evaluate(
    model: ArchieHybridLM, corpus: pathlib.Path, *, sequence_length: int,
    batch_size: int, batches: int, seed: int, device: torch.device,
    amp_dtype: torch.dtype | None, byte_lengths: torch.Tensor,
) -> dict[str, float]:
    sampler = TokenSampler(corpus, sequence_length, batch_size, seed)
    return evaluate(model, sampler, device, batches, amp_dtype, byte_lengths, "byte")


def save_model_payload(
    path: pathlib.Path, model: ArchieHybridLM, template: dict[str, Any],
    growth: dict[str, Any], phase: str,
) -> str:
    raw_model = model._orig_mod if hasattr(model, "_orig_mod") else model
    payload = {
        "schema": MODEL_SCHEMA,
        "config": asdict(raw_model.cfg),
        "model": raw_model.state_dict(),
        "tokenizer": template.get("tokenizer"),
        "growth": {**growth, "latest_training_phase": phase},
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    torch.save(payload, path)
    return sha256_file(path)


def train_phase(
    model: ArchieHybridLM, *, phase: str, new_block_indices: list[int],
    train_corpus: pathlib.Path, eval_corpus: pathlib.Path, tokenizer: dict[str, Any],
    parent_bits_per_byte: float, steps: int, seed: int, device: torch.device,
    sequence_length: int, batch_size: int, eval_batch_size: int, eval_batches: int,
    learning_rate: float, weight_decay: float, grad_clip: float,
    amp_requested: str, evaluation_seed: int, output_model: pathlib.Path,
    payload_template: dict[str, Any], growth_metadata: dict[str, Any],
) -> PhaseResult:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    amp_dtype = resolve_amp(device, amp_requested)
    model.to(device)
    trainable = set_trainable_scope(model, new_block_indices, phase)
    optimizer = torch.optim.AdamW(
        [parameter for parameter in model.parameters() if parameter.requires_grad],
        lr=learning_rate, betas=(0.9, 0.95), eps=1e-8,
        weight_decay=weight_decay, fused=device.type == "cuda",
    )
    scaler = torch.amp.GradScaler(
        "cuda", enabled=device.type == "cuda" and amp_dtype == torch.float16
    )
    sampler = TokenSampler(train_corpus, sequence_length, batch_size, seed ^ 0x71C3)
    byte_lengths = torch.tensor(token_byte_lengths(tokenizer), dtype=torch.long, device=device)
    if device.type == "cuda":
        torch.cuda.reset_peak_memory_stats(device)
    started = time.monotonic()
    tokens_seen = 0
    model.train()
    for _ in range(steps):
        batch = sampler.batch(device)
        inputs = batch[:, :-1]
        optimizer.zero_grad(set_to_none=True)
        with torch.autocast(device_type=device.type, dtype=amp_dtype, enabled=amp_dtype is not None):
            logits = model(inputs)["logits"]
            nats, token_count, byte_count = next_token_statistics(logits, inputs, byte_lengths)
            loss = normalized_loss(nats, token_count, byte_count, "byte")
        scaler.scale(loss).backward()
        scaler.unscale_(optimizer)
        trainable_parameters = [
            parameter for parameter in model.parameters() if parameter.requires_grad
        ]
        norm = torch.nn.utils.clip_grad_norm_(trainable_parameters, grad_clip)
        if not math.isfinite(float(norm)) or not math.isfinite(float(loss.detach())):
            raise RuntimeError(f"non-finite update during {phase}")
        scaler.step(optimizer)
        scaler.update()
        tokens_seen += inputs.numel()
    metrics = fixed_evaluate(
        model, eval_corpus, sequence_length=sequence_length,
        batch_size=eval_batch_size, batches=eval_batches, seed=evaluation_seed,
        device=device, amp_dtype=amp_dtype, byte_lengths=byte_lengths,
    )
    model_digest = save_model_payload(
        output_model, model, payload_template, growth_metadata, phase
    )
    seconds = time.monotonic() - started
    peak = torch.cuda.max_memory_allocated(device) / 2**20 if device.type == "cuda" else None
    return PhaseResult(
        phase=phase, seed=seed, steps=steps, trainable_parameters=trainable,
        tokens_seen=tokens_seen, seconds=seconds,
        bits_per_byte=metrics["bits_per_byte"],
        relative_gain_vs_parent=(parent_bits_per_byte - metrics["bits_per_byte"])
        / max(parent_bits_per_byte, 1e-12),
        peak_allocated_mib=peak, model_sha256=model_digest,
    )


def evaluate_model_payload(
    payload: dict[str, Any], corpus: pathlib.Path, *, device: torch.device,
    sequence_length: int, batch_size: int, batches: int, seed: int,
    amp_requested: str,
) -> float:
    model = ArchieHybridLM(ModelConfig(**payload["config"]))
    model.load_state_dict(payload["model"])
    model.to(device)
    amp_dtype = resolve_amp(device, amp_requested)
    lengths = torch.tensor(
        token_byte_lengths(payload["tokenizer"]), dtype=torch.long, device=device
    )
    metrics = fixed_evaluate(
        model, corpus, sequence_length=sequence_length, batch_size=batch_size,
        batches=batches, seed=seed, device=device, amp_dtype=amp_dtype,
        byte_lengths=lengths,
    )
    return metrics["bits_per_byte"]


def execute_cycle(args: argparse.Namespace, decision: GrowthDecision) -> dict[str, Any]:
    state = pathlib.Path(args.state_dir).resolve()
    state.mkdir(parents=True, exist_ok=True)
    parent_path = pathlib.Path(args.parent_model).resolve()
    parent_payload = load_model_payload(parent_path)
    train_corpus = pathlib.Path(args.corpus).resolve()
    eval_corpus = pathlib.Path(args.eval_corpus).resolve()
    retention_corpus = pathlib.Path(args.retention_corpus).resolve() if args.retention_corpus else None
    train_metadata = verify_u16_corpus(train_corpus)
    eval_metadata = verify_u16_corpus(eval_corpus)
    if train_metadata["tokenizer"] != parent_payload.get("tokenizer"):
        raise ValueError("parent tokenizer does not match training corpus")
    if eval_metadata["tokenizer"] != parent_payload.get("tokenizer"):
        raise ValueError("parent tokenizer does not match evaluation corpus")
    retention_metadata = verify_u16_corpus(retention_corpus) if retention_corpus else None
    if retention_metadata and retention_metadata["tokenizer"] != parent_payload.get("tokenizer"):
        raise ValueError("parent tokenizer does not match retention corpus")
    device = torch.device(
        args.device if args.device != "auto" else ("cuda" if torch.cuda.is_available() else "cpu")
    )
    parent_eval = evaluate_model_payload(
        parent_payload, eval_corpus, device=device, sequence_length=args.sequence_length,
        batch_size=args.eval_batch_size, batches=args.eval_batches,
        seed=args.evaluation_seed, amp_requested=args.amp_dtype,
    )
    parent_retention = evaluate_model_payload(
        parent_payload, retention_corpus, device=device,
        sequence_length=args.sequence_length, batch_size=args.eval_batch_size,
        batches=args.eval_batches, seed=args.evaluation_seed ^ 0x9137,
        amp_requested=args.amp_dtype,
    ) if retention_corpus else None
    child, target_cfg, mapping, inserted = build_descendant(
        parent_payload, decision.add_layers, args.initialization_seed
    )
    birth = verify_birth(
        parent_payload, child, seeds=args.birth_seed,
        sequence_length=args.birth_sequence_length, tolerance=args.birth_tolerance,
    )
    if not birth["passed"]:
        raise RuntimeError("descendant failed function-preserving birth verification")
    growth_metadata = {
        "schema": GROWTH_SCHEMA,
        "parent_model_sha256": sha256_file(parent_path),
        "source_config": parent_payload["config"],
        "target_config": asdict(target_cfg),
        "parent_to_child_block": mapping,
        "new_block_indices": inserted,
        "source_parameters": decision.source_parameters,
        "target_parameters": parameter_count(child),
        "decision": asdict(decision),
        "birth_verification": birth,
    }
    born_path = state / "born-model.pt"
    born_sha = save_model_payload(born_path, child, parent_payload, growth_metadata, "birth")
    probation_path = state / "probation-model.pt"
    probation = train_phase(
        child, phase="new-capacity", new_block_indices=inserted,
        train_corpus=train_corpus, eval_corpus=eval_corpus,
        tokenizer=parent_payload["tokenizer"], parent_bits_per_byte=parent_eval,
        steps=args.probation_steps, seed=args.training_seed, device=device,
        sequence_length=args.sequence_length, batch_size=args.batch_size,
        eval_batch_size=args.eval_batch_size, eval_batches=args.eval_batches,
        learning_rate=args.probation_learning_rate, weight_decay=args.weight_decay,
        grad_clip=args.grad_clip, amp_requested=args.amp_dtype,
        evaluation_seed=args.evaluation_seed, output_model=probation_path,
        payload_template=parent_payload, growth_metadata=growth_metadata,
    )
    probation_passed = -probation.relative_gain_vs_parent <= args.maximum_probation_regression
    unfreeze: PhaseResult | None = None
    final_path = probation_path
    if probation_passed and args.unfreeze_steps > 0:
        final_path = state / "unfrozen-model.pt"
        unfreeze = train_phase(
            child, phase="all", new_block_indices=inserted,
            train_corpus=train_corpus, eval_corpus=eval_corpus,
            tokenizer=parent_payload["tokenizer"], parent_bits_per_byte=parent_eval,
            steps=args.unfreeze_steps, seed=args.training_seed ^ 0x51A7, device=device,
            sequence_length=args.sequence_length, batch_size=args.batch_size,
            eval_batch_size=args.eval_batch_size, eval_batches=args.eval_batches,
            learning_rate=args.unfreeze_learning_rate, weight_decay=args.weight_decay,
            grad_clip=args.grad_clip, amp_requested=args.amp_dtype,
            evaluation_seed=args.evaluation_seed, output_model=final_path,
            payload_template=parent_payload, growth_metadata=growth_metadata,
        )
    final_payload = load_model_payload(final_path)
    final_eval = evaluate_model_payload(
        final_payload, eval_corpus, device=device, sequence_length=args.sequence_length,
        batch_size=args.eval_batch_size, batches=args.eval_batches,
        seed=args.evaluation_seed, amp_requested=args.amp_dtype,
    )
    final_gain = (parent_eval - final_eval) / max(parent_eval, 1e-12)
    final_retention = evaluate_model_payload(
        final_payload, retention_corpus, device=device,
        sequence_length=args.sequence_length, batch_size=args.eval_batch_size,
        batches=args.eval_batches, seed=args.evaluation_seed ^ 0x9137,
        amp_requested=args.amp_dtype,
    ) if retention_corpus else None
    retention_regression = (
        (final_retention - parent_retention) / max(parent_retention, 1e-12)
        if final_retention is not None and parent_retention is not None else None
    )
    retention_available = retention_corpus is not None
    retention_passed = (
        retention_regression is not None
        and retention_regression <= args.maximum_retention_regression
    ) or (not retention_available and args.allow_no_retention)
    promotion_passed = (
        probation_passed
        and final_gain >= args.minimum_final_gain
        and retention_passed
    )
    receipt = {
        "schema": CYCLE_SCHEMA,
        "decision": asdict(decision),
        "parent": {
            "path": str(parent_path), "sha256": sha256_file(parent_path),
            "parameters": decision.source_parameters,
            "eval_bits_per_byte": parent_eval,
            "retention_bits_per_byte": parent_retention,
        },
        "birth": {**birth, "model_sha256": born_sha, "new_block_indices": inserted},
        "probation": {**asdict(probation), "passed": probation_passed},
        "unfreeze": asdict(unfreeze) if unfreeze else None,
        "final": {
            "path": str(final_path), "sha256": sha256_file(final_path),
            "parameters": decision.estimated_target_parameters,
            "eval_bits_per_byte": final_eval, "relative_eval_gain": final_gain,
            "retention_bits_per_byte": final_retention,
            "relative_retention_regression": retention_regression,
        },
        "gates": {
            "birth_equivalence": birth["passed"],
            "probation_non_destructive": probation_passed,
            "minimum_final_gain": {
                "threshold": args.minimum_final_gain, "observed": final_gain,
                "passed": final_gain >= args.minimum_final_gain,
            },
            "retention": {
                "required": not args.allow_no_retention,
                "available": retention_available,
                "maximum_regression": args.maximum_retention_regression,
                "observed_regression": retention_regression,
                "passed": retention_passed,
            },
        },
        "promotion": "research-candidate-not-admitted" if promotion_passed else "rejected",
        "claim_boundary": (
            "This cycle tests whether inherited function-preserving depth growth earns "
            "held-out improvement under a bounded budget. More parameters, successful "
            "optimization, or a single-corpus gain is not evidence of general intelligence."
        ),
        "corpora": {
            "train_sha256": train_metadata["sha256"],
            "evaluation_sha256": eval_metadata["sha256"],
            "retention_sha256": retention_metadata["sha256"] if retention_metadata else None,
        },
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    receipt["receipt_digest"] = digest_json(receipt)
    atomic_json(state / "regenerative-cycle-receipt.json", receipt)
    return receipt


def parser() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--parent-model", required=True)
    cli.add_argument("--evidence-json")
    cli.add_argument("--state-dir", required=True)
    cli.add_argument("--requested-parameter-multiplier", type=float, default=1.5)
    cli.add_argument("--max-parameter-multiplier", type=float, default=2.1)
    cli.add_argument("--minimum-failed-interventions", type=int, default=2)
    cli.add_argument("--plateau-threshold", type=float, default=0.003)
    cli.add_argument("--force-growth", action="store_true")
    cli.add_argument("--plan-only", action="store_true")
    cli.add_argument("--corpus")
    cli.add_argument("--eval-corpus")
    cli.add_argument("--retention-corpus")
    cli.add_argument("--device", default="auto")
    cli.add_argument("--sequence-length", type=int, default=512)
    cli.add_argument("--batch-size", type=int, default=2)
    cli.add_argument("--eval-batch-size", type=int, default=2)
    cli.add_argument("--eval-batches", type=int, default=16)
    cli.add_argument("--probation-steps", type=int, default=200)
    cli.add_argument("--unfreeze-steps", type=int, default=400)
    cli.add_argument("--probation-learning-rate", type=float, default=5e-4)
    cli.add_argument("--unfreeze-learning-rate", type=float, default=1e-4)
    cli.add_argument("--weight-decay", type=float, default=0.1)
    cli.add_argument("--grad-clip", type=float, default=1.0)
    cli.add_argument(
        "--amp-dtype", choices=["auto", "float16", "bfloat16", "float32"], default="auto"
    )
    cli.add_argument("--initialization-seed", type=int, default=20260722)
    cli.add_argument("--training-seed", type=int, default=20260723)
    cli.add_argument("--evaluation-seed", type=int, default=20260724)
    cli.add_argument("--birth-seed", action="append", type=int, default=[])
    cli.add_argument("--birth-sequence-length", type=int, default=64)
    cli.add_argument("--birth-tolerance", type=float, default=1e-6)
    cli.add_argument("--maximum-probation-regression", type=float, default=0.005)
    cli.add_argument("--minimum-final-gain", type=float, default=0.01)
    cli.add_argument("--maximum-retention-regression", type=float, default=0.0025)
    cli.add_argument(
        "--allow-no-retention", action="store_true",
        help="permit a research-candidate result without a separate retention corpus",
    )
    return cli


def main() -> None:
    args = parser().parse_args()
    if args.requested_parameter_multiplier <= 1.0:
        raise SystemExit("requested parameter multiplier must exceed one")
    if args.max_parameter_multiplier < args.requested_parameter_multiplier:
        raise SystemExit("maximum parameter multiplier is below the requested multiplier")
    parent_path = pathlib.Path(args.parent_model).resolve()
    parent_payload = load_model_payload(parent_path)
    evidence = (
        json.loads(pathlib.Path(args.evidence_json).read_text(encoding="utf-8"))
        if args.evidence_json else None
    )
    decision = decide_growth(
        parent_payload, evidence,
        requested_multiplier=args.requested_parameter_multiplier,
        max_parameter_multiplier=args.max_parameter_multiplier,
        minimum_failed_interventions=args.minimum_failed_interventions,
        plateau_threshold=args.plateau_threshold, force=args.force_growth,
    )
    decision_payload = {
        "schema": DECISION_SCHEMA,
        "parent_model_sha256": sha256_file(parent_path),
        "decision": asdict(decision),
        "boundary": (
            "Approval authorizes one bounded descendant experiment, not promotion. "
            "Rejection evidence must not be converted automatically into more parameters "
            "when representation, data, objective, or evaluation failure remains plausible."
        ),
    }
    decision_payload["receipt_digest"] = digest_json(decision_payload)
    state = pathlib.Path(args.state_dir).resolve()
    state.mkdir(parents=True, exist_ok=True)
    atomic_json(state / "growth-decision.json", decision_payload)
    if args.plan_only or not decision.approved:
        print(json.dumps(decision_payload, indent=2, sort_keys=True))
        return
    if not args.corpus or not args.eval_corpus:
        raise SystemExit("approved execution requires --corpus and --eval-corpus")
    if not args.birth_seed:
        args.birth_seed = [20260731, 20260801, 20260802]
    receipt = execute_cycle(args, decision)
    print(json.dumps(receipt, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
