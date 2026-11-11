---
id: a-delegate-learns-as-its-caller
kind: decision
tier: 1
status: active
topics: ["learning-memory", "agent-loop"]
paths: ["src/agents/multi/delegation/**", "src/agent-core/engine/setup.ts", "src/agent-core/engine/instinct-scope.ts", "src/agent-core/runner/**", "src/agents/memory-refresher.ts"]
purpose: "stop a delegated run from being given another person's private learning, or none of its caller's, and stop the fix from opening the caller's profile and memory to the delegate"
summary: "A delegated run keeps userId 'sub-agent' and retrieves user-scoped instincts for its caller's person, carried in a separate field; with no caller run it gets shared learning only."
decided_on: 2026-11-11
supersedes: null
superseded_by: null
conflicts_with: []
links: {"contracts": [], "commits": []}
---
## Context

DelegationManager starts every delegate as userId "sub-agent". The run's setup
asked the instinct retriever for `request.userId`, and the store hands a
user-scoped instinct only to its owner. A delegate therefore got project and
global learning only, while a root run on the same task also got the user's
own. Board #60, decided by the board's orchestrator.

`request.userId` is read in about a dozen places in one run: the identity key
(sessions, profiles), personalization, the interactive autonomy directive,
memory recall (setup, the in-run refresher, memory_search), the DM-policy
check, the transcript's memory owner, checkpoints. Instinct retrieval is three
of them: setup's retrieval, the error-recovery guidance choice (retrieval only,
no write reads that id), and the refresher's instinct half.

## Decision

- The request carries `instinctOwner: { userId? }` beside `userId`.
  `instinctUserIdOf` (src/agent-core/engine/instinct-scope.ts) is the one rule:
  the owner's id when an owner is given, else the run's own `userId`.
- The runner puts the resolved id on the `ParentRunScope` it lends its tools
  (`instinctUserId`). DelegationManager reads it from the caller's tool
  context, so a delegate's own delegation carries the same person.
- No calling run behind a delegation: `instinctOwner: {}`, shared learning
  only. Learning filed under "sub-agent" is no longer a candidate either.
- What a delegated run writes is unchanged: its `tool:result` events carry
  no user id (the root run's do not either); observations are keyed by the
  delegate's session id.

## Rejected alternatives

- **Start the delegate with the caller's real userId.** It would also give the
  delegate the caller's profile, personal memory, autonomy prefs and DM
  policy. Whether a sub-agent may read those is a separate access decision,
  the owner's (#53).
- **Fall back to `recallUserId` in the delegation.** A delegate's
  `recallUserId` is "sub-agent", so a delegate's delegate would have lost the
  person again.
- **Leave delegates on project and global learning on purpose.** That keeps
  the owner's own corrections out of exactly the sub-tasks they were made for.

## Consequences

- A new starter of a run whose `userId` is not a person must set
  `instinctOwner`, or it falls back to that id.
- Delegated orchestrators get no `reRetrievalConfig` today, so the refresher
  half is consistent but unused in delegates.
- Tests: `src/agents/multi/delegation/delegation-instinct-owner.test.ts`
  (real root run, real retriever and store) and
  `src/agents/memory-refresher-instinct-owner.test.ts`.
