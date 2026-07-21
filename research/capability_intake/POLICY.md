# Capability Intake Policy

Status: research-only and not admitted.

Purpose: describe how public repository ideas may become independently implemented capabilities without automatic code copying, execution, vendoring, or training ingestion.

## Default decision

Every candidate starts rejected until its immutable commit, provenance, license, evidence, intended use, and review decision are recorded.

## Permitted evidence classes

1. Public metadata and repository identity.
2. Public documentation and behavioral descriptions, subject to their terms.
3. Independently written capability specifications and acceptance tests.
4. Exact source files only after explicit approval of their licenses, notices, attribution, and distribution obligations.

## License handling

MIT, BSD-2-Clause, BSD-3-Clause, Apache-2.0, ISC, CC0-1.0, and Unlicense may enter review but are not automatically approved. Apache notices and attribution obligations must be preserved.

Copyleft, network-copyleft, source-available, non-commercial, no-derivatives, custom, missing, conflicting, or unknown licenses remain idea-only or rejected until explicit legal review approves the exact use.

Repository-level licensing does not override narrower file headers, third-party directories, model terms, dataset terms, patents, trademarks, or contributor restrictions.

## Clean-room sequence

1. Pin the exact repository commit.
2. Record every evidence path inspected.
3. Record license identifiers and license-file digests.
4. Write only the capability goal, input/output contract, invariants, failure modes, and measurable tests.
5. Seal that specification with a digest.
6. Give a separate implementer the specification rather than the original implementation.
7. Compare behavior against independently authored tests.
8. Record similarity, attribution, provenance, and dependency review results.
9. Keep the result not admitted until owner review.

## Distillation boundary

Raw implementation source is excluded by default. Any teacher dataset must identify each contributing repository and commit, the permitted evidence class, token counts, filtering decisions, and artifact digests. Transformation into model weights does not by itself resolve licensing or provenance obligations.

Trending status is only a discovery signal. Candidates are ranked by relevance, testability, novelty, provenance clarity, license confidence, maintenance quality, and marginal capability value.

## Compute boundary

This policy does not authorize training. A separate owner-signed dispatch must identify the local base model, hardware, dataset digest, holdout digest, token budget, resume requirements, evaluation contract, and promotion boundary. The selected model should be the largest locally available model that can complete the declared run reproducibly, not simply the largest model name available.
