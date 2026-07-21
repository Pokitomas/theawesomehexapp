#!/usr/bin/env python3
"""Train Archie with channel-correct supervision for route-only authored rows.

Synthetic rows supervise all six heads. Repository-authored rows supervise only
route, because they contain no observed authority/context/reference/outcome
labels. Authored development and hard-development rows are held out for model
selection. The frozen challenge pack is read only after the selected epoch is
fixed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import time
from pathlib import Path

import numpy as np

import np_transformer as nt


ROUTE_ONLY = {
    "route": 0.55,
    "auth": 0.0,
    "ctx": 0.0,
    "ref": 0.0,
    "out1": 0.0,
    "out2": 0.0,
}


def digest_json(value) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def authored_row(row: dict, index: int) -> dict:
    route = row["route"]
    return {
        "id": f"authored-{index}",
        "category": "authored_route_only",
        "request": row["prompt"],
        "attachments": "",
        "memory": "",
        "thread": "",
        # Only route is observed. Other labels are placeholders and MUST be
        # masked during optimization and ignored during authored evaluation.
        "expected": {
            "route": route,
            "authority": "allow",
            "context": "ambiguous" if route == "clarify" else "ready",
            "reference_type": "none",
            "outcomes": [] if route in ("clarify", "compound") else [route],
        },
        "source": row.get("source", "authored:unspecified"),
    }


def route_metrics(model: nt.Model, rows: list[dict], vmap: dict[str, int], tmax: int) -> dict:
    if not rows:
        return {"examples": 0, "route_accuracy": None, "route_nll": None}
    ids, mask = nt.encode_batch(rows, vmap, tmax)
    logits, _ = model.forward(ids, mask)
    z = logits["route"] - logits["route"].max(-1, keepdims=True)
    p = np.exp(z)
    p /= p.sum(-1, keepdims=True)
    y = np.array([nt.labels_for(row)["route"] for row in rows])
    return {
        "examples": len(rows),
        "route_accuracy": round(float((p.argmax(-1) == y).mean()), 6),
        "route_nll": round(float(-np.log(p[np.arange(len(rows)), y] + 1e-12).mean()), 6),
    }


def clone_params(model: nt.Model) -> dict[str, np.ndarray]:
    return {key: value.copy() for key, value in model.P.items()}


def restore_params(model: nt.Model, params: dict[str, np.ndarray]) -> None:
    for key, value in params.items():
        model.P[key][...] = value


def prepare_rows(args) -> tuple[list[dict], list[dict], list[dict], list[dict], list[dict]]:
    frozen_raw = json.loads(Path(args.frozen_pack).read_text())
    if isinstance(frozen_raw, dict):
        frozen = [frozen_raw[key] for key in sorted(frozen_raw, key=lambda item: int(item))]
    else:
        frozen = frozen_raw
    frozen_texts = {nt.norm_input(row) for row in frozen}

    synthetic = nt.generate_dataset(
        args.seed + 1,
        "train",
        n_single=800 * args.scale,
        n_ref_each=80 * args.scale,
        n_compound=160 * args.scale,
        n_authority_each=80 * args.scale,
        n_ambiguous=80 * args.scale,
    )
    generated_dev = nt.generate_dataset(
        args.seed + 2,
        "dev",
        n_single=240,
        n_ref_each=32,
        n_compound=72,
        n_authority_each=32,
        n_ambiguous=32,
    )
    synthetic = [row for row in synthetic if nt.norm_input(row) not in frozen_texts]
    generated_dev = [row for row in generated_dev if nt.norm_input(row) not in frozen_texts]

    raw_authored = json.loads(Path(args.authored_rows).read_text())
    authored = [authored_row(row, i) for i, row in enumerate(raw_authored)]
    authored = [row for row in authored if nt.norm_input(row) not in frozen_texts]
    authored_train = [row for row in authored if row["source"].endswith(":train")]
    authored_dev = [
        row for row in authored
        if row["source"].endswith(":development") or row["source"].endswith(":hard-development")
    ]
    if not authored_train or not authored_dev:
        # Deterministic fallback for older corpus files without split metadata.
        authored_sorted = sorted(authored, key=lambda row: hashlib.sha256(nt.norm_input(row).encode()).hexdigest())
        cut = max(1, int(round(len(authored_sorted) * 0.8)))
        authored_train, authored_dev = authored_sorted[:cut], authored_sorted[cut:]
    return synthetic, generated_dev, authored_train, authored_dev, frozen


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--authored-rows", required=True)
    parser.add_argument("--frozen-pack", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--tag", default="npt-authored-masked-d128")
    parser.add_argument("--seed", type=int, default=424243)
    parser.add_argument("--d", type=int, default=128)
    parser.add_argument("--layers", type=int, default=2)
    parser.add_argument("--heads", type=int, default=4)
    parser.add_argument("--tmax", type=int, default=84)
    parser.add_argument("--epochs", type=int, default=8)
    parser.add_argument("--batch", type=int, default=64)
    parser.add_argument("--lr", type=float, default=0.0022)
    parser.add_argument("--drop", type=float, default=0.10)
    parser.add_argument("--scale", type=int, default=3)
    parser.add_argument("--authored-repeat", type=int, default=40)
    parser.add_argument("--authored-loss-weight", type=float, default=0.55)
    args = parser.parse_args()

    started = time.time()
    synthetic, generated_dev, authored_train_base, authored_dev, frozen = prepare_rows(args)
    authored_pool = authored_train_base * max(1, args.authored_repeat)
    training_vocab_rows = synthetic + authored_train_base
    vmap = nt.build_vocab(training_vocab_rows)
    model = nt.Model(len(vmap), args.d, args.layers, args.heads, args.tmax, args.seed)
    rng = np.random.default_rng(args.seed + 991)

    route_only = dict(ROUTE_ONLY)
    route_only["route"] = args.authored_loss_weight

    syn_order = np.arange(len(synthetic))
    authored_order = np.arange(len(authored_pool))
    syn_steps = math.ceil(len(synthetic) / args.batch)
    # Match authored exposure to synthetic exposure each epoch. Repetition adds
    # sampling diversity without allowing route-only supervision to dominate.
    authored_examples_per_epoch = min(len(authored_pool), len(synthetic))
    authored_steps = math.ceil(authored_examples_per_epoch / args.batch)
    total_steps = args.epochs * (syn_steps + authored_steps)
    step = 0

    best_score = (-1.0, -1.0, -1.0)
    best_epoch = 0
    best_params = clone_params(model)
    trace = []

    print(json.dumps({
        "synthetic_train_rows": len(synthetic),
        "authored_train_unique": len(authored_train_base),
        "authored_selection_rows": len(authored_dev),
        "authored_pool_rows": len(authored_pool),
        "authored_examples_per_epoch": authored_examples_per_epoch,
        "vocab": len(vmap),
        "params": model.params_count(),
        "steps": total_steps,
        "supervision": "all-head synthetic; route-only authored; authored dev held out",
    }), flush=True)

    for epoch in range(1, args.epochs + 1):
        rng.shuffle(syn_order)
        # Sample without replacement when possible, then shuffle. This keeps the
        # authored/synthetic update ratio fixed and preregistered.
        if authored_examples_per_epoch == len(authored_pool):
            selected_authored = authored_order.copy()
            rng.shuffle(selected_authored)
        else:
            selected_authored = rng.choice(
                authored_order,
                size=authored_examples_per_epoch,
                replace=False,
            )
            rng.shuffle(selected_authored)

        authored_batches = [
            selected_authored[start:start + args.batch]
            for start in range(0, len(selected_authored), args.batch)
        ]
        syn_batches = [
            syn_order[start:start + args.batch]
            for start in range(0, len(syn_order), args.batch)
        ]

        loss_authored = 0.0
        loss_synthetic = 0.0
        # Route-only update first, full supervision immediately after it. This
        # prevents a tail of unopposed route-only trunk updates.
        for batch_index, syn_sel in enumerate(syn_batches):
            if batch_index < len(authored_batches):
                real_sel = authored_batches[batch_index]
                real_rows = [authored_pool[int(i)] for i in real_sel]
                ids, mask = nt.encode_batch(real_rows, vmap, args.tmax)
                ys = {
                    name: np.array([nt.labels_for(row)[name] for row in real_rows])
                    for name in nt.Model.HEADS
                }
                warm = min(1.0, (step + 1) / max(1, int(total_steps * 0.06)))
                cosine = 0.5 * (1.0 + math.cos(math.pi * step / max(1, total_steps)))
                lr = args.lr * warm * (0.08 + 0.92 * cosine)
                loss, grads = model.loss_and_grads(
                    ids, mask, ys, args.drop * 0.5, rng,
                    head_weights=route_only,
                )
                model.step(grads, lr)
                loss_authored += loss
                step += 1

            syn_rows = [synthetic[int(i)] for i in syn_sel]
            ids, mask = nt.encode_batch(syn_rows, vmap, args.tmax)
            ys = {
                name: np.array([nt.labels_for(row)[name] for row in syn_rows])
                for name in nt.Model.HEADS
            }
            warm = min(1.0, (step + 1) / max(1, int(total_steps * 0.06)))
            cosine = 0.5 * (1.0 + math.cos(math.pi * step / max(1, total_steps)))
            lr = args.lr * warm * (0.08 + 0.92 * cosine)
            loss, grads = model.loss_and_grads(ids, mask, ys, args.drop, rng)
            model.step(grads, lr)
            loss_synthetic += loss
            step += 1

        generated = nt.evaluate_pack(model, generated_dev, vmap, args.tmax, 1.0)
        authored_metrics = route_metrics(model, authored_dev, vmap, args.tmax)
        authored_acc = float(authored_metrics["route_accuracy"] or 0.0)
        # Primary score requires both structural full correctness and authored
        # register transfer; ties favor generated route retention.
        harmonic = 0.0
        if generated["full_accuracy"] > 0 and authored_acc > 0:
            harmonic = 2.0 * generated["full_accuracy"] * authored_acc / (generated["full_accuracy"] + authored_acc)
        score = (round(harmonic, 9), generated["full_accuracy"], generated["route_accuracy"])
        row = {
            "epoch": epoch,
            "synthetic_loss": round(loss_synthetic / max(1, len(syn_batches)), 6),
            "authored_route_loss": round(loss_authored / max(1, len(authored_batches)), 6),
            "generated_dev_full": generated["full_accuracy"],
            "generated_dev_route": generated["route_accuracy"],
            "authored_dev_route": authored_metrics["route_accuracy"],
            "selection_harmonic": round(harmonic, 6),
            "minutes": round((time.time() - started) / 60.0, 2),
        }
        trace.append(row)
        print(json.dumps(row), flush=True)
        if score > best_score:
            best_score = score
            best_epoch = epoch
            best_params = clone_params(model)

    restore_params(model, best_params)

    # Temperature is selected on generated development only after the epoch is
    # fixed. It cannot change argmax decisions and never sees the frozen pack.
    dev_ids, dev_mask = nt.encode_batch(generated_dev, vmap, args.tmax)
    logits, _ = model.forward(dev_ids, dev_mask)
    y_route = np.array([nt.labels_for(row)["route"] for row in generated_dev])
    best_temperature, best_nll = 1.0, float("inf")
    for temperature in np.linspace(0.6, 2.0, 15):
        z = logits["route"] / temperature
        z -= z.max(-1, keepdims=True)
        p = np.exp(z)
        p /= p.sum(-1, keepdims=True)
        nll = float(-np.log(p[np.arange(len(generated_dev)), y_route] + 1e-12).mean())
        if nll < best_nll:
            best_nll, best_temperature = nll, float(temperature)

    selected_generated = nt.evaluate_pack(model, generated_dev, vmap, args.tmax, best_temperature)
    selected_authored = route_metrics(model, authored_dev, vmap, args.tmax)
    blind = nt.evaluate_pack(model, frozen, vmap, args.tmax, best_temperature)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    weights_path = out / f"{args.tag}-seed{args.seed}.npz"
    np.savez_compressed(weights_path, **model.P)
    receipt = {
        "schema": "archie-masked-authored-transformer/v1",
        "tag": args.tag,
        "config": {
            "seed": args.seed,
            "d": args.d,
            "layers": args.layers,
            "heads": args.heads,
            "tmax": args.tmax,
            "epochs": args.epochs,
            "batch": args.batch,
            "lr": args.lr,
            "dropout": args.drop,
            "scale": args.scale,
            "authored_repeat": args.authored_repeat,
            "authored_loss_weight": args.authored_loss_weight,
            "selected_epoch": best_epoch,
            "route_temperature": best_temperature,
        },
        "data": {
            "synthetic_train_rows": len(synthetic),
            "generated_dev_rows": len(generated_dev),
            "authored_train_unique": len(authored_train_base),
            "authored_selection_rows": len(authored_dev),
            "authored_train_digest": digest_json([nt.norm_input(row) for row in authored_train_base]),
            "authored_selection_digest": digest_json([nt.norm_input(row) for row in authored_dev]),
            "frozen_pack_sha256": file_sha256(Path(args.frozen_pack)),
            "vocab": len(vmap),
            "vocab_tokens": sorted(vmap, key=vmap.get),
        },
        "supervision_contract": {
            "synthetic": "route+authority+context+reference+ordered outcomes",
            "authored_train": "route only; placeholder auxiliary labels masked",
            "authored_selection": "route only; never optimized",
            "frozen_pack": "evaluated once after epoch and temperature selection",
        },
        "selection_trace": trace,
        "selected_development": {
            "generated": {key: value for key, value in selected_generated.items() if key != "errors"},
            "authored": selected_authored,
        },
        "results": {"blind_429": blind},
        "model": {
            "parameters": model.params_count(),
            "weights_file": weights_path.name,
            "weights_sha256": file_sha256(weights_path),
        },
        "minutes": round((time.time() - started) / 60.0, 2),
        "promotion": "not-admitted",
        "claim_boundary": "Repository-authored route-only rows never supervise fabricated auxiliary labels. Mandatory legacy retention suites remain unavailable, so this candidate cannot be admitted regardless of blind-pack score.",
    }
    receipt["receipt_digest"] = digest_json(receipt)
    receipt_path = out / f"{args.tag}-seed{args.seed}-receipt.json"
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({
        "done": True,
        "selected_epoch": best_epoch,
        "blind_full": blind["full_accuracy"],
        "blind_route": blind["route_accuracy"],
        "weights_sha256": receipt["model"]["weights_sha256"],
        "receipt_digest": receipt["receipt_digest"],
        "promotion": receipt["promotion"],
    }, indent=2), flush=True)


if __name__ == "__main__":
    main()
