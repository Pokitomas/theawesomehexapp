#!/usr/bin/env python3
"""Train a scratch-initialized recurrent neural policy from agent trajectories."""
from __future__ import annotations

import argparse
import json
import math
import os
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import torch
from torch import nn
from torch.nn import functional as F


@dataclass(frozen=True)
class Transition:
    observation: list[int]
    action: int
    reward: float
    done: bool


def load_transitions(path: Path) -> list[Transition]:
    rows: list[Transition] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            raw = json.loads(line)
            required = {"episode_id", "step", "observation_tokens", "action_token", "reward", "done"}
            missing = sorted(required - raw.keys())
            if missing:
                raise ValueError(f"line {line_number}: missing {missing}")
            rows.append(
                Transition(
                    observation=[int(x) for x in raw["observation_tokens"]],
                    action=int(raw["action_token"]),
                    reward=float(raw["reward"]),
                    done=bool(raw["done"]),
                )
            )
    if not rows:
        raise ValueError("teacher corpus is empty")
    return rows


class RootlessPolicy(nn.Module):
    def __init__(self, vocab_size: int, hidden_size: int, action_vocab_size: int, layers: int) -> None:
        super().__init__()
        self.embedding = nn.Embedding(vocab_size, hidden_size)
        self.encoder = nn.GRU(hidden_size, hidden_size, num_layers=layers, batch_first=True)
        self.state_gate = nn.Sequential(nn.Linear(hidden_size, hidden_size), nn.SiLU(), nn.Linear(hidden_size, hidden_size))
        self.action_head = nn.Linear(hidden_size, action_vocab_size)
        self.value_head = nn.Linear(hidden_size, 1)

    def forward(self, tokens: torch.Tensor, lengths: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        embedded = self.embedding(tokens)
        packed = nn.utils.rnn.pack_padded_sequence(embedded, lengths.cpu(), batch_first=True, enforce_sorted=False)
        _, state = self.encoder(packed)
        latent = state[-1]
        latent = latent + self.state_gate(latent)
        return self.action_head(latent), self.value_head(latent).squeeze(-1), latent


def batches(rows: list[Transition], batch_size: int, pad_id: int, device: torch.device) -> Iterable[tuple[torch.Tensor, ...]]:
    order = list(range(len(rows)))
    random.shuffle(order)
    for start in range(0, len(order), batch_size):
        selected = [rows[index] for index in order[start : start + batch_size]]
        lengths = torch.tensor([max(1, len(row.observation)) for row in selected], dtype=torch.long)
        width = int(lengths.max().item())
        tokens = torch.full((len(selected), width), pad_id, dtype=torch.long)
        for index, row in enumerate(selected):
            values = row.observation or [pad_id]
            tokens[index, : len(values)] = torch.tensor(values, dtype=torch.long)
        actions = torch.tensor([row.action for row in selected], dtype=torch.long)
        rewards = torch.tensor([row.reward for row in selected], dtype=torch.float32)
        yield tokens.to(device), lengths.to(device), actions.to(device), rewards.to(device)


def save_checkpoint(path: Path, model: nn.Module, optimizer: torch.optim.Optimizer, epoch: int, step: int, config: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    torch.save(
        {
            "schema": "archie-rootless-checkpoint/v1",
            "model": model.state_dict(),
            "optimizer": optimizer.state_dict(),
            "epoch": epoch,
            "optimizer_step": step,
            "next_optimizer_step": step + 1,
            "python_rng": random.getstate(),
            "torch_rng": torch.get_rng_state(),
            "cuda_rng": torch.cuda.get_rng_state_all(),
            "config": config,
        },
        path,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True, type=Path)
    parser.add_argument("--teacher-jsonl", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    if not torch.cuda.is_available():
        raise RuntimeError("Refusing CPU fallback: rootless policy training requires CUDA")

    profile = json.loads(args.profile.read_text(encoding="utf-8"))
    if profile.get("schema") != "archie-rootless-profile/v1":
        raise ValueError("unsupported profile schema")
    if profile["student"].get("external_base_model") is not None:
        raise ValueError("rootless training forbids an external base model")

    seed = int(profile["training"]["seed"])
    random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    torch.backends.cuda.matmul.allow_tf32 = True

    rows = load_transitions(args.teacher_jsonl)
    student = profile["student"]
    training = profile["training"]
    device = torch.device("cuda")
    model = RootlessPolicy(
        vocab_size=int(student["vocabulary_size"]),
        hidden_size=int(student["hidden_size"]),
        action_vocab_size=int(student["action_vocab_size"]),
        layers=int(student["recurrent_layers"]),
    ).to(device)
    optimizer = torch.optim.AdamW(
        model.parameters(),
        lr=float(training["learning_rate"]),
        weight_decay=float(training["weight_decay"]),
    )
    scaler = torch.amp.GradScaler("cuda", enabled=False)
    accumulation = int(training["gradient_accumulation_steps"])
    checkpoint_every = int(training["checkpoint_every_optimizer_steps"])
    optimizer_step = 0
    model.train()

    for epoch in range(int(training["epochs"])):
        optimizer.zero_grad(set_to_none=True)
        for micro_step, (tokens, lengths, actions, rewards) in enumerate(
            batches(rows, int(training["batch_size"]), 0, device), 1
        ):
            with torch.autocast(device_type="cuda", dtype=torch.bfloat16):
                logits, values, latent = model(tokens, lengths)
                action_loss = F.cross_entropy(logits, actions)
                value_loss = F.smooth_l1_loss(values, rewards)
                centered = latent - latent.mean(dim=0, keepdim=True)
                state_loss = centered.pow(2).mean()
                entropy = -(logits.softmax(-1) * logits.log_softmax(-1)).sum(-1).mean()
                loss = (
                    float(training["teacher_action_weight"]) * action_loss
                    + float(training["return_weight"]) * value_loss
                    + float(training["state_consistency_weight"]) * state_loss
                    - float(training["entropy_floor"]) * entropy
                ) / accumulation
            scaler.scale(loss).backward()
            if micro_step % accumulation == 0:
                scaler.unscale_(optimizer)
                nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                scaler.step(optimizer)
                scaler.update()
                optimizer.zero_grad(set_to_none=True)
                optimizer_step += 1
                if optimizer_step % checkpoint_every == 0:
                    save_checkpoint(args.output / f"checkpoint-{optimizer_step}.pt", model, optimizer, epoch, optimizer_step, profile)

    save_checkpoint(args.output / "final.pt", model, optimizer, int(training["epochs"]), optimizer_step, profile)
    receipt = {
        "schema": "archie-rootless-training-receipt/v1",
        "training_started": True,
        "checkpoint_created": True,
        "optimizer_steps": optimizer_step,
        "teacher_examples": len(rows),
        "external_base_model": None,
        "runtime_requires_teacher": False,
        "promotion": "not-admitted",
    }
    (args.output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
