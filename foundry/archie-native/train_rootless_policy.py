#!/usr/bin/env python3
"""Train a random-initialized recurrent Archie policy from verified O/A/V traces.

Input JSONL episodes:
{"episode_id":"...","verified":true,"steps":[
  {"observation":"...","action":3,"value":0.8,"stop":false}, ...]}

The deployed checkpoint emits action/value/stop directly. It never loads or calls a
foundation model. Generation zero is provably random; resume generations must name
and load the student's own complete parent checkpoint.
"""
from __future__ import annotations
import argparse, dataclasses, hashlib, json, pathlib, random, time
from dataclasses import dataclass
from typing import Any
import torch
import torch.nn as nn
import torch.nn.functional as F

SCHEMA = "archie-rootless-policy/v1"
PAD = 256
VOCAB = 257

def stable(x: Any) -> str:
    return json.dumps(x, sort_keys=True, separators=(",", ":"), ensure_ascii=False)

def digest_bytes(x: bytes) -> str:
    return hashlib.sha256(x).hexdigest()

def digest_file(p: pathlib.Path) -> str:
    return digest_bytes(p.read_bytes())

def encode(text: str, width: int) -> list[int]:
    x = list(text.encode("utf-8", errors="replace"))[-width:]
    return [PAD] * (width - len(x)) + x

@dataclass
class Config:
    width: int = 256
    embed: int = 96
    hidden: int = 256
    layers: int = 2
    actions: int = 64
    dropout: float = 0.05

class RootlessPolicy(nn.Module):
    def __init__(self, cfg: Config):
        super().__init__()
        self.cfg = cfg
        self.token = nn.Embedding(VOCAB, cfg.embed, padding_idx=PAD)
        self.obs = nn.GRU(cfg.embed, cfg.hidden, batch_first=True)
        self.core = nn.GRU(cfg.hidden, cfg.hidden, cfg.layers, batch_first=True,
                           dropout=cfg.dropout if cfg.layers > 1 else 0.0)
        self.action = nn.Linear(cfg.hidden, cfg.actions)
        self.value = nn.Linear(cfg.hidden, 1)
        self.stop = nn.Linear(cfg.hidden, 1)
        self.apply(self._init)

    @staticmethod
    def _init(module: nn.Module) -> None:
        if isinstance(module, (nn.Linear, nn.Embedding)):
            nn.init.normal_(module.weight, mean=0.0, std=0.02)
            if isinstance(module, nn.Linear) and module.bias is not None:
                nn.init.zeros_(module.bias)

    def forward(self, observations: torch.Tensor, state=None):
        # observations: [batch, episode_steps, observation_bytes]
        b, t, w = observations.shape
        z = self.token(observations.reshape(b * t, w))
        _, h_obs = self.obs(z)
        z = h_obs[-1].reshape(b, t, self.cfg.hidden)
        z, state = self.core(z, state)
        return self.action(z), self.value(z).squeeze(-1), self.stop(z).squeeze(-1), state

    @torch.no_grad()
    def act(self, observation: torch.Tensor, state=None):
        logits, value, stop, state = self(observation[:, None, :], state)
        return {
            "action": logits[:, -1].argmax(-1),
            "value": value[:, -1],
            "stop_probability": stop[:, -1].sigmoid(),
            "state": state,
        }

def load_episodes(path: pathlib.Path, cfg: Config) -> list[dict[str, torch.Tensor]]:
    episodes = []
    seen = set()
    for line_no, raw in enumerate(path.read_text().splitlines(), 1):
        if not raw.strip():
            continue
        row = json.loads(raw)
        eid = str(row.get("episode_id", ""))
        if not eid or eid in seen or row.get("verified") is not True:
            raise ValueError(f"line {line_no}: episode must have unique id and verified=true")
        seen.add(eid)
        steps = row.get("steps") or []
        if not steps:
            raise ValueError(f"line {line_no}: empty episode")
        obs, action, value, stop = [], [], [], []
        for s in steps:
            a = int(s["action"])
            if not 0 <= a < cfg.actions:
                raise ValueError(f"line {line_no}: action {a} outside [0,{cfg.actions})")
            obs.append(encode(str(s["observation"]), cfg.width))
            action.append(a)
            value.append(float(s.get("value", 0.0)))
            stop.append(float(bool(s.get("stop", False))))
        episodes.append({
            "obs": torch.tensor(obs, dtype=torch.long),
            "action": torch.tensor(action, dtype=torch.long),
            "value": torch.tensor(value, dtype=torch.float32),
            "stop": torch.tensor(stop, dtype=torch.float32),
        })
    if len(episodes) < 2:
        raise ValueError("at least two verified episodes are required")
    return episodes

def batch(episodes, indices, device):
    rows = [episodes[i] for i in indices]
    length = max(len(x["action"]) for x in rows)
    b, width = len(rows), rows[0]["obs"].shape[-1]
    obs = torch.full((b, length, width), PAD, dtype=torch.long)
    action = torch.zeros((b, length), dtype=torch.long)
    value = torch.zeros((b, length))
    stop = torch.zeros((b, length))
    mask = torch.zeros((b, length), dtype=torch.bool)
    for i, row in enumerate(rows):
        n = len(row["action"])
        obs[i, :n], action[i, :n] = row["obs"], row["action"]
        value[i, :n], stop[i, :n], mask[i, :n] = row["value"], row["stop"], True
    return tuple(x.to(device) for x in (obs, action, value, stop, mask))

def split_indices(n: int, seed: int):
    ids = list(range(n)); random.Random(seed).shuffle(ids)
    cut = max(1, int(n * 0.8)); cut = min(cut, n - 1)
    return ids[:cut], ids[cut:]

def evaluate(model, episodes, ids, device):
    model.eval(); correct = count = 0; value_error = stop_error = 0.0
    with torch.no_grad():
        for i in ids:
            obs, action, value, stop, mask = batch(episodes, [i], device)
            logits, pred_value, pred_stop, _ = model(obs)
            correct += int(((logits.argmax(-1) == action) & mask).sum())
            count += int(mask.sum())
            value_error += float(((pred_value - value).abs() * mask).sum())
            stop_error += float(((pred_stop.sigmoid() - stop).abs() * mask).sum())
    return {"action_accuracy": correct / max(1, count),
            "value_mae": value_error / max(1, count),
            "stop_mae": stop_error / max(1, count), "steps": count}

def tensor_digest(model: nn.Module) -> str:
    h = hashlib.sha256()
    for name, tensor in sorted(model.state_dict().items()):
        h.update(name.encode()); h.update(tensor.detach().cpu().contiguous().numpy().tobytes())
    return h.hexdigest()

def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--episodes", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--parent")
    p.add_argument("--actions", type=int, default=64)
    p.add_argument("--steps", type=int, default=1000)
    p.add_argument("--batch", type=int, default=8)
    p.add_argument("--lr", type=float, default=3e-4)
    p.add_argument("--seed", type=int, default=730)
    p.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    a = p.parse_args()
    torch.manual_seed(a.seed); random.seed(a.seed)
    cfg = Config(actions=a.actions)
    episodes_path = pathlib.Path(a.episodes).resolve()
    episodes = load_episodes(episodes_path, cfg)
    train_ids, held_ids = split_indices(len(episodes), a.seed)
    device = torch.device(a.device)
    model = RootlessPolicy(cfg).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=0.01)
    generation = 0; parent_digest = None
    random_initial_digest = tensor_digest(model)
    if a.parent:
        parent = pathlib.Path(a.parent).resolve()
        payload = torch.load(parent, map_location=device, weights_only=False)
        if payload.get("schema") != SCHEMA:
            raise ValueError("parent schema mismatch")
        model.load_state_dict(payload["model"]); optimizer.load_state_dict(payload["optimizer"])
        generation = int(payload["generation"]) + 1
        parent_digest = digest_file(parent)
        if payload.get("checkpoint_digest") and payload["checkpoint_digest"] != tensor_digest(model):
            raise ValueError("parent tensor digest mismatch")
    before = evaluate(model, episodes, held_ids, device)
    started = time.time(); model.train()
    rng = random.Random(a.seed + generation)
    for step in range(a.steps):
        ids = [rng.choice(train_ids) for _ in range(min(a.batch, len(train_ids)))]
        obs, action, value, stop, mask = batch(episodes, ids, device)
        logits, pred_value, pred_stop, _ = model(obs)
        action_loss = F.cross_entropy(logits[mask], action[mask])
        value_loss = F.smooth_l1_loss(pred_value[mask], value[mask])
        stop_loss = F.binary_cross_entropy_with_logits(pred_stop[mask], stop[mask])
        loss = action_loss + 0.25 * value_loss + 0.25 * stop_loss
        optimizer.zero_grad(set_to_none=True); loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0); optimizer.step()
    after = evaluate(model, episodes, held_ids, device)
    out = pathlib.Path(a.output).resolve(); out.parent.mkdir(parents=True, exist_ok=True)
    checkpoint_digest = tensor_digest(model)
    payload = {"schema": SCHEMA, "generation": generation, "config": dataclasses.asdict(cfg),
               "model": model.state_dict(), "optimizer": optimizer.state_dict(),
               "seed": a.seed, "random_initial_digest": random_initial_digest,
               "parent_file_sha256": parent_digest, "checkpoint_digest": checkpoint_digest}
    torch.save(payload, out)
    receipt = {"schema": "archie-rootless-policy-receipt/v1", "generation": generation,
               "episodes_sha256": digest_file(episodes_path), "parent_file_sha256": parent_digest,
               "random_initial_digest": random_initial_digest, "checkpoint_tensor_digest": checkpoint_digest,
               "checkpoint_file_sha256": digest_file(out), "device": str(device),
               "cuda": torch.cuda.get_device_name(device) if device.type == "cuda" else None,
               "seconds": time.time() - started, "train_episodes": len(train_ids),
               "held_out_episodes": len(held_ids), "before": before, "after": after}
    receipt_path = out.with_suffix(out.suffix + ".receipt.json")
    receipt_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    print(stable(receipt))

if __name__ == "__main__":
    main()
