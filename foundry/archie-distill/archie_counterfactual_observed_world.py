#!/usr/bin/env python3
"""Fully observed world generator and entrypoint for the counterfactual state probe.

The underlying probe engine is reusable, but its scientific run must begin from a
known zero world. This module supplies that stricter generator and installs it
before optimization or evaluation so no target depends on hidden initialization.
"""
from __future__ import annotations

import random

import torch

import archie_counterfactual_state_probe as engine


def generate_observed_twins(
    *, cfg: engine.ProbeConfig, pairs: int, events: int, seed: int,
) -> engine.TwinBatch:
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
        initial = [0 for _ in range(cfg.objects)]
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
            op_id = rng.randrange(len(engine.OPS))
            operand = rng.randrange(cfg.values)
            if index == intervention:
                pre_value = world[obj]
            world[obj] = engine.apply_op(world[obj], op_id, operand, cfg.values)
            objects.append(obj)
            operations.append(op_id)
            operands.append(operand)

        answer_a = world[query]
        counter_operand = engine._different_operand(
            rng, operands[intervention], operations[intervention], pre_value, cfg.values
        )
        operands_b = list(operands)
        operands_b[intervention] = counter_operand
        world_b = list(initial)
        for obj, op_id, operand in zip(objects, operations, operands_b):
            world_b[obj] = engine.apply_op(world_b[obj], op_id, operand, cfg.values)
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

    return engine.TwinBatch(
        object_ids=torch.tensor(object_rows, dtype=torch.long),
        op_ids=torch.tensor(op_rows, dtype=torch.long),
        value_ids=torch.tensor(value_rows, dtype=torch.long),
        query_ids=torch.tensor(queries, dtype=torch.long),
        answers=torch.tensor(answers, dtype=torch.long),
        pair_ids=torch.tensor(pair_ids, dtype=torch.long),
        intervention_index=torch.tensor(intervention_indices, dtype=torch.long),
    )


# Every engine path resolves this global at call time, so both training and all
# evaluation horizons use the fully observed generator.
engine.generate_twins = generate_observed_twins


def main() -> None:
    engine.main()


if __name__ == "__main__":
    main()
