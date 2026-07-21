from __future__ import annotations

import argparse
import json
import pathlib
from typing import Any

from . import collect as collect_module
from . import evaluate as evaluate_module
from . import train as train_module
from .core import SCHEMA_SELECTION, read_json, select_best, sha256_text, stable_json, write_json


def _select(args: Any) -> dict[str, Any]:
    receipts = [read_json(pathlib.Path(path).resolve()) for path in args.receipts]
    winner = select_best(receipts, minimum_score=float(args.minimum_score))
    selection = {
        "schema": SCHEMA_SELECTION,
        "minimum_score": float(args.minimum_score),
        "candidate_receipt_digests": [receipt.get("receipt_digest") for receipt in receipts],
        "winner": {
            "evaluation_receipt_digest": winner.get("receipt_digest"),
            "adapter": winner.get("adapter"),
            "metrics": winner.get("metrics"),
            "generated_tokens": winner.get("generated_tokens"),
        },
        "promotion": "not-admitted",
    }
    selection["receipt_digest"] = sha256_text(stable_json(selection))
    write_json(pathlib.Path(args.output).resolve(), selection)
    return selection


def main() -> None:
    parser = argparse.ArgumentParser(prog="archie-distill")
    subparsers = parser.add_subparsers(dest="command", required=True)

    collect_parser = subparsers.add_parser("collect", help="Collect final-answer supervision")
    collect_module.configure_parser(collect_parser)
    collect_parser.set_defaults(handler=collect_module.run_from_args)

    train_parser = subparsers.add_parser("train", help="Train a CUDA-only QLoRA adapter")
    train_module.configure_parser(train_parser)
    train_parser.set_defaults(handler=train_module.run_from_args)

    evaluate_parser = subparsers.add_parser("evaluate", help="Evaluate one adapter")
    evaluate_module.configure_parser(evaluate_parser)
    evaluate_parser.set_defaults(handler=evaluate_module.run_from_args)

    select_parser = subparsers.add_parser("select", help="Select the best eligible evaluation receipt")
    select_parser.add_argument("--receipts", nargs="+", required=True)
    select_parser.add_argument("--minimum-score", type=float, default=0.0)
    select_parser.add_argument("--output", required=True)
    select_parser.set_defaults(handler=_select)

    args = parser.parse_args()
    print(json.dumps(args.handler(args), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
