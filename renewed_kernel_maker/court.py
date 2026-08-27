from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from core import Capability, SeatLease, UniversalRemoteKernel, receipt, verify_receipt
import corpus_foundry
import distill
import maker_fixture
import model_sourcing
import preference_train
import render_ffmpeg
import render_integration
import synthetic_pref
import video_editor_v2
import voxel_game


def cold_start_court() -> dict:
    code = (
        "import sys;sys.path.insert(0," + repr(str(HERE)) + ");"
        "import core,maker_fixture,video_editor_v2,render_ffmpeg,render_integration,synthetic_pref,preference_train,distill,voxel_game,corpus_foundry,model_sourcing;"
        "print(core.SCHEMA)"
    )
    t0 = time.perf_counter_ns()
    p = subprocess.run([sys.executable, "-c", code], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=20)
    elapsed_ns = time.perf_counter_ns() - t0
    return receipt("court.cold_start", {"returncode": p.returncode,"elapsed_ns": elapsed_ns,"elapsed_ms": elapsed_ns / 1e6,"stdout": p.stdout[-2000:],"passes": p.returncode == 0 and "archie-kernel-maker/v1" in p.stdout})


def receipt_court() -> dict:
    value = receipt("fixture", {"z": 1, "a": [3, 2, 1]}); again = receipt("fixture", {"a": [3, 2, 1], "z": 1}); corrupt = json.loads(json.dumps(value)); corrupt["payload"]["z"] = 2
    passes = verify_receipt(value) and value["sha256"] == again["sha256"] and not verify_receipt(corrupt)
    return receipt("court.receipt", {"valid": verify_receipt(value), "order_independent": value["sha256"] == again["sha256"], "corruption_detected": not verify_receipt(corrupt), "passes": passes})


def stale_seat_court() -> dict:
    seat = SeatLease(); a = seat.claim("alpha", now=10.0, ttl_s=1.0); refused = seat.claim("beta", now=10.5, ttl_s=1.0); takeover = seat.claim("beta", now=11.01, ttl_s=1.0)
    good = a["payload"].get("occupant") == "alpha" and refused["kind"] == "seat.refused" and takeover["payload"].get("occupant") == "beta" and takeover["payload"].get("takeover") is True
    return receipt("court.stale_seat", {"alpha": a, "pre_expiry": refused, "post_expiry": takeover, "passes": good})


def remote_court() -> dict:
    k = UniversalRemoteKernel(); seen: list[dict] = []
    def adapter(action: dict) -> dict: seen.append(action); return {"ok": True, "verified": True, "proof": {"echo": action}}
    k.register(Capability("desktop.type", mutating=True, reversible=True), adapter)
    basis = k.observe({"focused": "editor"}); gen = basis["payload"]["basis_generation"]
    good = k.act("desktop.type", {"text": "x"}, basis_generation=gen); k.observe({"focused": "other"})
    stale = k.act("desktop.type", {"text": "should-not-run"}, basis_generation=gen); unknown = k.act("desktop.unknown", {}, basis_generation=k.basis_generation)
    passes = good["kind"] == "remote.effect" and stale["kind"] == "remote.refused" and stale["payload"].get("reason") == "stale_basis" and unknown["kind"] == "remote.refused" and seen == [{"text": "x"}]
    return receipt("court.remote", {"good": good, "stale": stale, "unknown": unknown, "executed": seen, "passes": passes})


def maker_court() -> dict:
    r = maker_fixture.court(); p = r["payload"]; passes = all(bool(p.get(k)) for k in ("inspect_valid", "pre_repair_failed", "repair_receipt", "cache_invalidated", "post_repair_passed", "run_passed")); return receipt("court.maker", {"maker": p, "passes": passes})

def editor_court() -> dict:
    r = video_editor_v2.court(); p = r["payload"]; b = p["benchmark"]; passes = all(bool(p.get(k)) for k in ("add_receipt", "split_receipt", "undo_receipt", "redo_receipt", "redo_exact", "portable_roundtrip", "save_receipt")) and bool(b["deterministic_replay"]) and bool(b["exact_frame_roundtrip"]) and bool(b["mutation_receipts_valid"]); return receipt("court.editor", {"editor": p, "passes": passes})
def render_court() -> dict:
    r = render_ffmpeg.court(); return receipt("court.render", {"render": r["payload"], "passes": bool(r["payload"].get("passes"))})
def render_integration_court() -> dict:
    r = render_integration.court(); return receipt("court.render_integration", {"integration": r["payload"], "passes": bool(r["payload"].get("passes"))})
def voxel_court() -> dict:
    r=voxel_game.court(); return receipt("court.voxel", {"voxel":r["payload"],"passes":bool(r["payload"].get("passes"))})
def corpus_court() -> dict:
    r=corpus_foundry.court(); return receipt("court.corpus", {"corpus":r["payload"],"passes":bool(r["payload"].get("passes"))})
def sourcing_court() -> dict:
    r=model_sourcing.court(); return receipt("court.model_sourcing", {"model_sourcing":r["payload"],"passes":bool(r["payload"].get("passes"))})
def distill_court() -> dict:
    r = distill.court(); p = r["payload"]; passes = bool(p["kl_oracle"]["passes"]) and p["import_attempt"]["status"] in {"BLOCKED", "READY_TO_MATERIALIZE"} and p["triton"]["status"] in {"SKIP", "PASS"}; return receipt("court.distill", {"distill": p, "passes": passes})
def synthetic_court() -> dict:
    r = synthetic_pref.court(); return receipt("court.synthetic", {"synthetic": r["payload"], "passes": bool(r["payload"]["passes"])})
def preference_training_court() -> dict:
    r = preference_train.court(); return receipt("court.preference_training", {"training": r["payload"], "passes": bool(r["payload"].get("passes"))})


def run() -> dict:
    courts = {
        "cold_start": cold_start_court(), "receipts": receipt_court(), "stale_seat": stale_seat_court(), "remote": remote_court(), "maker": maker_court(),
        "video_editor": editor_court(), "video_render": render_court(), "video_render_integration": render_integration_court(), "voxel_game": voxel_court(),
        "corpus_foundry": corpus_court(), "model_sourcing": sourcing_court(), "distill": distill_court(), "synthetic_preference": synthetic_court(), "preference_training": preference_training_court(),
    }
    passes = {name: bool(value["payload"].get("passes")) for name, value in courts.items()}
    return receipt("kernel-maker.promotion-court", {"courts": courts, "passes": passes, "all_required_pass": all(passes.values()), "promotion": "ADMIT" if all(passes.values()) else "REFUSE"})

if __name__ == "__main__":
    out = run(); print(json.dumps(out, indent=2, default=str)); raise SystemExit(0 if out["payload"]["all_required_pass"] else 1)
