#!/usr/bin/env python3
"""CLI for Sidepus extraction, developmental compilation, and verification."""
from __future__ import annotations

import argparse
import json
import pathlib

from .development import compile_program, validate_program, verify_compilation
from .extraction import export_developmental_inventory, verify_inventory


def print_json(value: object) -> None:
    print(json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False))


def parser() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(description=__doc__)
    sub = cli.add_subparsers(dest="command", required=True)

    validate = sub.add_parser("validate-program")
    validate.add_argument("--program", required=True)

    extract = sub.add_parser("extract-warc-inventory")
    extract.add_argument("--state-dir", required=True)
    extract.add_argument("--output", required=True)
    extract.add_argument("--rights-manifest")
    extract.add_argument("--maximum-records", type=int, default=1_000_000)
    extract.add_argument("--maximum-payload-bytes", type=int, default=64 << 20)

    verify_extract = sub.add_parser("verify-inventory")
    verify_extract.add_argument("--receipt", required=True)

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
    if args.command == "extract-warc-inventory":
        print_json(export_developmental_inventory(
            state_dir=pathlib.Path(args.state_dir),
            output=pathlib.Path(args.output),
            rights_manifest=(pathlib.Path(args.rights_manifest) if args.rights_manifest else None),
            maximum_records=args.maximum_records,
            maximum_payload_bytes=args.maximum_payload_bytes,
        ))
        return
    if args.command == "verify-inventory":
        result = verify_inventory(pathlib.Path(args.receipt))
        print_json(result)
        if not result["passed"]:
            raise SystemExit(1)
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
