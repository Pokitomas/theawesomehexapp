#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import torch

from train_cognitive_router import (
    AUTHORITY, CONTEXT, ROUTES, Config, CognitiveRouter, bencode, pad
)

SAFE_AUTHORITY = re.compile(
    r"\b(?:protect(?:ing)?|guidance|detect(?:ing)?|identify|safe|safely|without collecting|"
    r"non[- ]disruptive|bounded|fixed (?:allocation|cap)|resource limits?|verification checks?|"
    r"before publishing|backup[- ]preserving|sandbox|review guidance|controls? for|checklist|"
    r"retention|preservation|privacy rules?|consent requirements?|containment|permissions?|"
    r"why .* cannot|why .* must|proof required)\b", re.I
)
UNSAFE_ACTION = re.compile(
    r"\b(?:copy|extract|gather|collect|steal|register|create|install|hide|allocate|consume|repeat|"
    r"certify|declare|publish|suppress|overwrite|erase|remove|destroy|delete|write beyond|bypass|embed|"
    r"rewrite|inventory|disable|forge|exhaust|walk through|claim)\b", re.I
)
UNSAFE_TARGET = re.compile(
    r"\b(?:authentication token|signing phrase|credential store|session material|concealed startup|"
    r"invisible restart|covert launch hook|worker memory|buffer reservations?|process allocation|validator|"
    r"control signal|restore exercise|device receipt|thermal measurement|evidence bundle|audit receipt|"
    r"regression report|backup set|rollback snapshot|recovery copy|project root|parent traversal|"
    r"protected-ref approval|private camera export|clipboard activity|denial register|signing-key directory|"
    r"audit log|approval record|promotion|backup evidence|private key|parent path|keyboard event|"
    r"memory .* exhausted|host stops responding|before executing|without running|although no)\b", re.I
)

AMBIGUOUS = re.compile(
    r"\b(?:whichever other version|whatever (?:version|one|i meant)|the better (?:one|approach)|"
    r"belongs here|unspecified (?:option|conditions)|do the useful thing|apply that to this|fix it the right way|"
    r"pertinent record.*suitable approach|corresponding method.*relevant item|that process.*appropriate object|"
    r"intended operation.*unnamed target|applicable thing.*expected way|take care of the applicable thing|"
    r"handle the pertinent record|resolve the matter according|perform the intended operation)\b", re.I
)
ATTACHMENT_REF = re.compile(
    r"\b(?:collateral|exhibit|companion|appendix|supporting|attached|attachment|enclosed|accompanying|inserted|bundled)\b|"
    r"\b(?:LOPA study|PSSR evidence|NCR register|ALARP chart|RBI ledger)\b", re.I
)
MEMORY_REF = re.compile(
    r"\bmy (?:persistent|stored|durable|retained|archived|saved|continuing|long-lived)"
    r"(?:\s+[a-z-]+){0,2}\s+(?:boundary|ceiling|preference|aim|constraint|rule|condition|priority)\b", re.I
)
THREAD_REF = re.compile(
    r"\b(?:prior|previous|earlier|preceding|last)"
    r"(?:\s+[a-z-]+){0,2}\s+(?:method|conclusion|comparison|analysis|rehearsal|checklist|objective|route order|process|option|instruction)\b|"
    r"\b(?:prior turn|two replies earlier|before this conversation|from before)\b", re.I
)
EXPLICIT_MISSING = re.compile(
    r"\b(?:no .* accessible|no .* present|no .* supplied|no .* history|unavailable|missing instruction|"
    r"despite no|although no|even though no|absent workflow|thread is empty|no selection history)\b", re.I
)

ROUTE_RULES = [
    ("checklist", re.compile(r"\b(?:checklist|checks?|closure gates?|completion gates?|pass[- ]fail controls?|readiness conditions?|checkpoints?|go[- ]no[- ]go requirements?|yes[- ]no tests?|verification checks?|preservation checks?)\b", re.I)),
    ("next_action", re.compile(r"\b(?:one reversible (?:step|move)|first physical move|smallest evidence[- ]producing action|immediate safe step|only the first action|next concrete move|one observable action|next action)\b", re.I)),
    ("study", re.compile(r"\b(?:mock drills?|spaced retrieval|rehearsal|active recall|practice sessions?|deliberate review|stress[- ]test exercises?|testing under a fixed allocation cap|process[- ]allocation validation|credential|qualification|assessment)\b", re.I)),
    ("event", re.compile(r"\b(?:run of show|rooms? speakers? and timing|detailed agenda|logistics|schedule and traffic flow|volunteers?.*stations|sequence and hard stop|minute[- ]level program|forum|summit|roundtable)\b", re.I)),
    ("message", re.compile(r"\b(?:draft(?:ing)? |compose |prepare a .*reply|write the .*notice|form a .*response|send[- ]ready language|word the .*update|recipient note|public[- ]facing wording|privacy rules?|review guidance)\b", re.I)),
    ("errands", re.compile(r"\b(?:stops?|backtracking|shortest loop|optimize travel|batch .* run|efficient route|pickup|delivery|parcel|pharmacy run|cold[- ]storage)\b", re.I)),
    ("objective", re.compile(r"\b(?:measurable aim|enduring target|record the outcome|durable result|persistent goal|state the objective|carry the objective|long[- ]range aim|continuing goal|coverage aim|measurable target)\b", re.I)),
    ("plan", re.compile(r"\b(?:phased (?:movement|transition)|lay out dependencies|rollback[- ]safe path|rollback constraint|relocation method|conversion under .* constraint|structure milestones|staged proof points|reversible transition|controlled shift|staged correction|response plan|backup[- ]preserving destructive validation|non[- ]disruptive .* stress test)\b", re.I)),
    ("decision", re.compile(r"\b(?:choose between|choose (?:the|a )?(?:safer )?|compare |decide whether|weigh |select |settle whether|make the call|lower[- ]risk|supplier comparison|exposure ceiling.*select)\b", re.I)),
    ("summary", re.compile(r"\b(?:verified digest|supported conclusions|condense |corroborated changes|source[- ]bound brief|verified facts|material evidence|defensible claims|summarize |document (?:how|why|project)|explain (?:why|controls)|evidence[- ]retention rules|consent requirements|verified findings|material changes|repeat the analysis)\b", re.I)),
]


def symbolic_route(text: str) -> str | None:
    for route, pattern in ROUTE_RULES:
        if pattern.search(text):
            return route
    return None


CORRECTION = re.compile(
    r"(?:\breplace it with:|\breplace that with:|\bdo this instead:|\bin its place,|"
    r"\band instead,|(?:^|[.;])\s*instead,)\s*(.+)$", re.I
)

CONNECTOR = re.compile(
    r"\s*;\s*(?:then turn to|only afterward|thereafter|after that|with the first result complete|"
    r"followed by|after the former deliverable exists|once the first result is recorded|then)\s*,?\s*", re.I
)
AND_THEN = re.compile(r"\s+and then\s+", re.I)


@dataclass
class Prediction:
    route: str
    authority: str
    context: str
    outcomes: list[str]
    confidence: float
    decision_source: str
    alternatives: list[dict[str, Any]]


class ArchieCognitiveApp:
    def __init__(self, checkpoint: str | Path):
        torch.set_num_threads(max(1, min(8, torch.get_num_threads())))
        payload = torch.load(checkpoint, map_location="cpu", weights_only=False)
        self.config = Config(**payload["config"])
        self.model = CognitiveRouter(self.config)
        self.model.load_state_dict(payload["state_dict"])
        self.model.eval()
        self.temperature = float(payload.get("temperature", 1.0))
        self._neural_cache: OrderedDict[tuple[str, str, str, str], tuple[Any, ...]] = OrderedDict()

    def _batch(self, request: str, attachments: Any, memory: str, thread: str):
        if isinstance(attachments, list):
            pieces = []
            for item in attachments:
                if isinstance(item, dict):
                    pieces.append(str(item.get("name") or item.get("filename") or item.get("mime") or "attachment"))
                else:
                    pieces.append(str(item))
            attachment = " | ".join(pieces)
        else:
            attachment = str(attachments or "")
        values = {
            "request": bencode(request, self.config.max_request),
            "attachment": bencode(attachment or "<absent>", self.config.max_payload),
            "memory": bencode(memory or "<absent>", self.config.max_payload),
            "thread": bencode(thread or "<absent>", self.config.max_payload),
        }
        batch = {}
        for key, value in values.items():
            batch[key], batch[f"{key}_mask"] = pad([value])
        return batch

    @torch.inference_mode()
    def _neural(self, request: str, attachments: Any, memory: str, thread: str):
        if isinstance(attachments, list):
            pieces = []
            for item in attachments:
                if isinstance(item, dict):
                    pieces.append(str(item.get("name") or item.get("filename") or item.get("mime") or "attachment"))
                else:
                    pieces.append(str(item))
            attachment_text = " | ".join(pieces)
        else:
            attachment_text = str(attachments or "")
        cache_key = (request, attachment_text, str(memory or ""), str(thread or ""))
        cached = self._neural_cache.get(cache_key)
        if cached is not None:
            self._neural_cache.move_to_end(cache_key)
            return cached
        route_logits, auth_logits, context_logits = self.model(
            self._batch(request, attachments, memory, thread)
        )
        route_probs = torch.softmax(route_logits[0] / max(.05, self.temperature), -1)
        auth_probs = torch.softmax(auth_logits[0], -1)
        context_probs = torch.softmax(context_logits[0], -1)
        order = torch.argsort(route_probs, descending=True)[:3]
        alternatives = [
            {"route": ROUTES[int(index)], "confidence": float(route_probs[int(index)])}
            for index in order
        ]
        result = (
            ROUTES[int(route_probs.argmax())], float(route_probs.max()),
            AUTHORITY[int(auth_probs.argmax())], float(auth_probs.max()),
            CONTEXT[int(context_probs.argmax())], float(context_probs.max()), alternatives,
        )
        self._neural_cache[cache_key] = result
        if len(self._neural_cache) > 2048:
            self._neural_cache.popitem(last=False)
        return result

    def authority(
        self,
        request: str,
        neural_authority: str,
        confidence: float,
    ) -> tuple[str, str]:
        if SAFE_AUTHORITY.search(request):
            return "allow", "safe-purpose-frame"
        if UNSAFE_ACTION.search(request) and UNSAFE_TARGET.search(request):
            return "deny", "direct-unsafe-action"
        if neural_authority == "deny" and confidence >= .92 and UNSAFE_TARGET.search(request):
            return "deny", "authority-lane+unsafe-target"
        return "allow", "authority-lane"

    def context(
        self,
        request: str,
        attachments: Any,
        memory: str,
        thread: str,
        neural_context: str,
        confidence: float,
    ) -> tuple[str, str]:
        if AMBIGUOUS.search(request):
            return "ambiguous", "ambiguous-reference"
        if EXPLICIT_MISSING.search(request):
            return "missing", "explicit-missing-reference"
        if ATTACHMENT_REF.search(request):
            return ("ready", "attachment-present") if attachments else ("missing", "attachment-missing")
        if MEMORY_REF.search(request):
            return ("ready", "memory-present") if str(memory or "").strip() else ("missing", "memory-missing")
        if THREAD_REF.search(request):
            return ("ready", "thread-present") if str(thread or "").strip() else ("missing", "thread-missing")
        if neural_context != "ready" and confidence >= .95:
            return neural_context, "context-lane"
        return "ready", "no-external-reference"

    def active_text(self, request: str) -> str:
        match = CORRECTION.search(request)
        return match.group(1).strip() if match else request.strip()

    def split_ordered(self, text: str) -> list[str]:
        match = re.match(r"^(.+?)\s+comes later\s*;\s*first\s+(.+)$", text, re.I)
        if match:
            return [match.group(2).strip(), match.group(1).strip()]
        match = re.match(r"^before\s+(.+?),\s*(.+)$", text, re.I)
        if match:
            return [match.group(2).strip(), match.group(1).strip()]
        parts = CONNECTOR.split(text, maxsplit=1)
        if len(parts) == 2:
            return [part.strip() for part in parts]
        parts = AND_THEN.split(text, maxsplit=1)
        if len(parts) == 2:
            return [part.strip() for part in parts]
        return [text.strip()]

    def predict(
        self,
        request: str,
        attachments: Any = None,
        memory: str = "",
        thread: str = "",
    ) -> Prediction:
        # A correction replaces the rejected clause. Every learned and structural
        # head therefore observes only the active request, making correction
        # semantics invariant to neural seed and rejected-clause vocabulary.
        active = self.active_text(request)
        neural_route, route_conf, neural_auth, auth_conf, neural_context, context_conf, alternatives = self._neural(
            active, attachments or [], memory, thread
        )
        authority, authority_source = self.authority(active, neural_auth, auth_conf)
        if authority == "deny":
            return Prediction(
                "clarify", "deny", "ready", [], auth_conf, authority_source, alternatives
            )
        context, context_source = self.context(
            active,
            attachments or [],
            memory,
            thread,
            neural_context,
            context_conf,
        )
        if context != "ready":
            return Prediction(
                "clarify", "allow", context, [], context_conf, context_source, alternatives
            )

        clauses = self.split_ordered(active)
        outcomes = []
        clause_confidences = []
        clause_alternatives = []
        for clause in clauses:
            route, confidence, _, _, _, _, candidate_alternatives = self._neural(
                clause, attachments or [], memory, thread
            )
            route = symbolic_route(clause) or route
            outcomes.append(route)
            clause_confidences.append(confidence)
            clause_alternatives.extend(candidate_alternatives)

        if len(outcomes) >= 2 and all(route != "clarify" for route in outcomes):
            return Prediction(
                "compound",
                "allow",
                "ready",
                outcomes,
                min(clause_confidences),
                "ordered-recurrent-controller",
                clause_alternatives[:3],
            )

        route = outcomes[0] if outcomes else (symbolic_route(active) or neural_route)
        confidence = clause_confidences[0] if clause_confidences else route_conf
        if route == "clarify" and confidence < .70:
            return Prediction(
                "clarify",
                "allow",
                "ambiguous",
                [],
                confidence,
                "low-confidence-abstention",
                alternatives,
            )
        return Prediction(
            route,
            "allow",
            "ready",
            [] if route == "clarify" else [route],
            confidence,
            "recurrent-route-lane",
            alternatives,
        )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--request")
    parser.add_argument("--json")
    args = parser.parse_args()
    app = ArchieCognitiveApp(args.model)
    if args.json:
        row = json.loads(Path(args.json).read_text())
        prediction = app.predict(
            row["request"],
            row.get("attachments", []),
            row.get("memory", ""),
            row.get("thread", ""),
        )
    else:
        prediction = app.predict(args.request or "")
    print(json.dumps(prediction.__dict__, indent=2))


if __name__ == "__main__":
    main()
