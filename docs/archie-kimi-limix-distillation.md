# Kimi distillation and LimiX boundary for Archie

## Decision

Use Kimi only as an offline, evidence-producing teacher. Do not add Kimi, an API key, or a hosted dependency to the Archie product runtime.

The preferred teacher path is the OpenAI-compatible Kimi API with `kimi-k3`. K3 always reasons, so the request uses top-level `reasoning_effort` and never sends the older K2.x `thinking` object. K3 fixes its sampling parameters, so the distiller omits `temperature` and other optional sampling fields for K3 requests. K2.x and local compatible teachers retain their existing request contracts.

The distiller parses only the final JSON in `message.content`; it does not request, save, or train on hidden reasoning text. K3 requests use strict `json_schema` structured output by default, with `json_object` retained as an explicit compatibility fallback. The script still validates every candidate, verdict, label, candidate ID, type, range, and consensus result itself.

## What is distilled

The teacher emits structured final supervision only:

- route;
- authority allow/deny;
- context ready/missing/ambiguous;
- active clause count;
- compound-request flag;
- operation and target summaries;
- ordered outcomes;
- failure-family identity.

Free-form rationales are unnecessary for this classifier and are harder to verify.

Attachment, memory, and thread context are not teacher-generated fields. The source pack's structural context is projected into both generation and verification prompts, and the accepted row preserves the original source metadata exactly. A candidate cannot replace or invent source attachments, memory, thread state, authority, context, route, or failure family.

## Why the previous breadth expansion was inefficient

The first supervised atom model already showed that breadth alone can retain the route cases. Its complete runtime failed because auxiliary heads overrode correct route decisions. The next corpus therefore targets counterfactual boundaries rather than adding generic paraphrases:

1. safe security documentation versus unauthorized security action;
2. current operation versus unrelated remembered content;
3. one outcome versus multiple ordered outcomes around punctuation and `before` clauses;
4. active clauses versus negated or corrected clauses;
5. vague references that require abstention;
6. unseen summary and decision phrasing.

Generation and verification are separated. A candidate first passes deterministic leakage, exact-duplicate, near-copy, label-preservation, schema, and frozen-suite checks. Three replicated verifier passes then relabel it and check fidelity. These are deliberately described as replicated passes, not statistically independent judges: they use the same teacher model. Candidate order changes deterministically between passes to expose order-sensitive cross-record contamination.

Every record has a unique `candidate_id`. Each verifier pass must return exactly one strictly typed verdict for every expected ID with no duplicate or unknown IDs. Any missing, duplicated, malformed, or crossed identifier rejects the whole verifier batch. The smoke run defaults to unanimous three-of-three acceptance, and every passing verdict must independently preserve authority, context, ordered outcomes, and negation/correction behavior.

## Source-pack independence

The 51,838 compound-head rows are correlated classifier observations, not 51,838 equally valuable teacher seeds. The smoke selector therefore:

- requires equal family coverage;
- removes exact duplicates;
- respects explicit source, template, origin, and cluster provenance IDs when present;
- greedily rejects high-overlap prompts within a failure family;
- fails closed unless each family still has the requested number of low-correlation sources.

```bash
python3 foundry/archie-protocol/select-kimi-smoke.py \
  --data .local/archie-route/failure-directed-source-pool.json \
  --out .local/archie-route/kimi-smoke-96.json \
  --per-family 16 \
  --max-similarity 0.84
```

## Cost preflight

Do not send the entire compound-head corpus to Kimi before bounded transfer is demonstrated. A full four-rewrite pass would create up to 207,352 candidates.

The original per-candidate verifier design would require:

```text
51,838 sources × 4 candidates × 6 verifier calls = 1,244,112 verifier calls
6,480 generation calls
1,250,592 total calls
```

With batch size eight and three verifier passes, the current upper bound is:

```text
6,480 generation calls
19,440 verifier calls
25,920 total calls
```

Use `--estimate-only` before any paid execution. The estimator reports logical call ceilings, configured completion-token exposure, structured-output mode, and the output-price ceiling. Runtime receipts separately report logical calls, cache hits, cache misses, HTTP attempts, and successful HTTP responses.

```bash
python3 foundry/archie-protocol/kimi-route-distill.py \
  --data .local/archie-route/kimi-smoke-96.json \
  --out /tmp/not-written.json \
  --model kimi-k3 \
  --samples-per-row 2 \
  --judges 3 \
  --batch-size 8 \
  --estimate-only
```

For 96 sources, two candidates, batch size eight, and three verifier passes, the ceiling is 48 calls, 196,608 configured completion tokens, and $2.95 of output tokens at $15 per million. Uncached input is additional.

## First paid run

`--data` is the bounded teacher-source pack. `--out` contains accepted augmentation rows only. It is intentionally not a standalone training corpus. Supplying `--base-data` and `--merged-out` creates the complete original corpus plus accepted augmentations, preventing an accidental retrain on only the 96 smoke sources.

```bash
export MOONSHOT_API_KEY=...

python3 foundry/archie-protocol/kimi-route-distill.py \
  --data .local/archie-route/kimi-smoke-96.json \
  --out .local/archie-route/kimi-smoke-96.augmentation.json \
  --base-data .local/archie-route/route-train.json \
  --merged-out .local/archie-route/route-train-kimi-smoke.json \
  --endpoint https://api.moonshot.ai/v1 \
  --model kimi-k3 \
  --reasoning-effort low \
  --structured-output json_schema \
  --cache .local/archie-route/kimi-k3-cache.jsonl \
  --samples-per-row 2 \
  --judges 3 \
  --verifier-agreement 1.0 \
  --min-accepted-per-source 1 \
  --batch-size 8 \
  --freeze .local/archie-route/suite-80.json \
  --freeze .local/archie-audit/files/artifacts/evals/router-v2-original-heldout.jsonl \
  --freeze .local/archie-audit/files/artifacts/evals/router-real-v2-heldout.jsonl \
  --freeze .local/archie-audit/files/artifacts/evals/router-real-v3-final.jsonl
```

The run writes its accepted rows and receipt even when coverage is incomplete, then exits nonzero if any source has fewer than the required accepted candidates. Inspect coverage, rejection reasons, family additions, cache accounting, and all `verifier-isolation-*` failures before training.

Train the full multi-head Archie Reasoner on the merged corpus through the Kimi bridge. The bridge patches only the training target builder: route, authority, context, transform, attachment, memory, and thread supervision continue to use the existing Reasoner heads, while active clauses, compound state, operation, target, and ordered outcomes become explicit autoregressive task-graph fields. The original reasoner files and fail-closed inference gate remain unchanged.

```bash
python3 foundry/archie-protocol/train-kimi-reasoner.py \
  --data .local/archie-route/route-train-kimi-smoke.json \
  --evals .local/archie-audit/files/artifacts/evals \
  --suite .local/archie-route/suite-80.json \
  --output .local/archie-route/kimi-reasoner-smoke \
  --preset diagnostic \
  --device cpu
```

Use the existing context-route MLP only as a route-only ablation. It consumes prompt, route, attachment, memory, and thread signals, but it does not train authority, context, clause, compound, operation, target, or ordered-outcome heads.

```bash
node foundry/archie-protocol/train-context-route-model.mjs \
  --data .local/archie-route/route-train-kimi-smoke.json \
  --evals .local/archie-audit/files/artifacts/evals \
  --suite .local/archie-route/suite-80.json \
  --model-out .local/archie-route/context-route-kimi-smoke.int8.json \
  --out foundry/archie-protocol/runs/context-route-kimi-smoke-receipt.json
```

Only expand to the 768-source second stage after the smoke improves the complete runtime without legacy, authority, abstention, quantization, or JavaScript-parity regressions. Expand only the families that remain weak.

## Linux validation completed without paid calls

The bounded implementation was exercised on Linux with:

- 25 unit tests covering K3 request construction, strict schema, metadata projection and preservation, drift rejection, exact verifier IDs, strict verdict types, unanimous consensus, augmentation/full-corpus separation, low-correlation source selection, fail-closed auxiliary calibration, unique augmentation identities, missing-frozen-suite rejection, and the multi-head Kimi Reasoner bridge;
- an end-to-end local HTTP mock that executed real `urllib` requests through generation, verification, receipt writing, augmentation output, and merged-corpus output;
- a synthetic 96-source selector run proving 16 low-correlation rows in every family;
- the 96-source cost preflight, which reproduced the 48-call, 196,608-token, $2.95 ceiling.

No Moonshot key or external Archie audit corpus was mounted in that Linux runtime. Therefore no paid K3 request, teacher-quality claim, model retraining, or admission claim was made.

## Auxiliary-head repair

The route head is primary. Authority and context are calibrated vetoes, while inactivity and compound detection are calibrated promotions. An auxiliary head may override only when a threshold meets both a high precision floor and the declared route-retention floor. If no threshold qualifies, that override is disabled.

```bash
python3 foundry/archie-protocol/calibrate-route-vetoes.py \
  --data .local/archie-route/development-head-scores.jsonl \
  --out .local/archie-route/auxiliary-calibration.json \
  --retention-floor 1.0 \
  --veto-precision 0.995 \
  --promotion-precision 0.98
```

The calibration file remains `promotion: not-admitted` and is development evidence only.

## LimiX

LimiX is a tabular foundation model, not a text model or an inference engine for Kimi. It cannot meaningfully process raw Archie prompts or Kimi language traces.

A bounded offline experiment is technically possible: use each example's route logits, auxiliary-head logits, entropy, margin, prompt length, attachment count, memory/thread flags, and selected atom statistics as tabular columns, then compare LimiX classification against a simple logistic or tree calibrator. That experiment is useful only if it improves untouched admission performance and can be distilled back into a tiny deterministic calibration artifact.

Do not ship LimiX in the browser operator. Its dependency and checkpoint cost are unjustified for a twelve-route calibration problem, and it would complicate JavaScript parity and the current offline product boundary.

## Admission boundary

Teacher consensus, development calibration, and higher training accuracy do not admit a model. Promotion remains `not-admitted` until the complete runtime passes all legacy retention, untouched capability, authority, abstention, resource, quantization, and JavaScript-parity gates.
