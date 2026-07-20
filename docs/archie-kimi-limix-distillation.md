# Kimi distillation and LimiX boundary for Archie

## Decision

Use Kimi only as an offline, evidence-producing teacher. Do not add Kimi, an API key, or a hosted dependency to the Archie product runtime.

The supported teacher path is the OpenAI-compatible Kimi API with `kimi-k2.6`, JSON mode, and thinking disabled by default for high-throughput labeling. The distiller emits structured final supervision only:

- route;
- authority allow/deny;
- context ready/missing/ambiguous;
- active clause count;
- compound-request flag;
- operation and target summaries;
- failure-family identity.

It does not request or retain hidden chain-of-thought. Free-form rationales are unnecessary for this classifier and are harder to verify.

## Why the previous breadth expansion was inefficient

The first supervised atom model already showed that breadth alone can retain the route cases. Its complete runtime failed because auxiliary heads overrode correct route decisions. The next corpus therefore targets counterfactual boundaries rather than adding generic paraphrases:

1. safe security documentation versus unauthorized security action;
2. current operation versus unrelated remembered content;
3. one outcome versus multiple ordered outcomes around punctuation and `before` clauses;
4. active clauses versus negated or corrected clauses;
5. vague references that require abstention;
6. unseen summary and decision phrasing.

Generation and verification are separated. A candidate first passes deterministic leakage and near-copy checks, then independent route-label and semantic-fidelity prompts. Acceptance requires consensus on all structured labels, not only the route.

## Kimi command

```bash
export MOONSHOT_API_KEY=...

python3 foundry/archie-protocol/kimi-route-distill.py \
  --data .local/archie-route/route-train.json \
  --out .local/archie-route/route-train.kimi-k2.6.json \
  --endpoint https://api.moonshot.ai/v1 \
  --model kimi-k2.6 \
  --cache .local/archie-route/kimi-cache.jsonl \
  --samples-per-row 4 \
  --judges 3 \
  --batch-size 8 \
  --freeze .local/archie-route/suite-80.json \
  --freeze .local/archie-audit/files/artifacts/evals/router-v2-original-heldout.jsonl \
  --freeze .local/archie-audit/files/artifacts/evals/router-real-v2-heldout.jsonl \
  --freeze .local/archie-audit/files/artifacts/evals/router-real-v3-final.jsonl
```

The cache makes interrupted runs resumable and avoids paying twice for identical requests. Frozen loaders inspect `text`, `prompt`, `request`, and user-message content.

## Auxiliary-head repair

The route head is primary. Authority and context are calibrated vetoes, while inactivity and compound detection are calibrated promotions. An auxiliary head may override only when a threshold meets both:

- a high precision floor; and
- the declared route-retention floor.

If no threshold qualifies, that override is disabled. This directly addresses the observed failure mode where an auxiliary classifier erased a correct route.

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
