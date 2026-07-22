# Sidepus developmental corpus

## Status

Sidepus now has two separate authorities:

1. **archive acquisition** decides which source bytes may be preserved; and
2. **developmental compilation** decides which channels of a preserved record are visible, hidden, predicted, replayed, or reserved for evaluation in each model lineage.

The operator authorized a broad corpus on 2026-07-22. The approved policy is `foundry/sidepus/plans/content-policy-broad-v2.json`. It permits an 8 TiB archive ceiling, starts from exact Common Crawl release `CC-MAIN-2026-25`, allows a frozen historical cohort, Wayback temporal recovery, explicit Internet Archive objects, and up to 512 GiB of governed fresh capture.

Nothing in this commit downloads that archive or claims a model improvement. The policy, query, compiler, controls, and falsification contract are executable; the archive inventory and real training runs remain future evidence.

## Why the old ratio question was underspecified

A collection ratio is not a cognitive-training ratio. Eighteen percent executable material can have more structural repetition and easier verification than twenty-four percent human expression. A raw token percentage also says nothing about whether annotations are visible, whether source claims are distinguished from observations, whether an outcome is predicted before it is revealed, or whether language is the model's only objective.

The broad intake target is now:

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

The compiler never concatenates these into one authoritative text field. Each stage names visible channels and hidden targets. A downstream tokenizer or multimodal adapter must obey that split.

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

The current Common Crawl SQL is intentionally broad and deterministic. It scans the URL Index for HTTP 200 records from supported textual and structured MIME types, removes obvious credential/session URLs, uses higher sampling probability for PDFs, structured/code-like artifacts, and non-English pages, and leaves the hard record bound to the governed discovery command.

The initial policy permits up to 20 million exact ranged-WARC records from `CC-MAIN-2026-25`. This is an authorization ceiling, not a claim that the local machine should download twenty million records in one worker or one session. Discovery must be sharded, frozen, and storage-checked before retrieval.

## Commands

Validate the program:

```bash
python -m foundry.sidepus.developmental_cli validate-program \
  --program foundry/sidepus/plans/developmental-program-v1.json
```

Install the acquisition policy into a Sidepus archive state:

```bash
python -m foundry.sidepus.governed_cli install-content-policy \
  --state-dir /srv/sidepus/archive-v2 \
  --policy foundry/sidepus/plans/content-policy-broad-v2.json
```

Discover a bounded broad Common Crawl shard:

```bash
python -m foundry.sidepus.governed_cli discover-commoncrawl-index \
  --state-dir /srv/sidepus/archive-v2 \
  --crawl CC-MAIN-2026-25 \
  --sql foundry/sidepus/plans/commoncrawl-broad-v1.sql \
  --max-records 250000 \
  --receipt /srv/sidepus/archive-v2/receipts/cc-2026-25-shard-000.json
```

Compile a frozen developmental inventory:

```bash
python -m foundry.sidepus.developmental_cli compile \
  --program foundry/sidepus/plans/developmental-program-v1.json \
  --content-policy foundry/sidepus/plans/content-policy-broad-v2.json \
  --inventory /srv/sidepus/inventory/shard-000.jsonl \
  --inventory /srv/sidepus/inventory/shard-001.jsonl \
  --output-dir /srv/sidepus/developmental/broad-v1
```

Verify the immutable outputs:

```bash
python -m foundry.sidepus.developmental_cli verify \
  --receipt /srv/sidepus/developmental/broad-v1/developmental-receipt.json
```

## What still has to be built or demonstrated

- WARC payload extraction into the six-channel inventory contract;
- large-scale language, document, code, audio, image, and video adapters;
- source-host, near-duplicate, and rights gates over extracted payloads;
- token-budget matching in the trainer from the emitted schedules;
- nonlinguistic latent prediction objectives in the actual model architecture;
- real acquisition throughput and storage evidence;
- matched training results from the four lineages;
- late-horizon transfer, retention, and contamination-resistance results.

The present change prevents the archive from becoming an accidental personality compiler. It does not yet prove that Archie has a sensory equivalent, a cleaner developmental substrate, or superior technology.
