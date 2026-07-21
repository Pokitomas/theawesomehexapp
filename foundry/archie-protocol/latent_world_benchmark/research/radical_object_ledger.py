#!/usr/bin/env python3
from __future__ import annotations

import argparse
import dataclasses
import json
import os
import random
import statistics
import sys
import time
from pathlib import Path
from typing import Any

import torch
import torch.nn as nn
import torch.nn.functional as F

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import latent_world_benchmark as base
import full_budget_campaign as campaign
import efficient_terminal_training as terminal

SCHEMA = "archie-radical-object-ledger/v4"
PROMOTION = "research-only-not-admitted"


class ObjectLedger(base.BaseModel):
    """Categorical object memory with exact routing and reversible correction transport."""

    supports_persistent_state = False

    def __init__(self, cfg: base.WorldConfig, hidden: int = 64, width: int = 24, neural: bool = False) -> None:
        super().__init__(cfg, hidden)
        self.s = terminal.slices(cfg)
        self.neural = neural
        self.negate_logits = nn.Parameter(torch.empty(cfg.values, cfg.values))
        nn.init.normal_(self.negate_logits, std=0.02)
        proposal_in = cfg.values * 3 + cfg.structured_dim
        self.proposer = nn.Sequential(
            nn.Linear(proposal_in, width * 2), nn.GELU(), nn.Linear(width * 2, cfg.values)
        )
        self.residual_scale = nn.Parameter(torch.tensor(-4.0))
        ledger_dim = cfg.slots * cfg.values + cfg.sources + 3 + cfg.queue_len * (cfg.slots + 1)
        self.readout = nn.Sequential(
            nn.Linear(ledger_dim, hidden * 2), nn.GELU(), nn.Linear(hidden * 2, hidden)
        )
        self.router = nn.Sequential(
            nn.Linear(base.N_PRIMITIVES + 4, width), nn.GELU(), nn.Linear(width, base.N_OPS)
        )

    def _initial(self, initial: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        cfg, batch = self.cfg, initial.size(0)
        offset = 0
        slots = initial[:, : cfg.slots * cfg.values].view(batch, cfg.slots, cfg.values).clone()
        offset += cfg.slots * cfg.values
        sources = initial[:, offset : offset + cfg.sources].clone()
        offset += cfg.sources
        authority = initial[:, offset : offset + 3].clone()
        queue = torch.zeros(batch, cfg.queue_len, cfg.slots + 1, dtype=initial.dtype, device=initial.device)
        queue[..., 0] = 1.0
        return slots, sources, authority, queue

    def _proposal(
        self,
        current: torch.Tensor,
        peer: torch.Tensor,
        value: torch.Tensor,
        structured: torch.Tensor,
        primitives: torch.Tensor,
    ) -> torch.Tensor:
        if self.neural:
            return self.proposer(torch.cat([current, peer, value, structured], -1)).softmax(-1)
        read = primitives[:, base.P_READ : base.P_READ + 1]
        source_value = value + read * (peer - value)
        negate = primitives[:, base.P_NEGATE : base.P_NEGATE + 1]
        transformed = source_value @ self.negate_logits.softmax(-1)
        composed = source_value + negate * (transformed - source_value)
        residual = self.proposer(torch.cat([current, peer, value, structured], -1))
        return (composed.clamp_min(1e-7).log() + torch.sigmoid(self.residual_scale) * residual).softmax(-1)

    def forward(self, events: torch.Tensor, initial: torch.Tensor, latent: Any = None) -> dict[str, Any]:
        if latent is not None:
            raise ValueError("correction ledger continuation is not serialized")
        cfg = self.cfg
        slots, sources, authority, queue = self._initial(initial)
        history: list[tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]] = [
            (slots, sources, authority, queue)
        ]
        stacks: list[list[int]] = [[] for _ in range(events.size(0))]
        hidden_seq, state_seq, queue_seq, op_seq = [], [], [], []

        for step in range(events.size(1)):
            structured = events[:, step, : cfg.structured_dim]
            primitives = structured[:, : base.N_PRIMITIVES]
            target = structured[:, self.s["target"]]
            other = structured[:, self.s["other"]]
            value = structured[:, self.s["value"]]
            source_sel = structured[:, self.s["source"]]
            auth_sel = structured[:, self.s["auth"]]
            flags = structured[:, self.s["flags"]]
            current = (target[..., None] * slots).sum(1)
            peer = (other[..., None] * slots).sum(1)
            proposal = self._proposal(current, peer, value, structured, primitives)

            selected_source = (source_sel * sources).sum(1, keepdim=True)
            conditional = primitives[:, base.P_CONDITIONAL : base.P_CONDITIONAL + 1]
            swap = primitives[:, base.P_SWAP : base.P_SWAP + 1]
            write = primitives[:, base.P_WRITE : base.P_WRITE + 1]
            write = write * (1.0 - conditional + conditional * selected_source) * (1.0 - swap)
            next_slots = slots + write[..., None] * target[..., None] * (proposal[:, None] - slots)
            swapped = slots + target[..., None] * (peer[:, None] - slots) + other[..., None] * (current[:, None] - slots)
            next_slots = next_slots + swap[..., None] * (swapped - next_slots)

            odd = torch.arange(cfg.values, device=value.device, dtype=value.dtype).remainder(2)
            source_value = (value * odd).sum(-1, keepdim=True)
            source_gate = primitives[:, base.P_SOURCE : base.P_SOURCE + 1] * (1.0 - conditional)
            next_sources = sources + source_gate * source_sel * (source_value - sources)
            auth_gate = primitives[:, base.P_AUTH : base.P_AUTH + 1]
            next_authority = authority + auth_gate * (auth_sel - authority)
            target_queue = torch.cat([torch.zeros_like(target[:, :1]), target], -1)
            pushed = torch.cat([queue[:, 1:], target_queue[:, None]], 1)
            queue_gate = primitives[:, base.P_QUEUE : base.P_QUEUE + 1]
            next_queue = queue + queue_gate[..., None] * (pushed - queue)

            correct = primitives[:, base.P_CORRECT].gt(0.5)
            noop = primitives.sum(-1).eq(0)
            for row in range(events.size(0)):
                if not bool(correct[row] or noop[row]):
                    stacks[row].append(step)
            if bool(correct.any()):
                indices = [
                    stacks[row].pop() if bool(correct[row]) and stacks[row] else step
                    for row in range(events.size(0))
                ]
                restored = [
                    torch.stack([history[indices[row]][part][row] for row in range(events.size(0))], 0)
                    for part in range(4)
                ]
                next_slots = torch.where(correct[:, None, None], restored[0], next_slots)
                next_sources = torch.where(correct[:, None], restored[1], next_sources)
                next_authority = torch.where(correct[:, None], restored[2], next_authority)
                next_queue = torch.where(correct[:, None, None], restored[3], next_queue)

            slots, sources, authority, queue = next_slots, next_sources, next_authority, next_queue
            history.append((slots, sources, authority, queue))
            ledger = torch.cat([slots.flatten(1), sources, authority, queue.flatten(1)], -1)
            hidden = self.readout(ledger)
            hidden_seq.append(hidden)
            state_seq.append(torch.cat([slots.flatten(1), sources, authority, queue[..., 1:].flatten(1)], -1))
            queue_seq.append(queue)
            op_seq.append(self.router(torch.cat([primitives, flags], -1)))

        hidden = torch.stack(hidden_seq, 1)
        return {
            "state": torch.stack(state_seq, 1),
            "queue_full": torch.stack(queue_seq, 1),
            "op_logits": torch.stack(op_seq, 1),
            "change_logits": self.change_head(hidden),
            "hidden_seq": hidden,
            "latent": (slots, sources, authority, queue),
        }


@dataclasses.dataclass(frozen=True)
class Arm:
    name: str
    kind: str
    width: int
    lr: float
    radical: bool


ARMS = (
    Arm("primitive_composed_ledger", "primitive", 24, 3e-3, True),
    Arm("neural_causal_ledger", "neural", 32, 2e-3, True),
    Arm("factorized_full_state", "factorized", 28, 1e-3, False),
    Arm("neural_interpreter", "interpreter", 26, 1e-3, False),
)


def build_model(arm: Arm, cfg: base.WorldConfig) -> base.BaseModel:
    if arm.kind == "primitive":
        return ObjectLedger(cfg, width=arm.width, neural=False)
    if arm.kind == "neural":
        return ObjectLedger(cfg, width=arm.width, neural=True)
    if arm.kind == "factorized":
        return terminal.FullStateFactorizedInterpreter(cfg, width=arm.width)
    if arm.kind == "interpreter":
        return campaign.NeuralInterpreter(cfg, width=arm.width)
    raise KeyError(arm.kind)


def causal_divergence(out: dict[str, Any], batch: dict[str, torch.Tensor], cfg: base.WorldConfig) -> torch.Tensor:
    slots = out["state"][..., : cfg.slots * cfg.values].view(
        *out["state"].shape[:-1], cfg.slots, cfg.values
    )
    initial = batch["initial"][:, : cfg.slots * cfg.values].view(batch["initial"].size(0), cfg.slots, cfg.values)
    previous = torch.cat([initial[:, None], slots[:, :-1]], 1)
    distance = 0.5 * (slots - previous).abs().sum(-1)
    changed = batch["changed_cells"]
    stable = ((1.0 - changed) * distance).sum() / (1.0 - changed).sum().clamp_min(1.0)
    effect = (changed * F.relu(0.55 - distance)).sum() / changed.sum().clamp_min(1.0)
    return stable + effect


def loss_fn(out: dict[str, Any], batch: dict[str, torch.Tensor], cfg: base.WorldConfig) -> tuple[torch.Tensor, dict[str, float]]:
    base_loss, parts = terminal.terminal_weighted_loss(out, batch, cfg)
    causal = causal_divergence(out, batch, cfg)
    total = base_loss + 0.30 * causal
    return total, {**parts, "causal_divergence": float(causal.detach())}


def train_range(trial: dict[str, Any], cfg: base.WorldConfig, start: int, stop: int, batch_size: int) -> None:
    model, optimizer, seed = trial["model"], trial["optimizer"], trial["seed"]
    model.train()
    for step in range(start, stop):
        lengths = (4, 6, 8) if step < 256 else ((6, 8, 12, 14) if step < 768 else (8, 12, 16, 20))
        length = lengths[step % len(lengths)]
        batch = base.generate_batch(cfg, batch_size, length, seed * 1_000_003 + step * 17, "train")
        trial["event_tokens"] += length * batch_size
        optimizer.zero_grad(set_to_none=True)
        out = model(batch["events"], batch["initial"])
        loss, parts = loss_fn(out, batch, cfg)
        if not torch.isfinite(loss):
            raise RuntimeError("non-finite loss")
        loss.backward()
        grad = float(torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0))
        optimizer.step()
        if step == start or (step + 1) % 128 == 0 or step + 1 == stop:
            trial["history"].append(
                {"step": step + 1, "loss": float(loss.detach()), "grad_norm": grad, **parts}
            )
    trial["step"] = stop


def rank(trials: dict[tuple[str, int], dict[str, Any]], arms: tuple[Arm, ...], seeds: list[int]) -> list[dict[str, Any]]:
    rows = []
    for arm in arms:
        members = [trials[(arm.name, seed)] for seed in seeds]
        rows.append({
            "arm": arm,
            "mean_score": statistics.fmean(member["dev"]["score"] for member in members),
            "mean_full_exact": statistics.fmean(member["dev"]["full_exact_terminal"] for member in members),
        })
    return sorted(rows, key=lambda row: (row["mean_score"], row["mean_full_exact"]), reverse=True)


def run(args: argparse.Namespace) -> dict[str, Any]:
    if args.rung2 <= args.rung1:
        raise ValueError("rung2 must exceed rung1")
    torch.set_num_threads(max(1, min(args.threads, os.cpu_count() or 1)))
    args.output.mkdir(parents=True, exist_ok=True)
    cfg = campaign.scale_by_name(args.scale).world
    seeds = [args.seed, args.seed + 100_003]
    trials: dict[tuple[str, int], dict[str, Any]] = {}
    started = time.monotonic()

    for arm in ARMS:
        for seed in seeds:
            torch.manual_seed(seed)
            random.seed(seed)
            model = build_model(arm, cfg)
            trials[(arm.name, seed)] = {
                "arm": arm,
                "seed": seed,
                "model": model,
                "optimizer": torch.optim.AdamW(model.parameters(), lr=arm.lr, weight_decay=1e-4),
                "history": [],
                "event_tokens": 0,
                "step": 0,
            }
            train_range(trials[(arm.name, seed)], cfg, 0, args.rung1, args.batch_size)
            trials[(arm.name, seed)]["dev"] = terminal.evaluate(
                model, cfg, [seed + 700_001, seed + 700_019], args.eval_batch_size
            )

    stage1 = rank(trials, ARMS, seeds)
    radical = max((row for row in stage1 if row["arm"].radical), key=lambda row: row["mean_score"])["arm"]
    comparator = max((row for row in stage1 if not row["arm"].radical), key=lambda row: row["mean_score"])["arm"]
    finalists_arms = (radical, comparator)

    for arm in finalists_arms:
        for seed in seeds:
            trial = trials[(arm.name, seed)]
            train_range(trial, cfg, trial["step"], args.rung2, args.batch_size)
            trial["dev"] = terminal.evaluate(
                trial["model"], cfg, [seed + 800_001, seed + 800_019], args.eval_batch_size
            )

    final_rank = rank(trials, finalists_arms, seeds)
    finalists = []
    for row in final_rank:
        arm = row["arm"]
        label = "radical" if arm.radical else "comparator"
        records = []
        for seed in seeds:
            trial = trials[(arm.name, seed)]
            sealed = terminal.evaluate_frozen(trial["model"], cfg, args.campaign_root, args.scale)
            checkpoint = args.output / f"{label}__{arm.name}__seed{seed}.pt"
            parameters = sum(parameter.numel() for parameter in trial["model"].parameters())
            torch.save({
                "schema": SCHEMA,
                "arm": dataclasses.asdict(arm),
                "world": dataclasses.asdict(cfg),
                "seed": seed,
                "steps": trial["step"],
                "state_dict": trial["model"].state_dict(),
                "optimizer_state": trial["optimizer"].state_dict(),
                "promotion": PROMOTION,
            }, checkpoint)
            records.append({
                "seed": seed,
                "steps": trial["step"],
                "parameters": parameters,
                "event_tokens": trial["event_tokens"],
                "estimated_training_flops": int(6 * parameters * trial["event_tokens"]),
                "dev": trial["dev"],
                "sealed_canonical": sealed,
                "history": trial["history"],
                "checkpoint": checkpoint.name,
                "checkpoint_sha256": terminal.sha256_file(checkpoint),
            })
        finalists.append({
            "label": label,
            "arm": dataclasses.asdict(arm),
            "mean_dev_score": row["mean_score"],
            "mean_dev_full_exact": row["mean_full_exact"],
            "mean_sealed_score": statistics.fmean(record["sealed_canonical"]["summary"]["score"] for record in records),
            "mean_sealed_full_exact": statistics.fmean(record["sealed_canonical"]["summary"]["full_exact_terminal"] for record in records),
            "records": records,
        })

    radical_result = next(item for item in finalists if item["label"] == "radical")
    comparator_result = next(item for item in finalists if item["label"] == "comparator")
    exact_gain = radical_result["mean_sealed_full_exact"] - comparator_result["mean_sealed_full_exact"]
    score_gain = radical_result["mean_sealed_score"] - comparator_result["mean_sealed_score"]
    verdict = "BIGLY" if exact_gain >= 0.10 and score_gain > 0 else (
        "SMALL_WIN" if exact_gain > 0 and score_gain > 0 else "NAW"
    )
    report = {
        "schema": SCHEMA,
        "promotion": PROMOTION,
        "scale": args.scale,
        "rungs": [args.rung1, args.rung2],
        "batch_size": args.batch_size,
        "seeds": seeds,
        "elapsed_seconds": time.monotonic() - started,
        "stage1_ranking": [
            {"arm": dataclasses.asdict(row["arm"]), "mean_score": row["mean_score"], "mean_full_exact_terminal": row["mean_full_exact"]}
            for row in stage1
        ],
        "finalists": finalists,
        "verdict": verdict,
        "radical_sealed_full_exact_gain": exact_gain,
        "radical_sealed_score_gain": score_gain,
        "selection_rule": "balanced generated-data screen; one radical and one comparator receive identical continuation budgets; sealed evidence is evaluated only after selection",
        "known_boundary": "the benchmark exposes typed primitive routing; a win demonstrates compositional state-machine induction on this capability class, not general intelligence",
    }
    terminal.atomic_json(report, args.output / "radical-object-ledger-report.json")
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--campaign-root", type=Path, required=True)
    parser.add_argument("--scale", choices=[scale.name for scale in campaign.SCALES], default="base")
    parser.add_argument("--seed", type=int, default=40260721)
    parser.add_argument("--rung1", type=int, default=96)
    parser.add_argument("--rung2", type=int, default=1024)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--eval-batch-size", type=int, default=32)
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()
    print(json.dumps(run(args), sort_keys=True))


if __name__ == "__main__":
    main()
