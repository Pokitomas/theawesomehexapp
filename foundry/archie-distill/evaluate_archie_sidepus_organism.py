#!/usr/bin/env python3
"""Frozen causal evaluation for an integrated Sidepus organism candidate."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import pathlib
from collections import defaultdict
from typing import Any

import torch

from archie_hybrid_core import ArchieHybridLM, ByteTokenizer, ModelConfig
from archie_hybrid_corpus import sha256_file, stable_json, verify_u16_corpus
from archie_tokenizers import token_byte_lengths, tokenizer_from_metadata
from archie_sidepus_organism import MODEL_SCHEMA, ArchieSidepusOrganism, OrganismConfig
from sidepus_training_stream import PlanBatchSampler, digest_json
from train_archie_hybrid import TokenSampler, evaluate as evaluate_base, next_token_statistics

RECEIPT_SCHEMA = "archie-sidepus-organism-causal-evaluation/v1"


def apply_domain_reset(
    tensor: torch.Tensor | None,
    current: list[str],
    previous: list[str] | None,
) -> torch.Tensor | None:
    if tensor is None or previous is None:
        return tensor
    flags = [a != b for a, b in zip(current, previous)]
    if not any(flags):
        return tensor
    value = tensor.clone()
    value[torch.tensor(flags, dtype=torch.bool, device=value.device)] = 0
    return value


def condition_loss(
    model: ArchieSidepusOrganism,
    inputs: torch.Tensor,
    byte_lengths: torch.Tensor,
    *,
    world_state: torch.Tensor | None,
    plastic_state: torch.Tensor | None,
    amp_dtype: torch.dtype | None,
) -> tuple[dict[str, torch.Tensor], float, float, float]:
    with torch.autocast(
        device_type=inputs.device.type,
        dtype=amp_dtype,
        enabled=amp_dtype is not None,
    ):
        output = model(
            inputs,
            world_state=world_state,
            plastic_state=plastic_state,
            return_diagnostics=True,
        )
    nats, tokens, bytes_ = next_token_statistics(output["logits"], inputs, byte_lengths)
    return output, float(nats.cpu()), float(tokens.cpu()), float(bytes_.cpu())


@torch.no_grad()
def evaluate_candidate(
    *,
    model: ArchieSidepusOrganism,
    plan: pathlib.Path,
    plan_receipt: pathlib.Path,
    batches: int,
    batch_size: int,
    sequence_length: int,
    wrong_offset_batches: int,
    device: torch.device,
    amp_dtype: torch.dtype | None,
    byte_lengths: torch.Tensor,
    prefetch_workers: int,
) -> dict[str, Any]:
    totals: dict[str, dict[str, float]] = defaultdict(
        lambda: {"nats": 0.0, "tokens": 0.0, "bytes": 0.0}
    )
    diagnostics = defaultdict(float)
    model.eval()
    with PlanBatchSampler(
        plan,
        plan_receipt,
        batch_size=batch_size,
        sequence_length=sequence_length,
        workers=prefetch_workers,
    ) as correct_stream, PlanBatchSampler(
        plan,
        plan_receipt,
        batch_size=batch_size,
        sequence_length=sequence_length,
        workers=prefetch_workers,
    ) as wrong_stream:
        wrong_stream.cursor = wrong_offset_batches * batch_size
        correct_world = correct_plastic = None
        wrong_world = wrong_plastic = None
        correct_domains: list[str] | None = None
        wrong_domains: list[str] | None = None
        for _ in range(batches):
            correct_batch, correct_rows = correct_stream.batch_with_rows(device)
            wrong_batch, wrong_rows = wrong_stream.batch_with_rows(device)
            inputs = correct_batch[:, :-1]
            wrong_inputs = wrong_batch[:, :-1]
            domains = [str(row.get("primary_domain", "unknown")) for row in correct_rows]
            wrong_now = [str(row.get("primary_domain", "unknown")) for row in wrong_rows]
            correct_world = apply_domain_reset(correct_world, domains, correct_domains)
            correct_plastic = apply_domain_reset(correct_plastic, domains, correct_domains)
            wrong_world = apply_domain_reset(wrong_world, wrong_now, wrong_domains)
            wrong_plastic = apply_domain_reset(wrong_plastic, wrong_now, wrong_domains)

            full, nats, tokens, bytes_ = condition_loss(
                model,
                inputs,
                byte_lengths,
                world_state=correct_world,
                plastic_state=correct_plastic,
                amp_dtype=amp_dtype,
            )
            for key, value in zip(("nats", "tokens", "bytes"), (nats, tokens, bytes_)):
                totals["correct"][key] += value

            _, nats, tokens, bytes_ = condition_loss(
                model,
                inputs,
                byte_lengths,
                world_state=None,
                plastic_state=None,
                amp_dtype=amp_dtype,
            )
            for key, value in zip(("nats", "tokens", "bytes"), (nats, tokens, bytes_)):
                totals["reset"][key] += value

            _, nats, tokens, bytes_ = condition_loss(
                model,
                inputs,
                byte_lengths,
                world_state=wrong_world,
                plastic_state=wrong_plastic,
                amp_dtype=amp_dtype,
            )
            for key, value in zip(("nats", "tokens", "bytes"), (nats, tokens, bytes_)):
                totals["wrong"][key] += value

            _, nats, tokens, bytes_ = condition_loss(
                model,
                inputs,
                byte_lengths,
                world_state=correct_world,
                plastic_state=None,
                amp_dtype=amp_dtype,
            )
            for key, value in zip(("nats", "tokens", "bytes"), (nats, tokens, bytes_)):
                totals["world_only"][key] += value

            _, nats, tokens, bytes_ = condition_loss(
                model,
                inputs,
                byte_lengths,
                world_state=None,
                plastic_state=correct_plastic,
                amp_dtype=amp_dtype,
            )
            for key, value in zip(("nats", "tokens", "bytes"), (nats, tokens, bytes_)):
                totals["plastic_only"][key] += value

            wrong_update = model(
                wrong_inputs,
                world_state=wrong_world,
                plastic_state=wrong_plastic,
            )
            correct_world = full["world_state"].detach()
            correct_plastic = (
                full["plastic_state"].detach() if "plastic_state" in full else None
            )
            wrong_world = wrong_update["world_state"].detach()
            wrong_plastic = (
                wrong_update["plastic_state"].detach()
                if "plastic_state" in wrong_update
                else None
            )
            correct_domains = domains
            wrong_domains = wrong_now
            for key in (
                "state_gate_mean",
                "thought_gate_mean",
                "active_slot_fraction",
                "expected_deliberation_steps",
                "state_l2",
                "plastic_l2",
            ):
                diagnostics[key] += float(full[key].detach().float().cpu())

    metrics: dict[str, dict[str, float]] = {}
    for name, values in totals.items():
        metrics[name] = {
            "bits_per_byte": values["nats"] / max(values["bytes"], 1.0) / math.log(2.0),
            "nats_per_token": values["nats"] / max(values["tokens"], 1.0),
            "evaluated_tokens": values["tokens"],
            "evaluated_bytes": values["bytes"],
        }
    correct = metrics["correct"]["bits_per_byte"]
    effects = {
        "gain_vs_reset": metrics["reset"]["bits_per_byte"] - correct,
        "gain_vs_wrong": metrics["wrong"]["bits_per_byte"] - correct,
        "gain_vs_world_only": metrics["world_only"]["bits_per_byte"] - correct,
        "gain_vs_plastic_only": metrics["plastic_only"]["bits_per_byte"] - correct,
    }
    return {
        "conditions": metrics,
        "effects": effects,
        "diagnostics": {key: value / batches for key, value in sorted(diagnostics.items())},
    }


def load_base(path: pathlib.Path, device: torch.device) -> ArchieHybridLM:
    payload = torch.load(path, map_location=device, weights_only=False)
    if payload.get("schema") != "archie-scratch-hybrid-model/v1":
        raise ValueError("base model schema is unsupported")
    model = ArchieHybridLM(ModelConfig(**payload["config"])).to(device)
    model.load_state_dict(payload["model"])
    model.eval()
    return model


def main() -> None:
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--candidate", required=True)
    cli.add_argument("--base-model", required=True)
    cli.add_argument("--plan", required=True)
    cli.add_argument("--plan-receipt", required=True)
    cli.add_argument("--retention-corpus", required=True)
    cli.add_argument("--output", required=True)
    cli.add_argument("--batches", type=int, default=48)
    cli.add_argument("--batch-size", type=int, default=1)
    cli.add_argument("--sequence-length", type=int, default=1024)
    cli.add_argument("--wrong-offset-batches", type=int, default=97)
    cli.add_argument("--retention-batches", type=int, default=24)
    cli.add_argument("--retention-sequence-length", type=int, default=512)
    cli.add_argument("--prefetch-workers", type=int, default=4)
    cli.add_argument("--minimum-reset-gain", type=float, default=0.01)
    cli.add_argument("--minimum-wrong-gain", type=float, default=0.01)
    cli.add_argument("--maximum-retention-regression", type=float, default=0.05)
    cli.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    cli.add_argument("--amp-dtype", choices=("float16", "bfloat16", "float32"), default="float16")
    args = cli.parse_args()

    device = torch.device(args.device)
    candidate_path = pathlib.Path(args.candidate).resolve()
    payload = torch.load(candidate_path, map_location=device, weights_only=False)
    if payload.get("schema") != MODEL_SCHEMA:
        raise SystemExit("candidate is not an integrated Sidepus organism")
    model = ArchieSidepusOrganism(OrganismConfig(**payload["config"])).to(device)
    model.load_state_dict(payload["model"])
    model.eval()

    retention_path = pathlib.Path(args.retention_corpus).resolve()
    retention_metadata = verify_u16_corpus(retention_path)
    tokenizer = tokenizer_from_metadata(retention_metadata["tokenizer"])
    if tokenizer.metadata() != ByteTokenizer.metadata():
        raise SystemExit("evaluation requires byte tokenizer")
    byte_lengths = torch.tensor(
        token_byte_lengths(retention_metadata["tokenizer"]), dtype=torch.long, device=device
    )
    amp_dtype = {
        "float16": torch.float16,
        "bfloat16": torch.bfloat16,
        "float32": None,
    }[args.amp_dtype] if device.type == "cuda" else None

    causal = evaluate_candidate(
        model=model,
        plan=pathlib.Path(args.plan),
        plan_receipt=pathlib.Path(args.plan_receipt),
        batches=args.batches,
        batch_size=args.batch_size,
        sequence_length=args.sequence_length,
        wrong_offset_batches=args.wrong_offset_batches,
        device=device,
        amp_dtype=amp_dtype,
        byte_lengths=byte_lengths,
        prefetch_workers=args.prefetch_workers,
    )

    base = load_base(pathlib.Path(args.base_model).resolve(), device)
    base_sampler = TokenSampler(
        retention_path,
        args.retention_sequence_length,
        1,
        0x51DE,
    )
    candidate_sampler = TokenSampler(
        retention_path,
        args.retention_sequence_length,
        1,
        0x51DE,
    )
    base_metrics = evaluate_base(
        base,
        base_sampler,
        device,
        args.retention_batches,
        amp_dtype,
        byte_lengths,
        "byte",
    )

    @torch.no_grad()
    def candidate_retention() -> dict[str, float]:
        total_nats = total_tokens = total_bytes = 0.0
        for _ in range(args.retention_batches):
            batch = candidate_sampler.batch(device)
            inputs = batch[:, :-1]
            with torch.autocast(
                device_type=device.type,
                dtype=amp_dtype,
                enabled=amp_dtype is not None,
            ):
                output = model(inputs)
            nats, tokens, bytes_ = next_token_statistics(output["logits"], inputs, byte_lengths)
            total_nats += float(nats.cpu())
            total_tokens += float(tokens.cpu())
            total_bytes += float(bytes_.cpu())
        return {
            "loss": total_nats / max(total_bytes, 1.0),
            "bits_per_byte": total_nats / max(total_bytes, 1.0) / math.log(2.0),
            "nats_per_token": total_nats / max(total_tokens, 1.0),
        }

    candidate_metrics = candidate_retention()
    regression = (
        candidate_metrics["bits_per_byte"] - base_metrics["bits_per_byte"]
    ) / max(base_metrics["bits_per_byte"], 1e-12)
    effects = causal["effects"]
    checks = {
        "correct_beats_reset": effects["gain_vs_reset"] >= args.minimum_reset_gain,
        "correct_beats_wrong": effects["gain_vs_wrong"] >= args.minimum_wrong_gain,
        "language_retention": regression <= args.maximum_retention_regression,
    }
    receipt = {
        "schema": RECEIPT_SCHEMA,
        "candidate": str(candidate_path),
        "candidate_sha256": sha256_file(candidate_path),
        "base_model": str(pathlib.Path(args.base_model).resolve()),
        "base_model_sha256": sha256_file(pathlib.Path(args.base_model).resolve()),
        "plan_sha256": sha256_file(pathlib.Path(args.plan).resolve()),
        "causal": causal,
        "retention": {
            "base": base_metrics,
            "candidate": candidate_metrics,
            "relative_regression": regression,
        },
        "thresholds": {
            "minimum_reset_gain": args.minimum_reset_gain,
            "minimum_wrong_gain": args.minimum_wrong_gain,
            "maximum_retention_regression": args.maximum_retention_regression,
        },
        "checks": checks,
        "passed": all(checks.values()),
        "promotion": "causal-candidate" if all(checks.values()) else "falsified",
        "claim_boundary": (
            "Passing establishes a bounded causal state effect on this frozen plan only; "
            "independent-seed replication and external task families remain required."
        ),
    }
    receipt["receipt_digest"] = digest_json(receipt)
    output = pathlib.Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2, sort_keys=True))
    raise SystemExit(0 if receipt["passed"] else 3)


if __name__ == "__main__":
    main()
