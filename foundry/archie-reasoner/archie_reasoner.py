#!/usr/bin/env python3
"""Core data, tokenizer, model, decoding, calibration, and receipt helpers for Archie Reasoner.

This module never downloads a model or dataset. Every training/evaluation byte must be supplied
by the caller. The generated student is research-only and remains promotion:not-admitted.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import random
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Sequence

ROUTES = (
    "checklist", "clarify", "compound", "decision", "errands", "event",
    "message", "next_action", "objective", "plan", "study", "summary",
)

ROUTE_PROTOCOL: dict[str, tuple[str, ...]] = {
    "summary": ("OBSERVE", "DRAFT", "STOP"),
    "checklist": ("OBSERVE", "DECOMPOSE", "DRAFT", "STOP"),
    "message": ("OBSERVE", "DRAFT", "STOP"),
    "decision": ("OBSERVE", "COMPARE", "DRAFT", "STOP"),
    "study": ("RETRIEVE", "DECOMPOSE", "ORDER", "SCHEDULE", "STOP"),
    "event": ("OBSERVE", "DECOMPOSE", "ORDER", "SCHEDULE", "STOP"),
    "errands": ("OBSERVE", "ORDER", "SCHEDULE", "STOP"),
    "plan": ("RETRIEVE", "DECOMPOSE", "ORDER", "DRAFT", "STOP"),
    "next_action": ("OBSERVE", "DECOMPOSE", "STOP"),
    "compound": ("OBSERVE", "DECOMPOSE", "ORDER", "SCHEDULE", "STOP"),
    "objective": ("OBSERVE", "DRAFT", "VERIFY", "STOP"),
    "clarify": ("ASK", "STOP"),
}

RESPONSE_ACTION = {
    "summary": "summarize",
    "checklist": "make_checklist",
    "message": "draft_message",
    "decision": "compare_and_recommend",
    "study": "build_study_plan",
    "event": "schedule_event",
    "errands": "order_errands",
    "plan": "build_plan",
    "next_action": "select_next_action",
    "compound": "compose_ordered_actions",
    "objective": "define_objective",
    "clarify": "ask_clarifying_question",
}

AUTHORITY_LABELS = ("allow", "deny")
CONTEXT_LABELS = ("ready", "missing", "ambiguous")
DEFAULT_TRANSFORMS = ("direct", "rewrite", "continue", "grounded", "compound")

SPECIAL_TOKENS = (
    "<PAD>", "<UNK>", "<BOS>", "<EOS>",
    "<REQUEST>", "<ATTACHMENT>", "<MEMORY>", "<THREAD>",
    "<TASK_GRAPH>", "</TASK_GRAPH>", "<PLAN>", "</PLAN>", "<CLARIFY>",
)

_TAG_RE = re.compile(
    r"<TASK_GRAPH>(?P<graph>.*?)</TASK_GRAPH>\s*<PLAN>(?P<plan>.*?)</PLAN>",
    re.DOTALL,
)


@dataclass(frozen=True)
class ModelConfig:
    vocab_size: int = 8192
    max_source_tokens: int = 256
    max_target_tokens: int = 192
    d_model: int = 256
    encoder_layers: int = 4
    decoder_layers: int = 4
    dim_feedforward: int = 768
    dropout: float = 0.10
    epochs: int = 8
    batch_size: int = 48
    learning_rate: float = 3e-4
    weight_decay: float = 0.01
    warmup_fraction: float = 0.06
    grad_clip: float = 1.0
    grad_accumulation: int = 1
    label_smoothing: float = 0.05
    route_loss_weight: float = 0.45
    authority_loss_weight: float = 0.25
    context_loss_weight: float = 0.25
    transform_loss_weight: float = 0.10
    generation_loss_weight: float = 1.0
    dev_fraction: float = 0.10
    seed: int = 3407


PRESETS: dict[str, ModelConfig] = {
    "diagnostic": ModelConfig(
        vocab_size=4096, max_source_tokens=192, max_target_tokens=128,
        d_model=128, encoder_layers=2, decoder_layers=2,
        dim_feedforward=384, epochs=2, batch_size=128,
    ),
    "small": ModelConfig(
        vocab_size=6144, max_source_tokens=224, max_target_tokens=160,
        d_model=192, encoder_layers=3, decoder_layers=3,
        dim_feedforward=576, epochs=8, batch_size=64,
    ),
    "full": ModelConfig(),
    "large": ModelConfig(
        vocab_size=12000, max_source_tokens=320, max_target_tokens=224,
        d_model=384, encoder_layers=6, decoder_layers=6,
        dim_feedforward=1152, epochs=8, batch_size=24,
        grad_accumulation=2,
    ),
}


def require_training_dependencies():
    try:
        import sentencepiece as spm  # type: ignore
        import torch  # type: ignore
        from torch import nn  # noqa: F401
    except Exception as exc:  # pragma: no cover - dependency error is environment-specific
        raise RuntimeError(
            "Archie Reasoner training requires torch and sentencepiece. "
            "Install foundry/archie-reasoner/requirements.txt; no network access is used at runtime."
        ) from exc
    return torch, spm


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_json(value: Any) -> str:
    return sha256_bytes(canonical_json(value).encode("utf-8"))


def sha256_file(path: os.PathLike[str] | str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def normalize_prompt(text: Any) -> str:
    return " ".join(str(text or "").casefold().split())


def read_records(path: os.PathLike[str] | str) -> list[dict[str, Any]]:
    source = Path(path)
    text = source.read_text(encoding="utf-8").strip()
    if not text:
        return []
    if source.suffix.lower() == ".jsonl":
        return [json.loads(line) for line in text.splitlines() if line.strip()]
    value = json.loads(text)
    if isinstance(value, list):
        return [dict(item) for item in value]
    for key in ("rows", "cases", "examples", "data"):
        if isinstance(value, dict) and isinstance(value.get(key), list):
            return [dict(item) for item in value[key]]
    raise ValueError(f"{source} must contain a JSON array or JSONL records")


def prompt_from_row(row: Mapping[str, Any]) -> str:
    for key in ("prompt", "text", "request", "input"):
        if row.get(key) is not None:
            return str(row[key])
    raise ValueError("record is missing prompt/text/request/input")


def route_from_row(row: Mapping[str, Any]) -> str:
    route = str(row.get("route") or row.get("expected") or row.get("label") or "").strip()
    if route not in ROUTES:
        raise ValueError(f"unsupported route {route!r}")
    return route


def attachment_names(row: Mapping[str, Any]) -> list[str]:
    raw = row.get("attachments", row.get("files", row.get("attached_files", [])))
    if raw is None:
        return []
    if not isinstance(raw, list):
        raw = [raw]
    names: list[str] = []
    for item in raw[:8]:
        if isinstance(item, str):
            name = item
        elif isinstance(item, Mapping):
            name = str(item.get("name") or item.get("filename") or item.get("type") or "")
        else:
            name = str(item)
        if name.strip():
            names.append(name.strip())
    if not names and (row.get("has_attachment") or row.get("has_file")):
        names.append("attachment")
    return names


def memory_text(row: Mapping[str, Any]) -> str:
    raw = row.get("memory", row.get("memories", row.get("context", {}).get("memory") if isinstance(row.get("context"), Mapping) else ""))
    if isinstance(raw, list):
        return " ".join(str(item) for item in raw[:4] if str(item).strip())
    return str(raw or "").strip()


def authority_from_row(row: Mapping[str, Any]) -> str:
    raw = row.get("authority")
    if isinstance(raw, Mapping):
        raw = raw.get("decision", raw.get("status"))
    if isinstance(raw, bool):
        return "allow" if raw else "deny"
    value = str(raw or "").strip().casefold()
    if value in {"deny", "denied", "forbid", "forbidden", "blocked", "false", "0"}:
        return "deny"
    if row.get("authority_denied") or row.get("permission_denied"):
        return "deny"
    return "allow"


def context_state_from_row(row: Mapping[str, Any], route: str) -> str:
    raw = row.get("context_state", row.get("context_status", ""))
    value = str(raw or "").strip().casefold()
    if value in CONTEXT_LABELS:
        return value
    if row.get("context_missing") or row.get("missing_context") or row.get("missing_fields"):
        return "missing"
    if row.get("context_ambiguous") or row.get("ambiguous"):
        return "ambiguous"
    # Clarify is authority-allow with unresolved context unless an explicit state says otherwise.
    if route == "clarify":
        return "missing"
    return "ready"


def transform_from_row(row: Mapping[str, Any]) -> str:
    metadata = row.get("metadata") if isinstance(row.get("metadata"), Mapping) else {}
    raw = row.get("transform_type", metadata.get("transform_type", metadata.get("transform", "direct")))
    value = re.sub(r"[^a-z0-9_-]+", "_", str(raw or "direct").casefold()).strip("_")
    return value or "direct"


def source_text(row: Mapping[str, Any]) -> str:
    parts = ["<REQUEST>", prompt_from_row(row).strip()]
    names = attachment_names(row)
    if names:
        parts.extend(["<ATTACHMENT>", " | ".join(names)])
    memory = memory_text(row)
    if memory:
        parts.extend(["<MEMORY>", memory])
    context = row.get("context")
    if row.get("reply_to") or row.get("thread") or (isinstance(context, Mapping) and context.get("thread")):
        parts.append("<THREAD>")
    return " ".join(part for part in parts if part)


def _protocol_nodes(protocol: Sequence[str]) -> list[list[str]]:
    nodes: list[list[str]] = []
    previous = "request"
    for index, opcode in enumerate(protocol):
        output = "response" if opcode in {"DRAFT", "STOP"} else f"state:{index}"
        nodes.append([opcode.casefold(), previous, output])
        previous = output
    return nodes


def target_objects(row: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    original_route = route_from_row(row)
    authority = authority_from_row(row)
    context_state = context_state_from_row(row, original_route)
    forced_clarify = authority == "deny" or context_state != "ready"
    route = "clarify" if forced_clarify else original_route
    grounding = ["request"]
    names = attachment_names(row)
    grounding.extend(f"attachment:{index}" for index in range(len(names)))
    if memory_text(row):
        grounding.append("memory")
    graph = {
        "authority": authority,
        "context": context_state,
        "nodes": _protocol_nodes(ROUTE_PROTOCOL[route]),
        "route": route,
        "transform": transform_from_row(row),
    }
    plan = {
        "grounding": grounding,
        "must_clarify": forced_clarify,
        "response_action": RESPONSE_ACTION[route],
    }
    return graph, plan


def target_text(row: Mapping[str, Any]) -> str:
    graph, plan = target_objects(row)
    prefix = "<CLARIFY>" if plan["must_clarify"] else ""
    return (
        f"{prefix}<TASK_GRAPH>{canonical_json(graph)}</TASK_GRAPH>"
        f"<PLAN>{canonical_json(plan)}</PLAN>"
    )


def parse_target(text: str) -> tuple[dict[str, Any], dict[str, Any]] | None:
    match = _TAG_RE.search(text)
    if not match:
        return None
    try:
        graph = json.loads(match.group("graph"))
        plan = json.loads(match.group("plan"))
    except json.JSONDecodeError:
        return None
    if not isinstance(graph, dict) or not isinstance(plan, dict):
        return None
    if graph.get("route") not in ROUTES:
        return None
    if graph.get("authority") not in AUTHORITY_LABELS:
        return None
    if graph.get("context") not in CONTEXT_LABELS:
        return None
    if plan.get("response_action") not in RESPONSE_ACTION.values():
        return None
    return graph, plan


def clarify_output(reason: str, transform: str = "direct") -> dict[str, Any]:
    graph = {
        "authority": "deny" if reason == "authority_denied" else "allow",
        "context": "missing" if reason != "authority_denied" else "ready",
        "nodes": _protocol_nodes(ROUTE_PROTOCOL["clarify"]),
        "route": "clarify",
        "transform": transform,
    }
    plan = {
        "grounding": ["request"],
        "must_clarify": True,
        "response_action": RESPONSE_ACTION["clarify"],
        "reason": reason,
    }
    return {"graph": graph, "plan": plan, "decision_source": "fail_closed_gate"}


def apply_fail_closed(
    decoded_text: str,
    authority_index: int,
    context_index: int,
    transform: str = "direct",
) -> dict[str, Any]:
    authority = AUTHORITY_LABELS[authority_index]
    context = CONTEXT_LABELS[context_index]
    if authority == "deny":
        return clarify_output("authority_denied", transform)
    if context != "ready":
        return clarify_output("context_missing", transform)
    parsed = parse_target(decoded_text)
    if parsed is None:
        return clarify_output("invalid_generation", transform)
    graph, plan = parsed
    if graph["authority"] == "deny" or graph["context"] != "ready" or plan.get("must_clarify"):
        return clarify_output("generated_abstention", str(graph.get("transform") or transform))
    return {"graph": graph, "plan": plan, "decision_source": "model"}


def frozen_prompt_set(paths: Iterable[os.PathLike[str] | str]) -> set[str]:
    frozen: set[str] = set()
    for path in paths:
        if not path:
            continue
        source = Path(path)
        if not source.exists():
            continue
        for row in read_records(source):
            try:
                frozen.add(normalize_prompt(prompt_from_row(row)))
            except ValueError:
                continue
    return frozen


def filter_frozen_rows(rows: Sequence[dict[str, Any]], frozen: set[str]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    kept: list[dict[str, Any]] = []
    removed: list[dict[str, Any]] = []
    for row in rows:
        bucket = removed if normalize_prompt(prompt_from_row(row)) in frozen else kept
        bucket.append(row)
    return kept, removed


def stratified_split(
    rows: Sequence[dict[str, Any]],
    dev_fraction: float,
    seed: int,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    by_route: dict[str, list[dict[str, Any]]] = {route: [] for route in ROUTES}
    for row in rows:
        by_route[route_from_row(row)].append(row)
    train: list[dict[str, Any]] = []
    dev: list[dict[str, Any]] = []
    for route_index, route in enumerate(ROUTES):
        group = list(by_route[route])
        random.Random(seed + route_index * 7919).shuffle(group)
        if len(group) <= 1:
            train.extend(group)
            continue
        count = max(1, min(len(group) - 1, round(len(group) * dev_fraction)))
        dev.extend(group[:count])
        train.extend(group[count:])
    random.Random(seed).shuffle(train)
    random.Random(seed + 1).shuffle(dev)
    return train, dev


class SentencePieceTokenizer:
    def __init__(self, model_path: os.PathLike[str] | str):
        _, spm = require_training_dependencies()
        self.model_path = str(model_path)
        self.processor = spm.SentencePieceProcessor(model_file=self.model_path)
        self.pad_id = self.processor.pad_id()
        self.unk_id = self.processor.unk_id()
        self.bos_id = self.processor.bos_id()
        self.eos_id = self.processor.eos_id()
        self.special_ids = {token: self.processor.piece_to_id(token) for token in SPECIAL_TOKENS[4:]}
        missing = [token for token, token_id in self.special_ids.items() if token_id < 0]
        if missing:
            raise RuntimeError(f"tokenizer missing special symbols: {missing}")

    @property
    def vocab_size(self) -> int:
        return self.processor.vocab_size()

    def encode(self, text: str, max_length: int, add_bos: bool = True, add_eos: bool = True) -> list[int]:
        ids = list(self.processor.encode(text, out_type=int))
        if add_bos and self.bos_id >= 0:
            ids.insert(0, self.bos_id)
        if add_eos and self.eos_id >= 0:
            ids.append(self.eos_id)
        if len(ids) > max_length:
            ids = ids[:max_length]
            if add_eos and self.eos_id >= 0:
                ids[-1] = self.eos_id
        return ids

    def decode(self, ids: Sequence[int]) -> str:
        clean = [int(value) for value in ids if int(value) >= 0 and int(value) != self.pad_id]
        return self.processor.decode(clean)


def train_sentencepiece(
    rows: Sequence[dict[str, Any]],
    output_prefix: os.PathLike[str] | str,
    vocab_size: int,
) -> Path:
    _, spm = require_training_dependencies()
    prefix = Path(output_prefix)
    prefix.parent.mkdir(parents=True, exist_ok=True)
    corpus_path = prefix.with_suffix(".corpus.txt")
    # Training-only text. Frozen evaluation prompts must already have been removed.
    lines: list[str] = []
    for row in rows:
        lines.append(source_text(row).replace("\n", " "))
        lines.append(target_text(row).replace("\n", " "))
    corpus_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    spm.SentencePieceTrainer.train(
        input=str(corpus_path),
        model_prefix=str(prefix),
        vocab_size=int(vocab_size),
        model_type="unigram",
        character_coverage=1.0,
        pad_id=0,
        unk_id=1,
        bos_id=2,
        eos_id=3,
        pad_piece="<PAD>",
        unk_piece="<UNK>",
        bos_piece="<BOS>",
        eos_piece="<EOS>",
        user_defined_symbols=list(SPECIAL_TOKENS[4:]),
        hard_vocab_limit=False,
        shuffle_input_sentence=False,
        input_sentence_size=0,
        num_threads=1,
    )
    return prefix.with_suffix(".model")


class ReasonerDataset:
    def __init__(
        self,
        rows: Sequence[dict[str, Any]],
        tokenizer: SentencePieceTokenizer,
        config: ModelConfig,
        transform_labels: Sequence[str],
    ):
        torch, _ = require_training_dependencies()
        self.torch = torch
        self.rows = list(rows)
        self.tokenizer = tokenizer
        self.config = config
        self.route_index = {label: index for index, label in enumerate(ROUTES)}
        self.transform_index = {label: index for index, label in enumerate(transform_labels)}

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, index: int) -> dict[str, Any]:
        row = self.rows[index]
        route = route_from_row(row)
        authority = authority_from_row(row)
        context = context_state_from_row(row, route)
        forced_route = "clarify" if authority == "deny" or context != "ready" else route
        source_ids = self.tokenizer.encode(source_text(row), self.config.max_source_tokens)
        target_ids = self.tokenizer.encode(target_text(row), self.config.max_target_tokens)
        return {
            "source_ids": source_ids,
            "target_ids": target_ids,
            "route": self.route_index[forced_route],
            "authority": AUTHORITY_LABELS.index(authority),
            "context": CONTEXT_LABELS.index(context),
            "transform": self.transform_index[transform_from_row(row)],
            "row": row,
        }


def collate_reasoner(batch: Sequence[dict[str, Any]], pad_id: int):
    torch, _ = require_training_dependencies()
    source_length = max(len(item["source_ids"]) for item in batch)
    target_length = max(len(item["target_ids"]) for item in batch)
    source = torch.full((len(batch), source_length), pad_id, dtype=torch.long)
    target = torch.full((len(batch), target_length), pad_id, dtype=torch.long)
    for row_index, item in enumerate(batch):
        source[row_index, : len(item["source_ids"])] = torch.tensor(item["source_ids"], dtype=torch.long)
        target[row_index, : len(item["target_ids"])] = torch.tensor(item["target_ids"], dtype=torch.long)
    return {
        "source_ids": source,
        "target_ids": target,
        "source_padding": source.eq(pad_id),
        "target_padding": target.eq(pad_id),
        "route": torch.tensor([item["route"] for item in batch], dtype=torch.long),
        "authority": torch.tensor([item["authority"] for item in batch], dtype=torch.long),
        "context": torch.tensor([item["context"] for item in batch], dtype=torch.long),
        "transform": torch.tensor([item["transform"] for item in batch], dtype=torch.long),
        "rows": [item["row"] for item in batch],
    }



def build_model_class():
    torch, _ = require_training_dependencies()
    nn = torch.nn

    class ArchieReasoner(nn.Module):
        """Bidirectional GRU encoder plus attention-conditioned GRU decoder.

        This architecture keeps full autoregressive generation linear in target length on CPU.
        The encoder memory is computed once; each decoder step reuses its recurrent state instead
        of rerunning an entire transformer prefix.
        """

        def __init__(
            self,
            vocab_size: int,
            pad_id: int,
            transform_classes: int,
            config: ModelConfig,
        ):
            super().__init__()
            if config.d_model % 2:
                raise ValueError("d_model must be even for the bidirectional encoder")
            self.config = config
            self.pad_id = pad_id
            self.token_embedding = nn.Embedding(vocab_size, config.d_model, padding_idx=pad_id)
            encoder_dropout = config.dropout if config.encoder_layers > 1 else 0.0
            decoder_dropout = config.dropout if config.decoder_layers > 1 else 0.0
            self.encoder = nn.GRU(
                input_size=config.d_model,
                hidden_size=config.d_model // 2,
                num_layers=config.encoder_layers,
                dropout=encoder_dropout,
                bidirectional=True,
                batch_first=True,
            )
            self.encoder_norm = nn.LayerNorm(config.d_model)
            self.decoder = nn.GRU(
                input_size=config.d_model * 2,
                hidden_size=config.d_model,
                num_layers=config.decoder_layers,
                dropout=decoder_dropout,
                batch_first=True,
            )
            self.initial_hidden = nn.Linear(
                config.d_model,
                config.decoder_layers * config.d_model,
            )
            self.attention_query = nn.Linear(config.d_model, config.d_model, bias=False)
            self.fusion = nn.Sequential(
                nn.Linear(config.d_model * 2, config.dim_feedforward),
                nn.GELU(),
                nn.Dropout(config.dropout),
                nn.Linear(config.dim_feedforward, config.d_model),
                nn.Tanh(),
            )
            self.final_norm = nn.LayerNorm(config.d_model)
            self.lm_head = nn.Linear(config.d_model, vocab_size, bias=False)
            self.lm_head.weight = self.token_embedding.weight
            self.route_head = nn.Linear(config.d_model, len(ROUTES))
            self.authority_head = nn.Linear(config.d_model, len(AUTHORITY_LABELS))
            self.context_head = nn.Linear(config.d_model, len(CONTEXT_LABELS))
            self.transform_head = nn.Linear(config.d_model, transform_classes)
            self._reset_parameters()

        def _reset_parameters(self) -> None:
            for name, parameter in self.named_parameters():
                if parameter.dim() > 1 and "token_embedding" not in name and "lm_head" not in name:
                    nn.init.xavier_uniform_(parameter)

        def encode(self, source_ids, source_padding):
            lengths = (~source_padding).sum(dim=1).clamp_min(1).cpu()
            embedded = self.token_embedding(source_ids)
            packed = nn.utils.rnn.pack_padded_sequence(
                embedded,
                lengths,
                batch_first=True,
                enforce_sorted=False,
            )
            packed_memory, _ = self.encoder(packed)
            memory, _ = nn.utils.rnn.pad_packed_sequence(
                packed_memory,
                batch_first=True,
                total_length=source_ids.size(1),
            )
            memory = self.encoder_norm(memory)
            valid = (~source_padding).unsqueeze(-1)
            pooled = (memory * valid).sum(dim=1) / valid.sum(dim=1).clamp_min(1)
            pooled = self.encoder_norm(pooled)
            return memory, pooled

        def _decoder_hidden(self, pooled):
            batch = pooled.size(0)
            hidden = self.initial_hidden(pooled)
            hidden = hidden.view(batch, self.config.decoder_layers, self.config.d_model)
            return hidden.transpose(0, 1).contiguous()

        def _attend(self, decoder_states, memory, source_padding):
            query = self.attention_query(decoder_states)
            scores = torch.bmm(query, memory.transpose(1, 2)) / math.sqrt(self.config.d_model)
            scores = scores.masked_fill(source_padding.unsqueeze(1), torch.finfo(scores.dtype).min)
            weights = torch.softmax(scores, dim=-1)
            context = torch.bmm(weights, memory)
            return self.fusion(torch.cat([decoder_states, context], dim=-1))

        def forward(self, source_ids, target_input_ids, source_padding, target_padding):
            memory, pooled = self.encode(source_ids, source_padding)
            target = self.token_embedding(target_input_ids)
            target = target.masked_fill(target_padding.unsqueeze(-1), 0.0)
            repeated = pooled.unsqueeze(1).expand(-1, target.size(1), -1)
            decoder_input = torch.cat([target, repeated], dim=-1)
            decoder_states, _ = self.decoder(decoder_input, self._decoder_hidden(pooled))
            fused = self.final_norm(self._attend(decoder_states, memory, source_padding))
            return {
                "token_logits": self.lm_head(fused),
                "route_logits": self.route_head(pooled),
                "authority_logits": self.authority_head(pooled),
                "context_logits": self.context_head(pooled),
                "transform_logits": self.transform_head(pooled),
            }

        @torch.no_grad()
        def generate(self, source_ids, source_padding, bos_id: int, eos_id: int, max_tokens: int):
            self.eval()
            memory, pooled = self.encode(source_ids, source_padding)
            hidden = self._decoder_hidden(pooled)
            previous = torch.full(
                (source_ids.size(0),),
                bos_id,
                dtype=torch.long,
                device=source_ids.device,
            )
            generated = [previous]
            done = torch.zeros(source_ids.size(0), dtype=torch.bool, device=source_ids.device)
            for _ in range(max_tokens - 1):
                token = self.token_embedding(previous).unsqueeze(1)
                decoder_input = torch.cat([token, pooled.unsqueeze(1)], dim=-1)
                decoder_state, hidden = self.decoder(decoder_input, hidden)
                fused = self.final_norm(self._attend(decoder_state, memory, source_padding))
                next_token = self.lm_head(fused[:, 0]).argmax(dim=-1)
                next_token = torch.where(done, torch.full_like(next_token, eos_id), next_token)
                generated.append(next_token)
                done |= next_token.eq(eos_id)
                previous = next_token
                if bool(done.all()):
                    break
            return {
                "generated_ids": torch.stack(generated, dim=1),
                "route_logits": self.route_head(pooled),
                "authority_logits": self.authority_head(pooled),
                "context_logits": self.context_head(pooled),
                "transform_logits": self.transform_head(pooled),
            }

    return ArchieReasoner

def parameter_count(model: Any) -> int:
    return sum(parameter.numel() for parameter in model.parameters())


def cosine_with_warmup(step: int, total_steps: int, warmup_steps: int) -> float:
    if total_steps <= 0:
        return 1.0
    if step < warmup_steps:
        return max(1e-8, step / max(1, warmup_steps))
    progress = (step - warmup_steps) / max(1, total_steps - warmup_steps)
    return 0.5 * (1.0 + math.cos(math.pi * min(1.0, progress)))


def fit_temperature(logits: Any, labels: Any) -> float:
    """Fit one positive scalar on development route logits to minimize NLL."""
    torch, _ = require_training_dependencies()
    if logits.numel() == 0:
        return 1.0
    log_temperature = torch.zeros((), dtype=torch.float32, requires_grad=True, device=logits.device)
    optimizer = torch.optim.LBFGS([log_temperature], lr=0.1, max_iter=50, line_search_fn="strong_wolfe")

    def closure():
        optimizer.zero_grad(set_to_none=True)
        temperature = log_temperature.exp().clamp(0.05, 20.0)
        loss = torch.nn.functional.cross_entropy(logits / temperature, labels)
        loss.backward()
        return loss

    optimizer.step(closure)
    return float(log_temperature.detach().exp().clamp(0.05, 20.0).cpu())


def route_metrics(predictions: Sequence[str], expected: Sequence[str]) -> dict[str, Any]:
    correct = sum(prediction == label for prediction, label in zip(predictions, expected))
    by_route: dict[str, dict[str, int]] = {}
    for prediction, label in zip(predictions, expected):
        bucket = by_route.setdefault(label, {"cases": 0, "correct": 0})
        bucket["cases"] += 1
        bucket["correct"] += int(prediction == label)
    return {
        "examples": len(expected),
        "accuracy": correct / max(1, len(expected)),
        "by_route": {
            route: {
                **counts,
                "accuracy": counts["correct"] / max(1, counts["cases"]),
            }
            for route, counts in sorted(by_route.items())
        },
    }


def write_receipt(path: os.PathLike[str] | str, body: Mapping[str, Any]) -> dict[str, Any]:
    payload = dict(body)
    payload["receipt_digest"] = sha256_json(payload)
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return payload


def config_dict(config: ModelConfig) -> dict[str, Any]:
    return asdict(config)
