#!/usr/bin/env python3
"""From-scratch NumPy transformer for factorized Archie routing.

No torch, no sklearn, no deterministic route scaffolding: a word-level
transformer encoder with learned positional embeddings whose CLS state feeds
six supervised heads (route, authority, context, reference type, first
outcome, second outcome). Attachment / memory / thread payloads enter as
ordinary tokens behind learned channel markers, so context handling is a
property of the representation, not of controller code. Composition
("compound" = two ordered outcomes) is label structure the heads must learn.

Backprop is hand-derived and verified by finite differences (--gradcheck).
Training and evaluation run entirely on Linux CPU.
"""
from __future__ import annotations

import argparse, hashlib, json, math, sys, time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "factorized"))
from factorized_controller import generate_dataset, norm_input  # noqa: E402  (vendored generator, provenance in repo)

ROUTES = ["summary", "checklist", "message", "decision", "study", "event", "errands", "objective", "next_action", "plan", "clarify", "compound"]
ACTIVE = [r for r in ROUTES if r not in ("clarify", "compound")]
AUTHORITY = ["allow", "deny"]
CONTEXT = ["ready", "missing", "ambiguous"]
REF = ["none", "attachment", "memory", "thread", "generic_unresolved", "ambiguous"]
OUT1 = ACTIVE + ["<none>"]
OUT2 = ACTIVE + ["<none>"]

SPECIAL = ["<pad>", "<cls>", "<unk>", "<att>", "<mem>", "<thr>", "<sep>"]


def sha(obj) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()


def tokenize(text: str) -> list[str]:
    out, cur = [], []
    for ch in str(text).lower():
        if ch.isalnum() or ch in "'-":
            cur.append(ch)
        else:
            if cur:
                out.append("".join(cur)); cur = []
            if not ch.isspace():
                out.append(ch)
    if cur:
        out.append("".join(cur))
    return out


SUBWORD = True  # emit char-trigram subword tokens so held-out topic words still activate learned features


def _expand(words: list[str], limit: int) -> list[str]:
    out = []
    for w in words[:limit]:
        out.append(w)
        if SUBWORD and len(w) >= 4 and w.isalnum():
            marked = f"^{w}$"
            for i in range(len(marked) - 2):
                out.append("#" + marked[i:i + 3])
    return out


def row_tokens(row: dict) -> list[str]:
    toks = ["<cls>"] + _expand(tokenize(row.get("request", "")), 64)
    for key, marker in (("attachments", "<att>"), ("memory", "<mem>"), ("thread", "<thr>")):
        payload = row.get(key) or ""
        if payload:
            toks += [marker] + _expand(tokenize(payload), 10)
    return toks


def labels_for(row: dict) -> dict:
    exp = row["expected"]
    route = exp["route"]
    outs = exp.get("outcomes") or []
    return {
        "route": ROUTES.index(route),
        "auth": AUTHORITY.index(exp["authority"]),
        "ctx": CONTEXT.index(exp["context"]),
        "ref": REF.index(exp.get("reference_type", "none")) if exp.get("reference_type", "none") in REF else 0,
        "out1": OUT1.index(outs[0]) if outs and outs[0] in ACTIVE else OUT1.index("<none>"),
        "out2": OUT2.index(outs[1]) if len(outs) > 1 and outs[1] in ACTIVE else OUT2.index("<none>"),
    }


# --------------------------------------------------------------------------
# Model: embeddings + N transformer blocks + CLS heads. Adam, hand backprop.
# --------------------------------------------------------------------------
class Model:
    HEADS = {"route": len(ROUTES), "auth": len(AUTHORITY), "ctx": len(CONTEXT), "ref": len(REF), "out1": len(OUT1), "out2": len(OUT2)}
    HEAD_W = {"route": 1.0, "auth": 0.5, "ctx": 0.7, "ref": 0.5, "out1": 0.8, "out2": 0.8}

    def __init__(self, vocab: int, d: int, layers: int, heads: int, tmax: int, seed: int):
        r = np.random.default_rng(seed)
        self.d, self.layers, self.h, self.tmax, self.vocab = d, layers, heads, tmax, vocab
        s = 0.02
        self.P = {"emb": r.normal(0, s, (vocab, d)), "pos": r.normal(0, s, (tmax, d))}
        for l in range(layers):
            self.P[f"qkv{l}"] = r.normal(0, s, (d, 3 * d)); self.P[f"qkvb{l}"] = np.zeros(3 * d)
            self.P[f"ao{l}"] = r.normal(0, s, (d, d)); self.P[f"aob{l}"] = np.zeros(d)
            self.P[f"g1{l}"] = np.ones(d); self.P[f"b1{l}"] = np.zeros(d)
            self.P[f"g2{l}"] = np.ones(d); self.P[f"b2{l}"] = np.zeros(d)
            self.P[f"f1{l}"] = r.normal(0, s, (d, 4 * d)); self.P[f"f1b{l}"] = np.zeros(4 * d)
            self.P[f"f2{l}"] = r.normal(0, s, (4 * d, d)); self.P[f"f2b{l}"] = np.zeros(d)
        self.P["gF"] = np.ones(d); self.P["bF"] = np.zeros(d)
        for name, n in self.HEADS.items():
            self.P[f"H{name}"] = r.normal(0, s, (d, n)); self.P[f"Hb{name}"] = np.zeros(n)
        self.opt = {k: [np.zeros_like(v), np.zeros_like(v)] for k, v in self.P.items()}
        self.t = 0

    def params_count(self):
        return int(sum(v.size for v in self.P.values()))

    @staticmethod
    def _ln_fwd(x, g, b):
        mu = x.mean(-1, keepdims=True); xc = x - mu
        var = (xc * xc).mean(-1, keepdims=True); inv = 1.0 / np.sqrt(var + 1e-5)
        xn = xc * inv
        return xn * g + b, (xn, inv, g)

    @staticmethod
    def _ln_bwd(dy, cache):
        xn, inv, g = cache
        D = xn.shape[-1]
        dg = (dy * xn).sum(axis=tuple(range(dy.ndim - 1)))
        db = dy.sum(axis=tuple(range(dy.ndim - 1)))
        dxn = dy * g
        dx = inv * (dxn - dxn.mean(-1, keepdims=True) - xn * (dxn * xn).mean(-1, keepdims=True))
        return dx, dg, db

    def forward(self, ids, mask, train=False, drop=0.0, rng=None):
        P = self.P; B, T = ids.shape; d, H = self.d, self.h; hd = d // H
        cache = {"ids": ids, "mask": mask, "drops": []}
        x = P["emb"][ids] + P["pos"][:T][None, :, :]
        att_bias = (1.0 - mask)[:, None, None, :] * -1e9  # (B,1,1,T)
        cache["x0"] = x
        for l in range(self.layers):
            ln1, c_ln1 = self._ln_fwd(x, P[f"g1{l}"], P[f"b1{l}"])
            qkv = ln1 @ P[f"qkv{l}"] + P[f"qkvb{l}"]
            q, k, v = np.split(qkv, 3, axis=-1)
            q = q.reshape(B, T, H, hd).transpose(0, 2, 1, 3)
            k = k.reshape(B, T, H, hd).transpose(0, 2, 1, 3)
            v = v.reshape(B, T, H, hd).transpose(0, 2, 1, 3)
            scores = q @ k.transpose(0, 1, 3, 2) / math.sqrt(hd) + att_bias
            scores -= scores.max(-1, keepdims=True)
            e = np.exp(scores); a = e / e.sum(-1, keepdims=True)
            av = a @ v
            avm = av.transpose(0, 2, 1, 3).reshape(B, T, d)
            ao = avm @ P[f"ao{l}"] + P[f"aob{l}"]
            if train and drop > 0:
                dm = (rng.random(ao.shape) >= drop) / (1 - drop); ao = ao * dm; cache["drops"].append(dm)
            else:
                cache["drops"].append(None)
            x = x + ao
            ln2, c_ln2 = self._ln_fwd(x, P[f"g2{l}"], P[f"b2{l}"])
            h1 = ln2 @ P[f"f1{l}"] + P[f"f1b{l}"]
            h1g = np.where(h1 > 0, h1, 0.0)
            ff = h1g @ P[f"f2{l}"] + P[f"f2b{l}"]
            if train and drop > 0:
                dm2 = (rng.random(ff.shape) >= drop) / (1 - drop); ff = ff * dm2; cache["drops"].append(dm2)
            else:
                cache["drops"].append(None)
            x = x + ff
            cache[f"l{l}"] = (ln1, c_ln1, q, k, v, a, avm, ln2, c_ln2, h1, h1g)
            cache[f"x{l+1}"] = x
        xf, c_lnF = self._ln_fwd(x, P["gF"], P["bF"])
        cls = xf[:, 0, :]
        cache["c_lnF"] = c_lnF; cache["cls"] = cls
        logits = {name: cls @ P[f"H{name}"] + P[f"Hb{name}"] for name in self.HEADS}
        return logits, cache

    def loss_and_grads(self, ids, mask, ys, drop, rng, smooth=0.05, head_weights=None):
        weights = head_weights if head_weights is not None else self.HEAD_W
        logits, cache = self.forward(ids, mask, train=True, drop=drop, rng=rng)
        B = ids.shape[0]
        G = {k: np.zeros_like(v) for k, v in self.P.items()}
        dcls = np.zeros_like(cache["cls"])
        total = 0.0
        for name, n in self.HEADS.items():
            z = logits[name]; y = ys[name]
            z = z - z.max(-1, keepdims=True); e = np.exp(z); p = e / e.sum(-1, keepdims=True)
            t = np.full_like(p, smooth / n); t[np.arange(B), y] += 1 - smooth
            total += float(-(t * np.log(p + 1e-12)).sum() / B) * weights[name]
            dz = (p - t) / B * weights[name]
            G[f"H{name}"] += cache["cls"].T @ dz
            G[f"Hb{name}"] += dz.sum(0)
            dcls += dz @ self.P[f"H{name}"].T
        # back through final LN (only CLS row receives gradient)
        d, H = self.d, self.h; hd = d // H; T = ids.shape[1]
        dxf = np.zeros((B, T, d)); dxf[:, 0, :] = dcls
        dx, dg, db = self._ln_bwd(dxf, cache["c_lnF"])
        G["gF"] += dg; G["bF"] += db
        di = 2 * self.layers - 1
        for l in range(self.layers - 1, -1, -1):
            ln1, c_ln1, q, k, v, a, avm, ln2, c_ln2, h1, h1g = cache[f"l{l}"]
            # FFN
            dff = dx.copy()
            dm2 = cache["drops"][di]; di -= 1
            if dm2 is not None: dff = dff * dm2
            G[f"f2{l}"] += h1g.reshape(-1, 4 * d).T @ dff.reshape(-1, d)
            G[f"f2b{l}"] += dff.sum((0, 1))
            dh1 = (dff @ self.P[f"f2{l}"].T) * (h1 > 0)
            G[f"f1{l}"] += ln2.reshape(-1, d).T @ dh1.reshape(-1, 4 * d)
            G[f"f1b{l}"] += dh1.sum((0, 1))
            dln2 = dh1 @ self.P[f"f1{l}"].T
            dx2, dg2, db2 = self._ln_bwd(dln2, c_ln2)
            G[f"g2{l}"] += dg2; G[f"b2{l}"] += db2
            dx = dx + dx2
            # attention
            dao = dx.copy()
            dm = cache["drops"][di]; di -= 1
            if dm is not None: dao = dao * dm
            G[f"ao{l}"] += avm.reshape(-1, d).T @ dao.reshape(-1, d)
            G[f"aob{l}"] += dao.sum((0, 1))
            davm = dao @ self.P[f"ao{l}"].T
            dav = davm.reshape(B, T, H, hd).transpose(0, 2, 1, 3)
            da = dav @ v.transpose(0, 1, 3, 2)
            dv = a.transpose(0, 1, 3, 2) @ dav
            ds = a * (da - (da * a).sum(-1, keepdims=True)) / math.sqrt(hd)
            dq = ds @ k
            dk = ds.transpose(0, 1, 3, 2) @ q
            dqkv = np.concatenate([
                dq.transpose(0, 2, 1, 3).reshape(B, T, d),
                dk.transpose(0, 2, 1, 3).reshape(B, T, d),
                dv.transpose(0, 2, 1, 3).reshape(B, T, d)], axis=-1)
            G[f"qkv{l}"] += ln1.reshape(-1, d).T @ dqkv.reshape(-1, 3 * d)
            G[f"qkvb{l}"] += dqkv.sum((0, 1))
            dln1 = dqkv @ self.P[f"qkv{l}"].T
            dx1, dg1, db1 = self._ln_bwd(dln1, c_ln1)
            G[f"g1{l}"] += dg1; G[f"b1{l}"] += db1
            dx = dx + dx1
        # embeddings
        np.add.at(G["emb"], cache["ids"], dx)
        G["pos"][:T] += dx.sum(0)
        return total, G

    def step(self, grads, lr, wd=1e-4):
        self.t += 1
        b1, b2, eps = 0.9, 0.98, 1e-9
        c1 = 1 - b1 ** self.t; c2 = 1 - b2 ** self.t
        for kname, g in grads.items():
            if kname not in ("gF", "bF") and not kname.startswith(("g1", "g2", "b1", "b2", "Hb", "qkvb", "aob", "f1b", "f2b")):
                g = g + wd * self.P[kname]
            m, v = self.opt[kname]
            m[:] = b1 * m + (1 - b1) * g
            v[:] = b2 * v + (1 - b2) * g * g
            self.P[kname] -= lr * (m / c1) / (np.sqrt(v / c2) + eps)


# --------------------------------------------------------------------------
def build_vocab(rows, min_count=2):
    from collections import Counter
    c = Counter()
    for row in rows:
        for t in row_tokens(row):
            c[t] += 1
    vocab = SPECIAL + sorted(t for t, n in c.items() if n >= min_count and t not in SPECIAL)
    return {t: i for i, t in enumerate(vocab)}


def encode_batch(rows, vmap, tmax):
    B = len(rows)
    ids = np.zeros((B, tmax), dtype=np.int64)
    mask = np.zeros((B, tmax))
    for i, row in enumerate(rows):
        toks = row_tokens(row)[:tmax]
        for j, t in enumerate(toks):
            ids[i, j] = vmap.get(t, vmap["<unk>"])
        mask[i, :len(toks)] = 1.0
    return ids, mask


def predict(model, rows, vmap, tmax, temperature=1.0, bs=256):
    preds = []
    for s in range(0, len(rows), bs):
        chunk = rows[s:s + bs]
        ids, mask = encode_batch(chunk, vmap, tmax)
        logits, _ = model.forward(ids, mask)
        soft = {}
        for name in Model.HEADS:
            z = logits[name] / (temperature if name == "route" else 1.0)
            z = z - z.max(-1, keepdims=True); e = np.exp(z)
            soft[name] = e / e.sum(-1, keepdims=True)
        for i in range(len(chunk)):
            route_i = int(soft["route"][i].argmax())
            route = ROUTES[route_i]
            auth = AUTHORITY[int(soft["auth"][i].argmax())]
            ctx = CONTEXT[int(soft["ctx"][i].argmax())]
            o1 = OUT1[int(soft["out1"][i].argmax())]
            o2 = OUT2[int(soft["out2"][i].argmax())]
            if route == "clarify":
                outcomes = []
            elif route == "compound":
                outcomes = [o for o in (o1, o2) if o != "<none>"]
                if len(outcomes) < 2:  # heads disagree with route: fall back to top-2 active outcome probs
                    order = np.argsort(-soft["out1"][i][:len(ACTIVE)])
                    outcomes = [OUT1[int(order[0])], OUT2[int(np.argsort(-soft["out2"][i][:len(ACTIVE)])[0])]]
            else:
                outcomes = [route]
            preds.append({
                "route": route, "authority": auth, "context": ctx, "outcomes": outcomes,
                "confidence": float(soft["route"][i][route_i]),
            })
    return preds


def evaluate_pack(model, rows, vmap, tmax, temperature):
    preds = predict(model, rows, vmap, tmax, temperature)
    errors = []
    conf_ok, conf_bad = [], []
    full = route_only = 0
    for row, pr in zip(rows, preds):
        exp = row["expected"]
        r_ok = pr["route"] == exp["route"]
        ok = r_ok and pr["authority"] == exp["authority"] and pr["context"] == exp["context"] and pr["outcomes"] == (exp.get("outcomes") or [])
        route_only += int(r_ok); full += int(ok)
        (conf_ok if ok else conf_bad).append(pr["confidence"])
        if not ok:
            errors.append({"id": row.get("id"), "category": row.get("category"), "expected": exp, "actual": pr})
    n = max(1, len(rows))
    return {
        "examples": len(rows),
        "full_accuracy": round(full / n, 6),
        "route_accuracy": round(route_only / n, 6),
        "mean_confidence_correct": round(float(np.mean(conf_ok)), 4) if conf_ok else None,
        "mean_confidence_incorrect": round(float(np.mean(conf_bad)), 4) if conf_bad else None,
        "errors": errors[:40],
    }


def legacy_rows(path):
    rows = []
    for line in Path(path).read_text().strip().splitlines():
        o = json.loads(line)
        rows.append({"id": o["id"], "request": o["text"],
                     "expected": {"route": o["expected"], "authority": "allow", "context": "ready",
                                  "outcomes": [] if o["expected"] == "clarify" else None, "reference_type": "none"}})
    return rows


def eval_legacy(model, rows, vmap, tmax, temperature):
    preds = predict(model, rows, vmap, tmax, temperature)
    ok = sum(1 for row, pr in zip(rows, preds) if pr["route"] == row["expected"]["route"])
    return {"examples": len(rows), "route_accuracy": round(ok / max(1, len(rows)), 6)}


def gradcheck(seed=7):
    rng = np.random.default_rng(seed)
    m = Model(vocab=30, d=16, layers=2, heads=2, tmax=9, seed=seed)
    ids = rng.integers(0, 30, (3, 9)); mask = np.ones((3, 9)); mask[0, 6:] = 0
    ys = {"route": np.array([0, 3, 11]), "auth": np.array([0, 1, 0]), "ctx": np.array([0, 1, 2]),
          "ref": np.array([0, 2, 4]), "out1": np.array([0, 5, 10]), "out2": np.array([10, 2, 10])}
    _, G = m.loss_and_grads(ids, mask, ys, drop=0.0, rng=rng)
    worst = 0.0
    for name in ["emb", "pos", "qkv0", "ao1", "g1_0" if False else "g10", "f11", "Hroute", "gF"]:
        key = name if name in m.P else name.replace("g10", "g10")
        if key not in m.P:
            continue
        Pk = m.P[key]
        flat = Pk.reshape(-1)
        idxs = rng.integers(0, flat.size, 6)
        for ii in idxs:
            eps = 1e-5
            old = flat[ii]
            flat[ii] = old + eps; l1, _ = m.loss_and_grads(ids, mask, ys, 0.0, rng)
            flat[ii] = old - eps; l2, _ = m.loss_and_grads(ids, mask, ys, 0.0, rng)
            flat[ii] = old
            num = (l1 - l2) / (2 * eps)
            ana = G[key].reshape(-1)[ii]
            rel = abs(num - ana) / max(1e-6, abs(num) + abs(ana))
            worst = max(worst, rel)
    print(json.dumps({"gradcheck_max_rel_err": float(worst), "pass": bool(worst < 2e-3)}))
    return bool(worst < 2e-3)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gradcheck", action="store_true")
    ap.add_argument("--seed", type=int, default=424243)
    ap.add_argument("--d", type=int, default=96)
    ap.add_argument("--layers", type=int, default=2)
    ap.add_argument("--heads", type=int, default=4)
    ap.add_argument("--tmax", type=int, default=48)
    ap.add_argument("--epochs", type=int, default=6)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--lr", type=float, default=2.5e-3)
    ap.add_argument("--drop", type=float, default=0.10)
    ap.add_argument("--scale", type=int, default=6, help="multiplier over the upstream corpus counts")
    ap.add_argument("--real-rows", default="")
    ap.add_argument("--real-repeat", type=int, default=1, help="oversampling factor for real-language rows")
    ap.add_argument("--finetune-epochs", type=int, default=0, help="extra epochs training ONLY on real-language rows, route head only, after main training")
    ap.add_argument("--finetune-lr", type=float, default=0.0, help="LR for the finetune phase (default: main lr * 0.15)")
    ap.add_argument("--legacy-dir", default="")
    ap.add_argument("--frozen-pack", default=str(HERE.parent / "factorized" / "blind-challenge-pack.frozen.json"))
    ap.add_argument("--out", default=str(HERE / "runs"))
    ap.add_argument("--tag", default="npt-v1")
    a = ap.parse_args()

    if a.gradcheck:
        sys.exit(0 if gradcheck() else 1)

    t0 = time.time()
    k = a.scale
    train = generate_dataset(a.seed + 1, "train", n_single=800 * k, n_ref_each=80 * k, n_compound=160 * k, n_authority_each=80 * k, n_ambiguous=80 * k)
    dev = generate_dataset(a.seed + 2, "dev", n_single=240, n_ref_each=32, n_compound=72, n_authority_each=32, n_ambiguous=32)

    # Real-language governed rows (text-only; deterministic auxiliary labels).
    real_count = 0
    if a.real_rows:
        real = json.loads(Path(a.real_rows).read_text()) * max(1, a.real_repeat)
        for row in real:
            route = row["route"]
            train.append({"id": f"real-{real_count}", "category": "real_language", "request": row["prompt"],
                          "attachments": "", "memory": "", "thread": "",
                          "expected": {"route": route if route != "compound" else "compound",
                                        "authority": "allow",
                                        "context": "ambiguous" if route == "clarify" else "ready",
                                        "reference_type": "none",
                                        "outcomes": [] if route == "clarify" else ([route] if route != "compound" else [])}})
            real_count += 1

    # Freeze-boundary hygiene: drop any training/dev row whose normalized text
    # collides with the frozen 429 pack or the legacy frozen suites.
    frozen_pack = json.loads(Path(a.frozen_pack).read_text())
    if isinstance(frozen_pack, dict):
        frozen_pack = [frozen_pack[key] for key in sorted(frozen_pack, key=lambda s: int(s))]
    frozen_texts = {norm_input(r) for r in frozen_pack}
    legacy_suites = {}
    if a.legacy_dir:
        for name in ["router-v2-original-heldout", "router-real-v2-heldout", "router-real-v3-final"]:
            p = Path(a.legacy_dir) / f"{name}.jsonl"
            if p.exists():
                legacy_suites[name] = legacy_rows(p)
                frozen_texts |= {norm_input(r) for r in legacy_suites[name]}
    before = len(train)
    train = [r for r in train if norm_input(r) not in frozen_texts]
    dev = [r for r in dev if norm_input(r) not in frozen_texts]
    dropped = before - len(train)

    vmap = build_vocab(train)
    ys_all = [labels_for(r) for r in train]
    model = Model(len(vmap), a.d, a.layers, a.heads, a.tmax, a.seed)
    rng = np.random.default_rng(a.seed + 99)
    order = np.arange(len(train))
    steps_per = math.ceil(len(train) / a.batch)
    total_steps = steps_per * a.epochs
    print(json.dumps({"train_rows": len(train), "real_rows": real_count, "dropped_frozen_collisions": dropped,
                      "vocab": len(vmap), "params": model.params_count(), "steps": total_steps}), flush=True)

    step = 0
    for ep in range(a.epochs):
        rng.shuffle(order)
        ep_loss = 0.0
        for s in range(steps_per):
            sel = order[s * a.batch:(s + 1) * a.batch]
            rows = [train[i] for i in sel]
            ids, mask = encode_batch(rows, vmap, a.tmax)
            ys = {name: np.array([ys_all[i][name] for i in sel]) for name in Model.HEADS}
            warm = min(1.0, (step + 1) / max(1, int(0.06 * total_steps)))
            cos = 0.5 * (1 + math.cos(math.pi * step / max(1, total_steps)))
            lr = a.lr * warm * (0.08 + 0.92 * cos)
            loss, G = model.loss_and_grads(ids, mask, ys, a.drop, rng)
            model.step(G, lr)
            ep_loss += loss; step += 1
        dev_eval = evaluate_pack(model, dev, vmap, a.tmax, 1.0)
        print(json.dumps({"epoch": ep + 1, "mean_loss": round(ep_loss / steps_per, 4),
                          "dev_full": dev_eval["full_accuracy"], "dev_route": dev_eval["route_accuracy"],
                          "minutes": round((time.time() - t0) / 60, 1)}), flush=True)

    # Real-language-only fine-tune phase (route head only; curriculum test for
    # register transfer). auth/context/ref/out1/out2 weights are zeroed here
    # because real rows carry only heuristic placeholder labels for those
    # heads (almost uniformly allow/ready/none) -- training them further would
    # teach a false uniform prior, not real supervision.
    real_indices = [i for i, r in enumerate(train) if r.get("category") == "real_language"]
    if a.finetune_epochs > 0 and real_indices:
        # Checkpoint the pre-finetune weights so the fine-tune phase can be
        # isolated and evaluated independently later (run C's evaluation
        # conflated corpus-mix and finetune-phase effects; this is the fix).
        pre_ft_dir = Path(a.out); pre_ft_dir.mkdir(parents=True, exist_ok=True)
        pre_ft_path = pre_ft_dir / f"{a.tag}-seed{a.seed}-pre-finetune.npz"
        np.savez_compressed(pre_ft_path, **model.P)
        print(json.dumps({"pre_finetune_checkpoint": pre_ft_path.name}), flush=True)
        ft_lr = a.finetune_lr if a.finetune_lr > 0 else a.lr * 0.15
        ft_weights = {"route": 1.0, "auth": 0.0, "ctx": 0.0, "ref": 0.0, "out1": 0.0, "out2": 0.0}
        ft_order = np.array(real_indices)
        ft_steps = math.ceil(len(ft_order) / a.batch)
        print(json.dumps({"finetune_start": True, "real_only_rows": len(ft_order), "lr": ft_lr, "epochs": a.finetune_epochs}), flush=True)
        for ep in range(a.finetune_epochs):
            rng.shuffle(ft_order)
            ep_loss = 0.0
            for s in range(ft_steps):
                sel = ft_order[s * a.batch:(s + 1) * a.batch]
                rows = [train[i] for i in sel]
                ids, mask = encode_batch(rows, vmap, a.tmax)
                ys = {name: np.array([ys_all[i][name] for i in sel]) for name in Model.HEADS}
                loss, G = model.loss_and_grads(ids, mask, ys, a.drop * 0.5, rng, head_weights=ft_weights)
                model.step(G, ft_lr)
                ep_loss += loss
            dev_eval = evaluate_pack(model, dev, vmap, a.tmax, 1.0)
            print(json.dumps({"finetune_epoch": ep + 1, "mean_loss": round(ep_loss / ft_steps, 4),
                              "dev_full": dev_eval["full_accuracy"], "dev_route": dev_eval["route_accuracy"],
                              "minutes": round((time.time() - t0) / 60, 1)}), flush=True)

    # Route temperature on dev NLL.
    best_t, best_nll = 1.0, 1e9
    dev_ids, dev_mask = encode_batch(dev, vmap, a.tmax)
    logits, _ = model.forward(dev_ids, dev_mask)
    yroute = np.array([labels_for(r)["route"] for r in dev])
    for t in np.linspace(0.6, 2.0, 15):
        z = logits["route"] / t; z = z - z.max(-1, keepdims=True)
        p = np.exp(z); p = p / p.sum(-1, keepdims=True)
        nll = float(-np.log(p[np.arange(len(dev)), yroute] + 1e-12).mean())
        if nll < best_nll:
            best_nll, best_t = nll, float(t)

    results = {"blind_429": evaluate_pack(model, frozen_pack, vmap, a.tmax, best_t)}
    for name, rows in legacy_suites.items():
        results[name] = eval_legacy(model, rows, vmap, a.tmax, best_t)

    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    weights_path = out / f"{a.tag}-seed{a.seed}.npz"
    np.savez_compressed(weights_path, **model.P)
    receipt = {
        "schema": "archie-np-transformer-receipt/v1",
        "tag": a.tag,
        "config": {"d": a.d, "layers": a.layers, "heads": a.heads, "tmax": a.tmax, "epochs": a.epochs,
                    "batch": a.batch, "lr": a.lr, "dropout": a.drop, "scale": a.scale, "seed": a.seed,
                    "subword": SUBWORD, "route_temperature": best_t,
                    "real_repeat": a.real_repeat, "finetune_epochs": a.finetune_epochs,
                    "finetune_lr": (a.finetune_lr if a.finetune_lr > 0 else a.lr * 0.15) if a.finetune_epochs > 0 else None,
                    "curriculum": "real-language-dominant mix + real-only route-head finetune phase" if a.finetune_epochs > 0 else "single-phase mixed synthetic+real"},
        "data": {"train_rows": len(train), "real_language_rows": real_count, "dev_rows": len(dev),
                 "dropped_frozen_collisions": dropped, "vocab": len(vmap),
                 "vocab_tokens": sorted(vmap, key=vmap.get),
                 "real_repeat": a.real_repeat,
                 "train_digest": sha([norm_input(r) for r in train[:2000]])},
        "model": {"parameters": model.params_count(),
                  "weights_file": weights_path.name,
                  "weights_sha256": hashlib.sha256(weights_path.read_bytes()).hexdigest()},
        "frozen_pack_sha256": hashlib.sha256(Path(a.frozen_pack).read_bytes()).hexdigest(),
        "results": results,
        "minutes": round((time.time() - t0) / 60, 1),
        "promotion": "not-admitted",
        "claim_boundary": "From-scratch NumPy transformer; heads learn factorized judgments from tokens alone. No deterministic route scaffolding at inference. Frozen texts excluded from training by normalized match.",
    }
    receipt["receipt_digest"] = sha(receipt)
    (out / f"{a.tag}-seed{a.seed}-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"done": True, "results": {k: {kk: vv for kk, vv in v.items() if kk != 'errors'} for k, v in results.items()},
                      "route_temperature": best_t, "minutes": receipt["minutes"]}, indent=1), flush=True)


if __name__ == "__main__":
    main()
