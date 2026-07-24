# Fresh causal smoke protocol

This protocol is intentionally narrower than the inherited pursuit campaign.

## Authorized execution

Only a fresh `v3-causal` smoke may run after the branch contract is green.

```bash
ARCHIE_SIDEPUS_PROFILE=smoke \
ARCHIE_SIDEPUS_PURSUIT_STATE="$HOME/archie-sidepus-pursuit-v3-causal-smoke" \
bash foundry/archie-distill/run_archie_sidepus_ready.sh
```

Do not point the invocation at a v2 state directory and do not adopt a legacy pursuit checkpoint.

## Required receipt fields

The final history row must contain finite values for:

- `oracle_deliberation_steps`;
- `supervised_deliberation_steps`;
- `oracle_extra_step_fraction`;
- `halt_extra_step_fraction`;
- `halt_oracle_agreement`;
- `halt_regret`;
- `deliberation_token_marginal_gain`;
- correct/reset/foreign state conditions when available;
- retention and interference metrics.

## Interpretation

The first 75 steps contain an explicit halt curriculum. During that interval, `supervised_deliberation_steps` may exceed `oracle_deliberation_steps`; this is training pressure, not evidence of useful computation.

A directional smoke signal requires all of the following after warmup:

- positive token-level marginal gain;
- nonzero oracle extra-step fraction;
- halt regret lower than its early-warmup value;
- finite gradients and state;
- correct state not losing to reset or foreign state on compared steps;
- retention remaining inside the inherited threshold.

Failure of any item keeps deliberation falsified. Passing does not authorize the full campaign. It authorizes construction of a disjoint held-out continuation evaluator only.
