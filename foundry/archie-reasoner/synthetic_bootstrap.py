#!/usr/bin/env python3
from __future__ import annotations

import argparse
import dataclasses
import json
import math
import time
from pathlib import Path

import torch
from torch import nn
from torch.utils.data import DataLoader

from synthetic_bootstrap_data import (
    ACTIONS, AUTHORITY, BOS, BYTE_OFFSET, BYTE_VOCAB, CONTEXT, EOS, PAD, ROUTES, ROUTE_PROTOCOL, TRANSFORMS, make_rows,
    sha256_bytes, stable_json,
)
from synthetic_bootstrap_model import (
    Config, Rows, Student, batch_to, collate, dequantize_state, evaluate, evaluate_aux,
    loss_for, quantize_state, seed_all, state_hash,
)

def train_one(seed: int, splits, config: Config, output: Path):
    seed_all(seed)
    device = torch.device("cpu")
    torch.set_num_threads(min(4, max(1, torch.get_num_threads())))
    train_loader = DataLoader(Rows(splits["train"], config), batch_size=config.batch_size, shuffle=True, collate_fn=collate, generator=torch.Generator().manual_seed(seed + 11))
    dev_loader = DataLoader(Rows(splits["dev"], config), batch_size=config.batch_size, shuffle=False, collate_fn=collate)
    test_loader = DataLoader(Rows(splits["test"], config), batch_size=config.batch_size, shuffle=False, collate_fn=collate)
    model = Student(config).to(device)
    initial = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
    initial_hash = state_hash(initial)
    optimizer = torch.optim.AdamW(model.parameters(), lr=config.learning_rate, weight_decay=config.weight_decay)
    total_steps = config.epochs * len(train_loader)
    scheduler = torch.optim.lr_scheduler.LambdaLR(optimizer, lambda step: 0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * min(step, total_steps) / max(1, total_steps))))
    history = []
    best_state = None
    best_score = -1.0
    gradient_steps = 0
    start = time.time()
    for epoch in range(config.epochs):
        model.train()
        sums = {key: 0.0 for key in ["total", "action", "route", "authority", "context", "transform"]}
        examples = 0
        for raw in train_loader:
            batch = batch_to(raw, device)
            optimizer.zero_grad(set_to_none=True)
            outputs = model(batch["source"], batch["source_mask"], batch["target"][:, :-1])
            loss, parts = loss_for(outputs, batch)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            scheduler.step()
            gradient_steps += 1
            count = batch["source"].size(0)
            examples += count
            for key in sums:
                sums[key] += parts[key] * count
        dev = evaluate_aux(model, dev_loader, device)
        score = dev["route_accuracy"] + 0.25 * (dev["authority_accuracy"] + dev["context_accuracy"])
        history.append({"epoch": epoch + 1, "loss": {key: sums[key] / max(1, examples) for key in sums}, "dev": {k: v for k, v in dev.items() if k != "errors"}})
        if score > best_score:
            best_score = score
            best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
    assert best_state is not None
    model.load_state_dict(best_state)
    dev = evaluate(model, dev_loader, device, config)
    test = evaluate(model, test_loader, device, config)
    final_hash = state_hash(best_state)
    changed = sum(1 for key in best_state if not torch.equal(best_state[key], initial[key]))
    quantized = quantize_state(best_state)
    qmodel = Student(config)
    qmodel.load_state_dict(dequantize_state(quantized))
    qtest = evaluate(qmodel, test_loader, device, config)
    artifact = {
        "schema": "archie-synthetic-reasoning-student/v1",
        "promotion": "not-admitted",
        "claim_boundary": "Real from-scratch CPU training on deterministic synthetic protocol data; not evidence of open-domain quality or production admission.",
        "seed": seed,
        "labels": {"routes": ROUTES, "authority": AUTHORITY, "context": CONTEXT, "transforms": TRANSFORMS, "actions": ACTIONS},
        "route_protocol": ROUTE_PROTOCOL,
        "tokenizer": {"type": "utf8-byte", "pad": PAD, "bos": BOS, "eos": EOS, "byte_offset": BYTE_OFFSET, "vocab_size": BYTE_VOCAB},
        "config": dataclasses.asdict(config),
        "state": quantized,
    }
    artifact_bytes = (json.dumps(artifact, sort_keys=True, separators=(",", ":")) + "\n").encode()
    receipt = {
        "schema": "archie-synthetic-reasoning-training-receipt/v1",
        "promotion": "not-admitted",
        "seed": seed,
        "gradient_steps": gradient_steps,
        "elapsed_seconds": round(time.time() - start, 3),
        "parameter_count": sum(p.numel() for p in model.parameters()),
        "changed_tensor_count": changed,
        "tensor_count": len(best_state),
        "initial_state_sha256": initial_hash,
        "trained_state_sha256": final_hash,
        "artifact_sha256": sha256_bytes(artifact_bytes),
        "artifact_bytes": len(artifact_bytes),
        "splits": {name: {"rows": len(rows), "sha256": sha256_bytes((stable_json(rows) + "\n").encode())} for name, rows in splits.items()},
        "history": history,
        "development": dev,
        "heldout": test,
        "quantized_heldout": qtest,
        "quantization_retention": {
            "route": qtest["route_accuracy"] / max(test["route_accuracy"], 1e-12),
            "guarded_protocol": qtest["guarded_protocol_exact"] / max(test["guarded_protocol_exact"], 1e-12),
        },
        "claim_boundary": "Training and changed tensors are real. The corpus is deterministic synthetic supervision derived from the repository's 12-route protocol and does not replace untouched real-corpus admission.",
    }
    output.mkdir(parents=True, exist_ok=True)
    (output / "model.int8.json").write_bytes(artifact_bytes)
    (output / "receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    return receipt, artifact


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--seeds", default="3407,20260720")
    parser.add_argument("--epochs", type=int, default=18)
    args = parser.parse_args()
    config = dataclasses.replace(Config(), epochs=args.epochs)
    splits = make_rows(20260720)
    root = Path(args.output)
    results = []
    artifacts = []
    for seed in [int(x) for x in args.seeds.split(",") if x.strip()]:
        receipt, artifact = train_one(seed, splits, config, root / f"seed-{seed}")
        results.append(receipt)
        artifacts.append(artifact)
    def rank(item):
        return (item["quantized_heldout"]["guarded_protocol_exact"], item["quantized_heldout"]["route_accuracy"], item["quantized_heldout"]["context_accuracy"], -item["artifact_bytes"])
    best = max(results, key=rank)
    selected_dir = root / f"seed-{best['seed']}"
    (root / "selected-model.int8.json").write_bytes((selected_dir / "model.int8.json").read_bytes())
    tournament = {
        "schema": "archie-synthetic-reasoning-tournament/v1",
        "promotion": "not-admitted",
        "data_seed": 20260720,
        "config": dataclasses.asdict(config),
        "candidates": [{"seed": item["seed"], "artifact_sha256": item["artifact_sha256"], "heldout": item["heldout"], "quantized_heldout": item["quantized_heldout"], "gradient_steps": item["gradient_steps"], "changed_tensor_count": item["changed_tensor_count"]} for item in results],
        "selected_seed": best["seed"],
        "selection_rule": "quantized guarded-protocol exact, then route accuracy, then context accuracy, then smaller artifact",
        "selected_artifact_sha256": best["artifact_sha256"],
        "claim_boundary": best["claim_boundary"],
    }
    (root / "tournament-receipt.json").write_text(json.dumps(tournament, indent=2, sort_keys=True) + "\n")
    print(json.dumps(tournament, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
