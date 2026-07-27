# Full-Budget Causal Mechanism Campaign — Result

The complete receipt-bound CPU campaign finished successfully on GitHub Actions. The run consumed the entire declared budget and independently verified the resulting evidence bundle.

## Decision

**Canonical decision: `not-admitted`.** Every recurrent/structured mechanism cleared the conservative mechanism-score margin over the matched attention baseline, but every family still failed terminal exactness across all six family-level observations. This is a mechanism-survival result, not model admission.

## Budget

- Candidates: 42 / 42
- Optimizer steps: 1008 / 1008
- Event tokens: 145,152
- Estimated training FLOPs: 42,689,327,616
- Families: 7
- Scales: 3
- Seeds: 2
- Evaluation suites: 8

## Family results

| Family | Mean mechanism score | 95% CI | Conservative delta vs attention | Allocation |
|---|---:|---:|---:|---|
| `reversible_state` | 0.5010 | 0.4703–0.5316 | 0.1755 to 0.2855 | expand |
| `object_recurrent` | 0.4737 | 0.4345–0.5130 | 0.1397 to 0.2669 | expand |
| `dynamic_transport` | 0.4737 | 0.4466–0.5009 | 0.1518 to 0.2548 | expand |
| `graph_routing` | 0.4704 | 0.4294–0.5115 | 0.1347 to 0.2654 | expand |
| `neural_interpreter` | 0.4625 | 0.4310–0.4940 | 0.1362 to 0.2479 | expand |
| `sparse_event_memory` | 0.4545 | 0.4290–0.4800 | 0.1342 to 0.2339 | expand |
| `attention_baseline` | 0.2704 | 0.2461–0.2948 | baseline | baseline |

## Falsification outcome

- Surviving mechanisms: `dynamic_transport`, `graph_routing`, `reversible_state`, `sparse_event_memory`, `object_recurrent`, `neural_interpreter`.
- Eliminated hypotheses: none at this budget.
- Unresolved mechanisms: none under the predeclared margin rule.
- Shared blocking pathology: terminal exactness failure frequency was 1.0 for every family.
- `reversible_state` had the highest mean mechanism score, but long-horizon degradation appeared in 5/6 observations.

## Evidence identities

- Campaign manifest: `0e858f547159ec19e4636d9b751c66533075975fb2ce4fc5aad33d740137f180`
- Campaign manifest file: `5244e2c31b3bcbf8779e5017fd8b9c6dcf7680bfeded8a3a396b000d59093240`
- Checkpoint manifest: `5c1ebaac2fb23ce8925f8d7d72bad7ccdc4033058b95859df38539464d469e70`
- Result cube: `644d6241f4966730069c3aad442dd401a0b5512b709288e21c42059b3fb14166`
- Falsification report: `41f10c2cac0dc6e22b4bdddf3c86ef191035d309f05783577cd4556cb4be1eb8`
- Evidence ledger: `35a9250367220eb1355b068eeb56590fc4c5d5277d011c5bd67b729f99e4fb62`
- Workflow run: `29833720111`
- Artifact digest: `sha256:b7da700e4f9a9c6b9cba11706a5668d16a55a1007aad38ccb972f6fd265e87ff`

## Next allocation

Expand all six structured mechanisms into a larger, terminal-exactness-focused round. Preserve the attention baseline, strengthen long-horizon stress for reversible state, and do not promote any candidate until exact terminal state becomes nonzero and survives independent evaluation.
