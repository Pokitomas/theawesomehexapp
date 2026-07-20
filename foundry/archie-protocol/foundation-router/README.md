# Archie focused foundational router — shadow research lane

**Promotion:** `not-admitted`  
**Production router changed:** no  
**Starting main:** `476a9b18c62e0158e0eeea21542bff63e450fefb`

This directory contains a reproducible research lane for replacing the deterministic register projection with a trained router. It does not modify the product operator, relabel a shadow artifact as production, or weaken admission.

## Selected candidate

`focused_foundational_router_v3` is a six-head learned system over a compact tabular representation:

- full-request and operation-focus views;
- the proven 12,000 supervised-atom route margins;
- learned full/focus route-centroid similarities;
- explicit attachment, memory, thread, punctuation, negation, correction, and order columns;
- route, authority, context, clause-activity, compound, and clause-route heads;
- route-head primacy: auxiliary heads cannot promote compound or erase a valid route, and may force clarification only at a calibrated 0.95 confidence.

The runtime contains no deterministic route-projection table. The discourse parser proposes clause boundaries and order; learned heads assign routes and activity.

## Locked results

| Evaluation | Route | Exact all-head/runtime |
|---|---:|---:|
| Legacy retention | 606/606 | route labels only |
| Known repair pack | 119/119 | 117/119 |
| Development v2 | 1124/1127 | 1059/1127 |
| Development v3 | 1420/1420 | 1396/1420 |
| Development v4 | 1660/1660 | 1595/1660 |
| Untouched frozen v5 | 1683/1880 | 1603/1880 |

The frozen-v5 operation-focus experiment improved untouched route accuracy from the preceding candidate's 73.5% to 89.5%, but it remains below the 97% route and 94% exact shadow thresholds. Exact `Archie-Audit.zip` and current-main runtime suites were not replayed. Promotion is therefore blocked.

Selected identities:

- model SHA-256: `c001250b3a9b7d55e06dadcf62eb5fd047ad554b9c19d51b3fdef760824d8e8a`
- frozen-v5 SHA-256: `69703565cc6f5de1c74ac8ce6c14256d089ca0f00a1a9ebe013c7e4e69ce06ed`
- prior atom model SHA-256: `7e61d995b5c990497351c85d67656140a0e81d4ec789e194ff45a0b17a56e3cf`
- known-repair pack SHA-256: `c69c93674d7f6b7b3424ee87300d2d527f2a3d0f0f039e65cc30a37fb76e5d3a`

The binary model is intentionally not committed through this text-only research PR. The receipt binds its exact digest; training recreates it from the recorded inputs and seed.

## Reproduce

Python dependencies: `numpy`, `scipy`, `scikit-learn`, and `joblib`.

```bash
python train_focused_foundational_router_v3.py \
  --old-model /path/to/atom_linear_v3.joblib \
  --known-repair /path/to/capability-admission-v4.json \
  --output ./output-v5

ARCHIE_ROUTER_ARTIFACT=./output-v5/focused_foundational_router_v3.joblib \
ARCHIE_ROUTER_RECEIPT=./output-v5/focused_foundational_router_v3_receipt.json \
ARCHIE_ROUTER_FROZEN=./output-v5/frozen-foundational-v5.jsonl \
python -m unittest -v test_archie_foundational_router.py
```

The test suite verifies clause ordering, operation-focus extraction, dry-run-only teacher behavior, fail-closed authority/context examples, and model/frozen-pack digest binding.

## Kimi teacher path

`kimi_teacher.py` is an optional OpenAI-compatible Moonshot adapter. It asks only for a strict auditable judgment record—route, authority, context, ordered outcomes, active clauses, evidence tags, and a short rationale tag. It does not request or retain private chain-of-thought. No request occurs unless both `--execute` and `MOONSHOT_API_KEY` are supplied. This run made **zero external teacher calls**.

This makes Kimi feasible as an offline curriculum teacher, not as a runtime dependency. Teacher rows still require source-family separation, schema validation, disagreement checks, and frozen evaluation.

## LimiX-shaped tabular path

`export_tabular_relations.py` converts teacher records to a compact relation table. A LimiX-class tabular foundation model could consume that table as a calibration or arbitration experiment. No LimiX checkpoint, package, or hosted service was available or run, so no LimiX performance claim is made. There is no direct Kimi-to-LimiX pipeline; the bridge is the governed structured table.

## Rejected successor and negative evidence

A larger hierarchical v6 separated atomic operation, compound mode, and evidence availability across 76,068 rows. It fit seen families well but regressed legacy to 533/606 and scored only 1462/2400 routes and 1382/2400 exact on a newly frozen semantic-paraphrase pack. It is rejected. This demonstrates that classifier hierarchy and table balancing do not substitute for stronger pretrained semantic representation.

`negative-evidence.json` also records the abandoned independent-vocabulary, exact LinearSVC, and LightGBM paths and why they were computationally or empirically inferior.

## Admission boundary

Admission still requires, at minimum:

1. 606/606 legacy retention in the complete runtime;
2. exact frozen audit and current-main suite replay;
3. authority fail-closed and safe-documentation controls;
4. calibrated missing-context abstention;
5. ordered compound outcomes and JavaScript/runtime parity;
6. quantized artifact identity, latency, and receipt gates.

Until all gates pass, the deterministic projection remains production and every artifact in this directory remains shadow evidence.
