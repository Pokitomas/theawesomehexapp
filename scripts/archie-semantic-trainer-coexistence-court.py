#!/usr/bin/env python3
"""Court foreground semantic latency while background ARCHIE training is live.

A fast semantic benchmark run while the trainer is idle proves nothing about
coexistence. This court fail-closes unless the named trainer unit is active at
both the beginning and end, then measures time-to-first-delta against the local
llama.cpp server while sampling GPU telemetry and trainer receipts.
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


def tail_jsonl(path: pathlib.Path, n: int = 16) -> list[dict[str, Any]]:
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
    p.add_argument("--runs", type=int, default=5)
    p.add_argument("--max-first-delta-ms", type=float, default=250.0)
    p.add_argument("--output", default="/home/awesomekai/archie-remote/presence/coexistence-court-latest.json")
    args = p.parse_args()

    start_unit = unit_state(args.trainer)
    before_gpu = gpu_snapshot()
    before_receipts = tail_jsonl(pathlib.Path(args.receipts))
    results = []
    for i in range(args.runs):
        # Stable wording makes model-side prefix/cache differences visible rather
        # than confounding the scheduling court with prompt novelty.
        results.append(semantic_stream(args.host, args.port, args.model, "Say READY only.", 8))
    after_gpu = gpu_snapshot()
    end_unit = unit_state(args.trainer)
    after_receipts = tail_jsonl(pathlib.Path(args.receipts))

    first = [r["first_delta_ms"] for r in results if r["first_delta_ms"] is not None]
    median_first = statistics.median(first) if first else None
    unit_live_entire_court = start_unit.get("active") == "active" and end_unit.get("active") == "active"
    all_semantic_ok = len(first) == len(results) and all(r.get("http_status") == 200 and not r.get("error") for r in results)
    latency_ok = median_first is not None and median_first <= args.max_first_delta_ms
    receipt_advanced = before_receipts != after_receipts

    verdict = "PASS" if unit_live_entire_court and all_semantic_ok and latency_ok else "FAIL"
    if not unit_live_entire_court:
        verdict = "INCONCLUSIVE_TRAINER_NOT_LIVE"

    record = {
        "schema": "archie/semantic-trainer-coexistence-court-v1",
        "time_unix": time.time(),
        "trainer": args.trainer,
        "trainer_start": start_unit,
        "trainer_end": end_unit,
        "trainer_receipt_advanced": receipt_advanced,
        "gpu_before": before_gpu,
        "gpu_after": after_gpu,
        "semantic_runs": results,
        "median_first_delta_ms": median_first,
        "precommitted_max_first_delta_ms": args.max_first_delta_ms,
        "all_semantic_ok": all_semantic_ok,
        "verdict": verdict,
        "claim_boundary": "PASS proves foreground semantic latency under this measured background trainer geometry only; it does not prove the final ARCHIE architecture.",
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
