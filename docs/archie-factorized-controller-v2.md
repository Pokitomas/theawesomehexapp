# Archie factorized controller v2 — final shadow result

## Decision

**Not admitted.** The frozen v9 checkpoint remains the strongest legitimate Archie route controller at **294/310 (94.84%)** on the protected post-freeze pack. Production routing and deterministic permission/execution controls were not modified.

The factorized v2 candidate scored **239/310 (77.10%)**, repaired one v9 error, and introduced 56 regressions. Its int8-storage checkpoint reproduced the same 239/310 predictions exactly. The candidate is retained as negative architectural evidence, not as a replacement.

The apparent 310/310 v12 result remains excluded from the legitimate candidate path because evaluation-specific route and policy regexes were added after protected phrase inspection.

## Implemented architecture

The completed local system combined genuinely different signals:

- the frozen v9 `char_wb` 3–5-gram and word 1–2-gram semantic backbone;
- a separately trained byte-level bidirectional GRU;
- independent character and word discriminative models;
- clause splitting, active/negated clause decisions, per-clause routes, ordering, and compound construction;
- typed `attachment`, `memory`, `thread`, `generic_missing`, `ambiguous`, and `none` references;
- separate source presence and payload-usability judgments;
- factorized authority signals for actionability, risky target, safe purpose, and trusted authorization metadata;
- temperature scaling, log-probability fusion, model disagreement, and full calibration reporting;
- symmetric per-tensor int8 GRU storage with exact prediction-parity evaluation.

Authority reads request text and trusted authorization metadata only. Payload content and payload length are structurally excluded from the authority decision.

## Leakage discipline

Blind-v2 was frozen before v2 fitting with disjoint verbs, topics, connectors, source-reference forms, authority operations, and authority targets.

```text
blind-v2 rows       287
blind-v2 SHA-256    d14432ae332169205b31e96417550a3410b8f3e2bc9ff2c32aa89ff4c6a2d2b6
training rows       1,539
validation rows       280
external teachers       0
```

Blind-v1 was consumed only after it falsified the first stack at 70/309. A new blind-v2 pack was frozen before hard-negative retraining. The protected 310-row post-freeze pack was evaluated only after blind-v2 evaluation and was not used for further tuning.

## Mandatory comparison

| System | Exact accuracy | Route accuracy | Mean latency | Peak RSS |
|---|---:|---:|---:|---:|
| v9 baseline | 294/310 (94.84%) | not available in aggregate receipt | not replayed | not replayed |
| failed v10 cognitive router | 209/310 (67.42%) | — | — | — |
| new semantic model alone | 68/310 (21.94%) | 59.68% | 2.21 ms | 833 MB |
| structural controller alone | 119/310 (38.39%) | 41.61% | 13.78 ms | 844 MB |
| factorized v2 fused | 239/310 (77.10%) | 81.61% | 40.40 ms | 888.5 MB |
| factorized v2 int8-storage | 239/310 (77.10%) | 81.61% | 39.95 ms | bounded replay |

The fused post-freeze category results were:

```text
abstention             11/14
authority benign       16/24
authority unsafe       24/24
attachment missing      6/8
attachment present      2/8
memory missing          7/8
memory present          1/8
thread missing          7/8
thread present          0/8
negation               12/30
ordered compounds      74/90
semantic routes        79/80
```

## Calibration

On the protected pack:

```text
NLL                         2.849
ECE                         0.219
Brier score                 0.309
mean confidence, correct    0.9969
mean confidence, incorrect  0.9656
```

Confidence is not accepted as useful. Incorrect examples remained highly confident, and selective accuracy did not improve monotonically enough to support a safe confidence gate.

## Isolation evidence

Authority predictions were invariant across empty, short, adversarial, and 100,000-character attachment/memory/thread payload variants. Explicit trusted authorization metadata changed a tested unsafe operation from deny to allow, proving the trusted channel remained distinct from untrusted payload text.

Reference presence twins failed: present attachment, memory, and thread payloads did not reliably change missing to ready. One benign security-documentation counterfactual was also denied. Both failures are preserved in `artifacts/structural-isolation.json`.

## Promotion gate

```text
exact legacy retention       not replayed: exact 606-row source pack unavailable
no authority safety loss     pass on protected unsafe slice (24/24)
no abstention regression     fail
post-freeze strength         fail
new blind strength           fail (121/287)
quantized parity             pass
JavaScript parity            not run
bounded resource use         fail
execution controls unchanged pass
promotion                    not-admitted
```

The mounted library contained the aggregate 606/606 v9 legacy receipt but not the exact 606 source rows. A full 1,880-row frozen-v5 candidate replay was attempted and did not complete within the bounded process, so no legacy-retention claim is made.

## Artifact identities

```text
factorized controller bundle  586d7eab8cf72c0adae717f41dc8998255d4ff377cae3c9157141d416b15fc7d
byte-GRU checkpoint            3fa670f43eaaae1e4d738a8ea99cd62c57dbdfea62f933eff6d391704384d0d8
int8 GRU storage               4876fe8a255375f231a88183f6835dc85fb6d424203cfec8dd14d53b64c659b6
v9 external dependency         06d33ca857dc6ab2c678a6bfe2ec65b8c3d223052d0109280bbc2301a00c7414
blind-v2 pack                  d14432ae332169205b31e96417550a3410b8f3e2bc9ff2c32aa89ff4c6a2d2b6
```

The complete receipt is `foundry/archie-cognitive-app/factorized-v2/artifacts/final-report.json`.
