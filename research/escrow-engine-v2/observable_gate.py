from __future__ import annotations

"""Observable-lifted admission gate for finite ESCROW factors.

A factor transition certificate controls only the factor. This module binds one
common stochastic decoder to both artifact and reference trajectories, measures
held-out decoder residuals, requires action/state support, and lifts factor TV
debt into the declared observable space by triangle inequality and TV data
processing.
"""

from dataclasses import dataclass
from hashlib import sha256
from typing import Sequence

Vector = Sequence[float]
Matrix = Sequence[Vector]
TOL = 1e-9


def _check_distribution(p: Vector, name: str) -> int:
    if not p:
        raise ValueError(f"{name}: empty distribution")
    if any(x < -TOL for x in p):
        raise ValueError(f"{name}: negative entry")
    if abs(sum(p) - 1.0) > 1e-7:
        raise ValueError(f"{name}: entries must sum to one")
    return len(p)


def _check_decoder(decoder: Matrix) -> tuple[int, int]:
    if not decoder:
        raise ValueError("decoder: empty")
    output_dim = _check_distribution(decoder[0], "decoder[0]")
    for i, row in enumerate(decoder[1:], 1):
        if _check_distribution(row, f"decoder[{i}]") != output_dim:
            raise ValueError("decoder: mixed output dimensions")
    return len(decoder), output_dim


def tv(p: Vector, q: Vector) -> float:
    if len(p) != len(q):
        raise ValueError("tv: dimension mismatch")
    return 0.5 * sum(abs(x - y) for x, y in zip(p, q))


def decode(mu: Vector, decoder: Matrix) -> list[float]:
    factor_dim, output_dim = _check_decoder(decoder)
    if _check_distribution(mu, "factor distribution") != factor_dim:
        raise ValueError("factor/decoder dimension mismatch")
    return [
        sum(mu[i] * decoder[i][j] for i in range(factor_dim))
        for j in range(output_dim)
    ]


def decoder_digest(decoder: Matrix) -> str:
    _check_decoder(decoder)
    payload = ";".join(",".join(f"{x:.17g}" for x in row) for row in decoder)
    return sha256(payload.encode()).hexdigest()


@dataclass(frozen=True)
class ObservableCertificate:
    decoder_digest: str
    evidence_digest: str
    factor_dim: int
    output_dim: int
    artifact_max_residual: float
    reference_max_residual: float
    artifact_support: tuple[int, ...]
    reference_support: tuple[int, ...]
    version: str = "observable-lift/v1"

    def observable_bound(self, factor_debt: float) -> float:
        if not 0.0 <= factor_debt <= 1.0 + TOL:
            raise ValueError("factor debt must lie in [0,1]")
        return min(
            1.0,
            max(0.0, self.artifact_max_residual)
            + max(0.0, factor_debt)
            + max(0.0, self.reference_max_residual),
        )

    def require_admission(self, factor_debt: float, observable_tau: float) -> float:
        if not self.decoder_digest:
            raise ValueError("missing decoder digest")
        if not 0.0 <= observable_tau <= 1.0:
            raise ValueError("observable tau must lie in [0,1]")
        if (
            len(self.artifact_support) != self.factor_dim
            or len(self.reference_support) != self.factor_dim
        ):
            raise ValueError("support vector/factor dimension mismatch")
        if any(count <= 0 for count in self.artifact_support):
            raise ValueError("unsupported artifact factor row")
        if any(count <= 0 for count in self.reference_support):
            raise ValueError("unsupported reference factor row")
        bound = self.observable_bound(factor_debt)
        if bound > observable_tau + TOL:
            raise ValueError(
                f"observable bound {bound:.6g} exceeds gate {observable_tau:.6g}"
            )
        return bound


def certify_observable_decoder(
    decoder: Matrix,
    artifact_observables: Sequence[Vector],
    artifact_factors: Sequence[Vector],
    reference_observables: Sequence[Vector],
    reference_factors: Sequence[Vector],
    artifact_support: Sequence[int],
    reference_support: Sequence[int],
) -> ObservableCertificate:
    factor_dim, output_dim = _check_decoder(decoder)
    if len(artifact_observables) != len(artifact_factors) or not artifact_observables:
        raise ValueError("artifact evidence mismatch or empty")
    if len(reference_observables) != len(reference_factors) or not reference_observables:
        raise ValueError("reference evidence mismatch or empty")

    def residuals(
        observables: Sequence[Vector], factors: Sequence[Vector], label: str
    ) -> list[float]:
        out: list[float] = []
        for i, (p, mu) in enumerate(zip(observables, factors)):
            if _check_distribution(p, f"{label}.observable[{i}]") != output_dim:
                raise ValueError("observable/decoder dimension mismatch")
            out.append(tv(p, decode(mu, decoder)))
        return out

    art_residuals = residuals(artifact_observables, artifact_factors, "artifact")
    ref_residuals = residuals(reference_observables, reference_factors, "reference")
    if len(artifact_support) != factor_dim or len(reference_support) != factor_dim:
        raise ValueError("support vector/factor dimension mismatch")
    evidence = (
        decoder_digest(decoder)
        + "|"
        + ",".join(f"{x:.17g}" for x in art_residuals)
        + "|"
        + ",".join(f"{x:.17g}" for x in ref_residuals)
        + "|"
        + ",".join(map(str, artifact_support))
        + "|"
        + ",".join(map(str, reference_support))
    )
    return ObservableCertificate(
        decoder_digest=decoder_digest(decoder),
        evidence_digest=sha256(evidence.encode()).hexdigest(),
        factor_dim=factor_dim,
        output_dim=output_dim,
        artifact_max_residual=max(art_residuals),
        reference_max_residual=max(ref_residuals),
        artifact_support=tuple(int(x) for x in artifact_support),
        reference_support=tuple(int(x) for x in reference_support),
    )
