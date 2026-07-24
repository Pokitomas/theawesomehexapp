#!/usr/bin/env python3
"""Counterfactual-twin probe for bounded persistent neural state.

The present query is byte-for-byte identical inside each twin pair. Only the
causal history differs, so reset-state models are information-theoretically
unable to distinguish the required answers. A useful persistent state should:

1. answer each world correctly from its carried state;
2. survive unrelated post-intervention events;
3. transfer beyond trained history lengths;
4. remain useful after Q4/Q8 fake quantization; and
5. move toward the counterfactual answer when twin states are swapped.

This is a mechanism probe, not an Archie capability or admission claim.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import pathlib
import random
from dataclasses import asdict, dataclass
from typing import Any, Iterable

import torch
import torch.nn as nn
import torch.nn.functional as F

from archie_world_state_core import SparseWorldState, WorldStateConfig

SCHEMA = "archie-counterfactual-state-probe/v1"
OPS = ("set", "add", "xor")


@dataclass(frozen=True)
class ProbeConfig:
    objects: int = 8
    values: int = 8
    width: int = 96
    slots: int = 8
    top_k: int = 2
    quant_bits: int = 4
    train_min_events: int = 6
    train_max_events: int = 18
    eval_event_counts: tuple[int, ...] = (8, 18, 32, 64)
    batch_size: int = 128
    steps: int = 3000
    learning_rate: float = 3e-4
    weight_decay: float = 0.01
    seeds: tuple[int, ...] = (17, 29, 43)
    eval_batches: int = 64
    device: str = "cuda"

    def validate(self) -> None:
        if self.objects < 2 or self.values < 4:
            raise ValueError("probe requires at least two objects and four values")
        if self.width < 16 or self.slots < 2 or not 1 <= self.top_k <= self.slots:
            raise ValueError("invalid state geometry")
        if self.quant_bits not in (0, 4, 8):
            raise ValueError("quant_bits must be 0, 4, or 8")
        if self.train_min_events < 2 or self.train_max_events < self.train_min_events:
            raise ValueError("invalid training event range")
        if not self.eval_event_counts or min(self.eval_event_counts) < 2:
            raise ValueError("evaluation event counts must be positive")
        if self.batch_size < 2 or self.steps < 1 or self.eval_batches < 1:
            raise ValueError("invalid optimization budget")


@dataclass(frozen=True)
class TwinBatch:
    object_ids: torch.Tensor       # [2B,T]
    op_ids: torch.Tensor           # [2B,T]
    value_ids: torch.Tensor        # [2B,T]
    query_ids: torch.Tensor        # [2B]
    answers: torch.Tensor          # [2B]
    pair_ids: torch.Tensor         # [2B]
    intervention_index: torch.Tensor  # [2B]

    def to(self, device: torch.device) -> "TwinBatch":
        return TwinBatch(**{
            field: getattr(self, field).to(device)
            for field in self.__dataclass_fields__
        })


def stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(value: Any) -> str:
    return hashlib.sha256(stable_json(value).encode("utf-8")).hexdigest()


def apply_op(current: int, op_id: int, operand: int, values: int) -> int:
    if op_id == 0:
        return operand
    if op_id == 1:
        return (current + operand) % values
    if op_id == 2:
        return current ^ operand
    raise ValueError(f"unknown operation {op_id}")


def _different_operand(rng: random.Random, original: int, op_id: int, current: int, values: int) -> int:
    candidates = [value for value in range(values) if value != original]
    rng.shuffle(candidates)
    original_result = apply_op(current, op_id, original, values)
    for candidate in candidates:
        if apply_op(current, op_id, candidate, values) != original_result:
            return candidate
    raise RuntimeError("could not create a counterfactual intervention")


def generate_twins(
    *, cfg: ProbeConfig, pairs: int, events: int, seed: int,
) -> TwinBatch:
    """Create twins with identical queries and one answer-changing intervention.

    The queried object is never touched after the intervention. Remaining events
    modify other objects only, making them controlled interference rather than a
    second source of answer information.
    """
    rng = random.Random(seed)
    object_rows: list[list[int]] = []
    op_rows: list[list[int]] = []
    value_rows: list[list[int]] = []
    queries: list[int] = []
    answers: list[int] = []
    pair_ids: list[int] = []
    intervention_indices: list[int] = []

    for pair in range(pairs):
        query = rng.randrange(cfg.objects)
        intervention = rng.randrange(1, max(2, events // 2))
        initial = [rng.randrange(cfg.values) for _ in range(cfg.objects)]
        objects: list[int] = []
        operations: list[int] = []
        operands: list[int] = []
        world = list(initial)
        pre_value = 0

        for index in range(events):
            if index == intervention:
                obj = query
            elif index > intervention:
                choices = [candidate for candidate in range(cfg.objects) if candidate != query]
                obj = choices[rng.randrange(len(choices))]
            else:
                obj = rng.randrange(cfg.objects)
            op_id = rng.randrange(len(OPS))
            operand = rng.randrange(cfg.values)
            if index == intervention:
                pre_value = world[obj]
            world[obj] = apply_op(world[obj], op_id, operand, cfg.values)
            objects.append(obj)
            operations.append(op_id)
            operands.append(operand)

        answer_a = world[query]
        counter_operand = _different_operand(
            rng, operands[intervention], operations[intervention], pre_value, cfg.values
        )
        world_b = list(initial)
        operands_b = list(operands)
        operands_b[intervention] = counter_operand
        for obj, op_id, operand in zip(objects, operations, operands_b):
            world_b[obj] = apply_op(world_b[obj], op_id, operand, cfg.values)
        answer_b = world_b[query]
        if answer_a == answer_b:
            raise RuntimeError("counterfactual twin answers unexpectedly match")

        for operand_row, answer in ((operands, answer_a), (operands_b, answer_b)):
            object_rows.append(list(objects))
            op_rows.append(list(operations))
            value_rows.append(list(operand_row))
            queries.append(query)
            answers.append(answer)
            pair_ids.append(pair)
            intervention_indices.append(intervention)

    return TwinBatch(
        object_ids=torch.tensor(object_rows, dtype=torch.long),
        op_ids=torch.tensor(op_rows, dtype=torch.long),
        value_ids=torch.tensor(value_rows, dtype=torch.long),
        query_ids=torch.tensor(queries, dtype=torch.long),
        answers=torch.tensor(answers, dtype=torch.long),
        pair_ids=torch.tensor(pair_ids, dtype=torch.long),
        intervention_index=torch.tensor(intervention_indices, dtype=torch.long),
    )


class CounterfactualStateProbe(nn.Module):
    def __init__(self, cfg: ProbeConfig) -> None:
        super().__init__()
        self.cfg = cfg
        self.object_embedding = nn.Embedding(cfg.objects, cfg.width)
        self.operation_embedding = nn.Embedding(len(OPS), cfg.width)
        self.value_embedding = nn.Embedding(cfg.values, cfg.width)
        self.event_encoder = nn.Sequential(
            nn.Linear(cfg.width * 3, cfg.width * 2),
            nn.GELU(),
            nn.Linear(cfg.width * 2, cfg.width),
        )
        self.query_marker = nn.Parameter(torch.zeros(cfg.width))
        world_cfg = WorldStateConfig(
            vocab_size=260,
            d_model=cfg.width,
            n_layers=1,
            n_heads=4 if cfg.width % 4 == 0 else 2,
            n_kv_heads=2,
            d_ff=cfg.width * 3,
            max_seq_len=max(cfg.eval_event_counts) + 1,
            event_size=1,
            state_slots=cfg.slots,
            state_top_k=cfg.top_k,
            state_quant_bits=cfg.quant_bits,
            state_aux_weight=0.0,
        )
        self.state = SparseWorldState(world_cfg)
        self.query_norm = nn.LayerNorm(cfg.width)
        self.head = nn.Sequential(
            nn.Linear(cfg.width * 2, cfg.width),
            nn.GELU(),
            nn.Linear(cfg.width, cfg.values),
        )
        nn.init.normal_(self.query_marker, std=0.02)

    def encode_events(self, batch: TwinBatch) -> torch.Tensor:
        return self.event_encoder(torch.cat((
            self.object_embedding(batch.object_ids),
            self.operation_embedding(batch.op_ids),
            self.value_embedding(batch.value_ids),
        ), dim=-1))

    def build_state(self, batch: TwinBatch) -> tuple[torch.Tensor, torch.Tensor]:
        events = self.encode_events(batch)
        state = self.state.initial_state(events.size(0), events.device)
        routes: list[torch.Tensor] = []
        for index in range(events.size(1)):
            state, route = self.state.update(state, events[:, index])
            routes.append(route)
        return state, torch.stack(routes, dim=1)

    def query(self, query_ids: torch.Tensor, state: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        query = self.query_norm(self.object_embedding(query_ids) + self.query_marker)
        read, weights = self.state.read(query[:, None], state)
        logits = self.head(torch.cat((query, read[:, 0]), dim=-1))
        return logits, weights[:, 0]

    def forward(self, batch: TwinBatch) -> dict[str, torch.Tensor]:
        state, routes = self.build_state(batch)
        logits, reads = self.query(batch.query_ids, state)
        return {"logits": logits, "state": state, "routes": routes, "reads": reads}


def pair_swap(state: torch.Tensor) -> torch.Tensor:
    if state.size(0) % 2:
        raise ValueError("twin state batch must have even leading dimension")
    indices = torch.arange(state.size(0), device=state.device).view(-1, 2).flip(1).reshape(-1)
    return state.index_select(0, indices)


def metrics_for_batch(
    model: CounterfactualStateProbe, batch: TwinBatch,
) -> dict[str, float]:
    output = model(batch)
    correct_logits = output["logits"]
    state = output["state"]
    reset = model.state.initial_state(state.size(0), state.device)
    reset_logits, _ = model.query(batch.query_ids, reset)
    swapped_logits, _ = model.query(batch.query_ids, pair_swap(state))

    answers = batch.answers
    twin_answers = answers.view(-1, 2).flip(1).reshape(-1)
    correct_prob = correct_logits.softmax(-1).gather(1, answers[:, None]).squeeze(1)
    swapped_correct_prob = swapped_logits.softmax(-1).gather(1, answers[:, None]).squeeze(1)
    swapped_twin_prob = swapped_logits.softmax(-1).gather(1, twin_answers[:, None]).squeeze(1)
    reset_pairs = reset_logits.view(-1, 2, reset_logits.size(-1))
    reset_pair_delta = (reset_pairs[:, 0] - reset_pairs[:, 1]).abs().amax(dim=-1)

    correct_prediction = correct_logits.argmax(-1)
    swapped_prediction = swapped_logits.argmax(-1)
    pair_predictions = correct_prediction.view(-1, 2)
    pair_answers = answers.view(-1, 2)
    pair_success = pair_predictions.eq(pair_answers).all(dim=1) & pair_predictions[:, 0].ne(pair_predictions[:, 1])

    return {
        "examples": float(answers.numel()),
        "pairs": float(answers.numel() // 2),
        "correct": float(correct_prediction.eq(answers).sum().item()),
        "reset_correct": float(reset_logits.argmax(-1).eq(answers).sum().item()),
        "swapped_correct": float(swapped_prediction.eq(answers).sum().item()),
        "swapped_twin": float(swapped_prediction.eq(twin_answers).sum().item()),
        "pair_success": float(pair_success.sum().item()),
        "causal_probability_gain": float((correct_prob - swapped_correct_prob).sum().item()),
        "swap_attraction": float((swapped_twin_prob - swapped_correct_prob).sum().item()),
        "reset_pair_logit_delta_max": float(reset_pair_delta.max().item()),
        "active_route_fraction": float(output["routes"].gt(0).float().mean().item()),
        "read_entropy": float((-(output["reads"].clamp_min(1e-9).log() * output["reads"]).sum(-1)).mean().item()),
    }


def merge_metrics(target: dict[str, float], source: dict[str, float]) -> None:
    for key, value in source.items():
        if key == "reset_pair_logit_delta_max":
            target[key] = max(target.get(key, 0.0), value)
        elif key in {"active_route_fraction", "read_entropy"}:
            target[key] = target.get(key, 0.0) + value
        else:
            target[key] = target.get(key, 0.0) + value


def finalize_metrics(total: dict[str, float], batches: int) -> dict[str, float]:
    examples = max(total.get("examples", 0.0), 1.0)
    pairs = max(total.get("pairs", 0.0), 1.0)
    return {
        "accuracy": total.get("correct", 0.0) / examples,
        "reset_accuracy": total.get("reset_correct", 0.0) / examples,
        "swapped_accuracy": total.get("swapped_correct", 0.0) / examples,
        "swapped_twin_accuracy": total.get("swapped_twin", 0.0) / examples,
        "counterfactual_pair_success": total.get("pair_success", 0.0) / pairs,
        "causal_probability_gain": total.get("causal_probability_gain", 0.0) / examples,
        "swap_attraction": total.get("swap_attraction", 0.0) / examples,
        "reset_pair_logit_delta_max": total.get("reset_pair_logit_delta_max", 0.0),
        "active_route_fraction": total.get("active_route_fraction", 0.0) / max(batches, 1),
        "mean_read_entropy": total.get("read_entropy", 0.0) / max(batches, 1),
        "evaluated_examples": total.get("examples", 0.0),
    }


@torch.no_grad()
def evaluate(
    model: CounterfactualStateProbe, cfg: ProbeConfig, *, events: int, seed: int,
) -> dict[str, float]:
    model.eval()
    total: dict[str, float] = {}
    for batch_index in range(cfg.eval_batches):
        batch = generate_twins(
            cfg=cfg,
            pairs=cfg.batch_size // 2,
            events=events,
            seed=seed + batch_index * 1009,
        ).to(next(model.parameters()).device)
        merge_metrics(total, metrics_for_batch(model, batch))
    result = finalize_metrics(total, cfg.eval_batches)
    chance = 1.0 / cfg.values
    result.update({
        "events": float(events),
        "chance_accuracy": chance,
        "beyond_training_horizon": float(events > cfg.train_max_events),
    })
    return result


def train_seed(cfg: ProbeConfig, seed: int, output_dir: pathlib.Path) -> dict[str, Any]:
    torch.manual_seed(seed)
    random.seed(seed)
    if cfg.device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA requested but unavailable")
    device = torch.device(cfg.device)
    model = CounterfactualStateProbe(cfg).to(device)
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=cfg.learning_rate, weight_decay=cfg.weight_decay
    )
    generator = random.Random(seed ^ 0xA11CE)
    trace: list[dict[str, float]] = []
    best_loss = math.inf
    best_state: dict[str, torch.Tensor] | None = None

    for step in range(1, cfg.steps + 1):
        model.train()
        events = generator.randint(cfg.train_min_events, cfg.train_max_events)
        batch = generate_twins(
            cfg=cfg,
            pairs=cfg.batch_size // 2,
            events=events,
            seed=generator.randrange(2**63),
        ).to(device)
        output = model(batch)
        loss = F.cross_entropy(output["logits"], batch.answers)
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        grad_norm = torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()
        value = float(loss.detach().cpu())
        if value < best_loss:
            best_loss = value
            best_state = {name: tensor.detach().cpu().clone() for name, tensor in model.state_dict().items()}
        if step == 1 or step % max(1, cfg.steps // 20) == 0:
            trace.append({
                "step": float(step),
                "events": float(events),
                "loss": value,
                "grad_norm": float(grad_norm.detach().cpu()),
            })

    if best_state is None:
        raise RuntimeError("training produced no checkpoint")
    model.load_state_dict(best_state)
    evaluations = {
        str(events): evaluate(model, cfg, events=events, seed=seed ^ (events * 7919))
        for events in cfg.eval_event_counts
    }
    checkpoint = output_dir / f"seed-{seed}.pt"
    checkpoint.parent.mkdir(parents=True, exist_ok=True)
    torch.save({
        "schema": SCHEMA,
        "config": asdict(cfg),
        "seed": seed,
        "model": best_state,
        "training_trace": trace,
        "evaluations": evaluations,
    }, checkpoint)
    return {
        "seed": seed,
        "checkpoint": str(checkpoint),
        "checkpoint_sha256": hashlib.sha256(checkpoint.read_bytes()).hexdigest(),
        "best_training_loss": best_loss,
        "training_trace": trace,
        "evaluations": evaluations,
    }


def aggregate(runs: Iterable[dict[str, Any]], cfg: ProbeConfig) -> dict[str, Any]:
    rows = list(runs)
    by_horizon: dict[str, dict[str, Any]] = {}
    for events in cfg.eval_event_counts:
        key = str(events)
        metrics = [run["evaluations"][key] for run in rows]
        numeric_keys = sorted(k for k, value in metrics[0].items() if isinstance(value, (int, float)))
        summary: dict[str, Any] = {}
        for metric in numeric_keys:
            values = [float(row[metric]) for row in metrics]
            mean = sum(values) / len(values)
            variance = sum((value - mean) ** 2 for value in values) / max(len(values) - 1, 1)
            summary[metric] = {
                "mean": mean,
                "minimum": min(values),
                "maximum": max(values),
                "sample_std": math.sqrt(variance),
            }
        by_horizon[key] = summary

    longest = by_horizon[str(max(cfg.eval_event_counts))]
    checks = {
        "reset_is_identical_within_twins": longest["reset_pair_logit_delta_max"]["maximum"] <= 1e-7,
        "carried_state_above_chance_long_horizon": (
            longest["accuracy"]["minimum"] >= (1.0 / cfg.values) + 0.20
        ),
        "counterfactual_pairs_resolved": longest["counterfactual_pair_success"]["minimum"] >= 0.35,
        "correct_state_beats_swapped": longest["causal_probability_gain"]["minimum"] > 0.05,
        "swapped_state_attracts_twin_answer": longest["swap_attraction"]["minimum"] > 0.02,
    }
    return {
        "schema": SCHEMA,
        "config": asdict(cfg),
        "config_digest": digest(asdict(cfg)),
        "runs": rows,
        "aggregate": by_horizon,
        "checks": checks,
        "passed_declared_probe": all(checks.values()),
        "interpretation": (
            "Pass means only that this bounded state mechanism retained and causally exposed "
            "counterfactual world information on the declared synthetic family. Failure is a "
            "mechanism result, not a prohibition on Archie architectures or successor experiments."
        ),
    }


def profile(name: str, device: str) -> ProbeConfig:
    if name == "smoke":
        return ProbeConfig(
            width=64,
            slots=6,
            top_k=2,
            train_min_events=4,
            train_max_events=10,
            eval_event_counts=(6, 10, 20),
            batch_size=32,
            steps=80,
            seeds=(17,),
            eval_batches=4,
            device=device,
        )
    if name == "full":
        return ProbeConfig(device=device)
    raise ValueError(f"unknown profile {name}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=("smoke", "full"), default="smoke")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--quant-bits", type=int, choices=(0, 4, 8))
    parser.add_argument("--steps", type=int)
    parser.add_argument("--seed", type=int, action="append")
    args = parser.parse_args()

    base = profile(args.profile, args.device)
    values = asdict(base)
    if args.quant_bits is not None:
        values["quant_bits"] = args.quant_bits
    if args.steps is not None:
        values["steps"] = args.steps
    if args.seed:
        values["seeds"] = tuple(args.seed)
    values["eval_event_counts"] = tuple(values["eval_event_counts"])
    values["seeds"] = tuple(values["seeds"])
    cfg = ProbeConfig(**values)
    cfg.validate()

    output_dir = pathlib.Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    runs = [train_seed(cfg, seed, output_dir) for seed in cfg.seeds]
    receipt = aggregate(runs, cfg)
    receipt_path = output_dir / "counterfactual-state-probe.json"
    receipt_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
