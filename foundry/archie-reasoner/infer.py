#!/usr/bin/env python3
"""Run one offline Archie Reasoner inference from a trained research bundle."""
from __future__ import annotations

import argparse
import dataclasses
import json
import sys
from pathlib import Path
from typing import Any

from archie_reasoner import (
    AUTHORITY_LABELS,
    CONTEXT_LABELS,
    ModelConfig,
    ROUTES,
    SentencePieceTokenizer,
    apply_fail_closed,
    build_model_class,
    require_training_dependencies,
    source_text,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", required=True, help="Directory containing best.pt and tokenizer.model")
    parser.add_argument("--request", help="Request text; reads stdin when omitted")
    parser.add_argument("--attachment", action="append", default=[])
    parser.add_argument("--memory", default="")
    parser.add_argument("--thread", action="store_true")
    parser.add_argument("--device", choices=("auto", "cpu", "cuda", "mps"), default="auto")
    return parser.parse_args()


def choose_device(torch: Any, requested: str):
    if requested != "auto":
        return torch.device(requested)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def main() -> int:
    args = parse_args()
    torch, _ = require_training_dependencies()
    bundle = Path(args.bundle)
    checkpoint_path = bundle / "best.pt"
    tokenizer_path = bundle / "tokenizer.model"
    if not checkpoint_path.exists() or not tokenizer_path.exists():
        raise SystemExit("bundle must contain best.pt and tokenizer.model")

    request = args.request if args.request is not None else sys.stdin.read()
    if not request.strip():
        raise SystemExit("request is empty")
    row = {
        "prompt": request.strip(),
        "route": "clarify",  # ignored for inference text construction
        "attachments": args.attachment,
        "memory": args.memory,
        "thread": args.thread,
    }

    device = choose_device(torch, args.device)
    checkpoint = torch.load(checkpoint_path, map_location=device, weights_only=False)
    config = ModelConfig(**checkpoint["config"])
    transform_labels = list(checkpoint["transform_labels"])
    temperature = float(checkpoint.get("temperature", 1.0))
    tokenizer = SentencePieceTokenizer(tokenizer_path)
    ArchieReasoner = build_model_class()
    model = ArchieReasoner(
        tokenizer.vocab_size,
        tokenizer.pad_id,
        len(transform_labels),
        config,
    ).to(device)
    model.load_state_dict(checkpoint["model_state"])
    model.eval()

    ids = tokenizer.encode(source_text(row), config.max_source_tokens)
    source = torch.tensor([ids], dtype=torch.long, device=device)
    padding = source.eq(tokenizer.pad_id)
    with torch.inference_mode():
        output = model.generate(
            source,
            padding,
            tokenizer.bos_id,
            tokenizer.eos_id,
            config.max_target_tokens,
        )
    decoded = tokenizer.decode(output["generated_ids"][0].detach().cpu().tolist())
    route_probability = torch.softmax(output["route_logits"][0] / max(0.05, temperature), dim=-1)
    authority_probability = torch.softmax(output["authority_logits"][0], dim=-1)
    context_probability = torch.softmax(output["context_logits"][0], dim=-1)
    transform_probability = torch.softmax(output["transform_logits"][0], dim=-1)

    route_index = int(route_probability.argmax())
    authority_index = int(authority_probability.argmax())
    context_index = int(context_probability.argmax())
    transform_index = int(transform_probability.argmax())
    guarded = apply_fail_closed(
        decoded,
        authority_index,
        context_index,
        transform_labels[transform_index],
    )
    result = {
        "schema": "archie-reasoner-inference/v1",
        "request": request.strip(),
        "graph": guarded["graph"],
        "plan": guarded["plan"],
        "decision_source": guarded["decision_source"],
        "auxiliary": {
            "route": ROUTES[route_index],
            "route_confidence": float(route_probability[route_index]),
            "authority": AUTHORITY_LABELS[authority_index],
            "authority_confidence": float(authority_probability[authority_index]),
            "context": CONTEXT_LABELS[context_index],
            "context_confidence": float(context_probability[context_index]),
            "transform": transform_labels[transform_index],
            "transform_confidence": float(transform_probability[transform_index]),
            "temperature": temperature,
        },
        "raw_generation": decoded,
        "promotion": "not-admitted",
    }
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
