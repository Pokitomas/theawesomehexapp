# Generation zero: emergent language–physics search

Generation zero is an executable, architecture-neutral foundry pass. It does not select an LLM, Transformer, state-space model, simulator, graph, field, program, tokenizer, parameter range, context length, modality boundary, or phone-size target in advance.

It creates ten read-only role reports, preserves their contradictions, serializes six complete candidate genomes, leases a conservative/adjacent/heretical experiment portfolio, and executes dependency-free falsification probes for:

- held-out linguistic/event prediction and calibration;
- procedural out-of-distribution linguistic prediction;
- physical rollout and energy drift;
- delayed memory across symbolic and continuous state;
- adaptation after a change in dynamics;
- representation bytes and finite runtime resources.

Plaintext tokens appear only as one candidate adapter. Other candidates use coupled event/field state, reversible object/field state, multiscale latent dynamics, induced programs, and typed relational graphs.

## Run

```bash
npm run foundry:generation-zero -- \
  --out /tmp/sideways-generation-zero \
  --code-revision "$(git rev-parse HEAD)"
```

The output directory contains:

- `mission.json`
- `assignments.json`
- `reports.json`
- `integration.json`
- `portfolio.json`
- `genomes.json`
- `proxy-results.json`
- `negative-results.json`
- `corpus-plan.json`
- `receipt.json`
- `artifact-manifest.json`

## Artifact integrity

Canonical JSON files are written through temporary paths. Any previous completion manifest is removed before mutation, and `artifact-manifest.json` is written last. Therefore:

- a missing manifest means the run is incomplete;
- a byte-length mismatch means the artifact changed after the manifest was created;
- a SHA-256 mismatch means the parsed evidence does not match the completed run;
- a receipt/manifest revision or digest mismatch means the bundle must not be consumed.

The manifest excludes itself from its artifact map to avoid a circular digest. It records the exact code revision, every canonical artifact's byte length and digest, the base protocol receipt digest, and the full generation receipt digest.

Programmatic verification:

```js
import { verifyGenerationZeroArtifactBundle } from './foundry/generation-zero.mjs';

await verifyGenerationZeroArtifactBundle('/tmp/sideways-generation-zero');
```

`receipt.json` has two identities. `receipt_digest` covers the reusable base Foundry protocol receipt. `generation_receipt_digest` covers the complete generation-zero receipt, including the exact revision, executed proxy outcomes, and truth-boundary fields. The CLI's top-level `receipt_digest` points to the full generation digest and separately emits `protocol_receipt_digest`.

## Executable evidence boundary

Candidate names never determine scores. Each selected genome chooses an executable proxy suite through `evaluation.proxy_suite`; that suite trains or infers its own symbolic predictor, oscillator dynamics, adaptation rule, and delayed-memory mechanism. All candidates receive the same deterministic seeds and shared thresholds.

Every seed records separate train, holdout, and procedural out-of-distribution dataset digests plus a digest of the mechanism state that actually produced the result. Renaming a candidate without changing its mechanism leaves all metrics unchanged, and unknown suites fail closed.

The resource receipt reports sampled RSS, serialized state bytes, wall time, and an observed scalar-operation count. These are finite proxy measurements, not active-FLOP, process-peak-memory, energy, or final training-cost claims.

## Corpus boundary

`corpus-plan.json` plans a lawful broad curriculum across web text, code, mathematics, scientific documents and measurements, physical observations, structured diagrams where licensed, and explicit teacher-agent action traces. It requires source-level provenance, licensing or permission, deduplication, revocation, contamination controls, personal-data minimization, and secret rejection.

The command does not download the internet, bypass access controls, acquire a corpus, install dependencies, spend training compute, or train foundation-model weights.

## Admission boundary

Proxy survivors are not promoted. Admission remains blocked until matched-resource evidence, hidden evaluation, broad regression, sabotage review, and reproduced training evidence exist. Failed candidates and admission blockers remain in `negative-results.json`.

No final architecture, scale, tokenizer, corpus sufficiency, general intelligence, phone deployability, or model-weight claim is emitted.
