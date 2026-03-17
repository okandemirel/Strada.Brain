# Agent Core: Autonomous Intelligence Architecture

> Historical design note: This file records a design snapshot. It is not the authoritative source for current runtime behavior or env defaults. Use [README.md](../../../README.md), [src/config/README.md](../../../src/config/README.md), [src/channels/README.md](../../../src/channels/README.md), and [SECURITY.md](../../../SECURITY.md) for the current system.

## Problem Statement

Strada.Brain has 7 sophisticated subsystems (PAOR, GoalSystem, Learning, Daemon, ErrorRecovery, SelfVerification, TaskPlanner) that each work individually but fail to produce intelligent autonomous behavior when combined. Three specific architectural problems prevent this:

1. **Three conflicting planning systems** — PAOR state machine, TaskPlanner protocol injection, and show_plan tool all inject different planning instructions into the same LLM context simultaneously
2. **Two-tier execution quality** — Interactive path uses full PAOR (reflect, replan, goal detection) while background/daemon path uses a simplified loop without reflection or replanning
3. **Daemon is a cron job, not an agent** — HeartbeatLoop fires triggers and submits tasks but performs zero reasoning about what to do, when, or why

The result: `/autonomous on` disables confirmation dialogs but the agent still can't think proactively. `/goal` decomposes tasks but daemon tasks can't reflect or replan. Learning records patterns but never drives what the agent chooses to work on.

## Architecture

### Design Principles

- **Single reasoning authority**: PAOR is the only planning/reflection system
- **Unified execution quality**: Background and interactive use the same PAOR engine
- **Observation-driven**: Agent responds to environment changes, not just user messages
- **Learning-informed decisions**: Patterns influence both HOW and WHAT to do
- **Budget-safe**: All autonomous actions respect existing budget, circuit breaker, and safety systems

### Layer Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    OBSERVATION LAYER                         │
│  Collects environment state into an ObservationStream        │
│                                                              │
│  Sources:                                                    │
│  • FileWatchObserver    (reuses existing FileWatchTrigger)   │
│  • GitStateObserver     (uncommitted changes, branch state)  │
│  • TestResultObserver   (test pass/fail after file changes)  │
│  • BuildStateObserver   (compilation errors)                 │
│  • UserActivityObserver (idle detection, session state)      │
│  • TriggerObserver      (existing cron/webhook/checklist)    │
│                                                              │
│  Output: Observation[] → priority-scored event stream        │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                    REASONING LAYER                           │
│  Single PAOR-based decision engine for ALL execution paths   │
│                                                              │
│  AgentCore:                                                  │
│  1. OBSERVE  — collect pending observations                  │
│  2. ORIENT   — priority score + learning-informed ranking    │
│  3. DECIDE   — LLM reasoning: act, wait, or escalate?       │
│  4. ACT      — submit goal/task to execution layer           │
│                                                              │
│  Inputs: ObservationStream + Memory + Instincts + Goals      │
│  Output: ActionDecision (execute | wait | notify | escalate) │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                    EXECUTION LAYER                           │
│  Unified PAOR-driven execution for ALL task types            │
│                                                              │
│  UnifiedAgentLoop (replaces both runAgentLoop &              │
│                    runBackgroundTask):                        │
│  • PAOR state machine (plan → execute → reflect → replan)   │
│  • Goal decomposition (proactive + reactive)                 │
│  • Error recovery + self-verification                        │
│  • Memory re-retrieval                                       │
│  • Tool execution with DMPolicy                              │
│                                                              │
│  Existing systems preserved:                                 │
│  • GoalExecutor (wave-based parallel)                        │
│  • ErrorRecoveryEngine (C# error analysis)                   │
│  • SelfVerification (build gate)                             │
│  • Learning event emission (tool:result → pipeline)          │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                   COMMUNICATION LAYER                        │
│  Proactive notifications + status reporting                  │
│                                                              │
│  • AgentNotifier: proactive messages to user                 │
│    ("I noticed test X failed, I'm fixing it")                │
│  • Existing ProgressReporter (task completion)               │
│  • Existing NotificationRouter (daemon events)               │
│  • Existing DigestReporter (periodic summaries)              │
│  • Dashboard WebSocket events (real-time)                    │
└─────────────────────────────────────────────────────────────┘
```

### Component Details

#### 1. ObservationEngine (`src/agent-core/observation-engine.ts`)

Replaces ad-hoc trigger checking with a unified observation stream.

```typescript
interface AgentObservation {
  id: string;
  source: "file-watch" | "git" | "test" | "build" | "user" | "trigger" | "schedule";
  priority: number;          // 0-100, learning-adjusted
  summary: string;           // Human-readable description
  context: Record<string, unknown>;  // Source-specific data
  timestamp: number;
  actionable: boolean;       // Can the agent do something about this?
}

class ObservationEngine {
  private observers: Observer[];
  private queue: PriorityQueue<AgentObservation>;

  // Collect all pending observations (called each agent tick)
  collect(): AgentObservation[];

  // Priority scoring uses learning patterns
  scorePriority(obs: AgentObservation, instincts: Instinct[]): number;
}
```

**Observers** wrap existing infrastructure:
- `FileWatchObserver`: Wraps existing `FileWatchTrigger` event buffering
- `GitStateObserver`: New — runs `git status`/`git diff --stat` periodically
- `TestResultObserver`: New — monitors last test run results
- `BuildStateObserver`: Wraps existing `dotnet_build` result tracking from SelfVerification
- `TriggerObserver`: Wraps existing `TriggerRegistry` for cron/webhook/checklist
- `UserActivityObserver`: Wraps existing idle detection from HeartbeatLoop

#### 2. AgentCore (`src/agent-core/agent-core.ts`)

The reasoning engine. Runs as a continuous loop when daemon mode is active.

```typescript
class AgentCore {
  private observationEngine: ObservationEngine;
  private executionEngine: UnifiedAgentLoop;
  private learningPipeline: LearningPipeline;
  private instinctRetriever: InstinctRetriever;
  private budgetTracker: BudgetTracker;
  private tickInFlight = false;         // Prevents concurrent tick overlap
  private lastReasoningMs = 0;          // Rate limiting for LLM calls

  // Session identity for agent-initiated goals
  static readonly AGENT_CHAT_ID = "agent-core";
  static readonly AGENT_CHANNEL_TYPE = "daemon";

  // Config
  private readonly minObservationPriority = 30;  // Skip reasoning below this
  private readonly minReasoningIntervalMs = 30_000; // Max 2 LLM calls/min
  private readonly budgetFloorPct = 10;           // Skip if budget < 10%

  // Main agent loop — called from HeartbeatLoop.tick()
  async tick(): Promise<void> {
    // Guard: prevent concurrent tick overlap (LLM calls can be slow)
    if (this.tickInFlight) return;
    this.tickInFlight = true;

    try {
      // Rate limit: don't call LLM more than once per minReasoningIntervalMs
      if (Date.now() - this.lastReasoningMs < this.minReasoningIntervalMs) return;

      // Budget guard: skip reasoning if budget nearly exhausted
      const budget = this.budgetTracker.getUsage();
      if (budget.pct >= (100 - this.budgetFloorPct)) return;

      // 1. OBSERVE — collect environment state
      const observations = this.observationEngine.collect();
      if (observations.length === 0) return;

      // 2. ORIENT — rank by priority + learning
      const ranked = this.rankObservations(observations);

      // Skip LLM call if no observation above threshold
      if (ranked.length === 0 || ranked[0].priority < this.minObservationPriority) return;

      // 3. DECIDE — LLM reasoning about what to do
      this.lastReasoningMs = Date.now();
      const decision = await this.reason(ranked);

      // 4. ACT — based on decision
      switch (decision.action) {
        case "execute":
          await this.submitGoal(decision.goal, decision.reasoning);
          break;
        case "notify":
          await this.notifyUser(decision.message);
          break;
        case "escalate":
          await this.requestUserInput(decision.question);
          break;
        case "wait":
          break; // Agent decided nothing needs doing
      }
    } finally {
      this.tickInFlight = false;
    }
  }

  // Submit goal using dedicated agent-core session identity
  private async submitGoal(goal: string, reasoning: string): Promise<void> {
    // Goals initiated by AgentCore use a dedicated chatId ("agent-core")
    // This separates them from user sessions and daemon trigger tasks
    // Goal trees are persisted to GoalStorage and resumable after crash
    await this.taskManager.submit(
      AgentCore.AGENT_CHAT_ID,
      AgentCore.AGENT_CHANNEL_TYPE,
      goal,
      { origin: "agent-core" }
    );
  }

  // LLM-driven reasoning about observations
  private async reason(observations: AgentObservation[]): Promise<ActionDecision> {
    // Build context: observations + active goals + learned patterns + budget
    // Ask LLM: "Given these observations, what should you do?"
    // Parse structured response
  }

  // Priority ranking with learning influence
  private rankObservations(obs: AgentObservation[]): AgentObservation[] {
    // Base priority from source type
    // Boost: matches learned pattern with high confidence
    // Boost: user explicitly requested this type of monitoring
    // Penalty: similar observation recently acted on (dedup)
    // Penalty: budget running low
  }
}
```

**Key design decision**: AgentCore.reason() is an LLM call. This is what makes it an "agent" not a "cron job". The LLM sees the observations, the current state, the learned patterns, and decides what to do. It can also decide to do nothing — which is critical for not burning budget on noise.

#### 3. UnifiedAgentLoop (`src/agents/unified-agent-loop.ts`)

Replaces both `runAgentLoop()` and `runBackgroundTask()` with a single PAOR-driven execution path.

```typescript
class UnifiedAgentLoop {
  // Single execution path for ALL task types
  async execute(params: {
    prompt: string;
    chatId: string;
    channelType: string;
    systemPrompt: string;
    origin: "user" | "daemon" | "agent-core";
    attachments?: Attachment[];
    parentMetricId?: string;
    // Context carried from caller (not rebuilt inside loop)
    userProfileStore?: UserProfileStore;
    soulLoader?: SoulLoader;
    embeddingProvider?: IEmbeddingProvider;
    initialContentHashes?: string[];     // For memory re-retrieval dedup
    skipOnboarding?: boolean;            // true for daemon/agent-core origin
  }): Promise<string> {
    // PAOR state machine — same for interactive and background
    let state = createInitialState(params.prompt);

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      // Phase-aware prompt building (PLANNING/EXECUTING/REFLECTING/REPLANNING)
      const activePrompt = this.buildPhasePrompt(params.systemPrompt, state);

      // LLM call
      const response = await this.callLLM(activePrompt, ...);

      // REFLECTING phase handling
      if (state.phase === AgentPhase.REFLECTING) {
        const decision = parseReflectionDecision(response.text);
        // DONE / CONTINUE / REPLAN logic
      }

      // Tool execution + autonomy tracking
      // Error recovery + self-verification
      // Step result recording + reflection triggers
      // Memory re-retrieval
    }
  }
}
```

**What changes from current orchestrator:**
- `runBackgroundTask()` code path eliminated — uses same PAOR loop
- `TaskPlanner.getPlanningPrompt()` removed — PAOR PLANNING phase handles this
- `TaskPlanner` tracking methods preserved (mutation count, stall detection, trajectory)
- ~150 lines of duplicated system prompt assembly extracted to shared method

#### 4. Learning-Informed Priority (`src/agent-core/priority-scorer.ts`)

Connects existing learning system to observation ranking.

```typescript
class PriorityScorer {
  constructor(
    private instinctRetriever: InstinctRetriever,
    private patternMatcher: PatternMatcher,
  ) {}

  score(observation: AgentObservation): number {
    let priority = observation.priority; // Base from source

    // Boost if similar pattern was successfully handled before
    const similar = this.patternMatcher.findSimilar(observation.summary);
    if (similar.length > 0 && similar[0].confidence > 0.7) {
      priority += 20; // We know how to handle this
    }

    // Boost if user has interacted with this type before
    const instincts = this.instinctRetriever.getInsightsForTask(observation.summary);
    if (instincts.insights.length > 0) {
      priority += 10;
    }

    // Penalty for recently handled similar observation
    // (dedup at reasoning level, not just trigger level)

    return Math.min(100, Math.max(0, priority));
  }
}
```

### HeartbeatLoop Transformation

The existing HeartbeatLoop is NOT replaced — it's refactored:

**Before:**
```
tick() {
  for (trigger of triggers) {
    if (trigger.shouldFire()) {
      taskManager.submit(trigger.description);
    }
  }
}
```

**After:**
```
async tick() {
  // Phase 1: Existing trigger checking (preserved)
  this.checkTriggers(); // Same as before — fire, dedup, budget, circuit breaker

  // Phase 2: Agent reasoning (NEW)
  // AgentCore.tick() has its own tickInFlight guard — safe to call every tick
  // even if previous reasoning is still in progress (will no-op)
  if (this.agentCore) {
    await this.agentCore.tick(); // Observe → Reason → Decide → Act
  }
}
```

This means:
- All existing daemon functionality preserved (triggers, budget, approval, circuit breaker)
- Agent reasoning added as a second phase within each tick
- Budget shared between triggers and agent-initiated work
- Circuit breaker applies to agent failures too

### TaskPlanner Refactoring

TaskPlanner's conflicting planning prompt is removed. Its tracking capabilities are preserved:

**Removed:**
- `getPlanningPrompt()` — PAOR PLANNING phase replaces this
- The `PLANNING_PROMPT` constant (OBSERVE → PLAN → ACT → VERIFY → RESPOND)

**Preserved:**
- `trackToolCall()` — mutation tracking, stall detection
- `getStateInjection()` — verification nagging, budget warnings
- `startTask()` / `endTask()` — trajectory recording for learning
- `recordError()` — error history tracking

## Implementation Phases

### Phase 1: Unify PAOR + Remove TaskPlanner Conflict
**Files**: orchestrator.ts, task-planner.ts, paor-prompts.ts
**Risk**: Low (removing duplicate, not adding new)
**Tests**: Existing PAOR tests + TaskPlanner tests updated

1. **Migrate C#-specific rules to PAOR first**: Copy TaskPlanner's build-verification rules ("After editing files, run dotnet_build", "NEVER declare done without verifying compilation") and error-recovery ordering ("Fix in dependency order: missing types → undefined symbols → type mismatches → logic") into `buildPlanningPrompt()` or `buildExecutionContext()` in `paor-prompts.ts`. These are NOT covered by existing PAOR prompts and will be lost if removed without migration.
2. Remove `TaskPlanner.getPlanningPrompt()` and `PLANNING_PROMPT` constant
3. Remove `systemPrompt += taskPlanner.getPlanningPrompt()` from both execution paths
4. Verify the migrated PAOR prompts include all operational rules from TaskPlanner
5. Keep all TaskPlanner tracking methods (trackToolCall, getStateInjection, etc.)

### Phase 2: Unified Agent Loop
**Files**: New unified-agent-loop.ts, orchestrator.ts refactor
**Risk**: Medium (merging two code paths)
**Tests**: New unified loop tests + existing integration tests

1. Extract shared system prompt assembly into `buildSystemPromptWithContext()` — merges ~150 lines of duplicated memory/RAG/instinct/analysis injection from both paths
2. Create `UnifiedAgentLoop` class with single PAOR-driven execution. Params include: userProfileStore, soulLoader, embeddingProvider, initialContentHashes, skipOnboarding flag
3. Refactor `runAgentLoop()` to delegate to UnifiedAgentLoop (skipOnboarding=false)
4. Refactor `runBackgroundTask()` to delegate to UnifiedAgentLoop (skipOnboarding=true for daemon/agent-core origin, false for user-initiated background tasks)
5. BackgroundExecutor uses UnifiedAgentLoop for node execution
6. **Explicit integration test**: Invoke `UnifiedAgentLoop.execute()` with `origin: "daemon"` and mock LLM responses. Verify PAOR phase transitions occur (PLANNING → EXECUTING → REFLECTING) — confirms background tasks now use PAOR even without Observation Engine (Phase 3)

### Phase 3: Observation Engine
**Files**: New src/agent-core/observation-engine.ts, observer implementations
**Risk**: Low (new code, wraps existing infrastructure)
**Tests**: New unit tests per observer

1. Create ObservationEngine with observer interface
2. Implement FileWatchObserver (wraps FileWatchTrigger)
3. Implement TriggerObserver (wraps TriggerRegistry)
4. Implement UserActivityObserver (wraps idle detection)
5. Add GitStateObserver (new: periodic git status)
6. Add BuildStateObserver (wraps SelfVerification state)

### Phase 4: Agent Core + Priority Scoring
**Files**: New src/agent-core/agent-core.ts, priority-scorer.ts
**Risk**: Medium (LLM reasoning in autonomous loop)
**Tests**: New integration tests with mock LLM

1. Create AgentCore with tick() method
2. Implement LLM-driven reasoning (structured output parsing)
3. Create PriorityScorer with learning integration
4. Wire into HeartbeatLoop as second phase of tick()
5. Add budget-aware throttling (skip reasoning if budget low)

### Phase 5: Communication + Polish
**Files**: New agent-notifier.ts, dashboard updates
**Risk**: Low (notification layer)
**Tests**: Notification tests

1. Create AgentNotifier for proactive user messages
2. Add `/agent` command for status/history
3. Dashboard: agent activity log panel
4. Web portal: agent toggle in SettingsPage

## Success Criteria

1. `/autonomous on` → agent proactively detects test failure and fixes it without user message
2. File change in project → agent observes, reasons, and decides to build/test
3. Background tasks use PAOR — can reflect and replan like interactive tasks
4. No TaskPlanner/PAOR conflict — single coherent planning system
5. Budget and safety limits enforced for all agent-initiated actions
6. Agent can decide "nothing to do" and not burn budget on idle ticks
7. Learning patterns influence what the agent chooses to work on
8. All 3350+ existing tests continue passing

## Risk Analysis

| Risk | Mitigation |
|------|-----------|
| LLM reasoning burns budget on every tick | Three-layer throttle: (1) minReasoningIntervalMs=30s floor, (2) minObservationPriority=30 threshold skips noise, (3) budgetFloorPct=10% hard stop |
| Concurrent tick overlap causes duplicate goals | tickInFlight boolean guard in AgentCore (matches existing consolidationRunning pattern in HeartbeatLoop) |
| Agent enters infinite loop (observe → act → observe same thing) | Dedup at observation level + circuit breaker for agent actions + reasoning-level dedup |
| Agent makes destructive changes autonomously | Existing DaemonSecurityPolicy + budget limits + autonomous override expiry |
| Unified loop breaks interactive experience | Gradual rollout: background first, interactive after validation |
| AgentCore reasoning prompt too complex for smaller models | Provider-aware prompt sizing (shorter for Groq/Ollama, richer for Claude) |
| C#-specific VERIFY rules lost during TaskPlanner removal | Explicit migration step: copy rules to PAOR prompts BEFORE removing TaskPlanner prompt |
| Agent-initiated goals lack session identity for resume | Dedicated "agent-core" chatId for goal persistence and crash recovery |

## Non-Goals (Explicitly Out of Scope)

- Multi-agent collaboration (COLLAB-01..02 deferred to v5)
- Voice-driven commands
- External service monitoring (GitHub, CI/CD)
- Self-modifying code (agent editing its own source)
- User permission per-observation-type granularity
