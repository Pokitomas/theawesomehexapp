#!/usr/bin/env python3
"""Train Archie's random-initialized policy from verified agent-teacher trajectories.

The teacher contributes traces, critiques, branch rankings, and verifier returns—not
weights. Generation zero loads no pretrained neural artifact. Successor generations
resume exactly one complete student checkpoint and optimizer state.
"""
from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import pathlib
import random
import time
from dataclasses import dataclass
from typing import Any

import torch
import torch.nn as nn
import torch.nn.functional as F

SCHEMA = "archie-agent-teacher-policy/v1"
RECEIPT_SCHEMA = "archie-agent-teacher-policy-receipt/v1"
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
    embedding_width: int = 96
    hidden_width: int = 256
    recurrent_layers: int = 2
    dropout: float = 0.05
    transition_weight: float = 0.20
    value_weight: float = 0.25
    stop_weight: float = 0.20
    rejection_weight: float = 0.15
    entropy_weight: float = 0.002


class AgentTeacherPolicy(nn.Module):
    """Compact byte-recurrent controller with persistent episode state."""

    def __init__(self, config: Config, action_count: int):
        super().__init__()
        self.config = config
        self.action_count = action_count
        self.byte_embedding = nn.Embedding(VOCAB, config.embedding_width, padding_idx=PAD)
        self.observation_encoder = nn.GRU(
            config.embedding_width, config.hidden_width, batch_first=True
        )
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
        self.apply(self._initialize)

    @staticmethod
    def _initialize(module: nn.Module) -> None:
        if isinstance(module, (nn.Linear, nn.Embedding)):
            nn.init.normal_(module.weight, mean=0.0, std=0.02)
            if isinstance(module, nn.Linear) and module.bias is not None:
                nn.init.zeros_(module.bias)

    def forward(self, observations: torch.Tensor, state=None):
        batch, steps, width = observations.shape
        embedded = self.byte_embedding(observations.reshape(batch * steps, width))
        _, observation_state = self.observation_encoder(embedded)
        encoded = observation_state[-1].reshape(batch, steps, self.config.hidden_width)
        hidden, state = self.policy_core(encoded, state)
        return {
            "logits": self.action_head(hidden),
            "value": self.value_head(hidden).squeeze(-1),
            "stop": self.stop_head(hidden).squeeze(-1),
            "transition": self.transition_head(hidden),
            "encoded": encoded.detach(),
            "state": state,
        }

    @torch.no_grad()
    def act(self, observation: torch.Tensor, state=None) -> dict[str, torch.Tensor]:
        output = self(observation[:, None, :], state)
        probabilities = output["logits"][:, -1].softmax(-1)
        return {
            "action": probabilities.argmax(-1),
            "action_probability": probabilities.max(-1).values,
            "value": output["value"][:, -1],
            "stop_probability": output["stop"][:, -1].sigmoid(),
            "state": output["state"],
        }


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
        teachers = row.get("teacher_agents")
        if not isinstance(teachers, list) or not teachers:
            raise ValueError(f"line {line_number}: non-empty teacher_agents required")
        if not row.get("verifier_digest"):
            raise ValueError(f"line {line_number}: verifier_digest required")
        steps = row.get("steps")
        if not isinstance(steps, list) or not steps:
            raise ValueError(f"line {line_number}: non-empty steps required")
        seen.add(episode_id)
        rows.append(row)
    if len(rows) < 3:
        raise ValueError("at least three verified episodes are required")
    return rows


def action_vocabulary(rows: list[dict[str, Any]]) -> list[str]:
    actions: set[str] = set()
    for row in rows:
        for step in row["steps"]:
            actions.add(str(step["action"]))
            actions.update(str(item) for item in step.get("rejected_actions", []))
    if len(actions) < 2:
        raise ValueError("at least two distinct actions are required")
    return sorted(actions)


def compile_episodes(
    rows: list[dict[str, Any]], config: Config, vocabulary: list[str]
) -> list[dict[str, torch.Tensor]]:
    action_to_id = {action: index for index, action in enumerate(vocabulary)}
    episodes: list[dict[str, torch.Tensor]] = []
    for row in rows:
        observations, actions, returns, stops, confidence = [], [], [], [], []
        rejected = []
        for step in row["steps"]:
            observations.append(encode_bytes(str(step["observation"]), config.observation_width))
            actions.append(action_to_id[str(step["action"])])
            returns.append(float(step.get("return", step.get("value", 0.0))))
            stops.append(float(bool(step.get("stop", False))))
            confidence.append(float(step.get("teacher_confidence", 1.0)))
            rejected_ids = [action_to_id[str(x)] for x in step.get("rejected_actions", [])]
            rejected.append(rejected_ids)
        episodes.append(
            {
                "observation": torch.tensor(observations, dtype=torch.long),
                "action": torch.tensor(actions, dtype=torch.long),
                "return": torch.tensor(returns, dtype=torch.float32),
                "stop": torch.tensor(stops, dtype=torch.float32),
                "confidence": torch.tensor(confidence, dtype=torch.float32),
                "rejected": rejected,
            }
        )
    return episodes


def split_indices(count: int, seed: int) -> tuple[list[int], list[int]]:
    indices = list(range(count))
    random.Random(seed).shuffle(indices)
    held_count = max(1, count // 5)
    return indices[held_count:], indices[:held_count]


def make_batch(episodes, indices, action_count: int, device: torch.device):
    rows = [episodes[index] for index in indices]
    length = max(len(row["action"]) for row in rows)
    batch_size = len(rows)
    width = rows[0]["observation"].shape[-1]
    observation = torch.full((batch_size, length, width), PAD, dtype=torch.long)
    action = torch.zeros((batch_size, length), dtype=torch.long)
    returns = torch.zeros((batch_size, length), dtype=torch.float32)
    stop = torch.zeros((batch_size, length), dtype=torch.float32)
    confidence = torch.zeros((batch_size, length), dtype=torch.float32)
    mask = torch.zeros((batch_size, length), dtype=torch.bool)
    rejected = torch.zeros((batch_size, length, action_count), dtype=torch.bool)
    for row_index, row in enumerate(rows):
        size = len(row["action"])
        observation[row_index, :size] = row["observation"]
        action[row_index, :size] = row["action"]
        returns[row_index, :size] = row["return"]
        stop[row_index, :size] = row["stop"]
        confidence[row_index, :size] = row["confidence"]
        mask[row_index, :size] = True
        for step_index, rejected_ids in enumerate(row["rejected"]):
            if rejected_ids:
                rejected[row_index, step_index, rejected_ids] = True
    return tuple(
        tensor.to(device)
        for tensor in (observation, action, returns, stop, confidence, mask, rejected)
    )


def tensor_digest(model: nn.Module) -> str:
    digest = hashlib.sha256()
    for name, tensor in sorted(model.state_dict().items()):
        digest.update(name.encode("utf-8"))
        digest.update(tensor.detach().cpu().contiguous().numpy().tobytes())
    return digest.hexdigest()


def evaluate(model, episodes, indices, action_count, device):
    model.eval()
    correct = count = 0
    value_error = stop_error = transition_error = 0.0
    with torch.no_grad():
        for index in indices:
            batch = make_batch(episodes, [index], action_count, device)
            observation, action, returns, stop, _, mask, _ = batch
            output = model(observation)
            correct += int(((output["logits"].argmax(-1) == action) & mask).sum())
            count += int(mask.sum())
            value_error += float(((output["value"] - returns).abs() * mask).sum())
            stop_error += float(((output["stop"].sigmoid() - stop).abs() * mask).sum())
            if observation.shape[1] > 1:
                pair_mask = mask[:, :-1] & mask[:, 1:]
                transition_error += float(
                    ((output["transition"][:, :-1] - output["encoded"][:, 1:]).pow(2).mean(-1)
                     * pair_mask).sum()
                )
    denominator = max(1, count)
    return {
        "action_accuracy": correct / denominator,
        "value_mae": value_error / denominator,
        "stop_mae": stop_error / denominator,
        "transition_mse": transition_error / denominator,
        "steps": count,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--episodes", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--parent")
    parser.add_argument("--steps", type=int, default=12000)
    parser.add_argument("--batch", type=int, default=8)
    parser.add_argument("--lr", type=float, default=3e-4)
    parser.add_argument("--seed", type=int, default=730)
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    args = parser.parse_args()

    torch.manual_seed(args.seed)
    random.seed(args.seed)
    config = Config()
    episodes_path = pathlib.Path(args.episodes).resolve()
    rows = read_rows(episodes_path)
    vocabulary = action_vocabulary(rows)
    episodes = compile_episodes(rows, config, vocabulary)
    train_indices, held_indices = split_indices(len(episodes), args.seed)
    device = torch.device(args.device)

    model = AgentTeacherPolicy(config, len(vocabulary)).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
    generation = 0
    parent_file_digest = None
    generation_zero_digest = tensor_digest(model)

    if args.parent:
        parent_path = pathlib.Path(args.parent).resolve()
        payload = torch.load(parent_path, map_location=device, weights_only=False)
        if payload.get("schema") != SCHEMA:
            raise ValueError("parent schema mismatch")
        if payload.get("action_vocabulary") != vocabulary:
            raise ValueError("parent action vocabulary mismatch")
        if payload.get("config") != dataclasses.asdict(config):
            raise ValueError("parent architecture mismatch")
        model.load_state_dict(payload["model"])
        optimizer.load_state_dict(payload["optimizer"])
        if payload.get("checkpoint_tensor_digest") != tensor_digest(model):
            raise ValueError("parent tensor digest mismatch")
        generation = int(payload["generation"]) + 1
        parent_file_digest = sha256_file(parent_path)

    before = evaluate(model, episodes, held_indices, len(vocabulary), device)
    model.train()
    rng = random.Random(args.seed + generation)
    started = time.time()

    for _ in range(args.steps):
        selected = [rng.choice(train_indices) for _ in range(min(args.batch, len(train_indices)))]
        batch = make_batch(episodes, selected, len(vocabulary), device)
        observation, action, returns, stop, confidence, mask, rejected = batch
        output = model(observation)

        log_probabilities = output["logits"].log_softmax(-1)
        chosen_log_probability = log_probabilities.gather(-1, action.unsqueeze(-1)).squeeze(-1)
        advantage = (returns - output["value"].detach()).clamp(-2.0, 2.0)
        weights = confidence.clamp(0.0, 1.0) * advantage.exp().clamp(max=6.0)
        action_loss = -(chosen_log_probability[mask] * weights[mask]).mean()
        value_loss = F.smooth_l1_loss(output["value"][mask], returns[mask])
        stop_loss = F.binary_cross_entropy_with_logits(output["stop"][mask], stop[mask])

        rejected_mask = rejected & mask.unsqueeze(-1)
        if rejected_mask.any():
            rejected_logits = output["logits"].masked_fill(~rejected_mask, float("-inf")).max(-1).values
            chosen_logits = output["logits"].gather(-1, action.unsqueeze(-1)).squeeze(-1)
            contrastive_mask = rejected_mask.any(-1)
            rejection_loss = F.relu(1.0 - chosen_logits[contrastive_mask] + rejected_logits[contrastive_mask]).mean()
        else:
            rejection_loss = output["logits"].sum() * 0.0

        if observation.shape[1] > 1:
            transition_mask = mask[:, :-1] & mask[:, 1:]
            transition_loss = F.mse_loss(
                output["transition"][:, :-1][transition_mask],
                output["encoded"][:, 1:][transition_mask],
            ) if transition_mask.any() else output["transition"].sum() * 0.0
        else:
            transition_loss = output["transition"].sum() * 0.0

        probabilities = output["logits"].softmax(-1)
        entropy = -(probabilities * log_probabilities).sum(-1)[mask].mean()
        loss = (
            action_loss
            + config.value_weight * value_loss
            + config.stop_weight * stop_loss
            + config.transition_weight * transition_loss
            + config.rejection_weight * rejection_loss
            - config.entropy_weight * entropy
        )
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()

    after = evaluate(model, episodes, held_indices, len(vocabulary), device)
    output_path = pathlib.Path(args.output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    checkpoint_digest = tensor_digest(model)
    teacher_lineage_digest = sha256_bytes(
        stable([row["teacher_agents"] for row in rows]).encode("utf-8")
    )
    payload = {
        "schema": SCHEMA,
        "generation": generation,
        "config": dataclasses.asdict(config),
        "action_vocabulary": vocabulary,
        "model": model.state_dict(),
        "optimizer": optimizer.state_dict(),
        "seed": args.seed,
        "generation_zero_random_tensor_digest": generation_zero_digest,
        "parent_file_sha256": parent_file_digest,
        "checkpoint_tensor_digest": checkpoint_digest,
        "teacher_lineage_digest": teacher_lineage_digest,
    }
    torch.save(payload, output_path)
    receipt = {
        "schema": RECEIPT_SCHEMA,
        "generation": generation,
        "episodes_sha256": sha256_file(episodes_path),
        "teacher_lineage_digest": teacher_lineage_digest,
        "action_vocabulary_sha256": sha256_bytes(stable(vocabulary).encode("utf-8")),
        "parent_file_sha256": parent_file_digest,
        "generation_zero_random_tensor_digest": generation_zero_digest,
        "checkpoint_tensor_digest": checkpoint_digest,
        "checkpoint_file_sha256": sha256_file(output_path),
        "device": str(device),
        "cuda_device": torch.cuda.get_device_name(device) if device.type == "cuda" else None,
        "gpu_seconds": time.time() - started if device.type == "cuda" else 0.0,
        "wall_seconds": time.time() - started,
        "train_episodes": len(train_indices),
        "held_out_episodes": len(held_indices),
        "before": before,
        "after": after,
        "promotion": "research-only-not-admitted",
    }
    receipt_path = output_path.with_suffix(output_path.suffix + ".receipt.json")
    receipt_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(stable(receipt))


if __name__ == "__main__":
    main()
