#!/usr/bin/env python3
"""Run a bounded, real RSLoRA training pass on a GitHub-hosted Linux CPU.

This is deliberately separate from the CUDA/NF4 production lane. It performs
actual gradient updates with full-precision or BF16 frozen base weights, caches
frozen-reference scores once, stacks chosen/rejected arms, saves step adapters,
and emits a receipt that never claims admission or production equivalence.
"""
from __future__ import annotations

import argparse
import hashlib
import inspect
import json
import os
import pathlib
import platform
import random
import resource
import sys
import time
import traceback
from typing import Any

ROOT = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import information_budgeted_rslora as ib  # type: ignore

SCHEMA = "archie-linux-cpu-rslora-training-receipt/v1"
METHOD = "github-hosted-linux-cpu-causal-fork-rslora/v1"


def stable(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def manifest(root: pathlib.Path) -> list[dict[str, Any]]:
    rows = []
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        rows.append({"path": path.relative_to(root).as_posix(), "bytes": path.stat().st_size, "sha256": sha256(path)})
    return rows


def memory_total_bytes() -> int | None:
    path = pathlib.Path("/proc/meminfo")
    if not path.is_file():
        return None
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("MemTotal:"):
            return int(line.split()[1]) * 1024
    return None


def max_rss_bytes() -> int:
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(value * 1024) if sys.platform.startswith("linux") else int(value)


def supports_kwarg(callable_object: Any, name: str) -> bool:
    parameters = inspect.signature(callable_object).parameters
    return name in parameters or any(item.kind == inspect.Parameter.VAR_KEYWORD for item in parameters.values())


def read_rows(path: pathlib.Path) -> list[dict[str, Any]]:
    rows = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        value = json.loads(line)
        if not isinstance(value, dict):
            raise SystemExit(f"{path}:{number} must contain an object.")
        required = ["pair_id", "split", "instruction", "chosen_target", "rejected_target"]
        missing = [key for key in required if not str(value.get(key) or "").strip()]
        if missing:
            raise SystemExit(f"{path}:{number} missing {', '.join(missing)}")
        body = {
            "schema": ib.PAIR_SCHEMA,
            "pair_id": str(value["pair_id"]),
            "group_id": str(value.get("group_id") or value["pair_id"]),
            "instruction": str(value["instruction"]),
            "compact_context": value.get("compact_context"),
            "chosen_target": str(value["chosen_target"]),
            "rejected_target": str(value["rejected_target"]),
            "evidence_weight": float(value.get("evidence_weight", 1.0)),
        }
        body["pair_digest"] = hashlib.sha256(stable(body).encode("utf-8")).hexdigest()
        body["split"] = str(value["split"])
        rows.append(body)
    if not rows:
        raise SystemExit("CPU corpus is empty.")
    return rows


def batch_to_cpu(batch: dict[str, Any]) -> dict[str, Any]:
    return {key: value.cpu() if hasattr(value, "cpu") else value for key, value in batch.items()}


def score_item(model: Any, collator: Any, item: dict[str, Any], torch: Any) -> tuple[float, float]:
    batch = batch_to_cpu(collator([item]))
    with torch.inference_mode():
        chosen_logits, rejected_logits = ib.stacked_forward(model, batch)
        chosen = ib.sequence_log_prob(chosen_logits, batch["chosen_divergence_labels"])
        rejected = ib.sequence_log_prob(rejected_logits, batch["rejected_divergence_labels"])
    return float(chosen[0]), float(rejected[0])


def evaluate(model: Any, collator: Any, items: list[dict[str, Any]], torch: Any) -> dict[str, Any]:
    model.eval()
    cases = []
    for item in items:
        chosen, rejected = score_item(model, collator, item, torch)
        margin = chosen - rejected
        cases.append({"pair_id": item["pair_id"], "chosen_logp": chosen, "rejected_logp": rejected, "margin": margin, "correct": margin > 0})
    return {
        "pairs": len(cases),
        "pair_accuracy": sum(int(case["correct"]) for case in cases) / max(1, len(cases)),
        "mean_pair_margin": sum(case["margin"] for case in cases) / max(1, len(cases)),
        "cases": cases,
    }


def model_dtype(torch: Any, value: str) -> Any:
    if value == "bfloat16":
        return torch.bfloat16
    if value == "float32":
        return torch.float32
    raise SystemExit(f"Unsupported dtype: {value}")


def write_receipt(output: pathlib.Path, body: dict[str, Any]) -> dict[str, Any]:
    receipt = {**body, "receipt_digest": hashlib.sha256(stable(body).encode("utf-8")).hexdigest()}
    output.mkdir(parents=True, exist_ok=True)
    (output / "training-receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return receipt


def train(args: argparse.Namespace) -> dict[str, Any]:
    import torch
    from peft import LoraConfig, get_peft_model
    from transformers import AutoModelForCausalLM, AutoTokenizer

    output = pathlib.Path(args.output).resolve()
    corpus = pathlib.Path(args.corpus).resolve()
    output.mkdir(parents=True, exist_ok=True)
    random.seed(args.seed)
    torch.manual_seed(args.seed)
    torch.set_num_threads(max(1, args.threads))
    try:
        torch.set_num_interop_threads(1)
    except RuntimeError:
        pass

    rows = read_rows(corpus)
    train_rows = [row for row in rows if row["split"] == "train"][: args.train_limit]
    eval_rows = [row for row in rows if row["split"] == "development"][: args.eval_limit]
    if not train_rows or not eval_rows:
        raise SystemExit("CPU training requires nonempty train and development rows.")

    started = time.monotonic()
    deadline = started + args.time_budget_minutes * 60
    dtype = model_dtype(torch, args.dtype)
    tokenizer = AutoTokenizer.from_pretrained(args.model, revision=args.revision, trust_remote_code=False)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    model = AutoModelForCausalLM.from_pretrained(
        args.model,
        revision=args.revision,
        torch_dtype=dtype,
        low_cpu_mem_usage=True,
        trust_remote_code=False,
    )
    model.config.use_cache = False
    model.to("cpu")

    policy = ib.normalized_policy({
        "max_seq_length": args.max_seq_length,
        "prompt_replay_tokens": args.prompt_replay_tokens,
        "prompt_head_tokens": args.prompt_head_tokens,
        "shared_prefix_replay_tokens": args.shared_prefix_replay_tokens,
        "max_divergence_tokens": args.max_divergence_tokens,
    })
    train_items = [ib.tokenize_causal_fork(tokenizer, row, policy) for row in train_rows]
    eval_items = [ib.tokenize_causal_fork(tokenizer, row, policy) for row in eval_rows]
    collator = ib.ForkCollator(int(tokenizer.pad_token_id))

    reference = {}
    model.eval()
    for item in train_items + eval_items:
        chosen, rejected = score_item(model, collator, item, torch)
        reference[item["pair_id"]] = {"chosen": chosen, "rejected": rejected, "tokenization_digest": item["tokenization_digest"]}
    base_eval = {
        "pairs": len(eval_items),
        "pair_accuracy": sum(int(reference[item["pair_id"]]["chosen"] > reference[item["pair_id"]]["rejected"]) for item in eval_items) / len(eval_items),
        "mean_pair_margin": sum(reference[item["pair_id"]]["chosen"] - reference[item["pair_id"]]["rejected"] for item in eval_items) / len(eval_items),
        "cases": [
            {
                "pair_id": item["pair_id"],
                "chosen_logp": reference[item["pair_id"]]["chosen"],
                "rejected_logp": reference[item["pair_id"]]["rejected"],
                "margin": reference[item["pair_id"]]["chosen"] - reference[item["pair_id"]]["rejected"],
                "correct": reference[item["pair_id"]]["chosen"] > reference[item["pair_id"]]["rejected"],
            }
            for item in eval_items
        ],
    }

    lora_values: dict[str, Any] = {
        "r": args.rank,
        "lora_alpha": args.alpha,
        "lora_dropout": 0.0,
        "bias": "none",
        "task_type": "CAUSAL_LM",
        "target_modules": [part.strip() for part in args.target_modules.split(",") if part.strip()],
    }
    rslora_supported = supports_kwarg(LoraConfig.__init__, "use_rslora")
    if rslora_supported:
        lora_values["use_rslora"] = True
    model = get_peft_model(model, LoraConfig(**lora_values))
    if hasattr(model, "enable_input_require_grads"):
        model.enable_input_require_grads()
    if args.gradient_checkpointing and hasattr(model, "gradient_checkpointing_enable"):
        try:
            model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
        except TypeError:
            model.gradient_checkpointing_enable()
    model.config.use_cache = False

    trainable = [(name, parameter) for name, parameter in model.named_parameters() if parameter.requires_grad]
    if not trainable or any("lora_" not in name for name, _ in trainable):
        raise SystemExit("CPU lane may update only LoRA tensors.")
    optimizer = torch.optim.AdamW([parameter for _, parameter in trainable], lr=args.learning_rate, weight_decay=0.0)

    history = []
    optimizer.zero_grad(set_to_none=True)
    completed_steps = 0
    for step in range(args.max_steps):
        item = train_items[step % len(train_items)]
        batch = batch_to_cpu(collator([item]))
        model.train()
        chosen_logits, rejected_logits = ib.stacked_forward(model, batch)
        cached = reference[item["pair_id"]]
        loss, metrics = ib.causal_fork_loss(
            policy_chosen_logits=chosen_logits,
            policy_rejected_logits=rejected_logits,
            reference_chosen_logp=torch.tensor([cached["chosen"]], dtype=torch.float32),
            reference_rejected_logp=torch.tensor([cached["rejected"]], dtype=torch.float32),
            chosen_labels=batch["chosen_divergence_labels"],
            rejected_labels=batch["rejected_divergence_labels"],
            evidence_weight=batch["evidence_weight"],
            beta=args.beta,
            margin=args.causal_margin,
            sft_weight=args.sft_weight,
        )
        if not torch.isfinite(loss):
            raise SystemExit(f"Non-finite loss at step {step + 1}.")
        loss.backward()
        gradient_norm = float(torch.nn.utils.clip_grad_norm_([parameter for _, parameter in trainable], args.max_grad_norm))
        optimizer.step()
        optimizer.zero_grad(set_to_none=True)
        completed_steps += 1
        elapsed = time.monotonic() - started
        record = {
            "step": completed_steps,
            "pair_id": item["pair_id"],
            "loss": float(loss.detach()),
            "preference_loss": float(metrics["preference_loss"]),
            "sft_loss": float(metrics["sft_loss"]),
            "causal_margin": float(metrics["causal_margin"]),
            "pair_accuracy": float(metrics["pair_accuracy"]),
            "gradient_norm": gradient_norm,
            "elapsed_seconds": elapsed,
            "max_rss_bytes": max_rss_bytes(),
        }
        history.append(record)
        checkpoint = output / "checkpoints" / f"step-{completed_steps:03d}"
        checkpoint.mkdir(parents=True, exist_ok=True)
        model.save_pretrained(checkpoint, safe_serialization=True)
        (output / "progress.json").write_text(json.dumps({"history": history}, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(json.dumps(record, sort_keys=True), flush=True)
        if time.monotonic() >= deadline:
            break

    adapter = output / "adapter"
    model.save_pretrained(adapter, safe_serialization=True)
    tokenizer.save_pretrained(output / "tokenizer")
    final_eval = evaluate(model, collator, eval_items, torch)
    comparison = {
        "pair_accuracy_delta": final_eval["pair_accuracy"] - base_eval["pair_accuracy"],
        "mean_pair_margin_delta": final_eval["mean_pair_margin"] - base_eval["mean_pair_margin"],
        "non_regression": final_eval["pair_accuracy"] >= base_eval["pair_accuracy"],
    }
    resolved_revision = getattr(model.config, "_commit_hash", None) or tokenizer.init_kwargs.get("_commit_hash") or args.revision
    receipt_body = {
        "schema": SCHEMA,
        "method": METHOD,
        "lane": args.lane,
        "source": {
            "repository": os.environ.get("GITHUB_REPOSITORY"),
            "code_revision": os.environ.get("GITHUB_SHA"),
            "workflow_run_id": os.environ.get("GITHUB_RUN_ID"),
            "workflow_run_attempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
            "corpus_path": str(corpus),
            "corpus_sha256": sha256(corpus),
            "train_pair_digests": [row["pair_digest"] for row in train_rows],
            "development_pair_digests": [row["pair_digest"] for row in eval_rows],
        },
        "model": {
            "requested": args.model,
            "requested_revision": args.revision,
            "resolved_revision": resolved_revision,
            "dtype": args.dtype,
            "device": "cpu",
        },
        "runtime": {
            "python": platform.python_version(),
            "platform": platform.platform(),
            "torch": torch.__version__,
            "threads": torch.get_num_threads(),
            "interop_threads": torch.get_num_interop_threads(),
            "memory_total_bytes": memory_total_bytes(),
            "max_rss_bytes": max_rss_bytes(),
            "runner_name": os.environ.get("RUNNER_NAME"),
            "runner_environment": os.environ.get("RUNNER_ENVIRONMENT"),
        },
        "optimization": {
            "real_gradient_updates": completed_steps > 0,
            "completed_optimizer_steps": completed_steps,
            "requested_optimizer_steps": args.max_steps,
            "time_budget_minutes": args.time_budget_minutes,
            "duration_seconds": time.monotonic() - started,
            "rank": args.rank,
            "alpha": args.alpha,
            "rslora_requested": True,
            "rslora_supported": rslora_supported,
            "rslora_active": rslora_supported,
            "scaling_law": "alpha/sqrt(rank)" if rslora_supported else "alpha/rank",
            "fallback_reason": None if rslora_supported else "installed-peft-loraconfig-has-no-use_rslora",
            "target_modules": lora_values["target_modules"],
            "trainable_parameter_count": sum(parameter.numel() for _, parameter in trainable),
            "trainable_parameter_names": [name for name, _ in trainable],
            "learning_rate": args.learning_rate,
            "beta": args.beta,
            "causal_margin": args.causal_margin,
            "sft_weight": args.sft_weight,
            "policy": policy,
            "frozen_reference_cached_once": True,
            "stacked_chosen_rejected_forward": True,
            "history": history,
        },
        "evaluation": {"frozen_base": base_eval, "adapter": final_eval, "comparison": comparison},
        "artifacts": manifest(output),
        "promotion": "not-admitted",
        "claim_boundary": "This receipt proves bounded real CPU LoRA gradient updates on the named model and corpus. It does not prove production equivalence, broad capability gain, CUDA/NF4 behavior, quantization retention, independent reproduction, or admission.",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    return write_receipt(output, receipt_body)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lane", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--revision", default="main")
    parser.add_argument("--dtype", choices=["bfloat16", "float32"], required=True)
    parser.add_argument("--corpus", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-steps", type=int, required=True)
    parser.add_argument("--train-limit", type=int, required=True)
    parser.add_argument("--eval-limit", type=int, required=True)
    parser.add_argument("--rank", type=int, required=True)
    parser.add_argument("--alpha", type=int, required=True)
    parser.add_argument("--learning-rate", type=float, required=True)
    parser.add_argument("--max-seq-length", type=int, required=True)
    parser.add_argument("--prompt-replay-tokens", type=int, required=True)
    parser.add_argument("--prompt-head-tokens", type=int, required=True)
    parser.add_argument("--shared-prefix-replay-tokens", type=int, required=True)
    parser.add_argument("--max-divergence-tokens", type=int, required=True)
    parser.add_argument("--time-budget-minutes", type=int, default=270)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--seed", type=int, default=3407)
    parser.add_argument("--target-modules", default="q_proj,k_proj,v_proj,o_proj")
    parser.add_argument("--beta", type=float, default=0.1)
    parser.add_argument("--causal-margin", type=float, default=0.2)
    parser.add_argument("--sft-weight", type=float, default=0.35)
    parser.add_argument("--max-grad-norm", type=float, default=1.0)
    parser.add_argument("--gradient-checkpointing", action="store_true")
    args = parser.parse_args()
    output = pathlib.Path(args.output).resolve()
    try:
        receipt = train(args)
        print(json.dumps(receipt, indent=2, sort_keys=True))
    except BaseException as exc:
        failure_body = {
            "schema": SCHEMA,
            "method": METHOD,
            "lane": args.lane,
            "status": "resource-or-runtime-failure",
            "model": {"requested": args.model, "requested_revision": args.revision, "dtype": args.dtype, "device": "cpu"},
            "runtime": {"python": platform.python_version(), "platform": platform.platform(), "memory_total_bytes": memory_total_bytes(), "max_rss_bytes": max_rss_bytes()},
            "error": {"type": type(exc).__name__, "message": str(exc), "traceback": traceback.format_exc()},
            "real_gradient_updates": False,
            "promotion": "not-admitted",
            "claim_boundary": "The requested CPU lane did not complete. This is a resource or runtime receipt, not neural evidence.",
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        write_receipt(output, failure_body)
        print(json.dumps(failure_body, indent=2, sort_keys=True), file=sys.stderr)
        raise


if __name__ == "__main__":
    main()
