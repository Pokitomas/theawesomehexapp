# Archie Sidepus broad diet

Sidepus is now the provenance and deduplication layer in front of Archie Hybrid training. It freezes explicitly governed source bytes before transforming anything, then compiles a deterministic observational export that both the curriculum exchange and token-corpus builder verify independently.

It is intentionally not an instruction generator. Text, code, archive members, and deterministic binary measurements enter as observations. Archie still needs real local image, audio, and sensor adapters to perceive pixels, waveforms, infrared, or ultraviolet signals directly; metadata and bytefield sketches only establish provenance-bound cross-modal structure.

## Pipeline

1. `sidepus-source-plan/v1` names local, URL, pinned GitHub, and Internet Archive sources with an explicit license or rights label.
2. `sidepus-source-lock/v1` freezes every selected object into a SHA-256 object store and records retrieval provenance.
3. The compiler safely walks ZIP and tar members without extracting paths, applies quality and secret filters, and produces text or modality observations.
4. Exact text, Unicode-normalized text, and SimHash near-duplicate checks remove repetition deterministically.
5. `sidepus-diet-manifest/v1`, `sidepus-export-receipt/v1`, and `dedupe-decisions.jsonl` bind every selected and rejected record.
6. Archie’s curriculum exchange scores the frozen documents with the current and parent models, bargains for bounded focus, and seals the exact document repetitions.
7. The corpus builder verifies the Sidepus receipt, exchange inventory, starting-model hash, and development split before producing training bytes.

No network request occurs during compilation or training. Network and mutable local state exist only before the source lock is sealed.

## One-command local baseline

```bash
cd "/mnt/c/Users/AwesomeKai/Documents/New project/theawesomehexapp-archie-train"
ARCHIE_SIDEPUS_STATE=/home/awesomekai/archie-sidepus-v1 \
  bash foundry/archie-distill/run_sidepus_diet.sh
```

The first run creates `/home/awesomekai/archie-sidepus-v1/source-plan.json`, freezes the repository, compiles the export, and verifies it. Re-running verifies and reuses the same immutable source lock.

## Add broad public sources

Edit the plan’s `sources` array. GitHub revisions must be exact 40-character commits. Internet Archive files are explicit names or bounded globs. URL checksums are optional during the first freeze because the resulting lock records SHA-256, but known upstream SHA-256 values should be supplied.

`foundry/archie-distill/sidepus-public-diet.unsealed.json` is a ready-to-seal public-diet example containing exact Linux and CPython Git revisions plus one explicit Internet Archive text object. Its rights label remains an operator assertion, not a legal determination.

```json
{
  "id": "linux-kernel",
  "type": "github",
  "repository": "torvalds/linux",
  "revision": "REPLACE_WITH_EXACT_40_CHARACTER_COMMIT",
  "license": "GPL-2.0-only"
}
```

```json
{
  "id": "public-archive-text",
  "type": "internet_archive",
  "item": "REPLACE_WITH_ITEM_ID",
  "files": ["REPLACE_WITH_EXACT_FILE_NAME.txt"],
  "license": "public-domain"
}
```

```json
{
  "id": "governed-snapshot",
  "type": "url",
  "url": "https://example.org/public-corpus.tar.gz",
  "logical_path": "public-corpus.tar.gz",
  "expected_sha256": "REPLACE_WITH_KNOWN_SHA256",
  "license": "REPLACE_WITH_LICENSE"
}
```

Reseal the edited plan, then use a fresh state directory so an older source lock can never be silently repurposed:

```bash
/home/awesomekai/.venv-archie-cuda/bin/python \
  foundry/archie-distill/sidepus_broad_diet.py seal \
  --plan /home/awesomekai/archie-sidepus-v2/source-plan.json

ARCHIE_SIDEPUS_STATE=/home/awesomekai/archie-sidepus-v2 \
  bash foundry/archie-distill/run_sidepus_diet.sh
```

## Train from the diet

Use Sidepus-only mode when the plan already contains the Archie repositories. This prevents a second ungoverned copy of the same files entering beside the deduped export.

```bash
cd "/mnt/c/Users/AwesomeKai/Documents/New project/theawesomehexapp-archie-train"
ARCHIE_INCLUDE_LOCAL_SOURCES=0 \
ARCHIE_SIDEPUS_EXPORTS=/home/awesomekai/archie-sidepus-v1/export \
ARCHIE_PURSUIT_STATE=/home/awesomekai/archie-sidepus-pursuit-v1 \
ARCHIE_STUDENT_MODEL="$PWD/returns/generative-next/archie-hybrid-generative-next.pt" \
ARCHIE_PARENT_MODEL="$PWD/returns/generative-final/archie-hybrid-generative.pt" \
ARCHIE_PURSUIT_EXPORT_DIR="$PWD/returns/generative-sidepus-pursuit" \
ARCHIE_FOCUS_FRACTION=0.75 \
ARCHIE_MAX_STEPS=300 \
ARCHIE_DEADLINE_MINUTES=60 \
ARCHIE_PLASTIC_MODE=delta \
  bash foundry/archie-distill/run_archie_pursuit.sh
```

When a Sidepus export is present, the launcher defaults to raw observational records and zero synthetic span tasks. The student still controls bounded focus through its measured model-native taste; the teacher counteroffer preserves learning progress and broad replay.

For large public exports, curriculum scoring uses a deterministic domain/split-stratified sample capped by `ARCHIE_MAX_SCORED_DOCUMENTS` (default `4096`). All documents remain in baseline training; sampling limits only the expensive model probes. Focus allocation uses a deterministic heap, so adding a Linux-sized source does not create a quadratic selection loop.

## Current evidence

The first local frozen diet selected 967 observations from 975 candidates: 610 code, 184 data, 104 text, 66 binary, and 3 image-metadata observations. Eight records were rejected by explicit quality or secret filters. Its manifest digest is `372cd59a346a26118dcd21adb2d2f9975861015788e7350a4f07b3f1fe8af853`.

The completed 24.14M-parameter student at SHA-256 `9173f9b479c8949916db16eb4a61a67c610afdeb1da92733fd9ba8717e61a56f` negotiated exchange `b41af5fef16a5d57ae993752c7a2e7b3baa0a64f22be29b56cdb5c6c4111c86a`. That exchange compiled to 14,109,971 training tokens and 2,507,980 untouched development tokens with matching inventory and starting-model bindings.

The pinned public v2 source lock contains Linux revision `248951ddc14de84de3910f9b13f51491a8cd91df`, CPython revision `cbd15390e474e254ad2590c57de7e3bf657c0a09`, and one explicit Internet Archive text object. Its verified export contains 90,198 selected observations in 1,554,746,918 bytes. Sidepus rejected 10,616 candidates, including 7,816 near duplicates and 592 repeated raw objects. Public export manifest: `dc53ca7025aaf8bc32430eea14a594cbdc39f0170bfe4bff2f552d4169c19cd0`.

The public exchange `2c6eae4d3391953f5c8c429e5c4d29add582bba51766da084211e1905365d6fe` covers all 90,198 documents while scoring a deterministic 512-document sample. It compiled to 1,563,218,387 training tokens and 83,662,312 development tokens. A real 100-step continuation consumed 819,200 public-corpus tokens with zero skipped nonfinite steps and produced model `1848fb938a21bdf6c2267957cf3efbf8ace36b1f38051dedddf2c8c493b774cf`.

Evidence is deliberately mixed. On 261,888 identical full-window development tokens, public-corpus bits per byte improved from `4.609727` to `2.458572` (`46.67%`). The preselected curriculum probes regressed by `0.027734` bits per byte overall, with only the Gutenberg domain improving. Fast-state transfer improved from slightly harmful before public training to `0.0457%` helpful afterward with 9 of 12 cases improved, but it still fails the `3%` plastic-transfer gate. The model is therefore a materially better public-distribution learner, not an admitted dynamically adapting organism.
