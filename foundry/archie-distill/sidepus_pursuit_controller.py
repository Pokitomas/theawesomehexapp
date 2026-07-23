#!/usr/bin/env python3
"""Checkpointable active curriculum controller for Sidepus pursuit."""
from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass, field
from typing import Any

from sidepus_pursuit_plan import deterministic_unit

CONTROLLER_SCHEMA = "sidepus-pursuit-controller-state/v1"


@dataclass
class Stat:
    count: int = 0
    loss_ema: float = 0.0
    progress_ema: float = 0.0
    state_utility_ema: float = 0.0
    surprise_ema: float = 0.0
    deliberation_ema: float = 1.0

    def update(self, *, loss: float, state_utility: float, deliberation: float, alpha: float) -> None:
        previous = self.loss_ema if self.count else loss
        progress = previous - loss
        if not self.count:
            self.loss_ema, self.state_utility_ema, self.deliberation_ema = loss, state_utility, deliberation
        else:
            old_loss = self.loss_ema
            self.loss_ema = (1 - alpha) * self.loss_ema + alpha * loss
            self.progress_ema = (1 - alpha) * self.progress_ema + alpha * progress
            self.state_utility_ema = (1 - alpha) * self.state_utility_ema + alpha * state_utility
            self.surprise_ema = (1 - alpha) * self.surprise_ema + alpha * (loss - old_loss)
            self.deliberation_ema = (1 - alpha) * self.deliberation_ema + alpha * deliberation
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
    retention_tax_weight: float = 2.0
    global_step: int = 0
    retention_tax: float = 0.0
    records: dict[str, Stat] = field(default_factory=dict)
    domains: dict[str, Stat] = field(default_factory=dict)

    @staticmethod
    def _stat(table: dict[str, Stat], key: str) -> Stat:
        if key not in table:
            table[key] = Stat()
        return table[key]

    def score(self, row: Mapping[str, Any]) -> float:
        record_id, domain = str(row["record_id"]), str(row.get("primary_domain", "unknown"))
        record, domain_stat = self.records.get(record_id, Stat()), self.domains.get(domain, Stat())
        novelty, fairness = 1 / math.sqrt(record.count + 1), 1 / math.sqrt(domain_stat.count + 1)
        surprise = max(0.0, record.surprise_ema, domain_stat.surprise_ema)
        progress = max(0.0, record.progress_ema, domain_stat.progress_ema)
        utility = max(0.0, record.state_utility_ema, domain_stat.state_utility_ema)
        jitter = deterministic_unit(self.seed, "pursuit", self.global_step, row["intent_id"]) * 1e-6
        return (
            self.surprise_weight * surprise + self.progress_weight * progress
            + self.novelty_weight * novelty + self.state_utility_weight * utility
            + self.difficulty_weight * float(row.get("difficulty_prior", 0.25))
            + self.fairness_weight * fairness - self.retention_tax_weight * self.retention_tax + jitter
        )

    def choose(self, rows: Sequence[Mapping[str, Any]], count: int) -> list[int]:
        if count < 1 or count > len(rows):
            raise ValueError("invalid pursuit selection count")
        return sorted(range(len(rows)), key=lambda i: (self.score(rows[i]), -i), reverse=True)[:count]

    def feedback(
        self, rows: Sequence[Mapping[str, Any]], *, loss: float, state_utility: float,
        deliberation: float, retention_tax: float | None = None,
    ) -> None:
        for row in rows:
            record_id, domain = str(row["record_id"]), str(row.get("primary_domain", "unknown"))
            self._stat(self.records, record_id).update(
                loss=loss, state_utility=state_utility, deliberation=deliberation, alpha=self.alpha
            )
            self._stat(self.domains, domain).update(
                loss=loss, state_utility=state_utility, deliberation=deliberation, alpha=self.alpha
            )
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
            "schema": CONTROLLER_SCHEMA, "seed": self.seed, "alpha": self.alpha,
            "global_step": self.global_step, "retention_tax": self.retention_tax,
            "records": {key: asdict(value) for key, value in self.records.items()},
            "domains": {key: asdict(value) for key, value in self.domains.items()},
        }

    def load_state_dict(self, state: Mapping[str, Any]) -> None:
        if state.get("schema") != CONTROLLER_SCHEMA or int(state.get("seed", -1)) != self.seed:
            raise ValueError("pursuit controller state mismatch")
        self.global_step, self.retention_tax = int(state.get("global_step", 0)), float(state.get("retention_tax", 0))
        self.records = {str(k): Stat(**dict(v)) for k, v in dict(state.get("records", {})).items()}
        self.domains = {str(k): Stat(**dict(v)) for k, v in dict(state.get("domains", {})).items()}
