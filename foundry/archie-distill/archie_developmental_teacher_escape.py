#!/usr/bin/env python3
"""Developmental teacher-escape experiment over compositional latent worlds.

A local student receives a short supervised curriculum from a bounded teacher,
then teacher access ends. The student continues by selecting uncertain experiences,
receiving only environment truth, replaying retained episodes, and updating all of
its own weights. Competence is relational: rule induction, composition, inversion,
analogy, counterfactual transfer, and classification share one latent algebra.

The experiment asks whether post-teacher development improves both familiar and
previously untrained task families. It is not coding distillation and does not keep
the proprietary teacher in the runtime.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import pathlib
import random
from dataclasses import asdict, dataclass
from typing import Any

import torch
import torch.nn as nn
import torch.nn.functional as F

SCHEMA = "archie-developmental-teacher-escape/v1"
PAD = 13
QUERY_BASE = 14
VOCAB = 22
PRIME = 13


@dataclass(frozen=True)
class Config:
    width: int = 128
    layers: int = 4
    heads: int = 4
    teacher_examples: int = 384
    autonomous_rounds: int = 10
    autonomous_candidates: int = 1024
    autonomous_examples: int = 192
    replay_capacity: int = 12000
    train_steps_per_round: int = 220
    batch_size: int = 64
    lr: float = 4e-4
    seeds: tuple[int, ...] = (17, 29, 43)
    eval_examples: int = 1536
    device: str = "cuda"

    def validate(self) -> None:
        if self.width % self.heads:
            raise ValueError("width must divide heads")
        if self.teacher_examples < 64 or self.autonomous_rounds < 2:
            raise ValueError("insufficient developmental budget")
        if self.autonomous_examples > self.autonomous_candidates:
            raise ValueError("cannot acquire more examples than candidates")
        if not self.seeds:
            raise ValueError("at least one seed is required")


@dataclass(frozen=True)
class Batch:
    tokens: torch.Tensor
    answer: torch.Tensor
    family: torch.Tensor
    rule_a: torch.Tensor
    rule_b: torch.Tensor

    def to(self, device: torch.device) -> "Batch":
        return Batch(*(value.to(device) for value in (
            self.tokens, self.answer, self.family, self.rule_a, self.rule_b
        )))


class AffineWorld:
    """World laws are y = a*x+b mod 13, with a nonzero.

    Surface families vary, but all are exactly solvable from demonstrations. Held-out
    families use the same algebra in unseen compositions rather than impossible
    random mappings.
    """

    def __init__(self, seed: int) -> None:
        self.rng = random.Random(seed)
        self.rules = [(a, b) for a in range(1, PRIME) for b in range(PRIME)]

    @staticmethod
    def apply(rule: tuple[int, int], x: int) -> int:
        a, b = rule
        return (a * x + b) % PRIME

    @staticmethod
    def compose(first: tuple[int, int], second: tuple[int, int]) -> tuple[int, int]:
        # second(first(x))
        a1, b1 = first
        a2, b2 = second
        return ((a2 * a1) % PRIME, (a2 * b1 + b2) % PRIME)

    @staticmethod
    def inverse(rule: tuple[int, int]) -> tuple[int, int]:
        a, b = rule
        inv = pow(a, -1, PRIME)
        return (inv, (-inv * b) % PRIME)

    def _pair(self, rule: tuple[int, int], x: int) -> list[int]:
        return [x, self.apply(rule, x)]

    def sample(self, count: int, *, families: tuple[int, ...], seed: int) -> Batch:
        rng = random.Random(seed)
        rows, answers, family_rows, rule_as, rule_bs = [], [], [], [], []
        for _ in range(count):
            family = rng.choice(families)
            rule_a = rng.choice(self.rules)
            rule_b = rng.choice(self.rules)
            xs = rng.sample(range(PRIME), 5)
            x0, x1, x2, x3, query_x = xs
            if family == 0:  # infer one transformation from two examples
                tokens = self._pair(rule_a, x0) + self._pair(rule_a, x1) + [query_x, QUERY_BASE]
                answer = self.apply(rule_a, query_x)
            elif family == 1:  # apply same transformation twice
                tokens = self._pair(rule_a, x0) + self._pair(rule_a, x1) + [query_x, QUERY_BASE + 1]
                answer = self.apply(rule_a, self.apply(rule_a, query_x))
            elif family == 2:  # inverse from forward demonstrations
                y = self.apply(rule_a, query_x)
                tokens = self._pair(rule_a, x0) + self._pair(rule_a, x1) + [y, QUERY_BASE + 2]
                answer = query_x
            elif family == 3:  # analogy under same relation
                tokens = self._pair(rule_a, x0) + self._pair(rule_a, x1) + [query_x, QUERY_BASE + 3]
                answer = self.apply(rule_a, query_x)
            elif family == 4:  # unseen composition of two inferred rules
                tokens = (
                    self._pair(rule_a, x0) + self._pair(rule_a, x1)
                    + self._pair(rule_b, x2) + self._pair(rule_b, x3)
                    + [query_x, QUERY_BASE + 4]
                )
                answer = self.apply(self.compose(rule_a, rule_b), query_x)
            elif family == 5:  # counterfactual replacement: use B instead of A
                tokens = (
                    self._pair(rule_a, x0) + self._pair(rule_a, x1)
                    + self._pair(rule_b, x2) + self._pair(rule_b, x3)
                    + [query_x, QUERY_BASE + 5]
                )
                answer = self.apply(rule_b, query_x)
            elif family == 6:  # classify whether composition returns the query
                tokens = (
                    self._pair(rule_a, x0) + self._pair(rule_a, x1)
                    + self._pair(rule_b, x2) + self._pair(rule_b, x3)
                    + [query_x, QUERY_BASE + 6]
                )
                composed = self.apply(self.compose(rule_a, rule_b), query_x)
                answer = int(composed == query_x)
            else:  # inverse-composition
                tokens = (
                    self._pair(rule_a, x0) + self._pair(rule_a, x1)
                    + self._pair(rule_b, x2) + self._pair(rule_b, x3)
                    + [query_x, QUERY_BASE + 7]
                )
                transform = self.compose(rule_a, self.inverse(rule_b))
                answer = self.apply(transform, query_x)
            max_len = 10
            tokens = tokens[:max_len] + [PAD] * (max_len - len(tokens[:max_len]))
            rows.append(tokens)
            answers.append(answer)
            family_rows.append(family)
            rule_as.append(rule_a[0] * PRIME + rule_a[1])
            rule_bs.append(rule_b[0] * PRIME + rule_b[1])
        return Batch(
            tokens=torch.tensor(rows, dtype=torch.long),
            answer=torch.tensor(answers, dtype=torch.long),
            family=torch.tensor(family_rows, dtype=torch.long),
            rule_a=torch.tensor(rule_as, dtype=torch.long),
            rule_b=torch.tensor(rule_bs, dtype=torch.long),
        )


class Student(nn.Module):
    def __init__(self, cfg: Config) -> None:
        super().__init__()
        self.embedding = nn.Embedding(VOCAB, cfg.width)
        self.position = nn.Parameter(torch.zeros(1, 10, cfg.width))
        layer = nn.TransformerEncoderLayer(
            d_model=cfg.width,
            nhead=cfg.heads,
            dim_feedforward=cfg.width * 4,
            batch_first=True,
            activation="gelu",
            norm_first=True,
        )
        self.encoder = nn.TransformerEncoder(layer, cfg.layers)
        self.answer = nn.Linear(cfg.width, PRIME)
        self.family = nn.Linear(cfg.width, 8)
        self.rule_probe_a = nn.Linear(cfg.width, (PRIME - 1) * PRIME)
        self.rule_probe_b = nn.Linear(cfg.width, (PRIME - 1) * PRIME)
        nn.init.normal_(self.position, std=0.01)

    def forward(self, batch: Batch) -> dict[str, torch.Tensor]:
        mask = batch.tokens.eq(PAD)
        x = self.embedding(batch.tokens) + self.position[:, : batch.tokens.size(1)]
        encoded = self.encoder(x, src_key_padding_mask=mask)
        lengths = (~mask).sum(-1).clamp_min(1) - 1
        pooled = encoded[torch.arange(encoded.size(0), device=encoded.device), lengths]
        return {
            "answer_logits": self.answer(pooled),
            "family_logits": self.family(pooled),
            "rule_a_logits": self.rule_probe_a(pooled.detach()),
            "rule_b_logits": self.rule_probe_b(pooled.detach()),
        }


class Replay:
    def __init__(self, capacity: int) -> None:
        self.capacity = capacity
        self.rows: list[Batch] = []

    def add(self, batch: Batch) -> None:
        cpu = batch.to(torch.device("cpu"))
        for i in range(cpu.answer.numel()):
            self.rows.append(Batch(
                cpu.tokens[i:i+1], cpu.answer[i:i+1], cpu.family[i:i+1],
                cpu.rule_a[i:i+1], cpu.rule_b[i:i+1]
            ))
        if len(self.rows) > self.capacity:
            self.rows = self.rows[-self.capacity:]

    def sample(self, count: int, rng: random.Random, device: torch.device) -> Batch:
        chosen = [self.rows[rng.randrange(len(self.rows))] for _ in range(count)]
        return Batch(
            tokens=torch.cat([row.tokens for row in chosen]).to(device),
            answer=torch.cat([row.answer for row in chosen]).to(device),
            family=torch.cat([row.family for row in chosen]).to(device),
            rule_a=torch.cat([row.rule_a for row in chosen]).to(device),
            rule_b=torch.cat([row.rule_b for row in chosen]).to(device),
        )


def optimize(model: Student, optimizer: torch.optim.Optimizer, batch: Batch) -> float:
    out = model(batch)
    loss = (
        F.cross_entropy(out["answer_logits"], batch.answer)
        + 0.10 * F.cross_entropy(out["family_logits"], batch.family)
    )
    optimizer.zero_grad(set_to_none=True)
    loss.backward()
    torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
    optimizer.step()
    return float(loss.detach().cpu())


@torch.no_grad()
def evaluate(model: Student, world: AffineWorld, cfg: Config, seed: int) -> dict[str, float]:
    model.eval()
    device = next(model.parameters()).device
    seen = world.sample(cfg.eval_examples, families=(0, 1, 2, 3), seed=seed).to(device)
    transfer = world.sample(cfg.eval_examples, families=(4, 5, 6, 7), seed=seed ^ 0x715).to(device)
    seen_out, transfer_out = model(seen), model(transfer)
    return {
        "seen_accuracy": float(seen_out["answer_logits"].argmax(-1).eq(seen.answer).float().mean().cpu()),
        "transfer_accuracy": float(transfer_out["answer_logits"].argmax(-1).eq(transfer.answer).float().mean().cpu()),
        "family_accuracy": float(transfer_out["family_logits"].argmax(-1).eq(transfer.family).float().mean().cpu()),
        "rule_a_probe": float(transfer_out["rule_a_logits"].argmax(-1).eq(transfer.rule_a).float().mean().cpu()),
        "rule_b_probe": float(transfer_out["rule_b_logits"].argmax(-1).eq(transfer.rule_b).float().mean().cpu()),
    }


@torch.no_grad()
def select_uncertain(model: Student, candidates: Batch, count: int) -> Batch:
    device = next(model.parameters()).device
    batch = candidates.to(device)
    probs = model(batch)["answer_logits"].softmax(-1)
    entropy = -(probs.clamp_min(1e-9) * probs.clamp_min(1e-9).log()).sum(-1)
    idx = entropy.topk(count).indices
    return Batch(*(value.index_select(0, idx) for value in (
        batch.tokens, batch.answer, batch.family, batch.rule_a, batch.rule_b
    )))


def run_seed(cfg: Config, seed: int, output: pathlib.Path) -> dict[str, Any]:
    torch.manual_seed(seed)
    random.seed(seed)
    if cfg.device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA requested but unavailable")
    device = torch.device(cfg.device)
    world = AffineWorld(seed ^ 0xA11CE)
    model = Student(cfg).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=cfg.lr)
    replay = Replay(cfg.replay_capacity)
    rng = random.Random(seed ^ 0xC0DE)

    teacher = world.sample(cfg.teacher_examples, families=(0, 1, 2, 3), seed=seed ^ 0x7EA)
    replay.add(teacher)
    for _ in range(cfg.train_steps_per_round):
        optimize(model, optimizer, replay.sample(cfg.batch_size, rng, device))
    after_teacher = evaluate(model, world, cfg, seed ^ 0x100)
    trajectory = [{"round": 0, **after_teacher}]

    # Teacher is gone. Environment exposes truth for self-selected experiences,
    # including families the teacher never demonstrated.
    for round_index in range(1, cfg.autonomous_rounds + 1):
        candidate_families = (0, 1, 2, 3, 4, 5, 6, 7)
        candidates = world.sample(
            cfg.autonomous_candidates,
            families=candidate_families,
            seed=seed ^ (round_index * 1009),
        )
        acquired = select_uncertain(model, candidates, cfg.autonomous_examples)
        replay.add(acquired)
        model.train()
        for _ in range(cfg.train_steps_per_round):
            optimize(model, optimizer, replay.sample(cfg.batch_size, rng, device))
        trajectory.append({"round": round_index, **evaluate(
            model, world, cfg, seed ^ (0x100 + round_index * 313)
        )})

    final = trajectory[-1]
    checkpoint = output / f"developmental-teacher-escape-{seed}.pt"
    torch.save({
        "schema": SCHEMA,
        "config": asdict(cfg),
        "seed": seed,
        "model": model.state_dict(),
        "trajectory": trajectory,
    }, checkpoint)
    return {
        "seed": seed,
        "checkpoint": str(checkpoint),
        "checkpoint_sha256": hashlib.sha256(checkpoint.read_bytes()).hexdigest(),
        "after_teacher": after_teacher,
        "final": final,
        "trajectory": trajectory,
        "autonomous_seen_gain": final["seen_accuracy"] - after_teacher["seen_accuracy"],
        "autonomous_transfer_gain": final["transfer_accuracy"] - after_teacher["transfer_accuracy"],
    }


def aggregate(cfg: Config, runs: list[dict[str, Any]]) -> dict[str, Any]:
    checks = {
        "continues_learning_after_teacher": min(run["autonomous_seen_gain"] for run in runs) > 0.03,
        "escapes_teacher_family_boundary": min(run["autonomous_transfer_gain"] for run in runs) > 0.08,
        "transfer_is_nontrivial": min(run["final"]["transfer_accuracy"] for run in runs) > (1.0 / PRIME) + 0.18,
        "shared_latent_structure_decodable": min(run["final"]["rule_a_probe"] for run in runs) > (1.0 / ((PRIME - 1) * PRIME)) + 0.05,
    }
    return {
        "schema": SCHEMA,
        "config": asdict(cfg),
        "runs": runs,
        "checks": checks,
        "passed_declared_experiment": all(checks.values()),
        "claim_boundary": (
            "Pass means a locally trainable student continued acquiring relational competence "
            "after bounded teacher exposure and crossed into task families absent from that teacher "
            "curriculum. It does not establish unrestricted or human-level general intelligence."
        ),
    }


def profile(name: str, device: str) -> Config:
    if name == "smoke":
        return Config(
            width=64,
            layers=2,
            teacher_examples=96,
            autonomous_rounds=2,
            autonomous_candidates=128,
            autonomous_examples=32,
            train_steps_per_round=12,
            batch_size=16,
            seeds=(17,),
            eval_examples=128,
            device=device,
        )
    if name == "full":
        return Config(device=device)
    raise ValueError(name)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=("smoke", "full"), default="smoke")
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    cfg = profile(args.profile, args.device)
    cfg.validate()
    output = pathlib.Path(args.output_dir).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    runs = [run_seed(cfg, seed, output) for seed in cfg.seeds]
    receipt = aggregate(cfg, runs)
    path = output / "developmental-teacher-escape.json"
    path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
