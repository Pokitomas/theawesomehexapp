#!/usr/bin/env python3
"""Disjoint causal court for Sidepus state, plasticity, and adaptive computation."""
from __future__ import annotations

import argparse
import json
import math
import pathlib
from collections import defaultdict
from typing import Any, Mapping

import torch
import torch.nn.functional as F

from archie_hybrid_core import ArchieHybridLM, ByteTokenizer, ModelConfig, PAD_ID
from archie_hybrid_corpus import sha256_file, verify_u16_corpus
from archie_tokenizers import token_byte_lengths, tokenizer_from_metadata
from archie_sidepus_organism import MODEL_SCHEMA, ArchieSidepusOrganism, OrganismConfig
from sidepus_pursuit_forward import pursuit_forward
from sidepus_pursuit_plan import digest_json, read_jsonl
from sidepus_pursuit_stream import PursuitExperienceStream
from train_archie_hybrid import TokenSampler, evaluate as evaluate_base, next_token_statistics

RECEIPT_SCHEMA = "archie-sidepus-disjoint-causal-court/v1"


def _write_json(path: pathlib.Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(dict(value), indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _reset_changed_threads(
    tensor: torch.Tensor | None,
    current: list[str],
    previous: list[str] | None,
) -> torch.Tensor | None:
    if tensor is None or previous is None:
        return tensor
    if len(current) != len(previous):
        return None
    flags = [left != right for left, right in zip(current, previous)]
    if not any(flags):
        return tensor
    value = tensor.clone()
    value[torch.tensor(flags, dtype=torch.bool, device=value.device)] = 0
    return value


def _threads(rows: list[dict[str, Any]]) -> list[str]:
    return [str(row.get("state_thread_id", row.get("intent_id", ""))) for row in rows]


def _accumulate_condition(
    totals: dict[str, dict[str, float]],
    name: str,
    output: Mapping[str, torch.Tensor],
    inputs: torch.Tensor,
    byte_lengths: torch.Tensor,
) -> None:
    nats, tokens, bytes_ = next_token_statistics(output["logits"], inputs, byte_lengths)
    totals[name]["nats"] += float(nats.detach().cpu())
    totals[name]["tokens"] += float(tokens.detach().cpu())
    totals[name]["bytes"] += float(bytes_.detach().cpu())


def _masked_sum(value: torch.Tensor, mask: torch.Tensor) -> float:
    return float(value.masked_select(mask).sum().detach().cpu()) if bool(mask.any()) else 0.0


def _deliberation_batch(
    result: Mapping[str, torch.Tensor],
    inputs: torch.Tensor,
    *,
    compute_cost: float,
) -> dict[str, float]:
    targets = inputs[:, 1:].contiguous()
    valid = targets.ne(PAD_ID)
    valid_count = float(valid.sum().detach().cpu())
    if valid_count <= 0:
        return defaultdict(float)

    logits = result["logits"][:, :-1].contiguous().float()
    dynamic_loss = F.cross_entropy(
        logits.view(-1, logits.size(-1)),
        targets.view(-1),
        ignore_index=PAD_ID,
        reduction="none",
    ).view_as(targets)
    step_losses = result["deliberation_token_losses"].float()
    halt_weights = result["halt_weights"][:, :-1].float()
    depth = step_losses.size(0)
    numbers = torch.arange(depth, device=step_losses.device, dtype=step_losses.dtype)
    step_scores = step_losses + compute_cost * numbers[:, None, None]
    expected_steps = (halt_weights * (numbers + 1.0)[None, None, :]).sum(dim=-1)
    dynamic_score = dynamic_loss + compute_cost * (expected_steps - 1.0)
    oracle_score, oracle_index = step_scores.min(dim=0)
    halt_index = halt_weights.argmax(dim=-1)

    return {
        "tokens": valid_count,
        "dynamic_loss": _masked_sum(dynamic_loss, valid),
        "step1_loss": _masked_sum(step_losses[0], valid),
        "max_depth_loss": _masked_sum(step_losses[-1], valid),
        "dynamic_score": _masked_sum(dynamic_score, valid),
        "step1_score": _masked_sum(step_scores[0], valid),
        "max_depth_score": _masked_sum(step_scores[-1], valid),
        "oracle_score": _masked_sum(oracle_score, valid),
        "oracle_extra": _masked_sum(oracle_index.gt(0).float(), valid),
        "halt_extra": _masked_sum(halt_index.gt(0).float(), valid),
        "halt_agreement": _masked_sum(halt_index.eq(oracle_index).float(), valid),
        "expected_steps": _masked_sum(expected_steps, valid),
    }


def _merge_numeric(target: dict[str, float], source: Mapping[str, float]) -> None:
    for key, value in source.items():
        target[key] = target.get(key, 0.0) + float(value)


def _condition_forward(
    model: ArchieSidepusOrganism,
    inputs: torch.Tensor,
    *,
    world_state: torch.Tensor | None,
    plastic_state: torch.Tensor | None,
    amp_dtype: torch.dtype | None,
    labels: bool = False,
) -> dict[str, torch.Tensor]:
    with torch.autocast(
        device_type=inputs.device.type,
        dtype=amp_dtype,
        enabled=amp_dtype is not None,
    ):
        return pursuit_forward(
            model,
            inputs,
            labels=inputs if labels else None,
            world_state=world_state,
            plastic_state=plastic_state,
        )


@torch.no_grad()
def evaluate_candidate(
    *,
    model: ArchieSidepusOrganism,
    plan: pathlib.Path,
    plan_receipt: pathlib.Path,
    sidepus_state: pathlib.Path,
    cache_dir: pathlib.Path,
    cache_bytes: int,
    batches: int,
    batch_size: int,
    sequence_length: int,
    wrong_offset_batches: int,
    device: torch.device,
    amp_dtype: torch.dtype | None,
    byte_lengths: torch.Tensor,
    prefetch_workers: int,
    compute_cost: float,
    seed: int,
) -> dict[str, Any]:
    if batches < 1 or wrong_offset_batches < 1:
        raise ValueError("batches and wrong_offset_batches must be positive")
    totals: dict[str, dict[str, float]] = defaultdict(
        lambda: {"nats": 0.0, "tokens": 0.0, "bytes": 0.0}
    )
    diagnostics: dict[str, float] = defaultdict(float)
    deliberation: dict[str, float] = {}
    model.eval()

    common = dict(
        state_dir=sidepus_state,
        cache_bytes=cache_bytes,
        batch_size=batch_size,
        sequence_length=sequence_length,
        workers=prefetch_workers,
        lookahead=batch_size,
    )
    with PursuitExperienceStream(
        plan, plan_receipt,
        cache_dir=cache_dir / "correct",
        seed=seed,
        ledger=cache_dir / "correct-ledger.jsonl",
        **common,
    ) as correct_stream, PursuitExperienceStream(
        plan, plan_receipt,
        cache_dir=cache_dir / "wrong",
        seed=seed ^ 0xBADC0DE,
        ledger=cache_dir / "wrong-ledger.jsonl",
        **common,
    ) as wrong_stream:
        wrong_world = wrong_plastic = None
        wrong_previous: list[str] | None = None

        def advance_foreign_bank() -> None:
            nonlocal wrong_world, wrong_plastic, wrong_previous
            wrong_batch, wrong_rows = wrong_stream.batch_with_rows(device)
            wrong_inputs = wrong_batch[:, :-1]
            wrong_now = _threads(wrong_rows)
            wrong_world = _reset_changed_threads(wrong_world, wrong_now, wrong_previous)
            wrong_plastic = _reset_changed_threads(wrong_plastic, wrong_now, wrong_previous)
            wrong_update = _condition_forward(
                model,
                wrong_inputs,
                world_state=wrong_world,
                plastic_state=wrong_plastic,
                amp_dtype=amp_dtype,
            )
            wrong_world = wrong_update["world_state"].detach()
            wrong_plastic = (
                wrong_update["plastic_state"].detach()
                if "plastic_state" in wrong_update else None
            )
            wrong_stream.remember_state(wrong_now, wrong_world, wrong_plastic)
            wrong_previous = wrong_now

        for _ in range(wrong_offset_batches):
            advance_foreign_bank()

        correct_world = correct_plastic = None
        correct_previous: list[str] | None = None
        for _ in range(batches):
            correct_batch, correct_rows = correct_stream.batch_with_rows(device)
            inputs = correct_batch[:, :-1]
            current = _threads(correct_rows)
            correct_world = _reset_changed_threads(correct_world, current, correct_previous)
            correct_plastic = _reset_changed_threads(correct_plastic, current, correct_previous)

            full = _condition_forward(
                model,
                inputs,
                world_state=correct_world,
                plastic_state=correct_plastic,
                amp_dtype=amp_dtype,
                labels=True,
            )
            _accumulate_condition(totals, "correct", full, inputs, byte_lengths)
            _merge_numeric(deliberation, _deliberation_batch(full, inputs, compute_cost=compute_cost))

            reset = _condition_forward(
                model, inputs, world_state=None, plastic_state=None, amp_dtype=amp_dtype
            )
            _accumulate_condition(totals, "reset", reset, inputs, byte_lengths)

            foreign_world, foreign_plastic, foreign_threads = wrong_stream.foreign_state(current, device)
            attempts = 0
            while foreign_threads is None and attempts < max(8, wrong_offset_batches):
                advance_foreign_bank()
                foreign_world, foreign_plastic, foreign_threads = wrong_stream.foreign_state(
                    current, device
                )
                attempts += 1
            if foreign_threads is None:
                raise RuntimeError("admission court could not obtain a foreign-history state")
            if any(left == right for left, right in zip(current, foreign_threads)):
                raise RuntimeError("foreign-state bank returned the current evidence lineage")
            wrong = _condition_forward(
                model,
                inputs,
                world_state=foreign_world,
                plastic_state=foreign_plastic,
                amp_dtype=amp_dtype,
            )
            _accumulate_condition(totals, "wrong", wrong, inputs, byte_lengths)
            diagnostics["foreign_state_comparisons"] += float(len(foreign_threads))

            world_only = _condition_forward(
                model,
                inputs,
                world_state=correct_world,
                plastic_state=None,
                amp_dtype=amp_dtype,
            )
            _accumulate_condition(totals, "world_only", world_only, inputs, byte_lengths)
            plastic_only = _condition_forward(
                model,
                inputs,
                world_state=None,
                plastic_state=correct_plastic,
                amp_dtype=amp_dtype,
            )
            _accumulate_condition(totals, "plastic_only", plastic_only, inputs, byte_lengths)

            correct_world = full["world_state"].detach()
            correct_plastic = (
                full["plastic_state"].detach() if "plastic_state" in full else None
            )
            correct_previous = current
            for key in (
                "state_gate_mean",
                "thought_gate_mean",
                "active_slot_fraction",
                "expected_deliberation_steps",
                "state_l2",
                "plastic_l2",
            ):
                diagnostics[key] += float(full[key].detach().float().cpu())
            advance_foreign_bank()

    conditions: dict[str, dict[str, float]] = {}
    for name, values in totals.items():
        conditions[name] = {
            "bits_per_byte": values["nats"] / max(values["bytes"], 1.0) / math.log(2.0),
            "nats_per_token": values["nats"] / max(values["tokens"], 1.0),
            "evaluated_tokens": values["tokens"],
            "evaluated_bytes": values["bytes"],
        }
    correct_bpb = conditions["correct"]["bits_per_byte"]
    effects = {
        "gain_vs_reset": conditions["reset"]["bits_per_byte"] - correct_bpb,
        "gain_vs_wrong": conditions["wrong"]["bits_per_byte"] - correct_bpb,
        "gain_vs_world_only": conditions["world_only"]["bits_per_byte"] - correct_bpb,
        "gain_vs_plastic_only": conditions["plastic_only"]["bits_per_byte"] - correct_bpb,
    }

    token_count = max(deliberation.get("tokens", 0.0), 1.0)
    deliberation_metrics = {
        "evaluated_tokens": deliberation.get("tokens", 0.0),
        "dynamic_nats_per_token": deliberation.get("dynamic_loss", 0.0) / token_count,
        "step1_nats_per_token": deliberation.get("step1_loss", 0.0) / token_count,
        "max_depth_nats_per_token": deliberation.get("max_depth_loss", 0.0) / token_count,
        "dynamic_score_per_token": deliberation.get("dynamic_score", 0.0) / token_count,
        "step1_score_per_token": deliberation.get("step1_score", 0.0) / token_count,
        "max_depth_score_per_token": deliberation.get("max_depth_score", 0.0) / token_count,
        "oracle_score_per_token": deliberation.get("oracle_score", 0.0) / token_count,
        "raw_gain_vs_step1": (
            deliberation.get("step1_loss", 0.0) - deliberation.get("dynamic_loss", 0.0)
        ) / token_count,
        "compute_adjusted_gain_vs_step1": (
            deliberation.get("step1_score", 0.0) - deliberation.get("dynamic_score", 0.0)
        ) / token_count,
        "compute_adjusted_gain_vs_max_depth": (
            deliberation.get("max_depth_score", 0.0) - deliberation.get("dynamic_score", 0.0)
        ) / token_count,
        "halt_regret": (
            deliberation.get("dynamic_score", 0.0) - deliberation.get("oracle_score", 0.0)
        ) / token_count,
        "oracle_extra_step_fraction": deliberation.get("oracle_extra", 0.0) / token_count,
        "halt_extra_step_fraction": deliberation.get("halt_extra", 0.0) / token_count,
        "halt_oracle_agreement": deliberation.get("halt_agreement", 0.0) / token_count,
        "mean_expected_steps": deliberation.get("expected_steps", 0.0) / token_count,
        "compute_cost_nats_per_extra_step": compute_cost,
    }
    diagnostics_result = {
        key: (value / batches if key != "foreign_state_comparisons" else value)
        for key, value in sorted(diagnostics.items())
    }
    return {
        "conditions": conditions,
        "effects": effects,
        "deliberation": deliberation_metrics,
        "diagnostics": diagnostics_result,
    }


def load_base(path: pathlib.Path, device: torch.device) -> ArchieHybridLM:
    payload = torch.load(path, map_location=device, weights_only=False)
    if payload.get("schema") != "archie-scratch-hybrid-model/v1":
        raise ValueError("base model schema is unsupported")
    model = ArchieHybridLM(ModelConfig(**payload["config"])).to(device)
    model.load_state_dict(payload["model"])
    model.eval()
    return model


def retention_metrics(
    *,
    model: ArchieSidepusOrganism,
    base_model: ArchieHybridLM,
    retention_path: pathlib.Path,
    batches: int,
    sequence_length: int,
    device: torch.device,
    amp_dtype: torch.dtype | None,
    byte_lengths: torch.Tensor,
) -> dict[str, Any]:
    base_sampler = TokenSampler(retention_path, sequence_length, 1, 0x51DE)
    candidate_sampler = TokenSampler(retention_path, sequence_length, 1, 0x51DE)
    base = evaluate_base(
        base_model,
        base_sampler,
        device,
        batches,
        amp_dtype,
        byte_lengths,
        "byte",
    )
    total_nats = total_tokens = total_bytes = 0.0
    model.eval()
    with torch.no_grad():
        for _ in range(batches):
            batch = candidate_sampler.batch(device)
            inputs = batch[:, :-1]
            with torch.autocast(
                device_type=device.type,
                dtype=amp_dtype,
                enabled=amp_dtype is not None,
            ):
                output = pursuit_forward(model, inputs)
            nats, tokens, bytes_ = next_token_statistics(output["logits"], inputs, byte_lengths)
            total_nats += float(nats.cpu())
            total_tokens += float(tokens.cpu())
            total_bytes += float(bytes_.cpu())
    candidate = {
        "loss": total_nats / max(total_bytes, 1.0),
        "bits_per_byte": total_nats / max(total_bytes, 1.0) / math.log(2.0),
        "nats_per_token": total_nats / max(total_tokens, 1.0),
    }
    regression = (
        candidate["bits_per_byte"] - base["bits_per_byte"]
    ) / max(base["bits_per_byte"], 1e-12)
    return {"base": base, "candidate": candidate, "relative_regression": regression}


def plan_identity(path: pathlib.Path) -> dict[str, Any]:
    rows = read_jsonl(path)
    record_ids = sorted({str(row.get("record_id", "")) for row in rows})
    threads = sorted({str(row.get("state_thread_id", "")) for row in rows})
    windows = sorted({str(row.get("window_seed", "")) for row in rows})
    return {
        "rows": len(rows),
        "record_id_digest": digest_json(record_ids),
        "state_thread_digest": digest_json(threads),
        "window_seed_digest": digest_json(windows),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--base-model", required=True)
    parser.add_argument("--plan", required=True)
    parser.add_argument("--plan-receipt", required=True)
    parser.add_argument("--sidepus-state", required=True)
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--cache-bytes", type=int, default=2147483648)
    parser.add_argument("--retention-corpus", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--split-receipt")
    parser.add_argument("--split-name", choices=("development", "admission"))
    parser.add_argument("--batches", type=int, default=48)
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument("--sequence-length", type=int, default=1024)
    parser.add_argument("--wrong-offset-batches", type=int, default=53)
    parser.add_argument("--retention-batches", type=int, default=24)
    parser.add_argument("--retention-sequence-length", type=int, default=512)
    parser.add_argument("--prefetch-workers", type=int, default=4)
    parser.add_argument("--compute-cost", type=float, default=0.002)
    parser.add_argument("--minimum-reset-gain", type=float, default=0.0)
    parser.add_argument("--minimum-wrong-gain", type=float, default=0.0)
    parser.add_argument("--minimum-oracle-extra-fraction", type=float, default=0.01)
    parser.add_argument("--minimum-compute-gain-vs-step1", type=float, default=0.0)
    parser.add_argument("--maximum-halt-regret", type=float, default=0.02)
    parser.add_argument("--maximum-retention-regression", type=float, default=0.05)
    parser.add_argument("--seed", type=int, default=20260723)
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--amp-dtype", choices=("float16", "bfloat16", "float32"), default="float16")
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args()

    device = torch.device(args.device)
    candidate_path = pathlib.Path(args.candidate).expanduser().resolve()
    payload = torch.load(candidate_path, map_location=device, weights_only=False)
    if payload.get("schema") != MODEL_SCHEMA:
        raise SystemExit("candidate is not an integrated Sidepus organism")
    model = ArchieSidepusOrganism(OrganismConfig(**payload["config"])).to(device)
    model.load_state_dict(payload["model"])
    model.eval()

    retention_path = pathlib.Path(args.retention_corpus).expanduser().resolve()
    metadata = verify_u16_corpus(retention_path)
    tokenizer = tokenizer_from_metadata(metadata["tokenizer"])
    if tokenizer.metadata() != ByteTokenizer.metadata():
        raise SystemExit("evaluation requires byte tokenizer")
    byte_lengths = torch.tensor(
        token_byte_lengths(metadata["tokenizer"]), dtype=torch.long, device=device
    )
    amp_dtype = (
        {"float16": torch.float16, "bfloat16": torch.bfloat16, "float32": None}[args.amp_dtype]
        if device.type == "cuda" else None
    )

    plan = pathlib.Path(args.plan).expanduser().resolve()
    plan_receipt = pathlib.Path(args.plan_receipt).expanduser().resolve()
    split_binding: dict[str, Any] | None = None
    if args.split_receipt or args.split_name:
        if not args.split_receipt or not args.split_name:
            raise SystemExit("split-receipt and split-name must be supplied together")
        split_receipt_path = pathlib.Path(args.split_receipt).expanduser().resolve()
        split = json.loads(split_receipt_path.read_text(encoding="utf-8"))
        split_body = dict(split)
        expected_split_digest = split_body.pop("receipt_digest", None)
        if expected_split_digest != digest_json(split_body) or split.get("hard_disjoint") is not True:
            raise SystemExit("evidence split receipt is invalid or not hard-disjoint")
        entry = split.get("splits", {}).get(args.split_name, {})
        receipt = json.loads(plan_receipt.read_text(encoding="utf-8"))
        if receipt.get("inventory_sha256") != entry.get("sha256"):
            raise SystemExit("evaluation plan is not bound to the declared evidence split")
        split_binding = {
            "receipt": str(split_receipt_path),
            "receipt_sha256": sha256_file(split_receipt_path),
            "name": args.split_name,
            "inventory_sha256": entry.get("sha256"),
        }

    causal = evaluate_candidate(
        model=model,
        plan=plan,
        plan_receipt=plan_receipt,
        sidepus_state=pathlib.Path(args.sidepus_state).expanduser().resolve(),
        cache_dir=pathlib.Path(args.cache_dir).expanduser().resolve(),
        cache_bytes=args.cache_bytes,
        batches=args.batches,
        batch_size=args.batch_size,
        sequence_length=args.sequence_length,
        wrong_offset_batches=args.wrong_offset_batches,
        device=device,
        amp_dtype=amp_dtype,
        byte_lengths=byte_lengths,
        prefetch_workers=args.prefetch_workers,
        compute_cost=args.compute_cost,
        seed=args.seed,
    )
    base_model = load_base(pathlib.Path(args.base_model).expanduser().resolve(), device)
    retention = retention_metrics(
        model=model,
        base_model=base_model,
        retention_path=retention_path,
        batches=args.retention_batches,
        sequence_length=args.retention_sequence_length,
        device=device,
        amp_dtype=amp_dtype,
        byte_lengths=byte_lengths,
    )

    effects = causal["effects"]
    thought = causal["deliberation"]
    checks = {
        "correct_beats_reset": effects["gain_vs_reset"] >= args.minimum_reset_gain,
        "correct_beats_wrong": effects["gain_vs_wrong"] >= args.minimum_wrong_gain,
        "oracle_uses_extra_depth": (
            thought["oracle_extra_step_fraction"] >= args.minimum_oracle_extra_fraction
        ),
        "dynamic_compute_beats_step1": (
            thought["compute_adjusted_gain_vs_step1"] >= args.minimum_compute_gain_vs_step1
        ),
        "halt_regret_bounded": thought["halt_regret"] <= args.maximum_halt_regret,
        "language_retention": (
            retention["relative_regression"] <= args.maximum_retention_regression
        ),
    }
    development_score = (
        effects["gain_vs_reset"]
        + effects["gain_vs_wrong"]
        + thought["compute_adjusted_gain_vs_step1"] / math.log(2.0)
        - thought["halt_regret"] / math.log(2.0)
        - 2.0 * max(0.0, retention["relative_regression"])
    )
    receipt: dict[str, Any] = {
        "schema": RECEIPT_SCHEMA,
        "candidate": str(candidate_path),
        "candidate_sha256": sha256_file(candidate_path),
        "base_model": str(pathlib.Path(args.base_model).expanduser().resolve()),
        "base_model_sha256": sha256_file(pathlib.Path(args.base_model).expanduser().resolve()),
        "plan": str(plan),
        "plan_sha256": sha256_file(plan),
        "plan_receipt_sha256": sha256_file(plan_receipt),
        "plan_identity": plan_identity(plan),
        "split_binding": split_binding,
        "causal": causal,
        "retention": retention,
        "thresholds": {
            "minimum_reset_gain": args.minimum_reset_gain,
            "minimum_wrong_gain": args.minimum_wrong_gain,
            "minimum_oracle_extra_fraction": args.minimum_oracle_extra_fraction,
            "minimum_compute_gain_vs_step1": args.minimum_compute_gain_vs_step1,
            "maximum_halt_regret": args.maximum_halt_regret,
            "maximum_retention_regression": args.maximum_retention_regression,
        },
        "checks": checks,
        "development_score": development_score,
        "development_score_formula": (
            "gain_vs_reset_bpb + gain_vs_wrong_bpb + compute_gain_bits_per_token "
            "- halt_regret_bits_per_token - 2*positive_retention_regression"
        ),
        "passed": all(checks.values()),
        "promotion": "disjoint-causal-candidate" if all(checks.values()) else "falsified",
        "claim_boundary": (
            "Passing establishes bounded state and adaptive-compute effects on the declared disjoint split. "
            "It does not establish pursuit superiority unless a matched sequential control loses on the same admission plan."
        ),
    }
    receipt["receipt_digest"] = digest_json(receipt)
    output = pathlib.Path(args.output).expanduser().resolve()
    _write_json(output, receipt)
    print(json.dumps(receipt, indent=2, sort_keys=True))
    if args.strict and not receipt["passed"]:
        raise SystemExit(3)


if __name__ == "__main__":
    main()
