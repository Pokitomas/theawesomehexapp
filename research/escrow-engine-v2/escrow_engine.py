from __future__ import annotations

"""Standalone ESCROW Engine v2.

Proof-carrying scheduling of cheap stochastic artifacts and an exact reference
under a total-variation affine debt gate.
"""

from dataclasses import dataclass, field
from hashlib import sha256
from math import ceil
from typing import Dict, List, Mapping, Optional, Sequence, Tuple

Vector = Sequence[float]
Matrix = Sequence[Vector]
Action = str
TOL = 1e-9


def check_distribution(p: Vector, name: str = "p") -> int:
    if not p:
        raise ValueError(f"{name}: empty")
    if any(x < -TOL for x in p):
        raise ValueError(f"{name}: negative entry")
    if abs(sum(p) - 1.0) > 1e-7:
        raise ValueError(f"{name}: must sum to one")
    return len(p)


def check_kernel(K: Matrix, name: str = "K") -> int:
    n = len(K)
    if n == 0:
        raise ValueError(f"{name}: empty")
    for i, row in enumerate(K):
        if len(row) != n:
            raise ValueError(f"{name}: row {i} is not square")
        check_distribution(row, f"{name}[{i}]")
    return n


def check_family(family: Sequence[Matrix], name: str = "family") -> int:
    if not family:
        raise ValueError(f"{name}: empty")
    dims = {check_kernel(K, f"{name}[{i}]") for i, K in enumerate(family)}
    if len(dims) != 1:
        raise ValueError(f"{name}: mixed dimensions")
    return dims.pop()


def tv(p: Vector, q: Vector) -> float:
    if len(p) != len(q):
        raise ValueError("tv: dimension mismatch")
    return 0.5 * sum(abs(x - y) for x, y in zip(p, q))


def apply_kernel(p: Vector, K: Matrix) -> List[float]:
    n = check_distribution(p)
    if check_kernel(K) != n:
        raise ValueError("apply_kernel: dimension mismatch")
    return [sum(p[i] * K[i][j] for i in range(n)) for j in range(n)]


def dobrushin(K: Matrix) -> float:
    n = check_kernel(K)
    return max((tv(K[i], K[j]) for i in range(n) for j in range(i + 1, n)), default=0.0)


def grades(family: Sequence[Matrix]) -> Tuple[float, float]:
    n = check_family(family)
    dbar = max(dobrushin(K) for K in family)
    width = max(
        (tv(family[i][q], family[j][q])
         for q in range(n)
         for i in range(len(family))
         for j in range(i + 1, len(family))),
        default=0.0,
    )
    return dbar, width


def affine_step(z: float, dbar: float, width: float) -> float:
    if z < -TOL or width < -TOL or not 0.0 <= dbar <= 1.0 + TOL:
        raise ValueError("invalid affine debt")
    return dbar * max(z, 0.0) + max(width, 0.0)


def horizon(dbar: float, width: float, tau: float, z0: float = 0.0) -> float:
    if not 0.0 <= tau <= 1.0:
        raise ValueError("tau must be in [0,1]")
    if z0 > tau + TOL:
        return 0
    if dbar < 1.0 - TOL and width / (1.0 - dbar) <= tau + TOL:
        return float("inf")
    if dbar >= 1.0 - TOL and width <= TOL:
        return float("inf")
    z, steps = z0, 0
    while steps < 1_000_000:
        z = affine_step(z, dbar, width)
        if z > tau + TOL:
            return steps
        steps += 1
    return float("inf")


def kernel_digest(K: Matrix) -> str:
    check_kernel(K)
    text = ";".join(",".join(f"{x:.17g}" for x in row) for row in K)
    return sha256(text.encode()).hexdigest()


def family_digest(family: Sequence[Matrix]) -> str:
    check_family(family)
    return sha256("|".join(kernel_digest(K) for K in family).encode()).hexdigest()


def same_matrix(A: Matrix, B: Matrix, tol: float = 1e-12) -> bool:
    return len(A) == len(B) and all(
        len(a) == len(b) and all(abs(x - y) <= tol for x, y in zip(a, b))
        for a, b in zip(A, B)
    )


@dataclass
class OracleLedger:
    membership_checks: int = 0
    reference_steps: int = 0
    discovery_calls: int = 0
    statistical_calls: int = 0
    reanchors: int = 0

    def snapshot(self) -> Dict[str, int]:
        return {
            "membership_checks": self.membership_checks,
            "reference_steps": self.reference_steps,
            "discovery_calls": self.discovery_calls,
            "statistical_calls": self.statistical_calls,
            "reanchors": self.reanchors,
        }


@dataclass(frozen=True)
class ActionCertificate:
    action: Action
    family_digest: str
    artifact_member: int
    reference_member: int
    artifact_digest: str
    reference_digest: str
    dbar: float
    width: float
    reference_dbar: float


@dataclass(frozen=True)
class Certificate:
    artifact_name: str
    version: str
    actions: Tuple[ActionCertificate, ...]
    proof_digest: str

    def for_action(self, action: Action) -> ActionCertificate:
        for cert in self.actions:
            if cert.action == action:
                return cert
        raise KeyError(action)


@dataclass(frozen=True)
class Artifact:
    name: str
    kernels: Mapping[Action, Matrix]
    factor_size: int
    version: str = "v1"
    execution_cost: float = 0.05
    discovery_cost: int = 0
    verification_cost: int = 0

    def __post_init__(self) -> None:
        if not self.kernels:
            raise ValueError("artifact has no kernels")
        for action, K in self.kernels.items():
            if check_kernel(K, f"artifact.{action}") != self.factor_size:
                raise ValueError("artifact factor mismatch")

    def apply(self, p: Vector, action: Action) -> List[float]:
        if action not in self.kernels:
            raise ValueError(f"action {action!r} outside artifact jurisdiction")
        return apply_kernel(p, self.kernels[action])


@dataclass
class Reference:
    kernels: Mapping[Action, Matrix]
    execution_cost: float = 1.0
    calls: int = 0

    def __post_init__(self) -> None:
        dims = {check_kernel(K, f"reference.{a}") for a, K in self.kernels.items()}
        if len(dims) != 1:
            raise ValueError("reference mixed dimensions")
        self.factor_size = dims.pop()

    def apply(self, p: Vector, action: Action, ledger: OracleLedger) -> List[float]:
        self.calls += 1
        ledger.reference_steps += 1
        return apply_kernel(p, self.kernels[action])


def certify(artifact: Artifact, reference: Reference,
            families: Mapping[Action, Sequence[Matrix]],
            ledger: Optional[OracleLedger] = None) -> Certificate:
    if artifact.factor_size != reference.factor_size:
        raise ValueError("artifact/reference factor mismatch")
    certs: List[ActionCertificate] = []
    for action in sorted(artifact.kernels):
        if action not in reference.kernels or action not in families:
            raise ValueError(f"missing reference/family action {action!r}")
        family = families[action]
        if check_family(family) != artifact.factor_size:
            raise ValueError("family factor mismatch")
        ai = next((i for i, K in enumerate(family)
                   if same_matrix(K, artifact.kernels[action])), None)
        ri = next((i for i, K in enumerate(family)
                   if same_matrix(K, reference.kernels[action])), None)
        if ai is None:
            raise ValueError("artifact is not a declared family member")
        if ri is None:
            raise ValueError("reference is not a declared family member")
        dbar, width = grades(family)
        certs.append(ActionCertificate(
            action=action,
            family_digest=family_digest(family),
            artifact_member=ai,
            reference_member=ri,
            artifact_digest=kernel_digest(artifact.kernels[action]),
            reference_digest=kernel_digest(reference.kernels[action]),
            dbar=dbar,
            width=width,
            reference_dbar=dobrushin(reference.kernels[action]),
        ))
        if ledger:
            ledger.membership_checks += 2 * len(family)
    payload = "|".join(
        f"{c.action}:{c.family_digest}:{c.artifact_member}:{c.reference_member}:"
        f"{c.dbar:.17g}:{c.width:.17g}:{c.reference_dbar:.17g}"
        for c in certs
    )
    digest = sha256(f"{artifact.name}:{artifact.version}:{payload}".encode()).hexdigest()
    return Certificate(artifact.name, artifact.version, tuple(certs), digest)


@dataclass(frozen=True)
class PlanStep:
    index: int
    action: Action
    mode: str
    operator: str
    debt_before: float
    debt_after: float
    cost: float


@dataclass(frozen=True)
class Plan:
    tau: float
    initial_debt: float
    steps: Tuple[PlanStep, ...]
    total_cost: float
    final_debt: float


@dataclass
class _Node:
    debt: float
    cost: float
    steps: Tuple[PlanStep, ...]


def _prune(nodes: List[_Node]) -> List[_Node]:
    nodes.sort(key=lambda n: (n.cost, n.debt))
    out, best_debt = [], float("inf")
    for node in nodes:
        if node.debt < best_debt - 1e-12:
            out.append(node)
            best_debt = node.debt
    return out


@dataclass
class Engine:
    reference: Reference
    tau: float
    ledger: OracleLedger = field(default_factory=OracleLedger)
    installed: Dict[str, Tuple[Artifact, Certificate]] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not 0.0 <= self.tau <= 1.0:
            raise ValueError("tau must be in [0,1]")
        self._reference_digests = {
            a: kernel_digest(K) for a, K in self.reference.kernels.items()
        }

    def _check_reference(self, action: Action) -> None:
        if kernel_digest(self.reference.kernels[action]) != self._reference_digests[action]:
            raise RuntimeError("ARREST: reference mutated")

    def install(self, artifact: Artifact, certificate: Certificate,
                families: Mapping[Action, Sequence[Matrix]]) -> None:
        if certify(artifact, self.reference, families) != certificate:
            raise ValueError("certificate does not verify")
        if artifact.name in self.installed:
            raise ValueError("duplicate artifact")
        self.installed[artifact.name] = (artifact, certificate)

    def plan(self, actions: Sequence[Action], initial_debt: float = 0.0) -> Plan:
        if not 0.0 <= initial_debt <= self.tau:
            raise ValueError("initial debt outside gate")
        frontier = [_Node(initial_debt, 0.0, ())]
        for index, action in enumerate(actions):
            self._check_reference(action)
            candidates: List[_Node] = []
            for node in frontier:
                rz = dobrushin(self.reference.kernels[action]) * node.debt
                if rz <= self.tau + TOL:
                    step = PlanStep(index, action, "reference", "reference",
                                    node.debt, rz, self.reference.execution_cost)
                    candidates.append(_Node(rz, node.cost + step.cost, node.steps + (step,)))
                for name, (artifact, certificate) in sorted(self.installed.items()):
                    if action not in artifact.kernels:
                        continue
                    cert = certificate.for_action(action)
                    az = affine_step(node.debt, cert.dbar, cert.width)
                    if az <= self.tau + TOL:
                        step = PlanStep(index, action, "artifact", name,
                                        node.debt, az, artifact.execution_cost)
                        candidates.append(_Node(az, node.cost + step.cost, node.steps + (step,)))
            if not candidates:
                raise RuntimeError(f"ARREST at step {index}: no safe transition")
            frontier = _prune(candidates)
        best = min(frontier, key=lambda n: (n.cost, n.debt))
        return Plan(self.tau, initial_debt, best.steps, best.cost, best.debt)

    def run(self, initial: Vector, actions: Sequence[Action], plan: Optional[Plan] = None,
            audit: bool = False) -> Dict[str, object]:
        if check_distribution(initial) != self.reference.factor_size:
            raise ValueError("initial distribution mismatch")
        plan = plan or self.plan(actions)
        if len(plan.steps) != len(actions) or abs(plan.tau - self.tau) > TOL:
            raise ValueError("plan mismatch")
        p, z, paid, trace = list(initial), plan.initial_debt, 0.0, []
        for i, (action, step) in enumerate(zip(actions, plan.steps)):
            if step.index != i or step.action != action or abs(step.debt_before - z) > 1e-10:
                raise RuntimeError("ARREST: malformed plan")
            self._check_reference(action)
            if step.mode == "reference":
                expected = dobrushin(self.reference.kernels[action]) * z
                cost = self.reference.execution_cost
                p = self.reference.apply(p, action, self.ledger)
            elif step.mode == "artifact":
                artifact, certificate = self.installed[step.operator]
                cert = certificate.for_action(action)
                if kernel_digest(artifact.kernels[action]) != cert.artifact_digest:
                    raise RuntimeError("ARREST: artifact mutated")
                expected = affine_step(z, cert.dbar, cert.width)
                cost = artifact.execution_cost
                p = artifact.apply(p, action)
            else:
                raise RuntimeError("ARREST: unknown mode")
            if expected > self.tau + TOL or abs(expected - step.debt_after) > 1e-10:
                raise RuntimeError("ARREST: debt is not reproducible")
            if abs(cost - step.cost) > 1e-10:
                raise RuntimeError("ARREST: cost is not reproducible")
            z, paid = expected, paid + cost
            trace.append({"action": action, "mode": step.mode, "operator": step.operator,
                          "debt": z, "output": list(p)})
        if abs(z - plan.final_debt) > 1e-10 or abs(paid - plan.total_cost) > 1e-10:
            raise RuntimeError("ARREST: plan totals are not reproducible")
        observed = None
        if audit:
            exact = list(initial)
            for action in actions:
                exact = self.reference.apply(exact, action, self.ledger)
            observed = tv(p, exact)
        return {
            "final_distribution": p,
            "final_debt": z,
            "total_cost": paid,
            "trace": trace,
            "observed_reference_error": observed,
            "bound_validated": None if observed is None else observed <= z + 1e-9,
            "oracle_ledger": self.ledger.snapshot(),
        }

    def cost_report(self, plan: Plan, runs: int = 1) -> Dict[str, float]:
        if runs <= 0:
            raise ValueError("runs must be positive")
        used = {s.operator for s in plan.steps if s.mode == "artifact"}
        setup = sum(self.installed[n][0].discovery_cost +
                    self.installed[n][0].verification_cost for n in used)
        baseline_per_run = len(plan.steps) * self.reference.execution_cost
        saving_per_run = baseline_per_run - plan.total_cost
        return {
            "setup": float(setup),
            "runtime": runs * plan.total_cost,
            "total": setup + runs * plan.total_cost,
            "reference_only": runs * baseline_per_run,
            "breakeven_runs": float("inf") if saving_per_run <= TOL
                               else ceil(setup / saving_per_run),
        }


@dataclass(frozen=True)
class PeriodicPolicy:
    artifact_name: str
    action: Action
    artifact_steps: int
    reference_steps: int
    fixed_debt: float
    peak_debt: float
    average_cost: float

    @property
    def speedup(self) -> float:
        return 1.0 / self.average_cost


def synthesize_periodic(engine: Engine, artifact_name: str, action: Action,
                        max_artifact_steps: int = 64,
                        max_reference_steps: int = 64) -> PeriodicPolicy:
    artifact, certificate = engine.installed[artifact_name]
    cert = certificate.for_action(action)
    if kernel_digest(artifact.kernels[action]) != cert.artifact_digest:
        raise RuntimeError("artifact mutated")
    engine._check_reference(action)
    best = None
    for m in range(1, max_artifact_steps + 1):
        for r in range(1, max_reference_steps + 1):
            D, W = 1.0, 0.0
            for _ in range(m):
                D, W = cert.dbar * D, cert.dbar * W + cert.width
            for _ in range(r):
                D, W = cert.reference_dbar * D, cert.reference_dbar * W
            if D >= 1.0 - TOL:
                continue
            z0 = W / (1.0 - D)
            z, peak, safe = z0, z0, True
            for _ in range(m):
                z = affine_step(z, cert.dbar, cert.width)
                peak = max(peak, z)
                safe &= z <= engine.tau + TOL
            for _ in range(r):
                z *= cert.reference_dbar
            if not safe or abs(z - z0) > 1e-7:
                continue
            avg = (m * artifact.execution_cost + r * engine.reference.execution_cost) / (m + r)
            if avg >= engine.reference.execution_cost - TOL:
                continue
            policy = PeriodicPolicy(artifact_name, action, m, r, z0, peak, avg)
            if best is None or (avg, peak, -m, r) < (
                best.average_cost, best.peak_debt,
                -best.artifact_steps, best.reference_steps
            ):
                best = policy
    if best is None:
        raise RuntimeError("no cheaper safe periodic policy")
    return best


def demo() -> Dict[str, object]:
    K_art = [[0.8, 0.2], [0.2, 0.8]]
    K_ref = [[0.6, 0.4], [0.4, 0.6]]
    families = {"tick": [K_art, K_ref]}
    ledger = OracleLedger()
    reference = Reference({"tick": K_ref})
    artifact = Artifact("cheap-tick", {"tick": K_art}, 2, "v2", 0.05, 2, 4)
    certificate = certify(artifact, reference, families, ledger)
    engine = Engine(reference, 0.30, ledger)
    engine.install(artifact, certificate, families)
    actions = ["tick"] * 20
    plan = engine.plan(actions)
    receipt = engine.run([1.0, 0.0], actions, plan, audit=True)
    periodic = synthesize_periodic(engine, "cheap-tick", "tick")
    return {
        "artifact_horizon": horizon(0.6, 0.2, 0.30),
        "plan_cost": plan.total_cost,
        "reference_cost": 20.0,
        "peak_debt": max(s.debt_after for s in plan.steps),
        "periodic": periodic.__dict__,
        "periodic_speedup": periodic.speedup,
        "receipt": receipt,
        "cost_report": engine.cost_report(plan),
    }


if __name__ == "__main__":
    import json
    print(json.dumps(demo(), indent=2))
