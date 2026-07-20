#!/usr/bin/env python3
"""Export a trained NumPy transformer checkpoint to int8 JSON for the browser.

2-D tensors are quantized per-row to int8 with float scales; 1-D tensors stay
float (they are tiny). The vocabulary and head layouts ride along so the JS
runtime is self-sufficient. Reports float-vs-int8 parity on the frozen pack.
"""
from __future__ import annotations

import argparse, base64, hashlib, json, sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import np_transformer as T  # noqa: E402


def quant2d(m):
    scales, rows = [], []
    for row in m:
        s = float(np.max(np.abs(row)) / 127.0) or 1.0
        q = np.clip(np.round(row / s), -127, 127).astype(np.int8)
        scales.append(s)
        rows.append(base64.b64encode(q.tobytes()).decode())
    return {"scales": scales, "rows": rows}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", required=True)
    ap.add_argument("--receipt", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--parity-pack", default=str(HERE.parent / "factorized" / "blind-challenge-pack.frozen.json"))
    ap.add_argument("--real-rows", default="")
    ap.add_argument("--real-repeat", type=int, default=1)
    ap.add_argument("--legacy-dir", default="")
    a = ap.parse_args()

    z = np.load(a.weights)
    receipt = json.loads(Path(a.receipt).read_text())
    cfg = receipt["config"]

    frozen_pack = json.loads(Path(a.parity_pack).read_text())
    if isinstance(frozen_pack, dict):
        frozen_pack = [frozen_pack[key] for key in sorted(frozen_pack, key=lambda s: int(s))]

    # Vocabulary: prefer the tokens embedded in the receipt (exact); otherwise
    # rebuild from the recorded recipe (requires --real-rows/--real-repeat/--legacy-dir
    # to match training exactly) and refuse on any drift.
    if "vocab_tokens" in receipt.get("data", {}):
        vocab_list = receipt["data"]["vocab_tokens"]
        vmap = {t: i for i, t in enumerate(vocab_list)}
    else:
        k = cfg["scale"]; seed = cfg["seed"]
        train = T.generate_dataset(seed + 1, "train", n_single=800 * k, n_ref_each=80 * k, n_compound=160 * k, n_authority_each=80 * k, n_ambiguous=80 * k)
        if a.real_rows:
            for i, row in enumerate(json.loads(Path(a.real_rows).read_text()) * max(1, a.real_repeat)):
                train.append({"id": f"real-{i}", "request": row["prompt"], "attachments": "", "memory": "", "thread": "",
                              "expected": {"route": row["route"], "authority": "allow", "context": "ready", "reference_type": "none", "outcomes": []}})
        frozen_texts = {T.norm_input(r) for r in frozen_pack}
        if a.legacy_dir:
            for name in ["router-v2-original-heldout", "router-real-v2-heldout", "router-real-v3-final"]:
                p = Path(a.legacy_dir) / f"{name}.jsonl"
                if p.exists():
                    frozen_texts |= {T.norm_input(r) for r in T.legacy_rows(p)}
        train = [r for r in train if T.norm_input(r) not in frozen_texts]
        vmap = T.build_vocab(train)
    emb_rows = int(z["emb"].shape[0])
    if len(vmap) != emb_rows:
        raise SystemExit(f"vocab mismatch: rebuilt {len(vmap)} vs checkpoint {emb_rows} — recipe drift, refusing to export")

    body = {
        "schema": "archie-np-transformer-web/v1",
        "config": {**{kk: cfg[kk] for kk in ("d", "layers", "heads", "tmax", "seed", "route_temperature")}, "subword": cfg.get("subword", True)},
        "routes": T.ROUTES, "authority": T.AUTHORITY, "context": T.CONTEXT, "ref": T.REF,
        "out1": T.OUT1, "out2": T.OUT2, "special": T.SPECIAL,
        "vocab": sorted(vmap, key=vmap.get),
        "tensors2d": {kname: quant2d(z[kname]) for kname in z.files if z[kname].ndim == 2},
        "tensors1d": {kname: [float(x) for x in z[kname]] for kname in z.files if z[kname].ndim == 1},
        "source_receipt_digest": receipt["receipt_digest"],
        "results": {kk: {m: vv for m, vv in v.items() if m != "errors"} for kk, v in receipt["results"].items()},
        "parameters": receipt["model"]["parameters"],
        "promotion": "not-admitted",
    }
    body["model_digest"] = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
    Path(a.out).write_text(json.dumps(body) + "\n")

    # Parity: dequantized weights vs float on the frozen pack (route decisions).
    model = T.Model(len(vmap), cfg["d"], cfg["layers"], cfg["heads"], cfg["tmax"], seed)
    for kname in z.files:
        model.P[kname] = z[kname]
    float_pred = T.predict(model, frozen_pack, vmap, cfg["tmax"], cfg["route_temperature"])
    for kname, q in body["tensors2d"].items():
        deq = np.stack([np.frombuffer(base64.b64decode(r), dtype=np.int8).astype(np.float64) * s
                        for r, s in zip(q["rows"], q["scales"])])
        model.P[kname] = deq
    int8_pred = T.predict(model, frozen_pack, vmap, cfg["tmax"], cfg["route_temperature"])
    agree = sum(1 for aa, bb in zip(float_pred, int8_pred) if aa["route"] == bb["route"]) / len(frozen_pack)
    exp = [r["expected"] for r in frozen_pack]
    int8_full = sum(1 for p, e in zip(int8_pred, exp)
                    if p["route"] == e["route"] and p["authority"] == e["authority"] and p["context"] == e["context"] and p["outcomes"] == (e.get("outcomes") or [])) / len(frozen_pack)
    print(json.dumps({"out": a.out, "bytes": Path(a.out).stat().st_size, "vocab": len(vmap),
                      "float_int8_route_agreement": round(agree, 4), "int8_full_accuracy_blind429": round(int8_full, 4),
                      "model_digest": body["model_digest"]}, indent=1))


if __name__ == "__main__":
    main()
