#!/usr/bin/env python3
"""Executable residual cortex for API-model/container learning.

An API model cannot update its provider weights from a container. This experiment
instead compiles model-proposed lessons into two durable local objects:

1. an admitted executable skill in a restricted deterministic DSL; and
2. a genuinely trained local router that learns when to invoke each skill.

The experiment asks whether this pair can acquire exact procedural competence on
unseen inputs and unseen language paraphrases more efficiently than textual memory.
It does not claim to alter the API model or equal general-purpose weight training.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import pathlib
import random
from dataclasses import asdict, dataclass
from typing import Any, Iterable, Mapping

import torch
import torch.nn as nn
import torch.nn.functional as F

SCHEMA = "archie-executable-residual-cortex/v1"
SKILL_SCHEMA = "archie-executable-skill/v1"
LESSON_SCHEMA = "archie-executable-lesson/v1"
OPS = {
    "sum_mod",
    "product_mod",
    "maximum",
    "minimum",
    "xor",
    "count_even",
    "count_above",
    "affine_sum_mod",
}


def stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(value: Any) -> str:
    return hashlib.sha256(stable_json(value).encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class CortexConfig:
    hash_buckets: int = 4096
    width: int = 128
    steps: int = 1200
    batch_size: int = 64
    learning_rate: float = 2e-3
    weight_decay: float = 0.01
    hidden_tests: int = 512
    train_paraphrases_per_skill: int = 18
    eval_paraphrases_per_skill: int = 24
    seeds: tuple[int, ...] = (17, 29, 43)
    device: str = "cuda"

    def validate(self) -> None:
        if self.hash_buckets < 256 or self.width < 16:
            raise ValueError("router capacity is too small")
        if self.steps < 1 or self.batch_size < 2 or self.hidden_tests < 32:
            raise ValueError("invalid experiment budget")
        if not self.seeds:
            raise ValueError("at least one seed is required")


@dataclass(frozen=True)
class Skill:
    skill_id: str
    description: str
    program: dict[str, Any]

    @classmethod
    def from_json(cls, value: Mapping[str, Any]) -> "Skill":
        if value.get("schema") != SKILL_SCHEMA:
            raise ValueError("unsupported skill schema")
        program = dict(value.get("program", {}))
        validate_program(program)
        skill_id = str(value.get("skill_id", ""))
        description = str(value.get("description", "")).strip()
        if not skill_id or not description:
            raise ValueError("skill identity and description are required")
        return cls(skill_id=skill_id, description=description, program=program)

    def receipt(self) -> dict[str, Any]:
        body = {
            "schema": SKILL_SCHEMA,
            "skill_id": self.skill_id,
            "description": self.description,
            "program": self.program,
        }
        return {**body, "skill_digest": digest(body)}


@dataclass(frozen=True)
class Lesson:
    skill: Skill
    utterances: tuple[str, ...]
    public_examples: tuple[tuple[tuple[int, ...], int], ...]

    @classmethod
    def from_json(cls, value: Mapping[str, Any]) -> "Lesson":
        if value.get("schema") != LESSON_SCHEMA:
            raise ValueError("unsupported lesson schema")
        skill = Skill.from_json(dict(value.get("skill", {})))
        utterances = tuple(str(item).strip() for item in value.get("utterances", []) if str(item).strip())
        examples: list[tuple[tuple[int, ...], int]] = []
        for row in value.get("public_examples", []):
            inputs = tuple(int(item) for item in row["input"])
            target = int(row["target"])
            examples.append((inputs, target))
        if len(utterances) < 2 or len(examples) < 2:
            raise ValueError("lesson requires multiple utterances and examples")
        return cls(skill=skill, utterances=utterances, public_examples=tuple(examples))


def validate_program(program: Mapping[str, Any]) -> None:
    op = str(program.get("op", ""))
    if op not in OPS:
        raise ValueError(f"unsupported executable operation: {op}")
    integers = {
        key: int(value)
        for key, value in program.items()
        if key != "op"
    }
    if any(abs(value) > 1_000_000 for value in integers.values()):
        raise ValueError("program constant exceeds declared bound")
    if op in {"sum_mod", "product_mod", "affine_sum_mod"} and integers.get("modulus", 0) < 2:
        raise ValueError("modular operation requires modulus >= 2")
    if op == "count_above" and "threshold" not in integers:
        raise ValueError("count_above requires threshold")
    if op == "affine_sum_mod" and not {"scale", "bias", "modulus"}.issubset(integers):
        raise ValueError("affine_sum_mod requires scale, bias, and modulus")


def execute(program: Mapping[str, Any], values: Iterable[int]) -> int:
    validate_program(program)
    xs = [int(value) for value in values]
    if not xs:
        raise ValueError("skill input cannot be empty")
    op = str(program["op"])
    if op == "sum_mod":
        return sum(xs) % int(program["modulus"])
    if op == "product_mod":
        result = 1
        modulus = int(program["modulus"])
        for value in xs:
            result = (result * value) % modulus
        return result
    if op == "maximum":
        return max(xs)
    if op == "minimum":
        return min(xs)
    if op == "xor":
        result = 0
        for value in xs:
            result ^= value
        return result
    if op == "count_even":
        return sum(value % 2 == 0 for value in xs)
    if op == "count_above":
        threshold = int(program["threshold"])
        return sum(value > threshold for value in xs)
    if op == "affine_sum_mod":
        return (
            int(program["scale"]) * sum(xs) + int(program["bias"])
        ) % int(program["modulus"])
    raise AssertionError(op)


def hidden_input(rng: random.Random) -> tuple[int, ...]:
    return tuple(rng.randint(0, 31) for _ in range(rng.randint(3, 14)))


def admit_lesson(lesson: Lesson, *, hidden_tests: int, seed: int) -> dict[str, Any]:
    public_failures: list[dict[str, Any]] = []
    for values, target in lesson.public_examples:
        actual = execute(lesson.skill.program, values)
        if actual != target:
            public_failures.append({"input": list(values), "target": target, "actual": actual})
    rng = random.Random(seed ^ int(digest(lesson.skill.receipt())[:16], 16))
    hidden_failures: list[dict[str, Any]] = []
    oracle = canonical_oracle(lesson.skill.skill_id)
    for _ in range(hidden_tests):
        values = hidden_input(rng)
        target = oracle(values)
        actual = execute(lesson.skill.program, values)
        if actual != target:
            hidden_failures.append({"input": list(values), "target": target, "actual": actual})
            if len(hidden_failures) >= 8:
                break
    admitted = not public_failures and not hidden_failures
    body = {
        "skill": lesson.skill.receipt(),
        "public_examples": len(lesson.public_examples),
        "hidden_tests": hidden_tests,
        "public_failures": public_failures,
        "hidden_failures": hidden_failures,
        "admitted": admitted,
    }
    return {**body, "admission_digest": digest(body)}


def canonical_programs() -> dict[str, dict[str, Any]]:
    return {
        "sum-seven": {"op": "sum_mod", "modulus": 7},
        "product-eleven": {"op": "product_mod", "modulus": 11},
        "largest": {"op": "maximum"},
        "smallest": {"op": "minimum"},
        "xor-all": {"op": "xor"},
        "even-count": {"op": "count_even"},
        "above-nine": {"op": "count_above", "threshold": 9},
        "affine-five": {"op": "affine_sum_mod", "scale": 3, "bias": 2, "modulus": 5},
    }


def canonical_oracle(skill_id: str):
    program = canonical_programs().get(skill_id)
    if program is None:
        raise ValueError(f"hidden court has no oracle for {skill_id}")
    return lambda values: execute(program, values)


PARAPHRASE_PARTS = {
    "sum-seven": ("sum", "total", "add together", "combined amount"),
    "product-eleven": ("product", "multiply", "times together", "multiplicative result"),
    "largest": ("largest", "maximum", "highest", "biggest"),
    "smallest": ("smallest", "minimum", "lowest", "least"),
    "xor-all": ("xor", "exclusive-or", "bitwise xor", "toggle aggregate"),
    "even-count": ("count evens", "how many even", "number divisible by two", "even entries"),
    "above-nine": ("above nine", "greater than nine", "exceeding 9", "over the threshold nine"),
    "affine-five": ("triple sum plus two mod five", "3 times total plus 2 modulo 5", "affine five transform", "scaled modular total"),
}
TEMPLATES = (
    "Please compute {phrase} for this integer list.",
    "Return the {phrase} of the supplied values.",
    "For these numbers, I need {phrase}.",
    "Apply {phrase}; output only the integer.",
    "What is {phrase} here?",
    "Use the rule {phrase} on this sequence.",
)


def paraphrases(skill_id: str, *, count: int, seed: int) -> tuple[str, ...]:
    rng = random.Random(seed)
    phrases = PARAPHRASE_PARTS[skill_id]
    rows: list[str] = []
    while len(rows) < count:
        text = rng.choice(TEMPLATES).format(phrase=rng.choice(phrases))
        if text not in rows:
            rows.append(text)
        elif count > len(TEMPLATES) * len(phrases):
            rows.append(f"{text} request-{len(rows)}")
    return tuple(rows)


def synthetic_lessons(cfg: CortexConfig, seed: int) -> list[Lesson]:
    lessons: list[Lesson] = []
    for index, (skill_id, program) in enumerate(canonical_programs().items()):
        utterances = paraphrases(skill_id, count=cfg.train_paraphrases_per_skill, seed=seed + index * 101)
        rng = random.Random(seed ^ (index * 7919 + 3))
        examples = []
        for _ in range(12):
            values = hidden_input(rng)
            examples.append((values, execute(program, values)))
        lessons.append(Lesson(
            skill=Skill(skill_id=skill_id, description=utterances[0], program=program),
            utterances=utterances,
            public_examples=tuple(examples),
        ))
    return lessons


def byte_hash_features(texts: list[str], buckets: int, device: torch.device) -> torch.Tensor:
    matrix = torch.zeros(len(texts), buckets, dtype=torch.float32, device=device)
    for row, text in enumerate(texts):
        raw = text.lower().encode("utf-8")
        grams = [raw[index:index + width] for width in (1, 2, 3) for index in range(max(0, len(raw) - width + 1))]
        for gram in grams:
            key = int.from_bytes(hashlib.blake2b(gram, digest_size=8).digest(), "little") % buckets
            matrix[row, key] += 1.0
    return F.normalize(matrix, dim=-1)


class SkillRouter(nn.Module):
    def __init__(self, cfg: CortexConfig, skills: int) -> None:
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(cfg.hash_buckets, cfg.width),
            nn.GELU(),
            nn.Linear(cfg.width, skills),
        )

    def forward(self, features: torch.Tensor) -> torch.Tensor:
        return self.net(features)


def lexical_route(text: str, lessons: list[Lesson]) -> int:
    query = set(text.lower().split())
    scores = []
    for lesson in lessons:
        words = set(" ".join((lesson.skill.description, *lesson.utterances)).lower().split())
        scores.append(len(query & words) / max(len(query | words), 1))
    return max(range(len(scores)), key=scores.__getitem__)


def train_router(cfg: CortexConfig, lessons: list[Lesson], seed: int) -> tuple[SkillRouter, list[dict[str, float]]]:
    torch.manual_seed(seed)
    device = torch.device(cfg.device)
    texts: list[str] = []
    labels: list[int] = []
    for label, lesson in enumerate(lessons):
        texts.extend(lesson.utterances)
        labels.extend([label] * len(lesson.utterances))
    features = byte_hash_features(texts, cfg.hash_buckets, device)
    targets = torch.tensor(labels, dtype=torch.long, device=device)
    model = SkillRouter(cfg, len(lessons)).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=cfg.learning_rate, weight_decay=cfg.weight_decay)
    generator = torch.Generator(device="cpu").manual_seed(seed ^ 0xC07E)
    trace: list[dict[str, float]] = []
    for step in range(1, cfg.steps + 1):
        indices = torch.randint(0, len(texts), (cfg.batch_size,), generator=generator).to(device)
        logits = model(features.index_select(0, indices))
        loss = F.cross_entropy(logits, targets.index_select(0, indices))
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        optimizer.step()
        if step == 1 or step % max(1, cfg.steps // 20) == 0:
            trace.append({"step": float(step), "loss": float(loss.detach().cpu())})
    return model, trace


@torch.no_grad()
def evaluate_router(
    cfg: CortexConfig, model: SkillRouter, lessons: list[Lesson], seed: int,
) -> dict[str, float]:
    model.eval()
    texts: list[str] = []
    labels: list[int] = []
    inputs: list[tuple[int, ...]] = []
    rng = random.Random(seed ^ 0xE7A1)
    for label, lesson in enumerate(lessons):
        held_out = paraphrases(
            lesson.skill.skill_id,
            count=cfg.eval_paraphrases_per_skill,
            seed=seed + label * 10007 + 499,
        )
        training = set(lesson.utterances)
        held_out = tuple(text for text in held_out if text not in training)
        while len(held_out) < cfg.eval_paraphrases_per_skill:
            held_out += (f"Unseen formulation {len(held_out)}: {PARAPHRASE_PARTS[lesson.skill.skill_id][-1]}",)
        for text in held_out[:cfg.eval_paraphrases_per_skill]:
            texts.append(text)
            labels.append(label)
            inputs.append(hidden_input(rng))
    device = next(model.parameters()).device
    features = byte_hash_features(texts, cfg.hash_buckets, device)
    predicted = model(features).argmax(-1).cpu().tolist()
    lexical = [lexical_route(text, lessons) for text in texts]
    random_router = random.Random(seed ^ 0xBAD5EED)
    random_predictions = [random_router.randrange(len(lessons)) for _ in texts]

    def score(routes: list[int]) -> tuple[float, float]:
        routed = sum(route == label for route, label in zip(routes, labels)) / len(labels)
        exact = 0
        for route, label, values in zip(routes, labels, inputs):
            expected = execute(lessons[label].skill.program, values)
            actual = execute(lessons[route].skill.program, values)
            exact += actual == expected
        return routed, exact / len(labels)

    trained_route, trained_exact = score(predicted)
    lexical_route_accuracy, lexical_exact = score(lexical)
    random_route_accuracy, random_exact = score(random_predictions)
    return {
        "unseen_utterances": float(len(texts)),
        "trained_router_accuracy": trained_route,
        "trained_end_to_end_exact": trained_exact,
        "lexical_router_accuracy": lexical_route_accuracy,
        "lexical_end_to_end_exact": lexical_exact,
        "random_router_accuracy": random_route_accuracy,
        "random_end_to_end_exact": random_exact,
    }


def run_seed(cfg: CortexConfig, seed: int, output: pathlib.Path) -> dict[str, Any]:
    lessons = synthetic_lessons(cfg, seed)
    admissions = [admit_lesson(lesson, hidden_tests=cfg.hidden_tests, seed=seed) for lesson in lessons]
    if not all(receipt["admitted"] for receipt in admissions):
        raise RuntimeError("canonical lesson failed hidden executable admission")
    model, trace = train_router(cfg, lessons, seed)
    evaluation = evaluate_router(cfg, model, lessons, seed)
    checkpoint = output / f"router-seed-{seed}.pt"
    torch.save({
        "schema": SCHEMA,
        "config": asdict(cfg),
        "seed": seed,
        "skills": [lesson.skill.receipt() for lesson in lessons],
        "router": model.state_dict(),
    }, checkpoint)
    return {
        "seed": seed,
        "checkpoint": str(checkpoint),
        "checkpoint_sha256": hashlib.sha256(checkpoint.read_bytes()).hexdigest(),
        "admissions": admissions,
        "training_trace": trace,
        "evaluation": evaluation,
    }


def aggregate(cfg: CortexConfig, runs: list[dict[str, Any]]) -> dict[str, Any]:
    keys = sorted(runs[0]["evaluation"])
    summary: dict[str, dict[str, float]] = {}
    for key in keys:
        values = [float(run["evaluation"][key]) for run in runs]
        mean = sum(values) / len(values)
        variance = sum((value - mean) ** 2 for value in values) / max(len(values) - 1, 1)
        summary[key] = {
            "mean": mean,
            "minimum": min(values),
            "maximum": max(values),
            "sample_std": math.sqrt(variance),
        }
    checks = {
        "all_skills_hidden_admitted": all(
            receipt["admitted"] for run in runs for receipt in run["admissions"]
        ),
        "trained_router_generalizes": summary["trained_router_accuracy"]["minimum"] >= 0.80,
        "compiled_cortex_exact": summary["trained_end_to_end_exact"]["minimum"] >= 0.85,
        "learned_policy_beats_lexical": (
            summary["trained_end_to_end_exact"]["minimum"]
            > summary["lexical_end_to_end_exact"]["maximum"] + 0.05
        ),
        "learned_policy_beats_random": (
            summary["trained_end_to_end_exact"]["minimum"]
            > summary["random_end_to_end_exact"]["maximum"] + 0.35
        ),
    }
    return {
        "schema": SCHEMA,
        "config": asdict(cfg),
        "config_digest": digest(asdict(cfg)),
        "runs": runs,
        "aggregate": summary,
        "checks": checks,
        "passed_declared_experiment": all(checks.values()),
        "claim_boundary": (
            "A pass establishes only that executable skill admission plus a locally trained "
            "invocation policy acquired exact bounded procedural competence from lesson packets. "
            "It does not update API-provider weights or establish general intelligence."
        ),
    }


def profile(name: str, device: str) -> CortexConfig:
    if name == "smoke":
        return CortexConfig(
            hash_buckets=1024,
            width=64,
            steps=40,
            batch_size=24,
            hidden_tests=64,
            train_paraphrases_per_skill=8,
            eval_paraphrases_per_skill=8,
            seeds=(17,),
            device=device,
        )
    if name == "full":
        return CortexConfig(device=device)
    raise ValueError(name)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=("smoke", "full"), default="smoke")
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--steps", type=int)
    parser.add_argument("--seed", type=int, action="append")
    args = parser.parse_args()

    cfg = profile(args.profile, args.device)
    values = asdict(cfg)
    if args.steps is not None:
        values["steps"] = args.steps
    if args.seed:
        values["seeds"] = tuple(args.seed)
    values["seeds"] = tuple(values["seeds"])
    cfg = CortexConfig(**values)
    cfg.validate()
    output = pathlib.Path(args.output_dir).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    runs = [run_seed(cfg, seed, output) for seed in cfg.seeds]
    receipt = aggregate(cfg, runs)
    path = output / "executable-residual-cortex.json"
    path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
