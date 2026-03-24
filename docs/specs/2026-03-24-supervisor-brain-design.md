# Supervisor Brain - Intelligent Multi-Provider Orchestration Layer

**Date:** 2026-03-24
**Status:** Approved
**Scope:** New `src/supervisor/` module (~1,500 lines + ~500 lines tests)

## Overview

Supervisor Brain is an intelligent orchestration layer that sits above the existing PAOR loop. It acts as an autonomous team manager: analyzes complex tasks, determines capability requirements, assigns work to optimal providers, supervises execution across parallel PAOR instances, and aggregates results into a single coherent response.

The system works identically with both multi-provider and single-provider setups. With multiple providers, sub-tasks are routed to the best-fit provider based on capability scoring. With a single provider, the same pipeline runs but verification uses role-differentiated prompting (reviewer persona) for self-review.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Autonomy level | Full Autonomous Team Lead | System analyzes, plans, dispatches, supervises, and aggregates without user intervention |
| Single provider behavior | Same pipeline + role-differentiated verification | Consistent pipeline regardless of provider count; reviewer persona enables self-review |
| Activation strategy | Adaptive (TaskClassifier gate) | Simple tasks use existing PAOR (zero overhead); complex tasks trigger Supervisor Brain |
| Capability analysis | Hybrid (heuristic + cheap LLM triage) | Heuristics catch ~80-90% at zero cost; cheap LLM handles ambiguous cases (~$0.001/node) |
| GoalDecomposer relationship | Kept intact, new layers added between decompose and execute | Separation of concerns; proven code stays untouched |
| User visibility | Chat: minimal progress / Monitor panel: full detail | Clean conversation UX with optional deep observability |
| Architecture | Supervisor above PAOR, not inside it | Keeps orchestrator at 5,185 lines; Supervisor is a separate concern |

## Architecture

```
User Request
    |
TaskClassifier (existing, untouched)
    |-- simple/moderate --> Existing PAOR Loop (zero overhead)
    |-- complex -->
        |
        SupervisorBrain (new orchestrator)
        |
        GoalDecomposer (existing, untouched)
        |   Output: DAG (sub-goals + dependencies)
        |
        CapabilityMatcher (new)
        |   Output: capability tags per node
        |
        ProviderAssigner (new)
        |   Output: provider:model assignment per node
        |
        SupervisorDispatcher (new)
        |   Output: wave-based parallel PAOR execution
        |
        ResultAggregator (new)
        |   Output: cross-validated, merged final response
        |
User Response
```

## Components

### 1. SupervisorBrain (~250 lines)

Pipeline orchestrator and activation gate. Entry point for the entire supervisor pipeline.

**Responsibilities:**
- Receive complex task classification from TaskClassifier
- Orchestrate the 5-stage pipeline (decompose, match, assign, dispatch, aggregate)
- Emit lifecycle telemetry events
- Handle pipeline-level errors and abort cascading
- Manage supervisor-level configuration

**Key interface:**
```typescript
class SupervisorBrain {
  async execute(task: string, context: SupervisorContext): Promise<SupervisorResult>;
  abort(): void;
}
```

### 2. CapabilityMatcher (~200 lines)

Two-phase capability analysis: heuristic first-pass followed by cheap LLM triage for ambiguous nodes.

**Capability Taxonomy:**

Primary capabilities (model requirements):
- `reasoning` — Deep analysis, complex logic, debugging
- `vision` — Image/visual content processing
- `code-gen` — Code writing, refactoring, implementation
- `tool-use` — Tool calling intensive tasks
- `long-context` — Large file/context processing (>100K tokens)

Operational preferences (optimization):
- `speed` — Prioritize fast inference (Groq, Fireworks)
- `cost` — Prioritize low cost (DeepSeek, Ollama)
- `quality` — Prioritize best output (Claude Opus, GPT-5)
- `creative` — Creative content, naming, copywriting

**Phase 1: Heuristic First-Pass (0ms, $0)**

Pattern-based keyword matching against signal dictionaries:
- VISION_SIGNALS: "image", "photo", "screenshot", "visual", "thumbnail", "upload", "picture", "diagram"
- REASONING_SIGNALS: "analyze", "debug", "investigate", "why", "trace", "evaluate", "compare", "assess"
- CODEGEN_SIGNALS: "implement", "create", "build", "write code", "add feature", "refactor", "migrate"
- TOOL_SIGNALS: "search", "find files", "run tests", "execute", "deploy", "install"
- SPEED_SIGNALS: "quick", "fast", "simple check", "lint", "format"
- QUALITY_SIGNALS: "critical", "production", "security", "review carefully"

Confidence thresholds:
- matchCount >= 2 or strong match → confidence "high" (0.9), tag finalized
- matchCount == 1 → confidence "medium" (0.7), tag added but LLM verifies
- matchCount == 0 → confidence "low", sent to LLM triage

**Phase 2: Cheap LLM Triage (only for ambiguous nodes, ~$0.001/node)**

- Provider: configured via `SUPERVISOR_TRIAGE_PROVIDER` (default: groq)
- Batch support: multiple ambiguous nodes in single call
- Structured output prompt requesting capabilities array and priority
- Fallback: if triage provider unavailable, assign default profile (code-gen + quality)

**Output type:**
```typescript
interface CapabilityProfile {
  primary: CapabilityTag[];
  preference: "speed" | "cost" | "quality";
  confidence: number;  // 0-1
  source: "heuristic" | "llm-triage" | "hybrid";
}

interface TaggedGoalNode extends GoalNode {
  capabilityProfile: CapabilityProfile;
  assignedProvider?: string;
  assignedModel?: string;
}
```

### 3. ProviderAssigner (~250 lines)

Scores available providers against capability profiles and assigns the best-fit provider per node.

**Scoring algorithm:**

```
scoreProvider(provider, capabilityProfile):
  // 1. Hard filter: eliminate providers missing required capabilities
  for tag in capabilityProfile.primary:
    if provider.scores[tag] == 0: return -1  // e.g., vision=0 but vision required

  // 2. Weighted capability score (60%)
  capScore = sum(provider.scores[tag] for tag in primary) * 0.6

  // 3. Preference score (30%)
  prefScore = provider.scores[capabilityProfile.preference] * 0.3

  // 4. History bonus from execution traces (10%)
  historyScore = getSuccessRate(provider, tags) * 0.1

  return capScore + prefScore + historyScore
```

Provider capability scores are sourced from ModelIntelligence (self-updating metadata service) with hardcoded baselines as fallback.

**Hard rules (non-negotiable):**
1. Vision-requiring node cannot be assigned to vision=0 provider
2. Provider with failed healthCheck is excluded
3. Provider near rate limit triggers preference for alternatives
4. User hard-pin mode forces all nodes to pinned provider

**Soft rules (optimization):**
1. Diversity: max 60% of nodes to single provider (configurable via `SUPERVISOR_DIVERSITY_CAP`)
2. Cost balance: total estimated cost within agent budget
3. History: prefer providers with higher success rate for similar tasks
4. Affinity: assign dependency-connected nodes to same provider when scores are close (reduces context switching)

**Single-provider mode:**
All nodes assigned to the only available provider. Verification strategy switches to role-differentiated prompting (reviewer persona system prompt on same model).

### 4. SupervisorDispatcher (~300 lines)

Wave-based parallel dispatch with failure handling and progress tracking.

**Execution flow:**
```
for wave in topologicalSort(dag):
  readyNodes = wave.filter(n => all dependencies satisfied)
  results = await Promise.allSettled(
    readyNodes.map(node =>
      semaphore.acquire().then(() =>
        spawnPAORLoop(node, node.assignedProvider, node.assignedModel)
      )
    )
  )
  // Concurrency: semaphore(config.maxParallelNodes || 4)
  // Per-node: AbortController + timeout
  // Progress: emit supervisor:node_complete per node
```

Each sub-task runs as a full PAOR loop instance via `orchestrator.runBackgroundTask()` with the assigned provider.

**4-Level failure recovery:**

| Level | Trigger | Action | Cost |
|-------|---------|--------|------|
| L1: Retry | Transient error (timeout, rate limit, 5xx) | Retry same provider, maxRetries=1, backoff=2s | Low |
| L2: Provider Escalation | Retry fails | Switch to next-best provider from ProviderAssigner scores | Medium |
| L3: Re-Decompose | Escalation fails | GoalDecomposer.decomposeReactive() breaks node into smaller tasks, new children get CapabilityMatcher + ProviderAssigner | High |
| L4: Criticality Check | Re-decompose fails | LLM evaluates criticality. Non-critical: skip, dependents continue. Critical: skip + dependents, return partial result | Terminal |

**Failure budget:** maxFailures=3 (configurable). When exhausted, abort all remaining nodes and return completed work.

**Timeouts:**
- Interactive mode: 120s per node (configurable via `SUPERVISOR_NODE_TIMEOUT_MS`)
- Background/daemon mode: 300s per node
- Timeout triggers L2 escalation

**Cancellation:** User cancel aborts all active PAOR loops via AbortController cascade. Completed node results are preserved and returned as partial result.

**Budget guard:** After each node completion, check cumulative cost against AgentBudgetTracker. If exceeded, stop dispatching and return completed work.

### 5. ResultAggregator (~200 lines)

Three-stage result pipeline: collect, verify, synthesize.

**Stage 1: Collect**

Gather results from all completed nodes:
```typescript
interface NodeResult {
  nodeId: GoalNodeId;
  status: "ok" | "failed" | "skipped";
  output: string;
  artifacts: FileChange[];
  toolResults: ToolResult[];
  provider: string;
  cost: number;
  duration: number;
}
```

**Stage 2: Verify**

Cross-validation strategy depends on provider availability:

Multi-provider verification:
- Select a different provider from the one that executed the node
- Prefer providers with "reasoning" capability for verification
- Send reviewer prompt with original task, output, and artifacts
- Verdict: "approve" | "flag_issues" | "reject"
- flag_issues triggers re-execution of the node with issue context

Single-provider verification:
- Use same provider with reviewer persona system prompt
- Prompt explicitly states "You did NOT write this code. Review critically."
- Same verdict system as multi-provider

Verification configuration:
```typescript
interface VerificationConfig {
  mode: "always" | "critical-only" | "sampling" | "disabled";
  samplingRate: number;            // 0-1, for sampling mode
  preferDifferentProvider: boolean; // true: verify with different provider
  maxVerificationCost: number;     // max % of agent budget for verification
}
// Defaults: mode="critical-only", samplingRate=0.3,
// preferDifferentProvider=true, maxVerificationCost=15% of budget
```

**Stage 3: Synthesize**

Generate final user-facing response:

Full success: Merge all node outputs into coherent response with summary of what was accomplished.

Partial success: Present completed work, list failures with reasons, offer to complete remaining tasks.

**Conflict resolution** (when multiple nodes modify same files):
1. File-level conflict detection: identify nodes that touched the same file
2. LLM-driven merge: use highest-scoring "reasoning" provider to reconcile conflicting changes
3. Dependency ordering: later node in DAG wins on conflict
4. Fallback: present conflict to user if automatic resolution fails

## Telemetry Events

All events emitted via TypedEventBus, consumed by WorkspaceBus for Monitor panel:

| Event | Payload | Purpose |
|-------|---------|---------|
| `supervisor:activated` | taskId, complexity, nodeCount | Pipeline started |
| `supervisor:plan_ready` | dag, assignments Map | Decomposition + assignment complete |
| `supervisor:wave_start` | waveIndex, nodes[] | Wave execution begins |
| `supervisor:node_start` | nodeId, provider, model, wave | Individual node starts |
| `supervisor:node_complete` | nodeId, status, duration, cost | Individual node finishes |
| `supervisor:node_failed` | nodeId, error, failureLevel, nextAction | Node failure with recovery info |
| `supervisor:escalation` | nodeId, fromProvider, toProvider, reason | Provider escalation triggered |
| `supervisor:wave_done` | waveIndex, results, totalCost | Wave completed |
| `supervisor:verify_start` | nodeId, verifierProvider | Verification begins |
| `supervisor:verify_done` | nodeId, verdict, issues? | Verification result |
| `supervisor:conflict` | fileConflicts[], resolution | File conflict detected |
| `supervisor:complete` | totalNodes, succeeded, failed, skipped, cost, duration | Pipeline finished |
| `supervisor:aborted` | reason, completedNodes, partialResult | Pipeline aborted |

## User Experience

**Chat side (minimal progress):**
```
User: Auth sistemi kur - JWT, DB, endpoint'ler, testler

Strada.Brain: Görevi analiz ettim, 5 alt görev belirledim. Çalışıyorum...
              ⟳ 2/5 görev tamamlandı
              ⟳ 4/5 görev tamamlandı
              ✓ 5/5 görev tamamlandı
              Auth sistemi hazır: [coherent summary]
```

**Monitor panel (full detail):**
- Real-time DAG visualization with node status colors (pending/running/done/failed)
- Provider usage bar chart
- Cost, time, wave progress counters
- Verification status per node
- Failure/escalation event log

## Integration Points

**Untouched components (used as-is):**
- GoalDecomposer — DAG decomposition
- GoalExecutor — underlying wave execution engine
- GoalValidator — DAG cycle detection
- GoalStorage — SQLite persistence
- TaskClassifier — complexity gate
- PAOR Loop — sub-task execution engine
- ConsensusManager — verification support
- AgentBudgetTracker — budget enforcement

**Modified components (minimal changes):**
- `orchestrator.ts` — Add complexity gate in processMessage to route to SupervisorBrain
- `config.ts` — Add supervisor configuration section (Zod schema)
- `bootstrap-stages/` — New `stage-supervisor.ts` for initialization

**New components:**
- `src/supervisor/` — 7 files (brain, matcher, assigner, dispatcher, aggregator, types, telemetry)
- `src/supervisor/__tests__/` — 5 test files
- `src/core/bootstrap-stages/stage-supervisor.ts` — Bootstrap integration
- `web-portal/src/components/SupervisorPanel.tsx` — Monitor UI component

## Configuration

```env
SUPERVISOR_ENABLED=true
SUPERVISOR_COMPLEXITY_THRESHOLD=complex      # "moderate" | "complex" (trivial/simple always use PAOR directly)
SUPERVISOR_MAX_PARALLEL_NODES=4
SUPERVISOR_NODE_TIMEOUT_MS=120000
SUPERVISOR_VERIFICATION_MODE=critical-only   # "always" | "critical-only" | "sampling" | "disabled"
SUPERVISOR_VERIFICATION_BUDGET_PCT=15
SUPERVISOR_TRIAGE_PROVIDER=groq              # cheap model for capability analysis
SUPERVISOR_MAX_FAILURE_BUDGET=3
SUPERVISOR_DIVERSITY_CAP=0.6                 # max 60% nodes to single provider
```

## File Structure

```
src/supervisor/
  ├── supervisor-brain.ts          # Pipeline orchestrator (~250 lines)
  ├── capability-matcher.ts        # Heuristic + LLM triage (~200 lines)
  ├── provider-assigner.ts         # Scoring + assignment (~250 lines)
  ├── supervisor-dispatcher.ts     # Wave dispatch + failure (~300 lines)
  ├── result-aggregator.ts         # Verify + merge + synthesize (~200 lines)
  ├── supervisor-types.ts          # Shared types + interfaces (~100 lines)
  ├── supervisor-telemetry.ts      # Event definitions + emitters (~80 lines)
  └── __tests__/
      ├── capability-matcher.test.ts
      ├── provider-assigner.test.ts
      ├── supervisor-dispatcher.test.ts
      ├── result-aggregator.test.ts
      └── supervisor-brain.test.ts

src/core/bootstrap-stages/
  └── stage-supervisor.ts          # Bootstrap integration (~120 lines)

web-portal/src/components/
  └── SupervisorPanel.tsx          # Monitor UI component (~200 lines)
```

**Total new code:** ~1,500 lines implementation + ~500 lines tests
