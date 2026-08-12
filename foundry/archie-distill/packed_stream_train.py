#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import os
import pathlib
import random
import signal
import subprocess
import sys
import time
from collections import deque
from typing import Any

CANON = pathlib.Path(
    "/home/awesomekai/archie-bench/moonshot/full-model-b/full_step_court.py"
)
CORPUS = pathlib.Path(
    "/home/awesomekai/archie-curie-islands-v2/train.u16"
)
STATE = pathlib.Path(
    "/home/awesomekai/maximal/scratch/packed-stream-v1"
)
CHECKPOINT = STATE / "checkpoint.pt"
HALT = STATE / "HALT.json"
RECEIPTS = STATE / "receipts.jsonl"

NVIDIA_SMI = pathlib.Path("/usr/lib/wsl/lib/nvidia-smi")

ARM = "w1024x2-packed"
BATCH = 32
SEQ = 1024
TOKENS_PER_STEP = BATCH * SEQ
SEED = 20260810

ABORT_C = 78
FORCED_COOL_C = 76
COOL_TARGET_C = 68

SCHEMA = "archie-packed-stream-checkpoint/v1"
SCRIPT_VERSION = "packed-stream-v1"

stop_requested = False
stop_signal = None


def file_sha256(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            block = f.read(8 * 1024 * 1024)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def json_safe(value: Any) -> Any:
    if isinstance(value, float) and not math.isfinite(value):
        if math.isnan(value):
            return "NaN"
        return "Infinity" if value > 0 else "-Infinity"
    if isinstance(value, dict):
        return {key: json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    return value


def is_recoverable_amp_overflow(
    result: dict[str, Any], scale_before: float, scale_after: float
) -> bool:
    loss_value = float(result["loss"])
    grad_value = float(result["grad_norm"])
    return (
        math.isfinite(loss_value)
        and not math.isfinite(grad_value)
        and scale_after < scale_before
    )


def emit(obj: dict[str, Any]) -> None:
    obj = {
        "time_unix": time.time(),
        **obj,
    }

    text = json.dumps(json_safe(obj), sort_keys=True, allow_nan=False)
    print(text, flush=True)

    STATE.mkdir(parents=True, exist_ok=True)
    with RECEIPTS.open("a", buffering=1) as f:
        f.write(text + "\n")


def atomic_json(path: pathlib.Path, obj: dict[str, Any]) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(json_safe(obj), indent=2, sort_keys=True, allow_nan=False) + "\n")
    os.replace(tmp, path)


def handle_signal(signum, _frame) -> None:
    global stop_requested, stop_signal
    stop_requested = True
    stop_signal = int(signum)


signal.signal(signal.SIGTERM, handle_signal)
signal.signal(signal.SIGINT, handle_signal)


def import_court():
    spec = importlib.util.spec_from_file_location("archie_full_step_base", CANON)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import canonical court: {CANON}")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def gpu_snapshot(torch=None) -> dict[str, Any]:
    last_error = None

    for attempt in range(4):
        try:
            out = subprocess.check_output(
                [
                    str(NVIDIA_SMI),
                    "--query-gpu="
                    "temperature.gpu,"
                    "utilization.gpu,"
                    "memory.total,"
                    "power.draw,"
                    "fan.speed",
                    "--format=csv,noheader,nounits",
                ],
                text=True,
                stderr=subprocess.STDOUT,
            ).strip()

            fields = [x.strip() for x in out.split(",")]
            if len(fields) != 5:
                raise ValueError(f"unexpected field count: {out!r}")

            temp, util, total, power, fan = fields

            snap = {
                "temp_c": int(temp),
                "util_pct": int(util),
                "memory_total_mib": int(total),
                "power_w": float(power),
                "fan_pct": int(fan),
            }

            sane = (
                0 <= snap["temp_c"] <= 100
                and 0 <= snap["util_pct"] <= 100
                and 1024 <= snap["memory_total_mib"] <= 32768
                and 0.0 <= snap["power_w"] <= 250.0
                and 0 <= snap["fan_pct"] <= 100
            )

            if not sane:
                raise ValueError(f"implausible telemetry: {snap}")

            # PyTorch's own allocator numbers are more trustworthy than the
            # broken WSL nvidia-smi memory.used field on this machine.
            if torch is not None and torch.cuda.is_available():
                snap["torch_allocated_mib"] = (
                    torch.cuda.memory_allocated() / 2**20
                )
                snap["torch_reserved_mib"] = (
                    torch.cuda.memory_reserved() / 2**20
                )

            return snap

        except Exception as exc:
            last_error = repr(exc)
            time.sleep(0.15 * (attempt + 1))

    raise RuntimeError(
        f"GPU telemetry unavailable after retries: {last_error}"
    )


def cool_until(target_c: int, torch=None) -> dict[str, Any]:
    started = time.time()
    samples = []

    while True:
        snap = gpu_snapshot(torch)
        samples.append(snap)

        if snap["temp_c"] >= ABORT_C:
            raise RuntimeError(
                f"thermal hard-stop while cooling: {snap['temp_c']}C"
            )

        if snap["temp_c"] <= target_c:
            return {
                "seconds": time.time() - started,
                "samples": samples,
            }

        time.sleep(1.0)


def pace_for_temperature(temp_c: int) -> float:
    # This is deliberately close to the already observed stable envelope
    # rather than trying to maximize instantaneous utilization.
    if temp_c <= 64:
        return 0.45
    if temp_c <= 67:
        return 0.65
    if temp_c <= 70:
        return 0.90
    if temp_c <= 73:
        return 1.20
    if temp_c == 74:
        return 1.60
    if temp_c == 75:
        return 2.00
    return 3.00


class PermutedCorpusSampler:
    """
    Deterministic full-corpus window permutation.

    A coprime modular stride means a start offset is never reused until
    every valid sequence start in the corpus has been visited once.

    No giant list of offsets is kept in RAM.
    """

    def __init__(self, np, corpus_path: pathlib.Path, seq: int) -> None:
        self.np = np
        self.seq = seq
        self.tokens = np.memmap(
            corpus_path,
            dtype=np.uint16,
            mode="r",
        )

        # Valid starts are 0 ... len(tokens)-seq-1 inclusive.
        self.window_count = len(self.tokens) - seq

        if self.window_count <= BATCH:
            raise RuntimeError(
                f"corpus too small: {len(self.tokens)} tokens"
            )

        self.origin = 123456 % self.window_count

        stride = 4099
        while math.gcd(stride, self.window_count) != 1:
            stride += 2

        self.stride = stride
        self.cursor = 0

    def state_dict(self) -> dict[str, int]:
        return {
            "cursor": int(self.cursor),
            "origin": int(self.origin),
            "stride": int(self.stride),
            "window_count": int(self.window_count),
        }

    def load_state_dict(self, state: dict[str, Any]) -> None:
        for name in ("origin", "stride", "window_count"):
            if int(state[name]) != int(getattr(self, name)):
                raise RuntimeError(
                    f"sampler identity mismatch for {name}: "
                    f"{state[name]} != {getattr(self, name)}"
                )

        self.cursor = int(state["cursor"])

    def batch(self, torch):
        epoch_before = self.cursor // self.window_count
        offsets = []

        for index in range(BATCH):
            logical = self.cursor + index
            offset = (
                self.origin + logical * self.stride
            ) % self.window_count
            offsets.append(int(offset))

        rows = self.np.stack(
            [
                self.np.asarray(
                    self.tokens[offset : offset + SEQ + 1],
                    dtype=self.np.int64,
                )
                for offset in offsets
            ]
        )

        self.cursor += BATCH

        cpu = torch.from_numpy(rows).pin_memory()
        gpu = cpu.to(device="cuda", non_blocking=True)

        batch_digest = hashlib.sha256(
            self.np.asarray(offsets, dtype=self.np.int64).tobytes()
        ).hexdigest()[:16]

        return (
            gpu[:, :-1],
            gpu[:, 1:],
            {
                "batch_id": batch_digest,
                "first_offset": offsets[0],
                "last_offset": offsets[-1],
                "cursor_after": int(self.cursor),
                "epoch_before": int(epoch_before),
                "epoch_after": int(self.cursor // self.window_count),
            },
        )


def optimizer_to_device(optimizer, device) -> None:
    # Explicitly move restored Adam states to CUDA.
    for state in optimizer.state.values():
        for key, value in list(state.items()):
            if hasattr(value, "to"):
                state[key] = value.to(device)


def save_checkpoint(
    torch,
    model,
    optimizer,
    scaler,
    sampler,
    step: int,
    tokens_seen: int,
    corpus_sha: str,
    canon_sha: str,
    reason: str,
) -> None:
    payload = {
        "schema": SCHEMA,
        "script_version": SCRIPT_VERSION,
        "arm": ARM,
        "batch_size": BATCH,
        "sequence_length": SEQ,
        "tokens_per_step": TOKENS_PER_STEP,
        "step": int(step),
        "tokens_seen": int(tokens_seen),
        "corpus_path": str(CORPUS),
        "corpus_sha256": corpus_sha,
        "canonical_court_sha256": canon_sha,
        "sampler": sampler.state_dict(),
        "model": model.state_dict(),
        "optimizer": optimizer.state_dict(),
        "scaler": scaler.state_dict(),
        "save_reason": reason,
        "saved_unix": time.time(),
    }

    tmp = CHECKPOINT.with_suffix(".pt.tmp")
    torch.save(payload, tmp)
    os.replace(tmp, CHECKPOINT)

    emit(
        {
            "kind": "STREAM_CHECKPOINT",
            "step": step,
            "tokens_seen": tokens_seen,
            "reason": reason,
            "path": str(CHECKPOINT),
            "bytes": CHECKPOINT.stat().st_size,
        }
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-steps", type=int, default=100_000_000)
    parser.add_argument("--checkpoint-every", type=int, default=250)
    parser.add_argument("--receipt-every", type=int, default=10)
    args = parser.parse_args()

    STATE.mkdir(parents=True, exist_ok=True)

    if HALT.exists():
        emit(
            {
                "kind": "STREAM_REFUSE_HALTED_STATE",
                "halt": json.loads(HALT.read_text()),
            }
        )
        return 0

    corpus_sha = file_sha256(CORPUS)
    canon_sha = file_sha256(CANON)

    # Do not allocate the model while the card is already hot.
    initial = gpu_snapshot()
    if initial["temp_c"] >= ABORT_C:
        emit(
            {
                "kind": "STREAM_THERMAL_ABORT",
                "stage": "startup",
                "gpu": initial,
            }
        )
        return 4

    if initial["temp_c"] > 60:
        cool_until(60)

    base = import_court()
    base.configure_environment()

    stack = base.import_stack()
    np, torch, _, _, clip_function, _ = stack

    torch.manual_seed(SEED)
    torch.cuda.manual_seed_all(SEED)
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
    torch.backends.cudnn.benchmark = False

    sampler = PermutedCorpusSampler(np, CORPUS, SEQ)

    model, optimizer, scaler, manifest = base.build_arm(stack, ARM)

    step = 0
    tokens_seen = 0
    resumed = False

    if CHECKPOINT.exists():
        payload = torch.load(
            CHECKPOINT,
            map_location="cpu",
            weights_only=False,
        )

        expected = {
            "schema": SCHEMA,
            "arm": ARM,
            "batch_size": BATCH,
            "sequence_length": SEQ,
            "corpus_sha256": corpus_sha,
            "canonical_court_sha256": canon_sha,
        }

        for key, wanted in expected.items():
            got = payload.get(key)
            if got != wanted:
                raise RuntimeError(
                    f"checkpoint identity mismatch: "
                    f"{key}={got!r}, expected {wanted!r}"
                )

        model.load_state_dict(payload["model"])
        optimizer.load_state_dict(payload["optimizer"])
        optimizer_to_device(optimizer, torch.device("cuda"))
        scaler.load_state_dict(payload["scaler"])
        sampler.load_state_dict(payload["sampler"])

        step = int(payload["step"])
        tokens_seen = int(payload["tokens_seen"])
        resumed = True

    torch.cuda.synchronize()
    torch.cuda.reset_peak_memory_stats()

    emit(
        {
            "kind": "STREAM_READY",
            "resumed": resumed,
            "step": step,
            "tokens_seen": tokens_seen,
            "arm": ARM,
            "batch_size": BATCH,
            "sequence_length": SEQ,
            "tokens_per_step": TOKENS_PER_STEP,
            "corpus_path": str(CORPUS),
            "corpus_sha256": corpus_sha,
            "corpus_tokens": int(len(sampler.tokens)),
            "unique_window_starts_per_epoch": int(
                sampler.window_count
            ),
            "sampler_origin": sampler.origin,
            "sampler_stride": sampler.stride,
            "sampler_cursor": sampler.cursor,
            "canonical_court_sha256": canon_sha,
            "model": manifest,
            "gpu": gpu_snapshot(torch),
            "claim_boundary": (
                "scratch streamed-training artifact only; "
                "not admitted or promoted"
            ),
        }
    )

    compute_history = deque(maxlen=10)
    wall_history = deque(maxlen=10)
    data_history = deque(maxlen=10)
    amp_overflow_retries = 0
    max_amp_overflow_retries = 8

    event_start = torch.cuda.Event(enable_timing=True)
    event_end = torch.cuda.Event(enable_timing=True)

    while step < args.max_steps:
        if stop_requested:
            save_checkpoint(
                torch,
                model,
                optimizer,
                scaler,
                sampler,
                step,
                tokens_seen,
                corpus_sha,
                canon_sha,
                f"signal-{stop_signal}",
            )
            emit(
                {
                    "kind": "STREAM_STOP",
                    "reason": "signal",
                    "signal": stop_signal,
                    "step": step,
                    "tokens_seen": tokens_seen,
                }
            )
            return 0

        before = gpu_snapshot(torch)

        if before["temp_c"] >= ABORT_C:
            save_checkpoint(
                torch,
                model,
                optimizer,
                scaler,
                sampler,
                step,
                tokens_seen,
                corpus_sha,
                canon_sha,
                "thermal-before-step",
            )
            emit(
                {
                    "kind": "STREAM_THERMAL_ABORT",
                    "stage": "before-step",
                    "step": step,
                    "gpu": before,
                }
            )
            return 4

        # At 76-77C, do not take another optimizer step.
        # Cool to 68C first.
        forced_cooling = None
        if before["temp_c"] >= FORCED_COOL_C:
            forced_cooling = cool_until(COOL_TARGET_C, torch)

        wall_started = time.perf_counter()

        data_started = time.perf_counter()
        cursor_before = int(sampler.cursor)
        scale_before = float(scaler.get_scale())
        inputs, targets, stream = sampler.batch(torch)
        torch.cuda.synchronize()
        data_seconds = time.perf_counter() - data_started

        event_start.record()

        result = base.execute_step(
            torch,
            model,
            optimizer,
            scaler,
            clip_function,
            inputs,
            targets,
        )

        event_end.record()
        torch.cuda.synchronize()

        compute_seconds = (
            event_start.elapsed_time(event_end) / 1000.0
        )

        finite = (
            bool(result["finite"])
            and math.isfinite(float(result["loss"]))
            and math.isfinite(float(result["grad_norm"]))
        )

        if not finite:
            scale_after = float(scaler.get_scale())
            amp_overflow = is_recoverable_amp_overflow(
                result, scale_before, scale_after
            )

            if amp_overflow and amp_overflow_retries < max_amp_overflow_retries:
                sampler.cursor = cursor_before
                amp_overflow_retries += 1
                emit(
                    {
                        "kind": "STREAM_AMP_OVERFLOW_RETRY",
                        "step": step,
                        "tokens_seen": tokens_seen,
                        "result": result,
                        "stream": stream,
                        "scale_before": scale_before,
                        "scale_after": scale_after,
                        "retry": amp_overflow_retries,
                        "max_retries": max_amp_overflow_retries,
                    }
                )
                continue

            halt = {
                "kind": "NONFINITE",
                "step": step,
                "tokens_seen": tokens_seen,
                "result": result,
                "stream": stream,
                "scale_before": scale_before,
                "scale_after": scale_after,
                "amp_overflow_retries": amp_overflow_retries,
                "created_unix": time.time(),
            }
            atomic_json(HALT, halt)
            emit({"kind": "STREAM_NONFINITE_HALT", **halt})
            return 0

        amp_overflow_retries = 0
        step += 1
        tokens_seen += TOKENS_PER_STEP

        after_compute = gpu_snapshot(torch)

        if after_compute["temp_c"] >= ABORT_C:
            save_checkpoint(
                torch,
                model,
                optimizer,
                scaler,
                sampler,
                step,
                tokens_seen,
                corpus_sha,
                canon_sha,
                "thermal-after-step",
            )
            emit(
                {
                    "kind": "STREAM_THERMAL_ABORT",
                    "stage": "after-step",
                    "step": step,
                    "tokens_seen": tokens_seen,
                    "gpu": after_compute,
                }
            )
            return 4

        sleep_s = pace_for_temperature(
            after_compute["temp_c"]
        )

        if after_compute["temp_c"] >= FORCED_COOL_C:
            cool = cool_until(COOL_TARGET_C, torch)
            forced_cooling = cool
            sleep_s = 0.0
        else:
            time.sleep(sleep_s)

        after_sleep = gpu_snapshot(torch)

        wall_seconds = time.perf_counter() - wall_started

        compute_history.append(compute_seconds)
        data_history.append(data_seconds)
        wall_history.append(wall_seconds)

        if step % args.receipt_every == 0:
            compute_mean = sum(compute_history) / len(
                compute_history
            )
            data_mean = sum(data_history) / len(data_history)
            wall_mean = sum(wall_history) / len(wall_history)

            emit(
                {
                    "kind": "STREAM_RECEIPT",
                    "step": step,
                    "tokens_seen": tokens_seen,
                    "loss": float(result["loss"]),
                    "grad_norm": float(result["grad_norm"]),
                    "finite": True,
                    "stream": stream,
                    "compute_mean_step_s": compute_mean,
                    "compute_tokens_s": (
                        TOKENS_PER_STEP / compute_mean
                    ),
                    "data_mean_step_s": data_mean,
                    "wall_mean_step_s": wall_mean,
                    "wall_tokens_s": (
                        TOKENS_PER_STEP / wall_mean
                    ),
                    "sleep_s_last": sleep_s,
                    "forced_cooling": forced_cooling,
                    "gpu_after_compute": after_compute,
                    "gpu_after_sleep": after_sleep,
                    "peak_allocated_mib": (
                        torch.cuda.max_memory_allocated() / 2**20
                    ),
                    "peak_reserved_mib": (
                        torch.cuda.max_memory_reserved() / 2**20
                    ),
                    "timing_authority": "cuda_event",
                    "data_mode": (
                        "deterministic-coprime-full-corpus-window-permutation"
                    ),
                }
            )

        if step % args.checkpoint_every == 0:
            save_checkpoint(
                torch,
                model,
                optimizer,
                scaler,
                sampler,
                step,
                tokens_seen,
                corpus_sha,
                canon_sha,
                "periodic",
            )

    save_checkpoint(
        torch,
        model,
        optimizer,
        scaler,
        sampler,
        step,
        tokens_seen,
        corpus_sha,
        canon_sha,
        "max-steps",
    )

    emit(
        {
            "kind": "STREAM_COMPLETE",
            "step": step,
            "tokens_seen": tokens_seen,
        }
    )

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())

    except Exception as exc:
        text = f"{type(exc).__name__}: {exc}"

        # OOM is sticky: don't restart it forever.
        if "out of memory" in text.lower():
            atomic_json(
                HALT,
                {
                    "kind": "OOM",
                    "error": text,
                    "created_unix": time.time(),
                },
            )
            emit(
                {
                    "kind": "STREAM_OOM_HALT",
                    "error": text,
                }
            )
            raise SystemExit(0)

        # CUDA/driver transient failures are restartable.
        emit(
            {
                "kind": "STREAM_WORKER_ERROR",
                "error": text,
            }
        )
        raise SystemExit(6)
