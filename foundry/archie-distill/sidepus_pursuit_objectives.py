#!/usr/bin/env python3
"""Losses and immutable contract helpers for Archie pursuit training."""
from __future__ import annotations

import hashlib
import pathlib
from dataclasses import asdict
from typing import Any, Mapping

import torch
import torch.nn.functional as F

from archie_hybrid_corpus import sha256_file, stable_json
from archie_sidepus_organism import ArchieSidepusOrganism, OrganismConfig

METHOD = "archie-sidepus-pursuit-organism/v3-causal-deliberation"
CONTRACT_SCHEMA = "archie-sidepus-pursuit-training-contract/v3"
CODE_FILES = (
    "train_archie_sidepus_pursuit.py",
    "sidepus_pursuit_cli.py",
    "sidepus_pursuit_objectives.py",
    "sidepus_pursuit_forward.py",
    "sidepus_pursuit_step.py",
    "sidepus_pursuit_stream.py",
    "sidepus_pursuit_plan.py",
    "sidepus_pursuit_controller.py",
    "sidepus_developmental_graph.py",
    "sidepus_ephemeral_cache.py",
    "sidepus_experience_compiler.py",
    "sidepus_microphysics.py",
    "sidepus_inventory_union.py",
    "sidepus_remote_experience.py",
    "run_archie_sidepus_pursuit.sh",
    "archie_sidepus_organism.py",
    "archie_world_state_core.py",
)


def contract_digest(value: Mapping[str, Any]) -> str:
    return hashlib.sha256(stable_json(dict(value)).encode()).hexdigest()


def code_identity() -> dict[str, str]:
    here = pathlib.Path(__file__).resolve().parent
    return {name: sha256_file(here / name) for name in CODE_FILES}


def shell_logits(model: ArchieSidepusOrganism, inputs: torch.Tensor) -> torch.Tensor:
    x = model.token_embedding(inputs)
    for block in model.blocks:
        x = block(x)
    return model.lm_head(model.norm(x))


def kl_to_shell(student: torch.Tensor, teacher: torch.Tensor) -> torch.Tensor:
    teacher_prob = F.softmax(teacher.float(), dim=-1)
    return F.kl_div(
        F.log_softmax(student.float(), dim=-1), teacher_prob, reduction="batchmean",
    ) / max(student.size(1), 1)


def halt_entropy(result: Mapping[str, torch.Tensor]) -> torch.Tensor:
    probabilities = result.get("halt_probabilities")
    if probabilities is None:
        return result["loss"].new_zeros(())
    p = probabilities.float().clamp(1e-6, 1 - 1e-6)
    return -(p * p.log() + (1 - p) * (1 - p).log()).mean()


def pursuit_contract(
    args: Any, cfg: OrganismConfig, source_sha: str, plan_receipt: Mapping[str, Any],
    retention_metadata: Mapping[str, Any], device: torch.device, amp_dtype: torch.dtype | None,
) -> dict[str, Any]:
    return {
        "schema": CONTRACT_SCHEMA,
        "method": METHOD,
        "model": asdict(cfg),
        "source": {
            "language_shell_sha256": source_sha,
            "plan_sha256": plan_receipt["plan_sha256"],
            "plan_receipt_digest": plan_receipt["receipt_digest"],
            "inventory_sha256": plan_receipt["inventory_sha256"],
            "retention_corpus_sha256": retention_metadata["sha256"],
        },
        "streaming": {
            "two_phase_sealing": True,
            "cache_dir": str(pathlib.Path(args.cache_dir).expanduser().resolve()),
            "cache_bytes": args.cache_bytes,
            "lookahead": args.pursuit_lookahead,
            "prefetch_workers": args.prefetch_workers,
            "foreign_state_bank_capacity": 64,
        },
        "pursuit": {
            "counterfactual_every": args.counterfactual_every,
            "state_margin": args.state_margin,
            "state_order_weight": args.state_order_weight,
            "deliberation_compute_cost": args.deliberation_compute_cost,
            "deliberation_policy_weight": args.deliberation_policy_weight,
            "deliberation_trajectory_weight": args.deliberation_trajectory_weight,
            "deliberation_improvement_margin": args.deliberation_improvement_margin,
            "deliberation_halt_warmup_steps": args.deliberation_halt_warmup_steps,
            "deliberation_floor_weight": args.deliberation_floor_weight,
            "halt_entropy_weight": args.halt_entropy_weight,
            "interference_every": args.interference_every,
            "interference_weight": args.interference_weight,
            "retention_tax_weight": args.retention_tax_weight,
        },
        "optimization": {
            "optimizer": "AdamW",
            "learning_rate": args.learning_rate,
            "language_lr_scale": args.language_lr_scale,
            "maximum_steps": args.max_steps,
            "warmup_steps": args.warmup_steps,
            "gradient_clip": args.grad_clip,
        },
        "execution": {
            "seed": args.seed,
            "device": str(device),
            "amp_dtype": str(amp_dtype) if amp_dtype is not None else "float32",
            "torch": torch.__version__,
            "cuda": torch.version.cuda,
        },
        "code_sha256": code_identity(),
    }
