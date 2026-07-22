#!/usr/bin/env python3
"""Contract and gradient checks for the from-scratch Archie hybrid."""
from __future__ import annotations

import json
import pathlib
import tempfile
from dataclasses import asdict, replace

import numpy as np
import torch

from archie_hybrid_core import (
    BOS_ID, EOS_ID, PAD_ID, SEP_ID, VOCAB_SIZE, ArchieHybridLM, ModelConfig,
    PRESETS, parameter_count,
)
from archie_hybrid_corpus import build_u16_corpus, verify_u16_corpus
from archie_tokenizers import learn_pair_tokenizer, tokenizer_from_metadata
from train_archie_hybrid import load_initial_weights


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
        pair_tokenizer = learn_pair_tokenizer(
            ["the model preserves the evidence", "the model verifies the receipt"], 300
        )
        pair_text = "the model preserves the receipt"
        assert pair_tokenizer.decode(pair_tokenizer.encode(pair_text)) == pair_text
        pair_corpus = root / "pair-probe.u16"
        pair_metadata = build_u16_corpus(
            pair_corpus, [("pair", pair_text * 20)], max_tokens=None,
            tokenizer=pair_tokenizer,
        )
        assert (
            verify_u16_corpus(pair_corpus)["tokenizer"]["vocab_size"]
            == pair_tokenizer.vocab_size
        )
        loaded_tokenizer = tokenizer_from_metadata(pair_metadata["tokenizer"])
        assert loaded_tokenizer.decode(loaded_tokenizer.encode(pair_text)) == pair_text
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
        long_cfg = replace(PRESETS["micro"], max_seq_len=1024)
        long_model = ArchieHybridLM(long_cfg, gradient_checkpointing=False)
        long_batch = torch.randint(0, VOCAB_SIZE, (1, 1024), dtype=torch.long)
        long_loss = long_model(long_batch, long_batch)["loss"]
        long_loss.backward()
        long_gradients = [
            parameter.grad for parameter in long_model.parameters() if parameter.requires_grad
        ]
        assert all(
            gradient is not None and torch.isfinite(gradient).all()
            for gradient in long_gradients
        )
        for mixer_mode in ("attention", "ssm"):
            variant_cfg = replace(cfg, mixer_mode=mixer_mode)
            variant = ArchieHybridLM(variant_cfg)
            variant_loss = variant(batch, batch)["loss"]
            assert torch.isfinite(variant_loss)
            variant_loss.backward()
        plastic_cfg = replace(
            cfg, plastic_mode="delta", plastic_rank=8, plastic_detach_every=0
        )
        plastic_model = ArchieHybridLM(plastic_cfg)
        first = plastic_model(batch[:, :10])
        plastic_state = first["plastic_state"]
        assert tuple(plastic_state.shape) == (2, 8, plastic_cfg.d_model)
        continued = plastic_model(batch[:, 10:], plastic_state=plastic_state)
        reset = plastic_model(batch[:, 10:])
        assert not torch.allclose(continued["logits"], reset["logits"])
        plastic_loss = plastic_model(batch, batch)["loss"]
        plastic_loss.backward()
        plastic_gradients = [
            parameter.grad for name, parameter in plastic_model.named_parameters()
            if name.startswith("plastic_memory")
        ]
        assert plastic_gradients and all(
            gradient is not None and torch.isfinite(gradient).all()
            for gradient in plastic_gradients
        )
        generated_plastic, generated_state = plastic_model.generate_with_plastic_state(
            torch.tensor([[BOS_ID, ord("A")]]), max_new_tokens=2
        )
        assert generated_plastic.shape[1] >= 3 and generated_state is not None
        upgraded_model = ArchieHybridLM(plastic_cfg)
        upgrade_mode = load_initial_weights(
            upgraded_model,
            {"config": asdict(cfg), "model": model.state_dict()},
            plastic_cfg,
            allow_plastic_upgrade=True,
        )
        assert upgrade_mode == "plastic-module-added"
        assert torch.equal(
            upgraded_model.token_embedding.weight, model.token_embedding.weight
        )
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
            "plastic_upgrade": True,
            "parameters": parameter_count(model), "corpus_sha256": metadata["sha256"],
        }, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
