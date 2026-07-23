# Sidepus developmental corpus

## Status

Sidepus now has three distinct authorities:

1. **archive acquisition** decides which immutable source bytes may be preserved;
2. **record extraction and rights gating** separates raw observations, source context, utterances, and compiler interpretations; and
3. **developmental compilation** decides which channels are visible, hidden, predicted, replayed, or reserved for evaluation in each model lineage.

The operator authorized a broad corpus on 2026-07-22. The approved policy is `foundry/sidepus/plans/content-policy-broad-v2.json`, digest `aa11086067845abfc5d966f92a03b6b8a95ba44145de33e9dcfcdc06c905d5e4`. It permits an 8 TiB archive ceiling, starts from exact Common Crawl release `CC-MAIN-2026-25`, allows a frozen historical cohort, Wayback temporal recovery, explicit Internet Archive objects, and up to 512 GiB of governed fresh capture.

Nothing in this PR downloads that archive or claims a model improvement. The policy, broad query, WARC extractor, rights boundary, developmental compiler, controls, and falsification contract are executable. Real archive holdings and matched training runs remain future evidence.

## Why the old ratio question was underspecified

A collection ratio is not a cognitive-training ratio. Eighteen percent executable material can have more structural repetition and easier verification than twenty-four percent human expression. A raw token percentage also says nothing about whether annotations are visible, whether source claims are distinguished from observations, whether an outcome is predicted before it is revealed, or whether language is the model's only objective.

The broad intake target is:

| Archive subject family | Target |
|---|---:|
| Language and human expression | 24% |
| Empirical world and science | 22% |
| Formal and executable artifacts | 18% |
| Social and institutional records | 18% |
| Multimodal and temporal episodes | 10% |
| Deliberately messy or adversarial material | 8% |

These targets govern collection diversity only. The developmental program reallocates exposure by stage and objective, and no single subject may exceed 30% of effective scheduled tokens.

## Record model

A developmental inventory record uses `sidepus-developmental-inventory-record/v1` and preserves six separable channel classes:

- `observation`: captured bytes or direct modality features;
- `production_context`: camera, edit, publication, source, document, and recording-process information;
- `utterance`: situated language from an author, speaker, narrator, institution, or program;
- `interpretation`: labels, summaries, inferred states, and compiler hypotheses;
- `action_consequence`: interventions, executions, state changes, outcomes, and feedback;
- `evaluation_only`: withheld counterfactuals and diagnostics.

The WARC extractor writes channel payloads as separate SHA-256 objects. HTML scripts, styles, templates, canvas, SVG internals, and other shortcut-bearing production material are not silently merged into visible page text. Ordinary `.html` pages are not classified as code merely because of their extension.

Unknown rights fail closed. A record without a matching operator-approved `sidepus-rights-decision/v1` rule retains its archive provenance but receives `rights-blocked`, which every developmental stage excludes.

## Developmental stages

`foundry/sidepus/plans/developmental-program-v1.json` defines four stages over the broad inventory.

### 1. Grounded interleave

Language, evidence, source boundaries, executable artifacts, and human expression are interleaved from the start. Compiler interpretations remain hidden. This avoids both a code-only infancy and an undifferentiated assistant-response infancy.

### 2. World-state expansion

Extra exposure shifts toward empirical, executable, and temporal material. Objectives emphasize persistence, temporal order, intervention, state transition, and falsification rather than merely describing those things in language.

### 3. Deliberate contamination

Low-integrity, persuasive, duplicated, contradictory, theatrical, and spam-like material enters as a bounded subject family. It is not treated as a clean teacher. Source context remains visible while interpretations and evaluation labels stay hidden.

### 4. Expression projection

Language generation is trained as a readout from observation, interpretation, and consequence channels. The design does not claim that hidden state equals cognition; it only prevents every useful representation from being trained exclusively through next-response production.

## Matched lineages

The compiler emits four deterministic lineages using the same inventory and declared resource group:

- `episode_state_experimental`: hidden supervision with grounded interleaving;
- `language_first_control`: expression training comes first;
- `flattened_assistant_control`: compiler interpretations are exposed as ordinary context;
- `structure_first_control`: world-state expansion precedes broad language grounding.

The ablation manifest requires parameter count, optimizer, token budget, checkpoint cadence, and evaluation inventory to remain equal. A developmental result is rejected when its gains disappear after hidden-channel ablation, fail outside the source medium, exist only on response-style benchmarks, or cause excessive retention damage.

## Scale behavior

The compiler has no global document cap. It ingests JSONL inventories into SQLite, creates deterministic candidates by lineage and stage, allocates bounded supplemental exposures by subject, and emits one schedule row per record-stage-lineage rather than copying source payloads or expanding every repetition into duplicate text.

The current Common Crawl SQL scans textual, structured, PDF, image, audio, and video MIME types. It removes obvious credential/session URLs, applies low deterministic sampling to large sensory media, applies higher sampling to PDFs and structured artifacts, raises non-English collection probability, and leaves the hard result bound to the governed discovery command.

The initial policy permits up to 20 million exact ranged-WARC records from `CC-MAIN-2026-25`. This is an authorization ceiling, not a claim that one workstation should download twenty million records in one session. Discovery, retrieval, extraction, and merge remain shardable.

## Commands

Initialize and install the approved policy:

```bash
export SIDEPUS_STATE=/srv/sidepus/archive-v2
bash foundry/sidepus/run_sidepus.sh
```

Discover one bounded Common Crawl shard:

```bash
python -m foundry.sidepus.governed_cli discover-commoncrawl-index \
  --state-dir "$SIDEPUS_STATE" \
  --crawl CC-MAIN-2026-25 \
  --sql foundry/sidepus/plans/commoncrawl-broad-v1.sql \
  --max-records 250000 \
  --receipt "$SIDEPUS_STATE/receipts/cc-2026-25-shard-000.json"
```

After governed workers retrieve and validate those jobs, extract channel-separated inventory records:

```bash
python -m foundry.sidepus.developmental_cli extract-warc-inventory \
  --state-dir "$SIDEPUS_STATE" \
  --rights-manifest /srv/sidepus/policies/rights-v1.json \
  --maximum-records 1000000 \
  --maximum-payload-bytes 67108864 \
  --output /srv/sidepus/inventory/shard-000.jsonl

python -m foundry.sidepus.developmental_cli verify-inventory \
  --receipt /srv/sidepus/inventory/shard-000.jsonl.receipt.json
```

Compile matched developmental schedules:

```bash
python -m foundry.sidepus.developmental_cli compile \
  --program foundry/sidepus/plans/developmental-program-v1.json \
  --content-policy foundry/sidepus/plans/content-policy-broad-v2.json \
  --inventory /srv/sidepus/inventory/shard-000.jsonl \
  --inventory /srv/sidepus/inventory/shard-001.jsonl \
  --output-dir /srv/sidepus/developmental/broad-v1

python -m foundry.sidepus.developmental_cli verify \
  --receipt /srv/sidepus/developmental/broad-v1/developmental-receipt.json
```

## What still has to be built or demonstrated

- large-scale PDF, code-tree, image, audio, video, and temporal episode adapters;
- scalable source-host and near-duplicate gating across the extracted archive;
- reviewed rights manifests for actual training exports;
- token-budget matching in the trainer from emitted schedules;
- nonlinguistic latent-prediction objectives in the actual model architecture;
- real acquisition throughput, storage, resume, and worker-merge evidence;
- matched training results from the four lineages;
- late-horizon transfer, retention, calibration, and contamination-resistance results.

The present implementation prevents a broad archive from becoming an accidental personality compiler and creates an executable bridge from WARC holdings to controlled developmental schedules. It does not yet prove that Archie has a sensory equivalent, a cleaner developmental substrate, or superior technology.
