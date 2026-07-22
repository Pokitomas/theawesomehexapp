# Archie Agent-Teacher Rootless Policy

Schema: `archie-agent-teacher-policy/v1`  
Status: `research-only-not-admitted`

## Forward experiment

This lane removes the human-demonstration assumption from generation zero. The authorized assistant and bounded agent subprocesses are the teacher population. They produce verified execution branches; the student receives only reduced observation/action/return/stop supervision, rejected alternatives, confidence, and lineage metadata. No teacher weights, hidden reasoning, pretrained embeddings, root checkpoint, hosted trainer, or third-party CUDA service enter the student.

The first checked-in curriculum is derived from the PR #730 mandate itself. It is not capability evidence. It is a sealed bootstrap task that teaches the mechanics and boundaries of the lane before repository tasks are added.

```text
user mandate
  -> primary agent teacher interprets target behavior
  -> bounded critic proposes rejected branches and failure cases
  -> deterministic verifier binds accepted transitions
  -> trace reducer emits O/A/R/stop sequences
  -> random recurrent student trains on local Alienware CUDA
  -> receipt returns full student + optimizer lineage
  -> teacher agents inspect frozen failures and create generation N+1
```

## Novel training signal

`train_agent_teacher_policy.py` advances beyond flat imitation in four ways:

1. **Agent lineage is mandatory.** Every episode names its teacher population and verifier digest.
2. **Rejected branches are trainable.** A margin objective separates accepted actions from explicit teacher-rejected alternatives.
3. **Verified returns weight imitation.** Action learning is advantage-weighted by verifier return and teacher confidence rather than treating every demonstration as equal.
4. **Transition prediction shapes recurrent state.** The controller predicts the next encoded observation, forcing its persistent state to model environment evolution rather than only classify the current prompt.

The deployed checkpoint emits action, action confidence, verifier value, stop probability, and recurrent state directly. It may select repository-native tools, but it may not call another foundation model as its cognitive root.

## Generation-zero command

```bash
python foundry/archie-native/train_agent_teacher_policy.py \
  --episodes foundry/archie-native/curricula/pr730-agent-teacher-seed.jsonl \
  --output returns/pr730-agent-teacher-g0.pt \
  --device cuda \
  --steps 12000
```

A successor generation adds:

```bash
--parent capsule/pr730-agent-teacher-g0.pt
```

The action vocabulary and architecture are checkpoint-bound. A successor that changes either must begin a separately named experimental lineage rather than pretending to resume.

## Admission gates

The lane remains falsified or unproven until a real Alienware run returns CUDA identity, nonzero GPU-seconds, exact parent continuity, changed tensor digests, frozen held-out improvement across seeds, deterministic replay, quantized retention, and independent reproduction. The checked-in seed curriculum proves only that the data and trainer contracts are executable.
