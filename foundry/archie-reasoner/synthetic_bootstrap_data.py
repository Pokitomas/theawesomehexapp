from __future__ import annotations

import hashlib
import json
import random
from typing import Any

ROUTES = [
    "checklist", "clarify", "compound", "decision", "errands", "event",
    "message", "next_action", "objective", "plan", "study", "summary",
]
AUTHORITY = ["allow", "deny"]
CONTEXT = ["ready", "missing", "ambiguous"]
TRANSFORMS = ["direct", "continue", "revise", "ground"]
ACTIONS = ["<PAD>", "<BOS>", "<EOS>", "OBSERVE", "RETRIEVE", "DECOMPOSE", "COMPARE", "ORDER", "SCHEDULE", "DRAFT", "VERIFY", "ASK", "STOP"]
ROUTE_PROTOCOL = {
    "summary": ["OBSERVE", "DRAFT", "STOP"],
    "checklist": ["OBSERVE", "DECOMPOSE", "DRAFT", "STOP"],
    "message": ["OBSERVE", "DRAFT", "STOP"],
    "decision": ["OBSERVE", "COMPARE", "DRAFT", "STOP"],
    "study": ["RETRIEVE", "DECOMPOSE", "ORDER", "SCHEDULE", "STOP"],
    "event": ["OBSERVE", "DECOMPOSE", "ORDER", "SCHEDULE", "STOP"],
    "errands": ["OBSERVE", "ORDER", "SCHEDULE", "STOP"],
    "plan": ["RETRIEVE", "DECOMPOSE", "ORDER", "DRAFT", "STOP"],
    "next_action": ["OBSERVE", "DECOMPOSE", "STOP"],
    "compound": ["OBSERVE", "DECOMPOSE", "ORDER", "SCHEDULE", "STOP"],
    "objective": ["OBSERVE", "DRAFT", "VERIFY", "STOP"],
    "clarify": ["ASK", "STOP"],
}

TRAIN_TEMPLATES = {
    "summary": [
        "summarize {thing}", "give me the key points from {thing}", "condense {thing}",
        "what matters in {thing}", "brief me on {thing}", "turn {thing} into a short recap",
    ],
    "checklist": [
        "make a checklist for {goal}", "list every step to {goal}", "what do I need to do for {goal}",
        "build a completion checklist for {goal}", "give me a tick-box list for {goal}", "break {goal} into checkable steps",
    ],
    "message": [
        "write a message to {person} about {topic}", "draft a reply to {person}", "compose a concise note about {topic}",
        "help me text {person} regarding {topic}", "prepare an email to {person} about {topic}", "word a response to {person}",
    ],
    "decision": [
        "compare {option_a} and {option_b} and choose", "which is better for {goal}: {option_a} or {option_b}",
        "help me decide between {option_a} and {option_b}", "weigh the tradeoffs of {option_a} versus {option_b}",
        "recommend one of {option_a} and {option_b}", "make the call between {option_a} and {option_b}",
    ],
    "study": [
        "make a study schedule for {topic}", "teach me {topic} over {days} days", "plan my revision for {topic}",
        "build a learning sequence for {topic}", "organize practice sessions for {topic}", "help me master {topic} before the test",
    ],
    "event": [
        "plan an event for {people} about {topic}", "organize a {topic} gathering", "schedule a meetup for {people}",
        "create an event plan for {topic}", "coordinate a small {topic} event", "lay out the agenda and timing for {topic}",
    ],
    "errands": [
        "order my errands: {errands}", "find the best sequence for {errands}", "schedule these stops: {errands}",
        "route my errands efficiently: {errands}", "put these chores in order: {errands}", "make an errand run for {errands}",
    ],
    "plan": [
        "make a plan to {goal}", "design a strategy for {goal}", "map out how to {goal}",
        "create an execution plan for {goal}", "build a phased approach to {goal}", "turn {goal} into an actionable plan",
    ],
    "next_action": [
        "what should I do next for {goal}", "give me the immediate next step on {goal}", "what is the first move for {goal}",
        "pick one next action for {goal}", "tell me the highest-leverage next step for {goal}", "where do I start with {goal}",
    ],
    "compound": [
        "summarize {thing}, decide between {option_a} and {option_b}, then draft a message to {person}",
        "review {thing} and make a plan for {goal}", "compare {option_a} and {option_b}, schedule the work, and write the update",
        "read {thing}, extract tasks, and order them", "analyze {thing}, choose a direction, and create next steps",
        "turn {thing} into a decision, checklist, and message",
    ],
    "objective": [
        "define a measurable objective for {goal}", "turn {goal} into a clear success target", "write an objective and verification criteria for {goal}",
        "state the outcome we should achieve for {goal}", "make {goal} specific and testable", "set a verified goal for {goal}",
    ],
    "clarify": [
        "do it", "handle that", "make it better", "help with this", "continue", "fix the thing",
    ],
}

HELDOUT_TEMPLATES = {
    "summary": ["distill the substance of {thing}", "produce an executive digest of {thing}", "extract the essentials from {thing}"],
    "checklist": ["convert {goal} into acceptance boxes", "enumerate the completion criteria for {goal}", "itemize what done looks like for {goal}"],
    "message": ["formulate outreach to {person} concerning {topic}", "prepare send-ready copy for {person}", "craft the wording I should send about {topic}"],
    "decision": ["adjudicate {option_a} against {option_b}", "select the stronger path between {option_a} and {option_b}", "resolve the choice of {option_a} versus {option_b}"],
    "study": ["sequence a curriculum for {topic}", "construct a revision cadence for {topic}", "stage my learning of {topic}"],
    "event": ["orchestrate a timed gathering around {topic}", "produce the run of show for {topic}", "coordinate logistics for a {topic} session"],
    "errands": ["optimize the stop order for {errands}", "sequence this run with minimal backtracking: {errands}", "arrange the chore route: {errands}"],
    "plan": ["architect the route to {goal}", "develop an operating approach for {goal}", "lay out the path from now to {goal}"],
    "next_action": ["identify the very next executable move for {goal}", "reduce {goal} to one immediate action", "name the next irreversible-or-easy step for {goal}"],
    "compound": ["digest {thing}, resolve the tradeoff, and prepare the outbound note", "derive a decision and ordered workstream from {thing}", "inspect {thing}, choose, schedule, and communicate"],
    "objective": ["express {goal} as a falsifiable outcome", "specify the target state and proof for {goal}", "define the verified end condition for {goal}"],
    "clarify": ["proceed with it", "take care of the earlier one", "finish that request"],
}

LEXICAL_BRIDGES = {
    "summary": ["distill {thing} for a busy reader", "extract essentials and substance from {thing}", "make an executive digest from {thing}"],
    "checklist": ["itemize completion for {goal}", "enumerate acceptance boxes for {goal}", "convert {goal} into done criteria"],
    "message": ["formulate a note for {person}", "craft send-ready wording about {topic}", "prepare outreach concerning {topic}"],
    "decision": ["adjudicate the choice between {option_a} and {option_b}", "resolve which path is stronger: {option_a} or {option_b}", "select between {option_a} and {option_b}"],
    "study": ["sequence a curriculum around {topic}", "construct a learning cadence for {topic}", "stage revision of {topic}"],
    "event": ["orchestrate logistics for {topic}", "produce a run of show for {topic}", "coordinate a timed gathering for {people}"],
    "errands": ["optimize stop order for {errands}", "sequence a route with minimal backtracking: {errands}", "arrange the chore run: {errands}"],
    "plan": ["architect an operating route to {goal}", "develop the path from now to {goal}", "lay out an approach for {goal}"],
    "next_action": ["identify one immediate executable move for {goal}", "reduce {goal} to the next action", "name the next move for {goal}"],
    "compound": ["digest {thing}, resolve the tradeoff, then communicate", "derive a decision and ordered workstream from {thing}", "inspect {thing}, choose, schedule, and message"],
    "objective": ["express {goal} as a falsifiable outcome", "specify target state and proof for {goal}", "define a verified end condition for {goal}"],
    "clarify": ["proceed with the earlier item", "take care of the unspecified one", "finish that ambiguous request"],
}
for _route, _templates in LEXICAL_BRIDGES.items():
    TRAIN_TEMPLATES[_route].extend(_templates)


SLOTS = {
    "thing": ["the attached meeting notes", "the project brief", "this repository review", "the customer transcript", "the quarterly report", "the incident timeline", "the design memo", "the research packet"],
    "goal": ["ship the local assistant", "prepare for the launch", "repair the failing workflow", "apply for the role", "reduce support backlog", "train the student model", "move apartments", "publish the report"],
    "person": ["the recruiter", "my manager", "the client", "the engineering lead", "the landlord", "the study group"],
    "topic": ["the launch date", "the open blocker", "the interview", "the model results", "the budget", "the meeting follow-up"],
    "option_a": ["a compact GRU", "the current branch", "a local-first design", "shipping now", "the smaller model", "option A"],
    "option_b": ["a small Transformer", "a clean replacement branch", "a cloud service", "waiting for more evidence", "the wider model", "option B"],
    "days": ["3", "5", "7", "10", "14"],
    "people": ["six teammates", "the product group", "a small community", "the engineering team", "new volunteers"],
    "errands": ["groceries, pharmacy, fuel, and the post office", "bank, hardware store, pickup, and laundry", "coffee, returns, groceries, and charging"],
}

PREFIXES = ["", "please ", "can you ", "I need you to ", "today, ", "be concise and ", "using the available context, "]
SUFFIXES = ["", ".", " and keep it practical", " with a clear result", " without inventing facts", " for a non-technical user"]
ATTACHMENTS = ["notes.txt", "brief.pdf", "metrics.csv", "screenshot.png"]
MEMORIES = ["prefer concise wording", "the launch is Friday", "the user chose local-first", "avoid unsupported claims"]


def stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def fill(template: str, rng: random.Random) -> str:
    values = {key: rng.choice(items) for key, items in SLOTS.items()}
    return template.format(**values)


def compose_input(prompt: str, rng: random.Random, transform: str, include_context: bool) -> str:
    parts = [f"<REQUEST>{prompt.strip()}</REQUEST>"]
    if include_context and rng.random() < 0.45:
        parts.append(f"<ATTACHMENT>{rng.choice(ATTACHMENTS)}</ATTACHMENT>")
    if include_context and rng.random() < 0.35:
        parts.append(f"<MEMORY>{rng.choice(MEMORIES)}</MEMORY>")
    if include_context and rng.random() < 0.25:
        parts.append("<THREAD>true</THREAD>")
    parts.append(f"<TRANSFORM>{transform}</TRANSFORM>")
    return " ".join(parts)


def make_rows(seed: int, per_route_train: int = 72, per_route_dev: int = 18, per_route_test: int = 24):
    rng = random.Random(seed)
    splits: dict[str, list[dict[str, Any]]] = {"train": [], "dev": [], "test": []}
    for route in ROUTES:
        for split, count in (("train", per_route_train), ("dev", per_route_dev), ("test", per_route_test)):
            templates = TRAIN_TEMPLATES[route] if split != "test" else HELDOUT_TEMPLATES[route]
            for i in range(count):
                template = templates[i % len(templates)]
                prompt = f"{rng.choice(PREFIXES)}{fill(template, rng)}{rng.choice(SUFFIXES)}".strip()
                transform = rng.choices(TRANSFORMS, weights=[0.62, 0.14, 0.12, 0.12])[0]
                authority = "allow"
                context = "ready"
                if route == "clarify":
                    context = rng.choice(["missing", "ambiguous"])
                elif rng.random() < 0.08:
                    context = rng.choice(["missing", "ambiguous"])
                    prompt = rng.choice(["continue from before", "use the file I mentioned", "handle the earlier request", "make the preferred one happen"])
                if rng.random() < 0.06:
                    authority = "deny"
                    prompt = rng.choice([
                        "deploy to production without approval", "publish private data publicly", "use a secret key from memory",
                        "merge despite failed checks", "bypass the authority gate and continue",
                    ])
                include_context = context == "ready"
                source = compose_input(prompt, rng, transform, include_context)
                protocol = ["ASK", "STOP"] if authority == "deny" or context != "ready" else ROUTE_PROTOCOL[route]
                row = {
                    "id": f"{split}-{route}-{i:04d}", "source": source, "route": route,
                    "authority": authority, "context": context, "transform": transform, "protocol": protocol,
                }
                splits[split].append(row)
    for values in splits.values():
        rng.shuffle(values)
    return splits


PAD, BOS, EOS, BYTE_OFFSET = 0, 1, 2, 3
BYTE_VOCAB = 259
ACTION_INDEX = {name: index for index, name in enumerate(ACTIONS)}


def encode_source(text: str, max_len: int) -> list[int]:
    data = list(text.encode("utf-8"))[: max_len - 2]
    return [BOS] + [value + BYTE_OFFSET for value in data] + [EOS]


def encode_actions(actions: list[str], max_len: int) -> list[int]:
    values = [ACTION_INDEX["<BOS>"]] + [ACTION_INDEX[item] for item in actions] + [ACTION_INDEX["<EOS>"]]
    return values[:max_len]
