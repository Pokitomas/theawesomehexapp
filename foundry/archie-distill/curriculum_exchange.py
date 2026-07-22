#!/usr/bin/env python3
"""Negotiate and settle model-directed Archie training curricula."""
from __future__ import annotations

import argparse
import hashlib
import heapq
import json
import math
import pathlib
import tempfile
import time
from collections import defaultdict
from dataclasses import asdict, replace
from typing import Any

import torch
import torch.nn.functional as F

from archie_hybrid_core import PAD_ID, ArchieHybridLM, ByteTokenizer, ModelConfig, PRESETS
from archie_hybrid_corpus import atomic_json, sha256_file, stable_json
from archie_tokenizers import token_byte_lengths, tokenizer_from_metadata
from build_archie_next_corpus import (
    CODE_SUFFIXES, EXCHANGE_SCHEMA, build, collect_training_documents, inventory_digest,
)

SETTLEMENT_SCHEMA = "archie-curriculum-settlement/v1"
LEDGER_SCHEMA = "archie-pursuit-ledger/v1"
DATA_SUFFIXES = {".json", ".jsonl", ".yaml", ".yml", ".toml", ".csv", ".tsv", ".sql"}
PROSE_SUFFIXES = {".md", ".txt", ".rst", ".adoc", ".tex"}


def domain_for(source: str) -> str:
    path = pathlib.PurePosixPath(source)
    parts = path.parts
    root = parts[0] if parts else "unknown"
    area = parts[1] if len(parts) > 2 else "root"
    suffix = path.suffix.lower()
    if suffix in DATA_SUFFIXES:
        medium = "data"
    elif suffix in PROSE_SUFFIXES:
        medium = "prose"
    elif suffix in CODE_SUFFIXES:
        medium = "code"
    else:
        medium = "other"
    return f"{root}/{area}/{medium}"


def load_ledger(path: pathlib.Path | None) -> dict[str, Any]:
    if path is None or not path.exists():
        return {"schema": LEDGER_SCHEMA, "round": 0, "domains": {}}
    ledger = json.loads(path.read_text(encoding="utf-8"))
    if ledger.get("schema") != LEDGER_SCHEMA or not isinstance(ledger.get("domains"), dict):
        raise ValueError("unsupported pursuit ledger")
    return ledger


def probe_slices(text: str, characters: int, count: int) -> list[str]:
    if len(text) <= characters:
        return [text]
    maximum = len(text) - characters
    positions = [0, maximum // 2, maximum]
    if count > 3:
        positions.extend(round(maximum * index / max(count - 1, 1)) for index in range(count))
    return [text[position : position + characters] for position in sorted(set(positions))[:count]]


def scoring_subset(
    documents: list[dict[str, Any]], maximum_documents: int,
) -> list[dict[str, Any]]:
    if maximum_documents <= 0 or len(documents) <= maximum_documents:
        return list(documents)
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for document in documents:
        grouped[domain_for(document["source"])].append(document)
    selected = []
    selected_ids = set()
    domains = sorted(grouped)
    base = maximum_documents // len(domains)
    remainder = maximum_documents % len(domains)
    for domain_index, domain in enumerate(domains):
        quota = base + (1 if domain_index < remainder else 0)
        if quota <= 0:
            continue
        members = grouped[domain]
        development = sorted(
            (item for item in members if item["split"] == "development"),
            key=lambda item: item["id"],
        )
        train = sorted(
            (item for item in members if item["split"] == "train"),
            key=lambda item: item["id"],
        )
        development_quota = min(len(development), max(1, quota // 2))
        chosen = development[:development_quota]
        chosen.extend(train[: max(0, quota - len(chosen))])
        if len(chosen) < quota:
            chosen.extend(
                development[
                    development_quota : development_quota + quota - len(chosen)
                ]
            )
        for document in chosen:
            if document["id"] not in selected_ids:
                selected.append(document)
                selected_ids.add(document["id"])
    if len(selected) < maximum_documents:
        remaining = sorted(
            (item for item in documents if item["id"] not in selected_ids),
            key=lambda item: item["id"],
        )
        selected.extend(remaining[: maximum_documents - len(selected)])
    return selected[:maximum_documents]


@torch.inference_mode()
def score_model(
    model_path: pathlib.Path, documents: list[dict[str, Any]], device: torch.device,
    batch_size: int, probe_tokens: int, probes_per_document: int,
    max_scored_documents: int,
) -> dict[str, Any]:
    payload = torch.load(model_path, map_location=device, weights_only=False)
    if payload.get("schema") != "archie-scratch-hybrid-model/v1":
        raise ValueError("unsupported Archie model")
    config = ModelConfig(**payload["config"])
    tokenizer_metadata = payload.get("tokenizer") or ByteTokenizer.metadata()
    tokenizer = tokenizer_from_metadata(tokenizer_metadata)
    model = ArchieHybridLM(config).to(device)
    model.load_state_dict(payload["model"])
    model.eval()
    byte_lengths = torch.tensor(token_byte_lengths(tokenizer_metadata), device=device)
    maximum_tokens = min(probe_tokens, config.max_seq_len)
    scored_documents = scoring_subset(documents, max_scored_documents)
    probes = []
    for document in scored_documents:
        characters = max(64, maximum_tokens * 3)
        for snippet in probe_slices(document["text"], characters, probes_per_document):
            encoded = tokenizer.encode(snippet, bos=True, eos=True)[:maximum_tokens]
            if len(encoded) >= 2:
                probes.append((document["id"], encoded))
    probes.sort(key=lambda item: (len(item[1]), item[0]))
    totals: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0, 0.0])
    for start in range(0, len(probes), batch_size):
        group = probes[start : start + batch_size]
        width = max(len(tokens) for _, tokens in group)
        batch = torch.full((len(group), width), PAD_ID, dtype=torch.long, device=device)
        for index, (_, tokens) in enumerate(group):
            batch[index, : len(tokens)] = torch.tensor(tokens, dtype=torch.long, device=device)
        logits = model(batch)["logits"][:, :-1].float()
        targets = batch[:, 1:]
        losses = F.cross_entropy(
            logits.reshape(-1, logits.size(-1)), targets.reshape(-1),
            ignore_index=PAD_ID, reduction="none",
        ).reshape_as(targets)
        valid = targets.ne(PAD_ID)
        represented_bytes = byte_lengths[targets]
        for index, (identity, _) in enumerate(group):
            mask = valid[index]
            totals[identity][0] += float(losses[index][mask].sum().cpu())
            totals[identity][1] += float(represented_bytes[index][mask].sum().cpu())
            totals[identity][2] += float(mask.sum().cpu())
    scores = {}
    for document in scored_documents:
        nats, bytes_, tokens = totals[document["id"]]
        scores[document["id"]] = {
            "bits_per_byte": nats / max(bytes_, 1.0) / math.log(2.0),
            "probe_bytes": int(bytes_), "probe_tokens": int(tokens), "sampled": True,
        }
    domain_fallback = {}
    global_fallback = weighted_mean([
        (scores[item["id"]]["bits_per_byte"], max(scores[item["id"]]["probe_bytes"], 1))
        for item in scored_documents
    ])
    for domain in sorted({domain_for(item["source"]) for item in documents}):
        members = [
            item for item in scored_documents if domain_for(item["source"]) == domain
        ]
        domain_fallback[domain] = (
            weighted_mean([
                (
                    scores[item["id"]]["bits_per_byte"],
                    max(scores[item["id"]]["probe_bytes"], 1),
                )
                for item in members
            ])
            if members else global_fallback
        )
    for document in documents:
        if document["id"] not in scores:
            scores[document["id"]] = {
                "bits_per_byte": domain_fallback[domain_for(document["source"])],
                "probe_bytes": 0,
                "probe_tokens": 0,
                "sampled": False,
            }
    result = {
        "model_sha256": sha256_file(model_path), "config": asdict(config),
        "tokenizer": tokenizer_metadata, "documents": scores,
        "sampling": {
            "documents_total": len(documents),
            "documents_scored": len(scored_documents),
            "maximum_documents": max_scored_documents,
            "method": "deterministic-domain-split-stratified",
        },
    }
    del model
    if device.type == "cuda":
        torch.cuda.empty_cache()
    return result


def weighted_mean(items: list[tuple[float, float]]) -> float:
    total = sum(weight for _, weight in items)
    return sum(value * weight for value, weight in items) / max(total, 1e-12)


def domain_metrics(
    documents: list[dict[str, Any]], current: dict[str, Any],
    parent: dict[str, Any] | None,
) -> dict[str, dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for document in documents:
        grouped[domain_for(document["source"])].append(document)
    metrics = {}
    for domain, members in sorted(grouped.items()):
        train = [item for item in members if item["split"] == "train"]
        development = [item for item in members if item["split"] == "development"]
        evidence = development or train
        train_current = weighted_mean([
            (current["documents"][item["id"]]["bits_per_byte"], item["bytes"])
            for item in train
        ])
        evidence_current = weighted_mean([
            (current["documents"][item["id"]]["bits_per_byte"], item["bytes"])
            for item in evidence
        ])
        evidence_parent = None
        if parent is not None:
            evidence_parent = weighted_mean([
                (parent["documents"][item["id"]]["bits_per_byte"], item["bytes"])
                for item in evidence
            ])
        metrics[domain] = {
            "train_documents": len(train), "development_documents": len(development),
            "train_bytes": sum(item["bytes"] for item in train),
            "evidence_split": "development" if development else "train-fallback",
            "student_train_bits_per_byte": train_current,
            "student_evidence_bits_per_byte": evidence_current,
            "parent_evidence_bits_per_byte": evidence_parent,
            "observed_learning_progress": (
                evidence_parent - evidence_current if evidence_parent is not None else 0.0
            ),
        }
    return {domain: value for domain, value in metrics.items() if value["train_documents"]}


def softmax_map(values: dict[str, float]) -> dict[str, float]:
    maximum = max(values.values())
    exponentials = {key: math.exp(min(value - maximum, 60.0)) for key, value in values.items()}
    total = sum(exponentials.values())
    return {key: value / total for key, value in exponentials.items()}


def positive_map(values: dict[str, float]) -> dict[str, float]:
    shifted = {key: max(value, 0.0) + 1e-6 for key, value in values.items()}
    total = sum(shifted.values())
    return {key: value / total for key, value in shifted.items()}


def cap_distribution(values: dict[str, float], maximum_share: float) -> dict[str, float]:
    if maximum_share * len(values) < 1.0 - 1e-9:
        raise ValueError("maximum domain share is impossible for this many domains")
    remaining = set(values)
    result = {key: 0.0 for key in values}
    remaining_mass = 1.0
    while remaining:
        denominator = sum(values[key] for key in remaining)
        capped = []
        for key in sorted(remaining):
            share = remaining_mass * values[key] / max(denominator, 1e-12)
            if share > maximum_share + 1e-12:
                result[key] = maximum_share
                remaining_mass -= maximum_share
                capped.append(key)
        if not capped:
            for key in remaining:
                result[key] = remaining_mass * values[key] / max(denominator, 1e-12)
            break
        remaining.difference_update(capped)
    return result


def allocate_focus(
    documents: list[dict[str, Any]], current: dict[str, Any], parent: dict[str, Any] | None,
    domain_shares: dict[str, float], focus_bytes: int, max_repeats: int,
) -> tuple[dict[str, int], dict[str, int]]:
    train = [item for item in documents if item["split"] == "train"]
    repeats = {item["id"]: 0 for item in documents}
    realized = {domain: 0 for domain in domain_shares}
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for document in train:
        score = current["documents"][document["id"]]["bits_per_byte"]
        progress = 0.0
        if parent is not None:
            progress = parent["documents"][document["id"]]["bits_per_byte"] - score
        grouped[domain_for(document["source"])].append(
            {
                **document,
                "selection_score": math.exp(-min(max(score, 0.0), 20.0))
                + max(progress, 0.0),
            }
        )
    for domain, share in sorted(domain_shares.items()):
        target = round(focus_bytes * share)
        members = grouped[domain]
        queue = [
            (-item["selection_score"], item["bytes"], item["id"], item)
            for item in members
        ]
        heapq.heapify(queue)
        while realized[domain] < target:
            if not queue:
                break
            _, _, _, selected = heapq.heappop(queue)
            repeats[selected["id"]] += 1
            realized[domain] += selected["bytes"]
            if repeats[selected["id"]] < max_repeats:
                priority = selected["selection_score"] / (
                    1.0 + repeats[selected["id"]]
                )
                heapq.heappush(
                    queue,
                    (-priority, selected["bytes"], selected["id"], selected),
                )
    return repeats, realized


def negotiate(args: argparse.Namespace) -> dict[str, Any]:
    roots = sorted({pathlib.Path(item).resolve() for item in args.source}, key=str)
    sidepus_exports = sorted(
        {pathlib.Path(item).resolve() for item in getattr(args, "sidepus_export", [])},
        key=str,
    )
    documents, ingestion = collect_training_documents(
        roots, sidepus_exports, development_percent=args.development_percent,
        max_file_bytes=args.max_file_bytes, max_document_chars=args.max_document_chars,
        file_class=args.file_class,
    )
    device = torch.device(
        args.device if args.device != "auto" else ("cuda" if torch.cuda.is_available() else "cpu")
    )
    student_path = pathlib.Path(args.student_model).resolve()
    current = score_model(
        student_path, documents, device, args.batch_size, args.probe_tokens,
        args.probes_per_document, args.max_scored_documents,
    )
    parent = None
    if args.parent_model:
        parent = score_model(
            pathlib.Path(args.parent_model).resolve(), documents, device, args.batch_size,
            args.probe_tokens, args.probes_per_document, args.max_scored_documents,
        )
        if parent["tokenizer"] != current["tokenizer"]:
            raise ValueError("parent and student tokenizers differ")
    ledger_path = pathlib.Path(args.ledger).resolve() if args.ledger else None
    ledger = load_ledger(ledger_path)
    metrics = domain_metrics(documents, current, parent)
    taste_logits = {}
    for domain, values in metrics.items():
        pursuit = float(ledger["domains"].get(domain, {}).get("pursuit_strength", 0.0))
        taste_logits[domain] = (
            -values["student_train_bits_per_byte"] / args.taste_temperature
            + args.persistence_weight * pursuit
        )
    student_bid = softmax_map(taste_logits)
    progress = positive_map({
        domain: values["observed_learning_progress"] for domain, values in metrics.items()
    })
    uniform = 1.0 / len(metrics)
    teacher_raw = {
        domain: (
            args.taste_weight * student_bid[domain]
            + args.progress_weight * progress[domain]
            + args.replay_weight * uniform
        )
        for domain in metrics
    }
    effective_max_domain_share = max(args.max_domain_share, 1.0 / len(metrics))
    teacher_offer = cap_distribution(teacher_raw, effective_max_domain_share)
    base_training_bytes = sum(
        document["bytes"] for document in documents if document["split"] == "train"
    )
    requested_focus_bytes = round(base_training_bytes * args.focus_fraction)
    repeats, realized = allocate_focus(
        documents, current, parent, teacher_offer, requested_focus_bytes, args.max_repeats,
    )
    granted_focus_bytes = sum(realized.values())
    focus_documents = []
    for document in sorted(documents, key=lambda item: item["id"]):
        identity = document["id"]
        focus_documents.append(
            {
                "id": identity, "source": document["source"], "split": document["split"],
                "domain": domain_for(document["source"]),
                "extra_repeats": repeats[identity],
                "student_bits_per_byte": current["documents"][identity]["bits_per_byte"],
                "parent_bits_per_byte": (
                    parent["documents"][identity]["bits_per_byte"] if parent else None
                ),
            }
        )
    contract = {
        "schema": EXCHANGE_SCHEMA,
        "student_model_sha256": current["model_sha256"],
        "parent_model_sha256": parent["model_sha256"] if parent else None,
        "tokenizer": current["tokenizer"],
        "inventory_sha256": inventory_digest(documents),
        "sources": [str(root) for root in roots],
        "sidepus_exports": [str(path) for path in sidepus_exports],
        "ingestion": ingestion,
        "scan": {
            "development_percent": args.development_percent,
            "max_file_bytes": args.max_file_bytes,
            "max_document_characters": args.max_document_chars,
            "file_class": args.file_class,
        },
        "scoring": {
            "probe_tokens": args.probe_tokens,
            "probes_per_document": args.probes_per_document,
            "max_scored_documents": args.max_scored_documents,
            "sampling": {
                "student": current["sampling"],
                "parent": parent["sampling"] if parent else None,
            },
            "taste_temperature": args.taste_temperature,
            "taste_weight": args.taste_weight,
            "progress_weight": args.progress_weight,
            "replay_weight": args.replay_weight,
            "persistence_weight": args.persistence_weight,
            "device": str(device),
        },
        "domains": {
            domain: {
                **values,
                "student_requested_focus_share": student_bid[domain],
                "teacher_offered_focus_share": teacher_offer[domain],
                "requested_focus_bytes": round(requested_focus_bytes * student_bid[domain]),
                "granted_focus_bytes": realized[domain],
            }
            for domain, values in metrics.items()
        },
        "allocation": {
            "base_training_bytes": base_training_bytes,
            "requested_focus_bytes": requested_focus_bytes,
            "granted_focus_bytes": granted_focus_bytes,
            "focus_fraction": args.focus_fraction,
            "max_domain_share": args.max_domain_share,
            "effective_max_domain_share": effective_max_domain_share,
            "max_repeats_per_document": args.max_repeats,
            "bargain": (
                "The student requests focus from its own probability taste and accumulated pursuit; "
                "the teacher prices the request with frozen-split learning progress and broad replay."
            ),
            "settlement_required": True,
        },
        "document_focus": focus_documents,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "claim_boundary": (
            "Model taste controls a bounded focus supplement; every source retains one baseline "
            "training occurrence and development documents are never repeated."
        ),
    }
    contract["contract_digest"] = hashlib.sha256(stable_json(contract).encode()).hexdigest()
    output = pathlib.Path(args.output).resolve()
    atomic_json(output, contract)
    print(json.dumps(contract, indent=2, sort_keys=True))
    return contract


def settle(args: argparse.Namespace) -> dict[str, Any]:
    contract_path = pathlib.Path(args.contract).resolve()
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    if contract.get("schema") != EXCHANGE_SCHEMA:
        raise ValueError("unsupported curriculum exchange")
    digest_body = {key: value for key, value in contract.items() if key != "contract_digest"}
    if hashlib.sha256(stable_json(digest_body).encode()).hexdigest() != contract.get("contract_digest"):
        raise ValueError("curriculum exchange contract digest is invalid")
    roots = [pathlib.Path(item).resolve() for item in contract["sources"]]
    sidepus_exports = [
        pathlib.Path(item).resolve() for item in contract.get("sidepus_exports", [])
    ]
    scan = contract["scan"]
    documents, _ = collect_training_documents(
        roots, sidepus_exports, development_percent=int(scan["development_percent"]),
        max_file_bytes=int(scan["max_file_bytes"]),
        max_document_chars=int(scan["max_document_characters"]),
        file_class=str(scan["file_class"]),
    )
    expected_sources = {item["source"] for item in contract["document_focus"]}
    documents = [item for item in documents if item["source"] in expected_sources]
    if inventory_digest(documents) != contract["inventory_sha256"]:
        raise ValueError("source inventory changed before curriculum settlement")
    device = torch.device(
        args.device if args.device != "auto" else ("cuda" if torch.cuda.is_available() else "cpu")
    )
    scoring = contract["scoring"]
    after = score_model(
        pathlib.Path(args.after_model).resolve(), documents, device, args.batch_size,
        int(scoring["probe_tokens"]), int(scoring["probes_per_document"]),
        int(scoring.get("max_scored_documents", 4096)),
    )
    if after["tokenizer"] != contract["tokenizer"]:
        raise ValueError("settlement model tokenizer differs from the bargained student")
    training_receipt_sha256 = None
    if args.training_receipt:
        receipt_path = pathlib.Path(args.training_receipt).resolve()
        training_receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        if training_receipt.get("model", {}).get("export_sha256") != after["model_sha256"]:
            raise ValueError("training receipt does not identify the settlement model")
        corpus = training_receipt.get("corpus", {})
        if corpus.get("curriculum_contract_digest") != contract["contract_digest"]:
            raise ValueError("training receipt did not consume this curriculum exchange")
        if training_receipt.get("model", {}).get("initialized_from_sha256") != contract["student_model_sha256"]:
            raise ValueError("training receipt began from a different student")
        training_receipt_sha256 = sha256_file(receipt_path)
    by_domain: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for document in documents:
        by_domain[domain_for(document["source"])].append(document)
    outcomes = {}
    ledger_path = pathlib.Path(args.ledger).resolve() if args.ledger else None
    previous = load_ledger(ledger_path)
    next_domains = dict(previous["domains"])
    for domain, terms in contract["domains"].items():
        evidence = [item for item in by_domain[domain] if item["split"] == "development"]
        if not evidence:
            evidence = [item for item in by_domain[domain] if item["split"] == "train"]
        after_bpb = weighted_mean([
            (after["documents"][item["id"]]["bits_per_byte"], item["bytes"])
            for item in evidence
        ])
        before_bpb = float(terms["student_evidence_bits_per_byte"])
        gain = before_bpb - after_bpb
        focus_share = float(terms["teacher_offered_focus_share"])
        prior_balance = float(next_domains.get(domain, {}).get("credit_balance", 0.0))
        earned = 100.0 * focus_share * gain
        balance = 0.8 * prior_balance + earned
        next_domains[domain] = {
            "credit_balance": balance,
            "pursuit_strength": math.tanh(balance),
            "last_evidence_gain_bits_per_byte": gain,
            "last_student_taste_share": terms["student_requested_focus_share"],
            "last_teacher_offer_share": focus_share,
            "rounds": int(next_domains.get(domain, {}).get("rounds", 0)) + 1,
        }
        outcomes[domain] = {
            "before_bits_per_byte": before_bpb,
            "after_bits_per_byte": after_bpb,
            "gain_bits_per_byte": gain,
            "teacher_offered_focus_share": focus_share,
            "earned_credit": earned,
            "credit_balance": balance,
        }
    ledger = {
        "schema": LEDGER_SCHEMA,
        "round": int(previous.get("round", 0)) + 1,
        "model_sha256": after["model_sha256"],
        "domains": dict(sorted(next_domains.items())),
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    ledger["ledger_digest"] = hashlib.sha256(stable_json(ledger).encode()).hexdigest()
    if ledger_path is not None:
        atomic_json(ledger_path, ledger)
    settlement = {
        "schema": SETTLEMENT_SCHEMA,
        "contract_sha256": sha256_file(contract_path),
        "contract_digest": contract["contract_digest"],
        "before_model_sha256": contract["student_model_sha256"],
        "after_model_sha256": after["model_sha256"],
        "training_receipt_sha256": training_receipt_sha256,
        "inventory_sha256": contract["inventory_sha256"],
        "domains": outcomes,
        "mean_evidence_gain_bits_per_byte": weighted_mean([
            (item["gain_bits_per_byte"], max(item["teacher_offered_focus_share"], 1e-9))
            for item in outcomes.values()
        ]),
        "ledger_digest": ledger["ledger_digest"],
        "promotion": "curriculum-settlement-only",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    settlement["receipt_digest"] = hashlib.sha256(stable_json(settlement).encode()).hexdigest()
    atomic_json(pathlib.Path(args.output).resolve(), settlement)
    print(json.dumps(settlement, indent=2, sort_keys=True))
    return settlement


def selftest() -> None:
    with tempfile.TemporaryDirectory() as temporary:
        root = pathlib.Path(temporary)
        source = root / "source"
        for area in ("sound", "vision", "systems"):
            directory = source / area
            directory.mkdir(parents=True)
            for index in range(8):
                (directory / f"example-{index}.md").write_text(
                    (f"{area} mechanism {index} preserves evidence and transfers structure\n" * 12),
                    encoding="utf-8",
                )
        parent_config = replace(PRESETS["micro"], max_seq_len=128)
        parent_model = ArchieHybridLM(parent_config)
        student_model = ArchieHybridLM(parent_config)
        student_model.load_state_dict(parent_model.state_dict())
        with torch.no_grad():
            student_model.token_embedding.weight.add_(0.0001)
        parent_path, student_path = root / "parent.pt", root / "student.pt"
        for path, model in ((parent_path, parent_model), (student_path, student_model)):
            torch.save(
                {
                    "schema": "archie-scratch-hybrid-model/v1",
                    "config": asdict(parent_config), "model": model.state_dict(),
                    "tokenizer": ByteTokenizer.metadata(),
                },
                path,
            )
        contract_path = root / "exchange.json"
        contract = negotiate(
            argparse.Namespace(
                source=[str(source)], student_model=str(student_path),
                parent_model=str(parent_path), output=str(contract_path), ledger=None,
                development_percent=25, max_file_bytes=1 << 20,
                max_document_chars=1 << 20, file_class="all", device="cpu",
                batch_size=4, probe_tokens=64, probes_per_document=2,
                taste_temperature=0.5, taste_weight=0.65, progress_weight=0.25,
                replay_weight=0.10, persistence_weight=0.25, focus_fraction=0.5,
                max_domain_share=0.6, max_repeats=3,
                sidepus_export=[],
                max_scored_documents=12,
            )
        )
        assert contract["allocation"]["granted_focus_bytes"] > 0
        assert contract["scoring"]["sampling"]["student"]["documents_scored"] == 12
        corpus_manifest = build(
            argparse.Namespace(
                source=[str(source)], output_dir=str(root / "corpus"),
                development_percent=25, span_tasks_per_document=1,
                max_file_bytes=1 << 20, max_document_chars=1 << 20,
                max_train_tokens=None, max_development_tokens=None,
                tokenizer="byte", pair_vocab_size=320, record_mode="governed",
                file_class="all", curriculum_exchange=str(contract_path),
                sidepus_export=[],
            )
        )
        assert corpus_manifest["curriculum_exchange"]["contract_digest"] == contract["contract_digest"]
        tampered = json.loads(contract_path.read_text(encoding="utf-8"))
        tampered["document_focus"][0]["extra_repeats"] += 1
        tampered_path = root / "tampered-exchange.json"
        tampered_path.write_text(json.dumps(tampered), encoding="utf-8")
        try:
            build(
                argparse.Namespace(
                    source=[str(source)], output_dir=str(root / "tampered-corpus"),
                    development_percent=25, span_tasks_per_document=1,
                    max_file_bytes=1 << 20, max_document_chars=1 << 20,
                    max_train_tokens=None, max_development_tokens=None,
                    tokenizer="byte", pair_vocab_size=320, record_mode="governed",
                    file_class="all", curriculum_exchange=str(tampered_path),
                    sidepus_export=[],
                )
            )
            raise AssertionError("tampered exchange was accepted")
        except ValueError as error:
            assert "digest" in str(error)
        training_receipt_path = root / "training-receipt.json"
        training_receipt_path.write_text(
            json.dumps(
                {
                    "model": {
                        "export_sha256": sha256_file(student_path),
                        "initialized_from_sha256": contract["student_model_sha256"],
                    },
                    "corpus": {"curriculum_contract_digest": contract["contract_digest"]},
                }
            ),
            encoding="utf-8",
        )
        settlement = settle(
            argparse.Namespace(
                contract=str(contract_path), after_model=str(student_path),
                output=str(root / "settlement.json"), ledger=str(root / "ledger.json"),
                device="cpu", batch_size=4, training_receipt=str(training_receipt_path),
            )
        )
        assert settlement["after_model_sha256"] == sha256_file(student_path)
        assert settlement["training_receipt_sha256"] == sha256_file(training_receipt_path)
        print(json.dumps({"selftest": "passed", "contract": contract["contract_digest"]}))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=False)
    negotiate_parser = subparsers.add_parser("negotiate")
    negotiate_parser.add_argument("--source", action="append", default=[])
    negotiate_parser.add_argument("--sidepus-export", action="append", default=[])
    negotiate_parser.add_argument("--student-model", required=True)
    negotiate_parser.add_argument("--parent-model")
    negotiate_parser.add_argument("--output", required=True)
    negotiate_parser.add_argument("--ledger")
    negotiate_parser.add_argument("--development-percent", type=int, default=5)
    negotiate_parser.add_argument("--max-file-bytes", type=int, default=8 << 20)
    negotiate_parser.add_argument("--max-document-chars", type=int, default=2 << 20)
    negotiate_parser.add_argument("--file-class", choices=["all", "code"], default="all")
    negotiate_parser.add_argument("--device", default="auto")
    negotiate_parser.add_argument("--batch-size", type=int, default=8)
    negotiate_parser.add_argument("--probe-tokens", type=int, default=256)
    negotiate_parser.add_argument("--probes-per-document", type=int, default=2)
    negotiate_parser.add_argument("--max-scored-documents", type=int, default=4096)
    negotiate_parser.add_argument("--taste-temperature", type=float, default=0.5)
    negotiate_parser.add_argument("--taste-weight", type=float, default=0.65)
    negotiate_parser.add_argument("--progress-weight", type=float, default=0.25)
    negotiate_parser.add_argument("--replay-weight", type=float, default=0.10)
    negotiate_parser.add_argument("--persistence-weight", type=float, default=0.25)
    negotiate_parser.add_argument("--focus-fraction", type=float, default=0.5)
    negotiate_parser.add_argument("--max-domain-share", type=float, default=0.45)
    negotiate_parser.add_argument("--max-repeats", type=int, default=4)
    settle_parser = subparsers.add_parser("settle")
    settle_parser.add_argument("--contract", required=True)
    settle_parser.add_argument("--after-model", required=True)
    settle_parser.add_argument("--output", required=True)
    settle_parser.add_argument("--ledger")
    settle_parser.add_argument("--training-receipt")
    settle_parser.add_argument("--device", default="auto")
    settle_parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()
    if args.selftest:
        selftest()
    elif args.command == "negotiate":
        if not args.source and not args.sidepus_export:
            parser.error("negotiate requires at least one --source or --sidepus-export")
        total = args.taste_weight + args.progress_weight + args.replay_weight
        if not math.isclose(total, 1.0, abs_tol=1e-9):
            parser.error("taste, progress, and replay weights must sum to one")
        if not 0.0 < args.focus_fraction <= 2.0:
            parser.error("--focus-fraction must be in (0, 2]")
        if not 1 <= args.max_repeats <= 16:
            parser.error("--max-repeats must be in [1, 16]")
        if args.max_scored_documents < 1:
            parser.error("--max-scored-documents must be positive")
        negotiate(args)
    elif args.command == "settle":
        settle(args)
    else:
        parser.error("choose negotiate or settle, or pass --selftest")


if __name__ == "__main__":
    main()
