#!/usr/bin/env python3
"""CLI for Sidepus developmental corpus compilation and verification."""
from __future__ import annotations

import argparse
import json
import pathlib

from .development import compile_program, validate_program, verify_compilation


def print_json(value: object) -> None:
    print(json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False))


def parser() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(description=__doc__)
    sub = cli.add_subparsers(dest="command", required=True)

    validate = sub.add_parser("validate-program")
    validate.add_argument("--program", required=True)

    compile_command = sub.add_parser("compile")
    compile_command.add_argument("--program", required=True)
    compile_command.add_argument("--content-policy", required=True)
    compile_command.add_argument("--inventory", action="append", required=True)
    compile_command.add_argument("--output-dir", required=True)

    verify = sub.add_parser("verify")
    verify.add_argument("--receipt", required=True)
    return cli


def main() -> None:
    args = parser().parse_args()
    if args.command == "validate-program":
        program = json.loads(pathlib.Path(args.program).resolve().read_text(encoding="utf-8"))
        print_json(validate_program(program))
        return
    if args.command == "compile":
        print_json(compile_program(
            program_path=pathlib.Path(args.program),
            content_policy_path=pathlib.Path(args.content_policy),
            inventory_paths=[pathlib.Path(path) for path in args.inventory],
            output_dir=pathlib.Path(args.output_dir),
        ))
        return
    if args.command == "verify":
        result = verify_compilation(pathlib.Path(args.receipt))
        print_json(result)
        if not result["passed"]:
            raise SystemExit(1)
        return
    raise AssertionError(args.command)


if __name__ == "__main__":
    main()
