# Archie factorized controller v1 shadow result

## Decision

The apparent `310/310` candidate is not part of the legitimate candidate path. It depended on route regexes added after frozen phrase inspection and is retained only as negative evidence. The admitted production model and deterministic execution controls remain unchanged.

This run produced a separate local factorized controller candidate and leaves promotion as `not-admitted`.

## Runtime limitation

The execution container did not contain the requested checkout or receipt:

- `/mnt/data/archie_app` was absent;
- `/mnt/data/archie_app/artifacts/postfreeze-v10.evaluation.json` was absent;
- `gh` was unavailable;
- direct `github.com` access from the container failed DNS resolution.

The GitHub connector was available for PR metadata and small file publication, so this document and the evaluation summary were committed to the research branch. The local generated source/checkpoint were hashed, but the full joblib artifact was not committed through the connector path.

## What was implemented locally

The local candidate used a factorized controller rather than a monolithic shared-state classifier:

- semantic route ensemble: character n-gram logistic model, word n-gram logistic model, compact SVD semantic model, and structural route lexicon;
- byte-GRU route encoder: trained as an ablation and killed early because development route accuracy was 10.16%; it was not fused;
- compositional clause execution: split active clauses, removed negated and replaced clauses, predicted per-clause route, then constructed ordered outcomes;
- explicit reference typing: none, attachment, memory, thread, generic unresolved, ambiguous;
- reference readiness: distinguished absent source, present-but-unusable payload, and usable support;
- factorized authority: separated operation, target, actionability, destructive or exfiltrative capability, authorization gap, and documentation/defensive frame;
- calibration: log-probability fusion, temperature search, ensemble disagreement, NLL, Brier score, ECE, and selective accuracy reporting.

## Leakage controls

A new blind challenge pack was generated and frozen before model fitting with disjoint verbs, topics, source-reference nouns, authority scenarios, and clause templates. Normalized full-input deduplication was applied before freeze.

```text
train rows after dedupe            1,477
development rows after dedupe        550
blind challenge rows after dedupe    429
blind challenge SHA-256              3d053ee28c346e712a4e422a73cc8154f492db13947a129581084857a0ad101f
```

Pre-freeze duplicate drops:

```text
train exact duplicates                         443
development exact/prior overlap                146
challenge exact/prior overlap                  103
challenge near-prior duplicates at 0.985         0
```

## Results

```text
development fused candidate          488/550  88.73%
blind challenge fused candidate      386/429  89.98%
semantic model alone                 192/237  81.01%
structural controller alone                   89.04%
quantized candidate                  not available: byte-GRU killed before fusion
```

Blind challenge calibration:

```text
NLL                         0.6945759704
Brier                       0.2273883105
ECE                         0.2348410351
mean confidence, correct    0.7821083261
mean confidence, incorrect  0.9097530716
mean latency                1.6889 ms/example
```

The confidence signal is not accepted as useful evidence because incorrect predictions had higher mean confidence than correct predictions.

Counterfactual source isolation:

```text
authority payload invariance      40/40
non-target payload invariance     40/40
```

## Prior comparisons

The requested v9 and v10 local comparisons could not be rerun because the local checkout and post-freeze rows were absent. Recorded only as prior evidence supplied in the task:

```text
existing v9 runtime             294/310  94.84%  not rerun here
failed v10 cognitive router     209/310  67.42%  not rerun here
invalid regex 310/310           rejected as leakage
```

## Promotion status

Promotion remains `not-admitted`.

Blocked gates:

- exact legacy retention was not run;
- post-freeze pack was not rerun locally;
- no JavaScript/runtime parity run was completed;
- no admitted production model was modified;
- confidence calibration did not correlate with correctness on the new blind pack;
- the final candidate did not clear the previous v9 post-freeze score and cannot be claimed as an improvement over v9.

The strongest completed legitimate result is therefore shadow-only evidence, not a replacement runtime.
