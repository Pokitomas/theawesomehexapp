#!/usr/bin/env python3
"""Typed recurrent controller for Archie Reasoner.

The controller keeps request, attachment, memory, and thread representations in
separate recurrent lanes. Authority is computed only from the request lane;
route selection may consult contextual lanes only through request-conditioned
residual gates. A bounded recurrent workspace performs several shared-weight
updates before the existing typed decoder runs.

This module is installed by ``train-kimi-reasoner.py`` without changing the
admitted runtime. Produced checkpoints remain research-only/not-admitted.
"""
from __future__ import annotations

import math
from typing import Any, Mapping

SEGMENT_TOKENS = ("<REQUEST>", "<ATTACHMENT>", "<MEMORY>", "<THREAD>")
STATE_TOKENS = ("<ABSENT>", "<PRESENT>")
_SPECIAL_IDS: dict[str, int] = {}


def configure_special_ids(values: Mapping[str, int]) -> None:
    """Bind tokenizer IDs used to derive hard segment masks."""
    required = (*SEGMENT_TOKENS, *STATE_TOKENS)
    missing = [token for token in required if int(values.get(token, -1)) < 0]
    if missing:
        raise RuntimeError(f"typed controller tokenizer is missing symbols: {missing}")
    _SPECIAL_IDS.clear()
    _SPECIAL_IDS.update({token: int(values[token]) for token in required})


def _thread_text(row: Mapping[str, Any]) -> str:
    value = row.get("thread", row.get("reply_to", ""))
    context = row.get("context")
    if not value and isinstance(context, Mapping):
        value = context.get("thread", "")
    if isinstance(value, list):
        return " ".join(str(item) for item in value[:8] if str(item).strip())
    if isinstance(value, Mapping):
        return " ".join(str(item) for item in list(value.values())[:8] if str(item).strip())
    return str(value or "").strip()


def structured_source_text(reasoner: Any, row: Mapping[str, Any]) -> str:
    """Serialize every source channel explicitly, including verified absence."""
    request = reasoner.prompt_from_row(row).strip()
    attachments = reasoner.attachment_names(row)
    memory = reasoner.memory_text(row)
    thread = _thread_text(row)

    def channel(marker: str, present: bool, payload: str) -> list[str]:
        state = "<PRESENT>" if present else "<ABSENT>"
        return [marker, state, payload] if present and payload else [marker, state]

    parts = ["<REQUEST>", request]
    parts.extend(channel("<ATTACHMENT>", bool(attachments), " | ".join(attachments)))
    parts.extend(channel("<MEMORY>", bool(memory), memory))
    parts.extend(channel("<THREAD>", bool(thread), thread))
    return " ".join(part for part in parts if part)


def build_controller_class(reasoner: Any, *, reasoning_steps: int = 4):
    """Return a trainer-compatible block-sparse recurrent reasoner class."""
    torch, _ = reasoner.require_training_dependencies()
    nn = torch.nn
    routes = tuple(reasoner.ROUTES)
    authority_labels = tuple(reasoner.AUTHORITY_LABELS)
    context_labels = tuple(reasoner.CONTEXT_LABELS)

    class LaneHead(nn.Module):
        def __init__(self, lane: int, lane_dim: int, classes: int):
            super().__init__()
            self.start = lane * lane_dim
            self.end = self.start + lane_dim
            self.linear = nn.Linear(lane_dim, classes)

        def forward(self, state):
            return self.linear(state[..., self.start:self.end])

    class TypedRecurrentReasoner(nn.Module):
        """Hard-isolated segment encoder plus bounded recurrent workspace."""

        controller_schema = "archie-typed-recurrent-controller/v1"

        def __init__(self, vocab_size: int, pad_id: int, transform_classes: int, config: Any):
            super().__init__()
            if config.d_model % 4:
                raise ValueError("d_model must be divisible by four typed controller lanes")
            if not _SPECIAL_IDS:
                raise RuntimeError("configure_special_ids must run before model construction")
            self.config = config
            self.pad_id = int(pad_id)
            self.reasoning_steps = int(reasoning_steps)
            self.lane_dim = config.d_model // 4
            self.marker_ids = tuple(_SPECIAL_IDS[token] for token in SEGMENT_TOKENS)

            self.token_embedding = nn.Embedding(vocab_size, config.d_model, padding_idx=pad_id)
            self.segment_embedding = nn.Embedding(4, config.d_model)
            encoder_dropout = config.dropout if config.encoder_layers > 1 else 0.0
            decoder_dropout = config.dropout if config.decoder_layers > 1 else 0.0
            self.segment_encoder = nn.GRU(
                input_size=config.d_model,
                hidden_size=config.d_model // 2,
                num_layers=config.encoder_layers,
                dropout=encoder_dropout,
                bidirectional=True,
                batch_first=True,
            )
            self.encoder_norm = nn.LayerNorm(config.d_model)
            self.segment_queries = nn.Parameter(torch.empty(4, config.d_model))

            d = self.lane_dim
            self.request_projection = nn.Linear(config.d_model, d)
            self.attachment_projection = nn.Linear(config.d_model, d)
            self.memory_projection = nn.Linear(config.d_model, d)
            self.thread_projection = nn.Linear(config.d_model, d)
            self.route_gate = nn.Linear(config.d_model, 3)
            self.route_observation = nn.Sequential(
                nn.Linear(d * 4, d * 2), nn.GELU(), nn.Dropout(config.dropout), nn.Linear(d * 2, d)
            )
            self.authority_observation = nn.Sequential(
                nn.Linear(config.d_model, d * 2), nn.GELU(), nn.Dropout(config.dropout), nn.Linear(d * 2, d)
            )
            self.context_observation = nn.Sequential(
                nn.Linear(d * 4, d * 2), nn.GELU(), nn.Dropout(config.dropout), nn.Linear(d * 2, d)
            )
            self.transform_observation = nn.Sequential(
                nn.Linear(config.d_model, d * 2), nn.GELU(), nn.Dropout(config.dropout), nn.Linear(d * 2, d)
            )
            self.cells = nn.ModuleList(nn.GRUCell(d, d) for _ in range(4))
            self.halt_heads = nn.ModuleList(nn.Linear(d, 1) for _ in range(4))
            self.lane_norms = nn.ModuleList(nn.LayerNorm(d) for _ in range(4))

            self.decoder = nn.GRU(
                input_size=config.d_model * 2,
                hidden_size=config.d_model,
                num_layers=config.decoder_layers,
                dropout=decoder_dropout,
                batch_first=True,
            )
            self.initial_hidden = nn.Linear(config.d_model, config.decoder_layers * config.d_model)
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
            self.route_head = LaneHead(0, d, len(routes))
            self.authority_head = LaneHead(1, d, len(authority_labels))
            self.context_head = LaneHead(2, d, len(context_labels))
            self.transform_head = LaneHead(3, d, transform_classes)
            self._reset_parameters()

        def _reset_parameters(self) -> None:
            nn.init.normal_(self.segment_queries, mean=0.0, std=0.02)
            for name, parameter in self.named_parameters():
                if parameter.dim() > 1 and not any(
                    key in name for key in ("token_embedding", "lm_head", "segment_queries")
                ):
                    nn.init.xavier_uniform_(parameter)
            nn.init.constant_(self.route_gate.bias, -2.0)

        def _segment_ids(self, source_ids):
            current = torch.zeros(source_ids.size(0), dtype=torch.long, device=source_ids.device)
            output = torch.zeros_like(source_ids)
            for position in range(source_ids.size(1)):
                token = source_ids[:, position]
                for segment, marker_id in enumerate(self.marker_ids):
                    current = torch.where(token.eq(marker_id), torch.full_like(current, segment), current)
                output[:, position] = current
            return output

        def _encode_one_segment(self, embedded, source_padding, segment_ids, segment: int):
            # Compact before recurrent encoding. Other segments cannot affect this
            # segment through backward recurrence, sequence length, or token position.
            mask = segment_ids.eq(segment) & ~source_padding
            lengths = mask.sum(dim=1).clamp_min(1)
            maximum = int(lengths.max().item())
            compact = embedded.new_zeros(embedded.size(0), maximum, embedded.size(-1))
            for batch_index in range(embedded.size(0)):
                count = int(lengths[batch_index].item())
                compact[batch_index, :count] = embedded[batch_index, mask[batch_index]]
            packed = nn.utils.rnn.pack_padded_sequence(
                compact,
                lengths.cpu(),
                batch_first=True,
                enforce_sorted=False,
            )
            packed_states, _ = self.segment_encoder(packed)
            states, _ = nn.utils.rnn.pad_packed_sequence(
                packed_states,
                batch_first=True,
                total_length=maximum,
            )
            states = self.encoder_norm(states)
            compact_mask = (
                torch.arange(maximum, device=embedded.device).unsqueeze(0)
                < lengths.unsqueeze(1)
            )
            scores = (states * self.segment_queries[segment]).sum(dim=-1) / math.sqrt(self.config.d_model)
            scores = scores.masked_fill(~compact_mask, torch.finfo(scores.dtype).min)
            weights = torch.softmax(scores, dim=-1)
            pooled = torch.bmm(weights.unsqueeze(1), states).squeeze(1)
            expanded = embedded.new_zeros(embedded.shape)
            for batch_index in range(embedded.size(0)):
                count = int(lengths[batch_index].item())
                expanded[batch_index, mask[batch_index]] = states[batch_index, :count]
            return expanded, pooled

        def encode(self, source_ids, source_padding):
            segment_ids = self._segment_ids(source_ids)
            base = self.token_embedding(source_ids)
            encoded_segments = []
            pooled_segments = []
            for segment in range(4):
                embedded = base + self.segment_embedding.weight[segment].view(1, 1, -1)
                states, pooled = self._encode_one_segment(
                    embedded, source_padding, segment_ids, segment
                )
                encoded_segments.append(states)
                pooled_segments.append(pooled)
            memory = self.encoder_norm(torch.stack(encoded_segments, dim=0).sum(dim=0))
            request, attachment, remembered, thread = pooled_segments

            req = self.request_projection(request)
            att = self.attachment_projection(attachment)
            mem = self.memory_projection(remembered)
            thr = self.thread_projection(thread)
            gates = torch.sigmoid(self.route_gate(request))
            route_obs = self.route_observation(torch.cat([
                req,
                gates[:, 0:1] * att,
                gates[:, 1:2] * mem,
                gates[:, 2:3] * thr,
            ], dim=-1))
            authority_obs = self.authority_observation(request)
            context_obs = self.context_observation(torch.cat([req, att, mem, thr], dim=-1))
            transform_obs = self.transform_observation(request)
            observations = (route_obs, authority_obs, context_obs, transform_obs)

            states = tuple(torch.zeros_like(observation) for observation in observations)
            lane_candidates = [[] for _ in range(4)]
            lane_halt_logits = [[] for _ in range(4)]
            for _ in range(self.reasoning_steps):
                states = tuple(
                    cell(observation, state)
                    for cell, observation, state in zip(self.cells, observations, states)
                )
                for lane, state in enumerate(states):
                    lane_candidates[lane].append(state)
                    lane_halt_logits[lane].append(self.halt_heads[lane](state))
            lane_outputs = []
            for lane in range(4):
                halting = torch.softmax(torch.stack(lane_halt_logits[lane], dim=1), dim=1)
                stacked = torch.stack(lane_candidates[lane], dim=1)
                lane_state = (halting * stacked).sum(dim=1)
                lane_outputs.append(self.lane_norms[lane](lane_state))
            return memory, torch.cat(lane_outputs, dim=-1)

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
                (source_ids.size(0),), bos_id, dtype=torch.long, device=source_ids.device
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

    return TypedRecurrentReasoner


def install_controller(reasoner: Any) -> None:
    """Install structured serialization, tokenizer binding, and model builder."""
    if getattr(reasoner, "__archie_typed_controller__", False):
        return
    reasoner.SPECIAL_TOKENS = tuple(dict.fromkeys((*reasoner.SPECIAL_TOKENS, *STATE_TOKENS)))
    original_tokenizer = reasoner.SentencePieceTokenizer

    class StructuredTokenizer(original_tokenizer):
        def __init__(self, model_path):
            super().__init__(model_path)
            configure_special_ids(self.special_ids)

    StructuredTokenizer.__name__ = original_tokenizer.__name__
    StructuredTokenizer.__qualname__ = original_tokenizer.__qualname__
    reasoner.SentencePieceTokenizer = StructuredTokenizer
    reasoner.source_text = lambda row: structured_source_text(reasoner, row)
    reasoner.build_model_class = lambda: build_controller_class(reasoner)
    reasoner.__archie_typed_controller__ = True
