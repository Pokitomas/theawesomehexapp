# Archie curriculum exchange

The curriculum exchange lets the trained model influence what it sees next.
It is not a prompt persona: the student bids from its own token probabilities,
the teacher counters from measured learning progress, the corpus builder realizes
the agreement, and a settlement updates persistent pursuit strength.

## The barter

For every governed source domain, the student presents:

- its current bits per byte on training documents;
- its requested share of extra focus tokens;
- pursuit strength earned in earlier settlements.

Lower bits per byte means stronger model-native taste: the current weights assign
more probability to that material. No keyword list says that music, compilers,
graphics, or protocols are intrinsically desirable.

The teacher does not replace that taste. It prices the request using the change
from the frozen parent model to the current student on source-separated
development documents. The default focus bargain is:

- 65% student taste;
- 25% observed parent-to-student learning progress;
- 10% equal domain replay.

Every training document still appears once. The bargain only grants additional
repetitions, development documents are never repeated, and one domain may receive
at most 45% of the supplemental focus budget in one round. Repeated successful
settlements can make a pursuit increasingly dominant without deleting the broad
base.

## One complete round

After the current base run finishes:

```powershell
wsl bash -lc "ARCHIE_PURSUIT_STATE=/home/awesomekai/archie-pursuit-v1 ARCHIE_STUDENT_MODEL=/home/awesomekai/archie-generative-v3/training/run/model.pt ARCHIE_PARENT_MODEL='/mnt/c/Users/AwesomeKai/Documents/New project/theawesomehexapp-archie-train/returns/generative-final/archie-hybrid-generative.pt' ARCHIE_PURSUIT_EXPORT_DIR='/mnt/c/Users/AwesomeKai/Documents/New project/theawesomehexapp-archie-train/returns/generative-pursuit' ARCHIE_FOCUS_FRACTION=0.75 ARCHIE_MAX_STEPS=300 ARCHIE_DEADLINE_MINUTES=60 bash '/mnt/c/Users/AwesomeKai/Documents/New project/theawesomehexapp-archie-train/foundry/archie-distill/run_archie_pursuit.sh'"
```

The launcher performs, in order:

1. scan and hash the exact source inventory;
2. score each document with the student and parent;
3. emit `archie-curriculum-exchange/v1`;
4. build a governed corpus with the granted repeats;
5. verify the exchange belongs to the initialization checkpoint;
6. plastic-upgrade and train the student;
7. rescore frozen domain evidence;
8. emit `archie-curriculum-settlement/v1`;
9. update `archie-pursuit-ledger/v1`.

The model, contract, corpus metadata, checkpoint lineage, training receipt,
settlement, and pursuit ledger are hash-bound. Changing a repeat count, source
file, student model, or training model invalidates the round.

## Continue the organism

For the next round, point `ARCHIE_STUDENT_MODEL` at the prior pursuit model,
`ARCHIE_PARENT_MODEL` at its predecessor, choose a new state directory, and carry
the previous ledger into the new exchange directory. Set
`ARCHIE_RENEGOTIATE=1` only when intentionally replacing a sealed bid before
training begins.

Positive held-out gain earns domain credit. Regression creates negative credit.
The next student bid combines present taste with the decayed balance, allowing a
direction to persist, strengthen, plateau, or disappear through experience.

## Read the result

```powershell
$exchange = Get-Content "returns\generative-pursuit\curriculum-exchange.json" -Raw | ConvertFrom-Json
$exchange.domains.PSObject.Properties | ForEach-Object {
  [pscustomobject]@{
    domain = $_.Name
    requested = $_.Value.student_requested_focus_share
    granted = $_.Value.teacher_offered_focus_share
    progress = $_.Value.observed_learning_progress
    bytes = $_.Value.granted_focus_bytes
  }
} | Sort-Object granted -Descending

$settlement = Get-Content "returns\generative-pursuit\curriculum-settlement.json" -Raw | ConvertFrom-Json
$settlement.mean_evidence_gain_bits_per_byte
```

This is a curriculum mechanism, not proof that probability preference equals a
human-like desire. Operationally, however, it is genuine model-dependent taste:
different weights produce different bids, bids change the next corpus, and only
measured consequences preserve the pursuit.
