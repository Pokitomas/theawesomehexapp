from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

SCHEMA = "archie-kernel-maker/v1"


def canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def receipt(kind: str, payload: dict[str, Any]) -> dict[str, Any]:
    body = {"schema": SCHEMA, "kind": str(kind), "payload": payload}
    body["sha256"] = hashlib.sha256(canonical(body)).hexdigest()
    return body


def verify_receipt(value: dict[str, Any]) -> bool:
    if not isinstance(value, dict) or "sha256" not in value:
        return False
    got = str(value.get("sha256") or "")
    body = {k: v for k, v in value.items() if k != "sha256"}
    return hashlib.sha256(canonical(body)).hexdigest() == got


@dataclass
class SeatLease:
    occupant: str = ""
    generation: int = 0
    expires_at: float = 0.0

    def claim(self, occupant: str, *, now: float, ttl_s: float, force_if_stale: bool = True) -> dict[str, Any]:
        occupant = str(occupant or "").strip()
        if not occupant:
            raise ValueError("occupant required")
        stale = now >= self.expires_at
        if self.occupant and self.occupant != occupant and not (stale and force_if_stale):
            return receipt("seat.refused", {"active": self.occupant, "generation": self.generation, "stale": stale})
        takeover = bool(self.occupant and self.occupant != occupant)
        self.occupant = occupant
        self.generation += 1
        self.expires_at = float(now) + max(0.001, float(ttl_s))
        return receipt("seat.claimed", {"occupant": occupant, "generation": self.generation, "takeover": takeover, "stale_basis": stale})

    def pulse(self, occupant: str, *, now: float, ttl_s: float) -> dict[str, Any]:
        if occupant != self.occupant or now >= self.expires_at:
            return receipt("seat.pulse_refused", {"occupant": occupant, "active": self.occupant, "stale": now >= self.expires_at})
        self.expires_at = float(now) + max(0.001, float(ttl_s))
        return receipt("seat.pulse", {"occupant": occupant, "generation": self.generation})


@dataclass(frozen=True)
class Capability:
    name: str
    mutating: bool
    reversible: bool = True


class UniversalRemoteKernel:
    """Small authority-neutral dispatch membrane.

    The kernel knows capability names, basis generations, and receipts. It does
    not know UI semantics. Adapters own platform details and must return evidence.
    """

    def __init__(self) -> None:
        self.capabilities: dict[str, Capability] = {}
        self.adapters: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {}
        self.basis_generation = 0
        self.history: list[dict[str, Any]] = []

    def register(self, capability: Capability, adapter: Callable[[dict[str, Any]], dict[str, Any]]) -> None:
        if capability.name in self.capabilities:
            raise ValueError(f"duplicate capability: {capability.name}")
        self.capabilities[capability.name] = capability
        self.adapters[capability.name] = adapter

    def observe(self, state: dict[str, Any]) -> dict[str, Any]:
        self.basis_generation += 1
        r = receipt("remote.observe", {"basis_generation": self.basis_generation, "state": state})
        self.history.append(r)
        return r

    def act(self, capability_name: str, action: dict[str, Any], *, basis_generation: int) -> dict[str, Any]:
        if capability_name not in self.capabilities:
            return receipt("remote.refused", {"reason": "unknown_capability", "capability": capability_name})
        cap = self.capabilities[capability_name]
        if cap.mutating and int(basis_generation) != self.basis_generation:
            return receipt("remote.refused", {
                "reason": "stale_basis",
                "capability": capability_name,
                "provided": int(basis_generation),
                "current": self.basis_generation,
            })
        result = self.adapters[capability_name](dict(action))
        ok = isinstance(result, dict) and bool(result.get("ok")) and bool(result.get("verified", result.get("ok")))
        r = receipt("remote.effect" if ok else "remote.unverified", {
            "capability": capability_name,
            "basis_generation": self.basis_generation,
            "reversible": cap.reversible,
            "result": result,
        })
        self.history.append(r)
        return r


@dataclass
class GeneratedApp:
    name: str
    root: Path
    entry: Path
    tests: Path
    metadata: dict[str, Any] = field(default_factory=dict)


class AppMaker:
    """Generate -> inspect -> build -> test -> run -> repair loop.

    This uses a tiny Python target in the benchmark court so the maker itself can
    be tested on any host before platform-specific generators are admitted.
    """

    def generate_fixture(self, root: Path, *, broken: bool = False) -> GeneratedApp:
        app_root = root / "generated_app"
        app_root.mkdir(parents=True, exist_ok=True)
        entry = app_root / "app.py"
        tests = app_root / "test_app.py"
        entry.write_text(
            "def transform(x):\n    return x * 2\n\nif __name__ == '__main__':\n    print(transform(21))\n"
            if not broken
            else "def transform(x):\n    return x + 1\n\nif __name__ == '__main__':\n    print(transform(21))\n",
            encoding="utf-8",
        )
        tests.write_text(
            "import app\nassert app.transform(21) == 42\nprint('APP_TEST_OK')\n",
            encoding="utf-8",
        )
        return GeneratedApp("fixture", app_root, entry, tests)

    @staticmethod
    def inspect(app: GeneratedApp) -> dict[str, Any]:
        files = sorted(p.name for p in app.root.iterdir() if p.is_file())
        return receipt("maker.inspect", {"name": app.name, "files": files})

    @staticmethod
    def test(app: GeneratedApp) -> dict[str, Any]:
        p = subprocess.run(
            [sys.executable, app.tests.name], cwd=app.root, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=10,
        )
        return receipt("maker.test", {"returncode": p.returncode, "stdout": p.stdout[-4000:]})

    @staticmethod
    def run(app: GeneratedApp) -> dict[str, Any]:
        p = subprocess.run(
            [sys.executable, app.entry.name], cwd=app.root, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=10,
        )
        return receipt("maker.run", {"returncode": p.returncode, "stdout": p.stdout[-4000:]})

    @staticmethod
    def repair(app: GeneratedApp) -> dict[str, Any]:
        src = app.entry.read_text(encoding="utf-8")
        old = "return x + 1"
        if old not in src:
            return receipt("maker.repair", {"changed": False, "reason": "known_fixture_fault_absent"})
        app.entry.write_text(src.replace(old, "return x * 2"), encoding="utf-8")
        return receipt("maker.repair", {"changed": True, "patch": "fixture arithmetic invariant"})

    def court(self) -> dict[str, Any]:
        with tempfile.TemporaryDirectory(prefix="archie-maker-") as td:
            app = self.generate_fixture(Path(td), broken=True)
            inspected = self.inspect(app)
            before = self.test(app)
            repaired = self.repair(app)
            after = self.test(app)
            ran = self.run(app)
            before_rc = int(before["payload"]["returncode"])
            after_rc = int(after["payload"]["returncode"])
            run_rc = int(ran["payload"]["returncode"])
            return receipt("maker.court", {
                "inspect_valid": verify_receipt(inspected),
                "pre_repair_failed": before_rc != 0,
                "repair_changed": bool(repaired["payload"]["changed"]),
                "post_repair_passed": after_rc == 0,
                "run_passed": run_rc == 0 and ran["payload"]["stdout"].strip().endswith("42"),
            })


def available_accelerators() -> dict[str, Any]:
    result: dict[str, Any] = {
        "python": sys.version.split()[0],
        "platform": sys.platform,
        "triton": {"available": False, "version": None},
    }
    try:
        import triton  # type: ignore
        result["triton"] = {"available": True, "version": getattr(triton, "__version__", "unknown")}
    except Exception as exc:
        result["triton"] = {"available": False, "version": None, "reason": type(exc).__name__}
    return result
