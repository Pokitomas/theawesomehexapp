#!/usr/bin/env python3
from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import math
import os
import random
import statistics
import time
from pathlib import Path
from typing import Any

import torch
import torch.nn as nn
import torch.nn.functional as F

import latent_world_benchmark as base
import full_budget_campaign as campaign

SCHEMA = "archie-terminal-efficiency/v3"
PROMOTION = "research-only-not-admitted"


def atomic_json(value: Any, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def slices(cfg: base.WorldConfig) -> dict[str, slice]:
    offset = base.N_PRIMITIVES
    target = slice(offset, offset + cfg.slots); offset += cfg.slots
    other = slice(offset, offset + cfg.slots); offset += cfg.slots
    value = slice(offset, offset + cfg.values); offset += cfg.values
    source = slice(offset, offset + cfg.sources); offset += cfg.sources
    auth = slice(offset, offset + 3); offset += 3
    flags = slice(offset, offset + 4)
    return {"target": target, "other": other, "value": value, "source": source, "auth": auth, "flags": flags}


class FullStateFactorizedInterpreter(base.BaseModel):
    """Factorized neural transitions over explicit slots plus exact structural state transport.

    The model learns value-changing slot transitions. Source bits, authority, queue occupancy,
    and correction-stack transport are explicit state variables because the benchmark exposes
    their typed primitive controls directly. This is a research hybrid, never an admission path.
    """

    supports_persistent_state = False

    def __init__(self, cfg: base.WorldConfig, hidden: int = 64, width: int = 28) -> None:
        super().__init__(cfg, hidden)
        self.width = width
        self.s = slices(cfg)
        self.slot_init = nn.Linear(cfg.values, width)
        self.value_embed = nn.Linear(cfg.values, width)
        self.event = nn.Linear(cfg.structured_dim, width)
        self.set_cell = nn.Sequential(nn.Linear(width * 3, width * 2), nn.GELU(), nn.Linear(width * 2, width))
        self.copy_cell = nn.Sequential(nn.Linear(width * 3, width * 2), nn.GELU(), nn.Linear(width * 2, width))
        self.negate_cell = nn.Sequential(nn.Linear(width * 2, width * 2), nn.GELU(), nn.Linear(width * 2, width))
        self.slot_decode = nn.Linear(width, cfg.values)
        self.readout = nn.Sequential(
            nn.Linear(cfg.slots * width + cfg.sources + 3 + cfg.queue_len * (cfg.slots + 1), hidden * 2),
            nn.GELU(),
            nn.Linear(hidden * 2, hidden),
        )
        self.router = nn.Sequential(nn.Linear(base.N_PRIMITIVES + 4, 48), nn.GELU(), nn.Linear(48, base.N_OPS))

    def _initial(self, initial: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
        b, cfg = initial.size(0), self.cfg
        offset = 0
        slot_onehot = initial[:, offset:offset + cfg.slots * cfg.values].view(b, cfg.slots, cfg.values)
        offset += cfg.slots * cfg.values
        sources = initial[:, offset:offset + cfg.sources].clone(); offset += cfg.sources
        auth = initial[:, offset:offset + 3].clone()
        slots = self.slot_init(slot_onehot)
        queue = torch.zeros(b, cfg.queue_len, cfg.slots + 1, device=initial.device, dtype=initial.dtype)
        queue[..., 0] = 1.0
        return slots, sources, auth, queue

    def _state_probs(self, slots: torch.Tensor, sources: torch.Tensor, auth: torch.Tensor, queue: torch.Tensor) -> torch.Tensor:
        slot_probs = self.slot_decode(slots).softmax(-1).flatten(1)
        return torch.cat([slot_probs, sources, auth, queue[..., 1:].flatten(1)], -1)

    def forward(self, events: torch.Tensor, initial: torch.Tensor, latent: Any = None) -> dict[str, Any]:
        if latent is not None:
            raise ValueError("prefix continuation is disabled until correction-stack state is serialized")
        cfg = self.cfg
        slots, sources, auth, queue = self._initial(initial)
        state_history: list[tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]] = [(slots, sources, auth, queue)]
        stacks: list[list[int]] = [[] for _ in range(events.size(0))]
        hidden_seq, state_seq, queue_seq, router_seq = [], [], [], []

        for step in range(events.size(1)):
            structured = events[:, step, :cfg.structured_dim]
            prim = structured[:, :base.N_PRIMITIVES]
            target = structured[:, self.s["target"]]
            other = structured[:, self.s["other"]]
            value = structured[:, self.s["value"]]
            source_sel = structured[:, self.s["source"]]
            auth_sel = structured[:, self.s["auth"]]
            flags = structured[:, self.s["flags"]]
            event = self.event(structured)

            current = (target[..., None] * slots).sum(1)
            peer = (other[..., None] * slots).sum(1)
            value_latent = self.value_embed(value)
            set_proposal = self.set_cell(torch.cat([current, value_latent, event], -1))
            copy_proposal = self.copy_cell(torch.cat([current, peer, event], -1))
            read_gate = prim[:, base.P_READ:base.P_READ + 1]
            base_proposal = set_proposal + read_gate * (copy_proposal - set_proposal)
            negate_input = current + read_gate * (peer - current)
            negated = self.negate_cell(torch.cat([negate_input, event], -1))
            negate_gate = prim[:, base.P_NEGATE:base.P_NEGATE + 1]
            proposal = base_proposal + negate_gate * (negated - base_proposal)

            selected_source = (source_sel * sources).sum(1, keepdim=True)
            conditional = prim[:, base.P_CONDITIONAL:base.P_CONDITIONAL + 1]
            swap_gate = prim[:, base.P_SWAP:base.P_SWAP + 1]
            write_gate = prim[:, base.P_WRITE:base.P_WRITE + 1] * (1.0 - conditional + conditional * selected_source)
            ordinary_write = write_gate * (1.0 - swap_gate)
            next_slots = slots + ordinary_write[..., None] * target[..., None] * (proposal[:, None] - slots)
            swapped = slots + target[..., None] * (peer[:, None] - slots) + other[..., None] * (current[:, None] - slots)
            next_slots = next_slots + swap_gate[..., None] * (swapped - next_slots)

            odd_mask = torch.tensor([float(i & 1) for i in range(cfg.values)], device=value.device, dtype=value.dtype)
            source_value = (value * odd_mask).sum(-1, keepdim=True)
            source_gate = prim[:, base.P_SOURCE:base.P_SOURCE + 1] * (1.0 - conditional)
            next_sources = sources + source_gate * source_sel * (source_value - sources)

            auth_gate = prim[:, base.P_AUTH:base.P_AUTH + 1]
            next_auth = auth + auth_gate * (auth_sel - auth)

            target_queue = torch.cat([torch.zeros_like(target[:, :1]), target], -1)
            pushed_queue = torch.cat([queue[:, 1:], target_queue[:, None]], 1)
            queue_gate = prim[:, base.P_QUEUE:base.P_QUEUE + 1]
            next_queue = queue + queue_gate[..., None] * (pushed_queue - queue)

            correct = prim[:, base.P_CORRECT].gt(0.5)
            noop = prim.sum(-1).eq(0)
            push = ~(correct | noop)
            for row in range(events.size(0)):
                if bool(push[row]):
                    stacks[row].append(step)

            if bool(correct.any()):
                restore_indices = []
                for row in range(events.size(0)):
                    restore_indices.append(stacks[row].pop() if bool(correct[row]) and stacks[row] else step)
                restored = [
                    torch.stack([state_history[restore_indices[row]][part][row] for row in range(events.size(0))], 0)
                    for part in range(4)
                ]
                next_slots = torch.where(correct[:, None, None], restored[0], next_slots)
                next_sources = torch.where(correct[:, None], restored[1], next_sources)
                next_auth = torch.where(correct[:, None], restored[2], next_auth)
                next_queue = torch.where(correct[:, None, None], restored[3], next_queue)

            slots, sources, auth, queue = next_slots, next_sources, next_auth, next_queue
            state_history.append((slots, sources, auth, queue))
            h = self.readout(torch.cat([slots.flatten(1), sources, auth, queue.flatten(1)], -1))
            hidden_seq.append(h)
            state_seq.append(self._state_probs(slots, sources, auth, queue))
            queue_seq.append(queue)
            router_seq.append(self.router(torch.cat([prim, flags], -1)))

        hseq = torch.stack(hidden_seq, 1)
        return {
            "state": torch.stack(state_seq, 1),
            "queue_full": torch.stack(queue_seq, 1),
            "op_logits": torch.stack(router_seq, 1),
            "change_logits": self.change_head(hseq),
            "hidden_seq": hseq,
            "latent": (slots, sources, auth, queue),
        }


def build_model(kind: str, cfg: base.WorldConfig, width: int) -> base.BaseModel:
    if kind == "factorized_full_state":
        return FullStateFactorizedInterpreter(cfg, width=width)
    if kind == "neural_interpreter":
        return campaign.NeuralInterpreter(cfg, width=width)
    if kind == "graph_routing":
        return campaign.GraphRouting(cfg, width=width)
    raise KeyError(kind)


def component_losses(out: dict[str, Any], batch: dict[str, torch.Tensor], cfg: base.WorldConfig) -> dict[str, torch.Tensor]:
    pred, target = out["state"], batch["trajectory"]
    offset = 0
    slot_pred = pred[..., offset:offset + cfg.slots * cfg.values].view(*pred.shape[:-1], cfg.slots, cfg.values)
    slot_target = target[..., offset:offset + cfg.slots * cfg.values].view(*target.shape[:-1], cfg.slots, cfg.values).argmax(-1)
    slot_ce = F.nll_loss(slot_pred.clamp_min(1e-8).log().reshape(-1, cfg.values), slot_target.reshape(-1), reduction="none").view(*slot_target.shape)
    offset += cfg.slots * cfg.values
    source_pred = pred[..., offset:offset + cfg.sources]
    source_target = target[..., offset:offset + cfg.sources]
    source_bce = F.binary_cross_entropy(source_pred, source_target, reduction="none")
    offset += cfg.sources
    auth_pred = pred[..., offset:offset + 3]
    auth_target = target[..., offset:offset + 3].argmax(-1)
    auth_ce = F.nll_loss(auth_pred.clamp_min(1e-8).log().reshape(-1, 3), auth_target.reshape(-1), reduction="none").view(*auth_target.shape)
    offset += 3
    queue_target_raw = target[..., offset:].view(*target.shape[:-1], cfg.queue_len, cfg.slots)
    queue_class = torch.where(queue_target_raw.sum(-1).gt(0), queue_target_raw.argmax(-1) + 1, torch.zeros_like(queue_target_raw.argmax(-1)))
    if "queue_full" in out:
        queue_nll = F.nll_loss(out["queue_full"].clamp_min(1e-8).log().reshape(-1, cfg.slots + 1), queue_class.reshape(-1), reduction="none").view(*queue_class.shape)
    else:
        queue_pred = pred[..., offset:].view(*pred.shape[:-1], cfg.queue_len, cfg.slots)
        occupied = queue_class.gt(0)
        queue_nll = torch.zeros_like(queue_class, dtype=pred.dtype)
        if occupied.any():
            queue_nll[occupied] = F.nll_loss(queue_pred[occupied].clamp_min(1e-8).log(), queue_class[occupied] - 1, reduction="none")
    return {"slot": slot_ce, "source": source_bce, "auth": auth_ce, "queue": queue_nll}


def terminal_weighted_loss(out: dict[str, Any], batch: dict[str, torch.Tensor], cfg: base.WorldConfig) -> tuple[torch.Tensor, dict[str, float]]:
    c = component_losses(out, batch, cfg)
    t = batch["events"].size(1)
    step_weights = torch.linspace(0.35, 1.0, t, device=out["state"].device)
    changed = batch["changed_cells"]
    slot_weights = step_weights[None, :, None] * (1.0 + 2.0 * changed)
    trajectory = (c["slot"] * slot_weights).mean() + (c["source"] * step_weights[None, :, None]).mean() + (c["auth"] * step_weights[None]).mean() + (c["queue"] * step_weights[None, :, None]).mean()
    terminal = c["slot"][:, -1].sum(-1).mean() + c["source"][:, -1].sum(-1).mean() + c["auth"][:, -1].mean() + c["queue"][:, -1].sum(-1).mean()
    op = F.cross_entropy(out["op_logits"].reshape(-1, base.N_OPS), batch["ops"].reshape(-1))
    positive = batch["changed_cells"].sum().clamp_min(1.0)
    negative = batch["changed_cells"].numel() - positive
    pos_weight = (negative / positive).clamp(1.0, 12.0)
    change = F.binary_cross_entropy_with_logits(out["change_logits"], batch["changed_cells"], pos_weight=pos_weight)
    pred_delta = (out["state"][:, 1:] - out["state"][:, :-1]).abs().mean(-1)
    true_delta = (batch["trajectory"][:, 1:] - batch["trajectory"][:, :-1]).abs().mean(-1)
    delta = F.smooth_l1_loss(pred_delta, true_delta)
    loss = trajectory + 1.25 * terminal + 0.08 * op + 0.10 * change + 0.05 * delta
    return loss, {"trajectory": float(trajectory.detach()), "terminal": float(terminal.detach()), "op": float(op.detach()), "change": float(change.detach()), "delta": float(delta.detach())}


@torch.no_grad()
def _batch_metrics(model: base.BaseModel, cfg: base.WorldConfig, batch: dict[str, torch.Tensor]) -> dict[str, float]:
    out = model(batch["events"], batch["initial"])
    ps, psrc, pauth, pq = base.decode_state(out["state"], cfg)
    ts, tsrc, tauth, tq = base.decode_state(batch["trajectory"], cfg)
    slot_ok = ps.eq(ts)
    nonqueue_ok = slot_ok.all(-1) & psrc.eq(tsrc).all(-1) & pauth.eq(tauth)
    queue_ok = pq.eq(tq).all(-1)
    full_ok = nonqueue_ok & queue_ok
    first = []
    length = batch["events"].size(1)
    for row in range(batch["events"].size(0)):
        bad = (~full_ok[row]).nonzero()
        first.append(length if bad.numel() == 0 else int(bad[0, 0]))
    op_accuracy = out["op_logits"].argmax(-1).eq(batch["ops"]).float().mean()
    change_accuracy = out["change_logits"].sigmoid().gt(0.5).eq(batch["changed_cells"].gt(0.5)).float().mean()
    return {
        "exact_terminal": float(nonqueue_ok[:, -1].float().mean()),
        "full_exact_terminal": float(full_ok[:, -1].float().mean()),
        "slot_accuracy": float(slot_ok[:, -1].float().mean()),
        "trajectory_slot_accuracy": float(slot_ok.float().mean()),
        "trajectory_full_exact": float(full_ok.float().mean()),
        "first_divergence_fraction": statistics.fmean(first) / length,
        "operation_accuracy": float(op_accuracy),
        "change_accuracy": float(change_accuracy),
        "examples": float(batch["events"].size(0)),
    }


def _aggregate(metrics: list[dict[str, float]]) -> dict[str, float]:
    keys = [key for key in metrics[0] if key != "examples"]
    result = {key: statistics.fmean(item[key] for item in metrics) for key in keys}
    result["examples"] = sum(item["examples"] for item in metrics)
    result["score"] = (
        0.48 * result["full_exact_terminal"]
        + 0.20 * result["exact_terminal"]
        + 0.17 * result["first_divergence_fraction"]
        + 0.10 * result["trajectory_full_exact"]
        + 0.05 * result["slot_accuracy"]
    )
    return result


@torch.no_grad()
def evaluate(model: base.BaseModel, cfg: base.WorldConfig, seeds: list[int], batch_size: int = 64) -> dict[str, float]:
    model.eval()
    metrics = []
    for seed in seeds:
        for suite_index, suite in enumerate(campaign.SUITES):
            batch = base.generate_batch(cfg, batch_size, suite.length, seed + suite_index * 1009, suite.split)
            metrics.append(_batch_metrics(model, cfg, batch))
        batch = base.generate_batch(cfg, batch_size, 28, seed + 90_001, "long_chain")
        metrics.append(_batch_metrics(model, cfg, batch))
    return _aggregate(metrics)


@torch.no_grad()
def evaluate_frozen(model: base.BaseModel, cfg: base.WorldConfig, campaign_root: Path, scale: str) -> dict[str, Any]:
    manifest = json.loads((campaign_root / "campaign-manifest.json").read_text(encoding="utf-8"))
    suites: dict[str, Any] = {}
    for suite in campaign.SUITES:
        records = [r for r in manifest["corpus"] if r["scale"] == scale and r["suite"] == suite.name]
        metrics = []
        for record in records:
            artifact = campaign_root / record["artifact"]
            if sha256_file(artifact) != record["artifact_sha256"]:
                raise RuntimeError(f"frozen batch digest mismatch: {artifact}")
            batch = torch.load(artifact, map_location="cpu", weights_only=False)
            metrics.append(_batch_metrics(model, cfg, batch))
        suites[suite.name] = _aggregate(metrics)
    summary = _aggregate([suites[s.name] for s in campaign.SUITES])
    return {
        "manifest_sha256": manifest["manifest_sha256"],
        "metric_correction": "full_exact_terminal includes queue occupancy and queue identity; legacy exact_terminal omitted queue",
        "suites": suites,
        "summary": summary,
    }


def historical_audit(campaign_root: Path, scale: str) -> dict[str, Any]:
    cube = json.loads((campaign_root / "result-cube.json").read_text(encoding="utf-8"))
    rows = [row for row in cube["rows"] if row["scale"] == scale]
    ranked = []
    for row in rows:
        suites = row["evaluation"]["suites"]
        mean_exact = statistics.fmean(item["exact_terminal_accuracy"] for item in suites.values())
        ranked.append({
            "candidate": row["candidate"],
            "family": row["family"],
            "mechanism_score": row["mechanism_score"],
            "mean_legacy_exact_terminal": mean_exact,
            "temporal_legacy_exact_terminal": suites["temporal_horizon"]["exact_terminal_accuracy"],
            "estimated_training_flops": row["estimated_training_flops"],
            "legacy_exact_per_1e12_flops": mean_exact * 1e12 / max(1, row["estimated_training_flops"]),
        })
    return {
        "best_by_mechanism": max(ranked, key=lambda x: x["mechanism_score"]),
        "best_by_legacy_exact": max(ranked, key=lambda x: x["mean_legacy_exact_terminal"]),
        "best_by_legacy_exact_per_flop": max(ranked, key=lambda x: x["legacy_exact_per_1e12_flops"]),
        "warning": "legacy exact excludes queue and is not the corrected global terminal metric",
    }


@dataclasses.dataclass(frozen=True)
class Arm:
    name: str
    kind: str
    width: int
    lr: float


ARMS = (
    Arm("factorized_w24_lr2e3", "factorized_full_state", 24, 2e-3),
    Arm("factorized_w28_lr1e3", "factorized_full_state", 28, 1e-3),
    Arm("factorized_w32_lr2e3", "factorized_full_state", 32, 2e-3),
    Arm("factorized_w36_lr1e3", "factorized_full_state", 36, 1e-3),
    Arm("neural_interpreter_terminal", "neural_interpreter", 26, 1e-3),
    Arm("graph_routing_terminal", "graph_routing", 28, 1e-3),
)


def train_to(model: base.BaseModel, optimizer: torch.optim.Optimizer, cfg: base.WorldConfig, seed: int, start: int, stop: int, batch_size: int) -> list[dict[str, float]]:
    history = []
    model.train()
    for step in range(start, stop):
        lengths = (4, 6, 8) if step < 256 else ((6, 8, 12, 14) if step < 768 else (8, 12, 16, 20))
        length = lengths[step % len(lengths)]
        batch = base.generate_batch(cfg, batch_size, length, seed * 1_000_003 + step * 17, "train")
        optimizer.zero_grad(set_to_none=True)
        out = model(batch["events"], batch["initial"])
        loss, parts = terminal_weighted_loss(out, batch, cfg)
        if not torch.isfinite(loss):
            raise RuntimeError("non-finite loss")
        loss.backward()
        grad = float(torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0))
        optimizer.step()
        if step == start or (step + 1) % 128 == 0 or step + 1 == stop:
            history.append({"step": step + 1, "loss": float(loss.detach()), "grad_norm": grad, **parts})
    return history


def run(args: argparse.Namespace) -> dict[str, Any]:
    torch.set_num_threads(max(1, min(args.threads, os.cpu_count() or 1)))
    out = args.output
    out.mkdir(parents=True, exist_ok=True)
    cfg = campaign.scale_by_name(args.scale).world
    rung_steps = [args.rung1, args.rung2, args.rung3]
    seeds = [args.seed, args.seed + 100_003]
    trials: dict[tuple[str, int], dict[str, Any]] = {}
    active = list(ARMS)
    started = time.monotonic()

    for rung_index, stop in enumerate(rung_steps):
        for arm in active:
            for seed in seeds:
                key = (arm.name, seed)
                if key not in trials:
                    torch.manual_seed(seed); random.seed(seed)
                    model = build_model(arm.kind, cfg, arm.width)
                    optimizer = torch.optim.AdamW(model.parameters(), lr=arm.lr, weight_decay=1e-4)
                    trials[key] = {"arm": arm, "seed": seed, "model": model, "optimizer": optimizer, "step": 0, "history": [], "event_tokens": 0}
                trial = trials[key]
                for step in range(trial["step"], stop):
                    lengths = (4, 6, 8) if step < 256 else ((6, 8, 12, 14) if step < 768 else (8, 12, 16, 20))
                    trial["event_tokens"] += lengths[step % len(lengths)] * args.batch_size
                trial["history"].extend(train_to(trial["model"], trial["optimizer"], cfg, seed, trial["step"], stop, args.batch_size))
                trial["step"] = stop
                trial["metrics"] = evaluate(trial["model"], cfg, [seed + 700_001, seed + 700_019], batch_size=args.eval_batch_size)

        grouped = []
        for arm in active:
            values = [trials[(arm.name, seed)]["metrics"]["score"] for seed in seeds]
            grouped.append((statistics.fmean(values), arm))
        grouped.sort(key=lambda x: x[0], reverse=True)
        keep = [3, 2, 1][rung_index]
        active = [arm for _, arm in grouped[:keep]]
        atomic_json({
            "schema": SCHEMA,
            "rung": rung_index + 1,
            "steps": stop,
            "ranking": [{"arm": arm.name, "mean_score": score} for score, arm in grouped],
            "promoted": [arm.name for arm in active],
            "promotion": PROMOTION,
        }, out / f"rung-{rung_index + 1}.json")

    winner = active[0]
    final_records = []
    for seed in seeds:
        trial = trials[(winner.name, seed)]
        checkpoint = out / f"{winner.name}__seed{seed}.pt"
        params = sum(p.numel() for p in trial["model"].parameters())
        torch.save({
            "schema": SCHEMA,
            "arm": dataclasses.asdict(winner),
            "world": dataclasses.asdict(cfg),
            "seed": seed,
            "steps": trial["step"],
            "state_dict": trial["model"].state_dict(),
            "optimizer_state": trial["optimizer"].state_dict(),
            "promotion": PROMOTION,
        }, checkpoint)
        sealed = evaluate_frozen(trial["model"], cfg, args.campaign_root, args.scale)
        final_records.append({
            "arm": winner.name,
            "seed": seed,
            "steps": trial["step"],
            "parameters": params,
            "event_tokens": trial["event_tokens"],
            "estimated_training_flops": int(6 * params * trial["event_tokens"]),
            "dev": trial["metrics"],
            "sealed_canonical": sealed,
            "history": trial["history"],
            "checkpoint": checkpoint.name,
            "checkpoint_sha256": sha256_file(checkpoint),
        })

    report = {
        "schema": SCHEMA,
        "promotion": PROMOTION,
        "scale": args.scale,
        "winner": dataclasses.asdict(winner),
        "rung_steps": rung_steps,
        "seeds": seeds,
        "elapsed_seconds": time.monotonic() - started,
        "records": final_records,
        "selection_rule": "successive halving on generated development seeds; sealed canonical corpus is used only after arm selection",
        "historical_audit": historical_audit(args.campaign_root, args.scale),
        "known_boundary": "the factorized candidate is a structured neural/symbolic research hybrid; canonical admission remains prohibited",
    }
    atomic_json(report, out / "terminal-efficiency-report.json")
    return report


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--campaign-root", type=Path, required=True)
    p.add_argument("--scale", choices=[s.name for s in campaign.SCALES], default="base")
    p.add_argument("--seed", type=int, default=30260721)
    p.add_argument("--rung1", type=int, default=256)
    p.add_argument("--rung2", type=int, default=768)
    p.add_argument("--rung3", type=int, default=2048)
    p.add_argument("--batch-size", type=int, default=64)
    p.add_argument("--eval-batch-size", type=int, default=64)
    p.add_argument("--threads", type=int, default=4)
    args = p.parse_args()
    print(json.dumps(run(args), sort_keys=True))


if __name__ == "__main__":
    main()
