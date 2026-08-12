#!/usr/bin/env python3
"""Derive a memory-bounded packed-stream trainer without mutating the source.

The canonical scratch trainer uses physical batch 32. On a 6 GiB RTX 2060 that
reserves ~5.5 GiB and evicts the resident semantic model. This transformer has
zero dropout and no batch-statistics layers, so eight microbatches of four with
loss/8 accumulation preserve the effective batch-32 gradient up to floating
point/AMP ordering while reducing activation memory substantially.

This script fail-closes on exact source snippets and writes a sibling variant.
It does not touch the canonical trainer.
"""
from __future__ import annotations

import argparse
import hashlib
import pathlib


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


ACCUM_FN = r'''
def execute_accumulated_step(
    torch,
    model,
    optimizer,
    scaler,
    clip_function,
    sampler,
):
    """One effective batch-32 optimizer transaction from bounded microbatches."""
    optimizer.zero_grad(set_to_none=True)
    loss_values = []
    streams = []
    data_seconds = 0.0
    compute_seconds = 0.0
    active_gradient_parameters = 0

    event_start = torch.cuda.Event(enable_timing=True)
    event_end = torch.cuda.Event(enable_timing=True)

    for micro_index in range(ACCUM_STEPS):
        data_started = time.perf_counter()
        inputs, targets, stream = sampler.batch(torch)
        torch.cuda.synchronize()
        data_seconds += time.perf_counter() - data_started

        event_start.record()
        with torch.autocast("cuda", dtype=torch.float16):
            micro_result = model(inputs, targets)
            micro_loss = (
                micro_result["loss"]
                + micro_result["auxiliary_loss"] * 0.05
            )
        scaler.scale(micro_loss / ACCUM_STEPS).backward()
        event_end.record()
        torch.cuda.synchronize()
        compute_seconds += event_start.elapsed_time(event_end) / 1000.0

        loss_values.append(float(micro_loss.detach()))
        streams.append(stream)
        del micro_result, micro_loss, inputs, targets

    scaler.unscale_(optimizer)
    active_gradient_parameters = sum(
        parameter.numel()
        for parameter in model.parameters()
        if parameter.grad is not None
    )
    grad_norm, finite = clip_function(model.parameters(), 1.0)
    scaler.step(optimizer)
    scaler.update()
    optimizer.zero_grad(set_to_none=True)

    first = streams[0]
    last = streams[-1]
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
    return (
        {
            "loss": sum(loss_values) / len(loss_values),
            "grad_norm": float(grad_norm),
            "finite": bool(finite),
            "active_gradient_parameters": active_gradient_parameters,
        },
        stream,
        data_seconds,
        compute_seconds,
    )

'''


def derive(source: pathlib.Path, target: pathlib.Path, micro_batch: int) -> dict:
    if 32 % micro_batch:
        raise ValueError("micro batch must divide effective batch 32 exactly")
    text = source.read_text("utf-8")
    source_sha = hashlib.sha256(text.encode()).hexdigest()

    text = replace_once(
        text,
        'BATCH = 32\nSEQ = 1024\nTOKENS_PER_STEP = BATCH * SEQ\n',
        (
            'BATCH = 32  # effective optimizer batch; checkpoint identity stays compatible\n'
            f'MICRO_BATCH = {micro_batch}\n'
            'ACCUM_STEPS = BATCH // MICRO_BATCH\n'
            'SEQ = 1024\n'
            'TOKENS_PER_STEP = BATCH * SEQ\n'
        ),
        'batch constants',
    )
    text = replace_once(
        text,
        'SCRIPT_VERSION = "packed-stream-v1"',
        'SCRIPT_VERSION = "packed-stream-v1-resident-microbatch"',
        'script version',
    )
    text = replace_once(text, 'if self.window_count <= BATCH:', 'if self.window_count <= MICRO_BATCH:', 'sampler size guard')
    text = replace_once(text, 'for index in range(BATCH):', 'for index in range(MICRO_BATCH):', 'sampler loop')
    text = replace_once(text, 'self.cursor += BATCH', 'self.cursor += MICRO_BATCH', 'sampler cursor')

    marker = '\ndef optimizer_to_device(optimizer, device) -> None:\n'
    text = replace_once(text, marker, '\n' + ACCUM_FN + marker.lstrip('\n'), 'accumulation function insertion')

    old_step = '''        data_started = time.perf_counter()\n        cursor_before = int(sampler.cursor)\n        scale_before = float(scaler.get_scale())\n        inputs, targets, stream = sampler.batch(torch)\n        torch.cuda.synchronize()\n        data_seconds = time.perf_counter() - data_started\n\n        event_start.record()\n\n        result = base.execute_step(\n            torch,\n            model,\n            optimizer,\n            scaler,\n            clip_function,\n            inputs,\n            targets,\n        )\n\n        event_end.record()\n        torch.cuda.synchronize()\n\n        compute_seconds = (\n            event_start.elapsed_time(event_end) / 1000.0\n        )\n'''
    new_step = '''        cursor_before = int(sampler.cursor)\n        scale_before = float(scaler.get_scale())\n        result, stream, data_seconds, compute_seconds = execute_accumulated_step(\n            torch,\n            model,\n            optimizer,\n            scaler,\n            clip_function,\n            sampler,\n        )\n'''
    text = replace_once(text, old_step, new_step, 'optimizer step')

    # Preserve existing checkpoint's batch_size=32 identity while explicitly
    # recording the new physical execution geometry in future checkpoints.
    checkpoint_anchor = '        "batch_size": BATCH,\n        "sequence_length": SEQ,\n'
    text = replace_once(
        text,
        checkpoint_anchor,
        '        "batch_size": BATCH,\n        "micro_batch_size": MICRO_BATCH,\n        "accumulation_steps": ACCUM_STEPS,\n        "sequence_length": SEQ,\n',
        'checkpoint execution geometry',
    )

    # First batch-size occurrence after STREAM_READY is separate from checkpoint.
    ready_anchor = '            "batch_size": BATCH,\n            "sequence_length": SEQ,\n'
    text = replace_once(
        text,
        ready_anchor,
        '            "batch_size": BATCH,\n            "micro_batch_size": MICRO_BATCH,\n            "accumulation_steps": ACCUM_STEPS,\n            "sequence_length": SEQ,\n',
        'ready execution geometry',
    )

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, 'utf-8')
    target_sha = hashlib.sha256(text.encode()).hexdigest()
    return {
        "source": str(source),
        "source_sha256": source_sha,
        "target": str(target),
        "target_sha256": target_sha,
        "effective_batch": 32,
        "micro_batch": micro_batch,
        "accumulation_steps": 32 // micro_batch,
        "tokens_per_optimizer_step": 32 * 1024,
    }


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument('--source', default='/home/awesomekai/maximal/scratch/packed-stream-v1/stream_train.py')
    p.add_argument('--target', default='/home/awesomekai/maximal/scratch/packed-stream-v1/stream_train_resident.py')
    p.add_argument('--micro-batch', type=int, default=4)
    args = p.parse_args()
    print(derive(pathlib.Path(args.source), pathlib.Path(args.target), args.micro_batch))


if __name__ == '__main__':
    main()
