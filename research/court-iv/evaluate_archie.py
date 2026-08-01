#!/usr/bin/env python3
"""Assess a trained ARCHIE event-semidirect checkpoint.

Answers three questions, in descending order of how much they matter:

  1. bpb       How well does it predict bytes it has never seen?
  2. baseline  Is that better than just compressing the file with xz?
  3. sample    What does it actually produce?

`bpb` is the one that decides whether the model is good. Everything else is
context for that number.

Usage
-----
    # the number that matters, plus the context-length sweep
    python evaluate_archie.py bpb \
        --checkpoint ckpt_step30000.pt \
        --model-file /path/to/your/model.py \
        --data corpus/development.u16

    # what to compare it against -- needs no checkpoint, run it first
    python evaluate_archie.py baseline --data corpus/development.u16

    # see what it writes
    python evaluate_archie.py sample \
        --checkpoint ckpt_step30000.pt \
        --model-file /path/to/your/model.py \
        --prompt "static int __init "

Evaluate on `development.u16`, never `train.u16`. The audit records that the
development split was separated by source document and that curriculum
repetition touches only training documents, so `train.u16` loss is optimistic
by an unknown amount and cannot tell you whether the model generalizes.

TESTING STATUS: this script has NOT been run against a real checkpoint or
corpus -- the environment it was written in has no torch, no weights, and no
data. The BPB arithmetic is standard and simple; the model-loading and
generation shells are written defensively but expect to adjust `--builder` or
`--config-json` for how your checkpoint stores its config.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import math
import pathlib
import subprocess
import sys

LN2 = math.log(2.0)
BYTE_VALUES = 256  # ids 0..255 are literal bytes; 256..259 are special


# --------------------------------------------------------------------------
# data
# --------------------------------------------------------------------------


def load_tokens(path: pathlib.Path):
    """Read a .u16 corpus: little-endian unsigned 16-bit token ids."""
    import array

    values = array.array("H")
    with open(path, "rb") as handle:
        values.frombytes(handle.read())
    if sys.byteorder == "big":
        values.byteswap()
    return values


def as_raw_bytes(tokens):
    """Drop special tokens and return the underlying byte stream.

    Needed for an apples-to-apples compression baseline: the .u16 file is two
    bytes per token on disk, so compressing it directly would understate what a
    general-purpose compressor achieves on the actual content.
    """
    return bytes(int(t) for t in tokens if t < BYTE_VALUES)


# --------------------------------------------------------------------------
# baselines
# --------------------------------------------------------------------------


def command_baseline(args) -> int:
    tokens = load_tokens(args.data)
    raw = as_raw_bytes(tokens)
    total = len(raw)
    print(f"{args.data}: {len(tokens):,} tokens, {total:,} literal bytes")

    counts = [0] * BYTE_VALUES
    for value in raw:
        counts[value] += 1
    order0 = -sum(
        (c / total) * math.log2(c / total) for c in counts if c
    )
    print(f"\n  uniform over 256 values         8.0000 BPB   (knowing nothing)")
    print(f"  order-0 byte frequencies        {order0:.4f} BPB   (knowing only which bytes are common)")

    for tool, flags in (("gzip", ["-9"]), ("xz", ["-9e"]), ("zstd", ["-19"])):
        try:
            done = subprocess.run(
                [tool, *flags, "-c"], input=raw, capture_output=True, check=True
            )
            bpb = len(done.stdout) * 8 / total
            print(f"  {tool + ' ' + ' '.join(flags):<30}  {bpb:.4f} BPB")
        except (FileNotFoundError, subprocess.CalledProcessError):
            print(f"  {tool:<30}  (not installed, skipped)")

    print(
        "\nRead it like this: your model should beat xz comfortably. xz has no\n"
        "idea what C is -- it only reuses repeated strings. If a 45.7M-parameter\n"
        "model trained on kernel source cannot beat a general-purpose compressor\n"
        "on held-out kernel source, something is wrong."
    )
    return 0


# --------------------------------------------------------------------------
# model loading
# --------------------------------------------------------------------------


def load_model(args):
    import torch

    spec = importlib.util.spec_from_file_location("archie_model", args.model_file)
    module = importlib.util.module_from_spec(spec)
    sys.modules["archie_model"] = module
    spec.loader.exec_module(module)

    blob = torch.load(args.checkpoint, map_location="cpu", weights_only=False)
    state = blob
    for key in ("model", "state_dict", "model_state_dict"):
        if isinstance(state, dict) and key in state and isinstance(state[key], dict):
            state = state[key]
            break

    config = {}
    if args.config_json:
        config = json.loads(pathlib.Path(args.config_json).read_text())
    elif isinstance(blob, dict):
        for key in ("config", "model_config", "args", "hparams"):
            if key in blob and isinstance(blob[key], dict):
                config = blob[key]
                print(f"using config from checkpoint['{key}']")
                break

    if args.builder:
        name = args.builder
        if not hasattr(module, name):
            raise SystemExit(f"--builder {name!r} not found in {args.model_file}")
        model = getattr(module, name)(config) if config else getattr(module, name)()
    else:
        candidates = [
            n for n in dir(module)
            if "EventSemidirect" in n or n.endswith("LM")
        ]
        if not candidates:
            raise SystemExit(
                f"no model class found in {args.model_file}. Pass --builder NAME."
            )
        cls = getattr(module, candidates[0])
        print(f"instantiating {candidates[0]}")
        try:
            model = cls(**config) if config else cls()
        except TypeError as error:
            raise SystemExit(
                f"could not construct {candidates[0]}: {error}\n"
                f"Pass --config-json with the constructor arguments, or --builder "
                f"naming a zero-argument factory in your model file."
            )

    missing, unexpected = model.load_state_dict(state, strict=False)
    if missing:
        print(f"warning: {len(missing)} missing keys, e.g. {list(missing)[:3]}")
    if unexpected:
        print(f"warning: {len(unexpected)} unexpected keys, e.g. {list(unexpected)[:3]}")
    model.eval()
    return model


def forward_logits(model, batch):
    """Call the model and return logits, tolerating a few return conventions."""
    out = model(batch)
    if isinstance(out, (tuple, list)):
        out = out[0]
    if hasattr(out, "logits"):
        out = out.logits
    return out


# --------------------------------------------------------------------------
# held-out bits per byte
# --------------------------------------------------------------------------


def command_bpb(args) -> int:
    import torch

    model = load_model(args)
    device = torch.device(args.device)
    model.to(device)

    tokens = load_tokens(args.data)
    if args.max_tokens and len(tokens) > args.max_tokens:
        tokens = tokens[: args.max_tokens]
    print(f"\nevaluating on {len(tokens):,} tokens from {args.data}")

    stride = args.stride
    print(
        f"\nScoring only the last {stride} positions of each window, so the numbers\n"
        f"below differ ONLY in how much context the model was given. That is what\n"
        f"makes the sweep meaningful: if BPB does not drop as context grows, the\n"
        f"model is not using the extra context.\n"
    )
    print(f"{'context':>9} {'BPB':>9} {'nats':>9} {'positions':>12}")

    results = {}
    for length in args.lengths:
        if length <= stride:
            print(f"{length:>9}  (skipped: context must exceed stride)")
            continue
        total_nats, total_count = 0.0, 0

        starts = range(0, len(tokens) - length - 1, stride)
        with torch.no_grad():
            batch_windows = []
            for start in starts:
                batch_windows.append(list(tokens[start : start + length + 1]))
                if len(batch_windows) < args.batch_size:
                    continue
                nats, count = _score(model, batch_windows, stride, device, args)
                total_nats += nats
                total_count += count
                batch_windows = []
            if batch_windows:
                nats, count = _score(model, batch_windows, stride, device, args)
                total_nats += nats
                total_count += count

        if not total_count:
            print(f"{length:>9}  (no scored positions -- corpus too short)")
            continue
        mean_nats = total_nats / total_count
        results[length] = mean_nats / LN2
        print(f"{length:>9} {mean_nats/LN2:>9.4f} {mean_nats:>9.4f} {total_count:>12,}")

    if len(results) >= 2:
        lengths = sorted(results)
        shortest, longest = lengths[0], lengths[-1]
        gain = results[shortest] - results[longest]
        print(
            f"\ncontext {shortest} -> {longest}: {results[shortest]:.4f} -> "
            f"{results[longest]:.4f} BPB  ({gain:+.4f})"
        )
        if gain < 0.01:
            print(
                "  The model gains almost nothing from longer context. That is the\n"
                "  signature ARCHIE_COURT_IV.md section 5 predicts: memory is spent\n"
                "  before the extra bytes arrive. Run retention_probe.py to confirm."
            )
        else:
            print("  The model is genuinely using longer context.")
    print("\nCompare against `evaluate_archie.py baseline` on the same file.")
    return 0


def _score(model, windows, stride, device, args):
    import torch

    batch = torch.tensor(windows, dtype=torch.long, device=device)
    inputs, targets = batch[:, :-1], batch[:, 1:]
    logits = forward_logits(model, inputs)
    log_probs = torch.log_softmax(logits.float(), dim=-1)
    picked = log_probs.gather(-1, targets.unsqueeze(-1)).squeeze(-1)

    picked = picked[:, -stride:]
    scored = targets[:, -stride:]
    mask = torch.ones_like(picked, dtype=torch.bool)
    if not args.include_special:
        mask &= scored < BYTE_VALUES
    return float(-(picked * mask).sum()), int(mask.sum())


# --------------------------------------------------------------------------
# generation
# --------------------------------------------------------------------------


def command_sample(args) -> int:
    import torch

    model = load_model(args)
    device = torch.device(args.device)
    model.to(device)

    context = list(args.prompt.encode("utf-8", errors="replace"))
    if not context:
        context = [ord("\n")]
    produced = []

    print(
        "\nNaive decoding: the whole prefix is re-run for every byte. That is\n"
        "O(n^2) and slow, but it needs no incremental-state code and cannot\n"
        "silently disagree with the training-time forward pass.\n"
    )
    with torch.no_grad():
        for _ in range(args.tokens):
            window = (context + produced)[-args.context :]
            batch = torch.tensor([window], dtype=torch.long, device=device)
            logits = forward_logits(model, batch)[0, -1].float()
            logits[BYTE_VALUES:] = float("-inf")  # never emit special tokens
            if args.temperature <= 0:
                nxt = int(logits.argmax())
            else:
                probs = torch.softmax(logits / args.temperature, dim=-1)
                if args.top_p < 1.0:
                    ordered, index = torch.sort(probs, descending=True)
                    cutoff = torch.cumsum(ordered, dim=-1) > args.top_p
                    cutoff[0] = False
                    ordered[cutoff] = 0.0
                    probs = torch.zeros_like(probs).scatter_(0, index, ordered)
                    probs /= probs.sum()
                nxt = int(torch.multinomial(probs, 1))
            produced.append(nxt)

    print("=" * 70)
    print(args.prompt, end="")
    print(bytes(produced).decode("utf-8", errors="replace"))
    print("=" * 70)
    print(
        "\nThis is a judgement call, not a measurement. On a byte model of this\n"
        "size, look for: balanced brackets, plausible indentation, identifiers\n"
        "reused consistently across a few lines. Do not expect correct code."
    )
    return 0


# --------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    def add_model_args(p):
        p.add_argument("--checkpoint", type=pathlib.Path, required=True)
        p.add_argument("--model-file", type=pathlib.Path, required=True,
                       help="the .py defining ArchieEventSemidirectLM")
        p.add_argument("--config-json", type=pathlib.Path, default=None)
        p.add_argument("--builder", default=None,
                       help="name of a factory function in --model-file")
        p.add_argument("--device", default="cuda" if _has_cuda() else "cpu")

    p_base = sub.add_parser("baseline", help="compression floors, no model needed")
    p_base.add_argument("--data", type=pathlib.Path, required=True)
    p_base.set_defaults(func=command_baseline)

    p_bpb = sub.add_parser("bpb", help="held-out bits per byte + context sweep")
    add_model_args(p_bpb)
    p_bpb.add_argument("--data", type=pathlib.Path, required=True)
    p_bpb.add_argument("--lengths", type=int, nargs="+",
                       default=[256, 512, 1024, 2048])
    p_bpb.add_argument("--stride", type=int, default=128)
    p_bpb.add_argument("--batch-size", type=int, default=8)
    p_bpb.add_argument("--max-tokens", type=int, default=4_000_000)
    p_bpb.add_argument("--include-special", action="store_true")
    p_bpb.set_defaults(func=command_bpb)

    p_sample = sub.add_parser("sample", help="generate bytes")
    add_model_args(p_sample)
    p_sample.add_argument("--prompt", default="static int ")
    p_sample.add_argument("--tokens", type=int, default=300)
    p_sample.add_argument("--context", type=int, default=512)
    p_sample.add_argument("--temperature", type=float, default=0.8)
    p_sample.add_argument("--top-p", type=float, default=0.95)
    p_sample.set_defaults(func=command_sample)

    args = parser.parse_args()
    return args.func(args)


def _has_cuda() -> bool:
    try:
        import torch

        return torch.cuda.is_available()
    except Exception:
        return False


if __name__ == "__main__":
    raise SystemExit(main())
