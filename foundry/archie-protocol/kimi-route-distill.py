#!/usr/bin/env python3
"""Failure-directed, context-preserving Kimi distillation for Archie routes."""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from kimi_distill_common import *
from kimi_distill_api import *
from kimi_distill_verify import *


def validate_args(args) -> None:
    if bool(args.base_data) != bool(args.merged_out):
        raise ValueError("--base-data and --merged-out must be supplied together")
    if not 0 < args.verifier_agreement <= 1:
        raise ValueError("--verifier-agreement must be in (0, 1]")
    if min(args.samples_per_row, args.judges, args.batch_size) < 1:
        raise ValueError("samples, judges, and batch size must be positive")
    if not 0 <= args.min_accepted_per_source <= args.samples_per_row:
        raise ValueError("--min-accepted-per-source must be between zero and --samples-per-row")
    if args.max_sources < 0:
        raise ValueError("--max-sources must be zero or positive")
    if args.max_additions_per_route < 1:
        raise ValueError("--max-additions-per-route must be positive")
    if not 0 <= args.min_confidence <= 1:
        raise ValueError("--min-confidence must be between zero and one")
    if not 0 <= args.max_source_jaccard <= 1 or not 0 <= args.max_frozen_jaccard <= 1:
        raise ValueError("Jaccard thresholds must be between zero and one")
    if args.timeout < 1 or args.retries < 0:
        raise ValueError("--timeout must be positive and --retries cannot be negative")
    if min(args.generation_max_completion, args.verifier_max_completion) < 1:
        raise ValueError("completion-token ceilings must be positive")
    if args.output_price_per_million < 0:
        raise ValueError("--output-price-per-million cannot be negative")


def normalized_sources(path: str) -> list[dict]:
    raw_rows = load(path)
    rows = []
    invalid = []
    for index, raw in enumerate(raw_rows):
        normalized = source_row(raw) if isinstance(raw, dict) else None
        if normalized is None:
            invalid.append(index)
        else:
            rows.append(normalized)
    if invalid:
        preview = invalid[:20]
        suffix = "..." if len(invalid) > len(preview) else ""
        raise ValueError(f"invalid teacher source rows at indices {preview}{suffix}")
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True, help="balanced teacher-source pack")
    parser.add_argument("--out", required=True, help="accepted augmentation rows only")
    parser.add_argument("--base-data")
    parser.add_argument("--merged-out")
    parser.add_argument("--endpoint", default="https://api.moonshot.ai/v1")
    parser.add_argument("--model", default="kimi-k2.6")
    parser.add_argument("--api-key-env", default="MOONSHOT_API_KEY")
    parser.add_argument("--samples-per-row", type=int, default=4)
    parser.add_argument("--judges", type=int, default=3)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--max-sources", type=int, default=0)
    parser.add_argument("--max-additions-per-route", type=int, default=4000)
    parser.add_argument("--min-confidence", type=float, default=0.72)
    parser.add_argument("--verifier-agreement", type=float, default=1.0)
    parser.add_argument("--min-accepted-per-source", type=int, default=1)
    parser.add_argument("--max-source-jaccard", type=float, default=0.82)
    parser.add_argument("--max-frozen-jaccard", type=float, default=0.92)
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--retries", type=int, default=4)
    parser.add_argument("--cache")
    parser.add_argument("--freeze", action="append", default=[])
    parser.add_argument("--thinking", action="store_true")
    parser.add_argument("--reasoning-effort", choices=["low", "high", "max"], default=None)
    parser.add_argument("--structured-output", choices=["json_schema", "json_object"], default="json_schema")
    parser.add_argument("--generation-max-completion", type=int, default=4096)
    parser.add_argument("--verifier-max-completion", type=int, default=4096)
    parser.add_argument("--output-price-per-million", type=float, default=15.0)
    parser.add_argument("--estimate-only", action="store_true")
    args = parser.parse_args()
    validate_args(args)

    args.api_key = os.getenv(args.api_key_env) or os.getenv("ARCHIE_TEACHER_KEY")
    rows = normalized_sources(args.data)
    if args.max_sources:
        rows = rows[: args.max_sources]
    if not rows:
        raise ValueError("no valid failure-family teacher sources")

    holdout = frozen(args.freeze)
    overlapping = [
        row["prompt"]
        for row in rows
        if canon(row["prompt"]) in holdout
        or near_any(row["prompt"], holdout, args.max_frozen_jaccard)
    ]
    if overlapping:
        raise RuntimeError(f"teacher source overlaps frozen evaluation: {len(overlapping)} rows")

    batches = (len(rows) + args.batch_size - 1) // args.batch_size
    max_tokens = (
        batches * args.generation_max_completion
        + batches * args.judges * args.verifier_max_completion
    )
    estimate = {
        "sources": len(rows),
        "candidate_upper_bound": len(rows) * args.samples_per_row,
        "generation_calls": batches,
        "verifier_calls_upper_bound": batches * args.judges,
        "total_calls_upper_bound": batches * (1 + args.judges),
        "max_completion_tokens_exposure": max_tokens,
        "output_price_ceiling_usd": round(
            max_tokens / 1_000_000 * args.output_price_per_million, 2
        ),
        "structured_output": args.structured_output,
    }
    if args.estimate_only:
        print(json.dumps(estimate, indent=2))
        return
    if not args.api_key:
        raise RuntimeError(f"missing API key in {args.api_key_env} or ARCHIE_TEACHER_KEY")

    base_rows = load(args.base_data) if args.base_data else []
    seen = (
        {canon(user_text(row)) for row in base_rows if user_text(row)}
        | {canon(row["prompt"]) for row in rows}
        | set(holdout)
    )
    cache = Cache(args.cache)
    stats = ApiStats()
    accepted = []
    rejected = []
    per_route = Counter()
    per_family = Counter()
    per_source = Counter()

    for start in range(0, len(rows), args.batch_size):
        batch = rows[start : start + args.batch_size]
        style = STYLES[(start // args.batch_size) % len(STYLES)]
        stats.logical_generation += 1
        try:
            payload = teacher(
                args,
                cache,
                stats,
                generation_messages(batch, args.samples_per_row, style),
                0.8,
                args.generation_max_completion,
                f"archie_generation_{start}",
                generation_schema(len(batch), args.samples_per_row),
            )
            candidates = extract_candidates(payload, len(batch), args.samples_per_row)
        except Exception as exception:
            rejected.append(
                {
                    "batch": start,
                    "reason": "generation-error",
                    "detail": trim_text(f"{type(exception).__name__}: {exception}", 240),
                }
            )
            continue

        pending = []
        for position, candidate in enumerate(candidates):
            source_id = candidate.get("source_id") if isinstance(candidate, dict) else None
            if (
                isinstance(source_id, bool)
                or not isinstance(source_id, int)
                or not 0 <= source_id < len(batch)
            ):
                rejected.append({"batch": start, "reason": "source-id"})
                continue
            source = batch[source_id]
            reason = candidate_error(
                candidate,
                source,
                seen,
                holdout,
                args.max_source_jaccard,
                args.max_frozen_jaccard,
            )
            if reason or per_route[candidate.get("route")] >= args.max_additions_per_route:
                rejected.append(
                    {"source": start + source_id, "reason": reason or "route-cap"}
                )
                continue
            if sum(item["_source_id"] == source_id for item in pending) >= args.samples_per_row:
                rejected.append(
                    {"source": start + source_id, "reason": "generation-source-cap"}
                )
                continue
            pending.append(
                {**candidate, "_source_id": source_id, "_candidate_id": f"{start}:{position}"}
            )
        if not pending:
            continue

        judge_maps = []
        for judge in range(args.judges):
            stats.logical_verification += 1
            try:
                ids = [candidate["_candidate_id"] for candidate in pending]
                verdict_payload = teacher(
                    args,
                    cache,
                    stats,
                    verifier_messages(batch, pending, judge + 1),
                    0,
                    args.verifier_max_completion,
                    f"archie_verifier_{start}_{judge + 1}",
                    verifier_schema(ids),
                )
                indexed = index_verdicts(pending, verdict_payload)
                if indexed is None:
                    raise ValueError("verifier payload failed exact semantic validation")
            except Exception as exception:
                rejected.extend(
                    {
                        "source": start + candidate["_source_id"],
                        "reason": f"verifier-isolation-{judge + 1}",
                        "detail": trim_text(f"{type(exception).__name__}: {exception}", 240),
                    }
                    for candidate in pending
                )
                judge_maps = []
                break
            judge_maps.append(indexed)
        if len(judge_maps) != args.judges:
            continue

        for candidate in pending:
            source_index = start + candidate["_source_id"]
            source = batch[candidate["_source_id"]]
            verdicts = [mapping[candidate["_candidate_id"]] for mapping in judge_maps]
            if not batch_consensus(
                candidate, verdicts, args.min_confidence, args.verifier_agreement
            ):
                rejected.append({"source": source_index, "reason": "verifier"})
                continue
            normalized = canon(candidate["prompt"])
            if (
                normalized in seen
                or per_route[candidate["route"]] >= args.max_additions_per_route
                or per_source[source_index] >= args.samples_per_row
            ):
                rejected.append(
                    {"source": source_index, "reason": "post-verifier-duplicate-or-cap"}
                )
                continue
            seen.add(normalized)
            per_route[candidate["route"]] += 1
            per_family[source["failure_family"]] += 1
            per_source[source_index] += 1
            accepted.append(accepted_row(source, candidate, verdicts, args.model))

    missing = [
        index
        for index in range(len(rows))
        if per_source[index] < args.min_accepted_per_source
    ]
    complete = not missing
    write_json(args.out, accepted)
    if args.merged_out:
        write_json(args.merged_out, base_rows + accepted)

    rejection_reasons = Counter(item.get("reason", "unknown") for item in rejected)
    missing_sources = [
        {
            "index": index,
            "id": rows[index].get("id"),
            "source_digest": source_digest(rows[index])[:16],
            "accepted": per_source[index],
        }
        for index in missing
    ]
    reported_output_cost = round(
        stats.completion_tokens / 1_000_000 * args.output_price_per_million, 6
    )
    body = {
        "schema": "archie-route-kimi-distill/v3",
        "teacher": args.model,
        "endpoint_host": re.sub(r"^https?://", "", args.endpoint).split("/")[0],
        "source_rows": len(rows),
        "accepted_rows": len(accepted),
        "rejection_events": len(rejected),
        "rejection_reasons": dict(rejection_reasons),
        "coverage": {
            "minimum_per_source": args.min_accepted_per_source,
            "sources_below_minimum": missing_sources,
            "complete": complete,
        },
        "route_additions": dict(per_route),
        "failure_family_additions": dict(per_family),
        "frozen_prompt_count": len(holdout),
        "training_contract": {
            "context_route_model": ["prompt", "route", "attachments", "memory", "thread"],
            "archie_reasoner_heads": [
                "prompt", "route", "authority", "context_state", "transform_type",
                "attachments", "memory", "thread",
            ],
            "kimi_reasoner_generation": [
                "active_clauses", "compound", "operation", "target", "ordered_outcomes",
            ],
            "audit_only": ["failure_family"],
        },
        "calls": {
            "logical_generation": stats.logical_generation,
            "logical_verification": stats.logical_verification,
            "cache_hits": cache.hits,
            "cache_misses": cache.misses,
            "http_attempts": stats.http_attempts,
            "http_responses": stats.http_responses,
            "http_successes": stats.http_successes,
            "reported_usage_responses": stats.usage_responses,
            "reported_prompt_tokens": stats.prompt_tokens,
            "reported_completion_tokens": stats.completion_tokens,
            "reported_total_tokens": stats.total_tokens,
            "reported_output_cost_usd": reported_output_cost,
        },
        "cache": cache.snapshot(),
        "preflight_estimate": estimate,
        "augmentation_digest": digest(accepted),
        "merged_digest": digest(base_rows + accepted) if args.merged_out else None,
        "promotion": "not-admitted",
        "claim_boundary": (
            "Context-preserving teacher-consensus augmentation only; independent retraining and "
            "admission evaluation remain required."
        ),
    }
    receipt = {**body, "receipt_digest": digest(body)}
    write_json(str(args.out) + ".receipt.json", receipt)
    print(json.dumps(receipt, indent=2))
    if not complete:
        raise RuntimeError(f"distillation coverage incomplete for {len(missing)} sources")


if __name__ == "__main__":
    main()
