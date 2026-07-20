#!/usr/bin/env python3
"""Protected route-head adaptation for the from-scratch Archie transformer.

This lane starts from an already-trained checkpoint, freezes every shared-trunk
and auxiliary-head parameter bit-for-bit, and adapts only Hroute/Hbroute on a
predeclared mixture of governed real-language rows and synthetic replay. Model
selection uses the generated development split only; frozen suites are read
once after the selected checkpoint is fixed.
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


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def arrays_sha(params: dict[str, np.ndarray], keys: list[str]) -> str:
    h = hashlib.sha256()
    for key in sorted(keys):
        h.update(key.encode())
        h.update(str(params[key].dtype).encode())
        h.update(np.asarray(params[key].shape, dtype=np.int64).tobytes())
        h.update(np.ascontiguousarray(params[key]).tobytes())
    return h.hexdigest()


def governed_rows(path: Path) -> list[dict]:
    raw = json.loads(path.read_text())
    rows = []
    for i, row in enumerate(raw):
        route = row["route"]
        rows.append({
            "id": f"protected-real-{i}",
            "category": "real_language",
            "request": row["prompt"],
            "attachments": "",
            "memory": "",
            "thread": "",
            "expected": {
                "route": route,
                "authority": "allow",
                "context": "ambiguous" if route == "clarify" else "ready",
                "reference_type": "none",
                "outcomes": [] if route == "clarify" else ([route] if route != "compound" else []),
            },
        })
    return rows


def legacy_rows(directory: Path) -> dict[str, list[dict]]:
    suites = {}
    for name in ["router-v2-original-heldout", "router-real-v2-heldout", "router-real-v3-final"]:
        path = directory / f"{name}.jsonl"
        if path.exists():
            suites[name] = nt.legacy_rows(path)
    return suites


def route_metrics(model: nt.Model, rows: list[dict], vmap: dict[str, int], tmax: int) -> dict:
    if not rows:
        return {"examples": 0, "route_accuracy": None, "route_nll": None}
    ids, mask = nt.encode_batch(rows, vmap, tmax)
    logits, _ = model.forward(ids, mask)
    z = logits["route"] - logits["route"].max(-1, keepdims=True)
    p = np.exp(z)
    p /= p.sum(-1, keepdims=True)
    y = np.array([nt.labels_for(r)["route"] for r in rows])
    return {
        "examples": len(rows),
        "route_accuracy": round(float((p.argmax(-1) == y).mean()), 6),
        "route_nll": round(float(-np.log(p[np.arange(len(rows)), y] + 1e-12).mean()), 6),
    }


def load_model(receipt: dict, weights_path: Path) -> tuple[nt.Model, dict[str, int]]:
    cfg = receipt["config"]
    tokens = receipt["data"]["vocab_tokens"]
    vmap = {token: i for i, token in enumerate(tokens)}
    model = nt.Model(len(vmap), cfg["d"], cfg["layers"], cfg["heads"], cfg["tmax"], cfg["seed"])
    saved = np.load(weights_path)
    missing = sorted(set(model.P) - set(saved.files))
    extra = sorted(set(saved.files) - set(model.P))
    if missing or extra:
        raise RuntimeError(f"checkpoint schema mismatch missing={missing} extra={extra}")
    for key in model.P:
        if model.P[key].shape != saved[key].shape:
            raise RuntimeError(f"shape mismatch for {key}: {model.P[key].shape} != {saved[key].shape}")
        model.P[key][...] = saved[key]
    return model, vmap


def head_step(
    model: nt.Model,
    ids: np.ndarray,
    mask: np.ndarray,
    y: np.ndarray,
    state: dict[str, np.ndarray | int],
    initial_h: np.ndarray,
    initial_b: np.ndarray,
    lr: float,
    proximal: float,
    smooth: float,
) -> float:
    logits, cache = model.forward(ids, mask)
    z = logits["route"]
    z = z - z.max(-1, keepdims=True)
    p = np.exp(z)
    p /= p.sum(-1, keepdims=True)
    n = p.shape[1]
    target = np.full_like(p, smooth / n)
    target[np.arange(len(y)), y] += 1.0 - smooth
    loss = float(-(target * np.log(p + 1e-12)).sum() / len(y))
    dz = (p - target) / len(y)
    g_h = cache["cls"].T @ dz + proximal * (model.P["Hroute"] - initial_h)
    g_b = dz.sum(0) + proximal * (model.P["Hbroute"] - initial_b)
    loss += 0.5 * proximal * float(
        np.square(model.P["Hroute"] - initial_h).sum()
        + np.square(model.P["Hbroute"] - initial_b).sum()
    )

    state["t"] = int(state["t"]) + 1
    t = int(state["t"])
    beta1, beta2, eps = 0.9, 0.98, 1e-9
    for key, grad in (("Hroute", g_h), ("Hbroute", g_b)):
        m = state[f"m_{key}"]
        v = state[f"v_{key}"]
        assert isinstance(m, np.ndarray) and isinstance(v, np.ndarray)
        m[:] = beta1 * m + (1.0 - beta1) * grad
        v[:] = beta2 * v + (1.0 - beta2) * grad * grad
        mhat = m / (1.0 - beta1 ** t)
        vhat = v / (1.0 - beta2 ** t)
        model.P[key] -= lr * mhat / (np.sqrt(vhat) + eps)
    return loss


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source-receipt", required=True)
    ap.add_argument("--source-weights", required=True)
    ap.add_argument("--real-rows", required=True)
    ap.add_argument("--legacy-dir", required=True)
    ap.add_argument("--frozen-pack", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--tag", default="npt-realdom-headsafe-d128")
    ap.add_argument("--epochs", type=int, default=4)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--real-repeat", type=int, default=3)
    ap.add_argument("--replay-ratio", type=float, default=1.0)
    ap.add_argument("--proximal", type=float, default=1e-3)
    ap.add_argument("--label-smoothing", type=float, default=0.05)
    args = ap.parse_args()

    t0 = time.time()
    receipt_path = Path(args.source_receipt)
    weights_path = Path(args.source_weights)
    source = json.loads(receipt_path.read_text())
    cfg = source["config"]
    model, vmap = load_model(source, weights_path)
    frozen_path = Path(args.frozen_pack)
    frozen = json.loads(frozen_path.read_text())
    if isinstance(frozen, dict):
        frozen = [frozen[key] for key in sorted(frozen, key=lambda s: int(s))]
    legacy = legacy_rows(Path(args.legacy_dir))

    frozen_texts = {nt.norm_input(r) for r in frozen}
    for rows in legacy.values():
        frozen_texts |= {nt.norm_input(r) for r in rows}

    real_base = governed_rows(Path(args.real_rows))
    real_train = real_base * max(1, args.real_repeat)
    k = int(cfg["scale"])
    synthetic = nt.generate_dataset(
        int(cfg["seed"]) + 1,
        "train",
        n_single=800 * k,
        n_ref_each=80 * k,
        n_compound=160 * k,
        n_authority_each=80 * k,
        n_ambiguous=80 * k,
    )
    synthetic = [row for row in synthetic if nt.norm_input(row) not in frozen_texts]
    dev = nt.generate_dataset(
        int(cfg["seed"]) + 2,
        "dev",
        n_single=240,
        n_ref_each=32,
        n_compound=72,
        n_authority_each=32,
        n_ambiguous=32,
    )
    dev = [row for row in dev if nt.norm_input(row) not in frozen_texts]

    rng = np.random.default_rng(int(cfg["seed"]) + 701)
    replay_n = min(len(synthetic), int(round(len(real_train) * max(0.0, args.replay_ratio))))
    replay_idx = rng.choice(len(synthetic), size=replay_n, replace=False) if replay_n else np.array([], dtype=np.int64)
    train = real_train + [synthetic[int(i)] for i in replay_idx]
    order = np.arange(len(train))
    ys = np.array([nt.labels_for(row)["route"] for row in train])

    protected_keys = [key for key in model.P if key not in ("Hroute", "Hbroute")]
    protected_before = arrays_sha(model.P, protected_keys)
    h0 = model.P["Hroute"].copy()
    b0 = model.P["Hbroute"].copy()
    baseline_dev = route_metrics(model, dev, vmap, int(cfg["tmax"]))
    baseline_real = route_metrics(model, real_base, vmap, int(cfg["tmax"]))
    best_epoch = 0
    best_score = (baseline_dev["route_accuracy"], -baseline_dev["route_nll"])
    best_h = h0.copy()
    best_b = b0.copy()
    trace = [{"epoch": 0, "mean_loss": None, "dev": baseline_dev, "real": baseline_real}]
    state: dict[str, np.ndarray | int] = {
        "t": 0,
        "m_Hroute": np.zeros_like(model.P["Hroute"]),
        "v_Hroute": np.zeros_like(model.P["Hroute"]),
        "m_Hbroute": np.zeros_like(model.P["Hbroute"]),
        "v_Hbroute": np.zeros_like(model.P["Hbroute"]),
    }
    steps_per = math.ceil(len(train) / args.batch)
    total_steps = max(1, steps_per * args.epochs)
    step = 0
    for epoch in range(1, args.epochs + 1):
        rng.shuffle(order)
        epoch_loss = 0.0
        for start in range(0, len(order), args.batch):
            sel = order[start:start + args.batch]
            rows = [train[int(i)] for i in sel]
            ids, mask = nt.encode_batch(rows, vmap, int(cfg["tmax"]))
            warm = min(1.0, (step + 1) / max(1, int(total_steps * 0.08)))
            cosine = 0.5 * (1.0 + math.cos(math.pi * step / total_steps))
            lr = args.lr * warm * (0.1 + 0.9 * cosine)
            epoch_loss += head_step(
                model, ids, mask, ys[sel], state, h0, b0, lr,
                args.proximal, args.label_smoothing,
            )
            step += 1
        dev_metrics = route_metrics(model, dev, vmap, int(cfg["tmax"]))
        real_metrics = route_metrics(model, real_base, vmap, int(cfg["tmax"]))
        trace.append({
            "epoch": epoch,
            "mean_loss": round(epoch_loss / steps_per, 6),
            "dev": dev_metrics,
            "real": real_metrics,
        })
        score = (dev_metrics["route_accuracy"], -dev_metrics["route_nll"])
        if score > best_score:
            best_score = score
            best_epoch = epoch
            best_h = model.P["Hroute"].copy()
            best_b = model.P["Hbroute"].copy()
        print(json.dumps(trace[-1]), flush=True)

    model.P["Hroute"][...] = best_h
    model.P["Hbroute"][...] = best_b
    protected_after = arrays_sha(model.P, protected_keys)
    if protected_before != protected_after:
        raise RuntimeError("protected shared-trunk or auxiliary-head parameters changed")

    best_t, best_nll = 1.0, 1e9
    dev_ids, dev_mask = nt.encode_batch(dev, vmap, int(cfg["tmax"]))
    logits, _ = model.forward(dev_ids, dev_mask)
    y_dev = np.array([nt.labels_for(r)["route"] for r in dev])
    for temperature in np.linspace(0.6, 2.0, 15):
        z = logits["route"] / temperature
        z -= z.max(-1, keepdims=True)
        p = np.exp(z)
        p /= p.sum(-1, keepdims=True)
        nll = float(-np.log(p[np.arange(len(dev)), y_dev] + 1e-12).mean())
        if nll < best_nll:
            best_nll, best_t = nll, float(temperature)

    results = {"blind_429": nt.evaluate_pack(model, frozen, vmap, int(cfg["tmax"]), best_t)}
    for name, rows in legacy.items():
        results[name] = nt.eval_legacy(model, rows, vmap, int(cfg["tmax"]), best_t)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    output_weights = out / f"{args.tag}-seed{cfg['seed']}.npz"
    np.savez_compressed(output_weights, **model.P)
    result = {
        "schema": "archie-protected-route-head-receipt/v1",
        "tag": args.tag,
        "source": {
            "receipt_file": receipt_path.name,
            "receipt_sha256": file_sha256(receipt_path),
            "weights_file": weights_path.name,
            "weights_sha256": file_sha256(weights_path),
        },
        "config": {
            **cfg,
            "route_temperature": best_t,
            "adaptation": "frozen-trunk route-head only with balanced synthetic replay",
            "adaptation_epochs": args.epochs,
            "selected_epoch": best_epoch,
            "adaptation_lr": args.lr,
            "adaptation_batch": args.batch,
            "adaptation_real_repeat": args.real_repeat,
            "adaptation_replay_ratio": args.replay_ratio,
            "adaptation_proximal": args.proximal,
            "adaptation_label_smoothing": args.label_smoothing,
        },
        "data": {
            "real_language_base_rows": len(real_base),
            "real_language_adaptation_rows": len(real_train),
            "synthetic_replay_rows": replay_n,
            "adaptation_rows": len(train),
            "dev_rows": len(dev),
            "frozen_text_collisions_excluded": len(frozen_texts),
            "vocab": len(vmap),
            "vocab_tokens": sorted(vmap, key=vmap.get),
        },
        "protection": {
            "protected_parameter_keys": len(protected_keys),
            "protected_before_sha256": protected_before,
            "protected_after_sha256": protected_after,
            "bit_exact": protected_before == protected_after,
            "trainable_keys": ["Hroute", "Hbroute"],
        },
        "selection": {
            "rule": "maximize generated-dev route accuracy, then minimize generated-dev route NLL; frozen packs are evaluated only after selection",
            "baseline_dev": baseline_dev,
            "baseline_real": baseline_real,
            "trace": trace,
        },
        "model": {
            "parameters": model.params_count(),
            "weights_file": output_weights.name,
            "weights_sha256": file_sha256(output_weights),
        },
        "frozen_pack_sha256": file_sha256(frozen_path),
        "results": results,
        "minutes": round((time.time() - t0) / 60.0, 1),
        "promotion": "not-admitted",
        "claim_boundary": "Only the route head was adaptable. Every shared-trunk and auxiliary-head byte is digest-proven unchanged. Checkpoint selection used generated dev only; frozen suites were read once after selection.",
    }
    result["receipt_digest"] = nt.sha(result)
    output_receipt = out / f"{args.tag}-seed{cfg['seed']}-receipt.json"
    output_receipt.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({
        "done": True,
        "selected_epoch": best_epoch,
        "protection_bit_exact": protected_before == protected_after,
        "results": {k: {kk: vv for kk, vv in value.items() if kk != "errors"} for k, value in results.items()},
        "weights": output_weights.name,
        "receipt": output_receipt.name,
    }, indent=2), flush=True)


if __name__ == "__main__":
    main()
