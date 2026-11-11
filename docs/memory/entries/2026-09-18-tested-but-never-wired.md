---
id: tested-but-never-wired
kind: gotcha
tier: 1
status: active
topics: ["agent-loop", "learning-memory"]
paths: ["src/core/bootstrap.ts", "src/agents/multi/agent-manager.ts", "src/agents/multi/delegation/delegation-manager.ts"]
purpose: "Stop a correct, tested fix from changing nothing because the production construction site never passes its dependency."
summary: "Unit tests that build their own subject cannot see an argument nobody passes; check the construction site"
decided_on: 2026-09-18
supersedes: null
superseded_by: null
conflicts_with: []
links: {"contracts": [], "commits": []}
---
## Context
Error-recovery learning had never run in production. `enableLearning` was called once at startup, on an engine nothing used. The engine every task calls was built per task, with no hooks, and the same construction site never passed the learning pipeline to the orchestrator. Three rounds of fixes inside that subsystem, each with failing tests and killed mutants, were correct, and none of them changed what a run did.

## Decision
When a fix lands in a subsystem, grep for whoever constructs it: `src/core/bootstrap.ts`, `src/agents/multi/agent-manager.ts`, `src/agents/multi/delegation/delegation-manager.ts`. Check that the dependency the fix relies on is actually passed there. Where booting the app is the only real driver, a textual tripwire over the construction block is better than nothing; say in the test why it is textual.

## Rejected alternatives
- **More unit tests in the subsystem.** They construct the subject themselves, which is exactly the blind spot.

## Consequences
This is one reason for an end-to-end run of the loop with a scripted provider: it exercises the real construction sites.

It recurred on 2026-11-11. The learning bus and the instinct retriever reached the root and the per-agent orchestrators from a list kept beside `SharedOrchestratorDeps`, so a delegated run emitted no tool result to learning and retrieved no instinct. A run dependency now goes into that type, which all three sites spread. A dependency passed beside it is the pattern to look for.
