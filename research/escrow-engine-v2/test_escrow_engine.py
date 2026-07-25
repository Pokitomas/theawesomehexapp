from dataclasses import replace

import pytest

from escrow_engine import (
    Artifact,
    Engine,
    OracleLedger,
    Reference,
    apply_kernel,
    certify,
    grades,
    horizon,
    synthesize_periodic,
)


def fixture():
    ka = [[0.8, 0.2], [0.2, 0.8]]
    kr = [[0.6, 0.4], [0.4, 0.6]]
    families = {"tick": [ka, kr]}
    ledger = OracleLedger()
    ref = Reference({"tick": kr})
    art = Artifact(
        "cheap",
        {"tick": ka},
        2,
        execution_cost=0.05,
        discovery_cost=2,
        verification_cost=4,
    )
    cert = certify(art, ref, families, ledger)
    eng = Engine(ref, 0.3, ledger)
    eng.install(art, cert, families)
    return ka, kr, families, ref, art, cert, eng


def test_phase_change():
    _, _, _, _, _, _, eng = fixture()
    assert horizon(0.6, 0.2, 0.3) == 1
    policy = synthesize_periodic(eng, "cheap", "tick")
    assert (policy.artifact_steps, policy.reference_steps) == (1, 1)
    assert policy.peak_debt == pytest.approx(0.2272727272727273)
    assert policy.speedup > 1.9


def test_plan_executes_and_bound_holds():
    _, _, _, _, _, _, eng = fixture()
    actions = ["tick"] * 20
    plan = eng.plan(actions)
    assert sum(s.mode == "artifact" for s in plan.steps) == 10
    assert plan.total_cost == pytest.approx(10.5)
    receipt = eng.run([1.0, 0.0], actions, plan, audit=True)
    assert receipt["bound_validated"] is True
    assert receipt["observed_reference_error"] <= receipt["final_debt"]


def test_joint_membership_required():
    ka, kr, _, ref, art, _, _ = fixture()
    with pytest.raises(ValueError, match="artifact is not"):
        certify(art, ref, {"tick": [kr]})
    with pytest.raises(ValueError, match="reference is not"):
        certify(art, ref, {"tick": [ka]})


def test_singleton_exception_has_zero_width():
    k = [[1.0, 0.0], [0.35, 0.65]]
    assert grades([k]) == pytest.approx((0.65, 0.0))


def test_tampered_plan_and_kernel_arrest():
    _, _, _, _, art, _, eng = fixture()
    plan = eng.plan(["tick"] * 2)
    bad_step = replace(plan.steps[0], debt_after=0.0)
    bad_plan = replace(plan, steps=(bad_step,) + plan.steps[1:])
    with pytest.raises(RuntimeError, match="debt is not reproducible"):
        eng.run([1.0, 0.0], ["tick"] * 2, bad_plan)
    art.kernels["tick"][0][0] = 0.79
    art.kernels["tick"][0][1] = 0.21
    with pytest.raises(RuntimeError, match="artifact mutated"):
        eng.run([1.0, 0.0], ["tick"] * 2, plan)


def test_explicit_credal_paths_double_but_scalar_bound_survives():
    k1 = [[0.7, 0.3], [0.2, 0.8]]
    k2 = [[0.6, 0.4], [0.25, 0.75]]
    dbar, width = grades([k1, k2])
    paths = [[1.0, 0.0]]
    z = 0.0
    for t in range(14):
        paths = [apply_kernel(p, k) for p in paths for k in (k1, k2)]
        z = dbar * z + width
        xs = [p[0] for p in paths]
        assert len(paths) == 2 ** (t + 1)
        assert max(xs) - min(xs) <= z + 1e-12
