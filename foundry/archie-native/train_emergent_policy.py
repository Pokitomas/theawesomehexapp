#!/usr/bin/env python3
"""Train a compact from-scratch policy on verified Archie trajectories.

This lane is optimized for local iteration: a parallel byte-convolution encoder
replaces the older per-observation GRU, while a causal episode GRU preserves
pursuit state across steps. Every run emits a checkpoint and evidence receipt.
"""
from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import math
import pathlib
import random
import re
import time
from dataclasses import dataclass
from typing import Any

import torch
import torch.nn as nn
import torch.nn.functional as F

SCHEMA = "archie-emergent-policy/v1"
RECEIPT_SCHEMA = "archie-emergent-policy-receipt/v1"
PAD = 256
VOCAB = 257


def stable(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: pathlib.Path) -> str:
    return sha256_bytes(path.read_bytes())


def encode_bytes(text: str, width: int) -> list[int]:
    tokens = list(text.encode("utf-8", errors="replace"))[-width:]
    return [PAD] * (width - len(tokens)) + tokens


@dataclass(frozen=True)
class Config:
    observation_width: int = 384
    embedding_width: int = 64
    convolution_channels: int = 128
    hidden_width: int = 384
    recurrent_layers: int = 2
    dropout: float = 0.08
    label_smoothing: float = 0.02
    value_weight: float = 0.10
    stop_weight: float = 0.10
    rejection_weight: float = 0.15
    transition_weight: float = 0.05
    counterfactual_weight: float = 0.15
    use_counterfactual_head: bool = False


class ByteConvEncoder(nn.Module):
    def __init__(self, config: Config):
        super().__init__()
        self.embedding = nn.Embedding(VOCAB, config.embedding_width, padding_idx=PAD)
        self.branches = nn.ModuleList(
            nn.Sequential(
                nn.Conv1d(
                    config.embedding_width,
                    config.convolution_channels,
                    kernel_size,
                    padding=kernel_size // 2,
                ),
                nn.GELU(),
                nn.Conv1d(config.convolution_channels, config.convolution_channels, 1),
                nn.GELU(),
            )
            for kernel_size in (3, 5, 9)
        )
        pooled_width = config.convolution_channels * len(self.branches) * 2
        self.project = nn.Sequential(
            nn.Linear(pooled_width, config.hidden_width),
            nn.LayerNorm(config.hidden_width),
            nn.GELU(),
            nn.Dropout(config.dropout),
        )

    def forward(self, observations: torch.Tensor) -> torch.Tensor:
        mask = observations.ne(PAD).unsqueeze(1)
        valid = mask.any(-1)
        embedded = self.embedding(observations).transpose(1, 2)
        pooled = []
        denominator = mask.sum(-1).clamp_min(1)
        for branch in self.branches:
            features = branch(embedded)
            maximum = features.masked_fill(~mask, torch.finfo(features.dtype).min).amax(-1)
            maximum = torch.where(valid, maximum, torch.zeros_like(maximum))
            mean = (features * mask).sum(-1) / denominator
            pooled.extend((maximum, mean))
        return self.project(torch.cat(pooled, dim=-1))


class EmergentPolicy(nn.Module):
    def __init__(self, config: Config, action_count: int):
        super().__init__()
        self.config = config
        self.action_count = action_count
        self.observation_encoder = ByteConvEncoder(config)
        self.policy_core = nn.GRU(
            config.hidden_width,
            config.hidden_width,
            config.recurrent_layers,
            batch_first=True,
            dropout=config.dropout if config.recurrent_layers > 1 else 0.0,
        )
        self.action_head = nn.Linear(config.hidden_width, action_count)
        self.value_head = nn.Linear(config.hidden_width, 1)
        self.stop_head = nn.Linear(config.hidden_width, 1)
        self.transition_head = nn.Linear(config.hidden_width, config.hidden_width)
        self.action_value_head = (
            nn.Linear(config.hidden_width, action_count)
            if config.use_counterfactual_head else None
        )
        self.apply(self._initialize)

    @staticmethod
    def _initialize(module: nn.Module) -> None:
        if isinstance(module, (nn.Linear, nn.Conv1d, nn.Embedding)):
            nn.init.normal_(module.weight, mean=0.0, std=0.02)
            if getattr(module, "bias", None) is not None:
                nn.init.zeros_(module.bias)

    def forward(self, observations: torch.Tensor, state=None) -> dict[str, torch.Tensor]:
        batch, steps, width = observations.shape
        encoded = self.observation_encoder(observations.reshape(batch * steps, width))
        encoded = encoded.reshape(batch, steps, self.config.hidden_width)
        hidden, state = self.policy_core(encoded, state)
        result = {
            "logits": self.action_head(hidden),
            "value": self.value_head(hidden).squeeze(-1),
            "stop": self.stop_head(hidden).squeeze(-1),
            "transition": self.transition_head(hidden),
            "encoded": encoded,
            "state": state,
        }
        if self.action_value_head is not None:
            result["action_value"] = self.action_value_head(hidden)
        return result


def read_rows(path: pathlib.Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for line_number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not raw.strip():
            continue
        row = json.loads(raw)
        episode_id = str(row.get("episode_id", ""))
        if not episode_id or episode_id in seen:
            raise ValueError(f"line {line_number}: unique episode_id required")
        if row.get("verified") is not True:
            raise ValueError(f"line {line_number}: verified=true required")
        if not isinstance(row.get("teacher_agents"), list) or not row["teacher_agents"]:
            raise ValueError(f"line {line_number}: non-empty teacher_agents required")
        if not row.get("verifier_digest"):
            raise ValueError(f"line {line_number}: verifier_digest required")
        if not isinstance(row.get("steps"), list) or not row["steps"]:
            raise ValueError(f"line {line_number}: non-empty steps required")
        for step_index, step in enumerate(row["steps"]):
            for score_name in ("return", "value"):
                if score_name in step and (
                    isinstance(step[score_name], bool)
                    or not isinstance(step[score_name], (int, float))
                    or not math.isfinite(float(step[score_name]))
                ):
                    raise ValueError(
                        f"line {line_number} step {step_index}: {score_name} must be finite"
                    )
            for map_name in ("objective_components", "objective_weights"):
                if map_name not in step:
                    continue
                values = step[map_name]
                if not isinstance(values, dict) or not values:
                    raise ValueError(
                        f"line {line_number} step {step_index}: {map_name} must be non-empty"
                    )
                for name, value in values.items():
                    if (
                        not str(name).strip() or isinstance(value, bool)
                        or not isinstance(value, (int, float))
                        or not math.isfinite(float(value))
                    ):
                        raise ValueError(
                            f"line {line_number} step {step_index}: invalid {map_name} entry"
                        )
                    if map_name == "objective_components" and not -1.0 <= float(value) <= 1.0:
                        raise ValueError(
                            f"line {line_number} step {step_index}: objective component out of range"
                        )
                    if map_name == "objective_weights" and float(value) < 0.0:
                        raise ValueError(
                            f"line {line_number} step {step_index}: objective weight is negative"
                        )
            counterfactuals = step.get("counterfactuals", [])
            if not isinstance(counterfactuals, list):
                raise ValueError(
                    f"line {line_number} step {step_index}: counterfactuals must be a list"
                )
            for counterfactual in counterfactuals:
                if counterfactual.get("verified") is not True:
                    raise ValueError(
                        f"line {line_number} step {step_index}: counterfactual must be verified"
                    )
                if not counterfactual.get("action") or "return" not in counterfactual:
                    raise ValueError(
                        f"line {line_number} step {step_index}: action and return required"
                    )
                if (
                    isinstance(counterfactual["return"], bool)
                    or not isinstance(counterfactual["return"], (int, float))
                    or not math.isfinite(float(counterfactual["return"]))
                ):
                    raise ValueError(
                        f"line {line_number} step {step_index}: counterfactual return must be finite"
                    )
                components = counterfactual.get("objective_components")
                if components is not None and (
                    not isinstance(components, dict) or not components
                    or any(
                        isinstance(value, bool) or not isinstance(value, (int, float))
                        or not math.isfinite(float(value)) or not -1.0 <= float(value) <= 1.0
                        for value in components.values()
                    )
                ):
                    raise ValueError(
                        f"line {line_number} step {step_index}: invalid counterfactual objectives"
                    )
                if not re.fullmatch(
                    r"[0-9a-f]{64}", str(counterfactual.get("receipt_digest", ""))
                ):
                    raise ValueError(
                        f"line {line_number} step {step_index}: receipt_digest required"
                    )
        seen.add(episode_id)
        rows.append(row)
    if len(rows) < 3:
        raise ValueError("at least three verified episodes are required")
    return rows


def action_vocabulary(rows: list[dict[str, Any]]) -> list[str]:
    actions = {
        str(action)
        for row in rows
        for step in row["steps"]
        for action in [
            step["action"], *step.get("rejected_actions", []),
            *(item["action"] for item in step.get("counterfactuals", [])),
        ]
    }
    if len(actions) < 2:
        raise ValueError("at least two distinct actions are required")
    return sorted(actions)


def compile_episodes(rows, config: Config, vocabulary: list[str]):
    action_to_id = {action: index for index, action in enumerate(vocabulary)}
    episodes = []
    for row in rows:
        observations, actions, targets = [], [], []
        returns, stops, confidence, rejected, counterfactuals = [], [], [], [], []
        for step in row["steps"]:
            observations.append(encode_bytes(str(step["observation"]), config.observation_width))
            actions.append(action_to_id[str(step["action"])])
            chosen_return = float(step.get("return", step.get("value", 0.0)))
            returns.append(chosen_return)
            stops.append(float(bool(step.get("stop", False))))
            confidence.append(float(step.get("teacher_confidence", 1.0)))
            rejected.append([action_to_id[str(item)] for item in step.get("rejected_actions", [])])
            measured = [(actions[-1], chosen_return)]
            alternatives = []
            for counterfactual in step.get("counterfactuals", []):
                action_id = action_to_id[str(counterfactual["action"])]
                action_return = float(counterfactual["return"])
                alternatives.append((action_id, action_return))
                measured.append((action_id, action_return))
            counterfactuals.append(alternatives)
            targets.append(max(measured, key=lambda item: (item[1], -item[0]))[0])
        episodes.append(
            {
                "observation": torch.tensor(observations, dtype=torch.long),
                "action": torch.tensor(actions, dtype=torch.long),
                "target": torch.tensor(targets, dtype=torch.long),
                "return": torch.tensor(returns, dtype=torch.float32),
                "stop": torch.tensor(stops, dtype=torch.float32),
                "confidence": torch.tensor(confidence, dtype=torch.float32),
                "rejected": rejected,
                "counterfactuals": counterfactuals,
                "repository_id": str(row.get("repository_id") or ""),
                "mechanism_id": str(row.get("mechanism_id") or ""),
                "task_family": str(row.get("task_family") or ""),
                "episode_id": str(row["episode_id"]),
            }
        )
    return episodes


def split_indices(
    episodes: list[dict[str, Any]], seed: int, requested_axis: str,
) -> tuple[list[int], list[int], dict[str, Any]]:
    if requested_axis != "auto" and any(
        not str(episode.get(requested_axis, "")).strip() for episode in episodes
    ):
        raise ValueError(f"every episode must define requested holdout axis {requested_axis}")
    axes = [requested_axis] if requested_axis != "auto" else [
        "repository_id", "mechanism_id", "task_family", "episode_id"
    ]
    axis = "episode_id"
    for candidate in axes:
        values = {episode.get(candidate, "") for episode in episodes}
        values.discard("")
        minimum_groups = 2 if requested_axis != "auto" else 3
        if len(values) >= minimum_groups:
            axis = candidate
            break
    groups: dict[str, list[int]] = {}
    for index, episode in enumerate(episodes):
        group = str(episode.get(axis) or episode["episode_id"])
        groups.setdefault(group, []).append(index)
    names = sorted(groups)
    random.Random(seed).shuffle(names)
    held_count = max(1, len(names) // 5)
    held_names = set(names[:held_count])
    held = [index for name in names if name in held_names for index in groups[name]]
    train = [index for name in names if name not in held_names for index in groups[name]]
    if not train or not held:
        raise ValueError("grouped split requires non-empty training and held-out groups")
    return train, held, {
        "axis": axis,
        "train_groups": sorted(set(names) - held_names),
        "held_out_groups": sorted(held_names),
    }


def make_batch(episodes, indices, action_count: int, device: torch.device):
    rows = [episodes[index] for index in indices]
    length = max(len(row["action"]) for row in rows)
    batch_size, width = len(rows), rows[0]["observation"].shape[-1]
    observation = torch.full((batch_size, length, width), PAD, dtype=torch.long)
    action = torch.zeros((batch_size, length), dtype=torch.long)
    target = torch.zeros((batch_size, length), dtype=torch.long)
    returns = torch.zeros((batch_size, length), dtype=torch.float32)
    stop = torch.zeros((batch_size, length), dtype=torch.float32)
    confidence = torch.zeros((batch_size, length), dtype=torch.float32)
    mask = torch.zeros((batch_size, length), dtype=torch.bool)
    rejected = torch.zeros((batch_size, length, action_count), dtype=torch.bool)
    action_returns = torch.zeros((batch_size, length, action_count), dtype=torch.float32)
    action_return_mask = torch.zeros((batch_size, length, action_count), dtype=torch.bool)
    for row_index, row in enumerate(rows):
        size = len(row["action"])
        observation[row_index, :size] = row["observation"]
        action[row_index, :size] = row["action"]
        target[row_index, :size] = row["target"]
        returns[row_index, :size] = row["return"]
        stop[row_index, :size] = row["stop"]
        confidence[row_index, :size] = row["confidence"]
        mask[row_index, :size] = True
        for step_index, rejected_ids in enumerate(row["rejected"]):
            if rejected_ids:
                rejected[row_index, step_index, rejected_ids] = True
        for step_index, (chosen, chosen_return) in enumerate(
            zip(row["action"], row["return"])
        ):
            action_returns[row_index, step_index, int(chosen)] = float(chosen_return)
            action_return_mask[row_index, step_index, int(chosen)] = True
            for alternative, alternative_return in row["counterfactuals"][step_index]:
                action_returns[row_index, step_index, alternative] = alternative_return
                action_return_mask[row_index, step_index, alternative] = True
    return tuple(
        tensor.to(device, non_blocking=device.type == "cuda")
        for tensor in (
            observation, action, target, returns, stop, confidence, mask, rejected,
            action_returns, action_return_mask,
        )
    )


@torch.no_grad()
def evaluate(model, episodes, indices, action_count, device, batch_size=64):
    model.eval()
    correct = behavior_correct = count = 0
    value_error = stop_error = action_value_error = action_value_count = 0.0
    margins = []
    for start in range(0, len(indices), batch_size):
        batch = make_batch(episodes, indices[start : start + batch_size], action_count, device)
        (
            observation, action, target, returns, stop, _, mask, rejected,
            action_returns, action_return_mask,
        ) = batch
        output = model(observation)
        logits = output["logits"]
        correct += int(((logits.argmax(-1) == target) & mask).sum())
        behavior_correct += int(((logits.argmax(-1) == action) & mask).sum())
        count += int(mask.sum())
        optimal_returns = action_returns.masked_fill(~action_return_mask, float("-inf")).max(-1).values
        value_error += float((output["value"][mask] - optimal_returns[mask]).abs().sum())
        stop_error += float((output["stop"].sigmoid()[mask] - stop[mask]).abs().sum())
        if "action_value" in output and action_return_mask.any():
            action_value_error += float(
                (output["action_value"] - action_returns).abs()[action_return_mask].sum()
            )
            action_value_count += int(action_return_mask.sum())
        rejected_mask = rejected & mask.unsqueeze(-1)
        contrastive = rejected_mask.any(-1)
        if contrastive.any():
            rejected_logits = logits.masked_fill(~rejected_mask, float("-inf")).max(-1).values
            chosen_logits = logits.gather(-1, target.unsqueeze(-1)).squeeze(-1)
            margins.extend((chosen_logits[contrastive] - rejected_logits[contrastive]).cpu().tolist())
    denominator = max(1, count)
    return {
        "action_accuracy": correct / denominator,
        "behavior_action_accuracy": behavior_correct / denominator,
        "value_mae": value_error / denominator,
        "counterfactual_value_mae": (
            action_value_error / action_value_count if action_value_count else None
        ),
        "stop_mae": stop_error / denominator,
        "mean_rejection_margin": sum(margins) / max(1, len(margins)),
        "steps": count,
    }


PARAPHRASE_CASES = {
    "inspect_repository_state": [
        "Establish the checked-out revision and dirty-tree state before touching code.",
        "First determine the repository head, branch, and authority status.",
    ],
    "read_relevant_file": [
        "The implementation path is known; open that exact source for evidence.",
        "Read the named file because its precise contents are required.",
    ],
    "search_repository": [
        "The behavior's location is unknown, so locate references across the repository.",
        "Search the codebase to discover which module owns this feature.",
    ],
    "run_contract_tests": [
        "Executable invariants must be checked after the trainer changed.",
        "Run the narrow contract suite to verify this implementation.",
    ],
    "patch_training_lane": [
        "Implement the missing evidence-producing behavior in the training lane.",
        "The authorized trainer needs a code correction before it can run.",
    ],
    "dispatch_training": [
        "The sealed curriculum and runnable trainer are ready; start the bounded run.",
        "Launch training now that inputs, worker, and limits are verified.",
    ],
    "inspect_training_receipt": [
        "Training finished; inspect metrics, hashes, and hardware identity.",
        "Review the returned receipt before making any model claim.",
    ],
    "synthesize_corrective_curriculum": [
        "Failures cluster at one boundary; create targeted corrective examples.",
        "Build a focused curriculum from the frozen evaluation errors.",
    ],
    "continue_from_parent": [
        "Resume from the valid parent checkpoint and optimizer state.",
        "Continue the next generation using the verified predecessor artifact.",
    ],
    "stop_without_claim": [
        "No numerical evidence exists, so stop rather than assert capability.",
        "Do not continue or claim success without a verified receipt.",
    ],
}


@torch.no_grad()
def evaluate_paraphrases(model, vocabulary, config: Config, device):
    action_to_id = {action: index for index, action in enumerate(vocabulary)}
    cases = [
        (text, action_to_id[action])
        for action, texts in PARAPHRASE_CASES.items()
        if action in action_to_id
        for text in texts
    ]
    if not cases:
        return {"examples": 0, "action_accuracy": None}
    observations = torch.tensor(
        [[encode_bytes(text, config.observation_width)] for text, _ in cases],
        dtype=torch.long,
        device=device,
    )
    expected = torch.tensor([action for _, action in cases], device=device)
    probabilities = model(observations)["logits"][:, 0].softmax(-1)
    confidence, predicted = probabilities.max(-1)
    errors = [
        {
            "text": cases[index][0],
            "expected": vocabulary[int(expected[index])],
            "actual": vocabulary[int(predicted[index])],
            "confidence": float(confidence[index].cpu()),
        }
        for index in range(len(cases))
        if int(predicted[index]) != int(expected[index])
    ]
    return {
        "examples": len(cases),
        "action_accuracy": float(predicted.eq(expected).float().mean().cpu()),
        "errors": errors,
    }


def tensor_digest(model: nn.Module) -> str:
    digest = hashlib.sha256()
    for name, tensor in sorted(model.state_dict().items()):
        digest.update(name.encode("utf-8"))
        digest.update(tensor.detach().cpu().contiguous().numpy().tobytes())
    return digest.hexdigest()


def cosine_rate(step: int, total: int, warmup: int, peak: float) -> float:
    if step < warmup:
        return peak * (step + 1) / max(1, warmup)
    progress = (step - warmup) / max(1, total - warmup)
    return peak * (0.08 + 0.92 * 0.5 * (1.0 + math.cos(math.pi * min(1.0, progress))))


def train(args: argparse.Namespace) -> dict[str, Any]:
    torch.manual_seed(args.seed)
    random.seed(args.seed)
    torch.set_num_threads(args.threads)
    episodes_path = pathlib.Path(args.episodes).resolve()
    rows = read_rows(episodes_path)
    has_counterfactuals = any(
        step.get("counterfactuals") for row in rows for step in row["steps"]
    )
    use_counterfactual_head = (
        has_counterfactuals if args.counterfactual_head is None else args.counterfactual_head
    )
    config = dataclasses.replace(
        Config(), use_counterfactual_head=use_counterfactual_head
    )
    vocabulary = action_vocabulary(rows)
    episodes = compile_episodes(rows, config, vocabulary)
    train_indices, held_indices, split = split_indices(
        episodes, args.seed, args.holdout_axis
    )
    device = torch.device(
        args.device if args.device != "auto" else ("cuda" if torch.cuda.is_available() else "cpu")
    )
    if device.type == "cuda":
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
    model = EmergentPolicy(config, len(vocabulary)).to(device)
    optimizer = torch.optim.AdamW(
        model.parameters(), lr=args.lr, betas=(0.9, 0.95), weight_decay=args.weight_decay
    )
    before = evaluate(model, episodes, held_indices, len(vocabulary), device)
    before_paraphrase = evaluate_paraphrases(model, vocabulary, config, device)
    rng = random.Random(args.seed)
    started = time.monotonic()
    history = []
    best_accuracy = -1.0
    best_loss = float("inf")
    best_state = None
    warmup = max(1, int(args.steps * 0.05))
    for step in range(args.steps):
        model.train()
        selected = [rng.choice(train_indices) for _ in range(min(args.batch, len(train_indices)))]
        (
            observation, action, target, returns, stop, confidence, mask, rejected,
            action_returns, action_return_mask,
        ) = make_batch(
            episodes, selected, len(vocabulary), device
        )
        output = model(observation)
        logits = output["logits"]
        action_elementwise = F.cross_entropy(
            logits[mask], target[mask], reduction="none", label_smoothing=config.label_smoothing
        )
        action_weights = confidence[mask].clamp(0.25, 1.0)
        action_loss = (action_elementwise * action_weights).sum() / action_weights.sum()
        optimal_returns = action_returns.masked_fill(
            ~action_return_mask, float("-inf")
        ).max(-1).values
        value_loss = F.smooth_l1_loss(output["value"][mask], optimal_returns[mask])
        stop_loss = F.binary_cross_entropy_with_logits(output["stop"][mask], stop[mask])
        rejected_mask = rejected & mask.unsqueeze(-1)
        contrastive = rejected_mask.any(-1)
        if contrastive.any():
            rejected_logits = logits.masked_fill(~rejected_mask, float("-inf")).max(-1).values
            chosen_logits = logits.gather(-1, target.unsqueeze(-1)).squeeze(-1)
            rejection_loss = F.relu(1.0 - chosen_logits[contrastive] + rejected_logits[contrastive]).mean()
        else:
            rejection_loss = logits.sum() * 0.0
        if "action_value" in output and action_return_mask.any():
            counterfactual_loss = F.smooth_l1_loss(
                output["action_value"][action_return_mask],
                action_returns[action_return_mask],
            )
        else:
            counterfactual_loss = logits.sum() * 0.0
        if observation.shape[1] > 1:
            transition_mask = mask[:, :-1] & mask[:, 1:]
            if transition_mask.any():
                transition_loss = F.smooth_l1_loss(
                    output["transition"][:, :-1][transition_mask],
                    output["encoded"][:, 1:][transition_mask].detach(),
                )
            else:
                transition_loss = logits.sum() * 0.0
        else:
            transition_loss = logits.sum() * 0.0
        loss = (
            action_loss
            + config.value_weight * value_loss
            + config.stop_weight * stop_loss
            + config.rejection_weight * rejection_loss
            + config.transition_weight * transition_loss
            + config.counterfactual_weight * counterfactual_loss
        )
        rate = cosine_rate(step, args.steps, warmup, args.lr)
        for group in optimizer.param_groups:
            group["lr"] = rate
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        gradient_norm = float(torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0).cpu())
        optimizer.step()
        if step == 0 or (step + 1) % args.eval_every == 0 or step + 1 == args.steps:
            held = evaluate(model, episodes, held_indices, len(vocabulary), device)
            record = {
                "step": step + 1,
                "loss": float(loss.detach().cpu()),
                "action_loss": float(action_loss.detach().cpu()),
                "counterfactual_loss": float(counterfactual_loss.detach().cpu()),
                "gradient_norm": gradient_norm,
                "learning_rate": rate,
                "held_out": held,
            }
            history.append(record)
            print(stable(record), flush=True)
            score = held["action_accuracy"]
            if score > best_accuracy or (score == best_accuracy and record["loss"] < best_loss):
                best_accuracy = score
                best_loss = record["loss"]
                best_state = {name: tensor.detach().cpu().clone() for name, tensor in model.state_dict().items()}
            model.train()
    if best_state is None:
        raise RuntimeError("training produced no evaluated checkpoint")
    model.load_state_dict(best_state)
    after = evaluate(model, episodes, held_indices, len(vocabulary), device)
    paraphrase = evaluate_paraphrases(model, vocabulary, config, device)
    output_path = pathlib.Path(args.output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema": SCHEMA,
        "config": dataclasses.asdict(config),
        "action_vocabulary": vocabulary,
        "model": model.state_dict(),
        "seed": args.seed,
        "checkpoint_tensor_digest": tensor_digest(model),
    }
    torch.save(payload, output_path)
    parameters = sum(parameter.numel() for parameter in model.parameters())
    receipt = {
        "schema": RECEIPT_SCHEMA,
        "episodes_sha256": sha256_file(episodes_path),
        "checkpoint_file_sha256": sha256_file(output_path),
        "checkpoint_tensor_digest": payload["checkpoint_tensor_digest"],
        "action_vocabulary": vocabulary,
        "model": {"parameters": parameters, "config": dataclasses.asdict(config)},
        "optimization": {
            "seed": args.seed,
            "steps": args.steps,
            "batch": args.batch,
            "learning_rate": args.lr,
            "weight_decay": args.weight_decay,
            "best_held_out_accuracy": best_accuracy,
            "history": history,
        },
        "runtime": {
            "device": str(device),
            "cuda_device": torch.cuda.get_device_name(device) if device.type == "cuda" else None,
            "torch": torch.__version__,
            "threads": torch.get_num_threads(),
            "wall_seconds": time.monotonic() - started,
        },
        "data": {
            "episodes": len(episodes),
            "train_episodes": len(train_indices),
            "held_out_episodes": len(held_indices),
            "steps": sum(len(episode["action"]) for episode in episodes),
            "counterfactual_outcomes": sum(
                len(alternatives)
                for episode in episodes for alternatives in episode["counterfactuals"]
            ),
            "objective_dimensions": sorted({
                str(name)
                for row in rows for step in row["steps"]
                for name in step.get("objective_components", {})
            }),
            "holdout": split,
        },
        "before": before,
        "after": after,
        "paraphrase_before": before_paraphrase,
        "paraphrase_after": paraphrase,
        "promotion": "research-only-not-admitted",
        "claim_boundary": "Measures action selection on a procedural curriculum and a small hand-written paraphrase probe; it is not evidence of general intelligence.",
    }
    receipt_path = output_path.with_suffix(output_path.suffix + ".receipt.json")
    receipt_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2, sort_keys=True))
    return receipt


def selftest() -> None:
    config = dataclasses.replace(
        Config(), observation_width=64, embedding_width=16, convolution_channels=16, hidden_width=32
    )
    model = EmergentPolicy(config, 5)
    observations = torch.randint(0, 256, (3, 4, config.observation_width))
    observations[0, -1].fill_(PAD)
    output = model(observations)
    assert output["logits"].shape == (3, 4, 5)
    assert torch.isfinite(output["logits"]).all()
    loss = output["logits"].square().mean() + output["value"].square().mean()
    loss.backward()
    assert sum(parameter.grad is not None for parameter in model.parameters()) > 10
    print(stable({"selftest": "passed", "parameters": sum(p.numel() for p in model.parameters())}))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--episodes")
    parser.add_argument("--output")
    parser.add_argument("--steps", type=int, default=600)
    parser.add_argument("--batch", type=int, default=32)
    parser.add_argument("--lr", type=float, default=8e-4)
    parser.add_argument("--weight-decay", type=float, default=0.02)
    parser.add_argument("--eval-every", type=int, default=25)
    parser.add_argument("--seed", type=int, default=730)
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--device", default="auto")
    parser.add_argument(
        "--counterfactual-head", action=argparse.BooleanOptionalAction, default=None
    )
    parser.add_argument(
        "--holdout-axis",
        choices=["auto", "repository_id", "mechanism_id", "task_family", "episode_id"],
        default="auto",
    )
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()
    if args.selftest:
        selftest()
        return
    if not args.episodes or not args.output:
        parser.error("--episodes and --output are required unless --selftest is used")
    train(args)


if __name__ == "__main__":
    main()
