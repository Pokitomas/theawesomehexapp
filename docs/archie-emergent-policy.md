# Archie emergent policy training

`train_emergent_policy.py` is the accelerated local successor to the original
agent-teacher policy calibration lane. It remains a compact controller trained
from random initialization, not a language model or a general-intelligence claim.

## Why this lane exists

The original policy runs a GRU across every padded byte of every observation.
That is slow on CPU and makes short calibration runs spend most of their compute
on sequence traversal. It also weights action imitation with an exponentiated
value advantage, which can make the action objective harder to interpret.

The accelerated lane uses:

- three parallel byte-convolution scales for local language features;
- a causal two-layer GRU only across episode steps;
- action targets selected from the best verified chosen or counterfactual branch;
- a learned value for every measured candidate action;
- value, stopping, rejected-action margin, and transition auxiliary losses;
- warmup plus cosine decay, gradient clipping, and best-checkpoint selection;
- whole-repository, mechanism, task-family, or episode-group holdouts;
- a separate hand-written paraphrase probe in every receipt.

For mixed-intent work, `augment_emergent_curriculum.py` adds deterministic,
verifier-digested semantic variants while preserving the original episodes and
recording both corpus hashes in a manifest. Its mutations are language/protocol
stress cases, not fabricated repository outcomes.

`repo_ecology.py` is the causal experience source. It evaluates every bounded
candidate patch in an isolated snapshot, including the action Archie did not
choose, across adversarial environment mutations. It emits verified
counterfactual episodes with branch receipts and optional multi-objective
components. See `docs/ARCHIE-PLASTIC-ORGANISM.md`.

## Local CUDA run

```bash
python foundry/archie-native/train_emergent_policy.py \
  --episodes returns/pr730-local/curriculum.jsonl \
  --output returns/emergent-final/archie-emergent-policy.pt \
  --steps 120 \
  --batch 64 \
  --eval-every 10 \
  --holdout-axis repository_id \
  --device cuda \
  --seed 731
```

The output checkpoint is accompanied by
`archie-emergent-policy.pt.receipt.json`. The receipt records the corpus digest,
model size, seed, optimization curve, hardware, held-out metrics, paraphrase
probe, and claim boundary.

## Local inference

```bash
python foundry/archie-native/infer_emergent_policy.py \
  --model returns/emergent-final/archie-emergent-policy.pt \
  --text "Training finished; inspect its metrics and hashes before claiming success."
```

The command returns the selected action, confidence, two alternatives, estimated
value, stopping probability, device, and exact checkpoint digest as JSON.

## Evidence boundary

Random episode holdout is no longer the preferred claim. Grouped holdouts reserve
entire repositories, mechanisms, or task families, and ecology traces measure
actual candidate branches rather than treating a teacher action as truth. The
paraphrase probe remains a warning against template memorization.

The current controller still learns a scalar weighted return; objective vectors
remain visible in source episodes and receipts but do not yet have separate
prediction heads. None of these metrics proves broad planning, autonomous purpose,
repository competence outside the held groups, or general intelligence.
