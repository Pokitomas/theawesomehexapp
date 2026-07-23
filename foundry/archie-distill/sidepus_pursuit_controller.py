#!/usr/bin/env python3
"""Checkpointable active developmental curriculum controller for Sidepus pursuit."""
from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass, field
from typing import Any

from sidepus_developmental_graph import developmental_drive, normalize_vector
from sidepus_pursuit_plan import deterministic_unit

CONTROLLER_SCHEMA = "sidepus-pursuit-controller-state/v4"


@dataclass
class Stat:
    count: int = 0
    loss_ema: float = 0.0
    progress_ema: float = 0.0
    state_utility_ema: float = 0.0
    surprise_ema: float = 0.0
    deliberation_ema: float = 1.0
    interference_ema: float = 0.0
    retention_cost_ema: float = 0.0
    initial_loss: float = 0.0
    best_loss: float = 0.0
    mastery: float = 0.0

    def update(
        self, *, loss: float, state_utility: float, deliberation: float,
        interference: float, retention_cost: float | None, alpha: float,
    ) -> None:
        alpha = max(1e-4, min(1.0, float(alpha)))
        previous = self.loss_ema if self.count else loss
        progress = previous - loss
        if not self.count:
            self.loss_ema = loss
            self.state_utility_ema = state_utility
            self.deliberation_ema = deliberation
            self.interference_ema = interference
            self.retention_cost_ema = max(0.0, float(retention_cost or 0.0))
            self.initial_loss = loss
            self.best_loss = loss
        else:
            old_loss = self.loss_ema
            self.loss_ema = (1 - alpha) * self.loss_ema + alpha * loss
            self.progress_ema = (1 - alpha) * self.progress_ema + alpha * progress
            self.state_utility_ema = (1 - alpha) * self.state_utility_ema + alpha * state_utility
            self.surprise_ema = (1 - alpha) * self.surprise_ema + alpha * (loss - old_loss)
            self.deliberation_ema = (1 - alpha) * self.deliberation_ema + alpha * deliberation
            self.interference_ema = (1 - alpha) * self.interference_ema + alpha * interference
            if retention_cost is not None:
                self.retention_cost_ema = (
                    (1 - alpha) * self.retention_cost_ema
                    + alpha * max(0.0, float(retention_cost))
                )
            self.best_loss = min(self.best_loss, self.loss_ema, loss)
            denominator = max(abs(self.initial_loss), 1e-6)
            measured = (self.initial_loss - self.best_loss) / denominator
            self.mastery = max(self.mastery, max(0.0, min(1.0, measured)))
        self.count += 1


@dataclass
class PursuitController:
    seed: int
    alpha: float = 0.1
    surprise_weight: float = 1.0
    progress_weight: float = 1.25
    novelty_weight: float = 0.8
    state_utility_weight: float = 1.5
    difficulty_weight: float = 0.35
    fairness_weight: float = 0.15
    continuity_weight: float = 0.8
    developmental_weight: float = 1.0
    interference_weight: float = 0.75
    retention_tax_weight: float = 2.0
    global_step: int = 0
    retention_tax: float = 0.0
    last_thread: str | None = None
    last_sequence_index: int | None = None
    records: dict[str, Stat] = field(default_factory=dict)
    domains: dict[str, Stat] = field(default_factory=dict)
    threads: dict[str, Stat] = field(default_factory=dict)
    affordances: dict[str, Stat] = field(default_factory=dict)

    @staticmethod
    def _stat(table: dict[str, Stat], key: str) -> Stat:
        if key not in table:
            table[key] = Stat()
        return table[key]

    @staticmethod
    def _sequence_index(row: Mapping[str, Any]) -> int | None:
        try:
            value = row.get("sequence_index")
            return int(value) if value is not None else None
        except (TypeError, ValueError):
            return None

    def score(self, row: Mapping[str, Any]) -> float:
        record_id = str(row["record_id"])
        domain = str(row.get("primary_domain", "unknown"))
        thread = str(row.get("state_thread_id", row["intent_id"]))
        record = self.records.get(record_id, Stat())
        domain_stat = self.domains.get(domain, Stat())
        thread_stat = self.threads.get(thread, Stat())
        novelty = 1 / math.sqrt(record.count + 1)
        fairness = 1 / math.sqrt(domain_stat.count + 1)
        surprise = max(0.0, record.surprise_ema, domain_stat.surprise_ema, thread_stat.surprise_ema)
        progress = max(0.0, record.progress_ema, domain_stat.progress_ema, thread_stat.progress_ema)
        utility = max(0.0, record.state_utility_ema, domain_stat.state_utility_ema, thread_stat.state_utility_ema)
        interference = max(0.0, record.interference_ema, domain_stat.interference_ema, thread_stat.interference_ema)
        retention_cost = max(0.0, record.retention_cost_ema, domain_stat.retention_cost_ema, thread_stat.retention_cost_ema)
        sequence_index = self._sequence_index(row)
        exact_follow = (
            self.last_thread == thread
            and sequence_index is not None
            and self.last_sequence_index is not None
            and sequence_index == self.last_sequence_index + 1
        )
        same_thread = self.last_thread == thread
        continuity = 1.0 if exact_follow else 0.2 if same_thread else 0.0
        continuity *= 0.35 + min(1.0, max(0.0, thread_stat.state_utility_ema) * 4.0)
        development, _ = developmental_drive(row.get("curriculum_vector"), self.affordances)
        jitter = deterministic_unit(self.seed, "pursuit", self.global_step, row["intent_id"]) * 1e-6
        return (
            self.surprise_weight * surprise
            + self.progress_weight * progress
            + self.novelty_weight * novelty
            + self.state_utility_weight * utility
            + self.difficulty_weight * float(row.get("difficulty_prior", 0.25))
            + self.fairness_weight * fairness
            + self.continuity_weight * continuity
            + self.developmental_weight * development
            - self.interference_weight * interference
            - self.retention_tax_weight * retention_cost
            + jitter
        )

    def choose(self, rows: Sequence[Mapping[str, Any]], count: int) -> list[int]:
        if count < 1 or count > len(rows):
            raise ValueError("invalid pursuit selection count")
        return sorted(range(len(rows)), key=lambda i: (self.score(rows[i]), -i), reverse=True)[:count]

    def feedback(
        self, rows: Sequence[Mapping[str, Any]], *, loss: float, state_utility: float,
        deliberation: float, interference: float = 0.0,
        retention_tax: float | None = None,
    ) -> None:
        for row in rows:
            record_id = str(row["record_id"])
            domain = str(row.get("primary_domain", "unknown"))
            thread = str(row.get("state_thread_id", row["intent_id"]))
            for table, key in (
                (self.records, record_id),
                (self.domains, domain),
                (self.threads, thread),
            ):
                self._stat(table, key).update(
                    loss=loss,
                    state_utility=state_utility,
                    deliberation=deliberation,
                    interference=interference,
                    retention_cost=retention_tax,
                    alpha=self.alpha,
                )
            for name, exposure in normalize_vector(row.get("curriculum_vector")).items():
                if exposure <= 0.0:
                    continue
                self._stat(self.affordances, name).update(
                    loss=loss,
                    state_utility=state_utility * exposure,
                    deliberation=deliberation,
                    interference=interference * exposure,
                    retention_cost=(retention_tax * exposure if retention_tax is not None else None),
                    alpha=self.alpha * max(0.2, exposure),
                )
        if rows:
            last = rows[-1]
            self.last_thread = str(last.get("state_thread_id", last["intent_id"]))
            self.last_sequence_index = self._sequence_index(last)
        if retention_tax is not None:
            self.retention_tax = max(0.0, float(retention_tax))
        self.global_step += 1

    def target_deliberation(self, rows: Sequence[Mapping[str, Any]]) -> float:
        difficulty = sum(float(row.get("difficulty_prior", 0.25)) for row in rows) / max(len(rows), 1)
        surprise = max(
            [self.records.get(str(row["record_id"]), Stat()).surprise_ema for row in rows] or [0.0]
        )
        return max(1.0, min(3.5, 1.0 + 1.4 * difficulty + 0.8 * max(0.0, surprise)))

    def state_dict(self) -> dict[str, Any]:
        return {
            "schema": CONTROLLER_SCHEMA,
            "seed": self.seed,
            "alpha": self.alpha,
            "global_step": self.global_step,
            "retention_tax": self.retention_tax,
            "last_thread": self.last_thread,
            "last_sequence_index": self.last_sequence_index,
            "records": {key: asdict(value) for key, value in self.records.items()},
            "domains": {key: asdict(value) for key, value in self.domains.items()},
            "threads": {key: asdict(value) for key, value in self.threads.items()},
            "affordances": {key: asdict(value) for key, value in self.affordances.items()},
        }

    def load_state_dict(self, state: Mapping[str, Any]) -> None:
        if state.get("schema") != CONTROLLER_SCHEMA or int(state.get("seed", -1)) != self.seed:
            raise ValueError("pursuit controller state mismatch")
        self.global_step = int(state.get("global_step", 0))
        self.retention_tax = float(state.get("retention_tax", 0))
        self.last_thread = str(state["last_thread"]) if state.get("last_thread") is not None else None
        self.last_sequence_index = (
            int(state["last_sequence_index"])
            if state.get("last_sequence_index") is not None else None
        )
        self.records = {str(k): Stat(**dict(v)) for k, v in dict(state.get("records", {})).items()}
        self.domains = {str(k): Stat(**dict(v)) for k, v in dict(state.get("domains", {})).items()}
        self.threads = {str(k): Stat(**dict(v)) for k, v in dict(state.get("threads", {})).items()}
        self.affordances = {str(k): Stat(**dict(v)) for k, v in dict(state.get("affordances", {})).items()}
