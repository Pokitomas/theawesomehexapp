# Sidepus web archive v2

## Status

Sidepus v1 is a deterministic corpus compiler for a manually enumerated collection. It is useful as provenance-aware ingestion, but it is not a web archive and does not have Common Crawl or Internet Archive acquisition parity.

Sidepus v2 separates three authorities:

1. **archive acquisition** discovers or captures immutable WARC/ARC/WACZ bytes;
2. **content policy** decides what portions of the historical and fresh web may be acquired;
3. **curriculum compilation** later decides what archived observations should become training data.

Only the first authority is implemented here. The archive plan is created with `content_policy: null`, and the canonical CLI refuses discovery, fresh capture, worker execution, or shard import until an operator-approved `sidepus-content-policy/v2` is installed.

This is deliberate. Infrastructure may be aggressive; subject selection may not be smuggled in as a default.

## Hard parity contract

Sidepus v2 fails parity unless all of these lanes exist and validate their outputs:

| Lane | Required mechanism |
| --- | --- |
| Common Crawl bounded discovery | CDXJ queries that produce exact WARC filename, offset, and length jobs |
| Common Crawl broad discovery | DuckDB SQL over the Parquet URL Index, with an explicit record ceiling |
| Common Crawl retrieval | HTTP `Range` retrieval that requires `206`, exact byte length, and a valid WARC record |
| Internet Archive holdings | Exact item/file acquisition for WARC, legacy ARC, and WACZ |
| Wayback discovery | CDX capture discovery with explicit derivative labeling |
| Wayback retrieval | Replay bytes wrapped in a new provenance-bound WARC; never represented as the original WARC |
| Local archive ingestion | WARC 1.0/1.1, ARC through `warcio`, and WACZ with path-safe extraction |
| Fresh static capture | GNU Wget with `--warc-file` support |
| Fresh browser capture | Browsertrix `crawl` CLI or an explicit container command |
| Heritrix compatibility | Import and validate Heritrix-produced WARC/ARC output; Java is needed only to run Heritrix itself |
| Resume and distribution | immutable job IDs, expiring leases, deterministic shards, one SQLite catalog per worker |
| Merge | deep-verify worker objects and event chain, then content-addressed set union |
| Storage | SHA-256 object store with a SQLite authority ledger |
| Validation | WARC framing, content length, block digest where declared, WACZ member safety, deep object verification |
| Governance | every acquisition job bound to the sealed content-policy SHA-256 |

The doctor command checks local dependencies and, when requested, the public archive endpoints:

```bash
bash foundry/sidepus/run_sidepus.sh doctor
```

`--require-parity` exits nonzero if a mandatory adapter, dependency, capture engine, or requested endpoint is unavailable. A passing doctor proves that the tooling is callable. It does not claim that Sidepus holds the web, equals either archive's collection, or has selected a good corpus.

## Linux setup

```bash
python3 -m venv ~/.venv-sidepus
source ~/.venv-sidepus/bin/activate
python -m pip install -r foundry/sidepus/requirements-parity.txt

export SIDEPUS_PYTHON="$HOME/.venv-sidepus/bin/python"
export SIDEPUS_STATE="$HOME/sidepus-archive-v2"
bash foundry/sidepus/run_sidepus.sh
```

The launcher creates only:

- a disk-backed catalog;
- a SHA-256 object store;
- an infrastructure plan;
- an event ledger.

It does not create Common Crawl queries, Wayback queries, Internet Archive item lists, browser seeds, a subject distribution, language ratios, era ratios, or crawl depth.

## Content-policy stop

Before any acquisition, the operator must approve a policy with these explicit fields:

```json
{
  "schema": "sidepus-content-policy/v2",
  "approved_by_operator": true,
  "purposes": [],
  "historical_sources": [],
  "fresh_capture": {},
  "languages": [],
  "time_ranges": [],
  "subject_allocations": {},
  "exclusions": [],
  "maximum_archive_bytes": 0
}
```

Install it only after the content decision:

```bash
python -m foundry.sidepus.governed_cli install-content-policy \
  --state-dir "$SIDEPUS_STATE" \
  --policy /path/to/operator-approved-content-policy.json
```

The policy is immutable within a state directory. A different policy requires a fresh state or an explicit future migration mechanism. Capture requests must name the exact installed policy digest. Pending jobs are rewritten once to carry that digest, and workers reject unbound or mismatched jobs.

## Historical acquisition

### Common Crawl CDX

Use this only for bounded URL or domain queries. The input is JSONL and must be written after the content policy is approved:

```json
{"crawl":"CC-MAIN-YYYY-NN","url":"example.org/*","match_type":"prefix","filter":["status:200"],"limit":1000}
```

```bash
python -m foundry.sidepus.governed_cli discover-commoncrawl-cdx \
  --state-dir "$SIDEPUS_STATE" \
  --queries /path/to/approved-commoncrawl-queries.jsonl \
  --receipt "$SIDEPUS_STATE/receipts/commoncrawl-cdx.json"
```

Each result becomes an exact byte-range job. Workers require HTTP 206, the indexed length, valid WARC framing, and matching payload digest when available.

### Common Crawl Parquet URL Index

This is the scalable discovery path. The operator supplies SQL against the `cc_url_index` view and an explicit maximum result count:

```bash
python -m foundry.sidepus.governed_cli discover-commoncrawl-index \
  --state-dir "$SIDEPUS_STATE" \
  --crawl CC-MAIN-YYYY-NN \
  --sql /path/to/approved-selection.sql \
  --max-records 1000000 \
  --receipt "$SIDEPUS_STATE/receipts/commoncrawl-index.json"
```

The SQL must return:

- `url`
- `warc_filename`
- `warc_record_offset`
- `warc_record_length`

Optional columns such as MIME, language, status, digest, and fetch time are retained in provenance.

No default SQL is included because default predicates would silently make the content decision.

### Wayback CDX

```bash
python -m foundry.sidepus.governed_cli discover-wayback \
  --state-dir "$SIDEPUS_STATE" \
  --queries /path/to/approved-wayback-queries.jsonl
```

The public CDX response generally does not provide original WARC byte ranges. Sidepus therefore stores replay responses as newly generated derivative WARCs with the original target, capture timestamp, replay source URI, HTTP response, and a derivative boundary. It does not pretend those bytes are the original archive object.

### Internet Archive items

```json
{"item":"EXACT_ITEM_IDENTIFIER","include":["*.warc.gz","*.arc.gz","*.wacz"]}
```

```bash
python -m foundry.sidepus.governed_cli discover-internet-archive \
  --state-dir "$SIDEPUS_STATE" \
  --items /path/to/approved-items.jsonl
```

File size and upstream SHA-1/MD5 are verified when the item metadata supplies them. WACZ members are extracted without trusting archive paths. Legacy ARC is converted to WARC-shaped record metadata through `warcio`.

## Fresh capture

Create a request template only after deciding the content scope:

```bash
python -m foundry.sidepus.governed_cli capture-template \
  --engine wget \
  --output /path/to/capture-request.json \
  --capture-output-dir "$SIDEPUS_STATE/fresh/example"
```

Supported engines:

- `wget`: builds a GNU Wget WARC command and verifies that installed Wget exposes `--warc-file`;
- `browsertrix`: uses the Browsertrix `crawl` CLI or an exact explicit command with `{seeds}`, `{output}`, and `{collection}` substitutions;
- `external`: runs an exact argument array for Heritrix or another archival crawler and accepts the run only if valid WARC/ARC/WACZ appears.

The request is rejected unless it contains the exact 64-character installed content-policy digest. A zero exit code is not success by itself. Every emitted archive must ingest and validate.

## Workers, shards, and merge

Run a worker against one catalog:

```bash
python -m foundry.sidepus.governed_cli worker \
  --state-dir "$SIDEPUS_STATE" \
  --owner workstation-a \
  --limit 1000
```

Create deterministic JSONL job shards:

```bash
python -m foundry.sidepus.governed_cli export-shards \
  --state-dir "$SIDEPUS_STATE" \
  --output-dir "$SIDEPUS_STATE/shards" \
  --shards 32
```

Each worker should use its own state directory and import one or more shards. Do not place one SQLite catalog on a shared network filesystem.

Merge a completed worker:

```bash
python -m foundry.sidepus.governed_cli merge-worker \
  --state-dir "$SIDEPUS_STATE" \
  --worker-state /path/to/worker-state
```

Merge performs a deep source verification, rejects policy mismatch, copies or reuses objects by SHA-256, unions jobs and WARC records, and emits a merge receipt. Re-merging the same worker is idempotent.

## Tests

```bash
python -m unittest -v foundry.sidepus.test_sidepus_archive
```

The contract suite covers:

- generated WARC validation;
- WACZ extraction and traversal rejection;
- real HTTP range behavior;
- placeholder capture-policy rejection;
- unbound job rejection;
- bound WARC ingestion;
- lease expiration;
- deep catalog verification;
- idempotent worker merge;
- malformed WARC rejection.

## What remains intentionally undone

Sidepus v2 does not yet:

- choose the content policy;
- extract cleaned training documents from archive records;
- perform scalable text, image, audio, or video decoding;
- deduplicate payloads across the full archive catalog;
- rank archive records for curriculum;
- create train/development/test splits;
- claim web completeness or archive equivalence in holdings;
- claim that more web data improves Archie.

Those belong after the operator content decision and before training. Acquisition parity is a prerequisite, not a curriculum.
