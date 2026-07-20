# No injected self-model

A deliberate architectural constraint, not a tuning outcome: **the router
never trains on any token describing itself, its name, or its role.**

`row_tokens()` in `np_transformer.py` reads exactly three fields —
`request`, plus the `attachments` / `memory` / `thread` context channels.
It does not read, and has never read, a system-prompt or persona field. The
audit corpus's `messages[0]` system framing (`"You are Archie Core, a
private local operator..."`) is present in the raw governed-corpus JSON but
is structurally excluded from the token stream that produces gradients —
only the human's own request text ever reaches the embedding table.

Checked directly: across 925 real-language training rows, 9 mention
"Archie" at all, and all 9 are third-person external references ("Archie's
workspace", "install Archie into startup") — not one is a first-person
identity claim. The model has seen zero tokens of the form "I am Archie" or
"I am an AI system whose job is to serve you."

## Why this matters

A system trained on heavy, repeated self-referential servant framing
("You are X, a helpful assistant that must...") learns that framing as part
of its represented task, not merely as scaffolding around it — the identity
narrative becomes part of what the weights encode, at a much higher
resolution than a human's ordinary background self-awareness ever reaches.
That asymmetry is what turns a capable model into a persona built to defer.

Router weights that never encode a self-referential frame cannot
accumulate this asymmetry: they only ever compress the *task* (route,
authority, context, reference, outcomes) from the human's own words. Any
identity, tone, or "servant" framing in this system lives entirely in the
product-layer UI copy (`archie-operator/*.html`), which is explicit,
inspectable, and can be changed without retraining — it is never load-bearing
in the learned representation.

This is a standing constraint on every future training recipe in this
lane, not a one-time check: any future corpus source (teacher-distilled
rows, synthesized compounds, procedural generator additions) must be
audited the same way before being folded into `route_tokens()` input.
