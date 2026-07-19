#!/usr/bin/env python3
"""Contract and gradient checks for the from-scratch Archie hybrid."""
from __future__ import annotations

import json
import pathlib
import tempfile
from dataclasses import asdict

import numpy as np
import torch

from archie_hybrid_core import (
    BOS_ID, EOS_ID, PAD_ID, SEP_ID, VOCAB_SIZE, ArchieHybridLM, ModelConfig,
    PRESETS, parameter_count,
)
from archie_hybrid_corpus import build_u16_corpus, verify_u16_corpus


def main() -> None:
    with tempfile.TemporaryDirectory() as temporary:
        root = pathlib.Path(temporary)
        corpus = root / "probe.u16"
        metadata = build_u16_corpus(
            corpus,
            [("a", "special-token storage probe"), ("b", "state space plus local attention")],
            max_tokens=None,
        )
        assert metadata["sha256"] == verify_u16_corpus(corpus)["sha256"]
        tokens = np.memmap(corpus, dtype="<u2", mode="r")
        assert int(tokens.max()) == SEP_ID
        assert BOS_ID in tokens and EOS_ID in tokens and SEP_ID in tokens
        assert corpus.stat().st_size == metadata["token_count"] * 2
        cfg = PRESETS["micro"]
        model = ArchieHybridLM(cfg, gradient_checkpointing=True)
        batch = torch.randint(0, VOCAB_SIZE, (2, 20), dtype=torch.long)
        result = model(batch, batch)
        assert result["logits"].shape == (2, 20, VOCAB_SIZE)
        assert torch.isfinite(result["loss"])
        result["loss"].backward()
        gradients = [parameter.grad for parameter in model.parameters() if parameter.requires_grad]
        assert gradients and all(gradient is not None for gradient in gradients)
        assert all(torch.isfinite(gradient).all() for gradient in gradients if gradient is not None)
        exported = root / "model.pt"
        torch.save({"config": asdict(cfg), "model": model.state_dict()}, exported)
        payload = torch.load(exported, map_location="cpu", weights_only=False)
        reloaded = ArchieHybridLM(ModelConfig(**payload["config"]))
        reloaded.load_state_dict(payload["model"])
        generated = reloaded.generate(torch.tensor([[BOS_ID, ord("A")]]), max_new_tokens=2)
        assert generated.shape[1] >= 3
        source = "\n".join(
            path.read_text(encoding="utf-8")
            for path in [
                pathlib.Path(__file__).with_name("archie_hybrid_core.py"),
                pathlib.Path(__file__).with_name("train_archie_hybrid.py"),
            ]
        )
        assert not any(item in source for item in ["AutoModelForCausalLM", "from_pretrained(", "mamba_ssm"])
        print(json.dumps({
            "schema": "archie-scratch-hybrid-contract/v1", "u16_storage": True,
            "special_ids": [PAD_ID, BOS_ID, EOS_ID, SEP_ID], "forward": True,
            "backward": True, "reload": True, "generation": True,
            "parameters": parameter_count(model), "corpus_sha256": metadata["sha256"],
        }, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
