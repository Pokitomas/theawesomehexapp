#!/usr/bin/env python3
"""Exact-ish algebraic carrier for ARCHIE latent actions.

The action is not a shell token.  It is a transformation on persistent state.
Each latent action is represented by a monomial operator:

    y_i = sign_i * 2**scale_i * x[perm_i]

Permutation, sign, and power-of-two scale compose without dense matrix
multiplication.  On binary floating point, the carrier itself introduces no
rounding from multiply-add accumulation; inverse and composition are explicit.
This file is a courtable substrate, not a claim of intelligence.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import dataclass

import torch


@dataclass(frozen=True)
class MonomialAction:
    perm: torch.Tensor   # output i reads input perm[i]
    sign: torch.Tensor   # +/-1, shape [D]
    scale: torch.Tensor  # integer powers of two, shape [D]

    @property
    def dim(self) -> int:
        return int(self.perm.numel())

    def apply(self, x: torch.Tensor) -> torch.Tensor:
        factor = torch.ldexp(self.sign.to(dtype=x.dtype), self.scale.to(torch.int32))
        return x.index_select(-1, self.perm) * factor

    def inverse(self) -> "MonomialAction":
        inv = torch.empty_like(self.perm)
        inv[self.perm] = torch.arange(self.dim, device=self.perm.device, dtype=self.perm.dtype)
        # x_j = y[inv[j]] * sign[inv[j]] * 2**(-scale[inv[j]])
        return MonomialAction(
            perm=inv,
            sign=self.sign.index_select(0, inv),
            scale=-self.scale.index_select(0, inv),
        )

    def then(self, later: "MonomialAction") -> "MonomialAction":
        """Return the operator equivalent to later(self(x))."""
        if self.dim != later.dim:
            raise ValueError("dimension mismatch")
        p = later.perm
        return MonomialAction(
            perm=self.perm.index_select(0, p),
            sign=later.sign * self.sign.index_select(0, p),
            scale=later.scale + self.scale.index_select(0, p),
        )

    def identity_error(self, dtype: torch.dtype = torch.float32) -> float:
        x = torch.randn(8, self.dim, device=self.perm.device, dtype=dtype)
        recovered = self.inverse().apply(self.apply(x))
        return float((recovered - x).abs().max().item())


def seed_from_code(code: str) -> int:
    raw = hashlib.sha256(code.encode("utf-8")).digest()[:8]
    return int.from_bytes(raw, "little") & ((1 << 63) - 1)


def action_from_code(
    code: str,
    dim: int,
    *,
    device: torch.device,
    max_abs_scale: int = 1,
) -> MonomialAction:
    if dim < 1:
        raise ValueError("dim must be positive")
    g = torch.Generator(device=device)
    g.manual_seed(seed_from_code(code))
    perm = torch.randperm(dim, generator=g, device=device, dtype=torch.int64)
    bits = torch.randint(0, 2, (dim,), generator=g, device=device, dtype=torch.int64)
    sign = bits.mul(2).sub(1)
    if max_abs_scale:
        scale = torch.randint(
            -max_abs_scale,
            max_abs_scale + 1,
            (dim,),
            generator=g,
            device=device,
            dtype=torch.int64,
        )
    else:
        scale = torch.zeros(dim, device=device, dtype=torch.int64)
    return MonomialAction(perm=perm, sign=sign, scale=scale)


def identity(dim: int, device: torch.device) -> MonomialAction:
    return MonomialAction(
        perm=torch.arange(dim, device=device, dtype=torch.int64),
        sign=torch.ones(dim, device=device, dtype=torch.int64),
        scale=torch.zeros(dim, device=device, dtype=torch.int64),
    )


def run_court(dim: int, actions: int, trials: int, device: torch.device) -> dict:
    ops = [action_from_code(f"motor-action-{i}", dim, device=device) for i in range(actions)]
    dtypes = [torch.float32]
    if device.type == "cuda":
        dtypes.append(torch.float16)

    inverse_max = {str(dtype).replace("torch.", ""): 0.0 for dtype in dtypes}
    composition_max = {str(dtype).replace("torch.", ""): 0.0 for dtype in dtypes}
    identity_max = {str(dtype).replace("torch.", ""): 0.0 for dtype in dtypes}

    for dtype in dtypes:
        key = str(dtype).replace("torch.", "")
        for t in range(trials):
            a = ops[t % len(ops)]
            b = ops[(t * 7 + 3) % len(ops)]
            x = torch.randn(16, dim, device=device, dtype=dtype)

            restored = a.inverse().apply(a.apply(x))
            inverse_max[key] = max(inverse_max[key], float((restored - x).abs().max().item()))

            composed = a.then(b).apply(x)
            sequential = b.apply(a.apply(x))
            composition_max[key] = max(
                composition_max[key],
                float((composed - sequential).abs().max().item()),
            )

            untouched = identity(dim, device).apply(x)
            identity_max[key] = max(identity_max[key], float((untouched - x).abs().max().item()))

    return {
        "schema": "archie-action-latent/monomial-groupoid-court-v1",
        "device": str(device),
        "dim": dim,
        "action_count": actions,
        "trials": trials,
        "inverse_max_abs_error": inverse_max,
        "composition_max_abs_error": composition_max,
        "identity_max_abs_error": identity_max,
        "pass": all(v == 0.0 for table in (inverse_max, composition_max, identity_max) for v in table.values()),
        "interpretation": (
            "PASS means the monomial carrier satisfies identity/inverse/composition exactly for the tested binary dtypes. "
            "It does not establish that the latent action codes are meaningful or learned."
        ),
    }


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--dim", type=int, default=2048)
    p.add_argument("--actions", type=int, default=64)
    p.add_argument("--trials", type=int, default=256)
    p.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    args = p.parse_args()
    device = torch.device(args.device)
    result = run_court(args.dim, args.actions, args.trials, device)
    print(json.dumps(result, indent=2, sort_keys=True))
    raise SystemExit(0 if result["pass"] else 1)


if __name__ == "__main__":
    main()
