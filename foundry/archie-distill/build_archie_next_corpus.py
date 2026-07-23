#!/usr/bin/env python3
"""Build source-separated raw, reconstruction, and protocol corpora for Archie."""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import random
import tempfile
import unicodedata
from collections.abc import Iterable
from typing import Any

from archie_hybrid_corpus import (
    atomic_json, build_u16_corpus, iter_local_documents, sha256_file, stable_json,
)
from archie_hybrid_core import ByteTokenizer
from archie_tokenizers import learn_pair_tokenizer
from sidepus_broad_diet import compile_lock, freeze_plan, initial_plan, load_sidepus_export

SCHEMA = "archie-structured-next-corpus/v1"
EXCHANGE_SCHEMA = "archie-curriculum-exchange/v1"
CODE_SUFFIXES = {
    ".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".html", ".css",
    ".scss", ".sql", ".java", ".kt", ".go", ".rs", ".c", ".h", ".cpp",
    ".hpp", ".cs", ".rb", ".php", ".swift", ".scala", ".lua", ".ex", ".exs",
    ".sh", ".bash", ".json", ".jsonl", ".yaml", ".yml", ".toml",
}


def digest_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest()


def source_label(root: pathlib.Path, source: pathlib.Path) -> str:
    base = root if root.is_dir() else root.parent
    try:
        relative = source.relative_to(base)
    except ValueError:
        relative = pathlib.Path(source.name)
    return f"{root.name}/{relative.as_posix()}"


def collect_documents(
    roots: list[pathlib.Path], *, development_percent: int, max_file_bytes: int,
    max_document_chars: int, file_class: str,
) -> list[dict[str, Any]]:
    documents = []
    for root in roots:
        for source_name, raw_text in iter_local_documents([root], max_file_bytes):
            source = pathlib.Path(source_name)
            if file_class == "code" and source.suffix.lower() not in CODE_SUFFIXES:
                continue
            text = raw_text[:max_document_chars]
            label = source_label(root, source)
            identity = digest_text(label + "\0" + text)
            documents.append(
                {
                    "id": identity,
                    "source": label,
                    "split": (
                        "development"
                        if int(identity[:8], 16) % 100 < development_percent else "train"
                    ),
                    "sha256": digest_text(text),
                    "dedupe_sha256": digest_text(
                        " ".join(unicodedata.normalize("NFKC", text).casefold().split())
                    ),
                    "characters": len(text),
                    "bytes": len(text.encode("utf-8", errors="replace")),
                    "text": text,
                    "origin": "local",
                }
            )
    return documents


def collect_sidepus_documents(
    exports: list[pathlib.Path], *, development_percent: int,
    max_document_chars: int, file_class: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    documents = []
    evidence = []
    for export in sorted({path.resolve() for path in exports}, key=str):
        rows, receipt = load_sidepus_export(export)
        evidence.append(receipt)
        for row in rows:
            source = row["source"]
            logical = str(
                source.get("member_path") or source.get("logical_path")
                or row["document_id"]
            )
            suffix = pathlib.PurePosixPath(logical).suffix
            if (
                file_class == "code"
                and source.get("modality") != "code"
                and suffix.lower() not in CODE_SUFFIXES
            ):
                continue
            text = str(row["text"])
            if len(text) > max_document_chars + (256 << 10):
                raise ValueError(
                    f"Sidepus document {row['document_id']} exceeds the corpus document limit"
                )
            source_id = str(source.get("source_id") or "unknown")
            modality = str(source.get("modality") or "unknown")
            stem = pathlib.PurePosixPath(logical).stem or "observation"
            label = (
                f"sidepus/{source_id}/{modality}/{stem}."
                f"{row['document_id'][-12:]}{suffix or '.txt'}"
            )
            identity = digest_text(label + "\0" + text)
            documents.append(
                {
                    "id": identity,
                    "source": label,
                    "split": (
                        "development"
                        if int(identity[:8], 16) % 100 < development_percent else "train"
                    ),
                    "sha256": digest_text(text),
                    "dedupe_sha256": str(
                        (
                            row["selection"].get("raw_content_sha256")
                            if modality in {"image", "audio", "video", "binary"}
                            else None
                        )
                        or row["selection"].get("normalized_text_sha256")
                        or digest_text(
                            " ".join(
                                unicodedata.normalize("NFKC", text).casefold().split()
                            )
                        )
                    ),
                    "characters": len(text),
                    "bytes": len(text.encode("utf-8", errors="replace")),
                    "text": text,
                    "origin": "sidepus",
                    "sidepus_document_id": row["document_id"],
                    "sidepus_manifest_digest": receipt["manifest_digest"],
                }
            )
    return documents, evidence


def collect_training_documents(
    roots: list[pathlib.Path], sidepus_exports: list[pathlib.Path], *,
    development_percent: int, max_file_bytes: int, max_document_chars: int,
    file_class: str,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    local = collect_documents(
        roots, development_percent=development_percent,
        max_file_bytes=max_file_bytes, max_document_chars=max_document_chars,
        file_class=file_class,
    )
    sidepus, sidepus_evidence = collect_sidepus_documents(
        sidepus_exports, development_percent=development_percent,
        max_document_chars=max_document_chars, file_class=file_class,
    )
    retained = []
    seen = {}
    dropped = []
    for document in sorted(
        [*local, *sidepus], key=lambda item: (item["source"], item["id"])
    ):
        key = document["dedupe_sha256"]
        if key in seen:
            dropped.append(
                {
                    "source": document["source"],
                    "duplicate_of": seen[key],
                    "normalized_sha256": key,
                }
            )
            continue
        seen[key] = document["source"]
        retained.append(document)
    if len(retained) < 2:
        raise SystemExit("structured corpus requires at least two deduplicated documents")
    if not any(item["split"] == "development" for item in retained):
        retained[-1]["split"] = "development"
    if not any(item["split"] == "train" for item in retained):
        retained[0]["split"] = "train"
    return retained, {
        "local_candidates": len(local),
        "sidepus_candidates": len(sidepus),
        "retained": len(retained),
        "cross_source_duplicates": len(dropped),
        "dropped_sha256": digest_text(
            json.dumps(dropped, sort_keys=True, separators=(",", ":"))
        ),
        "sidepus": sidepus_evidence,
    }


def inventory_projection(documents: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(
        [
            {
                "id": item["id"], "source": item["source"], "split": item["split"],
                "sha256": item["sha256"], "characters": item["characters"],
                "bytes": item["bytes"],
            }
            for item in documents
        ],
        key=lambda item: item["id"],
    )


def inventory_digest(documents: list[dict[str, Any]]) -> str:
    return digest_text(json.dumps(inventory_projection(documents), sort_keys=True, separators=(",", ":")))


def load_curriculum_exchange(
    path: pathlib.Path, documents: list[dict[str, Any]],
) -> tuple[dict[str, Any], dict[str, int]]:
    exchange = json.loads(path.read_text(encoding="utf-8"))
    if exchange.get("schema") != EXCHANGE_SCHEMA:
        raise ValueError("unsupported curriculum exchange")
    claimed_digest = str(exchange.get("contract_digest", ""))
    digest_body = {key: value for key, value in exchange.items() if key != "contract_digest"}
    if hashlib.sha256(stable_json(digest_body).encode()).hexdigest() != claimed_digest:
        raise ValueError("curriculum exchange contract digest is invalid")
    observed_inventory = inventory_digest(documents)
    if exchange.get("inventory_sha256") != observed_inventory:
        raise ValueError("curriculum exchange does not match the source inventory")
    selections = exchange.get("document_focus")
    if not isinstance(selections, list):
        raise ValueError("curriculum exchange requires document_focus")
    repeats: dict[str, int] = {}
    known = {item["id"]: item for item in documents}
    for selection in selections:
        identity = str(selection.get("id", ""))
        if identity not in known or identity in repeats:
            raise ValueError("curriculum exchange contains an unknown or duplicate document")
        extra = selection.get("extra_repeats")
        if isinstance(extra, bool) or not isinstance(extra, int) or not 0 <= extra <= 16:
            raise ValueError("curriculum extra_repeats must be an integer in [0, 16]")
        if known[identity]["split"] != "train" and extra:
            raise ValueError("development documents cannot receive curriculum focus")
        repeats[identity] = extra
    if set(repeats) != set(known):
        raise ValueError("curriculum exchange must account for every source document")
    return exchange, repeats


def span_task(label: str, text: str, document_digest: str, index: int) -> str | None:
    if len(text) < 96:
        return None
    target_length = min(192, max(48, len(text) // 12))
    maximum = max(0, len(text) - target_length)
    task_seed = digest_text(f"{document_digest}:{index}")
    rng = random.Random(int(task_seed[:16], 16))
    start = rng.randint(0, maximum)
    end = start + target_length
    prefix = text[max(0, start - 384) : start]
    target = text[start:end]
    suffix = text[end : end + 384]
    return (
        '<archie:task kind="restore_span">\n'
        f"<source>{label}</source>\n"
        f"<prefix>{prefix}</prefix>\n"
        f"<suffix>{suffix}</suffix>\n"
        "<instruction>Recover the exact missing span. Emit only the recovered bytes.</instruction>\n"
        f"<archie:response>{target}</archie:response>\n"
        "</archie:task>"
    )


def receipt_task(label: str, text: str, document_digest: str) -> str:
    suffix = pathlib.Path(label).suffix.lower() or "none"
    receipt = {
        "artifact": label,
        "bytes": len(text.encode("utf-8", errors="replace")),
        "content_sha256": document_digest,
        "kind": suffix,
        "protocol": ["OBSERVE", "VERIFY", "STOP"],
        "claim": "artifact identity only",
    }
    return (
        '<archie:task kind="artifact_receipt">\n'
        f"<input>{json.dumps({'artifact': label, 'kind': suffix}, sort_keys=True)}</input>\n"
        "<instruction>Emit the deterministic provenance receipt for this governed artifact.</instruction>\n"
        f"<archie:response>{json.dumps(receipt, sort_keys=True)}</archie:response>\n"
        "</archie:task>"
    )


def document_records(
    label: str, text: str, span_tasks: int, record_mode: str
) -> list[tuple[str, str, str]]:
    document_digest = digest_text(text)
    if record_mode == "raw":
        return [(f"raw:{label}", "raw_document", text)]
    records = [
        (
            f"raw:{label}",
            "raw_document",
            (
                '<archie:document governed="true">\n'
                f"<source>{label}</source>\n"
                f"<sha256>{document_digest}</sha256>\n"
                f"<content>{text}</content>\n"
                "</archie:document>"
            ),
        ),
    ]
    records.append(
        (f"receipt:{label}", "artifact_receipt", receipt_task(label, text, document_digest))
    )
    for index in range(span_tasks):
        task = span_task(label, text, document_digest, index)
        if task:
            records.append((f"span-{index}:{label}", "restore_span", task))
    return records


def flatten(groups: Iterable[list[tuple[str, str, str]]]) -> list[tuple[str, str]]:
    records = [record for group in groups for record in group]
    records.sort(key=lambda item: digest_text(item[0]))
    return [(source, text) for source, _, text in records]


def build(args: argparse.Namespace) -> dict[str, Any]:
    roots = sorted({pathlib.Path(item).resolve() for item in args.source}, key=str)
    sidepus_exports = sorted(
        {pathlib.Path(item).resolve() for item in getattr(args, "sidepus_export", [])},
        key=str,
    )
    if not roots and not sidepus_exports:
        raise SystemExit("at least one --source or --sidepus-export is required")
    documents, ingestion = collect_training_documents(
        roots, sidepus_exports, development_percent=args.development_percent,
        max_file_bytes=args.max_file_bytes, max_document_chars=args.max_document_chars,
        file_class=args.file_class,
    )
    exchange_path = (
        pathlib.Path(args.curriculum_exchange).resolve()
        if getattr(args, "curriculum_exchange", None) else None
    )
    exchange = None
    repeats = {item["id"]: 0 for item in documents}
    if exchange_path is not None:
        exchange, repeats = load_curriculum_exchange(exchange_path, documents)
    train_groups: list[list[tuple[str, str, str]]] = []
    development_groups: list[list[tuple[str, str, str]]] = []
    kind_counts = {"train": {}, "development": {}}
    for document in documents:
        records = document_records(
            document["source"], document["text"], args.span_tasks_per_document,
            args.record_mode,
        )
        document["records"] = len(records)
        document["extra_repeats"] = repeats[document["id"]]
        target = development_groups if document["split"] == "development" else train_groups
        for _ in range(1 + repeats[document["id"]]):
            target.append(records)
            for _, kind, _ in records:
                counts = kind_counts[document["split"]]
                counts[kind] = counts.get(kind, 0) + 1
    output = pathlib.Path(args.output_dir).resolve()
    output.mkdir(parents=True, exist_ok=True)
    train_records = flatten(train_groups)
    development_records = flatten(development_groups)
    if args.tokenizer == "pairgram":
        tokenizer = learn_pair_tokenizer(
            (text for _, text in train_records), args.pair_vocab_size
        )
    else:
        tokenizer = ByteTokenizer()
    train_path = output / "train.u16"
    development_path = output / "development.u16"
    train_metadata = build_u16_corpus(
        train_path, train_records, max_tokens=args.max_train_tokens, tokenizer=tokenizer
    )
    development_metadata = build_u16_corpus(
        development_path, development_records,
        max_tokens=args.max_development_tokens, tokenizer=tokenizer
    )
    if exchange is not None and exchange_path is not None:
        train_metadata["curriculum_exchange_sha256"] = sha256_file(exchange_path)
        train_metadata["curriculum_contract_digest"] = exchange["contract_digest"]
        train_metadata["curriculum_student_model_sha256"] = exchange["student_model_sha256"]
        atomic_json(train_path.with_suffix(train_path.suffix + ".json"), train_metadata)
    manifest_documents = [
        {
            key: item[key]
            for key in (
                "id", "source", "split", "sha256", "characters", "bytes", "records",
                "extra_repeats",
            )
        }
        for item in documents
    ]
    manifest = {
        "schema": SCHEMA,
        "sources": [str(root) for root in roots],
        "sidepus_exports": [str(path) for path in sidepus_exports],
        "configuration": {
            "development_percent": args.development_percent,
            "span_tasks_per_document": args.span_tasks_per_document,
            "max_file_bytes": args.max_file_bytes,
            "max_document_characters": args.max_document_chars,
            "max_train_tokens": args.max_train_tokens,
            "max_development_tokens": args.max_development_tokens,
            "tokenizer": args.tokenizer,
            "pair_vocab_size": args.pair_vocab_size if args.tokenizer == "pairgram" else None,
            "record_mode": args.record_mode,
            "file_class": args.file_class,
            "curriculum_exchange": str(exchange_path) if exchange_path else None,
        },
        "documents": {
            "total": len(documents),
            "train": sum(item["split"] == "train" for item in documents),
            "development": sum(item["split"] == "development" for item in documents),
        },
        "record_counts": kind_counts,
        "ingestion": ingestion,
        "training": train_metadata,
        "development": development_metadata,
        "document_inventory_sha256": inventory_digest(documents),
        "realized_document_sha256": digest_text(
            json.dumps(manifest_documents, sort_keys=True, separators=(",", ":"))
        ),
        "curriculum_exchange": (
            {
                "path": str(exchange_path), "sha256": sha256_file(exchange_path),
                "contract_digest": exchange["contract_digest"],
                "student_model_sha256": exchange["student_model_sha256"],
                "base_training_bytes": exchange["allocation"]["base_training_bytes"],
                "granted_focus_bytes": exchange["allocation"]["granted_focus_bytes"],
            }
            if exchange is not None and exchange_path is not None else None
        ),
        "claim_boundary": (
            f"Record mode {args.record_mode}; "
            "development is split by source document, not by token window; learned tokenizer "
            "statistics come from training records only; curriculum focus only repeats training "
            "documents and never alters the development split."
        ),
    }
    atomic_json(output / "manifest.json", manifest)
    print(json.dumps(manifest, indent=2, sort_keys=True))
    return manifest


def selftest() -> None:
    with tempfile.TemporaryDirectory() as temporary:
        root = pathlib.Path(temporary)
        source = root / "source"
        source.mkdir()
        for index in range(40):
            (source / f"document-{index:02d}.md").write_text(
                (f"document {index} preserves evidence and restores missing spans\n" * 8),
                encoding="utf-8",
            )
        sidepus_plan = root / "sidepus-plan.json"
        atomic_json(sidepus_plan, initial_plan(source))
        sidepus_state = root / "sidepus-state"
        freeze_plan(sidepus_plan, sidepus_state)
        sidepus_export = root / "sidepus-export"
        compile_lock(sidepus_state / "source-lock.json", sidepus_export)
        args = argparse.Namespace(
            source=[str(source)], output_dir=str(root / "output"),
            development_percent=20, span_tasks_per_document=2,
            max_file_bytes=1 << 20, max_document_chars=1 << 20,
            max_train_tokens=None, max_development_tokens=None,
            tokenizer="pairgram", pair_vocab_size=320,
            record_mode="governed",
            file_class="all",
            curriculum_exchange=None,
            sidepus_export=[str(sidepus_export)],
        )
        manifest = build(args)
        assert manifest["documents"]["train"] > 0
        assert manifest["documents"]["development"] > 0
        assert manifest["training"]["sha256"] != manifest["development"]["sha256"]
        assert 260 < manifest["training"]["tokenizer"]["vocab_size"] <= 320
        assert manifest["training"]["tokenizer"] == manifest["development"]["tokenizer"]
        assert manifest["ingestion"]["sidepus_candidates"] == 40
        assert manifest["ingestion"]["sidepus"][0]["documents"] == 40
        print(json.dumps({"selftest": "passed", "schema": SCHEMA}, sort_keys=True))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir")
    parser.add_argument("--source", action="append", default=[])
    parser.add_argument("--sidepus-export", action="append", default=[])
    parser.add_argument("--development-percent", type=int, default=5)
    parser.add_argument("--span-tasks-per-document", type=int, default=3)
    parser.add_argument("--max-file-bytes", type=int, default=8 << 20)
    parser.add_argument("--max-document-chars", type=int, default=2 << 20)
    parser.add_argument("--max-train-tokens", type=int)
    parser.add_argument("--max-development-tokens", type=int)
    parser.add_argument("--tokenizer", choices=["byte", "pairgram"], default="byte")
    parser.add_argument("--pair-vocab-size", type=int, default=512)
    parser.add_argument("--record-mode", choices=["governed", "raw"], default="governed")
    parser.add_argument("--file-class", choices=["all", "code"], default="all")
    parser.add_argument("--curriculum-exchange")
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()
    if args.selftest:
        selftest()
        return
    if not args.output_dir:
        parser.error("--output-dir is required")
    if not 1 <= args.development_percent <= 50:
        parser.error("--development-percent must be between 1 and 50")
    if args.span_tasks_per_document < 0:
        parser.error("--span-tasks-per-document cannot be negative")
    if args.tokenizer == "pairgram" and not 260 <= args.pair_vocab_size <= 65_536:
        parser.error("--pair-vocab-size must be between 260 and 65536")
    build(args)


if __name__ == "__main__":
    main()
