#!/usr/bin/env python3
"""Derive a memory-bounded effective-batch-32 trainer without mutating source."""
from __future__ import annotations

import argparse
import hashlib
import pathlib


def once(text: str, old: str, new: str, label: str) -> str:
    n = text.count(old)
    if n != 1:
        raise RuntimeError(f"{label}: expected exactly one source match, found {n}")
    return text.replace(old, new, 1)


ACCUM = r'''
def execute_accumulated_step(torch, model, optimizer, scaler, clip_function, sampler):
    """One logical batch-32 update from bounded physical microbatches."""
    optimizer.zero_grad(set_to_none=True)
    losses = []
    streams = []
    data_seconds = 0.0
    compute_seconds = 0.0
    event_start = torch.cuda.Event(enable_timing=True)
    event_end = torch.cuda.Event(enable_timing=True)

    for _micro_index in range(ACCUM_STEPS):
        data_started = time.perf_counter()
        inputs, targets, stream = sampler.batch(torch)
        torch.cuda.synchronize()
        data_seconds += time.perf_counter() - data_started

        event_start.record()
        with torch.autocast("cuda", dtype=torch.float16):
            micro_result = model(inputs, targets)
            micro_loss = micro_result["loss"] + micro_result["auxiliary_loss"] * 0.05
        scaler.scale(micro_loss / ACCUM_STEPS).backward()
        event_end.record()
        torch.cuda.synchronize()
        compute_seconds += event_start.elapsed_time(event_end) / 1000.0
        losses.append(float(micro_loss.detach()))
        streams.append(stream)
        del micro_result, micro_loss, inputs, targets

    scaler.unscale_(optimizer)
    active_gradient_parameters = sum(
        p.numel() for p in model.parameters() if p.grad is not None
    )
    grad_norm, finite = clip_function(model.parameters(), 1.0)
    scaler.step(optimizer)
    scaler.update()
    optimizer.zero_grad(set_to_none=True)

    first, last = streams[0], streams[-1]
    stream = {
        "batch_id": hashlib.sha256(
            "|".join(item["batch_id"] for item in streams).encode()
        ).hexdigest()[:16],
        "first_offset": first["first_offset"],
        "last_offset": last["last_offset"],
        "cursor_after": last["cursor_after"],
        "epoch_before": first["epoch_before"],
        "epoch_after": last["epoch_after"],
        "micro_batch_size": MICRO_BATCH,
        "accumulation_steps": ACCUM_STEPS,
        "micro_batch_ids": [item["batch_id"] for item in streams],
    }
    result = {
        "loss": sum(losses) / len(losses),
        "grad_norm": float(grad_norm),
        "finite": bool(finite),
        "active_gradient_parameters": active_gradient_parameters,
    }
    return result, stream, data_seconds, compute_seconds

'''


def derive(source: pathlib.Path, target: pathlib.Path, micro_batch: int) -> dict:
    if micro_batch < 1 or 32 % micro_batch:
        raise ValueError("micro batch must be a positive divisor of 32")
    text = source.read_text("utf-8")
    source_sha = hashlib.sha256(text.encode()).hexdigest()

    text = once(
        text,
        'BATCH = 32\nSEQ = 1024\nTOKENS_PER_STEP = BATCH * SEQ\n',
        'BATCH = 32  # effective optimizer batch / checkpoint identity\n'
        f'MICRO_BATCH = {micro_batch}\n'
        'ACCUM_STEPS = BATCH // MICRO_BATCH\n'
        'SEQ = 1024\nTOKENS_PER_STEP = BATCH * SEQ\n',
        "batch constants",
    )
    text = once(text, 'SCRIPT_VERSION = "packed-stream-v1"',
                'SCRIPT_VERSION = "packed-stream-v1-resident-microbatch"', "version")
    text = once(text, 'if self.window_count <= BATCH:',
                'if self.window_count <= MICRO_BATCH:', "sampler guard")
    text = once(text, 'for index in range(BATCH):',
                'for index in range(MICRO_BATCH):', "sampler loop")
    text = once(text, 'self.cursor += BATCH',
                'self.cursor += MICRO_BATCH', "sampler cursor")
    marker = '\ndef optimizer_to_device(optimizer, device) -> None:\n'
    text = once(text, marker, '\n' + ACCUM + marker.lstrip('\n'), "accum insert")

    old = '''        data_started = time.perf_counter()\n        cursor_before = int(sampler.cursor)\n        scale_before = float(scaler.get_scale())\n        inputs, targets, stream = sampler.batch(torch)\n        torch.cuda.synchronize()\n        data_seconds = time.perf_counter() - data_started\n\n        event_start.record()\n\n        result = base.execute_step(\n            torch,\n            model,\n            optimizer,\n            scaler,\n            clip_function,\n            inputs,\n            targets,\n        )\n\n        event_end.record()\n        torch.cuda.synchronize()\n\n        compute_seconds = (\n            event_start.elapsed_time(event_end) / 1000.0\n        )\n'''
    new = '''        cursor_before = int(sampler.cursor)\n        scale_before = float(scaler.get_scale())\n        result, stream, data_seconds, compute_seconds = execute_accumulated_step(\n            torch, model, optimizer, scaler, clip_function, sampler\n        )\n'''
    text = once(text, old, new, "logical optimizer step")

    # This 8-space occurrence is checkpoint serialization, not the 12-space
    # resume identity or STREAM_READY dict. Keep batch_size=32 so the old
    # checkpoint remains load-compatible, while recording physical geometry.
    checkpoint = '        "batch_size": BATCH,\n        "sequence_length": SEQ,\n'
    text = once(
        text,
        checkpoint,
        '        "batch_size": BATCH,\n'
        '        "micro_batch_size": MICRO_BATCH,\n'
        '        "accumulation_steps": ACCUM_STEPS,\n'
        '        "sequence_length": SEQ,\n',
        "checkpoint geometry",
    )

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, "utf-8")
    target_sha = hashlib.sha256(text.encode()).hexdigest()
    return {
        "source": str(source), "source_sha256": source_sha,
        "target": str(target), "target_sha256": target_sha,
        "effective_batch": 32, "micro_batch": micro_batch,
        "accumulation_steps": 32 // micro_batch,
        "tokens_per_optimizer_step": 32768,
    }


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--source", default="/home/awesomekai/maximal/scratch/packed-stream-v1/stream_train.py")
    p.add_argument("--target", default="/home/awesomekai/maximal/scratch/packed-stream-v1/stream_train_resident.py")
    p.add_argument("--micro-batch", type=int, default=4)
    a = p.parse_args()
    print(derive(pathlib.Path(a.source), pathlib.Path(a.target), a.micro_batch))


if __name__ == "__main__":
    main()
