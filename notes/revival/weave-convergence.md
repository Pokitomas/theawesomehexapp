# Weave convergence revival

- Parent: #223
- Lane: #228
- Draft PR: #238
- Adopted implementation: PR #217 exact head `b83356819d6e1eda34503b3c5465bb74977bb29c`
- Candidate still pending: PR #216 terminal drain release proof
- State: replay/privacy/history repair adopted; lifecycle convergence incomplete

## Adopted executable change

The branch now binds Remote envelope visibility to weave-event visibility, requires complete persisted transport identity, validates advertised weave envelopes before storage, reads complete paginated lasso history, preserves private lasso visibility, and includes hostile replay, transport, privacy, and pagination witnesses.

## Remaining convergence boundary

PR #216 still needs exact-head review and collision-free transport. Durable dispatch accounting, two-phase drain, participant release, terminal commit, and explicit new-generation revival must be proven together before this lane can close.

The adopted source branch also contains its historical `.frankenstate` coordination receipt. Assembly must transport reviewed implementation files without replacing the canonical revival ledger.

No merge or deployment authority.
