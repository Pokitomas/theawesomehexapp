#!/usr/bin/env python3
"""Train Archie on real Git transitions with causal contrast and curiosity allocation."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import pathlib
import random
import tempfile
import time
from collections import Counter
from dataclasses import asdict
from typing import Any

import numpy as np
import torch
import torch.nn.functional as F

from archie_hybrid_core import BOS_ID, EOS_ID, PAD_ID, SEP_ID, ArchieHybridLM, ByteTokenizer, ModelConfig, parameter_count
from archie_tokenizers import ArchieTokenizer, tokenizer_from_metadata

SCHEMA = "archie-git-experience-training-receipt/v1"
DATA_SCHEMA = "archie-git-experience/v1"
DATA_RECEIPT_SCHEMA = "archie-git-experience-receipt/v1"
CAUSAL_EVENT_SCHEMA = "archie-causal-event-patch/v1"


def stable(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(value: Any) -> str:
    payload = value if isinstance(value, bytes) else stable(value).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: pathlib.Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(1 << 20):
            value.update(block)
    return value.hexdigest()


def atomic_json(path: pathlib.Path, value: Any) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def load_receipt(path: pathlib.Path) -> dict[str, Any]:
    receipt = json.loads(path.read_text(encoding="utf-8"))
    if receipt.get("schema") != DATA_RECEIPT_SCHEMA:
        raise SystemExit("unsupported Git experience receipt")
    claimed = receipt.get("receipt_digest")
    body = dict(receipt)
    body.pop("receipt_digest", None)
    if digest(body) != claimed:
        raise SystemExit("Git experience receipt digest mismatch")
    return receipt


def load_rows(path: pathlib.Path, receipt: dict[str, Any], artifact: str) -> list[dict[str, Any]]:
    evidence = receipt.get("artifacts", {}).get(artifact, {})
    if sha256_file(path) != evidence.get("sha256"):
        raise SystemExit(f"{artifact} Git experience artifact digest mismatch")
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            row = json.loads(line)
            if row.get("schema") != DATA_SCHEMA:
                raise SystemExit(f"unsupported row at {path}:{line_number}")
            claimed = row.get("episode_digest")
            body = dict(row)
            body.pop("episode_digest", None)
            if digest(body) != claimed:
                raise SystemExit(f"episode digest mismatch at {path}:{line_number}")
            if not row.get("prompt") or not row.get("chosen_target") or not row.get("rejected_target"):
                raise SystemExit(f"incomplete episode at {path}:{line_number}")
            if row["chosen_target"] == row["rejected_target"]:
                raise SystemExit(f"non-divergent episode at {path}:{line_number}")
            event = row.get("causal_event_patch")
            if event is not None:
                if event.get("schema") != CAUSAL_EVENT_SCHEMA:
                    raise SystemExit(f"unsupported causal event patch at {path}:{line_number}")
                event_body = dict(event)
                claimed_event_digest = event_body.pop("event_digest", None)
                if digest(event_body) != claimed_event_digest:
                    raise SystemExit(f"causal event patch digest mismatch at {path}:{line_number}")
                receipts = event.get("receipts", {})
                if receipts.get("chosen_patch_sha256") != digest(row["chosen_target"]):
                    raise SystemExit(f"causal event chosen patch mismatch at {path}:{line_number}")
                candidates = event.get("candidate_actions", [])
                chosen_action = next(
                    (item for item in candidates if item.get("action_id") == event.get("chosen_action_id")),
                    None,
                )
                if chosen_action is None or chosen_action.get("target_field") != "chosen_target":
                    raise SystemExit(f"causal event chosen action is invalid at {path}:{line_number}")
            rows.append(row)
    if not rows:
        raise SystemExit(f"{artifact} Git experience artifact is empty")
    return rows


def compact_prompt(tokenizer: ArchieTokenizer, text: str, budget: int) -> list[int]:
    tokens = tokenizer.encode(text)
    if len(tokens) <= budget:
        return tokens
    head = max(32, budget // 3)
    tail = budget - head - 1
    if tail < 1:
        return tokens[:budget]
    return [*tokens[:head], SEP_ID, *tokens[-tail:]]


def tokenize_row(
    tokenizer: ArchieTokenizer, row: dict[str, Any], max_seq_length: int,
    max_target_tokens: int,
) -> dict[str, Any]:
    chosen = tokenizer.encode(str(row["chosen_target"]))[:max_target_tokens]
    rejected = tokenizer.encode(str(row["rejected_target"]))[:max_target_tokens]
    if not chosen or not rejected:
        raise ValueError(f"empty token target for {row['episode_id']}")
    if chosen == rejected:
        raise ValueError(f"counterfactual diverges after the target budget for {row['episode_id']}")
    divergence = 0
    while divergence < min(len(chosen), len(rejected)) and chosen[divergence] == rejected[divergence]:
        divergence += 1
    target_width = max(len(chosen), len(rejected)) + 1
    prompt_budget = max_seq_length - target_width - 1
    if prompt_budget < 64:
        raise ValueError("target budget leaves fewer than 64 prompt tokens")
    prompt = compact_prompt(tokenizer, str(row["prompt"]), prompt_budget)

    def sequence(target: list[int], include_sft: bool) -> tuple[list[int], list[int], list[int]]:
        input_ids = [BOS_ID, *prompt, *target, EOS_ID]
        sft_labels = (
            [PAD_ID] * (1 + len(prompt)) + [*target, EOS_ID]
            if include_sft else [PAD_ID] * len(input_ids)
        )
        preference_labels = [PAD_ID] * (1 + len(prompt) + divergence) + [*target[divergence:], EOS_ID]
        return input_ids, sft_labels, preference_labels

    chosen_ids, chosen_sft_labels, chosen_preference_labels = sequence(chosen, True)
    rejected_ids, rejected_sft_labels, rejected_preference_labels = sequence(rejected, False)
    return {
        "row": row,
        "chosen_ids": chosen_ids,
        "chosen_sft_labels": chosen_sft_labels,
        "chosen_preference_labels": chosen_preference_labels,
        "rejected_ids": rejected_ids,
        "rejected_sft_labels": rejected_sft_labels,
        "rejected_preference_labels": rejected_preference_labels,
        "divergence_target_token": divergence,
        "cost_tokens": len(chosen_ids) + len(rejected_ids),
    }


def tokenize_rows(
    tokenizer: ArchieTokenizer, rows: list[dict[str, Any]], max_seq_length: int,
    max_target_tokens: int,
) -> list[dict[str, Any]]:
    encoded: list[dict[str, Any]] = []
    rejected = 0
    for row in rows:
        try:
            encoded.append(tokenize_row(tokenizer, row, max_seq_length, max_target_tokens))
        except ValueError:
            rejected += 1
    if not encoded:
        raise SystemExit("no Git experience episodes fit the sequence budget")
    if rejected:
        print(json.dumps({"tokenization_rejected": rejected}, sort_keys=True), flush=True)
    return encoded


def collate_episode(
    item: dict[str, Any], device: torch.device,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    sequences = [item["chosen_ids"], item["rejected_ids"]]
    sft_labels = [item["chosen_sft_labels"], item["rejected_sft_labels"]]
    preference_labels = [item["chosen_preference_labels"], item["rejected_preference_labels"]]
    width = max(len(sequence) for sequence in sequences)
    input_tensor = torch.tensor(
        [sequence + [PAD_ID] * (width - len(sequence)) for sequence in sequences],
        dtype=torch.long, device=device,
    )
    sft_tensor = torch.tensor(
        [row + [PAD_ID] * (width - len(row)) for row in sft_labels],
        dtype=torch.long, device=device,
    )
    preference_tensor = torch.tensor(
        [row + [PAD_ID] * (width - len(row)) for row in preference_labels],
        dtype=torch.long, device=device,
    )
    return input_tensor, sft_tensor, preference_tensor


def target_log_prob(logits: torch.Tensor, labels: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    shifted_logits = logits[:, :-1].float()
    shifted_labels = labels[:, 1:]
    mask = shifted_labels.ne(PAD_ID)
    safe = shifted_labels.masked_fill(~mask, 0)
    log_probs = F.log_softmax(shifted_logits, dim=-1).gather(-1, safe.unsqueeze(-1)).squeeze(-1)
    totals = (log_probs * mask).sum(dim=-1)
    lengths = mask.sum(dim=-1).clamp_min(1)
    return totals / lengths, lengths


def experience_loss(
    logits: torch.Tensor, sft_labels: torch.Tensor,
    preference_labels: torch.Tensor, *, preference_weight: float,
    causal_margin: float,
) -> tuple[torch.Tensor, dict[str, torch.Tensor]]:
    sft_log_probs, sft_lengths = target_log_prob(logits, sft_labels)
    divergence_log_probs, divergence_lengths = target_log_prob(logits, preference_labels)
    chosen_ce = -sft_log_probs[0]
    advantage = divergence_log_probs[0] - divergence_log_probs[1]
    preference = F.softplus(causal_margin - advantage)
    total = chosen_ce + preference_weight * preference
    return total, {
        "chosen_nats_per_token": chosen_ce.detach(),
        "chosen_divergence_nats_per_token": (-divergence_log_probs[0]).detach(),
        "rejected_divergence_nats_per_token": (-divergence_log_probs[1]).detach(),
        "causal_advantage": advantage.detach(),
        "preference_loss": preference.detach(),
        "chosen_target_tokens": sft_lengths[0].detach(),
        "chosen_divergence_tokens": divergence_lengths[0].detach(),
        "rejected_divergence_tokens": divergence_lengths[1].detach(),
    }


class CuriosityExchange:
    def __init__(self, items: list[dict[str, Any]], seed: int, exploration_rate: float) -> None:
        self.items = items
        self.rng = random.Random(seed)
        self.exploration_rate = exploration_rate
        self.weights = [0.03 for _ in items]
        self.ema_loss: list[float | None] = [None for _ in items]
        self.ema_advantage: list[float | None] = [None for _ in items]
        self.progress = [0.0 for _ in items]
        self.samples = [0 for _ in items]

    def choose(self) -> int:
        unseen = [index for index, value in enumerate(self.ema_loss) if value is None]
        seen = [index for index, value in enumerate(self.ema_loss) if value is not None]
        if unseen and (not seen or self.rng.random() < self.exploration_rate):
            return unseen[self.rng.randrange(len(unseen))]
        pool = seen or unseen
        return self.rng.choices(pool, weights=[self.weights[index] for index in pool], k=1)[0]

    def observe(self, index: int, loss: float, advantage: float) -> None:
        prior_loss = self.ema_loss[index]
        next_loss = loss if prior_loss is None else 0.85 * prior_loss + 0.15 * loss
        prior_advantage = self.ema_advantage[index]
        next_advantage = advantage if prior_advantage is None else 0.85 * prior_advantage + 0.15 * advantage
        progress = 0.0 if prior_loss is None else max(0.0, prior_loss - next_loss)
        surprise = min(max(next_loss / 8.0, 0.0), 1.0)
        confusion = 1.0 / (1.0 + math.exp(max(min(5.0 * next_advantage, 30.0), -30.0)))
        progress_signal = min(progress * 4.0, 1.0)
        bid = 0.12 + 0.43 * surprise + 0.35 * confusion + 0.10 * progress_signal
        price = math.sqrt(max(self.items[index]["cost_tokens"], 1) / 256.0)
        self.weights[index] = min(max(bid / max(price, 0.5), 0.03), 2.0)
        self.ema_loss[index] = next_loss
        self.ema_advantage[index] = next_advantage
        self.progress[index] = progress
        self.samples[index] += 1

    def state_dict(self) -> dict[str, Any]:
        return {
            "rng": self.rng.getstate(), "weights": self.weights,
            "exploration_rate": self.exploration_rate,
            "ema_loss": self.ema_loss, "ema_advantage": self.ema_advantage,
            "progress": self.progress, "samples": self.samples,
        }

    def load_state_dict(self, state: dict[str, Any]) -> None:
        if float(state["exploration_rate"]) != self.exploration_rate:
            raise SystemExit("curiosity checkpoint uses another exploration rate")
        self.rng.setstate(state["rng"])
        for name in ("weights", "ema_loss", "ema_advantage", "progress", "samples"):
            values = list(state[name])
            if len(values) != len(self.items):
                raise SystemExit("curiosity checkpoint does not match the experience inventory")
            setattr(self, name, values)

    def summary(self, maximum: int = 32) -> dict[str, Any]:
        ranked = sorted(
            range(len(self.items)),
            key=lambda index: (-self.samples[index], -self.weights[index], self.items[index]["row"]["episode_id"]),
        )
        return {
            "method": "student-bid-replay-with-bounded-unseen-exploration/v2",
            "exploration_rate": self.exploration_rate,
            "sampled_episodes": sum(count > 0 for count in self.samples),
            "total_episode_draws": sum(self.samples),
            "top_demands": [
                {
                    "episode_id": self.items[index]["row"]["episode_id"],
                    "commit": self.items[index]["row"]["commit"],
                    "path": self.items[index]["row"]["new_path"],
                    "samples": self.samples[index],
                    "final_weight": self.weights[index],
                    "ema_loss": self.ema_loss[index],
                    "ema_causal_advantage": self.ema_advantage[index],
                }
                for index in ranked[:maximum] if self.samples[index] > 0
            ],
        }


@torch.no_grad()
def evaluate(
    model: ArchieHybridLM, items: list[dict[str, Any]], device: torch.device,
    amp_dtype: torch.dtype | None, maximum: int, preference_weight: float,
    causal_margin: float,
) -> dict[str, Any]:
    model.eval()
    selected = items if maximum <= 0 or len(items) <= maximum else sorted(
        items, key=lambda item: digest(item["row"]["episode_id"])
    )[:maximum]
    chosen_losses: list[float] = []
    chosen_divergence_losses: list[float] = []
    rejected_divergence_losses: list[float] = []
    advantages: list[float] = []
    by_suffix: dict[str, list[float]] = {}
    for item in selected:
        inputs, sft_labels, preference_labels = collate_episode(item, device)
        with torch.autocast(device_type=device.type, dtype=amp_dtype, enabled=amp_dtype is not None):
            logits = model(inputs)["logits"]
            _, metrics = experience_loss(
                logits, sft_labels, preference_labels,
                preference_weight=preference_weight,
                causal_margin=causal_margin,
            )
        chosen = float(metrics["chosen_nats_per_token"].cpu())
        chosen_divergence = float(metrics["chosen_divergence_nats_per_token"].cpu())
        rejected = float(metrics["rejected_divergence_nats_per_token"].cpu())
        advantage = float(metrics["causal_advantage"].cpu())
        chosen_losses.append(chosen)
        chosen_divergence_losses.append(chosen_divergence)
        rejected_divergence_losses.append(rejected)
        advantages.append(advantage)
        by_suffix.setdefault(item["row"]["suffix"], []).append(advantage)
    model.train()
    return {
        "episodes": len(selected),
        "chosen_nats_per_token": sum(chosen_losses) / len(chosen_losses),
        "chosen_divergence_nats_per_token": sum(chosen_divergence_losses) / len(chosen_divergence_losses),
        "rejected_divergence_nats_per_token": sum(rejected_divergence_losses) / len(rejected_divergence_losses),
        "mean_causal_advantage": sum(advantages) / len(advantages),
        "pair_accuracy": sum(value > 0 for value in advantages) / len(advantages),
        "suffix_pair_accuracy": {
            suffix: sum(value > 0 for value in values) / len(values)
            for suffix, values in sorted(by_suffix.items())
        },
    }


@torch.no_grad()
def seed_curiosity(
    model: ArchieHybridLM, exchange: CuriosityExchange, device: torch.device,
    amp_dtype: torch.dtype | None, maximum: int, preference_weight: float,
    causal_margin: float,
) -> int:
    indices = sorted(
        range(len(exchange.items)),
        key=lambda index: digest(exchange.items[index]["row"]["episode_id"]),
    )[:maximum]
    model.eval()
    for index in indices:
        inputs, sft_labels, preference_labels = collate_episode(exchange.items[index], device)
        with torch.autocast(device_type=device.type, dtype=amp_dtype, enabled=amp_dtype is not None):
            logits = model(inputs)["logits"]
            _, metrics = experience_loss(
                logits, sft_labels, preference_labels,
                preference_weight=preference_weight,
                causal_margin=causal_margin,
            )
        exchange.observe(
            index, float(metrics["chosen_nats_per_token"].cpu()),
            float(metrics["causal_advantage"].cpu()),
        )
        exchange.samples[index] = 0
    model.train()
    return len(indices)


def save_training_state(
    path: pathlib.Path, *, model: ArchieHybridLM, optimizer: torch.optim.Optimizer,
    scheduler: torch.optim.lr_scheduler.LRScheduler, scaler: torch.amp.GradScaler,
    exchange: CuriosityExchange, step: int, history: list[dict[str, Any]],
    before: dict[str, Any], seeded: int, model_sha256: str, data_receipt_digest: str,
) -> None:
    state = {
        "schema": "archie-git-experience-run-state/v1",
        "model_sha256": model_sha256,
        "data_receipt_digest": data_receipt_digest,
        "step": step, "history": history, "before": before, "seeded": seeded,
        "model": model.state_dict(), "optimizer": optimizer.state_dict(),
        "scheduler": scheduler.state_dict(), "scaler": scaler.state_dict(),
        "exchange": exchange.state_dict(),
        "rng": {
            "python": random.getstate(), "numpy": np.random.get_state(),
            "torch": torch.get_rng_state(),
            "cuda": torch.cuda.get_rng_state_all() if torch.cuda.is_available() else None,
        },
    }
    temporary = path.with_suffix(path.suffix + ".tmp")
    torch.save(state, temporary)
    os.replace(temporary, path)


def load_training_state(
    path: pathlib.Path, *, model: ArchieHybridLM, optimizer: torch.optim.Optimizer,
    scheduler: torch.optim.lr_scheduler.LRScheduler, scaler: torch.amp.GradScaler,
    exchange: CuriosityExchange, model_sha256: str, data_receipt_digest: str,
) -> tuple[int, list[dict[str, Any]], dict[str, Any], int]:
    state = torch.load(path, map_location=next(model.parameters()).device, weights_only=False)
    if state.get("schema") != "archie-git-experience-run-state/v1":
        raise SystemExit("unsupported Git experience run-state checkpoint")
    if state.get("model_sha256") != model_sha256:
        raise SystemExit("Git experience checkpoint belongs to another initial model")
    if state.get("data_receipt_digest") != data_receipt_digest:
        raise SystemExit("Git experience checkpoint belongs to another dataset")
    model.load_state_dict(state["model"])
    optimizer.load_state_dict(state["optimizer"])
    scheduler.load_state_dict(state["scheduler"])
    scaler.load_state_dict(state["scaler"])
    exchange.load_state_dict(state["exchange"])
    random.setstate(state["rng"]["python"])
    np.random.set_state(state["rng"]["numpy"])
    torch.set_rng_state(state["rng"]["torch"].cpu())
    if torch.cuda.is_available() and state["rng"].get("cuda") is not None:
        torch.cuda.set_rng_state_all([value.cpu() for value in state["rng"]["cuda"]])
    return int(state["step"]), list(state["history"]), dict(state["before"]), int(state["seeded"])


def train(args: argparse.Namespace) -> dict[str, Any]:
    model_path = pathlib.Path(args.model).resolve()
    train_path = pathlib.Path(args.train_data).resolve()
    development_path = pathlib.Path(args.development_data).resolve()
    data_receipt_path = pathlib.Path(args.data_receipt).resolve()
    output = pathlib.Path(args.output).resolve()
    checkpoint_path = output / "run-state.pt"
    final_receipt_path = output / "training-receipt.json"
    if final_receipt_path.exists() and not args.overwrite:
        raise SystemExit(f"completed output already exists: {output}")
    if output.exists() and any(output.iterdir()) and not checkpoint_path.exists() and not args.overwrite:
        raise SystemExit(f"refusing non-empty output directory: {output}")
    output.mkdir(parents=True, exist_ok=True)
    receipt = load_receipt(data_receipt_path)
    train_rows = load_rows(train_path, receipt, "train")
    development_rows = load_rows(development_path, receipt, "development")
    train_commits = {row["commit"] for row in train_rows}
    development_commits = {row["commit"] for row in development_rows}
    if train_commits & development_commits:
        raise SystemExit("Git experience temporal split leaks commit groups")
    device = torch.device(args.device if args.device != "auto" else ("cuda" if torch.cuda.is_available() else "cpu"))
    initial_model_sha256 = sha256_file(model_path)
    payload = torch.load(model_path, map_location=device, weights_only=False)
    if payload.get("schema") != "archie-scratch-hybrid-model/v1":
        raise SystemExit("unsupported Archie model")
    cfg = ModelConfig(**payload["config"])
    tokenizer: ArchieTokenizer = tokenizer_from_metadata(payload.get("tokenizer") or ByteTokenizer.metadata())
    if cfg.vocab_size != tokenizer.vocab_size:
        raise SystemExit("model and tokenizer vocabulary mismatch")
    if args.max_seq_length > cfg.max_seq_len:
        raise SystemExit("training sequence exceeds model maximum")
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(args.seed)
    if device.type == "cuda":
        torch.backends.cuda.matmul.allow_tf32 = args.tf32
        torch.backends.cudnn.allow_tf32 = args.tf32
        torch.cuda.reset_peak_memory_stats(device)
    model = ArchieHybridLM(cfg, gradient_checkpointing=args.gradient_checkpointing).to(device)
    model.load_state_dict(payload["model"])
    train_items = tokenize_rows(tokenizer, train_rows, args.max_seq_length, args.max_target_tokens)
    development_items = tokenize_rows(tokenizer, development_rows, args.max_seq_length, args.max_target_tokens)
    amp_dtype: torch.dtype | None = None
    if device.type == "cuda":
        amp_dtype = torch.float16 if args.amp_dtype in {"auto", "float16"} else torch.bfloat16
    scaler = torch.amp.GradScaler("cuda", enabled=device.type == "cuda" and amp_dtype == torch.float16)
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=args.learning_rate, betas=(0.9, 0.95), eps=1e-8,
        weight_decay=args.weight_decay, fused=device.type == "cuda",
    )
    scheduler = torch.optim.lr_scheduler.LambdaLR(
        optimizer,
        lambda step: min((step + 1) / max(args.warmup_steps, 1), 1.0)
        * (args.min_lr_ratio + (1.0 - args.min_lr_ratio) * 0.5
           * (1.0 + math.cos(math.pi * min(step, args.steps) / max(args.steps, 1)))),
    )
    exchange = CuriosityExchange(
        train_items, args.seed ^ 0xC0FFEE, args.curiosity_exploration,
    )
    history: list[dict[str, Any]] = []
    start_step = 0
    resumed = checkpoint_path.exists() and not args.overwrite
    if resumed:
        start_step, history, before, seeded = load_training_state(
            checkpoint_path, model=model, optimizer=optimizer, scheduler=scheduler,
            scaler=scaler, exchange=exchange, model_sha256=initial_model_sha256,
            data_receipt_digest=receipt["receipt_digest"],
        )
    else:
        before = evaluate(
            model, development_items, device, amp_dtype, args.eval_episodes,
            args.preference_weight, args.causal_margin,
        )
        seeded = seed_curiosity(
            model, exchange, device, amp_dtype,
            min(args.curiosity_seed_episodes, len(train_items)),
            args.preference_weight, args.causal_margin,
        )
        save_training_state(
            checkpoint_path, model=model, optimizer=optimizer, scheduler=scheduler,
            scaler=scaler, exchange=exchange, step=0, history=history, before=before,
            seeded=seeded, model_sha256=initial_model_sha256,
            data_receipt_digest=receipt["receipt_digest"],
        )
    optimizer.zero_grad(set_to_none=True)
    skipped_steps = 0
    start = time.monotonic()
    model.train()
    for step in range(start_step + 1, args.steps + 1):
        total_loss = total_chosen = total_advantage = 0.0
        selected_suffixes: Counter[str] = Counter()
        for _ in range(args.gradient_accumulation):
            index = exchange.choose()
            item = train_items[index]
            inputs, sft_labels, preference_labels = collate_episode(item, device)
            with torch.autocast(device_type=device.type, dtype=amp_dtype, enabled=amp_dtype is not None):
                logits = model(inputs)["logits"]
                loss, metrics = experience_loss(
                    logits, sft_labels, preference_labels,
                    preference_weight=args.preference_weight,
                    causal_margin=args.causal_margin,
                )
                objective = loss / args.gradient_accumulation
            scaler.scale(objective).backward()
            chosen_loss = float(metrics["chosen_nats_per_token"].cpu())
            advantage = float(metrics["causal_advantage"].cpu())
            exchange.observe(index, chosen_loss, advantage)
            total_loss += float(loss.detach().cpu()) / args.gradient_accumulation
            total_chosen += chosen_loss / args.gradient_accumulation
            total_advantage += advantage / args.gradient_accumulation
            selected_suffixes[item["row"]["suffix"]] += 1
        scaler.unscale_(optimizer)
        grad_norm = float(torch.nn.utils.clip_grad_norm_(model.parameters(), args.grad_clip).detach().cpu())
        applied = math.isfinite(grad_norm) and math.isfinite(total_loss)
        if applied:
            scaler.step(optimizer)
        else:
            skipped_steps += 1
        scaler.update()
        optimizer.zero_grad(set_to_none=True)
        scheduler.step()
        record = {
            "step": step, "loss": total_loss,
            "chosen_nats_per_token": total_chosen,
            "causal_advantage": total_advantage,
            "gradient_norm": grad_norm, "step_applied": applied,
            "learning_rate": optimizer.param_groups[0]["lr"],
            "selected_suffixes": dict(sorted(selected_suffixes.items())),
        }
        history.append(record)
        if step % args.log_every == 0 or step == args.steps:
            print(json.dumps(record, sort_keys=True), flush=True)
        if step % args.save_every == 0 or step == args.steps:
            save_training_state(
                checkpoint_path, model=model, optimizer=optimizer, scheduler=scheduler,
                scaler=scaler, exchange=exchange, step=step, history=history,
                before=before, seeded=seeded, model_sha256=initial_model_sha256,
                data_receipt_digest=receipt["receipt_digest"],
            )
    after = evaluate(
        model, development_items, device, amp_dtype, args.eval_episodes,
        args.preference_weight, args.causal_margin,
    )
    export_path = output / "archie-git-experience.pt"
    torch.save({
        "schema": "archie-scratch-hybrid-model/v1", "config": asdict(cfg),
        "model": model.state_dict(), "tokenizer": tokenizer.metadata(),
    }, export_path)
    duration = time.monotonic() - start
    training_receipt = {
        "schema": SCHEMA,
        "method": "real-git-transition-divergence-contrast-with-curiosity-exchange/v2",
        "model": {
            "parameters": parameter_count(model),
            "initialized_from_sha256": initial_model_sha256,
            "export_path": str(export_path),
            "export_sha256": sha256_file(export_path),
            "full_parameter_training": True,
        },
        "data": {
            "receipt_path": str(data_receipt_path),
            "receipt_sha256": sha256_file(data_receipt_path),
            "receipt_digest": receipt["receipt_digest"],
            "train_sha256": sha256_file(train_path),
            "development_sha256": sha256_file(development_path),
            "train_episodes": len(train_items),
            "development_episodes": len(development_items),
            "train_commit_groups": len(train_commits),
            "development_commit_groups": len(development_commits),
            "language_model_generated_rows": 0,
            "causal_event_patch_train_episodes": sum(
                item["row"].get("causal_event_patch") is not None for item in train_items
            ),
            "causal_event_patch_development_episodes": sum(
                item["row"].get("causal_event_patch") is not None
                for item in development_items
            ),
        },
        "objective": {
            "chosen": "exact committed unified diff conditioned on real parent bytes and human commit message",
            "rejected": "unmodified diff from another real commit in the same temporal split",
            "loss": "full chosen-patch cross entropy plus causal contrast only from the first divergent target byte onward",
            "belief_state": "typed causal context is observed before patch prediction; world-after and belief revision remain held-out receipt evidence",
            "preference_weight": args.preference_weight,
            "causal_margin": args.causal_margin,
            "curiosity_seed_episodes": seeded,
            "curiosity_exploration": args.curiosity_exploration,
        },
        "optimization": {
            "steps": args.steps,
            "gradient_accumulation": args.gradient_accumulation,
            "max_seq_length": args.max_seq_length,
            "max_target_tokens": args.max_target_tokens,
            "learning_rate": args.learning_rate,
            "weight_decay": args.weight_decay,
            "skipped_nonfinite_steps": skipped_steps,
            "duration_seconds": duration,
            "resumed": resumed,
            "starting_step": start_step,
            "checkpoint_path": str(checkpoint_path),
            "checkpoint_sha256": sha256_file(checkpoint_path),
            "peak_cuda_bytes": torch.cuda.max_memory_allocated(device) if device.type == "cuda" else 0,
            "history": history,
        },
        "evaluation": {
            "temporal_commit_holdout": True,
            "before": before,
            "after": after,
            "chosen_nats_gain": before["chosen_nats_per_token"] - after["chosen_nats_per_token"],
            "causal_advantage_gain": after["mean_causal_advantage"] - before["mean_causal_advantage"],
            "pair_accuracy_gain": after["pair_accuracy"] - before["pair_accuracy"],
        },
        "curiosity_exchange": exchange.summary(),
        "claim_boundary": "This run measures learning of held-out real repository transitions. It does not establish general intelligence, autonomous software correctness, or safe deployment.",
    }
    training_receipt["receipt_digest"] = digest(training_receipt)
    atomic_json(output / "training-receipt.json", training_receipt)
    return training_receipt


def selftest() -> None:
    with tempfile.TemporaryDirectory() as temporary:
        root = pathlib.Path(temporary)
        model = ArchieHybridLM(ModelConfig(
            d_model=32, n_layers=1, n_heads=4, n_kv_heads=2, d_ff=64,
            ssm_expand=1, ssm_chunk_size=16, attention_every=1,
            attention_window=32, max_seq_len=128,
        ))
        model_path = root / "model.pt"
        torch.save({
            "schema": "archie-scratch-hybrid-model/v1",
            "config": asdict(model.cfg), "model": model.state_dict(),
            "tokenizer": ByteTokenizer.metadata(),
        }, model_path)
        rows: list[dict[str, Any]] = []
        for index in range(8):
            row = {
                "schema": DATA_SCHEMA, "episode_id": f"episode-{index}",
                "commit": f"commit-{index}", "suffix": ".py",
                "new_path": f"module-{index}.py",
                "prompt": f"commit {index}\nbefore value {index}\n",
                "chosen_target": f"+after value {index}\n",
                "rejected_target": f"+after value {(index + 1) % 8}\n",
            }
            row["episode_digest"] = digest(row)
            rows.append(row)
        train_path = root / "train.jsonl"
        dev_path = root / "dev.jsonl"
        for path, selected in ((train_path, rows[:6]), (dev_path, rows[6:])):
            path.write_text("".join(stable(row) + "\n" for row in selected), encoding="utf-8")
        data_body = {
            "schema": DATA_RECEIPT_SCHEMA,
            "artifacts": {
                "train": {"sha256": sha256_file(train_path)},
                "development": {"sha256": sha256_file(dev_path)},
            },
        }
        data_body["receipt_digest"] = digest(data_body)
        data_path = root / "receipt.json"
        atomic_json(data_path, data_body)
        args = argparse.Namespace(
            model=str(model_path), train_data=str(train_path),
            development_data=str(dev_path), data_receipt=str(data_path),
            output=str(root / "out"), overwrite=False, device="cpu", seed=19,
            max_seq_length=96, max_target_tokens=24, gradient_checkpointing=False,
            tf32=False, amp_dtype="auto", learning_rate=1e-3,
            weight_decay=0.0, warmup_steps=1, min_lr_ratio=0.1,
            steps=1, gradient_accumulation=1, preference_weight=0.5,
            causal_margin=0.05, grad_clip=1.0, eval_episodes=2,
            curiosity_seed_episodes=2, log_every=1,
            save_every=1,
            curiosity_exploration=0.15,
        )
        first = train(args)
        assert first["optimization"]["steps"] == 1
        (root / "out" / "training-receipt.json").unlink()
        (root / "out" / "archie-git-experience.pt").unlink()
        args.steps = 2
        receipt = train(args)
        assert receipt["optimization"]["steps"] == 2
        assert receipt["optimization"]["resumed"] is True
        assert receipt["optimization"]["starting_step"] == 1
        assert receipt["data"]["language_model_generated_rows"] == 0
        print(json.dumps({"selftest": "passed", "receipt_digest": receipt["receipt_digest"]}, indent=2, sort_keys=True))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model")
    parser.add_argument("--train-data")
    parser.add_argument("--development-data")
    parser.add_argument("--data-receipt")
    parser.add_argument("--output")
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--seed", type=int, default=3407)
    parser.add_argument("--steps", type=int, default=100)
    parser.add_argument("--gradient-accumulation", type=int, default=4)
    parser.add_argument("--max-seq-length", type=int, default=768)
    parser.add_argument("--max-target-tokens", type=int, default=320)
    parser.add_argument("--learning-rate", type=float, default=3e-5)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--warmup-steps", type=int, default=10)
    parser.add_argument("--min-lr-ratio", type=float, default=0.1)
    parser.add_argument("--preference-weight", type=float, default=0.6)
    parser.add_argument("--causal-margin", type=float, default=0.05)
    parser.add_argument("--grad-clip", type=float, default=1.0)
    parser.add_argument("--eval-episodes", type=int, default=64)
    parser.add_argument("--curiosity-seed-episodes", type=int, default=128)
    parser.add_argument("--curiosity-exploration", type=float, default=0.15)
    parser.add_argument("--gradient-checkpointing", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--tf32", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--amp-dtype", choices=["auto", "float16", "bfloat16"], default="auto")
    parser.add_argument("--log-every", type=int, default=5)
    parser.add_argument("--save-every", type=int, default=10)
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()
    if args.selftest:
        selftest()
        return
    required = ("model", "train_data", "development_data", "data_receipt", "output")
    for name in required:
        if not getattr(args, name):
            parser.error(f"--{name.replace('_', '-')} is required")
    if not 0 <= args.curiosity_exploration <= 1:
        parser.error("--curiosity-exploration must be in [0, 1]")
    for name in ("steps", "gradient_accumulation", "max_seq_length", "max_target_tokens", "eval_episodes", "curiosity_seed_episodes", "save_every"):
        if getattr(args, name) < 1:
            parser.error(f"--{name.replace('_', '-')} must be positive")
    receipt = train(args)
    print(json.dumps({
        "model": receipt["model"], "evaluation": receipt["evaluation"],
        "receipt_digest": receipt["receipt_digest"],
    }, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
