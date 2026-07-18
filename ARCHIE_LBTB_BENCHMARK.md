# Archie LBTB real-source benchmark

The LBTB purchase-order program is the first actual consumer-workflow source package bound to Archie’s outcome-compounding product law.

This tranche does not treat a static redesign as customer-value proof. It pins the exact source identities and compares two materially different product hypotheses against the inherited Apps Script project before any live-service or human study is admitted.

## Pinned sources

The receipt at `maker/evaluations/lbtb-real-source-benchmark.json` records SHA-256 identities for three external source archives:

- the inherited LBTB PO Processing project;
- the queue-first LBTB Order Desk operator hypothesis;
- the mail-client LBTB PO Mail hypothesis.

The source archives are not vendored because they include deployment-local material outside the bounded benchmark. The receipt preserves only:

- archive digests;
- the complete `src/**` tree digest and byte count;
- exact hashes for the homepage, processing interface, routing file, and Apps Script manifest;
- the client-to-server function call set;
- bounded static interface mechanics;
- changed-source-file boundaries;
- the selection and rejection record.

It does not preserve `.clasp.json`, Apps Script deployment identity, absolute local paths, raw source contents, credentials, Gmail data, Drive data, Sheets data, or customer records.

## Reproduce from extracted packages

```bash
npm run archie:lbtb:benchmark -- \
  --baseline /path/to/LBTB-PO-Processing-main \
  --baseline-archive-sha256 <sha256> \
  --operator /path/to/LBTB-Order-Desk \
  --operator-archive-sha256 <sha256> \
  --mail /path/to/LBTB-PO-Mail \
  --mail-archive-sha256 <sha256> \
  --output maker/evaluations/lbtb-real-source-benchmark.json
```

The generator scans only `src/**`. It requires the inherited homepage, processing interface, `Admin_WebApp.js`, and `appsscript.json`, derives the server function inventory, and intersects it with client calls found in the two UI files.

## Baseline

The inherited product exposes a multi-step testing and processing interface. The pinned source has:

- 47 files under `src/**`;
- no responsive media query in the processing interface;
- explicit Step 1 and Step 2 labels;
- the full Apps Script call set for configuration, inbox listing, processing, PDF text, JSON, logs, Drive contents, and interface routing.

These are static source observations, not claims about operator behavior.

## Competing hypotheses

### Operator

The operator hypothesis treats the primary object as an incoming PO queue and makes progress, evidence, recent activity, and audit state first-class. It changes only:

```text
src/UI_HomePage.html
src/UI_POProcessInterface.html
```

Its complete non-UI `src/**` digest is byte-identical to the inherited project. The Apps Script manifest, routing file, and complete client call set are unchanged. The processing interface adds three responsive media-query contracts.

### Mail

The mail hypothesis treats the primary object as an email: open one message, inspect the PDF, then process the PO. It is a materially different counterfactual, not a color variant.

It changes the two UI files and `src/Admin_WebApp.js`, changes the default route, and narrows the exercised client call set by omitting the existing log and Drive-folder calls. It remains useful as negative and alternative product evidence, but it is deferred by this static gate.

## Selection

The pinned receipt selects the operator hypothesis for the next executable benchmark because it simultaneously proves:

- binding to the actual source package;
- byte-preservation of the complete backend tree;
- preservation of the Apps Script manifest and routing file;
- preservation of every inherited client/server function call;
- a phone-responsive interface contract;
- visible queue, progress, evidence, recent-activity, and audit mechanics.

That selection means “strongest source-preserving candidate for live evaluation.” It does not mean “proven better for customers.”

## Next evidence required

Customer-value promotion remains closed until the same pinned baseline and candidate are exercised against real authorized service contracts and a clean study records, at minimum:

- time to first useful state;
- taps or steps to completion;
- correction burden;
- ambiguous and failed orders;
- mobile completion;
- operator intervention;
- evidence completeness;
- explicit approval and rollback integrity.

Live Gmail, Drive, and Sheets access requires credentials and customer authorization and is not fabricated in CI. Physical phone evidence remains subordinate to the independent device program.

## Commands

```bash
npm run test:archie:lbtb
npm run archie:lbtb:receipt
```

`archie:lbtb:receipt` verifies the checked-in receipt and prints its exact digest, selected hypothesis, and closed claim boundary without requiring the external archives.
