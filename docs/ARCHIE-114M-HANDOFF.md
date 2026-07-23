# Archie 114M handoff

## Current truth

- Process activity is deliberately not claimed by this file; the launcher checks for a competing Archie trainer before every start.
- The RTX 2060 has 6 GiB VRAM. A measured 114,048,640-parameter `base` hybrid update at batch 16 and context 1024 peaked at about 4.1 GiB allocated; the launcher uses batch 12 for margin.
- The selected 24,448,514-parameter Git-experience merge improved all three newest-history metrics: chosen patch loss by 0.009630 nats/token, causal advantage by 0.015727, and pair accuracy by 0.048544.
- It is not a general promotion. Public-corpus bits per byte regressed from 2.458572 to 2.900980, and plastic transfer improved by only 0.0539% against a 3% gate.
- Selected Git model SHA-256: `f6a711115aeeef1f92420c20178498bbf45fff504c707dc431dcc0a86aeb7d2d`.

## Start or resume the larger run

From PowerShell:

```powershell
wsl bash '/mnt/c/Users/AwesomeKai/Documents/New project/theawesomehexapp-archie-train/foundry/archie-distill/run_archie_114m.sh'
```

The script refuses to start beside another Archie trainer. It builds a fresh unbound corpus from the verified 1.55 GB Sidepus public export, trains the 114M hybrid from random initialization, checkpoints in `/home/awesomekai/archie-base-114m-v1`, and mirrors the latest model and receipt into `returns/generative-114m`.

Each invocation is limited to six hours. Run the same command again to resume toward 30,000 updates. Checkpoint v2 binds the model, train/development corpus identities, optimizer and schedule, maximum steps, batching, sampling policy and seeds, precision, hardware class, and trainer source digests. A mismatched invocation is rejected instead of silently changing the experiment. The launcher carries `--adopt-legacy-checkpoint` solely so the currently active v1 campaign can be migrated once; every subsequent save is governed by the v2 contract. Use a new `ARCHIE_114M_STATE` for a genuinely different experiment.

An invocation that began before checkpoint v2 was installed keeps its already-loaded Python code and may finish by writing v1. Do not interrupt it for this patch. The next normal launcher invocation explicitly audits the model/configuration and train/development digests, adopts that legacy state, and immediately writes v2; the receipt records that migration.

## What this experiment proves or kills

This is the honest larger baseline. It tests whether the selective-state/local-attention hybrid learns broad held-out bytes more efficiently with 4.7 times the parameters and a much larger real corpus. The trainer constructs its evaluation sampler from `development.u16`, records both corpus digests, and requires `evaluation_is_independent: true` before the held-out label is deserved. Parameter count is not novelty and loss is not agency.

The next research candidate is not yet implemented. It starts from the trained 20-block `base` checkpoint and tests function-preserving 20-to-40-block depth growth: interleave inserted residual blocks with zero-initialized branch outputs, prove identical logits at step zero, train only inserted branches briefly, then unfreeze the full model. Couple that with causal event-patch training and general-retention gates. Do not claim novelty until it beats scratch hybrid, attention-only, and SSM-only baselines at matched parameters, tokens, and joules across multiple held-out repositories and seeds.

## Causal event patches

Language modeling remains one supervision channel, not the whole organism. The proposed second channel is an executable transition record:

1. `belief_before`: a compact, typed claim graph with confidence and provenance;
2. `observation`: immutable evidence newly available to the model;
3. `candidate_actions`: executable patches the model could apply, including abstention;
4. `predicted_effects`: state changes and test outcomes predicted for every candidate;
5. `chosen_patch`: the smallest action selected under explicit cost and uncertainty;
6. `world_after`: the observed repository, tool, or environment state after execution;
7. `belief_patch`: assertions added, revised, weakened, or retired by the evidence;
8. `receipts`: hashes, diffs, tests, and rollback material that make the transition auditable;
9. `counterfactual_credit`: measured or sandbox-estimated outcomes for rejected candidates.

The training unit is therefore `state + evidence + alternatives -> executable patch + predicted delta -> verified delta + belief revision`. Text is useful when it predicts or explains that transition. A fluent continuation that cannot survive execution receives no causal credit. Initial implementation should use deterministic repository sandboxes and held-out task families before adding any online weight mutation.
