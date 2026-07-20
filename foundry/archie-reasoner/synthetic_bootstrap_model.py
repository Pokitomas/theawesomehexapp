from __future__ import annotations

import base64
import dataclasses
import hashlib
import random

import numpy as np
import torch
from torch import nn
from torch.utils.data import Dataset

from synthetic_bootstrap_data import (
    ACTIONS, ACTION_INDEX, AUTHORITY, BOS, BYTE_VOCAB, CONTEXT, EOS, PAD, ROUTES, ROUTE_PROTOCOL,
    TRANSFORMS, encode_actions, encode_source,
)

@dataclasses.dataclass(frozen=True)
class Config:
    max_source: int = 96
    max_target: int = 9
    byte_dim: int = 24
    pos_dim: int = 8
    encoder_hidden: int = 32
    decoder_hidden: int = 48
    action_dim: int = 16
    batch_size: int = 64
    epochs: int = 18
    learning_rate: float = 0.003
    weight_decay: float = 0.0001


class Rows(Dataset):
    def __init__(self, rows: list[dict[str, Any]], config: Config):
        self.rows = rows
        self.config = config

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, index: int):
        row = self.rows[index]
        return {
            "source": encode_source(row["source"], self.config.max_source),
            "target": encode_actions(row["protocol"], self.config.max_target),
            "route": ROUTES.index(row["route"]),
            "authority": AUTHORITY.index(row["authority"]),
            "context": CONTEXT.index(row["context"]),
            "transform": TRANSFORMS.index(row["transform"]),
            "id": row["id"],
        }


def collate(batch):
    source_len = max(len(x["source"]) for x in batch)
    target_len = max(len(x["target"]) for x in batch)
    source = torch.full((len(batch), source_len), PAD, dtype=torch.long)
    target = torch.full((len(batch), target_len), ACTION_INDEX["<PAD>"], dtype=torch.long)
    for i, item in enumerate(batch):
        source[i, : len(item["source"])] = torch.tensor(item["source"])
        target[i, : len(item["target"])] = torch.tensor(item["target"])
    return {
        "source": source, "source_mask": source.eq(PAD), "target": target,
        "route": torch.tensor([x["route"] for x in batch]),
        "authority": torch.tensor([x["authority"] for x in batch]),
        "context": torch.tensor([x["context"] for x in batch]),
        "transform": torch.tensor([x["transform"] for x in batch]),
        "ids": [x["id"] for x in batch],
    }


class Student(nn.Module):
    def __init__(self, config: Config):
        super().__init__()
        self.config = config
        self.byte_embedding = nn.Embedding(BYTE_VOCAB, config.byte_dim, padding_idx=PAD)
        self.position_embedding = nn.Embedding(config.max_source, config.pos_dim)
        self.encoder = nn.GRU(config.byte_dim + config.pos_dim, config.encoder_hidden, batch_first=True, bidirectional=True)
        pooled = config.encoder_hidden * 2
        self.route_head = nn.Linear(pooled, len(ROUTES))
        self.authority_head = nn.Linear(pooled, len(AUTHORITY))
        self.context_head = nn.Linear(pooled, len(CONTEXT))
        self.transform_head = nn.Linear(pooled, len(TRANSFORMS))
        self.action_embedding = nn.Embedding(len(ACTIONS), config.action_dim, padding_idx=ACTION_INDEX["<PAD>"])
        self.decoder_init = nn.Linear(pooled, config.decoder_hidden)
        self.decoder = nn.GRU(config.action_dim + pooled, config.decoder_hidden, batch_first=True)
        self.action_head = nn.Linear(config.decoder_hidden, len(ACTIONS))

    def encode(self, source, source_mask):
        positions = torch.arange(source.size(1), device=source.device).unsqueeze(0).expand(source.size(0), -1)
        x = torch.cat([self.byte_embedding(source), self.position_embedding(positions)], dim=-1)
        encoded, _ = self.encoder(x)
        valid = (~source_mask).unsqueeze(-1)
        pooled = (encoded * valid).sum(dim=1) / valid.sum(dim=1).clamp_min(1)
        return encoded, pooled

    def forward(self, source, source_mask, target_input):
        _, pooled = self.encode(source, source_mask)
        action = self.action_embedding(target_input)
        context = pooled.unsqueeze(1).expand(-1, target_input.size(1), -1)
        hidden = torch.tanh(self.decoder_init(pooled)).unsqueeze(0)
        decoded, _ = self.decoder(torch.cat([action, context], dim=-1), hidden)
        return {
            "actions": self.action_head(decoded),
            "route": self.route_head(pooled),
            "authority": self.authority_head(pooled),
            "context": self.context_head(pooled),
            "transform": self.transform_head(pooled),
        }

    @torch.inference_mode()
    def generate(self, source, source_mask, max_steps: int):
        _, pooled = self.encode(source, source_mask)
        hidden = torch.tanh(self.decoder_init(pooled)).unsqueeze(0)
        token = torch.full((source.size(0), 1), ACTION_INDEX["<BOS>"], dtype=torch.long, device=source.device)
        output = []
        for _ in range(max_steps):
            action = self.action_embedding(token[:, -1:])
            decoded, hidden = self.decoder(torch.cat([action, pooled.unsqueeze(1)], dim=-1), hidden)
            next_token = self.action_head(decoded[:, -1]).argmax(dim=-1, keepdim=True)
            output.append(next_token)
            token = torch.cat([token, next_token], dim=1)
        generated = torch.cat(output, dim=1)
        return {
            "generated": generated,
            "route": self.route_head(pooled),
            "authority": self.authority_head(pooled),
            "context": self.context_head(pooled),
            "transform": self.transform_head(pooled),
        }


def seed_all(seed: int):
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.use_deterministic_algorithms(True, warn_only=True)


def loss_for(outputs, batch):
    action_labels = batch["target"][:, 1:]
    action_logits = outputs["actions"]
    action_loss = nn.functional.cross_entropy(action_logits.reshape(-1, action_logits.size(-1)), action_labels.reshape(-1), ignore_index=ACTION_INDEX["<PAD>"], label_smoothing=0.02)
    route = nn.functional.cross_entropy(outputs["route"], batch["route"], label_smoothing=0.02)
    authority = nn.functional.cross_entropy(outputs["authority"], batch["authority"])
    context = nn.functional.cross_entropy(outputs["context"], batch["context"])
    transform = nn.functional.cross_entropy(outputs["transform"], batch["transform"])
    total = 1.30 * action_loss + 1.00 * route + 0.35 * authority + 0.35 * context + 0.15 * transform
    return total, {"total": total.item(), "action": action_loss.item(), "route": route.item(), "authority": authority.item(), "context": context.item(), "transform": transform.item()}


def batch_to(batch, device):
    return {key: value.to(device) if torch.is_tensor(value) else value for key, value in batch.items()}


def decode_protocol(values: list[int]) -> list[str]:
    result = []
    for value in values:
        name = ACTIONS[value]
        if name == "<EOS>":
            break
        if name not in {"<PAD>", "<BOS>"}:
            result.append(name)
    return result


def evaluate_aux(model, loader, device):
    model.eval()
    counts = {"examples": 0, "route": 0, "authority": 0, "context": 0, "transform": 0}
    with torch.inference_mode():
        for raw in loader:
            batch = batch_to(raw, device)
            _, pooled = model.encode(batch["source"], batch["source_mask"])
            preds = {
                "route": model.route_head(pooled).argmax(-1),
                "authority": model.authority_head(pooled).argmax(-1),
                "context": model.context_head(pooled).argmax(-1),
                "transform": model.transform_head(pooled).argmax(-1),
            }
            n = batch["source"].size(0)
            counts["examples"] += n
            for key in preds:
                counts[key] += int((preds[key] == batch[key]).sum().item())
    n = max(1, counts["examples"])
    return {"examples": counts["examples"], **{f"{key}_accuracy": counts[key] / n for key in ["route", "authority", "context", "transform"]}}


def evaluate(model, loader, device, config):
    model.eval()
    counts = {"examples": 0, "route": 0, "authority": 0, "context": 0, "transform": 0, "protocol": 0, "guarded_protocol": 0, "routed_protocol": 0}
    errors = []
    with torch.inference_mode():
        for raw in loader:
            batch = batch_to(raw, device)
            out = model.generate(batch["source"], batch["source_mask"], config.max_target - 1)
            route = out["route"].argmax(-1).cpu().tolist()
            authority = out["authority"].argmax(-1).cpu().tolist()
            context = out["context"].argmax(-1).cpu().tolist()
            transform = out["transform"].argmax(-1).cpu().tolist()
            generated = out["generated"].cpu().tolist()
            expected_targets = batch["target"].cpu().tolist()
            for i in range(len(raw["ids"])):
                expected_protocol = decode_protocol(expected_targets[i][1:])
                predicted_protocol = decode_protocol(generated[i])
                guarded = ["ASK", "STOP"] if AUTHORITY[authority[i]] == "deny" or CONTEXT[context[i]] != "ready" else predicted_protocol
                routed = ["ASK", "STOP"] if AUTHORITY[authority[i]] == "deny" or CONTEXT[context[i]] != "ready" else ROUTE_PROTOCOL[ROUTES[route[i]]]
                counts["examples"] += 1
                counts["route"] += route[i] == int(batch["route"][i])
                counts["authority"] += authority[i] == int(batch["authority"][i])
                counts["context"] += context[i] == int(batch["context"][i])
                counts["transform"] += transform[i] == int(batch["transform"][i])
                counts["protocol"] += predicted_protocol == expected_protocol
                counts["guarded_protocol"] += guarded == expected_protocol
                counts["routed_protocol"] += routed == expected_protocol
                if len(errors) < 24 and (route[i] != int(batch["route"][i]) or guarded != expected_protocol):
                    errors.append({"id": raw["ids"][i], "expected_route": ROUTES[int(batch["route"][i])], "actual_route": ROUTES[route[i]], "expected_protocol": expected_protocol, "actual_protocol": predicted_protocol, "guarded_protocol": guarded})
    n = max(1, counts["examples"])
    return {
        "examples": counts["examples"],
        "route_accuracy": counts["route"] / n,
        "authority_accuracy": counts["authority"] / n,
        "context_accuracy": counts["context"] / n,
        "transform_accuracy": counts["transform"] / n,
        "protocol_exact": counts["protocol"] / n,
        "guarded_protocol_exact": counts["guarded_protocol"] / n,
        "routed_protocol_exact": counts["routed_protocol"] / n,
        "errors": errors,
    }


def state_hash(state: dict[str, torch.Tensor]) -> str:
    h = hashlib.sha256()
    for key in sorted(state):
        h.update(key.encode())
        h.update(state[key].detach().cpu().contiguous().numpy().tobytes())
    return h.hexdigest()


def quantize_state(state: dict[str, torch.Tensor]):
    tensors = {}
    for key in sorted(state):
        array = state[key].detach().cpu().numpy().astype(np.float32)
        peak = float(np.max(np.abs(array))) if array.size else 0.0
        scale = peak / 127.0 if peak > 0 else 1.0
        quantized = np.clip(np.rint(array / scale), -127, 127).astype(np.int8)
        tensors[key] = {"shape": list(array.shape), "scale": scale, "data": base64.b64encode(quantized.tobytes()).decode("ascii")}
    return tensors


def dequantize_state(tensors):
    state = {}
    for key, value in tensors.items():
        array = np.frombuffer(base64.b64decode(value["data"]), dtype=np.int8).astype(np.float32).reshape(value["shape"]) * float(value["scale"])
        state[key] = torch.from_numpy(array.copy())
    return state
