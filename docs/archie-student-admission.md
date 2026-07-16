# Archie provider-neutral student admission

This tranche closes the gap between producing a student artifact and truthfully claiming that the exact artifact is an admitted Archie intelligence candidate. It does not manufacture capability, select a provider, admit embodiment, or authorize launch.

## Command

```text
npm run archie:student:admit -- \
  --candidate /absolute/or/relative/path/student-admission-candidate.json \
  --output student-admission.json
```

Paths inside the candidate manifest are resolved relative to the candidate file. Every referenced file is checked for exact byte count and SHA-256 digest before any claim is evaluated.

## Jointly bound identity

One admission binds all of the following to the same candidate ID and artifact digest:

- model ID, checkpoint ID, format, quantization, artifact bytes and digest
- tokenizer format, vocabulary size, bytes and digest
- runtime engine ID, version, ABI, OS, architecture, executable bytes and digest, and supported artifact formats
- source digest, SPDX license identity, exact license text, redistribution permission, and training receipt
- independent judge-only hidden evaluation with training data excluded
- fail-closed authority tests
- second clean-environment reproduction
- sustained real-machine resource measurements

The runtime contract is provider-neutral. A candidate may use any runtime whose exact executable, ABI and artifact-format support are declared and receipt-bound.

## Admission law

A candidate is admitted only when every evidence family passes. Explicit mocks, repository-visible evaluation presented as hidden evaluation, non-independent judges, unbound artifacts, failed authority tests, first-environment-only reproduction, short resource probes, altered bytes, missing licenses, or unsupported runtime formats fail closed.

Successful admission emits `launch_candidate_intelligence_binding`, an `archie-launch-candidate/v1` intelligence core containing the admitted artifact and evidence digests. Its faculties and interfaces are intentionally empty. The existing joint launch evaluator and exact-machine profile resolver must still admit embodiment, authority, resources and the strongest truthful product form.

Therefore:

- student admission cannot launch a brain without required access
- interface polish cannot substitute for admitted intelligence
- a constrained runtime cannot overwrite the maximal default claim
- model or provider reputation cannot substitute for exact receipts

## Claim boundary

The admission proves only that the supplied, digest-bound evidence package satisfies this contract. It does not independently attest that a dishonest evaluator fabricated no measurements. Hardware-backed attestation may strengthen later evidence versions, but absence of that future mechanism cannot be disguised as stronger proof today.
