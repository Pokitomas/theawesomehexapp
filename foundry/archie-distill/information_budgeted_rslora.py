#!/usr/bin/env python3
"""Receipt-bound causal-fork replay, attention-area sharding, cached references, and RSLoRA."""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import inspect
import json
import math
import os
import pathlib
import platform
import random
import sys
import time
from collections import defaultdict
from dataclasses import dataclass
from typing import Any, Iterable

PAIR_SCHEMA = "archie-causal-divergence-pair/v1"
PAIR_RECEIPT_SCHEMA = "archie-causal-divergence-dataset-receipt/v1"
SEGMENTATION_SCHEMA = "archie-segmented-tokenized-distillation-receipt/v1"
SHARD_SCHEMA = "archie-segmented-tokenized-shard-receipt/v1"
CACHE_SCHEMA = "archie-causal-reference-cache/v1"
TRAINING_SCHEMA = "archie-neural-information-budgeted-rslora-receipt/v1"
VERIFICATION_SCHEMA = "archie-segment-adapter-verification-receipt/v1"
METHOD = "recursive-segmented-tokenized-distillation/v1"
TRAINING_METHOD = "information-budgeted-causal-fork-rslora/v1"
DEFAULT_POLICY = dict(max_seq_length=896, prompt_replay_tokens=384, prompt_head_tokens=32, shared_prefix_replay_tokens=96, max_divergence_tokens=384)


def stable(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(value: Any) -> str:
    raw = value if isinstance(value, bytes) else (value.encode() if isinstance(value, str) else stable(value).encode())
    return hashlib.sha256(raw).hexdigest()


def sha256(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def read_json(path: pathlib.Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise SystemExit(f"{path} must contain a JSON object.")
    return value


def read_jsonl(path: pathlib.Path, required: bool = False) -> list[dict[str, Any]]:
    if not path.exists():
        if required:
            raise SystemExit(f"Missing JSONL: {path}")
        return []
    rows = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if line.strip():
            value = json.loads(line)
            if not isinstance(value, dict):
                raise SystemExit(f"{path}:{number} must contain an object.")
            rows.append(value)
    return rows


def write_jsonl(path: pathlib.Path, rows: Iterable[dict[str, Any]]) -> None:
    path.write_text("".join(stable(row) + "\n" for row in rows), encoding="utf-8")


def verify_receipt(value: dict[str, Any]) -> str:
    body = dict(value)
    claimed = str(body.pop("receipt_digest", ""))
    if len(claimed) != 64 or digest(body) != claimed:
        raise SystemExit("Receipt digest mismatch.")
    return claimed


def repo_helpers() -> tuple[Any, Any]:
    root = pathlib.Path(__file__).resolve().parent
    sys.path.insert(0, str(root))
    import train as common  # type: ignore
    import train_causal_divergence as causal  # type: ignore
    return common, causal


def directory_identity(root: pathlib.Path) -> dict[str, Any]:
    common, _ = repo_helpers()
    value = dict(common.directory_identity(root))
    identity = value.get("directory_digest") or value.get("digest")
    if not identity:
        raise SystemExit("Directory identity helper returned no digest.")
    value["digest"] = identity
    value["directory_digest"] = identity
    return value


def artifact_manifest(root: pathlib.Path) -> list[dict[str, Any]]:
    common, _ = repo_helpers()
    return common.artifact_manifest(root)


def tokenizer_identity(root: pathlib.Path) -> dict[str, Any]:
    common, _ = repo_helpers()
    return common.tokenizer_identity(root)


def package_versions(names: list[str]) -> dict[str, Any]:
    common, _ = repo_helpers()
    return common.package_versions(names)


def prompt_text(tokenizer: Any, row: dict[str, Any]) -> str:
    instruction = str(row.get("instruction") or "").strip()
    if not instruction:
        raise SystemExit(f"Pair {row.get('pair_id')} has no instruction.")
    context = row.get("compact_context")
    user = instruction if context in (None, {}, []) else f"{instruction}\n\nContext:\n{stable(context)}"
    messages = [{"role": "system", "content": "You are Archie. Produce typed, permission-aware plans grounded in verifiable evidence."}, {"role": "user", "content": user}]
    if hasattr(tokenizer, "apply_chat_template") and getattr(tokenizer, "chat_template", None):
        return tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    return "\n".join(f"<{item['role']}>\n{item['content']}" for item in messages) + "\n<assistant>\n"


def common_prefix_length(left: list[int], right: list[int]) -> int:
    index, limit = 0, min(len(left), len(right))
    while index < limit and left[index] == right[index]:
        index += 1
    return index


def normalized_policy(value: dict[str, Any] | None = None) -> dict[str, int]:
    policy = {key: int(({**DEFAULT_POLICY, **(value or {})})[key]) for key in DEFAULT_POLICY}
    if policy["max_seq_length"] < 16 or any(policy[key] < 0 for key in policy if key != "max_seq_length"):
        raise SystemExit("Invalid causal-fork replay policy.")
    return policy


def head_tail(values: list[int], limit: int, head: int) -> list[int]:
    if limit <= 0:
        return []
    if len(values) <= limit:
        return list(values)
    head = min(max(head, 0), limit)
    return list(values[:head]) + list(values[-(limit - head):]) if limit > head else list(values[:limit])


def tokenize_causal_fork(tokenizer: Any, row: dict[str, Any], policy: dict[str, Any] | None = None) -> dict[str, Any]:
    policy = normalized_policy(policy)
    if row.get("schema") != PAIR_SCHEMA:
        raise SystemExit("Unsupported causal pair schema.")
    chosen_text, rejected_text = str(row.get("chosen_target") or "").strip(), str(row.get("rejected_target") or "").strip()
    if not chosen_text or not rejected_text or chosen_text == rejected_text:
        raise SystemExit("Pair requires distinct chosen and rejected targets.")
    prompt = list(tokenizer(prompt_text(tokenizer, row), add_special_tokens=False)["input_ids"])
    chosen = list(tokenizer(chosen_text, add_special_tokens=False)["input_ids"])
    rejected = list(tokenizer(rejected_text, add_special_tokens=False)["input_ids"])
    divergence = common_prefix_length(chosen, rejected)
    if divergence >= min(len(chosen), len(rejected)):
        raise SystemExit("Pair has no causal divergence.")
    eos = [int(tokenizer.eos_token_id)] if getattr(tokenizer, "eos_token_id", None) is not None else []
    cap = max(1, policy["max_divergence_tokens"])
    chosen_post, rejected_post = (chosen[divergence:] + eos)[:cap], (rejected[divergence:] + eos)[:cap]
    longest = max(len(chosen_post), len(rejected_post))
    if longest >= policy["max_seq_length"]:
        keep = policy["max_seq_length"] - 1
        chosen_post, rejected_post, longest = chosen_post[:keep], rejected_post[:keep], keep
    prefix_budget = policy["max_seq_length"] - longest
    shared_count = min(policy["shared_prefix_replay_tokens"], divergence, prefix_budget)
    shared = chosen[divergence - shared_count:divergence]
    prompt_budget = min(policy["prompt_replay_tokens"], prefix_budget - len(shared))
    prefix = head_tail(prompt, prompt_budget, policy["prompt_head_tokens"]) + shared

    def arm(post: list[int]) -> tuple[list[int], list[int]]:
        retained = post[:policy["max_seq_length"] - len(prefix)]
        ids = prefix + retained
        labels = [-100] * len(prefix) + retained
        if not retained:
            raise SystemExit("Replay window lost divergence supervision.")
        return ids, labels

    chosen_ids, chosen_labels = arm(chosen_post)
    rejected_ids, rejected_labels = arm(rejected_post)
    raw_chosen, raw_rejected = len(prompt) + len(chosen) + len(eos), len(prompt) + len(rejected) + len(eos)
    replay_area = len(chosen_ids) ** 2 + len(rejected_ids) ** 2
    raw_area = raw_chosen ** 2 + raw_rejected ** 2
    tokenization = {
        "pair_id": row.get("pair_id"), "pair_digest": row.get("pair_digest"), "policy": policy,
        "original": {"prompt_tokens": len(prompt), "chosen_tokens": len(chosen) + len(eos), "rejected_tokens": len(rejected) + len(eos), "shared_prefix_tokens": divergence, "token_cost": raw_chosen + raw_rejected, "attention_area": raw_area},
        "replayed": {"prompt_tokens": len(prefix) - len(shared), "shared_prefix_tokens": len(shared), "chosen_supervised_tokens": len(chosen_ids) - len(prefix), "rejected_supervised_tokens": len(rejected_ids) - len(prefix), "token_cost": len(chosen_ids) + len(rejected_ids), "attention_area": replay_area},
    }
    return {
        "pair_id": row.get("pair_id"), "pair_digest": row.get("pair_digest"), "group_id": row.get("group_id") or f"pair:{row.get('pair_id')}",
        "chosen_input_ids": chosen_ids, "chosen_sft_labels": chosen_labels, "chosen_divergence_labels": chosen_labels,
        "rejected_input_ids": rejected_ids, "rejected_divergence_labels": rejected_labels,
        "evidence_weight": max(0.25, min(4.0, float(row.get("evidence_weight", 1.0)))), "divergence_target_token": divergence,
        "tokenization": tokenization, "tokenization_digest": digest(tokenization), "attention_area_cost": replay_area,
        "information_tokens": len(chosen_ids) + len(rejected_ids) - 2 * len(prefix),
    }


@dataclass
class ForkCollator:
    pad_token_id: int

    def __call__(self, features: list[dict[str, Any]]) -> dict[str, Any]:
        import torch
        chosen, rejected = [item["chosen_input_ids"] for item in features], [item["rejected_input_ids"] for item in features]
        width = max(max(map(len, chosen)), max(map(len, rejected)))
        pad = lambda rows, value: torch.tensor([row + [value] * (width - len(row)) for row in rows], dtype=torch.long)
        result = {
            "chosen_input_ids": pad(chosen, self.pad_token_id), "chosen_attention_mask": pad([[1] * len(row) for row in chosen], 0),
            "chosen_sft_labels": pad([item["chosen_sft_labels"] for item in features], -100), "chosen_divergence_labels": pad([item["chosen_divergence_labels"] for item in features], -100),
            "rejected_input_ids": pad(rejected, self.pad_token_id), "rejected_attention_mask": pad([[1] * len(row) for row in rejected], 0),
            "rejected_divergence_labels": pad([item["rejected_divergence_labels"] for item in features], -100),
            "evidence_weight": torch.tensor([item["evidence_weight"] for item in features], dtype=torch.float32),
        }
        if all("reference_chosen_logp" in item for item in features):
            result["reference_chosen_logp"] = torch.tensor([item["reference_chosen_logp"] for item in features])
            result["reference_rejected_logp"] = torch.tensor([item["reference_rejected_logp"] for item in features])
        return result


def sequence_log_prob(logits: Any, labels: Any) -> Any:
    import torch
    import torch.nn.functional as F
    shifted_logits, shifted_labels = logits[:, :-1, :].float(), labels[:, 1:]
    mask = shifted_labels.ne(-100)
    safe = shifted_labels.masked_fill(~mask, 0)
    token_logp = F.log_softmax(shifted_logits, dim=-1).gather(-1, safe.unsqueeze(-1)).squeeze(-1)
    return (token_logp * mask).sum(-1) / torch.sqrt(mask.sum(-1).clamp_min(1).float())


def sft_loss(logits: Any, labels: Any) -> Any:
    import torch.nn.functional as F
    return F.cross_entropy(logits[:, :-1, :].contiguous().float().view(-1, logits.shape[-1]), labels[:, 1:].contiguous().view(-1), ignore_index=-100)


def stacked_forward(model: Any, inputs: dict[str, Any]) -> tuple[Any, Any]:
    import torch
    batch = inputs["chosen_input_ids"].shape[0]
    output = model(input_ids=torch.cat([inputs["chosen_input_ids"], inputs["rejected_input_ids"]]), attention_mask=torch.cat([inputs["chosen_attention_mask"], inputs["rejected_attention_mask"]]), use_cache=False)
    return output.logits[:batch], output.logits[batch:]


def causal_fork_loss(*, policy_chosen_logits: Any, policy_rejected_logits: Any, reference_chosen_logp: Any, reference_rejected_logp: Any, chosen_labels: Any, rejected_labels: Any, evidence_weight: Any, beta: float, margin: float, sft_weight: float) -> tuple[Any, dict[str, Any]]:
    import torch.nn.functional as F
    chosen, rejected = sequence_log_prob(policy_chosen_logits, chosen_labels), sequence_log_prob(policy_rejected_logits, rejected_labels)
    advantage = (chosen - reference_chosen_logp) - (rejected - reference_rejected_logp)
    weights = evidence_weight / evidence_weight.mean().clamp_min(1e-6)
    preference = (-F.logsigmoid(beta * advantage - margin) * weights).mean()
    supervised = sft_loss(policy_chosen_logits, chosen_labels)
    total = preference + sft_weight * supervised
    return total, {"preference_loss": preference.detach(), "sft_loss": supervised.detach(), "causal_margin": advantage.detach().mean(), "pair_accuracy": advantage.detach().gt(margin / max(beta, 1e-9)).float().mean()}


def information_balanced_shards(rows: list[dict[str, Any]], tokenizer: Any, shard_count: int, seed: int, round_number: int, policy: dict[str, Any]) -> list[dict[str, Any]]:
    grouped: dict[str, list[tuple[dict[str, Any], dict[str, Any]]]] = defaultdict(list)
    for row in rows:
        item = tokenize_causal_fork(tokenizer, row, policy)
        grouped[str(item["group_id"])].append((row, item))
    work = []
    for group_id, items in grouped.items():
        attention = sum(item["attention_area_cost"] for _, item in items)
        information = sum(item["information_tokens"] * item["evidence_weight"] for _, item in items)
        work.append((-(information / max(1.0, math.sqrt(attention))), -attention, digest(f"{seed}:{round_number}:{group_id}"), group_id, items, attention))
    shards = [{"index": i, "load": 0, "groups": [], "rows": [], "metadata": []} for i in range(min(shard_count, len(work)))]
    for _, _, _, group_id, items, attention in sorted(work):
        target = min(shards, key=lambda shard: (shard["load"], shard["index"]))
        target["load"] += attention; target["groups"].append(group_id); target["rows"].extend(row for row, _ in items); target["metadata"].extend(item for _, item in items)
    return shards


def add_policy_args(parser: argparse.ArgumentParser) -> None:
    for key, value in DEFAULT_POLICY.items():
        parser.add_argument("--" + key.replace("_", "-"), type=int, default=value)


def policy_from_args(args: argparse.Namespace) -> dict[str, int]:
    return normalized_policy({key: getattr(args, key) for key in DEFAULT_POLICY})


def load_tokenizer(model_dir: pathlib.Path) -> Any:
    from transformers import AutoTokenizer
    tokenizer = AutoTokenizer.from_pretrained(model_dir, local_files_only=True, trust_remote_code=False)
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    return tokenizer


def load_nf4_base(model_dir: pathlib.Path, checkpointing: bool) -> tuple[Any, Any]:
    import torch
    from peft import prepare_model_for_kbit_training
    from transformers import AutoModelForCausalLM, BitsAndBytesConfig
    if not torch.cuda.is_available():
        raise SystemExit("Information-budgeted RSLoRA requires real CUDA. Refusing CPU fallback.")
    tokenizer = load_tokenizer(model_dir)
    quant = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_use_double_quant=True, bnb_4bit_compute_dtype=torch.float16)
    model = AutoModelForCausalLM.from_pretrained(model_dir, quantization_config=quant, device_map={"": torch.cuda.current_device()}, local_files_only=True, trust_remote_code=False)
    if not getattr(model, "is_loaded_in_4bit", False):
        raise SystemExit("Student checkpoint did not load in NF4 mode.")
    model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=checkpointing); model.config.use_cache = False
    return model, tokenizer


def segment_command(args: argparse.Namespace) -> None:
    train_path, dev_path, pair_path, model_dir, output = map(lambda value: pathlib.Path(value).resolve(), [args.train, args.development, args.pair_receipt, args.model_dir, args.output])
    if output.exists(): raise SystemExit(f"Refusing overwrite: {output}")
    train_rows, dev_rows, pair_receipt = read_jsonl(train_path, True), read_jsonl(dev_path, True), read_json(pair_path)
    if pair_receipt.get("schema") != PAIR_RECEIPT_SCHEMA: raise SystemExit("Unsupported pair receipt.")
    pair_digest = verify_receipt(pair_receipt)
    if sorted(row["pair_digest"] for row in train_rows + dev_rows) != sorted(pair_receipt.get("pair_digests", [])): raise SystemExit("Pair bytes mismatch.")
    tokenizer, policy = load_tokenizer(model_dir), policy_from_args(args)
    shards = information_balanced_shards(train_rows, tokenizer, args.shards, args.seed, args.round, policy)
    dev_meta = [tokenize_causal_fork(tokenizer, row, policy) for row in dev_rows]
    output.mkdir(parents=True)
    summaries = []
    for shard in shards:
        directory = output / f"shard-{shard['index']:03d}"; directory.mkdir()
        train_out, dev_out = directory / "causal-preference.train.jsonl", directory / "causal-preference.development.jsonl"
        write_jsonl(train_out, shard["rows"]); write_jsonl(dev_out, dev_rows)
        subset_body = {"schema": PAIR_RECEIPT_SCHEMA, "seed": args.seed, "holdout_rate": pair_receipt.get("holdout_rate"), "batch_digests": pair_receipt.get("batch_digests", []), "pair_digests": sorted(row["pair_digest"] for row in shard["rows"] + dev_rows), "counts": {"total": len(shard["rows"]) + len(dev_rows), "train": len(shard["rows"]), "development": len(dev_rows)}, "method": "information-budgeted-causal-subset/v1", "source_pair_receipt_digest": pair_digest, "request_id": args.request_id, "code_revision": args.code_revision, "round": args.round, "shard_index": shard["index"]}
        subset = {**subset_body, "receipt_digest": digest(subset_body)}; subset_path = directory / "causal-preference-receipt.json"; subset_path.write_text(json.dumps(subset, indent=2, sort_keys=True) + "\n")
        raw_area = sum(item["tokenization"]["original"]["attention_area"] for item in shard["metadata"]); replay_area = sum(item["attention_area_cost"] for item in shard["metadata"])
        body = {"schema": SHARD_SCHEMA, "method": METHOD, "training_method": TRAINING_METHOD, "request_id": args.request_id, "code_revision": args.code_revision, "round": args.round, "shard_index": shard["index"], "pair_receipt_digest": pair_digest, "tokenizer_identity_digest": tokenizer_identity(model_dir).get("digest"), "train": {"path": train_out.name, "sha256": sha256(train_out), "rows": len(shard["rows"]), "pair_ids": sorted(str(row.get("pair_id")) for row in shard["rows"]), "pair_digests": [row["pair_digest"] for row in shard["rows"]], "groups": sorted(shard["groups"]), "raw_token_cost": sum(item["tokenization"]["original"]["token_cost"] for item in shard["metadata"]), "weighted_token_cost": replay_area, "raw_attention_area": raw_area, "replayed_attention_area": replay_area, "information_tokens": sum(item["information_tokens"] for item in shard["metadata"]), "estimated_attention_reduction": 1 - replay_area / max(1, raw_area), "metadata": [{key: item[key] for key in ("pair_id", "pair_digest", "tokenization_digest", "attention_area_cost", "information_tokens")} for item in shard["metadata"]]}, "causal_pair_receipt": {"path": subset_path.name, "sha256": sha256(subset_path), "receipt_digest": subset["receipt_digest"]}, "development": {"path": dev_out.name, "sha256": sha256(dev_out), "rows": len(dev_rows), "pair_digests": [row["pair_digest"] for row in dev_rows], "scope": "global-held-out-comparison", "metadata": [{key: item[key] for key in ("pair_id", "pair_digest", "tokenization_digest", "attention_area_cost", "information_tokens")} for item in dev_meta]}, "policy": policy, "claim_boundary": "Deterministic lineage-atomic attention-area shard; no neural claim."}
        receipt = {**body, "receipt_digest": digest(body)}; receipt_path = directory / "shard-receipt.json"; receipt_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
        summaries.append({"shard_index": shard["index"], "directory": directory.name, "receipt_sha256": sha256(receipt_path), "receipt_digest": receipt["receipt_digest"], "replayed_attention_area": replay_area})
    body = {"schema": SEGMENTATION_SCHEMA, "method": METHOD, "training_method": TRAINING_METHOD, "request_id": args.request_id, "code_revision": args.code_revision, "round": args.round, "seed": args.seed, "source": {"train": {"path": str(train_path), "sha256": sha256(train_path), "rows": len(train_rows)}, "development": {"path": str(dev_path), "sha256": sha256(dev_path), "rows": len(dev_rows)}, "pair_receipt": {"path": str(pair_path), "sha256": sha256(pair_path), "receipt_digest": pair_digest}}, "tokenizer": tokenizer_identity(model_dir), "shards": summaries, "policy": {"lineage_atomic": True, "causal_fork_replay": policy, "balance_metric": "replayed_attention_area", "global_held_out_split_on_every_shard": True}, "promotion": "not-admitted", "claim_boundary": "CPU segmentation only; no gradient or capability claim."}
    receipt = {**body, "receipt_digest": digest(body)}; (output / "segmentation-receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n"); print(json.dumps(receipt, indent=2, sort_keys=True))


def cache_command(args: argparse.Namespace) -> None:
    import torch
    data, model_dir, output = pathlib.Path(args.preference_data).resolve(), pathlib.Path(args.model_dir).resolve(), pathlib.Path(args.output).resolve()
    if output.exists(): raise SystemExit(f"Refusing overwrite: {output}")
    rows, policy = read_jsonl(data, True), policy_from_args(args); model, tokenizer = load_nf4_base(model_dir, False); collator = ForkCollator(tokenizer.pad_token_id); model.eval(); entries = []
    with torch.no_grad():
        for row in rows:
            item = tokenize_causal_fork(tokenizer, row, policy); batch = collator([item]); device = torch.device("cuda", torch.cuda.current_device()); batch = {key: value.to(device) if hasattr(value, "to") else value for key, value in batch.items()}; chosen, rejected = stacked_forward(model, batch)
            entries.append({"pair_id": item["pair_id"], "pair_digest": item["pair_digest"], "tokenization_digest": item["tokenization_digest"], "reference_chosen_logp": float(sequence_log_prob(chosen, batch["chosen_divergence_labels"])[0]), "reference_rejected_logp": float(sequence_log_prob(rejected, batch["rejected_divergence_labels"])[0]), "avoided_reference_forward_tokens_per_epoch": item["tokenization"]["replayed"]["token_cost"]})
    output.mkdir(parents=True); entries_path = output / "reference-scores.jsonl"; write_jsonl(entries_path, entries)
    body = {"schema": CACHE_SCHEMA, "method": TRAINING_METHOD, "student_checkpoint": {**directory_identity(model_dir), "path": str(model_dir)}, "tokenizer": tokenizer_identity(model_dir), "source": {"path": str(data), "sha256": sha256(data), "rows": len(rows)}, "policy": policy, "entries": {"path": entries_path.name, "sha256": sha256(entries_path), "rows": len(entries), "pair_digests": sorted(item["pair_digest"] for item in entries)}, "promotion": "not-admitted", "claim_boundary": "Frozen-base scalar cache only; no weight update."}
    receipt = {**body, "receipt_digest": digest(body)}; (output / "reference-cache-receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n"); print(json.dumps(receipt, indent=2, sort_keys=True))


def load_cache(directory: pathlib.Path, rows: list[dict[str, Any]], model_dir: pathlib.Path, policy: dict[str, int], tokenizer: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    receipt = read_json(directory / "reference-cache-receipt.json"); verify_receipt(receipt)
    if receipt.get("schema") != CACHE_SCHEMA or receipt.get("student_checkpoint", {}).get("directory_digest") != directory_identity(model_dir)["directory_digest"] or receipt.get("policy") != policy: raise SystemExit("Reference cache binding mismatch.")
    path = directory / receipt["entries"]["path"]
    if sha256(path) != receipt["entries"]["sha256"]: raise SystemExit("Reference cache bytes mismatch.")
    entries = {str(item["pair_id"]): item for item in read_jsonl(path, True)}
    for row in rows:
        item, cached = tokenize_causal_fork(tokenizer, row, policy), entries.get(str(row.get("pair_id")))
        if not cached or cached.get("pair_digest") != item["pair_digest"] or cached.get("tokenization_digest") != item["tokenization_digest"]: raise SystemExit("Reference cache pair mismatch.")
    return entries, receipt


def supports_kwarg(callable_object: Any, name: str) -> bool:
    parameters = inspect.signature(callable_object).parameters
    return name in parameters or any(item.kind == inspect.Parameter.VAR_KEYWORD for item in parameters.values())


def train_command(args: argparse.Namespace) -> None:
    import torch
    from datasets import Dataset
    from peft import LoraConfig, get_peft_model
    from transformers import Trainer, TrainingArguments
    profile_path, workspace, data, pair_path, model_dir, output = map(lambda value: pathlib.Path(value).resolve(), [args.profile, args.workspace, args.preference_data, args.preference_receipt, args.model_dir, args.output])
    cache_dir = pathlib.Path(args.reference_cache).resolve() if args.reference_cache else None
    if output.exists(): raise SystemExit(f"Refusing overwrite: {output}")
    profile, pair_receipt, rows = read_json(profile_path), read_json(pair_path), read_jsonl(data, True); cfg = profile.get("training") or {}; verify_receipt(pair_receipt)
    if profile.get("schema") != "archie-distill-profile/v1" or pair_receipt.get("schema") != PAIR_RECEIPT_SCHEMA: raise SystemExit("Profile or pair receipt mismatch.")
    allowed = set(pair_receipt.get("pair_digests", []))
    if any(row.get("pair_digest") not in allowed for row in rows): raise SystemExit("Training row outside receipt.")
    seed = int(cfg["seed"]); random.seed(seed); torch.manual_seed(seed); torch.cuda.manual_seed_all(seed); torch.use_deterministic_algorithms(True); torch.backends.cuda.matmul.allow_tf32 = False; torch.backends.cudnn.allow_tf32 = False; torch.backends.cudnn.benchmark = False; torch.backends.cudnn.deterministic = True
    model, tokenizer = load_nf4_base(model_dir, True); policy = policy_from_args(args); tokenized = [tokenize_causal_fork(tokenizer, row, policy) for row in rows]; cache_receipt = None
    if cache_dir:
        cache, cache_receipt = load_cache(cache_dir, rows, model_dir, policy, tokenizer)
        for item in tokenized: item.update(reference_chosen_logp=float(cache[str(item["pair_id"])]["reference_chosen_logp"]), reference_rejected_logp=float(cache[str(item["pair_id"])]["reference_rejected_logp"]))
    requested, supported = bool(cfg.get("use_rslora", True)), supports_kwarg(LoraConfig.__init__, "use_rslora"); active = requested and supported; fallback = None if active or not requested else "installed-peft-loraconfig-has-no-use_rslora"
    lora = {"r": int(cfg["lora_rank"]), "lora_alpha": int(cfg["lora_alpha"]), "lora_dropout": float(cfg.get("lora_dropout", 0)), "bias": "none", "task_type": "CAUSAL_LM", "target_modules": cfg.get("target_modules", "all-linear")}
    if supported: lora["use_rslora"] = active
    model = get_peft_model(model, LoraConfig(**lora)); trainable = [name for name, parameter in model.named_parameters() if parameter.requires_grad]
    if not trainable or any("lora_" not in name for name in trainable): raise SystemExit("Only LoRA parameters may train.")

    class ForkTrainer(Trainer):
        def compute_loss(self, model: Any, inputs: dict[str, Any], return_outputs: bool = False, num_items_in_batch: Any = None) -> Any:
            chosen, rejected = stacked_forward(model, inputs)
            if "reference_chosen_logp" in inputs: ref_chosen, ref_rejected = inputs["reference_chosen_logp"].to(chosen.device), inputs["reference_rejected_logp"].to(chosen.device)
            else:
                with model.disable_adapter(), torch.no_grad(): ref_chosen_logits, ref_rejected_logits = stacked_forward(model, inputs)
                ref_chosen, ref_rejected = sequence_log_prob(ref_chosen_logits, inputs["chosen_divergence_labels"]), sequence_log_prob(ref_rejected_logits, inputs["rejected_divergence_labels"])
            loss, metrics = causal_fork_loss(policy_chosen_logits=chosen, policy_rejected_logits=rejected, reference_chosen_logp=ref_chosen, reference_rejected_logp=ref_rejected, chosen_labels=inputs["chosen_divergence_labels"], rejected_labels=inputs["rejected_divergence_labels"], evidence_weight=inputs["evidence_weight"].to(chosen.device), beta=args.beta, margin=args.causal_margin, sft_weight=args.sft_weight)
            if model.training: self.log({key: float(value.cpu()) for key, value in metrics.items()})
            return (loss, {"chosen": chosen, "rejected": rejected}) if return_outputs else loss

    values = {"output_dir": str(output / "checkpoints"), "num_train_epochs": float(cfg["epochs"]), "learning_rate": float(cfg["learning_rate"]), "per_device_train_batch_size": args.batch_size, "gradient_accumulation_steps": args.gradient_accumulation_steps, "gradient_checkpointing": True, "gradient_checkpointing_kwargs": {"use_reentrant": False}, "optim": "paged_adamw_8bit", "dataloader_num_workers": 0, "logging_steps": 1, "save_strategy": "epoch", "eval_strategy": "no", "evaluation_strategy": "no", "seed": seed, "data_seed": seed, "full_determinism": True, "tf32": False, "report_to": [], "remove_unused_columns": False, "bf16": False, "fp16": True}
    values = {key: value for key, value in values.items() if supports_kwarg(TrainingArguments.__init__, key)}; output.mkdir(parents=True)
    trainer = ForkTrainer(model=model, args=TrainingArguments(**values), train_dataset=Dataset.from_list(tokenized), data_collator=ForkCollator(tokenizer.pad_token_id)); result = trainer.train(); adapter = output / "adapter"; trainer.model.save_pretrained(adapter); tokenizer.save_pretrained(adapter)
    raw_area, replay_area = sum(item["tokenization"]["original"]["attention_area"] for item in tokenized), sum(item["attention_area_cost"] for item in tokenized)
    body = {"schema": TRAINING_SCHEMA, "method": TRAINING_METHOD, "federation_method": METHOD, "profile": {"id": profile.get("id"), "sha256": sha256(profile_path)}, "training_plan": {"path": str(workspace / "training-plan.json"), "sha256": sha256(workspace / "training-plan.json") if (workspace / "training-plan.json").is_file() else None}, "preference_dataset": {"path": str(data), "sha256": sha256(data), "rows": len(rows), "receipt_digest": pair_receipt.get("receipt_digest")}, "student_checkpoint": {**directory_identity(model_dir), "path": str(model_dir), "tokenizer": tokenizer_identity(model_dir)}, "optimization": {"quantization": "NF4 double-quant float16", "optimizer": "paged_adamw_8bit", "epochs": float(cfg["epochs"]), "learning_rate": float(cfg["learning_rate"]), "lora": {**lora, "requested_rslora": requested, "rslora_supported": supported, "rslora_active": active, "fallback_reason": fallback, "scaling_law": "alpha/sqrt(rank)" if active else "alpha/rank"}, "policy": policy, "stacked_chosen_rejected_forward": True, "reference_policy": "receipt-bound frozen-base scalar cache" if cache_dir else "live frozen base", "original_attention_area": raw_area, "replayed_attention_area": replay_area, "estimated_attention_reduction": 1 - replay_area / max(1, raw_area), "supervised_information_tokens": sum(item["information_tokens"] for item in tokenized), "avoided_reference_forward_tokens_per_training_run": sum(item["tokenization"]["replayed"]["token_cost"] for item in tokenized) * float(cfg["epochs"]) if cache_dir else 0, "trainable_parameter_names": trainable}, "reference_cache": {"path": str(cache_dir), "receipt_digest": cache_receipt.get("receipt_digest")} if cache_receipt else None, "train_metrics": result.metrics, "artifacts": artifact_manifest(adapter), "promotion": "not-admitted", "novelty_boundary": "Repository experiment combining causal-fork replay, attention-area sharding, stacked pair forwards, cached references, and RSLoRA; components have prior art.", "claim_boundary": "CUDA adapter trained; evaluation, fusion, quantization, reproduction, and admission remain unproven.", "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    receipt = {**body, "receipt_digest": digest(body)}; (output / "training-receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n"); print(json.dumps(receipt, indent=2, sort_keys=True))


def verify_command(args: argparse.Namespace) -> None:
    import torch
    from peft import LoraConfig, get_peft_model, get_peft_model_state_dict, set_peft_model_state_dict
    from peft.utils.save_and_load import load_peft_weights
    common, _ = repo_helpers()
    from verify_segment_adapter import adapter_change_proof, compare_metrics, evaluate_policy  # type: ignore
    profile_path, model_dir, adapter_dir, evaluation, training_path, shard_path, output = map(lambda value: pathlib.Path(value).resolve(), [args.profile, args.model_dir, args.adapter_dir, args.evaluation_data, args.training_receipt, args.shard_receipt, args.output])
    if output.exists(): raise SystemExit(f"Refusing overwrite: {output}")
    output.mkdir(parents=True); training, shard, profile = read_json(training_path), read_json(shard_path), read_json(profile_path); verify_receipt(training); verify_receipt(shard)
    if training.get("schema") != TRAINING_SCHEMA or training.get("method") != TRAINING_METHOD or shard.get("schema") != SHARD_SCHEMA or sha256(evaluation) != shard.get("development", {}).get("sha256"): raise SystemExit("Verification binding mismatch.")
    seed = int(profile["training"]["seed"]); torch.manual_seed(seed); torch.cuda.manual_seed_all(seed); model, tokenizer = load_nf4_base(model_dir, False); config = LoraConfig.from_pretrained(adapter_dir); config.inference_mode = False; model = get_peft_model(model, config)
    initial = {name: tensor.detach().cpu().clone() for name, tensor in get_peft_model_state_dict(model).items()}; final = load_peft_weights(str(adapter_dir), device="cpu"); proof = adapter_change_proof(initial, final); result = set_peft_model_state_dict(model, final)
    if getattr(result, "unexpected_keys", None) or getattr(result, "mismatched_keys", None): raise SystemExit("Adapter exact load failed.")
    rows = common.read_jsonl(evaluation, required=True); base_metrics = evaluate_policy(model, rows, tokenizer, args.max_seq_length, adapter_enabled=False); adapter_metrics = evaluate_policy(model, rows, tokenizer, args.max_seq_length, adapter_enabled=True); comparison = compare_metrics(base_metrics, adapter_metrics)
    config_path = adapter_dir / "adapter_config.json"; body = {"schema": VERIFICATION_SCHEMA, "method": METHOD, "training_method": TRAINING_METHOD, "request_id": shard.get("request_id"), "code_revision": shard.get("code_revision"), "round": shard.get("round"), "shard_index": shard.get("shard_index"), "profile": {"path": str(profile_path), "sha256": sha256(profile_path), "id": profile.get("id")}, "student_checkpoint": {**directory_identity(model_dir), "path": str(model_dir), "tokenizer": tokenizer_identity(model_dir)}, "adapter": {"path": str(adapter_dir), "directory": directory_identity(adapter_dir), "config_sha256": sha256(config_path), "training_receipt_sha256": sha256(training_path), "training_receipt_digest": training.get("receipt_digest"), "change_proof": proof}, "segmentation": {"shard_receipt_sha256": sha256(shard_path), "shard_receipt_digest": shard.get("receipt_digest"), "pair_receipt_digest": shard.get("pair_receipt_digest"), "tokenizer_identity_digest": shard.get("tokenizer_identity_digest")}, "held_out": {"path": str(evaluation), "sha256": sha256(evaluation), "base": base_metrics, "adapter": adapter_metrics, "comparison": comparison}, "runtime": {"python": platform.python_version(), "platform": platform.platform(), "packages": package_versions(["torch", "transformers", "peft", "bitsandbytes", "accelerate"]), "cuda": torch.version.cuda, "gpu": {"index": torch.cuda.current_device(), "name": torch.cuda.get_device_name(torch.cuda.current_device()), "total_memory_bytes": torch.cuda.get_device_properties(torch.cuda.current_device()).total_memory}}, "fusion_eligible": proof["changed_tensor_count"] > 0 and comparison["pair_accuracy_delta"] >= 0 and comparison["non_regression"], "promotion": "not-admitted", "claim_boundary": "Changed tensors and full-sequence held-out comparison only; no admission.", "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    receipt = {**body, "receipt_digest": digest(body)}; (output / "segment-verification-receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n"); print(json.dumps(receipt, indent=2, sort_keys=True))


def strict_gain(comparison: dict[str, Any], epsilon: float = 1e-9) -> bool:
    return comparison.get("pair_accuracy_delta", 0) > epsilon or comparison.get("mean_pair_margin_delta", 0) > epsilon or comparison.get("chosen_negative_log_probability_delta", 0) < -epsilon


def evaluate_fused_command(args: argparse.Namespace) -> None:
    import torch
    from peft import PeftModel
    common, _ = repo_helpers()
    from verify_segment_adapter import compare_metrics, evaluate_policy  # type: ignore
    profile_path, model_dir, adapter_dir, fusion_path, segment_path, evaluation, output = map(lambda value: pathlib.Path(value).resolve(), [args.profile, args.model_dir, args.adapter_dir, args.fusion_receipt, args.segmentation_receipt, args.evaluation_data, args.output])
    if output.exists(): raise SystemExit(f"Refusing overwrite: {output}")
    output.mkdir(parents=True); profile, fusion, segment = read_json(profile_path), read_json(fusion_path), read_json(segment_path); verify_receipt(fusion); verify_receipt(segment)
    if fusion.get("schema") != "archie-segment-adapter-fusion-receipt/v1" or segment.get("schema") != SEGMENTATION_SCHEMA or fusion.get("base_checkpoint_directory_digest") != directory_identity(model_dir)["directory_digest"] or segment.get("source", {}).get("development", {}).get("sha256") != sha256(evaluation): raise SystemExit("Fused evaluation binding mismatch.")
    if sha256(adapter_dir / "adapter_model.safetensors") != fusion.get("fused_adapter", {}).get("model_sha256") or sha256(adapter_dir / "adapter_config.json") != fusion.get("fused_adapter", {}).get("config_sha256"): raise SystemExit("Fused adapter byte mismatch.")
    seed = int(profile["training"]["seed"]); torch.manual_seed(seed); torch.cuda.manual_seed_all(seed); base, tokenizer = load_nf4_base(model_dir, False); model = PeftModel.from_pretrained(base, adapter_dir, is_trainable=False, local_files_only=True); rows = common.read_jsonl(evaluation, required=True)
    base_metrics, fused_metrics = evaluate_policy(model, rows, tokenizer, args.max_seq_length, adapter_enabled=False), evaluate_policy(model, rows, tokenizer, args.max_seq_length, adapter_enabled=True); comparison = compare_metrics(base_metrics, fused_metrics); gain = strict_gain(comparison); passed = comparison["non_regression"] and comparison["pair_accuracy_delta"] >= 0 and gain
    body = {"schema": "archie-fused-adapter-evaluation-receipt/v1", "method": METHOD, "training_method": TRAINING_METHOD, "profile": {"path": str(profile_path), "sha256": sha256(profile_path), "id": profile.get("id")}, "student_checkpoint": {**directory_identity(model_dir), "path": str(model_dir), "tokenizer": tokenizer_identity(model_dir)}, "fusion": {"receipt_path": str(fusion_path), "receipt_sha256": sha256(fusion_path), "receipt_digest": fusion.get("receipt_digest"), "adapter_path": str(adapter_dir), "adapter_model_sha256": sha256(adapter_dir / "adapter_model.safetensors"), "adapter_config_sha256": sha256(adapter_dir / "adapter_config.json")}, "segmentation": {"receipt_path": str(segment_path), "receipt_sha256": sha256(segment_path), "receipt_digest": segment.get("receipt_digest"), "round": segment.get("round")}, "held_out": {"path": str(evaluation), "sha256": sha256(evaluation), "base": base_metrics, "fused_adapter": fused_metrics, "comparison": comparison}, "capability_gain_observed": gain, "evaluation_passed": passed, "quantization_eligible": passed, "promotion": "not-admitted", "claim_boundary": "Strict full-sequence held-out gate only; no broad capability or admission claim.", "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    receipt = {**body, "receipt_digest": digest(body)}; (output / "fused-adapter-evaluation-receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n"); print(json.dumps(receipt, indent=2, sort_keys=True))
    if not passed: raise SystemExit("Fused adapter failed strict non-regressive improvement.")


def build_parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(); commands = root.add_subparsers(dest="command", required=True)
    segment = commands.add_parser("segment")
    for name in ("train", "development", "pair-receipt", "model-dir", "output", "request-id", "code-revision"): segment.add_argument("--" + name, required=True)
    segment.add_argument("--shards", type=int, default=2); segment.add_argument("--seed", type=int, default=3407); segment.add_argument("--round", type=int, default=0); add_policy_args(segment)
    cache = commands.add_parser("cache-reference")
    for name in ("preference-data", "model-dir", "output"): cache.add_argument("--" + name, required=True)
    add_policy_args(cache)
    train = commands.add_parser("train")
    for name in ("profile", "workspace", "preference-data", "preference-receipt", "model-dir", "output"): train.add_argument("--" + name, required=True)
    train.add_argument("--reference-cache"); train.add_argument("--gradient-accumulation-steps", type=int, default=8); train.add_argument("--batch-size", type=int, default=1); train.add_argument("--beta", type=float, default=.1); train.add_argument("--causal-margin", type=float, default=.2); train.add_argument("--sft-weight", type=float, default=.35); add_policy_args(train)
    verify = commands.add_parser("verify")
    for name in ("profile", "model-dir", "adapter-dir", "evaluation-data", "training-receipt", "shard-receipt", "output"): verify.add_argument("--" + name, required=True)
    verify.add_argument("--max-seq-length", type=int, default=1536)
    fused = commands.add_parser("evaluate-fused")
    for name in ("profile", "model-dir", "adapter-dir", "fusion-receipt", "segmentation-receipt", "evaluation-data", "output"): fused.add_argument("--" + name, required=True)
    fused.add_argument("--max-seq-length", type=int, default=1536)
    return root


def main() -> None:
    args = build_parser().parse_args()
    {"segment": segment_command, "cache-reference": cache_command, "train": train_command, "verify": verify_command, "evaluate-fused": evaluate_fused_command}[args.command](args)


if __name__ == "__main__":
    main()
