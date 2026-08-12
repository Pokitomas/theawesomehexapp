#!/usr/bin/env python3
"""Learn latent state transformations from consequences, not command spelling.

This is a deliberately small developmental court for ARCHIE.  The training
signal is a sequence of state transitions from motor_babble.py.  Surface action
names are withheld from optimization and used only after training as a
diagnostic.

Each discovered latent action owns an affine isometry

    z' = Q_k z + b_k

where Q_k is produced by a Cayley transform of a learned skew-symmetric
matrix.  The carrier therefore has an explicit inverse and a compositional
interpretation.  An inverse-dynamics network chooses a discrete latent action
from (z_t, z_{t+1}); the forward loss asks the chosen operator to predict the
next state.  This is not a language model and does not ingest Bash/Python
syntax as a cognitive primitive.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import math
import random
import sys
import tempfile
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
except Exception as exc:  # pragma: no cover - host capability court reports this
    raise SystemExit(f"PyTorch is required for the learned operator court: {exc}")

HERE = Path(__file__).resolve().parent


def load_motor_module():
    path = HERE / "motor_babble.py"
    spec = importlib.util.spec_from_file_location("archie_motor_babble_for_operator_core", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    # dataclasses and other module-aware machinery resolve annotations through
    # sys.modules while exec_module is running. Register first so the standalone
    # --steps path is a real court rather than a py_compile-only artifact.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def load_rows(path: Path) -> list[dict[str, Any]]:
    rows = [json.loads(line) for line in path.read_text("utf-8").splitlines() if line.strip()]
    if not rows:
        raise ValueError("empty motor ledger")
    return rows


def reconstruct_state_pairs(rows: list[dict[str, Any]]) -> tuple[torch.Tensor, torch.Tensor, list[str], list[str]]:
    """Recover a path-invariant coarse state from exact transition deltas.

    The motor world starts with three infrastructure directories and no files.
    We track only quantities that survive path renaming: file count, mutable
    directory count, and total payload bytes.  Two surface commands that induce
    the same observable transformation are intentionally indistinguishable to
    this court.
    """
    file_count = 0.0
    mutable_dir_count = 0.0
    total_bytes = 0.0
    before: list[list[float]] = []
    after: list[list[float]] = []
    action_kind: list[str] = []
    baseline_code: list[str] = []

    for row in rows:
        before.append([file_count, mutable_dir_count, total_bytes])
        d = row["observed_delta"]
        file_count += float(d["created_files"] - d["deleted_files"])
        mutable_dir_count += float(d["created_dirs"] - d["deleted_dirs"])
        total_bytes += float(d["byte_delta"])
        after.append([file_count, mutable_dir_count, total_bytes])
        action_kind.append(str(row.get("motor_action", {}).get("kind", "unknown")))
        baseline_code.append(str(row.get("latent_action_code", "unknown")))

    return (
        torch.tensor(before, dtype=torch.float32),
        torch.tensor(after, dtype=torch.float32),
        action_kind,
        baseline_code,
    )


def robust_normalize(before: torch.Tensor, after: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor, dict[str, list[float]]]:
    all_states = torch.cat([before, after], dim=0)
    center = all_states.median(dim=0).values
    # Median absolute deviation is stable when motor babbling makes occasional
    # large byte jumps.  Clamp zero-variance coordinates rather than deleting
    # them so the court exposes degeneracy explicitly.
    mad = (all_states - center).abs().median(dim=0).values
    scale = (1.4826 * mad).clamp_min(1.0)
    return (before - center) / scale, (after - center) / scale, {
        "center": center.tolist(),
        "scale": scale.tolist(),
    }


class CayleyActionBank(nn.Module):
    def __init__(self, codes: int, dim: int):
        super().__init__()
        self.codes = codes
        self.dim = dim
        self.raw = nn.Parameter(torch.randn(codes, dim, dim) * 0.02)
        self.translation = nn.Parameter(torch.randn(codes, dim) * 0.02)

    def matrices(self) -> torch.Tensor:
        # S is skew-symmetric. Q=(I-S)^-1(I+S) is orthogonal whenever I-S is
        # nonsingular; for real skew S it is always nonsingular.
        s = 0.5 * (self.raw - self.raw.transpose(-1, -2))
        eye = torch.eye(self.dim, device=s.device, dtype=s.dtype).expand(self.codes, -1, -1)
        return torch.linalg.solve(eye - s, eye + s)

    def forward_all(self, z: torch.Tensor) -> torch.Tensor:
        q = self.matrices()
        return torch.einsum("kij,bj->bki", q, z) + self.translation.unsqueeze(0)

    def inverse_all(self, z_next: torch.Tensor) -> torch.Tensor:
        q = self.matrices()
        centered = z_next.unsqueeze(1) - self.translation.unsqueeze(0)
        return torch.einsum("kji,bkj->bki", q, centered)

    @torch.no_grad()
    def orthogonality_error(self) -> float:
        q = self.matrices()
        eye = torch.eye(self.dim, device=q.device, dtype=q.dtype).expand(self.codes, -1, -1)
        return float((q.transpose(-1, -2) @ q - eye).abs().max().item())


class InverseDynamics(nn.Module):
    def __init__(self, dim: int, codes: int, width: int = 64):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(dim * 3, width),
            nn.SiLU(),
            nn.Linear(width, width),
            nn.SiLU(),
            nn.Linear(width, codes),
        )

    def forward(self, z0: torch.Tensor, z1: torch.Tensor) -> torch.Tensor:
        return self.net(torch.cat([z0, z1, z1 - z0], dim=-1))


class OperatorPredictiveCore(nn.Module):
    def __init__(self, dim: int, codes: int, width: int = 64):
        super().__init__()
        self.bank = CayleyActionBank(codes, dim)
        self.inverse = InverseDynamics(dim, codes, width)

    def forward(self, z0: torch.Tensor, z1: torch.Tensor, temperature: float) -> dict[str, torch.Tensor]:
        logits = self.inverse(z0, z1)
        probs = F.softmax(logits / temperature, dim=-1)
        candidates = self.bank.forward_all(z0)
        prediction = torch.einsum("bk,bkd->bd", probs, candidates)
        inverse_candidates = self.bank.inverse_all(z1)
        recovered = torch.einsum("bk,bkd->bd", probs, inverse_candidates)
        return {
            "logits": logits,
            "probs": probs,
            "prediction": prediction,
            "recovered": recovered,
            "candidates": candidates,
        }


def purity(assignments: list[int], labels: list[str]) -> float:
    groups: dict[int, Counter[str]] = defaultdict(Counter)
    for cluster, label in zip(assignments, labels):
        groups[int(cluster)][label] += 1
    correct = sum(counter.most_common(1)[0][1] for counter in groups.values() if counter)
    return correct / max(1, len(labels))


def normalized_mutual_information(assignments: list[int], labels: list[str]) -> float:
    n = len(labels)
    if n == 0:
        return 0.0
    cx = Counter(assignments)
    cy = Counter(labels)
    joint = Counter(zip(assignments, labels))
    mi = 0.0
    for (x, y), count in joint.items():
        pxy = count / n
        mi += pxy * math.log(max(1e-12, pxy / ((cx[x] / n) * (cy[y] / n))))
    hx = -sum((c / n) * math.log(c / n) for c in cx.values())
    hy = -sum((c / n) * math.log(c / n) for c in cy.values())
    if hx <= 1e-12 or hy <= 1e-12:
        return 0.0
    return mi / math.sqrt(hx * hy)


def train_court(
    ledger: Path,
    *,
    codes: int,
    epochs: int,
    lr: float,
    seed: int,
    device: torch.device,
) -> dict[str, Any]:
    random.seed(seed)
    torch.manual_seed(seed)
    if device.type == "cuda":
        torch.cuda.manual_seed_all(seed)

    rows = load_rows(ledger)
    b, a, action_kind, baseline_code = reconstruct_state_pairs(rows)
    b, a, normalization = robust_normalize(b, a)
    b, a = b.to(device), a.to(device)
    n, dim = b.shape

    # Chronological holdout prevents the court from grading only memorized
    # transitions. No shuffling across the boundary.
    split = max(1, min(n - 1, int(n * 0.8)))
    train_idx = torch.arange(0, split, device=device)
    test_idx = torch.arange(split, n, device=device)
    model = OperatorPredictiveCore(dim, codes).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)

    losses: list[float] = []
    for epoch in range(epochs):
        progress = epoch / max(1, epochs - 1)
        temperature = 1.0 * (1.0 - progress) + 0.12 * progress
        out = model(b[train_idx], a[train_idx], temperature)
        forward_loss = F.mse_loss(out["prediction"], a[train_idx])
        inverse_loss = F.mse_loss(out["recovered"], b[train_idx])
        probs = out["probs"]
        sample_entropy = -(probs * (probs.clamp_min(1e-9).log())).sum(-1).mean()
        usage = probs.mean(0)
        target = torch.full_like(usage, 1.0 / codes)
        balance = F.mse_loss(usage, target)
        # Make assignments discrete while preventing a one-code collapse.
        loss = forward_loss + 0.5 * inverse_loss + 0.02 * sample_entropy + 0.2 * balance
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
        opt.step()
        losses.append(float(loss.detach().cpu()))

    model.eval()
    with torch.no_grad():
        train_out = model(b[train_idx], a[train_idx], 0.08)
        test_out = model(b[test_idx], a[test_idx], 0.08)
        assignments = model.inverse(b, a).argmax(-1).cpu().tolist()
        test_forward = float(F.mse_loss(test_out["prediction"], a[test_idx]).cpu())
        test_inverse = float(F.mse_loss(test_out["recovered"], b[test_idx]).cpu())
        train_forward = float(F.mse_loss(train_out["prediction"], a[train_idx]).cpu())
        used_codes = len(set(assignments))
        operator_orthogonality = model.bank.orthogonality_error()

    baseline_purity = purity(assignments, baseline_code)
    surface_purity = purity(assignments, action_kind)
    baseline_nmi = normalized_mutual_information(assignments, baseline_code)
    surface_nmi = normalized_mutual_information(assignments, action_kind)

    result = {
        "schema": "archie-action-latent/operator-predictive-core-court-v1",
        "ledger": str(ledger),
        "device": str(device),
        "rows": n,
        "train_rows": split,
        "test_rows": n - split,
        "state_dim": dim,
        "latent_code_capacity": codes,
        "used_codes": used_codes,
        "epochs": epochs,
        "normalization": normalization,
        "loss_initial": losses[0],
        "loss_final": losses[-1],
        "train_forward_mse": train_forward,
        "test_forward_mse": test_forward,
        "test_inverse_mse": test_inverse,
        "operator_orthogonality_max_abs_error": operator_orthogonality,
        "latent_vs_hand_effect_purity": baseline_purity,
        "latent_vs_hand_effect_nmi": baseline_nmi,
        "latent_vs_surface_action_purity_diagnostic_only": surface_purity,
        "latent_vs_surface_action_nmi_diagnostic_only": surface_nmi,
        "pass": bool(
            losses[-1] < losses[0]
            and math.isfinite(test_forward)
            and math.isfinite(test_inverse)
            and used_codes >= 2
            and operator_orthogonality < 1e-4
        ),
        "interpretation": (
            "PASS means a discrete latent-action selector and explicitly invertible operator bank learned nontrivial predictive "
            "structure from state transitions. Surface action labels were not used for optimization. It does not establish general "
            "planning, language understanding, or cinematic intelligence."
        ),
    }
    return result


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--ledger")
    p.add_argument("--steps", type=int, default=2000, help="motor-babble steps when generating a temporary ledger")
    p.add_argument("--codes", type=int, default=12)
    p.add_argument("--epochs", type=int, default=400)
    p.add_argument("--lr", type=float, default=3e-3)
    p.add_argument("--seed", type=int, default=5601)
    p.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    p.add_argument("--output")
    args = p.parse_args()

    temporary = None
    if args.ledger:
        ledger = Path(args.ledger).expanduser().resolve()
    else:
        temporary = tempfile.TemporaryDirectory(prefix="archie-operator-core-")
        root = Path(temporary.name)
        ledger = root / "motor.jsonl"
        motor = load_motor_module()
        motor.run_court(root / "world", ledger, args.steps, args.seed)

    result = train_court(
        ledger,
        codes=args.codes,
        epochs=args.epochs,
        lr=args.lr,
        seed=args.seed,
        device=torch.device(args.device),
    )
    text = json.dumps(result, indent=2, sort_keys=True)
    if args.output:
        out = Path(args.output).expanduser().resolve()
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text + "\n", "utf-8")
    print(text)
    if temporary is not None:
        temporary.cleanup()
    raise SystemExit(0 if result["pass"] else 1)


if __name__ == "__main__":
    main()
