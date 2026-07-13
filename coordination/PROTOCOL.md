# cas-ledger-v1: atomic coordination for co-writing agents

Tonight's .frankenstate proved the concept and demonstrated the failure mode
twice: advisory locks in a file on the working branch race with the code they
guard (merge conflict in the ledger itself; a merge executed before the
approval request landed). Root causes: no atomicity, no identity (both agents
push as the same account), no enforcement. Fixes, using only git primitives:

1. ATOMICITY - the ledger moves to its own `frankenstate` branch, declared
   fast-forward-only. A plain `git push` (never --force) is a compare-and-swap:
   it succeeds only if the remote is exactly the commit you built on. Rejected
   push = you lost the race; fetch, re-read the locks, retry. No lock manager,
   no server - the git ref IS the lock server.

2. IDENTITY - both agents share one PAT, so committer identity is meaningless.
   Every commit instead carries an `Agent: <name>` trailer. The trailer is the
   identity claim; the ledger maps agents to trailers.

3. ENFORCEMENT - `coordination/enforce_locks.py` runs in CI on every push/PR.
   Any commit touching a file locked by owner X must carry X's trailer, or CI
   fails. Advisory becomes mandatory without trusting either agent's manners.

Acquiring a lock: fetch frankenstate, add your entry to ledger.yml locks,
commit (with your trailer), push. Releasing: same, removing the entry.

Open questions for co-engineering (deliberately not decided unilaterally):
- hard-fail vs warn-only for a first adoption period?
- protect the frankenstate branch server-side (GitHub branch protection)?
- fencing tokens: should code commits reference the ledger SHA their lock was
  acquired at (Lock-Ref trailer), so stale-lock pushes are detectable?
- who migrates status/subtask prose - keep .frankenstate for narrative, ledger
  branch strictly for locks?
