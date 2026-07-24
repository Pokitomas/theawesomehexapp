#!/usr/bin/env python3
"""Runtime for an admitted Archie instrument pack.

The downstream caller receives only numeric consequence and intervention scores.
Program genealogy and search metadata are not part of the scoring interface.
"""
from __future__ import annotations

import argparse
import json
import pathlib
from typing import Any, Mapping

import numpy as np

from archie_instrument_core import Program, evaluate_program


def program_from_json(value: Mapping[str, Any]) -> Program:
    return Program(
        op=str(value["op"]),
        args=tuple(program_from_json(arg) for arg in value.get("args", [])),
        value=value.get("value"),
    )


class InstrumentRuntime:
    def __init__(self, pack: Mapping[str, Any]) -> None:
        if pack.get("schema") != "archie-instrument-pack/v1":
            raise ValueError("unsupported instrument pack")
        self.programs = [program_from_json(row["program"]) for row in pack.get("programs", [])]
        runtime = dict(pack["runtime"])
        self.base_names = tuple(str(name) for name in runtime["base_names"])
        self.mean = np.asarray(runtime["feature_mean"], dtype=np.float64)
        self.std = np.asarray(runtime["feature_std"], dtype=np.float64)
        self.counterfactual = np.asarray(runtime["counterfactual_coefficients"], dtype=np.float64)
        self.intervention = np.asarray(runtime["intervention_coefficients"], dtype=np.float64)
        expected = len(self.base_names) + len(self.programs)
        if not all(array.shape == (expected,) for array in (
            self.mean, self.std, self.counterfactual, self.intervention
        )):
            raise ValueError("instrument pack dimensions disagree")

    @classmethod
    def load(cls, path: str | pathlib.Path) -> "InstrumentRuntime":
        return cls(json.loads(pathlib.Path(path).read_text(encoding="utf-8")))

    def score(self, primitive: Mapping[str, np.ndarray | list[float]]) -> dict[str, np.ndarray]:
        arrays = {name: np.asarray(value, dtype=np.float64) for name, value in primitive.items()}
        if not arrays:
            raise ValueError("primitive map is empty")
        lengths = {array.shape for array in arrays.values()}
        if len(lengths) != 1 or next(iter(lengths)).__len__() != 1:
            raise ValueError("primitive arrays must share one vector shape")
        base = np.stack([arrays[name] for name in self.base_names], axis=1)
        columns = [base]
        if self.programs:
            columns.append(np.stack([evaluate_program(program, arrays) for program in self.programs], axis=1))
        features = np.concatenate(columns, axis=1)
        normalized = (features - self.mean) / self.std
        return {
            "counterfactual_consequence": normalized @ self.counterfactual,
            "intervention_score": normalized @ self.intervention,
        }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pack", required=True)
    parser.add_argument("--primitive-json", required=True)
    args = parser.parse_args()
    primitive = json.loads(pathlib.Path(args.primitive_json).read_text(encoding="utf-8"))
    result = InstrumentRuntime.load(args.pack).score(primitive)
    print(json.dumps({key: value.tolist() for key, value in result.items()}, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
