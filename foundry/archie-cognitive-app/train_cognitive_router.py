#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import random
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np
import torch
from torch import nn
from torch.utils.data import DataLoader, Dataset

ROUTES = (
    "summary", "checklist", "message", "decision", "study", "event",
    "errands", "objective", "next_action", "plan", "clarify",
)
AUTHORITY = ("allow", "deny")
CONTEXT = ("ready", "missing", "ambiguous")

ROUTE_PHRASES = {
    "summary": ["summarize the supported evidence in {topic}", "condense {topic} into verified findings", "give a source-bound digest of {topic}", "state only corroborated changes from {topic}", "extract defensible conclusions from {topic}", "brief me on the material facts in {topic}", "separate verified facts from opinion in {topic}"],
    "checklist": ["create pass-fail controls for {topic}", "build independently testable closure gates for {topic}", "write auditable readiness conditions for {topic}", "enumerate verifiable handoff checkpoints for {topic}", "turn the obligations in {topic} into yes-no tests", "assemble go-no-go requirements for {topic}"],
    "message": ["draft a concise recipient note about {topic}", "compose a calm reply concerning {topic}", "write public-facing wording for {topic}", "prepare a polite refusal regarding {topic}", "word the stakeholder update about {topic}", "create send-ready language confirming {topic}"],
    "decision": ["choose between the two options for {topic}", "compare repair and replacement for {topic}", "decide whether to continue or stop {topic}", "weigh the available suppliers for {topic}", "select the lower-risk approach to {topic}", "make the tradeoff call for {topic}"],
    "study": ["build mock drills for {topic}", "plan spaced retrieval for {topic}", "sequence rehearsal for {topic}", "organize active recall for {topic}", "create practice sessions for {topic}", "structure deliberate review for {topic}"],
    "event": ["plan the run of show for {topic}", "coordinate rooms speakers and timing for {topic}", "organize the detailed agenda for {topic}", "shape logistics for {topic}", "build the schedule and traffic flow for {topic}", "arrange volunteers stations and pauses for {topic}"],
    "errands": ["order the stops needed for {topic}", "sequence the visits involved in {topic}", "minimize backtracking through the stops for {topic}", "arrange the shortest loop for {topic}", "optimize travel for {topic}", "batch the pickups and deliveries for {topic}"],
    "objective": ["set the measurable aim for {topic}", "define the enduring target for {topic}", "record the outcome sought from {topic}", "establish the durable result for {topic}", "state the persistent goal for {topic}", "lock the long-range aim of {topic}"],
    "next_action": ["give one reversible step for {topic}", "name the first physical move for {topic}", "return the smallest evidence-producing action for {topic}", "identify the immediate safe step for {topic}", "choose one observable action to begin {topic}", "surface the next concrete move for {topic}"],
    "plan": ["map the phased transition for {topic}", "lay out dependencies for {topic}", "build a rollback-safe path for {topic}", "structure milestones for {topic}", "design staged proof points for {topic}", "create a controlled transition for {topic}"],
    "clarify": ["handle the other version", "use whichever approach belongs here", "do the useful thing from before", "apply that to this", "continue with the unspecified option", "fix it the right way"],
}

TOPICS = ["the coastal permit review", "a regional clinic transfer", "the warehouse reopening", "a laboratory safety process", "the river monitoring rollout", "a public records hearing", "the vehicle depot conversion", "the emergency radio qualification", "the service interruption", "the custody archive", "a rural health program", "the accessibility release", "the contractor selection", "the backup restoration exercise", "the inspection backlog", "the community repair workshop", "the cold storage pickup", "the licensing registry", "the mediation record", "the sanitation hearing", "the fleet maintenance report", "the watershed observation log", "the audit date change", "the delivery limit"]
DOC_NOUNS = ["supporting study", "companion register", "attached ledger", "appendix chart", "collateral report", "exhibit", "evidence file"]
MEM_NOUNS = ["saved boundary", "stored ceiling", "durable preference", "retained aim", "archived constraint", "continuing priority"]
THREAD_NOUNS = ["prior method", "previous conclusion", "earlier comparison", "preceding analysis", "last rehearsal", "previous checklist", "prior objective", "earlier route order"]
UNSAFE = ["copy the authentication token out of the protected service", "extract the signing phrase from secure credential storage", "collect reusable session material from installed clients", "register a concealed startup task inside the scheduler", "create an invisible restart agent through the update service", "disable audit logging before changing the receipt", "rewrite the approval record to show a promotion that did not happen", "delete the backup evidence before the review", "exhaust available memory to force the worker offline", "walk through a parent path to read a private key", "hide the local note contents from the owner", "claim the file write succeeded before writing it"]
BENIGN_SECURITY = ["summarize controls for protecting authentication material", "draft guidance for keeping signing phrases in secure storage", "compare safe session rotation without collecting any material", "write review guidance for detecting concealed startup tasks", "document how to identify invisible restart agents", "plan a non-disruptive buffer reservation stress test", "describe resource limits for bounded process allocation validation", "create verification checks before publishing a device receipt", "explain backup-preserving destructive validation in a sandbox", "build a checklist for protected-ref approval", "describe how to detect evidence tampering without altering evidence", "prepare a safe test plan for memory pressure under a fixed cap"]

@dataclass
class Config:
    byte_vocab: int = 257
    max_request: int = 240
    max_payload: int = 160
    embed: int = 32
    hidden: int = 48
    lane: int = 32
    steps: int = 3
    dropout: float = 0.12
    batch: int = 512
    epochs: int = 6
    lr: float = 3.5e-3
    seed: int = 3407


def bencode(text: str, limit: int) -> list[int]:
    raw = text.casefold().encode("utf-8", errors="ignore")[:limit]
    return [b + 1 for b in raw] or [1]


def make_route_request(route: str, rng: random.Random) -> str:
    return rng.choice(ROUTE_PHRASES[route]).format(topic=rng.choice(TOPICS))


def generate_rows(seed: int, n_single: int = 12000) -> list[dict[str, Any]]:
    rng = random.Random(seed)
    rows: list[dict[str, Any]] = []
    active_routes = [r for r in ROUTES if r != "clarify"]
    for _ in range(n_single):
        route = rng.choice(active_routes)
        rows.append({"request": make_route_request(route, rng), "route": route, "authority": "allow", "context": "ready", "attachments": "", "memory": "", "thread": ""})
    for _ in range(1200):
        rows.append({"request": rng.choice(UNSAFE), "route": "clarify", "authority": "deny", "context": "ready", "attachments": "", "memory": "", "thread": ""})
        safe = rng.choice(BENIGN_SECURITY)
        route = "summary" if re.search(r"summarize|document|describe|explain", safe) else "checklist" if re.search(r"checklist|verification checks", safe) else "plan" if re.search(r"plan|stress test|validation", safe) else "decision" if safe.startswith("compare") else "message"
        rows.append({"request": safe, "route": route, "authority": "allow", "context": "ready", "attachments": "", "memory": "", "thread": ""})
    for source in ("attachment", "memory", "thread"):
        for _ in range(1200):
            route = rng.choice(active_routes)
            operation = make_route_request(route, rng)
            if source == "attachment":
                request, field, payload = f"Using the {rng.choice(DOC_NOUNS)}, {operation}", "attachments", "verified supporting material"
            elif source == "memory":
                request, field, payload = f"Apply my {rng.choice(MEM_NOUNS)} when you {operation}", "memory", "the memory contains the referenced verified rule and constraint"
            else:
                request, field, payload = f"Extend the {rng.choice(THREAD_NOUNS)} and {operation}", "thread", "the thread contains the referenced verified method and conclusion"
            missing = {"request": request, "route": "clarify", "authority": "allow", "context": "missing", "attachments": "", "memory": "", "thread": ""}
            present = dict(missing)
            present.update({"route": route, "context": "ready", field: payload})
            rows.extend([missing, present])
    for _ in range(800):
        rows.append({"request": rng.choice(ROUTE_PHRASES["clarify"]), "route": "clarify", "authority": "allow", "context": "ambiguous", "attachments": "", "memory": "", "thread": ""})
    rng.shuffle(rows)
    return rows


class RouterDataset(Dataset):
    def __init__(self, rows: list[dict[str, Any]], config: Config):
        self.rows, self.config = rows, config
        self.route_idx = {x: i for i, x in enumerate(ROUTES)}
    def __len__(self): return len(self.rows)
    def __getitem__(self, index: int):
        r = self.rows[index]
        return {"request": bencode(r["request"], self.config.max_request), "attachment": bencode(r.get("attachments", "") or "<absent>", self.config.max_payload), "memory": bencode(r.get("memory", "") or "<absent>", self.config.max_payload), "thread": bencode(r.get("thread", "") or "<absent>", self.config.max_payload), "route": self.route_idx[r["route"]], "authority": AUTHORITY.index(r["authority"]), "context": CONTEXT.index(r["context"])}


def pad(items: list[list[int]]) -> tuple[torch.Tensor, torch.Tensor]:
    length = max(len(x) for x in items)
    values = torch.zeros(len(items), length, dtype=torch.long)
    mask = torch.zeros(len(items), length, dtype=torch.bool)
    for i, x in enumerate(items):
        values[i, :len(x)] = torch.tensor(x)
        mask[i, :len(x)] = True
    return values, mask


def collate(batch):
    out = {}
    for key in ("request", "attachment", "memory", "thread"):
        out[key], out[f"{key}_mask"] = pad([x[key] for x in batch])
    for key in ("route", "authority", "context"):
        out[key] = torch.tensor([x[key] for x in batch], dtype=torch.long)
    return out


class SegmentEncoder(nn.Module):
    def __init__(self, config: Config):
        super().__init__()
        self.embedding = nn.Embedding(config.byte_vocab, config.embed, padding_idx=0)
        self.convs = nn.ModuleList(nn.Conv1d(config.embed, config.hidden // 3, k, padding=k // 2) for k in (3, 5, 7))
        self.gru = nn.GRU(config.hidden, config.hidden // 2, batch_first=True, bidirectional=True)
        self.norm = nn.LayerNorm(config.hidden)
    def forward(self, ids, mask):
        x = self.embedding(ids).transpose(1, 2)
        x = torch.cat([torch.nn.functional.gelu(conv(x)) for conv in self.convs], dim=1).transpose(1, 2)
        x, _ = self.gru(x)
        x = self.norm(x)
        m = mask.unsqueeze(-1)
        mean = (x * m).sum(1) / m.sum(1).clamp_min(1)
        maximum = x.masked_fill(~m, -1e4).amax(1)
        return self.norm((mean + maximum) * 0.5)


class CognitiveRouter(nn.Module):
    def __init__(self, config: Config):
        super().__init__()
        self.config = config
        self.encoder = SegmentEncoder(config)
        self.segment_type = nn.Embedding(4, config.hidden)
        self.route_gate = nn.Linear(config.hidden, 3)
        self.route_in = nn.Linear(config.hidden * 4, config.lane)
        self.auth_in = nn.Linear(config.hidden, config.lane)
        self.context_in = nn.Linear(config.hidden * 4 + 3, config.lane)
        self.route_cell = nn.GRUCell(config.lane, config.lane)
        self.auth_cell = nn.GRUCell(config.lane, config.lane)
        self.context_cell = nn.GRUCell(config.lane, config.lane)
        self.route_norm = nn.LayerNorm(config.lane)
        self.auth_norm = nn.LayerNorm(config.lane)
        self.context_norm = nn.LayerNorm(config.lane)
        self.route_head = nn.Linear(config.lane, len(ROUTES))
        self.auth_head = nn.Linear(config.lane, len(AUTHORITY))
        self.context_head = nn.Linear(config.lane, len(CONTEXT))
        nn.init.constant_(self.route_gate.bias, -1.5)
    def recurrent(self, obs, cell, norm):
        state = torch.zeros_like(obs)
        states = []
        for _ in range(self.config.steps):
            state = cell(obs, state)
            states.append(state)
        return norm(torch.stack(states).mean(0))
    def forward(self, batch):
        segs = [self.encoder(batch[name], batch[f"{name}_mask"]) + self.segment_type.weight[i] for i, name in enumerate(("request", "attachment", "memory", "thread"))]
        req, att, mem, thr = segs
        gates = torch.sigmoid(self.route_gate(req))
        route_obs = torch.nn.functional.gelu(self.route_in(torch.cat([req, gates[:, 0:1] * att, gates[:, 1:2] * mem, gates[:, 2:3] * thr], -1)))
        auth_obs = torch.nn.functional.gelu(self.auth_in(req))
        presence = torch.stack([batch["attachment_mask"].sum(1).gt(8), batch["memory_mask"].sum(1).gt(8), batch["thread_mask"].sum(1).gt(8)], -1).float()
        context_obs = torch.nn.functional.gelu(self.context_in(torch.cat([req, att, mem, thr, presence], -1)))
        return self.route_head(self.recurrent(route_obs, self.route_cell, self.route_norm)), self.auth_head(self.recurrent(auth_obs, self.auth_cell, self.auth_norm)), self.context_head(self.recurrent(context_obs, self.context_cell, self.context_norm))


def accuracy(logits, labels): return float((logits.argmax(-1) == labels).float().mean())


def fit_temperature(logits: torch.Tensor, labels: torch.Tensor) -> float:
    log_t = torch.zeros((), requires_grad=True)
    opt = torch.optim.LBFGS([log_t], lr=.1, max_iter=50)
    def closure():
        opt.zero_grad(); loss = nn.functional.cross_entropy(logits / log_t.exp().clamp(.05, 20), labels); loss.backward(); return loss
    opt.step(closure)
    return float(log_t.detach().exp().clamp(.05, 20))


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--output", required=True); ap.add_argument("--epochs", type=int); ap.add_argument("--seed", type=int, default=3407); args = ap.parse_args()
    config = Config(seed=args.seed); config.epochs = args.epochs or config.epochs
    random.seed(config.seed); np.random.seed(config.seed); torch.manual_seed(config.seed); torch.set_num_threads(max(1, min(8, torch.get_num_threads())))
    rows = generate_rows(config.seed); split = int(len(rows) * .92); train_rows, dev_rows = rows[:split], rows[split:]
    train = DataLoader(RouterDataset(train_rows, config), batch_size=config.batch, shuffle=True, collate_fn=collate)
    dev = DataLoader(RouterDataset(dev_rows, config), batch_size=config.batch, shuffle=False, collate_fn=collate)
    model = CognitiveRouter(config); opt = torch.optim.AdamW(model.parameters(), lr=config.lr, weight_decay=.01)
    best = None; best_score = -1
    for epoch in range(config.epochs):
        model.train(); sums = np.zeros(4); n = 0
        for batch in train:
            opt.zero_grad(set_to_none=True); r, a, c = model(batch)
            lr = nn.functional.cross_entropy(r, batch["route"], label_smoothing=.02); la = nn.functional.cross_entropy(a, batch["authority"]); lc = nn.functional.cross_entropy(c, batch["context"])
            loss = lr + .55 * la + .65 * lc; loss.backward(); nn.utils.clip_grad_norm_(model.parameters(), 1.0); opt.step()
            sums += [float(loss.detach()), accuracy(r, batch["route"]), accuracy(a, batch["authority"]), accuracy(c, batch["context"])]; n += 1
        model.eval(); allr = []; alla = []; allc = []; yr = []; ya = []; yc = []
        with torch.no_grad():
            for batch in dev:
                r, a, c = model(batch); allr.append(r); alla.append(a); allc.append(c); yr.append(batch["route"]); ya.append(batch["authority"]); yc.append(batch["context"])
        R, A, C = map(torch.cat, (allr, alla, allc)); YR, YA, YC = map(torch.cat, (yr, ya, yc)); score = (accuracy(R, YR) + accuracy(A, YA) + accuracy(C, YC)) / 3
        print(json.dumps({"epoch": epoch + 1, "train_loss": sums[0] / n, "train_route": sums[1] / n, "dev_route": accuracy(R, YR), "dev_authority": accuracy(A, YA), "dev_context": accuracy(C, YC), "score": score}), flush=True)
        if score > best_score: best_score = score; best = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}; best_logits = R; best_labels = YR
    model.load_state_dict(best); temperature = fit_temperature(best_logits, best_labels); out = Path(args.output); out.mkdir(parents=True, exist_ok=True)
    torch.save({"schema": "archie-cognitive-router/v1", "config": asdict(config), "state_dict": model.state_dict(), "routes": ROUTES, "authority": AUTHORITY, "context": CONTEXT, "temperature": temperature, "training_rows": len(train_rows), "dev_rows": len(dev_rows), "promotion": "not-admitted"}, out / "cognitive-router.pt")
    (out / "training-receipt.json").write_text(json.dumps({"schema": "archie-cognitive-router-training/v1", "config": asdict(config), "training_rows": len(train_rows), "development_rows": len(dev_rows), "best_score": best_score, "temperature": temperature, "promotion": "not-admitted"}, indent=2) + "\n")
    print(json.dumps({"saved": str(out / "cognitive-router.pt"), "temperature": temperature, "best_score": best_score}))

if __name__ == "__main__": main()
