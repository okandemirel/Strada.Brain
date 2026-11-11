---
id: tool-list-is-byte-stable
kind: decision
tier: 1
status: active
topics: ["agent-loop", "providers"]
paths: ["src/agent-core/engine/phase-write-access.ts", "src/agent-core/engine/prepare-iteration.ts", "src/agent-core/runner/v2-agent-runner.ts", "src/agents/orchestrator.ts"]
purpose: "Stop the worker's tool list from following the phase again, where every phase change makes the provider's prefix cache miss the whole history, the reflection calls' included."
summary: "The worker's tool list is the run's list in every phase and role; a write called while planning, replanning or reflecting is refused where it runs, and the turn context says so"
decided_on: 2026-11-11
supersedes: null
superseded_by: null
conflicts_with: []
links: {"contracts": [], "commits": []}
---
## Context
After `system-prompt-is-byte-stable` the system prompt held across a run, but the tool list did not: `buildWorkerToolDefinitions` took the write tools out while the agent was planning, replanning or reflecting (and for any role but executor). The tool schemas come before the history in a request, so the list changed on 35–46% of consecutive calls in the replayed daemon logs (`compaction-must-respect-the-prefix-cache`), and each change missed the whole history. Under the replay's stable-head bound the same logs cost a fifth to two fifths of the "head as logged" projection.

## Decision
- **One list.** `buildWorkerToolDefinitions` is given the task only (`PrepareIterationDeps`), so nothing it is handed names the phase or the role. It still drops control-plane tools, tools whose metadata says unavailable, and the dotnet tools without a solution.
- **The rule is the gate.** `src/agent-core/engine/phase-write-access.ts` owns the phases that write (`phaseAllowsWrites`) and the refusal a write gets elsewhere (`phaseWriteRefusal`). The orchestrator's tool-call gate reads both. `create_skill` still passes it.
- **The planning turn's calls run in the planning phase.** The runner moved the state to EXECUTING (the plan transition) before it ran the planning turn's tool calls, so the gate saw EXECUTING and a write named in that turn ran. It now hands the tool turn the phase the call was made in. While the list hid writes in that turn the hole was rarely reached; with the list stable it would have been reached routinely. Scripted models had come to rely on it: `file-build-flow.test.ts` and the release smoke's mock (`scripts/release/mock-kimi-hook.mjs`, its autonomy, delegation and PAOR scenarios) wrote or delegated in the planning or replanning turn, and now plan first.
- **The turn context says it.** `buildPhaseWriteNotice` adds "## Writes in this phase" to the turn context of a planning, replanning or reflecting call. A reflecting turn's tool calls are not run at all (the runner reads its decision), and the notice says that too.

## Rejected alternatives
- **Letting a planning turn's writes run once the plan is recorded** (what the runner did by accident). It saves a turn when a model plans and acts at once, but the plan-review gate is skipped for a planning turn that carries tool calls, so a write would run before the review the user asked for; and the approved task said a planning-phase write is refused. If the live count below shows the extra turn is common, this is the alternative to weigh.
- **Keeping the per-phase list and caching around it** (two cached heads, one per phase). A provider caches a prefix, not a set of them: the phase change still misses everything after the tools.
- **Hiding writes by description** (a "not in this phase" line in each write tool's schema). The schemas would change per phase again.
- **Running the planning turn's calls before the plan transition.** The transition can end the run (plan review, goal handoff); running the calls first would execute tools in a turn that then terminates.
- **Running a reflecting turn's tool calls so the gate can refuse a write with a result.** Reads in that turn were never run either; making reflection a tool turn is a behaviour change of its own. The notice says the calls are not run.

## Consequences
- **Tests.** The golden run pins the plan, act and report calls of each node to one tool list, byte for byte, and the planning turn to offer file_write and carry the notice. `v2-agent-runner.integration.test.ts` B3 runs planning, executing, reflecting, replanning and executing through the real port and pins one list across them and that the reflecting turn's write did not run; B4 pins that a planning turn's write is refused and the read beside it runs. `prepare-iteration.test.ts` pins the shell is called with the task alone, and the notice.
- **Still changing the list mid-run:** the read-only streak intervention (one turn with progress tools only), a dotnet solution appearing, and tools registered mid-run. Each is rare next to a phase change.
- **A refused write still counts as a consequential step** for the reflection cadence (`recordStepResultsAndCheckReflection` counts by tool name). A planning turn that names a write now shifts the cadence by one.
- **A model that writes in its planning turn pays a turn.** The gate logs "Phase write refused" (chat, tool, phase) each time, so the daemon log counts how often it happens.
- **Not measured:** a live run. `cache-hit-report.mjs` on a run after this change, and the replay's head churn on its log, are the measurement.
