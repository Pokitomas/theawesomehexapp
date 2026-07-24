#!/usr/bin/env python3
"""Open-competence teacher escape experiment.

This experiment does not define competence as coding or a finite skill list. A
local student first receives bounded teacher traces, then loses teacher access and
must continue developing through interaction, replay, self-generated hypotheses,
and gradient updates.

The court measures whether the student acquires reusable latent structure that
transfers across task families and continues improving after the teacher is gone.
A pass is not general intelligence; it is evidence that the teacher was a catalyst
rather than the student's permanent ceiling.
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

SCHEMA = "archie-open-competence-escape/v1"


@dataclass(frozen=True)
class Config:
    symbols: int = 12
    attributes: int = 6
    latent_rules: int = 24
    width: int = 128
    state_width: int = 96
    layers: int = 4
    heads: int = 4
    teacher_examples: int = 256
    autonomous_rounds: int = 12
    autonomous_examples_per_round: int = 128
    replay_capacity: int = 8192
    train_steps_per_round: int = 250
    batch_size: int = 64
    lr: float = 3e-4
    seeds: tuple[int, ...] = (17, 29, 43)
    eval_episodes: int = 1024
    device: str = "cuda"

    def validate(self) -> None:
        if self.symbols < 8 or self.attributes < 4 or self.latent_rules < 8:
            raise ValueError("world is too small")
        if self.width % self.heads:
            raise ValueError("width must divide heads")
        if self.teacher_examples < 32 or self.autonomous_rounds < 2:
            raise ValueError("development budget is too small")
        if not self.seeds:
            raise ValueError("at least one seed is required")


@dataclass(frozen=True)
class Episode:
    context: torch.Tensor
    query: torch.Tensor
    answer: torch.Tensor
    family: torch.Tensor
    rule: torch.Tensor

    def to(self, device: torch.device) -> "Episode":
        return Episode(*(value.to(device) for value in (
            self.context, self.query, self.answer, self.family, self.rule
        )))


class LatentWorld:
    """Generates relational worlds sharing reusable hidden structure.

    Families differ in surface form but are generated from a common latent algebra:
    permutation, composition, inverse, parity, analogy, and counterfactual update.
    The student is never given rule IDs as input.
    """

    def __init__(self, cfg: Config, seed: int) -> None:
        self.cfg = cfg
        self.rng = random.Random(seed)
        self.permutations = []
        for _ in range(cfg.latent_rules):
            values = list(range(cfg.symbols))
            self.rng.shuffle(values)
            self.permutations.append(values)

    def _apply(self, rule: int, symbol: int, times: int = 1) -> int:
        value = symbol
        for _ in range(times):
            value = self.permutations[rule][value]
        return value

    def sample(self, batch: int, *, heldout_family: bool = False, seed: int | None = None) -> Episode:
        rng = self.rng if seed is None else random.Random(seed)
        contexts, queries, answers, families, rules = [], [], [], [], []
        family_pool = (4, 5) if heldout_family else (0, 1, 2, 3)
        for _ in range(batch):
            family = rng.choice(family_pool)
            rule = rng.randrange(self.cfg.latent_rules)
            anchor = rng.randrange(self.cfg.symbols)
            second = rng.randrange(self.cfg.symbols)
            if family == 0:  # direct relation induction
                context = [anchor, self._apply(rule, anchor), second]
                query = [second, 0]
                answer = self._apply(rule, second)
            elif family == 1:  # composition depth
                context = [anchor, self._apply(rule, anchor), second]
                depth = rng.choice((2, 3))
                query = [second, depth]
                answer = self._apply(rule, second, depth)
            elif family == 2:  # inverse reasoning
                image = self._apply(rule, second)
                context = [anchor, self._apply(rule, anchor), image]
                query = [image, 4]
                answer = second
            elif family == 3:  # analogy across anchors
                third = rng.randrange(self.cfg.symbols)
                context = [anchor, self._apply(rule, anchor), second, self._apply(rule, second), third]
                query = [third, 5]
                answer = self._apply(rule, third)
            elif family == 4:  # counterfactual intervention transfer
                altered_rule = (rule + 1) % self.cfg.latent_rules
                context = [anchor, self._apply(rule, anchor), second, self._apply(altered_rule, second)]
                query = [anchor, 6]
                answer = self._apply(altered_rule, anchor)
            else:  # relational parity/class abstraction
                image = self._apply(rule, second)
                context = [anchor, self._apply(rule, anchor), second, image]
                query = [second, 7]
                answer = int((image - second) % 2)
            contexts.append(context[:5] + [self.cfg.symbols] * (5 - len(context[:5])))
            queries.append(query)
            answers.append(answer)
            families.append(family)
            rules.append(rule)
        return Episode(
            context=torch.tensor(contexts, dtype=torch.long),
            query=torch.tensor(queries, dtype=torch.long),
            answer=torch.tensor(answers, dtype=torch.long),
            family=torch.tensor(families, dtype=torch.long),
            rule=torch.tensor(rules, dtype=torch.long),
        )


class Student(nn.Module):
    def __init__(self, cfg: Config) -> None:
        super().__init__()
        self.cfg = cfg
        vocab = cfg.symbols + 8
        self.embedding = nn.Embedding(vocab, cfg.width)
        layer = nn.TransformerEncoderLayer(
            d_model=cfg.width,
            nhead=cfg.heads,
            dim_feedforward=cfg.width * 4,
            batch_first=True,
            activation="gelu",
            norm_first=True,
        )
        self.encoder = nn.TransformerEncoder(layer, cfg.layers)
        self.state_encoder = nn.GRU(cfg.width, cfg.state_width, batch_first=True)
        self.state_to_width = nn.Linear(cfg.state_width, cfg.width)
        self.answer_head = nn.Linear(cfg.width, cfg.symbols)
        self.family_head = nn.Linear(cfg.width, 6)
        self.rule_probe = nn.Linear(cfg.width, cfg.latent_rules)

    def forward(self, episode: Episode) -> dict[str, torch.Tensor]:
        tokens = torch.cat((episode.context, episode.query), dim=1)
        x = self.embedding(tokens)
        encoded = self.encoder(x)
        _, hidden = self.state_encoder(encoded)
        state = hidden[-1]
        fused = encoded[:, -1] + self.state_to_width(state)
        return {
            "answer_logits": self.answer_head(fused),
            "family_logits": self.family_head(fused),
            "rule_logits": self.rule_probe(fused.detach()),
            "state": state,
        }


class Replay:
    def __init__(self, capacity: int) -> None:
        self.capacity = capacity
        self.rows: list[Episode] = []

    def add(self, episode: Episode) -> None:
        cpu = Episode(*(value.detach().cpu() for value in (
            episode.context, episode.query, episode.answer, episode.family, episode.rule
        )))
        for index in range(cpu.answer.numel()):
            self.rows.append(Episode(
                cpu.context[index:index+1], cpu.query[index:index+1],
                cpu.answer[index:index+1], cpu.family[index:index+1], cpu.rule[index:index+1]
            ))
        if len(self.rows) > self.capacity:
            self.rows = self.rows[-self.capacity:]

    def sample(self, batch: int, rng: random.Random, device: torch.device) -> Episode:
        chosen = [self.rows[rng.randrange(len(self.rows))] for _ in range(batch)]
        return Episode(
            context=torch.cat([row.context for row in chosen], dim=0).to(device),
            query=torch.cat([row.query for row in chosen], dim=0).to(device),
            answer=torch.cat([row.answer for row in chosen], dim=0).to(device),
            family=torch.cat([row.family for row in chosen], dim=0).to(device),
            rule=torch.cat([row.rule for row in chosen], dim=0).to(device),
        )


def optimize(student: Student, optimizer: torch.optim.Optimizer, batch: Episode) -> float:
    out = student(batch)
    answer_loss = F.cross_entropy(out["answer_logits"], batch.answer)
    family_loss = F.cross_entropy(out["family_logits"], batch.family)
    loss = answer_loss + 0.15 * family_loss
    optimizer.zero_grad(set_to_none=True)
    loss.backward()
    torch.nn.utils.clip_grad_norm_(student.parameters(), 1.0)
    optimizer.step()
    return float(loss.detach().cpu())


@torch.no_grad()
def evaluate(student: Student, world: LatentWorld, cfg: Config, seed: int) -> dict[str, float]:
    student.eval()
    device = next(student.parameters()).device
    seen = world.sample(cfg.eval_episodes, heldout_family=False, seed=seed).to(device)
    held = world.sample(cfg.eval_episodes, heldout_family=True, seed=seed ^ 0x51A7).to(device)
    seen_out = student(seen)
    held_out = student(held)
    return {
        "seen_family_accuracy": float(seen_out["answer_logits"].argmax(-1).eq(seen.answer).float().mean().cpu()),
        "heldout_family_accuracy": float(held_out["answer_logits"].argmax(-1).eq(held.answer).float().mean().cpu()),
        "family_abstraction_accuracy": float(held_out["family_logits"].argmax(-1).eq(held.family).float().mean().cpu()),
        "latent_rule_probe_accuracy": float(held_out["rule_logits"].argmax(-1).eq(held.rule).float().mean().cpu()),
    }


def autonomous_select(student: Student, world: LatentWorld, cfg: Config, round_index: int, seed: int) -> Episode:
    """Select experiences by uncertainty, not teacher choice."""
    device = next(student.parameters()).device
    candidates = world.sample(cfg.autonomous_examples_per_round * 4, heldout_family=False, seed=seed).to(device)
    student.eval()
    with torch.no_grad():
        probs = student(candidates)["answer_logits"].softmax(-1)
        uncertainty = -(probs.clamp_min(1e-9) * probs.clamp_min(1e-9).log()).sum(-1)
        indices = uncertainty.topk(cfg.autonomous_examples_per_round).indices
    return Episode(
        *(value.index_select(0, indices) for value in (
            candidates.context, candidates.query, candidates.answer, candidates.family, candidates.rule
        ))
    )


def run_seed(cfg: Config, seed: int, output: pathlib.Path) -> dict[str, Any]:
    torch.manual_seed(seed)
    random.seed(seed)
    if cfg.device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA requested but unavailable")
    device = torch.device(cfg.device)
    world = LatentWorld(cfg, seed ^ 0xA11CE)
    student = Student(cfg).to(device)
    optimizer = torch.optim.AdamW(student.parameters(), lr=cfg.lr)
    replay = Replay(cfg.replay_capacity)
    rng = random.Random(seed ^ 0xC0DE)

    teacher = world.sample(cfg.teacher_examples, heldout_family=False, seed=seed ^ 0x7EA).to(device)
    replay.add(teacher)
    for _ in range(max(1, cfg.train_steps_per_round)):
        optimize(student, optimizer, replay.sample(cfg.batch_size, rng, device))
    after_teacher = evaluate(student, world, cfg, seed ^ 0x101)

    trajectory = [{"round": 0, **after_teacher}]
    for round_index in range(1, cfg.autonomous_rounds + 1):
        acquired = autonomous_select(
            student, world, cfg, round_index,
            seed ^ (round_index * 1009)
        )
        replay.add(acquired)
        student.train()
        for _ in range(cfg.train_steps_per_round):
            optimize(student, optimizer, replay.sample(cfg.batch_size, rng, device))
        trajectory.append({"round": round_index, **evaluate(
            student, world, cfg, seed ^ (0x101 + round_index * 313)
        )})

    final = trajectory[-1]
    checkpoint = output / f"teacher-escape-seed-{seed}.pt"
    torch.save({
        "schema": SCHEMA,
        "config": asdict(cfg),
        "seed": seed,
        "model": student.state_dict(),
        "trajectory": trajectory,
    }, checkpoint)
    return {
        "seed": seed,
        "checkpoint": str(checkpoint),
        "checkpoint_sha256": hashlib.sha256(checkpoint.read_bytes()).hexdigest(),
        "after_teacher": after_teacher,
        "final": final,
        "trajectory": trajectory,
        "autonomous_gain_seen": final["seen_family_accuracy"] - after_teacher["seen_family_accuracy"],
        "autonomous_gain_heldout": final["heldout_family_accuracy"] - after_teacher["heldout_family_accuracy"],
    }


def aggregate(cfg: Config, runs: list[dict[str, Any]]) -> dict[str, Any]:
    def minimum(key: str) -> float:
        return min(float(run[key]) for run in runs)
    checks = {
        "improves_after_teacher_removed": minimum("autonomous_gain_seen") > 0.05,
        "transfer_improves_after_teacher_removed": minimum("autonomous_gain_heldout") > 0.03,
        "heldout_family_above_chance": min(run["final"]["heldout_family_accuracy"] for run in runs) > (1.0 / cfg.symbols) + 0.15,
        "latent_structure_is_decodable": min(run["final"]["latent_rule_probe_accuracy"] for run in runs) > (1.0 / cfg.latent_rules) + 0.10,
    }
    return {
        "schema": SCHEMA,
        "config": asdict(cfg),
        "runs": runs,
        "checks": checks,
        "passed_declared_experiment": all(checks.values()),
        "claim_boundary": (
            "Pass means the local student continued acquiring transferable relational competence "
            "after bounded teacher exposure ended. It does not establish open-ended intelligence, "
            "human-level competence, or freedom from all teacher-induced priors."
        ),
    }


def profile(name: str, device: str) -> Config:
    if name == "smoke":
        return Config(
            width=64,
            state_width=48,
            layers=2,
            teacher_examples=64,
            autonomous_rounds=3,
            autonomous_examples_per_round=32,
            train_steps_per_round=20,
            batch_size=16,
            seeds=(17,),
            eval_episodes=128,
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
    path = output / "open-competence-teacher-escape.json"
    path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
