#!/usr/bin/env python3
"""Reversible local tokenizers for Archie hybrid research."""
from __future__ import annotations

from collections import Counter
from collections.abc import Iterable
from typing import Any, Protocol

from archie_hybrid_core import (
    BOS_ID, EOS_ID, PAD_ID, SEP_ID, VOCAB_SIZE, ByteTokenizer,
)


class ArchieTokenizer(Protocol):
    vocab_size: int
    pad_token_id: int
    bos_token_id: int
    eos_token_id: int
    sep_token_id: int

    def encode(self, text: str, *, bos: bool = False, eos: bool = False) -> list[int]: ...
    def decode(self, ids: Iterable[int], *, skip_special: bool = True) -> str: ...
    def metadata(self) -> dict[str, Any]: ...


class LearnedPairTokenizer:
    """UTF-8 byte fallback plus corpus-learned, nonrecursive byte-pair tokens."""

    pad_token_id = PAD_ID
    bos_token_id = BOS_ID
    eos_token_id = EOS_ID
    sep_token_id = SEP_ID

    def __init__(self, pairs: Iterable[tuple[int, int]]) -> None:
        unique = list(dict.fromkeys((int(left), int(right)) for left, right in pairs))
        if any(not 0 <= value < 256 for pair in unique for value in pair):
            raise ValueError("learned pair bytes must be between 0 and 255")
        self.pairs = tuple(unique)
        self.pair_to_id = {pair: VOCAB_SIZE + index for index, pair in enumerate(self.pairs)}
        self.id_to_pair = {token: pair for pair, token in self.pair_to_id.items()}
        self.vocab_size = VOCAB_SIZE + len(self.pairs)

    def encode(self, text: str, *, bos: bool = False, eos: bool = False) -> list[int]:
        raw = text.encode("utf-8", errors="replace")
        ids = [BOS_ID] if bos else []
        index = 0
        while index < len(raw):
            pair = (raw[index], raw[index + 1]) if index + 1 < len(raw) else None
            pair_id = self.pair_to_id.get(pair) if pair is not None else None
            if pair_id is None:
                ids.append(raw[index])
                index += 1
            else:
                ids.append(pair_id)
                index += 2
        if eos:
            ids.append(EOS_ID)
        return ids

    def decode(self, ids: Iterable[int], *, skip_special: bool = True) -> str:
        raw = bytearray()
        labels = {PAD_ID: b"<pad>", BOS_ID: b"<bos>", EOS_ID: b"<eos>", SEP_ID: b"<sep>"}
        for token in ids:
            value = int(token)
            if value < 256:
                raw.append(value)
            elif value in self.id_to_pair:
                raw.extend(self.id_to_pair[value])
            elif not skip_special:
                raw.extend(labels.get(value, b"<?>"))
        return raw.decode("utf-8", errors="replace")

    def metadata(self) -> dict[str, Any]:
        return {
            "schema": "archie-learned-byte-pair-tokenizer/v1",
            "encoding": "utf-8-byte-fallback-with-nonrecursive-pairs",
            "vocab_size": self.vocab_size,
            "pairs_hex": [bytes(pair).hex() for pair in self.pairs],
            "special_tokens": {"pad": PAD_ID, "bos": BOS_ID, "eos": EOS_ID, "sep": SEP_ID},
        }


def learn_pair_tokenizer(texts: Iterable[str], vocab_size: int) -> LearnedPairTokenizer:
    if not VOCAB_SIZE <= vocab_size <= 65_536:
        raise ValueError(f"pair tokenizer vocabulary must be between {VOCAB_SIZE} and 65536")
    counts: Counter[tuple[int, int]] = Counter()
    for text in texts:
        raw = text.encode("utf-8", errors="replace")
        counts.update(zip(raw, raw[1:]))
    pair_count = vocab_size - VOCAB_SIZE
    ranked = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    return LearnedPairTokenizer(pair for pair, _ in ranked[:pair_count])


def tokenizer_from_metadata(metadata: dict[str, Any]) -> ArchieTokenizer:
    schema = metadata.get("schema")
    if schema == "archie-byte-tokenizer/v1":
        return ByteTokenizer()
    if schema == "archie-learned-byte-pair-tokenizer/v1":
        pairs = [tuple(bytes.fromhex(value)) for value in metadata.get("pairs_hex", [])]
        tokenizer = LearnedPairTokenizer(pairs)  # type: ignore[arg-type]
        if tokenizer.vocab_size != int(metadata.get("vocab_size", -1)):
            raise ValueError("learned pair tokenizer vocabulary does not match metadata")
        return tokenizer
    raise ValueError(f"unsupported Archie tokenizer schema: {schema!r}")


def token_byte_lengths(metadata: dict[str, Any]) -> list[int]:
    tokenizer = tokenizer_from_metadata(metadata)
    lengths = [1] * tokenizer.vocab_size
    for special in (PAD_ID, BOS_ID, EOS_ID, SEP_ID):
        lengths[special] = 0
    if isinstance(tokenizer, LearnedPairTokenizer):
        for token in tokenizer.id_to_pair:
            lengths[token] = 2
    return lengths
