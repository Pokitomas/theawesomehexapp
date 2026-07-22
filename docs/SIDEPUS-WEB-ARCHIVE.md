# Sidepus web archive v2

## Status

Sidepus v2 now separates and implements three governed authorities:

1. **archive acquisition** discovers or captures immutable WARC/ARC/WACZ bytes;
2. **content policy** seals the operator-approved acquisition boundary; and
3. **developmental compilation** converts extracted records into matched, staged model lineages without treating archive ratios as training ratios.

The approved acquisition policy is:

```text
foundry/sidepus/plans/content-policy-broad-v2.json
policy digest: aa11086067845abfc5d966f92a03b6b8a95ba44145de33e9dcfcdc06c905d5e4
```

The canonical launcher initializes the archive state, installs that exact immutable policy, and validates the developmental program. A state already sealed with another policy fails closed.

This implementation does **not** claim that any large archive has been downloaded, that the archive equals Common Crawl or Internet Archive holdings, that extracted rights labels are legally dispositive, that the model consumes the six-channel representation yet, or that Archie improved.

## Approved broad boundary

The policy authorizes a maximum archive size of 8 TiB. This is a ceiling, not a command to fill one machine indiscriminately.

Initial historical acquisition begins with exact Common Crawl release `CC-MAIN-2026-25`, with a maximum of 20 million selected ranged-WARC records. A historical expansion lane may resolve one frozen midyear release for each year from 2013 through 2025 before discovery. Wayback is reserved for temporal and disappeared-web counterfactuals. Internet Archive acquisition remains explicit item-and-file selection. Governed fresh capture is capped at 512 GiB.

Archive-intake targets are:

| Subject family | Target |
|---|---:|
| Language and human expression | 24% |
| Empirical world and science | 22% |
| Formal and executable artifacts | 18% |
| Social and institutional records | 18% |
| Multimodal and temporal episodes | 10% |
| Deliberately messy or adversarial material | 8% |

These percentages diversify holdings only. They do not determine token order, repetitions, objectives, hidden supervision, speaking style, or model personality.

## Hard acquisition contract

| Lane | Required mechanism |
|---|---|
| Common Crawl bounded discovery | CDXJ queries producing exact WARC filename, offset, and length jobs |
| Common Crawl broad discovery | DuckDB SQL over the Parquet URL Index with an explicit result ceiling |
| Common Crawl retrieval | HTTP `Range` requiring `206`, exact byte length, valid WARC framing, and digest agreement when available |
| Internet Archive | Exact WARC, ARC, or WACZ item/file acquisition with available upstream size and digest checks |
| Wayback | CDX replay captured only as a newly generated provenance-bound derivative WARC |
| Local archive ingestion | WARC 1.0/1.1, ARC through `warcio`, and path-safe WACZ extraction |
| Fresh static capture | GNU Wget WARC output |
| Fresh browser capture | Browsertrix CLI or an exact container command |
| Heritrix compatibility | Import and verify Heritrix WARC/ARC output |
| Storage | SHA-256 object store and SQLite WAL authority catalog |
| Distribution | immutable jobs, expiring leases, deterministic shards, one catalog per worker |
| Merge | deep verification followed by content-addressed set union |
| Governance | every job bound to the installed content-policy digest |

A passing doctor proves that the adapters and dependencies are callable. It does not prove corpus completeness or quality.

## Linux initialization

```bash
python3 -m venv ~/.venv-sidepus
source ~/.venv-sidepus/bin/activate
python -m pip install -r foundry/sidepus/requirements-parity.txt

export SIDEPUS_PYTHON="$HOME/.venv-sidepus/bin/python"
export SIDEPUS_STATE="$HOME/sidepus-archive-v2"
bash foundry/sidepus/run_sidepus.sh
```

Hard parity check:

```bash
bash foundry/sidepus/run_sidepus.sh doctor
```

## Broad Common Crawl discovery

The approved SQL is:

```text
foundry/sidepus/plans/commoncrawl-broad-v1.sql
```

It includes textual, structured, PDF, image, audio, and video records with deterministic MIME-specific sampling. Video and audio receive much lower collection probability than text and structured artifacts. Obvious credential/session URLs are excluded. Records may be as large as 64 MiB, but every invocation still supplies a hard result ceiling.

Start with a storage-bounded shard rather than pretending the 20-million-record authorization is one workstation command:

```bash
python -m foundry.sidepus.governed_cli discover-commoncrawl-index \
  --state-dir "$SIDEPUS_STATE" \
  --crawl CC-MAIN-2026-25 \
  --sql foundry/sidepus/plans/commoncrawl-broad-v1.sql \
  --max-records 250000 \
  --receipt "$SIDEPUS_STATE/receipts/cc-2026-25-shard-000.json"
```

Export deterministic worker shards:

```bash
python -m foundry.sidepus.governed_cli export-shards \
  --state-dir "$SIDEPUS_STATE" \
  --output-dir "$SIDEPUS_STATE/shards" \
  --shards 32
```

Each worker imports one or more shards into its own state directory. Do not place one SQLite file on a shared network filesystem.

## Other archive lanes

Bounded Common Crawl CDX:

```bash
python -m foundry.sidepus.governed_cli discover-commoncrawl-cdx \
  --state-dir "$SIDEPUS_STATE" \
  --queries /path/to/approved-commoncrawl-queries.jsonl \
  --receipt "$SIDEPUS_STATE/receipts/commoncrawl-cdx.json"
```

Wayback:

```bash
python -m foundry.sidepus.governed_cli discover-wayback \
  --state-dir "$SIDEPUS_STATE" \
  --queries /path/to/approved-wayback-queries.jsonl
```

Internet Archive:

```bash
python -m foundry.sidepus.governed_cli discover-internet-archive \
  --state-dir "$SIDEPUS_STATE" \
  --items /path/to/approved-items.jsonl
```

Fresh capture requests must include the exact installed policy digest. A crawler exit code is insufficient; emitted archives must ingest and validate.

## WARC to developmental inventory

Acquired records do not become one flattened text corpus. The extractor stores separate content-addressed channel objects for:

- raw observation;
- production and source context;
- situated utterance when text can be extracted;
- compiler interpretation;
- action/consequence when later adapters supply it; and
- evaluation-only counterfactuals when later builders supply them.

HTML scripts, styles, templates, SVG internals, and similar shortcuts are excluded from visible-text extraction. Ordinary HTML is not classified as executable merely because its URL ends in `.html`.

Unknown rights fail closed for training. Without an approved `sidepus-rights-decision/v1` rule, a record receives `rights-blocked`. The archive payload may remain preserved under the acquisition policy, but the developmental scheduler excludes it.

```bash
python -m foundry.sidepus.developmental_cli extract-warc-inventory \
  --state-dir "$SIDEPUS_STATE" \
  --rights-manifest /path/to/operator-approved-rights.json \
  --maximum-records 1000000 \
  --maximum-payload-bytes 67108864 \
  --output "$SIDEPUS_STATE/inventory/broad-000.jsonl"

python -m foundry.sidepus.developmental_cli verify-inventory \
  --receipt "$SIDEPUS_STATE/inventory/broad-000.jsonl.receipt.json"
```

## Developmental compilation

The developmental program is:

```text
foundry/sidepus/plans/developmental-program-v1.json
```

It emits matched schedules for four lineages: hidden-supervision episode/state training, language-first control, flattened-assistant control, and structure-first control. It stages grounded interleaving, world-state expansion, deliberate contamination, and expression as a projection from broader state.

```bash
python -m foundry.sidepus.developmental_cli compile \
  --program foundry/sidepus/plans/developmental-program-v1.json \
  --content-policy foundry/sidepus/plans/content-policy-broad-v2.json \
  --inventory "$SIDEPUS_STATE/inventory/broad-000.jsonl" \
  --output-dir "$SIDEPUS_STATE/developmental/broad-v1"

python -m foundry.sidepus.developmental_cli verify \
  --receipt "$SIDEPUS_STATE/developmental/broad-v1/developmental-receipt.json"
```

The compiler uses SQLite-backed streaming inventory indexing and emits schedule references rather than duplicating payloads for every repetition. It has no global demo-sized document cap. A maximum 30% effective-token share for any one subject family is enforced.

## Dedicated evidence

The Sidepus workflow compiles the package, validates the sealed developmental program, runs archive, governance, WARC extraction, rights, hidden-channel, matched-lineage, tamper, lease, range, WACZ, and merge contracts, and checks local parity capabilities.

## Still unproven or incomplete

- no Common Crawl, Wayback, Internet Archive, or fresh-crawl payload has been acquired by this PR;
- no large-scale archive throughput, storage, resume, or merge benchmark has run;
- no scalable payload near-deduplication across the extracted archive is implemented;
- PDF, image, audio, and video semantic adapters are not implemented;
- the current model architecture does not yet consume channel-separated sensory objectives;
- token-budget matching must be wired from schedules into the trainer;
- the four model lineages have not been trained or compared;
- no claim of frontier superiority, general intelligence, or developmental advantage is admitted.

The archive is now authorized and connected to an executable developmental compiler. The next evidence boundary is real bounded acquisition, extraction, and matched training—not more corpus rhetoric.
