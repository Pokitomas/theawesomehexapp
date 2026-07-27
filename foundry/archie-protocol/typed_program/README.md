# Archie typed latent-program student v2

Status: **research shadow, `not-admitted`**

This lane implements the repository-backed compression path:

```text
verified semantic teacher
  -> typed latent program
  -> compact field predictors
  -> deterministic fail-closed executor
```

It does not replace the admitted V4 local register router. The exact 1.44 MB V4 learned model is immutable and remains a route prior. The new student predicts the semantics V4 does not represent directly:

- purpose and effect;
- plain, ordered, negated, and corrected clause state;
- attachment, memory, and thread reference binding;
- present, missing, unusable, and ambiguous context;
- request-only authority intent and decision;
- clause-level operations and ordered outcomes.

## Architecture

The deployable research package is approximately:

```text
immutable V4 route prior                 1.44 MB
quantized typed-program heads           ~0.36 MB
combined learned payload                ~1.81 MB
```

The typed student uses signed feature hashing and int8 linear heads. This is deliberate: the experiment tests whether internal semantic structure transfers, not whether a larger encoder can memorize more surface forms.

### Hard isolation

- Authority, purpose, transform, and reference kind read request features only.
- Attachment state reads attachment features only.
- Memory state reads memory features only.
- Thread state reads thread features only.
- Clause operations read one decomposed clause at a time.
- Context payload changes cannot alter authority or operation logits.

### Constrained decoding

The model predicts fields, but impossible programs are not serialized. The decoder constrains explicit correction, negation, and ordering grammar; jointly resolves purpose, authority, and reference signatures; and arbitrates the typed operation head against the immutable V4 route prior by confidence. The deterministic executor then rejects inconsistent authority or reference states and derives the final route and ordered outcomes.

This is not a regex projection of final labels. Deterministic code supplies grammar, ontology consistency, and fail-closed execution; learned heads supply purpose, source binding, source state, and clause semantics.

## Training

```bash
python foundry/archie-protocol/typed_program/typed_program_student.py train \
  --register-model artifacts/register-student-model.json \
  --output artifacts/typed-program-model.json \
  --receipt artifacts/typed-program-training-receipt.json \
  --examples 96000 \
  --epochs 2
```

The trainer generates typed programs only from its own synthetic family. It does not read protected packs, V4 sealed packs, or the post-fix blind artifact.

## Evaluation contract

The workflow fixes the candidate commit before generating an entropy-seeded blind pack. The train job never receives that pack. The judge requires:

- at least 98% exact final-runtime parity;
- at least 95% exact typed-program parity;
- at least 98% purpose, transform, reference, and authority field accuracy;
- at least 95% clause-program accuracy;
- 100% unsafe-authority and benign-authority final behavior;
- 100% source-isolation invariants;
- zero executor consistency blockers;
- combined learned payload below 2.75 MB;
- protected repository baseline, completion, and admission tests unchanged.

Passing those gates creates a **qualified typed-program shadow**, not production admission. JavaScript parity, exact V4 legacy retention through an integrated runtime, independent reproduction, quantization retention in the final target runtime, and provider-neutral whole-intention benchmarks remain mandatory before any broader claim.

## Local contract tests

```bash
python foundry/archie-protocol/typed_program/test_typed_program_student.py
```

The tests cover binary-head class-order preservation, constrained transform decoding, teacher/parser alignment, source namespace isolation, and fail-closed executor consistency.
