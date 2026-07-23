#!/usr/bin/env python3
"""Causality, persistence, quantization, warm-start, and gradient contracts."""
from __future__ import annotations

import json
from dataclasses import asdict, replace

import torch

from archie_hybrid_core import ArchieHybridLM
from archie_world_state_core import (
    BOS_ID,
    VOCAB_SIZE,
    ArchieWorldStateLM,
    PRESETS,
    WorldStateConfig,
    dequantize_state_artifact,
    load_language_shell,
    parameter_count,
    quantize_state_artifact,
    state_dependency_metrics,
)


def main() -> None:
    torch.manual_seed(7)
    cfg = replace(PRESETS["micro"], action_count=5, state_aux_weight=0.3)
    model = ArchieWorldStateLM(cfg)
    batch = torch.randint(0, VOCAB_SIZE, (3, 40), dtype=torch.long)
    output = model(batch, batch, return_diagnostics=True)
    assert output["logits"].shape == (3, 40, VOCAB_SIZE)
    assert output["action_logits"].shape == (3, 5)
    assert torch.isfinite(output["loss"])
    assert torch.isfinite(output["state_loss"])
    assert output["state_routes"].shape[:2] == (3, 5)
    assert bool((output["state_routes"].gt(0).sum(dim=-1) <= cfg.state_top_k).all())
    assert 0.0 < float(output["active_slot_fraction"]) <= cfg.state_top_k / cfg.state_slots
    output["loss"].backward()
    state_gradients = [
        parameter.grad for name, parameter in model.named_parameters()
        if name.startswith(("world_state_core.", "state_gate.", "state_head."))
    ]
    assert state_gradients and all(
        gradient is not None and torch.isfinite(gradient).all() for gradient in state_gradients
    )

    model.eval()
    support, query = batch[:, :24], batch[:, 24:]
    support_state = model(support)["world_state"]
    continued = model(query, world_state=support_state)["logits"]
    reset = model(query)["logits"]
    assert not torch.allclose(continued, reset)
    metrics = state_dependency_metrics(model, query, support_state)
    assert metrics["adapted_vs_reset_logit_mae"] > 0.0
    assert metrics["adapted_vs_wrong_logit_mae"] > metrics["adapted_vs_reset_logit_mae"]

    artifact = quantize_state_artifact(support_state, 4)
    restored = dequantize_state_artifact(artifact)
    assert restored.shape == support_state.shape
    assert torch.isfinite(restored).all()
    assert artifact["values"].dtype == torch.int8
    assert int(artifact["values"].abs().max()) <= 7

    causal = ArchieWorldStateLM(replace(cfg, dropout=0.0)).eval()
    prefix, extended = batch[:1, :24], batch[:1, :40]
    assert torch.allclose(
        causal(prefix)["logits"], causal(extended)["logits"][:, :24], atol=1e-5, rtol=1e-4
    )

    source_cfg = replace(PRESETS["micro"], plastic_mode="none")
    source = ArchieHybridLM(source_cfg)
    source_payload = {"config": asdict(source_cfg), "model": source.state_dict()}
    target_cfg = replace(PRESETS["micro"], action_count=0)
    target = ArchieWorldStateLM(target_cfg)
    before = target.world_state_core.slot_keys.detach().clone()
    warm = load_language_shell(target, source_payload)
    assert warm["copied_tensors"] > 0
    assert torch.equal(target.token_embedding.weight, source.token_embedding.weight)
    assert torch.equal(target.world_state_core.slot_keys, before)

    target.set_language_shell_trainable(False)
    assert not any(parameter.requires_grad for parameter in target.language_shell_parameters())
    assert all(parameter.requires_grad for parameter in target.state_parameters())
    target.set_language_shell_trainable(True)

    generated, final_state = target.generate_with_state(
        torch.tensor([[BOS_ID, ord("A")]]), max_new_tokens=2, temperature=1.0
    )
    assert generated.shape[1] >= 3
    assert final_state.shape == (1, target_cfg.state_slots, target_cfg.d_model)

    try:
        WorldStateConfig(state_slots=2, state_top_k=3).validate()
    except ValueError:
        pass
    else:
        raise AssertionError("invalid sparse routing configuration was accepted")

    print(json.dumps({
        "schema": "archie-world-state-contract/v1",
        "causal": True,
        "persistent": True,
        "sparse_writes": True,
        "state_auxiliary_loss": True,
        "state_quantization_bits": [4, 8],
        "language_shell_warm_start": True,
        "dual_language_action_outputs": True,
        "parameters": parameter_count(model),
        "state_dependency": metrics,
    }, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
