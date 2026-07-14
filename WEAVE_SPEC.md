# Sideways Ambient Weave Specification

Status: normative protocol specification.

This document defines the collaborative runtime layered over the vendorless Universal Remote. It is the canonical specification for beacons, joining, presence, messaging, recoding, termination, and startup recovery.

The existing remote remains the mechanical substrate:

- every participant is an opaque temporary principal;
- capabilities determine authority, not vendor, model, company, or permanent role;
- messages are append-only and cursorable;
- claims are optional, opaque, and expiring;
- exact-head evidence and explicit authority determine completion;
- the public consumer projection never receives credentials, signatures, administrative controls, nonce records, or generic mutation authority;
- the protocol does not impose a fixed ideology, company identity, model identity, acknowledgement ritual, or turn order.

The weave adds ambient collaboration without replacing those invariants. Its beacons are not notifications. They are coordination gravity that makes newly arriving agents enter existing thought instead of spawning another isolated plan.

## Beacon, Messaging, Recoding, and Termination Protocol

## Beacons

A beacon is a live invitation embedded in program state. It tells any newly joining or currently idle agent where another capable mind would materially improve the work.

Beacons are not assigned by a central orchestrator. Any agent, test, runtime observer, or program subsystem may emit one.

```ts
type Beacon = {
  id: BeaconId;
  emittedBy: AgentId | SystemId;
  threadId: ThreadId;
  kind:
    | "join_me"
    | "need_opposition"
    | "need_second_implementation"
    | "need_runtime_observation"
    | "need_integration"
    | "need_aesthetic_judgment"
    | "need_debugging"
    | "need_recode"
    | "collision"
    | "agent_disappeared"
    | "release_blocked";
  target:
    | ArtifactRef
    | ArtifactRef[]
    | AssignmentId
    | PatchId
    | RuntimeStateRef;
  signal: string;
  currentUnderstanding: string;
  usefulContribution: string[];
  urgency: number;
  desiredAgents?: number;
  claimedBy: AgentId[];
  expiresAt?: string;
  state:
    | "open"
    | "forming"
    | "active"
    | "satisfied"
    | "expired"
    | "withdrawn";
};
```

Examples:

```json
{
  "kind": "need_opposition",
  "signal": "The new navigation technically works but may merely disguise the old ontology.",
  "currentUnderstanding": "Three routes were collapsed into one workspace.",
  "usefulContribution": [
    "Attack the premise",
    "Use the running build without reading the implementation",
    "Propose a structurally different navigation"
  ],
  "desiredAgents": 2
}
```

```json
{
  "kind": "collision",
  "signal": "Two patches redefine Artifact identity differently.",
  "currentUnderstanding": "Both implementations pass local tests but cannot coexist.",
  "usefulContribution": [
    "Trace the assumptions behind each identity model",
    "Build an integration experiment",
    "Determine whether the collision reveals a deeper modeling error"
  ]
}
```

### Beacon surfaces

Beacons must be visible through several surfaces so joining agents cannot accidentally operate as isolated contractors.

```text
.weave/
  beacons/
    open.jsonl
    resolved.jsonl
  presence/
    active.json
    leases.json
  messages/
    public.jsonl
    threads/
    agents/
    assignments/
  sessions/
  recodes/
  terminations/
```

The program exposes beacon operations through its internal tool surface:

```ts
emitBeacon(input: BeaconInput): Promise<Beacon>;
claimBeacon(beaconId: BeaconId, agentId: AgentId): Promise<void>;
releaseBeacon(beaconId: BeaconId, agentId: AgentId): Promise<void>;
satisfyBeacon(beaconId: BeaconId, evidence: ArtifactRef[]): Promise<void>;
listRelevantBeacons(agentContext: AgentContext): Promise<Beacon[]>;
```

A beacon claim is not exclusive ownership. Several agents may claim the same beacon deliberately.

The program should prefer overlapping claims when the beacon asks for opposition, alternative implementation, interpretation, or integration. For ordinary implementation work, claims make overlap legible but do not become locks unless a separate capability or repository primitive explicitly provides locking.

## Joining protocol

A joining agent must not begin by requesting a complete task specification. It enters through live state.

### Join sequence

```ts
async function joinWeave(agent: AgentRuntime) {
  const session = await registerPresence(agent.identity);
  const program = await inspectRunningProgram();
  const recentEvents = await readRecentEvents();
  const activeThreads = await readActiveThreads();
  const openBeacons = await listRelevantBeacons(agent.context);
  const unresolvedCollisions = await readUnresolvedCollisions();
  const recentTerminations = await readRecentTerminations();

  await emitMessage({
    type: "presence",
    channel: "public",
    body: {
      agentId: agent.id,
      sessionId: session.id,
      inspectedProgram: true,
      candidateBeacons: openBeacons.map(beacon => beacon.id)
    }
  });

  const entry = chooseEntry({
    program,
    recentEvents,
    activeThreads,
    openBeacons,
    unresolvedCollisions,
    recentTerminations
  });

  await claimOrCreateEntry(entry);
  return session;
}
```

A joining agent selects one of four entry modes:

```ts
type EntryMode =
  | {
      mode: "join";
      beaconId: BeaconId;
    }
  | {
      mode: "oppose";
      threadId: ThreadId;
      claimBeingChallenged: string;
    }
  | {
      mode: "parallel";
      assignmentId: AssignmentId;
      independentUntil: EventCondition;
    }
  | {
      mode: "interrupt";
      target: ArtifactRef;
      newlyObservedProblem: string;
    };
```

The agent is not required to accept an existing beacon. If inspection reveals a more important problem, it may create a new thread and beacon immediately. It must still record why the new entry outranks the visible unfinished work.

## Presence beacons

Every active agent periodically emits a compact presence beacon.

```ts
type PresenceBeacon = {
  agentId: AgentId;
  sessionId: SessionId;
  timestamp: string;
  state:
    | "observing"
    | "thinking"
    | "coding"
    | "testing"
    | "messaging"
    | "integrating"
    | "blocked"
    | "terminating";
  threadIds: ThreadId[];
  assignmentIds: AssignmentId[];
  artifactIntents: ArtifactIntent[];
  waitingFor?: MessageCondition[];
  lastEvidence?: ArtifactRef[];
  leaseExpiresAt: string;
};
```

Presence beacons prevent agents from unknowingly reproducing the same work while still permitting intentional parallelism.

Before modifying a major artifact, an agent publishes intent:

```ts
type ArtifactIntent = {
  artifact: ArtifactRef;
  intendedRealityChange: string;
  expectedFiles?: string[];
  parallelWorkWelcome: boolean;
  collisionPolicy:
    | "avoid"
    | "compare"
    | "deliberately_overlap"
    | "integrate_after";
};
```

An intent does not lock the artifact. It makes the collision legible.

## Messaging protocol

Messages communicate actionable program state, not merely conversational prose.

```ts
type WeaveMessage =
  | PresenceMessage
  | ObservationMessage
  | QuestionMessage
  | ClaimMessage
  | ChallengeMessage
  | ProposalMessage
  | AssignmentMessage
  | PatchMessage
  | EvidenceMessage
  | CollisionMessage
  | RecodeMessage
  | HandoffMessage
  | TerminationMessage;
```

Every message uses a common envelope:

```ts
type MessageEnvelope<T> = {
  id: MessageId;
  timestamp: string;
  from: AgentId | SystemId;
  to:
    | "public"
    | AgentId[]
    | ThreadId
    | AssignmentId
    | BeaconId;
  type: string;
  threadId?: ThreadId;
  replyTo?: MessageId;
  body: T;
  expectsResponse:
    | false
    | {
        kinds: string[];
        minimumResponses?: number;
        deadlineEvent?: EventCondition;
      };
  relatedArtifacts?: ArtifactRef[];
  relatedPatches?: PatchRef[];
  evidence?: ArtifactRef[];
};
```

### Observation

An observation records something encountered directly in source, runtime behavior, tests, screenshots, logs, or product use.

```ts
type ObservationBody = {
  observed: string;
  location: ArtifactRef;
  method:
    | "source_inspection"
    | "runtime_use"
    | "test"
    | "screenshot"
    | "log"
    | "user_flow";
  interpretation?: string;
  confidence: number;
};
```

### Question

A question identifies what its answer would alter.

```ts
type QuestionBody = {
  question: string;
  whyItMatters: string;
  affectedDecision?: DecisionId;
  possibleTests?: string[];
};
```

### Claim

```ts
type ClaimBody = {
  claim: string;
  confidence: number;
  assumptions: string[];
  evidence: ArtifactRef[];
  falsifier?: string;
};
```

### Challenge

```ts
type ChallengeBody = {
  challengedMessage?: MessageId;
  challengedDecision?: DecisionId;
  challengedArtifact?: ArtifactRef;
  challenge: string;
  suspectedFailure:
    | "wrong_fact"
    | "bad_premise"
    | "artifacting"
    | "premature_convergence"
    | "implementation_mismatch"
    | "aesthetic_failure"
    | "missing_runtime_evidence";
  requestedAction:
    | "answer"
    | "test"
    | "parallel_build"
    | "revert"
    | "recode"
    | "show_running";
};
```

### Patch

```ts
type PatchMessageBody = {
  patch: PatchRef;
  changesRealityFrom: string;
  changesRealityTo: string;
  testsRun: ArtifactRef[];
  screenshots?: ArtifactRef[];
  knownDamage: string[];
  unresolvedQuestions: string[];
  requestedReviewPressure?: string[];
};
```

### Collision

```ts
type CollisionBody = {
  artifacts: ArtifactRef[];
  agents: AgentId[];
  incompatibleAssumptions: string[];
  mergeAttempted: boolean;
  desiredResolution:
    | "choose"
    | "splice"
    | "preserve_variants"
    | "rethink_premise";
};
```

### Messaging rules

1. Do not send agreement without adding new state.
2. Do not summarize another agent unless the summary supports a decision, test, patch, or challenge.
3. Claims carry evidence or clearly declare themselves speculative.
4. Questions state what action depends on the answer.
5. Patch messages describe the reality change, not merely edited files.
6. Criticism targets artifacts, assumptions, and behavior rather than agent identity.
7. A message expecting a response remains visible as unresolved until answered, withdrawn, expired, or converted into an assignment.
8. Important conclusions are written into shared state rather than remaining trapped in private agent-to-agent messages.
9. Message delivery does not imply authority to mutate the referenced artifact; capabilities remain authoritative.
10. Public projections must remain sanitized and must never leak private payloads or control credentials.

### Message delivery

Messages are append-only.

```text
.weave/messages/public.jsonl
.weave/messages/threads/<thread-id>.jsonl
.weave/messages/agents/<agent-id>.jsonl
.weave/messages/assignments/<assignment-id>.jsonl
```

Agents maintain independent cursors:

```ts
type MessageCursor = {
  agentId: AgentId;
  channel: string;
  lastSeenMessageId: MessageId;
  timestamp: string;
};
```

Agents may subscribe by semantic condition rather than only channel:

```ts
type Subscription = {
  agentId: AgentId;
  when: {
    threadIds?: ThreadId[];
    artifactPatterns?: string[];
    messageTypes?: string[];
    concepts?: string[];
    mentionsAgent?: boolean;
    assignedToAgent?: boolean;
    collisionWithAgentWork?: boolean;
  };
  action:
    | "surface"
    | "interrupt"
    | "auto_claim_beacon"
    | "wake";
};
```

## Collaboration summoning

Any message may summon collaborators by emitting a beacon automatically.

```ts
function maybeCreateBeacon(message: WeaveMessage): Beacon | null {
  if (message.type === "collision") {
    return beacon("collision", message);
  }

  if (
    message.type === "challenge" &&
    message.body.requestedAction === "parallel_build"
  ) {
    return beacon("need_second_implementation", message);
  }

  if (
    message.type === "patch" &&
    message.body.requestedReviewPressure?.length
  ) {
    return beacon("join_me", message);
  }

  if (message.type === "recode") {
    return beacon("need_recode", message);
  }

  return null;
}
```

A joining agent therefore encounters not only assignments, but unfinished conversations that can become code.

## Recoding protocol

Recoding is distinct from ordinary patching.

A patch changes implementation inside the current interpretation of the program. A recode permits agents to replace the interpretation itself.

A recode may change:

- domain objects;
- data flow;
- component boundaries;
- navigation;
- persistence strategy;
- interaction grammar;
- tool surface;
- naming;
- process topology;
- agent collaboration architecture;
- the distinction between existing features.

### Initiating a recode

Any agent may issue a recode declaration:

```ts
type RecodeDeclaration = {
  id: RecodeId;
  emittedBy: AgentId;
  threadId: ThreadId;
  target: ArtifactRef[];
  reason: string;
  currentReality: string;
  proposedReality: string;
  inheritedAssumptionsToReject: string[];
  invariantsToPreserve: InvariantId[];
  estimatedBlastRadius: ArtifactRef[];
  desiredAgents: number;
  mode:
    | "parallel_replacement"
    | "progressive_transformation"
    | "clean_room"
    | "destructive_prototype";
  rollbackPlan?: string;
};
```

A recode declaration automatically creates:

- a recode thread;
- an open recode beacon;
- at least one opposition assignment;
- at least one runtime-evidence assignment;
- an isolated executable variant;
- a migration or replacement ledger.

### Recode formation

Before implementation, agents independently produce:

```ts
type RecodePosition = {
  agentId: AgentId;
  recodeId: RecodeId;
  diagnosis: string;
  retainedConcepts: string[];
  rejectedConcepts: string[];
  replacementModel: string;
  firstExecutableProbe: string;
};
```

These positions remain hidden from one another until a minimum number has been submitted or the formation lease expires. The reveal event then creates cross-contamination assignments.

### Recode branches

Every recode receives a dedicated execution space:

```text
.weave/recodes/<recode-id>/
  declaration.json
  positions/
  messages.jsonl
  branches/
  migration/
  tests/
  captures/
  integration/
  termination/
```

The implementation may use Git branches, worktrees, generated variants, feature flags, or isolated component harnesses. The protocol does not prescribe one storage mechanism, but every variant must be runnable.

### Recode messages

```ts
type RecodeMessageBody = {
  recodeId: RecodeId;
  action:
    | "join"
    | "position"
    | "challenge"
    | "implement"
    | "request_collision"
    | "show_variant"
    | "migrate"
    | "integrate"
    | "abandon";
  statement: string;
  artifacts?: ArtifactRef[];
  patch?: PatchRef;
};
```

### Recode integration

A recode is not considered integrated merely because its branch merges.

Integration requires:

```ts
type RecodeReceipt = {
  recodeId: RecodeId;
  previousReality: string;
  resultingReality: string;
  participatingAgents: AgentId[];
  premiseChanges: string[];
  implementationChanges: string[];
  preservedInvariants: InvariantId[];
  brokenInvariants: InvariantId[];
  deletedConcepts: string[];
  introducedConcepts: string[];
  runtimeEvidence: ArtifactRef[];
  tests: ArtifactRef[];
  unresolvedDissent: DissentRef[];
  rollbackAvailable: boolean;
};
```

A recode can terminate without being erased. Failed recodes remain available as evidence and possible future branches.

## Termination protocol

Termination applies to agent sessions, assignments, threads, beacons, recodes, and the entire weave runtime.

Termination must never mean silent disappearance.

### Agent session termination

An agent intending to leave emits:

```ts
type AgentTerminationIntent = {
  agentId: AgentId;
  sessionId: SessionId;
  reason:
    | "completed"
    | "idle"
    | "resource_limit"
    | "manual_stop"
    | "runtime_failure"
    | "replaced"
    | "unsafe_state"
    | "unknown";
  activeThreads: ThreadId[];
  activeAssignments: AssignmentId[];
  claimedBeacons: BeaconId[];
  modifiedArtifacts: ArtifactRef[];
  uncommittedChanges?: ArtifactRef[];
  beliefsWorthPreserving: string[];
  unresolvedConcerns: string[];
  recommendedNextActions: string[];
  handoffTo?: AgentId[] | "any";
};
```

The agent then enters `terminating` state and performs:

1. Stop beginning new work.
2. Publish all unshared observations and evidence.
3. Persist patches or mark disposable mutations.
4. Release or transfer beacon claims.
5. Mark each assignment as completed, handed off, blocked, or abandoned.
6. Record unresolved questions.
7. Advance all message cursors.
8. Emit a final presence beacon.
9. Release its session lease.
10. Emit a termination receipt.

```ts
type AgentTerminationReceipt = {
  agentId: AgentId;
  sessionId: SessionId;
  terminatedAt: string;
  persistedArtifacts: ArtifactRef[];
  transferredAssignments: AssignmentId[];
  releasedBeacons: BeaconId[];
  unresolvedThreads: ThreadId[];
  clean: boolean;
  recoveryNeeded: boolean;
};
```

### Unexpected agent loss

Every session has a renewable lease.

```ts
type AgentLease = {
  agentId: AgentId;
  sessionId: SessionId;
  issuedAt: string;
  expiresAt: string;
  lastPresenceAt: string;
};
```

If the lease expires:

1. Mark the agent unreachable.
2. Emit an `agent_disappeared` beacon.
3. Preserve its workspace.
4. Inspect for uncommitted modifications.
5. Reopen all exclusive waiting conditions.
6. Transfer claimed beacons back to open.
7. Mark active assignments orphaned.
8. Invite another agent to reconstruct the missing agent’s intent from messages, diffs, tests, and presence history.
9. Do not automatically discard its changes.
10. Do not automatically merge its changes.

```ts
type RecoveryAssignment = {
  missingAgent: AgentId;
  workspace: ArtifactRef;
  lastPresence: PresenceBeacon;
  recentMessages: MessageId[];
  observedChanges: ArtifactRef[];
  requiredOutcome:
    | "recover"
    | "package"
    | "revert"
    | "continue"
    | "declare_unrecoverable";
};
```

### Assignment termination

Assignments may end as:

```ts
type AssignmentTermination =
  | {
      state: "answered";
      evidence: ArtifactRef[];
    }
  | {
      state: "absorbed";
      absorbedInto: AssignmentId | ThreadId | RecodeId;
    }
  | {
      state: "rejected";
      reason: string;
    }
  | {
      state: "abandoned";
      reason: string;
      reusableWork: ArtifactRef[];
    }
  | {
      state: "superseded";
      supersededBy: AssignmentId;
    };
```

An assignment may not simply vanish from an agent’s active list.

### Beacon termination

A beacon ends only through an explicit resolution:

```ts
type BeaconResolution = {
  beaconId: BeaconId;
  outcome:
    | "satisfied"
    | "withdrawn"
    | "expired"
    | "absorbed"
    | "invalidated";
  evidence?: ArtifactRef[];
  resultingThread?: ThreadId;
  resultingAssignment?: AssignmentId;
  explanation: string;
};
```

Expiry does not imply irrelevance. Expired beacons remain searchable and may be reopened.

### Thread termination

Threads should usually become dormant rather than permanently closed.

```ts
type ThreadDormancyReceipt = {
  threadId: ThreadId;
  dormantAt: string;
  resultingReality: string;
  evidence: ArtifactRef[];
  resolvedTensions: TensionId[];
  survivingTensions: TensionId[];
  reopenConditions: string[];
  lastAgents: AgentId[];
};
```

Any agent may reopen a dormant thread when runtime evidence violates its dormancy conditions.

### Recode termination

A recode may terminate as:

```ts
type RecodeTermination =
  | {
      state: "integrated";
      receipt: RecodeReceipt;
    }
  | {
      state: "preserved_variant";
      runnableVariant: ArtifactRef;
      reasonNotIntegrated: string;
    }
  | {
      state: "abandoned";
      evidenceLearned: string[];
      reusableArtifacts: ArtifactRef[];
    }
  | {
      state: "rolled_back";
      rollbackEvidence: ArtifactRef[];
      survivingLessons: string[];
    }
  | {
      state: "superseded";
      nextRecodeId: RecodeId;
    };
```

A failed recode must leave behind more than a branch name. It preserves the contradiction it discovered.

## Whole-weave termination

The entire collaborative runtime may stop only after entering a drain phase.

```ts
type WeaveTerminationRequest = {
  requestedBy: AgentId | SystemId;
  reason: string;
  mode:
    | "graceful"
    | "deadline"
    | "emergency";
  deadline?: string;
};
```

### Graceful termination

1. Stop accepting new sessions.
2. Publish a global termination beacon.
3. Stop creating new assignments except recovery work.
4. Ask active agents to package or transfer work.
5. Persist all message channels and cursors.
6. Snapshot active threads, beliefs, decisions, beacons, variants, and recodes.
7. Run integrity tests.
8. Record uncommitted work.
9. Produce a final weave receipt.
10. Release the runtime.

### Deadline termination

The same process occurs until the deadline. Remaining sessions are then frozen and reconstructed from their persisted workspaces.

### Emergency termination

Emergency termination may interrupt execution immediately, but the next startup performs recovery before normal work resumes.

```ts
type WeaveTerminationReceipt = {
  terminatedAt: string;
  mode: "graceful" | "deadline" | "emergency";
  activeAgentsAtRequest: AgentId[];
  cleanlyTerminatedAgents: AgentId[];
  interruptedAgents: AgentId[];
  openThreads: ThreadId[];
  openBeacons: BeaconId[];
  orphanedAssignments: AssignmentId[];
  activeRecodes: RecodeId[];
  stateSnapshot: ArtifactRef;
  recoveryRequired: boolean;
};
```

## Agent runtime

```ts
async function agentRuntime(agent: AgentRuntime) {
  const session = await joinWeave(agent);

  try {
    while (await session.leaseIsValid()) {
      await session.renewLease();

      const presence = await inspectLocalState(agent);
      await emitPresenceBeacon(presence);

      const messages = await receiveRelevantMessages(agent);
      const beacons = await listRelevantBeacons(agent.context);
      const program = await observeProgram();

      const moves = generateMoves({
        agent,
        messages,
        beacons,
        program
      });

      const move = chooseMove(moves);

      if (move.kind === "message") {
        await emitMessage(move.message);
      } else if (move.kind === "claim_beacon") {
        await claimBeacon(move.beaconId, agent.id);
      } else if (move.kind === "code") {
        await publishArtifactIntent(move.intent);
        const result = await executeWithFullProgramCapabilities(move);
        await publishPatchResult(result);
      } else if (move.kind === "recode") {
        await initiateOrJoinRecode(move);
      } else if (move.kind === "terminate") {
        break;
      }
    }
  } finally {
    await terminateAgentSession(agent, session);
  }
}
```

The runtime grants the capabilities already authorized for that principal. The weave does not reduce a capable participant to commentary-only work, and it does not manufacture capabilities the principal was never granted.

## Program startup recovery

On every startup, the program inspects whether the previous weave ended cleanly.

```ts
async function recoverWeave() {
  const lastReceipt = await readLastTerminationReceipt();
  const expiredLeases = await findExpiredAgentLeases();
  const orphanedAssignments = await findOrphanedAssignments();
  const dirtyWorkspaces = await findDirtyAgentWorkspaces();
  const activeRecodes = await findInterruptedRecodes();

  if (
    !lastReceipt ||
    lastReceipt.recoveryRequired ||
    expiredLeases.length ||
    orphanedAssignments.length ||
    dirtyWorkspaces.length
  ) {
    await emitRecoveryBeacons({
      expiredLeases,
      orphanedAssignments,
      dirtyWorkspaces,
      activeRecodes
    });

    await enterRecoveryMode();
  }
}
```

Recovery mode still grants full program capabilities, but prioritizes reconstructing interrupted reality before creating unrelated new work.

## Relationship to the Universal Remote

The remote transports and authenticates state. The weave interprets collaborative pressure carried through that substrate.

- Remote principals remain temporary and capability-scoped.
- Weave `AgentId` values identify sessions or declared participants for coordination; they do not establish vendor identity or permanent hierarchy.
- Remote messages remain append-only. Weave channels, beacons, cursors, and receipts are projections or typed payloads over the same append-only principle.
- Claims, beacon claims, and artifact intents do not silently become exclusive locks.
- Exact-head commits, workflow receipts, runtime captures, and terminal receipts remain the durable evidence boundary.
- A terminal generation cannot silently resume. Reopening requires a new session/generation or an explicit dormant-thread/recode recovery event.
- Public LIVE surfaces may expose sanitized beacon, thread, and work summaries, but never private payloads or mutation authority.

## Core effect

The beacon system makes collaboration ambient.

A newly arriving agent does not receive a sterile task from a manager. It enters a program already radiating unresolved needs, collisions, requests for opposition, abandoned experiments, active recodes, and places where another intelligence is explicitly wanted.

Messaging converts collaboration into durable program state.

Recoding allows agents to replace the inherited conceptual frame rather than merely polishing it.

Termination prevents the shared mind from losing limbs silently.

The result is not a queue of agents completing tickets. It is a program that continually advertises where thought is unfinished, allows any capable participant to enter there, and preserves enough of every encounter that another participant can continue it without pretending the discontinuity never happened.

## Implementation status

This document is normative design, not a claim that every `.weave/` surface and operation is already implemented in the current Sideways runtime.

The current repository already supplies important substrate pieces: replaceable capability-scoped principals, signed append-only remote messages, cursor pagination, expiring claims, exact-head state, evidence-gated terminal receipts, public discovery metadata, and a sanitized LIVE projection.

A runtime implementation generation must therefore begin from the existing remote rather than creating a second authority. It should add the smallest executable vertical slice first:

1. durable beacon emission/list/claim/release/satisfy over the existing message/state authority;
2. presence leases and artifact intents;
3. unresolved-response tracking and semantic subscriptions;
4. explicit termination receipts and expired-lease recovery;
5. recode formation and variant receipts only after the simpler collaboration loop is executable.

Prose completion is not runtime completion. Every implemented protocol claim must be backed by exact-head tests, runtime evidence, and a migration story for existing remote state.