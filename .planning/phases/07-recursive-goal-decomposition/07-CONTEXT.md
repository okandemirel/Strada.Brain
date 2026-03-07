# Phase 7: Recursive Goal Decomposition - Context

**Gathered:** 2026-03-07
**Status:** Ready for planning

<domain>
## Phase Boundary

Enable the orchestrator to break complex tasks into sub-goals mid-execution with DAG dependencies, cycle detection, and depth limits. Sub-goals form a directed acyclic graph with explicit dependency edges. This phase delivers the DAG structure, types, storage, decomposer, and tree visualization. Phase 8 adds progress tracking and topological execution. This phase does NOT include goal execution ordering (Phase 8) or tool chain synthesis (Phase 9).

</domain>

<decisions>
## Implementation Decisions

### Decomposition Trigger
- Both proactive and reactive triggers: proactive complexity check during PLANNING phase, plus reactive decomposition during REFLECTING phase when stuck
- Heuristic pre-check first (like existing shouldDecompose), then LLM decides the actual breakdown — saves LLM calls for clearly simple tasks
- Full tree upfront during proactive decomposition (not lazy per-level)
- Reactive scope: agent decides whether to decompose just the failing step or restructure the remaining plan based on context
- Depth limit configurable via GOAL_MAX_DEPTH config option (default 3)
- Agent can collapse/skip unnecessary decomposition for sub-goals that turn out simpler than expected

### LLM Decomposition Strategy
- Hybrid LLM calls: single call for depth 1-2, recursive calls for depth 3 only if needed
- LLM marks each node as sequential (depends on previous) or parallel (independent) — simpler than full edge specification but enables parallelism
- Proactive vs reactive prompts: Claude decides whether to use same template with different context or separate specialized prompts
- Complexity flag for recursive trigger: Claude decides best signal (LLM flag vs heuristic)

### LLM Output Format
- Node list with dependsOn IDs: `{nodes: [{id, task, dependsOn: []}]}`
- Each node references dependencies by ID — standard DAG representation
- Cycle detection runs on this explicit graph before acceptance
- Format validated with JSON schema before building DAG

### Goal Visibility
- Full tree visualization shown to the user during execution
- Display in both progress messages (ASCII tree in onProgress channel) AND dashboard endpoint (/api/goals)
- Tree updates shown on state changes only (sub-goal starts, completes, or fails) — not every tool call
- Works across all channels (Telegram, Discord, CLI, Web)

### Failure Propagation
- Agent decides at runtime whether to propagate failure to parent based on context
- One retry with REPLAN before propagating failure (leverages existing FailureClassifier)
- Sibling execution on failure: agent decides whether independent siblings continue based on failure context
- Partial progress reporting: agent decides whether to include completed sub-goal results in failure response

### TaskDecomposer Relationship
- New GoalDecomposer replaces existing flat TaskDecomposer entirely
- Handles both simple (flat) and complex (recursive DAG) cases — one system
- Location: Claude decides based on dependency analysis and import graph

### DAG Persistence
- SQLite persisted: goal nodes and edges stored in SQLite tables (survives restarts)
- Phase 8 can resume execution from where it left off
- Storage location (new goals.db vs existing DB): Claude decides based on read/write patterns
- DAG encodes parallelism: nodes without dependency edges are implicitly parallel

### Goal-Instinct Interaction
- Claude decides whether/how instincts influence decomposition (hints in prompt vs mandatory sub-goals vs no interaction)

### Claude's Discretion
- GoalDecomposer file location (src/agents/ vs src/tasks/)
- Storage database choice (new goals.db vs tasks.db vs learning.db)
- Event bus integration for goal lifecycle events
- Proactive vs reactive prompt design (shared template vs separate)
- Complexity detection signal for recursive decomposition
- Instinct integration approach
- GoalNode data model fields beyond core (id, task, dependsOn, depth, status)
- ASCII tree rendering format
- Dashboard /api/goals response structure

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/tasks/task-decomposer.ts`: Existing flat decomposer with shouldDecompose() heuristic and LLM-based decompose(). Will be replaced but heuristic patterns are reusable.
- `src/tasks/background-executor.ts`: executeDecomposed() shows current flat subtask execution. Needs refactoring to use GoalDecomposer DAG.
- `src/agents/agent-state.ts`: PAOR state machine with immutable state, VALID_TRANSITIONS map. Decomposition integrates at PLANNING and REFLECTING phases.
- `src/core/event-bus.ts`: TypedEventBus with LearningEventMap. Can be extended with goal lifecycle events.
- `src/agents/failure-classifier.ts`: Detects when to force replan. Can trigger reactive decomposition.
- `src/learning/storage/learning-storage.ts`: SQLite storage pattern with migrations, prepared statements, pragma standardization. Template for goal storage.

### Established Patterns
- Bootstrap constructor injection for all singletons
- SQLite pragma standardization (WAL, cache_size, busy_timeout) across all databases
- Immutable state with spread-copy (AgentState pattern)
- Heuristic pre-check + LLM fallback (TaskDecomposer pattern)
- Fire-and-forget for non-critical operations
- Zod config with environment variable transforms and defaults

### Integration Points
- `src/agents/orchestrator.ts:634-636`: PAOR state machine init — where proactive decomposition would trigger during PLANNING
- `src/agents/orchestrator.ts:REFLECTING phase`: Where reactive decomposition triggers when agent is stuck
- `src/tasks/background-executor.ts:86-91`: Where TaskDecomposer is called — needs to route to GoalDecomposer instead
- `src/core/bootstrap.ts`: Wiring point for GoalDecomposer creation and injection
- `src/config/config.ts`: Zod schema for GOAL_MAX_DEPTH config option

</code_context>

<specifics>
## Specific Ideas

- The existing TaskDecomposer produces flat lists of 3-8 subtasks with sequential execution. GoalDecomposer must be a strict upgrade: flat decomposition is just a DAG with linear dependencies.
- Node list with dependsOn IDs format (`{nodes: [{id: "a", task: "...", dependsOn: ["b"]}]}`) chosen for clean DAG representation and straightforward cycle detection.
- Full tree upfront + hybrid LLM calls means: initial call produces depth 1-2 DAG, then each complex leaf at depth 2 gets a recursive call to produce depth 3. Max 1 + N recursive calls where N = complex leaves at depth 2.
- ASCII tree in progress messages must work across all channels including Telegram (monospace formatting) and CLI.
- SQLite persistence enables Phase 8 to resume interrupted goal execution — critical for long-running tasks.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 07-recursive-goal-decomposition*
*Context gathered: 2026-03-07*
