#!/usr/bin/env python3
"""Court foreground semantic latency while background ARCHIE training advances.

A trainer unit merely being `active` is insufficient: it could be blocked on a
lock, restoring a checkpoint, or otherwise not doing gradient work. This court
therefore fail-closes unless a STREAM_RECEIPT step advances during the measured
window while the named unit remains active. Foreground semantic TTFT is sampled
throughout that same window.
"""
from __future__ import annotations

import argparse
import http.client
import json
import pathlib
import statistics
import subprocess
import time
from typing import Any

DEFAULT_TRAINER = "archie-gpt56-packed-stream-resident-v1.service"
DEFAULT_RECEIPTS = pathlib.Path("/home/awesomekai/maximal/scratch/packed-stream-resident-v1/receipts.jsonl")


def run(argv: list[str], timeout: float = 4.0) -> subprocess.CompletedProcess[str]:
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout, check=False)


def unit_state(unit: str) -> dict[str, Any]:
    p = run(["systemctl", "--user", "show", unit, "-p", "LoadState", "-p", "ActiveState", "-p", "SubState", "-p", "MainPID", "-p", "ExecStart"])
    values: dict[str, str] = {}
    for line in p.stdout.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            values[k] = v
    return {
        "query_ok": p.returncode == 0,
        "load": values.get("LoadState"),
        "active": values.get("ActiveState"),
        "sub": values.get("SubState"),
        "pid": int(values.get("MainPID") or 0),
        "exec": values.get("ExecStart", ""),
    }


def gpu_snapshot() -> dict[str, Any]:
    p = run([
        "nvidia-smi",
        "--query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw",
        "--format=csv,noheader,nounits",
    ])
    line = p.stdout.strip().splitlines()[0] if p.returncode == 0 and p.stdout.strip() else ""
    parts = [x.strip() for x in line.split(",")]
    return {
        "ok": p.returncode == 0 and len(parts) >= 6,
        "raw": line,
        "name": parts[0] if len(parts) >= 1 else None,
        "memory_used_mib": float(parts[1]) if len(parts) >= 2 else None,
        "memory_total_mib": float(parts[2]) if len(parts) >= 3 else None,
        "util_pct": float(parts[3]) if len(parts) >= 4 else None,
        "temp_c": float(parts[4]) if len(parts) >= 5 else None,
        "power_w": float(parts[5]) if len(parts) >= 6 else None,
    }


def tail_jsonl(path: pathlib.Path, n: int = 64) -> list[dict[str, Any]]:
    try:
        lines = path.read_text("utf-8", errors="replace").splitlines()[-n:]
    except Exception:
        return []
    out = []
    for line in lines:
        try:
            out.append(json.loads(line))
        except Exception:
            pass
    return out


def last_stream_step(path: pathlib.Path) -> int | None:
    for row in reversed(tail_jsonl(path)):
        if row.get("kind") == "STREAM_RECEIPT" and isinstance(row.get("step"), int):
            return int(row["step"])
    return None


def semantic_stream(host: str, port: int, model: str, prompt: str, max_tokens: int) -> dict[str, Any]:
    body = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": "Reply compactly. Output READY only."},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.0,
        "max_tokens": max_tokens,
        "stream": True,
        "cache_prompt": True,
    })
    conn = http.client.HTTPConnection(host, port, timeout=30)
    start = time.perf_counter()
    first = None
    output = ""
    status = None
    error = None
    try:
        conn.request("POST", "/v1/chat/completions", body=body, headers={"Content-Type": "application/json"})
        r = conn.getresponse()
        status = r.status
        if r.status != 200:
            error = r.read(4096).decode("utf-8", "replace")
        else:
            while True:
                raw = r.readline()
                if not raw:
                    break
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                try:
                    event = json.loads(payload)
                    delta = str(event.get("choices", [{}])[0].get("delta", {}).get("content") or "")
                except Exception:
                    continue
                if delta:
                    if first is None:
                        first = time.perf_counter()
                    output += delta
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"
    finally:
        done = time.perf_counter()
        conn.close()
    return {
        "http_status": status,
        "first_delta_ms": None if first is None else round((first - start) * 1000, 3),
        "done_ms": round((done - start) * 1000, 3),
        "output": output.strip(),
        "error": error,
    }


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--trainer", default=DEFAULT_TRAINER)
    p.add_argument("--receipts", default=str(DEFAULT_RECEIPTS))
    p.add_argument("--host", default="172.22.64.1")
    p.add_argument("--port", type=int, default=18767)
    p.add_argument("--model", default="local")
    p.add_argument("--runs", type=int, default=8)
    p.add_argument("--inter-run-ms", type=float, default=350.0)
    p.add_argument("--progress-wait-s", type=float, default=12.0)
    p.add_argument("--max-first-delta-ms", type=float, default=250.0)
    p.add_argument("--output", default="/home/awesomekai/archie-remote/presence/coexistence-court-latest.json")
    args = p.parse_args()

    receipts = pathlib.Path(args.receipts)
    start_unit = unit_state(args.trainer)
    before_step = last_stream_step(receipts)
    before_gpu = gpu_snapshot()
    results = []
    gpu_samples = [before_gpu]

    for i in range(args.runs):
        # Stable wording makes model-side prefix/cache differences visible rather
        # than confounding the scheduling court with prompt novelty.
        results.append(semantic_stream(args.host, args.port, args.model, "Say READY only.", 8))
        gpu_samples.append(gpu_snapshot())
        if i + 1 < args.runs:
            time.sleep(max(0.0, args.inter_run_ms) / 1000.0)

    # If the semantic samples happened to fall entirely between optimizer
    # receipts, keep the court open briefly. This prevents a fast idle-ish burst
    # from being mislabeled coexistence while still bounding the experiment.
    deadline = time.monotonic() + max(0.0, args.progress_wait_s)
    after_step = last_stream_step(receipts)
    while (after_step is None or before_step is None or after_step <= before_step) and time.monotonic() < deadline:
        if unit_state(args.trainer).get("active") != "active":
            break
        time.sleep(0.1)
        after_step = last_stream_step(receipts)

    after_gpu = gpu_snapshot()
    gpu_samples.append(after_gpu)
    end_unit = unit_state(args.trainer)

    first = [r["first_delta_ms"] for r in results if r["first_delta_ms"] is not None]
    median_first = statistics.median(first) if first else None
    max_first = max(first) if first else None
    unit_live_entire_court = start_unit.get("active") == "active" and end_unit.get("active") == "active"
    all_semantic_ok = len(first) == len(results) and all(r.get("http_status") == 200 and not r.get("error") for r in results)
    latency_ok = median_first is not None and median_first <= args.max_first_delta_ms
    receipt_advanced = before_step is not None and after_step is not None and after_step > before_step

    if not unit_live_entire_court:
        verdict = "INCONCLUSIVE_TRAINER_NOT_LIVE"
    elif not receipt_advanced:
        verdict = "INCONCLUSIVE_NO_TRAINER_PROGRESS"
    else:
        verdict = "PASS" if all_semantic_ok and latency_ok else "FAIL"

    record = {
        "schema": "archie/semantic-trainer-coexistence-court-v2",
        "time_unix": time.time(),
        "trainer": args.trainer,
        "trainer_start": start_unit,
        "trainer_end": end_unit,
        "trainer_step_before": before_step,
        "trainer_step_after": after_step,
        "trainer_receipt_advanced": receipt_advanced,
        "gpu_samples": gpu_samples,
        "semantic_runs": results,
        "median_first_delta_ms": median_first,
        "max_first_delta_ms": max_first,
        "precommitted_max_median_first_delta_ms": args.max_first_delta_ms,
        "all_semantic_ok": all_semantic_ok,
        "verdict": verdict,
        "claim_boundary": "PASS proves foreground semantic latency while this exact background trainer demonstrably advanced at least one optimizer receipt; it does not prove the final ARCHIE architecture.",
    }
    out = pathlib.Path(args.output).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + f".tmp-{time.time_ns()}")
    tmp.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", "utf-8")
    tmp.replace(out)
    print(json.dumps(record, indent=2, sort_keys=True))
    raise SystemExit(0 if verdict == "PASS" else 1)


if __name__ == "__main__":
    main()
