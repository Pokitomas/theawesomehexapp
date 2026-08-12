#!/usr/bin/env python3
"""Counterexample-guided compiler for compact sufficient state relations.

The preceding relational-lift court still gave the architect a tiny menu of
features.  This court removes that menu.  It enumerates a bounded expression
grammar over the actually observed state transition, scores every expression
only by held-out consequence prediction plus description length, then trains a
latent operator selector on the cheapest winning expression.

The adversarial ecology rotates every ambiguous +/-rotation pair by an
independent random global angle.  That destroys a stable x/y shortcut while
preserving geometric relations.  A coordinate feature can therefore win only
if it genuinely generalizes across orientations.  Hand action labels are kept
out of synthesis and optimization and are exposed only after the model is
frozen as a diagnostic.

This is deliberately a *compiler court*, not a universal representation
learner.  The finite grammar is tiny.  The recursive ambition is that a failed
court yields a counterexample which expands the grammar, rather than a human
silently widening the model state.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import math
import random
import statistics
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import torch
import torch.nn as nn
import torch.nn.functional as F

HERE = Path(__file__).resolve().parent
ABLATION_PATH = HERE / "operator_delta_ablation.py"


def load_ablation():
    spec = importlib.util.spec_from_file_location("archie_grammar_ablation", ABLATION_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {ABLATION_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


A = load_ablation()
CORE = A.CORE


@dataclass(frozen=True)
class Expr:
    op: str
    left: "Expr | None" = None
    right: "Expr | None" = None
    atom: str = ""

    @property
    def cost(self) -> int:
        if self.op == "atom":
            return 1
        assert self.left is not None and self.right is not None
        return 1 + self.left.cost + self.right.cost

    @property
    def text(self) -> str:
        if self.op == "atom":
            return self.atom
        assert self.left is not None and self.right is not None
        symbol = {"mul": "*", "add": "+", "sub": "-"}[self.op]
        return f"({self.left.text}{symbol}{self.right.text})"


def atom(name: str) -> Expr:
    return Expr("atom", atom=name)


def binary(op: str, left: Expr, right: Expr) -> Expr:
    return Expr(op, left=left, right=right)


ATOMS = tuple(atom(x) for x in ("z0x", "z0y", "dx", "dy"))


def expression_grammar() -> list[Expr]:
    """Enumerate a finite degree-2 relational grammar without eval()."""
    monomials: list[Expr] = list(ATOMS)
    for i, left in enumerate(ATOMS):
        for right in ATOMS[i:]:
            monomials.append(binary("mul", left, right))

    expressions: dict[str, Expr] = {x.text: x for x in monomials}
    # Pairwise sums/differences are enough to contain wedge/cross, dot product,
    # radial differences, coordinate-weighted deltas, and many bad hypotheses.
    for i, left in enumerate(monomials):
        for right in monomials[i + 1:]:
            for op in ("add", "sub"):
                expr = binary(op, left, right)
                expressions.setdefault(expr.text, expr)
    return sorted(expressions.values(), key=lambda x: (x.cost, x.text))


def evaluate(expr: Expr, z0: torch.Tensor, z1: torch.Tensor) -> torch.Tensor:
    d = z1 - z0
    if expr.op == "atom":
        values = {
            "z0x": z0[:, 0],
            "z0y": z0[:, 1],
            "dx": d[:, 0],
            "dy": d[:, 1],
        }
        return values[expr.atom]
    assert expr.left is not None and expr.right is not None
    left = evaluate(expr.left, z0, z1)
    right = evaluate(expr.right, z0, z1)
    if expr.op == "mul":
        return left * right
    if expr.op == "add":
        return left + right
    if expr.op == "sub":
        return left - right
    raise ValueError(expr.op)


@dataclass
class Sample:
    before: torch.Tensor
    after: torch.Tensor
    effect: str  # diagnostic only


def rotation(theta: float) -> torch.Tensor:
    c, s = math.cos(theta), math.sin(theta)
    return torch.tensor([[c, -s], [s, c]], dtype=torch.float32)


def build_random_frame_collision_groups(seed: int, pairs: int, theta: float) -> list[list[Sample]]:
    """Identical-delta twins in a fresh random orientation for every pair."""
    rng = random.Random(seed)
    gen = torch.Generator().manual_seed(seed ^ 0xA11CE)
    q_plus = rotation(theta)
    q_minus = rotation(-theta)
    eye = torch.eye(2)
    inv_plus = torch.linalg.inv(q_plus - eye)
    inv_minus = torch.linalg.inv(q_minus - eye)
    groups: list[list[Sample]] = []
    for _ in range(pairs):
        d = torch.randn(2, generator=gen) * 0.9
        d = d + torch.sign(d + 1e-6) * 0.15
        x_plus = inv_plus @ d
        x_minus = inv_minus @ d
        a_plus = q_plus @ x_plus
        a_minus = q_minus @ x_minus

        # Independent frame rotation per collision group.  Both twins receive
        # the same frame, so their displacements remain equal.  No global x/y
        # coordinate can consistently identify the latent operator.
        frame = rotation(rng.uniform(-math.pi, math.pi))
        groups.append([
            Sample(frame @ x_plus, frame @ a_plus, "rot_plus"),
            Sample(frame @ x_minus, frame @ a_minus, "rot_minus"),
        ])
    rng.shuffle(groups)
    return groups


def split_groups(groups: list[list[Sample]]) -> tuple[list[Sample], list[Sample], list[Sample]]:
    n = len(groups)
    n_train = max(1, int(n * 0.62))
    n_val = max(1, int(n * 0.18))
    if n_train + n_val >= n:
        n_val = max(1, n - n_train - 1)
    flatten = lambda xs: [sample for group in xs for sample in group]
    return (
        flatten(groups[:n_train]),
        flatten(groups[n_train:n_train + n_val]),
        flatten(groups[n_train + n_val:]),
    )


def stack(samples: Iterable[Sample]) -> tuple[torch.Tensor, torch.Tensor, list[str]]:
    rows = list(samples)
    return (
        torch.stack([x.before for x in rows]),
        torch.stack([x.after for x in rows]),
        [x.effect for x in rows],
    )


def fit_scale(before: torch.Tensor, after: torch.Tensor) -> float:
    all_states = torch.cat([before, after], dim=0)
    return max(float(torch.sqrt((all_states * all_states).mean()).item()), 1e-4)


def feature_stats(expr: Expr, z0: torch.Tensor, z1: torch.Tensor) -> tuple[float, float]:
    raw = evaluate(expr, z0, z1)
    mean = float(raw.mean().item())
    std = max(float(raw.std(unbiased=False).item()), 1e-4)
    return mean, std


def probe_design(expr: Expr, z0: torch.Tensor, z1: torch.Tensor, mean: float, std: float) -> torch.Tensor:
    d = z1 - z0
    raw = (evaluate(expr, z0, z1) - mean) / std
    # Generic saturating readout lets an expression encode a discrete regime
    # without hand-writing a class label.  Interactions with d permit a linear
    # least-squares probe to express different linear operators per regime.
    s = torch.tanh(3.0 * raw)
    ones = torch.ones_like(raw)
    return torch.stack(
        [
            ones,
            d[:, 0], d[:, 1],
            raw, s,
            raw * d[:, 0], raw * d[:, 1],
            s * d[:, 0], s * d[:, 1],
        ],
        dim=1,
    )


def ridge_fit(x: torch.Tensor, y: torch.Tensor, l2: float = 1e-4) -> torch.Tensor:
    eye = torch.eye(x.shape[1], dtype=x.dtype, device=x.device)
    return torch.linalg.solve(x.T @ x + l2 * eye, x.T @ y)


def probe_mse(expr: Expr, train_b: torch.Tensor, train_a: torch.Tensor, val_b: torch.Tensor, val_a: torch.Tensor) -> dict[str, float]:
    mean, std = feature_stats(expr, train_b, train_a)
    xt = probe_design(expr, train_b, train_a, mean, std)
    xv = probe_design(expr, val_b, val_a, mean, std)
    weights = ridge_fit(xt, train_a)
    train_pred = xt @ weights
    val_pred = xv @ weights
    return {
        "feature_mean": mean,
        "feature_std": std,
        "train_mse": float(F.mse_loss(train_pred, train_a).item()),
        "validation_mse": float(F.mse_loss(val_pred, val_a).item()),
    }


def compile_expression(
    train_b: torch.Tensor,
    train_a: torch.Tensor,
    val_b: torch.Tensor,
    val_a: torch.Tensor,
    *,
    complexity_lambda: float,
) -> tuple[Expr, list[dict[str, Any]]]:
    rows: list[dict[str, Any]] = []
    for expr in expression_grammar():
        stats = probe_mse(expr, train_b, train_a, val_b, val_a)
        if not all(math.isfinite(float(v)) for v in stats.values()):
            continue
        objective = stats["validation_mse"] + complexity_lambda * expr.cost
        rows.append({
            "expression": expr.text,
            "cost": expr.cost,
            "objective": objective,
            **stats,
        })
    if not rows:
        raise RuntimeError("grammar produced no finite candidate")
    rows.sort(key=lambda r: (r["objective"], r["cost"], r["expression"]))
    winner_text = rows[0]["expression"]
    winner = next(x for x in expression_grammar() if x.text == winner_text)
    return winner, rows


class GrammarInverse(nn.Module):
    def __init__(self, dim: int, codes: int, expr: Expr, mean: float, std: float, width: int = 64):
        super().__init__()
        self.expr = expr
        self.register_buffer("feature_mean", torch.tensor(float(mean)))
        self.register_buffer("feature_std", torch.tensor(float(std)))
        self.net = nn.Sequential(
            nn.Linear(dim + 1, width),
            nn.SiLU(),
            nn.Linear(width, width),
            nn.SiLU(),
            nn.Linear(width, codes),
        )

    def forward(self, z0: torch.Tensor, z1: torch.Tensor) -> torch.Tensor:
        d = z1 - z0
        f = (evaluate(self.expr, z0, z1) - self.feature_mean) / self.feature_std
        return self.net(torch.cat([d, f[:, None]], dim=-1))


class GrammarCore(nn.Module):
    def __init__(self, dim: int, codes: int, expr: Expr, mean: float, std: float):
        super().__init__()
        self.bank = CORE.CayleyActionBank(codes, dim)
        self.inverse = GrammarInverse(dim, codes, expr, mean, std)

    def forward(self, z0: torch.Tensor, z1: torch.Tensor, temperature: float) -> dict[str, torch.Tensor]:
        logits = self.inverse(z0, z1)
        probs = F.softmax(logits / temperature, dim=-1)
        candidates = self.bank.forward_all(z0)
        prediction = torch.einsum("bk,bkd->bd", probs, candidates)
        recovered = torch.einsum("bk,bkd->bd", probs, self.bank.inverse_all(z1))
        return {"logits": logits, "probs": probs, "prediction": prediction, "recovered": recovered}


def train_model(model: nn.Module, before: torch.Tensor, after: torch.Tensor, *, epochs: int, lr: float) -> nn.Module:
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    for epoch in range(epochs):
        progress = epoch / max(1, epochs - 1)
        temperature = 1.0 * (1.0 - progress) + 0.07 * progress
        out = model(before, after, temperature)
        fwd = F.mse_loss(out["prediction"], after)
        inv = F.mse_loss(out["recovered"], before)
        probs = out["probs"]
        entropy = -(probs * probs.clamp_min(1e-9).log()).sum(-1).mean()
        usage = probs.mean(0)
        balance = F.mse_loss(usage, torch.full_like(usage, 1.0 / usage.numel()))
        loss = fwd + 0.5 * inv + 0.02 * entropy + 0.2 * balance
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
        opt.step()
    model.eval()
    return model


def mse(model: nn.Module, before: torch.Tensor, after: torch.Tensor) -> tuple[float, float]:
    with torch.no_grad():
        out = model(before, after, 0.04)
        return (
            float(F.mse_loss(out["prediction"], after).item()),
            float(F.mse_loss(out["recovered"], before).item()),
        )


def effect_diag(model: GrammarCore, before: torch.Tensor, after: torch.Tensor, labels: list[str]) -> dict[str, float | int]:
    with torch.no_grad():
        assignments = model.inverse(before, after).argmax(-1).cpu().tolist()
    return {
        "used_codes": len(set(assignments)),
        "effect_nmi_grading_only": CORE.normalized_mutual_information(assignments, labels),
        "effect_purity_grading_only": CORE.purity(assignments, labels),
        "operator_orthogonality_max_abs_error": model.bank.orthogonality_error(),
    }


def run_seed(
    seed: int,
    *,
    pairs: int,
    theta: float,
    codes: int,
    epochs: int,
    lr: float,
    complexity_lambda: float,
    device: str,
) -> dict[str, Any]:
    groups = build_random_frame_collision_groups(seed, pairs, theta)
    train_rows, val_rows, test_rows = split_groups(groups)
    train_b0, train_a0, _ = stack(train_rows)
    val_b0, val_a0, _ = stack(val_rows)
    test_b0, test_a0, test_labels = stack(test_rows)
    scale = fit_scale(train_b0, train_a0)
    train_b, train_a = train_b0 / scale, train_a0 / scale
    val_b, val_a = val_b0 / scale, val_a0 / scale
    test_b, test_a = test_b0 / scale, test_a0 / scale

    winner, search = compile_expression(
        train_b, train_a, val_b, val_a, complexity_lambda=complexity_lambda
    )
    full_b = torch.cat([train_b, val_b], dim=0)
    full_a = torch.cat([train_a, val_a], dim=0)
    mean, std = feature_stats(winner, full_b, full_a)
    dev = torch.device(device)
    full_b, full_a = full_b.to(dev), full_a.to(dev)
    test_b, test_a = test_b.to(dev), test_a.to(dev)

    def reset(offset: int) -> None:
        random.seed(seed ^ offset)
        torch.manual_seed(seed ^ offset)

    reset(0xC011)
    grammar = train_model(GrammarCore(2, codes, winner, mean, std).to(dev), full_b, full_a, epochs=epochs, lr=lr)
    reset(0xC011)
    delta = train_model(A.AblationCore(2, codes, "delta-only").to(dev), full_b, full_a, epochs=epochs, lr=lr)
    reset(0xC011)
    endpoint = train_model(A.AblationCore(2, codes, "endpoint+delta").to(dev), full_b, full_a, epochs=epochs, lr=lr)

    grammar_f, grammar_i = mse(grammar, test_b, test_a)
    delta_f, delta_i = mse(delta, test_b, test_a)
    endpoint_f, endpoint_i = mse(endpoint, test_b, test_a)
    diag = effect_diag(grammar, test_b, test_a, test_labels)
    return {
        "seed": seed,
        "pairs": pairs,
        "grammar_size": len(expression_grammar()),
        "selected_expression": winner.text,
        "selected_cost": winner.cost,
        "search_top10": search[:10],
        "grammar_test_forward_mse": grammar_f,
        "grammar_test_inverse_mse": grammar_i,
        "delta_test_forward_mse": delta_f,
        "delta_test_inverse_mse": delta_i,
        "endpoint_test_forward_mse": endpoint_f,
        "endpoint_test_inverse_mse": endpoint_i,
        "grammar_over_delta_forward_mse": grammar_f / max(delta_f, 1e-12),
        "grammar_over_endpoint_forward_mse": grammar_f / max(endpoint_f, 1e-12),
        "selector_input_widths": {"delta": 2, "compiled": 3, "endpoint_delta": 6},
        **diag,
        "valid": bool(
            math.isfinite(grammar_f)
            and diag["used_codes"] >= 2
            and float(diag["operator_orthogonality_max_abs_error"]) < 1e-4
        ),
    }


def run_court(
    seeds: list[int],
    *,
    pairs: int,
    theta: float,
    codes: int,
    epochs: int,
    lr: float,
    complexity_lambda: float,
    device: str,
) -> dict[str, Any]:
    runs = [run_seed(
        seed,
        pairs=pairs,
        theta=theta,
        codes=codes,
        epochs=epochs,
        lr=lr,
        complexity_lambda=complexity_lambda,
        device=device,
    ) for seed in seeds]
    gd = [r["grammar_over_delta_forward_mse"] for r in runs]
    ge = [r["grammar_over_endpoint_forward_mse"] for r in runs]
    nmi = [float(r["effect_nmi_grading_only"]) for r in runs]
    # No expression name is hard-coded into PASS.  The compiler is graded by
    # consequences, compactness, and post-freeze effect structure only.
    passed = bool(
        all(r["valid"] for r in runs)
        and statistics.median(gd) <= 0.40
        and statistics.median(ge) <= 1.35
        and statistics.median(nmi) >= 0.55
        and sum(float(r["grammar_over_delta_forward_mse"]) <= 0.55 for r in runs) >= len(runs) - 1
        and all(r["selector_input_widths"]["compiled"] < r["selector_input_widths"]["endpoint_delta"] for r in runs)
    )
    return {
        "schema": "archie-action-latent/representation-grammar-compiler-v1",
        "pass": passed,
        "seeds": seeds,
        "runs": runs,
        "selected_expressions": [r["selected_expression"] for r in runs],
        "median_compiled_over_delta_forward_mse": statistics.median(gd),
        "median_compiled_over_endpoint_forward_mse": statistics.median(ge),
        "median_effect_nmi_grading_only": statistics.median(nmi),
        "grammar_size": runs[0]["grammar_size"] if runs else 0,
        "compiled_selector_width": 3,
        "endpoint_selector_width": 6,
        "architectural_consequence": (
            "Counterexamples can drive representation growth without immediately widening resident state. A finite compiler searches low-description-length relations, "
            "grades them only by held-out consequences, and hands the smallest winner to the action operator. The next escalation is to let failed receipts extend the grammar itself."
        ),
        "claim_boundary": (
            "PASS means this bounded grammar compiler found a compact relation that survived random coordinate frames in this paired-rotation ecology. It does not establish universal sufficient-statistic discovery or autonomous theorem invention."
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seeds", default="11001,11002,11003")
    parser.add_argument("--pairs", type=int, default=280)
    parser.add_argument("--theta-deg", type=float, default=60.0)
    parser.add_argument("--codes", type=int, default=4)
    parser.add_argument("--epochs", type=int, default=140)
    parser.add_argument("--lr", type=float, default=3e-3)
    parser.add_argument("--complexity-lambda", type=float, default=2e-4)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--output")
    args = parser.parse_args()
    result = run_court(
        [int(x.strip()) for x in args.seeds.split(",") if x.strip()],
        pairs=args.pairs,
        theta=math.radians(args.theta_deg),
        codes=args.codes,
        epochs=args.epochs,
        lr=args.lr,
        complexity_lambda=args.complexity_lambda,
        device=args.device,
    )
    text = json.dumps(result, indent=2, sort_keys=True)
    if args.output:
        path = Path(args.output).expanduser().resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text + "\n", "utf-8")
    print(text)
    raise SystemExit(0 if result["pass"] else 1)


if __name__ == "__main__":
    main()
