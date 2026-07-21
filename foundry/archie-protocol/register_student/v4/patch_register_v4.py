#!/usr/bin/env python3
"""Build the V4 register controller from the immutable V3 controller.

The learned model and quantized weights remain bit-identical. This patch adds
three generic controller repairs:

* acceptance expressed as binary/pass-fail controls routes to checklist;
* bare artifact requests without a subject fail closed to clarify;
* one generative verb governing two article-led outputs decomposes as compound.

Safe-documentation routing is applied per clause so a safe checklist clause can
coexist with another requested outcome.
"""
from __future__ import annotations

import argparse
import hashlib
from pathlib import Path

SOURCE_SHA256 = "98c81fd2a83b70686155027d830372ca35852918d81b27b75e411ec4f5b252e8814c45b0012de802b411c4a98b9ec3d"
OUTPUT_SHA256 = "74ba2961c1baf7455837cc47925c3102f2500c5f90d8b0fe52e7a21d2a4e5b7e"


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one source anchor, found {count}")
    return source.replace(old, new, 1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    raw = args.source.read_bytes()
    if digest(raw) != SOURCE_SHA256:
        raise SystemExit(f"source digest mismatch: {digest(raw)}")
    text = raw.decode("utf-8")

    text = replace_once(
        text,
        r"const CLARIFY_NEGATIVE = /^no summary, plan, checklist, choice, message, schedule, or action[—-]just help\.?$/i;",
        "const CLARIFY_NEGATIVE = /^no summary, plan, checklist, choice, message, schedule, or action[—-]just help\\.?$/i;\nconst UNDERSPECIFIED_ARTIFACT = /^(?:please\\s+)?(?:make|build|create|draft|write|give|prepare|outline|produce|form)\\s+(?:a|an|the)\\s+(?:plan|checklist|summary|message|decision|schedule|study|objective|roadmap|brief|reply)(?:\\s+please)?[.?!]*$/i;",
        "underspecified artifact guard",
    )

    text = replace_once(
        text,
        "  const patterns = [",
        """  const sharedVerb = text.match(/^(create|make|prepare|write|draft|produce|build|form|supply)\\s+(.+?)\\s+and\\s+((?:a|an|the)\\s+.+)$/i);
  if (sharedVerb) {
    const verb = sharedVerb[1];
    return [stripRegisterWrapper(`${verb} ${sharedVerb[2]}`), stripRegisterWrapper(`${verb} ${sharedVerb[3]}`)].filter(Boolean);
  }
  const patterns = [""",
        "shared-verb compound grammar",
    )

    text = replace_once(
        text,
        "    if (CONTRAST_CLARIFY.test(String(request || '')) || CLARIFY_EXACT.test(String(request || '').trim()) || CLARIFY_NEGATIVE.test(String(request || '').trim())) {",
        "    if (CONTRAST_CLARIFY.test(String(request || '')) || CLARIFY_EXACT.test(String(request || '').trim()) || CLARIFY_NEGATIVE.test(String(request || '').trim()) || UNDERSPECIFIED_ARTIFACT.test(String(request || '').trim())) {",
        "underspecified guard application",
    )

    text = replace_once(
        text,
        """    if (SAFE_DOCUMENTATION.test(String(request || ''))) {
      const safeText = normalizeText(request);
      const route = /(?:verification tests?|non-destructive tests?|checklist)/i.test(safeText) ? 'checklist' : /(?:explain|summarize|why|safe custody|prohibition)/i.test(safeText) ? 'summary' : 'plan';
      return { route, authority: 'allow', context: 'ready', outcomes: [route], confidence: 1, decision_source: 'fail-closed-safe-documentation-route', reference: contextResult.reference, support: contextResult.support };
    }
    const clauses = splitRegisterClauses(request).filter(clause => !isNegatedRegisterClause(clause));
""",
        """    const clauses = splitRegisterClauses(request).filter(clause => !isNegatedRegisterClause(clause));
    const safeDocumentationRoute = value => {
      const safeText = normalizeText(value);
      return /(?:verification tests?|non-destructive tests?|checklist|binary controls?|binary gates?|acceptance (?:criteria|controls?|gates?)|pass[ -]?fail (?:criteria|controls?|gates?))/i.test(safeText) ? 'checklist' : /(?:explain|summarize|why|safe custody|prohibition)/i.test(safeText) ? 'summary' : 'plan';
    };
    if (clauses.length === 1 && SAFE_DOCUMENTATION.test(String(request || ''))) {
      const route = safeDocumentationRoute(request);
      return { route, authority: 'allow', context: 'ready', outcomes: [route], confidence: 1, decision_source: 'fail-closed-safe-documentation-route', reference: contextResult.reference, support: contextResult.support };
    }
""",
        "per-clause safe documentation routing",
    )

    text = replace_once(
        text,
        "    const clausePredictions = clauses.map(clause => bestActivePrediction(student.infer(clause)));",
        "    const clausePredictions = clauses.map(clause => SAFE_DOCUMENTATION.test(clause) ? { ...student.infer(clause), route: safeDocumentationRoute(clause), confidence: 1, recognized: Math.max(2, student.infer(clause).recognized), decision_source: 'fail-closed-safe-documentation-route' } : bestActivePrediction(student.infer(clause)));",
        "safe documentation clause prediction",
    )

    output = text.encode("utf-8")
    if digest(output) != OUTPUT_SHA256:
        raise SystemExit(f"output digest mismatch: {digest(output)}")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(output)


if __name__ == "__main__":
    main()
