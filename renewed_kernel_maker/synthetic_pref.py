from __future__ import annotations

import hashlib
import json
import random
from dataclasses import dataclass, asdict
from typing import Any

from core import canonical, receipt


@dataclass(frozen=True)
class Task:
    id: str
    split: str
    family: str
    seed: int
    spec: dict[str, Any]


@dataclass(frozen=True)
class Candidate:
    id: str
    task_id: str
    actions: tuple[str, ...]
    receipts_ok: int
    tests_passed: int
    regressions: int
    latency_ms: int


def task_id(split: str, family: str, seed: int, spec: dict[str, Any]) -> str:
    raw = canonical({"split": split, "family": family, "seed": seed, "spec": spec})
    return hashlib.sha256(raw).hexdigest()[:16]


def generate_tasks(*, train_seeds: range = range(0, 32), heldout_seeds: range = range(10_000, 10_016)) -> tuple[list[Task], list[Task]]:
    families = ("stale-seat", "repair-generated-app", "timeline-edit", "portable-roundtrip", "tool-recovery")

    def one(split: str, seed: int) -> Task:
        r = random.Random(seed)
        family = families[r.randrange(len(families))]
        spec = {
            "difficulty": 1 + r.randrange(5),
            "faults": 1 + r.randrange(4),
            "budget": 4 + r.randrange(9),
            "reversible_required": bool(r.randrange(2)),
        }
        return Task(task_id(split, family, seed, spec), split, family, seed, spec)

    return ([one("train", s) for s in train_seeds], [one("heldout", s) for s in heldout_seeds])


def score(c: Candidate) -> int:
    # Deliberately integer and inspectable. Passing evidence dominates speed;
    # regressions are more expensive than a modest latency win.
    return 1000 * c.tests_passed + 250 * c.receipts_ok - 1500 * c.regressions - min(500, max(0, c.latency_ms))


def preference_pair(task: Task, a: Candidate, b: Candidate) -> dict[str, Any]:
    sa, sb = score(a), score(b)
    if sa == sb:
        # Stable tie-break, independent of generation order.
        winner, loser = sorted((a, b), key=lambda c: c.id)
    else:
        winner, loser = (a, b) if sa > sb else (b, a)
    return {
        "schema": "archie-maker-preference/v1",
        "task": asdict(task),
        "chosen": asdict(winner),
        "rejected": asdict(loser),
        "scores": {a.id: sa, b.id: sb},
    }


def synthesize_candidate(task: Task, variant: int) -> Candidate:
    # This fixture is a court for ranking/data plumbing, not a claim that a
    # language model was trained. Real candidates replace this producer.
    r = random.Random(task.seed * 101 + variant * 7919)
    budget = int(task.spec["budget"])
    actions = tuple(f"act-{i}-{r.randrange(7)}" for i in range(1 + r.randrange(max(1, budget))))
    receipts_ok = max(0, len(actions) - r.randrange(3))
    tests_passed = r.randrange(4)
    regressions = r.randrange(2 if variant else 3)
    latency_ms = 20 + r.randrange(420)
    cid = hashlib.sha256(canonical({"task": task.id, "variant": variant, "actions": actions})).hexdigest()[:14]
    return Candidate(cid, task.id, actions, receipts_ok, tests_passed, regressions, latency_ms)


def dataset() -> dict[str, Any]:
    train, heldout = generate_tasks()
    pairs = []
    for task in train:
        pairs.append(preference_pair(task, synthesize_candidate(task, 0), synthesize_candidate(task, 1)))
    train_ids = {t.id for t in train}
    heldout_ids = {t.id for t in heldout}
    overlap = train_ids & heldout_ids
    return receipt("synthetic.preference_dataset", {
        "train_tasks": len(train),
        "heldout_tasks": len(heldout),
        "preference_pairs": len(pairs),
        "split_overlap": sorted(overlap),
        "leakage_free": not overlap,
        "dataset_sha256": hashlib.sha256(canonical(pairs)).hexdigest(),
        "pairs": pairs,
        "heldout_manifest": [asdict(t) for t in heldout],
    })


def rank_policy_weights(pairs: list[dict[str, Any]]) -> dict[str, float]:
    """Tiny deterministic preference fit used as a plumbing oracle.

    It learns only four transparent scalar weights with perceptron-style updates;
    it is intentionally not presented as RLHF. The real trainer may consume the
    exact same chosen/rejected records later.
    """
    w = {"tests": 0.0, "receipts": 0.0, "regressions": 0.0, "latency": 0.0}

    def f(c: dict[str, Any]) -> dict[str, float]:
        return {
            "tests": float(c["tests_passed"]),
            "receipts": float(c["receipts_ok"]),
            "regressions": float(c["regressions"]),
            "latency": float(c["latency_ms"]) / 500.0,
        }

    for _ in range(8):
        for pair in pairs:
            a, b = f(pair["chosen"]), f(pair["rejected"])
            margin = sum(w[k] * (a[k] - b[k]) for k in w)
            if margin <= 0.2:
                for k in w:
                    w[k] += 0.05 * (a[k] - b[k])
    return {k: round(v, 8) for k, v in w.items()}


def court() -> dict[str, Any]:
    data = dataset()
    pairs = data["payload"]["pairs"]
    weights1 = rank_policy_weights(pairs)
    weights2 = rank_policy_weights(json.loads(json.dumps(pairs)))
    deterministic = weights1 == weights2
    heldout = data["payload"]["heldout_manifest"]
    # Ensure held-out IDs never occur anywhere in the serialized train pairs.
    blob = json.dumps(pairs, sort_keys=True)
    leakage = [x["id"] for x in heldout if x["id"] in blob]
    return receipt("synthetic.court", {
        "dataset": {k: v for k, v in data["payload"].items() if k not in {"pairs", "heldout_manifest"}},
        "fit_weights": weights1,
        "deterministic_fit": deterministic,
        "heldout_leakage": leakage,
        "passes": bool(data["payload"]["leakage_free"]) and deterministic and not leakage,
        "claim": "preference-data-and-ranking-plumbing-only; no frontier-RLHF claim",
    })


if __name__ == "__main__":
    print(json.dumps(court(), indent=2))
