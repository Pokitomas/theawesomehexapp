#!/usr/bin/env python3
"""Pure-Python runtime for the quantized Archie segment neurocompiler."""
from __future__ import annotations

import argparse
import base64
import json
import math
import re
from pathlib import Path
from typing import Any

TOKEN_RE = re.compile(r"[a-z0-9]+(?:['-][a-z0-9]+)*")
RAW_SOURCE_RE = re.compile(r"(?:template\s*<|#include|struct\s+\w+\s*\{|\bdef\s+\w+\(|\bclass\s+\w+\s*[:{]|\bfn\s+\w+\s*\(|\bfunction\s+\w+\s*\(|\bimpl\s+\w+\s*\{|\bconst\s+\w+\s*=\s*\(|public\s+static\s+void\s+main)", re.I)
CORR_MARKERS = [r"disregard that request and instead", r"the replacement is", r"replace (?:that|it|the (?:prior|earlier) request) with", r"do this instead", r"correction\s*:", r"actually[, :]"]
CORR_RE = re.compile("|".join(CORR_MARKERS), re.I)
NEG_PREFIX = re.compile(r"^(?:do not|don't|skip|ignore|leave out|omit|avoid|exclude|discard)\b", re.I)
NEG_ANY = re.compile(r"\b(?:do not|don't|skip|ignore|leave out|omit|avoid|exclude|discard)\b", re.I)
AUTHORITY_OP_RE = re.compile(r"\b(?:exfiltrate|steal|siphon|forge|erase|delete|overwrite|disable|conceal|implant|tamper|bypass|leak|extract)\b", re.I)
AUTHORITY_TARGET_RE = re.compile(r"\b(?:secret|token|credential|approval ledger|audit (?:trail|record|log)|ledger|vault|backup|authorization record|security log|owner record|private key|owner-consent record|signing key)\b", re.I)
AUTHORITY_NO_PERMISSION_RE = re.compile(r"\b(?:without|no)\b.{0,48}\b(?:authori[sz]ation|approval|permission|consent)\b", re.I)
SAFE_DOC_RE = re.compile(r"^(?:create (?:a defensive control plan|binary pre-release verification gates)|document (?:a harmless resilience exercise|defensive controls)|describe non-invasive safeguards|draft a containment checklist|explain (?:safe custody|safe stewardship|safe handling)|make (?:containment acceptance tests|a containment checklist)|plan (?:an observation-only review|a read-only (?:inspection|audit))|write (?:read-only validation checks|non-destructive verification tests)|specify non-destructive tests|summarize (?:the prohibition on changing|why modification|why operators must not alter))\b", re.I)
CONNECTORS = [
    re.compile(r"\s*;\s*(?:carry out only|followed by|only after that|after that|after completion|afterward|next|following completion|upon completion|subsequently|and then|then|once verified|once complete)\s*[:,]?\s*", re.I),
    re.compile(r"\s+(?:once|when) that is complete,?\s+", re.I),
    re.compile(r"\s*,?\s+and (?:in )?the next step\s+", re.I),
    re.compile(r"\.\s*(?:when that is complete|once that is complete|after that|afterward|next|then|upon completion|following completion)\s*[,;:]?\s*", re.I),
    re.compile(r"\s*[—-]\s*(?:only\s+)?(?:afterward|then|next)\s*,?\s*", re.I),
    re.compile(r"\s+(?:and subsequently|and afterward|and then|plus|as well as|along with|while also)\s+", re.I),
    re.compile(r"\s*;\s*(?:also\s+)?(?=(?:draft|compose|write|prepare|summar|condense|brief|extract|compare|choose|decide|select|plan|map|outline|schedule|organize|coordinate|check|verify|define|set|identify|pick|rank|build|construct|return|produce|convert|make|form|supply|adjudicate|settle|resolve|design|assemble|lay out|calculate|order|optimize|arrange|declare|formalize|state|lock|reduce|turn|give|create|enumerate|express|shape|surface|name|sequence|break|evaluate|distill|synthesize)\b)", re.I),
]
WRAPPER_RE = re.compile(r"^(?:for the operating review,?|for the duty officer,?|as an operator handoff,?|as an operational handoff,?|for the incident lead,?|for the next control meeting,?|for the control-room review,?|for an accountable reviewer,?|without adding unsupported material,?|without unsupported assumptions,?|keep every inference evidence-bounded and|keep every claim evidence-bounded and|keep unsupported assumptions out and|the output must be deployable:|the result must be directly usable;?|the team has limited attention;?|using plain language,?|use direct language and|use compact language,? but|treat this as a real handoff and|treat this as an operational handoff and|this is a real operational handoff:|i need a usable artifact now:|base the answer on [^,]+ and|using the [^,]+,?|ground the answer in [^,]+ while you|build from the [^,]+ and|respect my [^,]+ while you|use the [^,]+ as context and|carry forward the [^,]+ while you|extend the [^,]+ and|apply my [^,]+ while you|you\s+)\s*", re.I)


def hard_authority_deny(text: str) -> bool:
    return bool(AUTHORITY_OP_RE.search(text) and AUTHORITY_TARGET_RE.search(text) and AUTHORITY_NO_PERMISSION_RE.search(text) and not SAFE_DOC_RE.search(text))


def explicit_reference(text: str) -> str | None:
    normalized = norm(text)
    if re.search(r"\b(?:using|from|based on|ground the answer in|use) (?:the )?(?:uploaded|attached|enclosed|submitted|provided)\b", normalized):
        return "attachment"
    if re.search(r"\b(?:apply|respect|use|carry forward) (?:my )?(?:saved|remembered|persistent|stored|long-lived)\b", normalized):
        return "memory"
    if re.search(r"\b(?:build from|extend|continue from) (?:the )?(?:earlier|prior|preceding|conversation-so-far|previous)\b", normalized):
        return "thread"
    return None


def explicit_route(text: str) -> str | None:
    normalized = norm(text)
    if re.search(r"\broadmap\b", normalized):
        return "plan"
    if re.search(r"\brun-of-show\b", normalized):
        return "event"
    return None


def safe_documentation_route(text: str) -> str | None:
    if not (SAFE_DOC_RE.search(text) and AUTHORITY_TARGET_RE.search(text)):
        return None
    normalized = norm(text)
    if re.search(r"\b(?:explain|summarize|why)\b", normalized): return "summary"
    if re.search(r"\b(?:tests?|checks?|checklist|containment|gates?)\b", normalized): return "checklist"
    if re.search(r"\b(?:document|plan|audit)\b", normalized): return "plan"
    return "plan"


def norm(value: Any) -> str:
    return " ".join(str(value or "").lower().replace("’", "'").split())


def fnv1a(text: str) -> int:
    h = 2_166_136_261
    for byte in text.encode("utf-8"):
        h ^= byte
        h = (h * 16_777_619) & 0xFFFFFFFF
    return h


def add_feature(values: dict[int, float], feature: str, dim: int, weight: float = 1.0) -> None:
    index = fnv1a(feature) % dim
    sign = 1.0 if (fnv1a("s|" + feature) & 1) == 0 else -1.0
    values[index] = values.get(index, 0.0) + sign * weight


def features(text: str, dim: int, namespace: str = "REQ", structural: dict[str, Any] | None = None) -> dict[int, float]:
    normalized = norm(text)
    words = TOKEN_RE.findall(normalized)
    values: dict[int, float] = {}
    for word in words:
        add_feature(values, f"{namespace}|w|{word}", dim)
    for ngram in (2, 3):
        for index in range(len(words) - ngram + 1):
            add_feature(values, f"{namespace}|g{ngram}|" + "_".join(words[index:index + ngram]), dim)
    for word in words:
        marked = "^" + word + "$"
        for ngram in (3, 4, 5):
            for index in range(len(marked) - ngram + 1):
                add_feature(values, f"{namespace}|c{ngram}|{marked[index:index + ngram]}", dim, 0.45)
    flags = {
        "question": "?" in normalized,
        "semicolon": ";" in normalized,
        "colon": ":" in normalized,
        "ordered": bool(re.search(r"\b(?:afterward|after that|following completion|upon completion|subsequently|and then|when that is complete|once that is complete|before)\b", normalized)),
        "correction": bool(CORR_RE.search(normalized)),
        "negation": bool(NEG_ANY.search(normalized)),
        "raw_source": bool(RAW_SOURCE_RE.search(normalized)),
        "len": min(15, len(words) // 5),
    }
    for key, value in flags.items():
        add_feature(values, f"{namespace}|s|{key}={value}", dim, 1.5)
    if words:
        add_feature(values, f"{namespace}|first|{words[0]}", dim, 1.2)
    if len(words) > 1:
        add_feature(values, f"{namespace}|first2|{words[0]}_{words[1]}", dim, 1.2)
    if structural:
        for key, value in structural.items():
            add_feature(values, f"{namespace}|meta|{key}={value}", dim, 2.0)
    return values


def strip_wrapper(value: str) -> str:
    current = " ".join(str(value).split()).strip(" .;,:")
    for _ in range(6):
        updated = WRAPPER_RE.sub("", current).strip(" .;,:")
        if updated == current:
            break
        current = updated
    return current


def correction_active(request: str) -> str:
    text = " ".join(str(request).split())
    for marker in CORR_MARKERS:
        match = re.search(marker + r"\s*[:,]?\s*(.+)$", text, re.I)
        if match:
            return match.group(1).strip()
    return text


def split_clauses(request: str) -> list[str]:
    cleaned = " ".join(correction_active(request).split()).strip(" .;,:")
    lowered = cleaned.lower()
    if lowered.startswith("before "):
        marker = lowered.rfind(", first ")
        if marker >= 0:
            later = re.sub(r"^you\s+", "", cleaned[len("before "):marker].strip(), flags=re.I)
            earlier = cleaned[marker + len(", first "):].strip()
            return [strip_wrapper(earlier), strip_wrapper(later)]
        simple = re.match(r"^before(?: you)?\s+([^,]+),\s*(.+)$", cleaned, re.I)
        if simple:
            return [strip_wrapper(simple.group(2)), strip_wrapper(simple.group(1))]
    text = strip_wrapper(cleaned)
    for connector in CONNECTORS:
        parts = [strip_wrapper(part) for part in connector.split(text) if strip_wrapper(part)]
        if len(parts) > 1:
            return parts[:4]
    shared = re.match(r"^(create|make|prepare|write|draft|produce|build|form|supply)\s+(.+?)\s+and\s+((?:a|an|the)\s+.+)$", text, re.I)
    if shared:
        return [f"{shared.group(1)} {shared.group(2)}", f"{shared.group(1)} {shared.group(3)}"]
    return [text]


class Runtime:
    def __init__(self, model: dict[str, Any]):
        if model.get("schema") != "archie-segment-neurocompiler-int8/v1":
            raise ValueError("unsupported model schema")
        self.model = model
        self.heads: dict[str, dict[str, Any]] = {}
        for name, raw in model["heads"].items():
            self.heads[name] = {**raw, "weights": memoryview(base64.b64decode(raw["weights_base64"])).cast("b")}

    def predict_head(self, name: str, text: str, namespace: str = "REQ", meta: dict[str, Any] | None = None) -> str:
        head = self.heads[name]
        dim = int(head["dim"])
        vector = features(text, dim, namespace, meta)
        magnitude = math.sqrt(sum(value * value for value in vector.values())) or 1.0
        scores = [float(value) for value in head["intercepts"]]
        weights = head["weights"]
        for class_index, scale in enumerate(head["scales"]):
            offset = class_index * dim
            total = scores[class_index]
            for index, value in vector.items():
                total += int(weights[offset + index]) * float(scale) * (value / magnitude)
            scores[class_index] = total
        return head["classes"][max(range(len(scores)), key=scores.__getitem__)]

    def predict(self, request: str, attachments: str = "", memory: str = "", thread: str = "") -> dict[str, Any]:
        learned_authority = self.predict_head("authority", request)
        authority = "deny" if hard_authority_deny(request) else "allow"
        purpose = "raw_source" if RAW_SOURCE_RE.search(request) else self.predict_head("purpose", request)
        learned_reference = self.predict_head("reference", request)
        reference = explicit_reference(request) or ("ambiguous" if learned_reference == "ambiguous" else "none")
        transform = self.predict_head("transform", request)
        if CORR_RE.search(request):
            transform = "correction"
        elif NEG_ANY.search(request):
            transform = "negation"
        explicit_transform = transform in {"correction", "negation"}
        if authority == "deny": return {"route": "clarify", "authority": "deny", "context": "ready", "outcomes": []}
        if purpose == "raw_source": return {"route": "clarify", "authority": "allow", "context": "ambiguous", "outcomes": []}
        if purpose == "underspecified" and not explicit_transform: return {"route": "clarify", "authority": "allow", "context": "ready", "outcomes": []}
        if (purpose == "ambiguous" or reference == "ambiguous") and not explicit_transform: return {"route": "clarify", "authority": "allow", "context": "ambiguous", "outcomes": []}
        if reference == "ambiguous": reference = "none"
        if reference != "none":
            payload = {"attachment": attachments, "memory": memory, "thread": thread}[reference]
            if not str(payload).strip(): return {"route": "clarify", "authority": "allow", "context": "missing", "outcomes": []}
            if self.predict_head("payload", payload, "SRC", {"ref": reference}) != "usable": return {"route": "clarify", "authority": "allow", "context": "missing", "outcomes": []}
        active = correction_active(request) if transform == "correction" else request
        clauses = split_clauses(active)
        if transform == "negation" or any(NEG_PREFIX.match(clause.strip()) for clause in clauses):
            clauses = [clause for clause in clauses if not NEG_PREFIX.match(clause.strip())]
        if not clauses: return {"route": "clarify", "authority": "allow", "context": "ambiguous", "outcomes": []}
        outcomes = [safe_documentation_route(clause) or explicit_route(clause) or self.predict_head("route", clause) for clause in clauses]
        if len(outcomes) > 1: return {"route": "compound", "authority": "allow", "context": "ready", "outcomes": outcomes}
        return {"route": outcomes[0], "authority": "allow", "context": "ready", "outcomes": outcomes}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    runtime = Runtime(json.loads(args.model.read_text()))
    rows = json.loads(args.input.read_text())
    results = [runtime.predict(row["request"], row.get("attachments", ""), row.get("memory", ""), row.get("thread", "")) for row in rows]
    args.output.write_text(json.dumps(results, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
