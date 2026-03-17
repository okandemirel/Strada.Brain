# Multi-Provider Intelligent Orchestration

> Historical design note: This file records a design snapshot. It is not the authoritative source for current runtime behavior or env defaults. Use [README.md](../../../README.md), [src/config/README.md](../../../src/config/README.md), [src/channels/README.md](../../../src/channels/README.md), and [SECURITY.md](../../../SECURITY.md) for the current system.

## Problem Statement

Strada.Brain supports 12+ AI providers but uses them in a primitive way: one provider per chat session with simple fallback chain. The system cannot use different providers for different purposes (planning vs execution vs review), cannot self-verify by consulting a second model, and has no task-aware routing to optimize cost/quality/speed tradeoffs.

The existing TierRouter only applies to delegation sub-agents, not the main orchestrator or AgentCore OODA loop.

## Design Principles

- **Graceful Degradation**: 1 provider = everything works normally with zero errors, zero warnings. 2 providers = basic routing + limited consensus. 12 providers = full routing + consensus + diversity.
- **No Breaking Changes**: Wizard presets and existing config unaffected. Multi-provider is additive.
- **Agent-Driven Consensus**: The agent decides when it needs a second opinion based on its own confidence, not hardcoded rules.
- **Cost-Aware**: Every routing and consensus decision factors in remaining budget.

## Architecture

### Component Overview

```
                    ┌─────────────────────────┐
                    │      TaskClassifier      │
                    │  (heuristic, no LLM)     │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │     ProviderRouter       │
                    │  preset + task → provider│
                    └────────────┬────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                   │
     ┌────────▼───────┐ ┌───────▼────────┐ ┌───────▼────────┐
     │  PAOR PLANNING  │ │ PAOR EXECUTING │ │ PAOR REFLECTING│
     │  (capable model)│ │ (tool model)   │ │ (different one)│
     └────────┬───────┘ └───────┬────────┘ └───────┬────────┘
              │                  │                   │
              └──────────────────┼──────────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │   ConfidenceEstimator    │
                    │  (heuristic scoring)     │
                    └────────────┬────────────┘
                                 │ confidence < threshold?
                    ┌────────────▼────────────┐
                    │    ConsensusManager      │
                    │  (review or re-execute)  │
                    └─────────────────────────┘
```

### 1. TaskClassifier (`src/agent-core/routing/task-classifier.ts`)

Heuristic-based classification — no LLM call.

```typescript
interface TaskClassification {
  type: "planning" | "code-generation" | "code-review" | "simple-question" |
        "analysis" | "refactoring" | "destructive-operation" | "debugging";
  complexity: "trivial" | "simple" | "moderate" | "complex";
  criticality: "low" | "medium" | "high" | "critical";
}
```

Classification rules:
- Prompt length + keyword patterns → complexity
- Tool usage type → task type (file_delete → destructive, dotnet_build → debugging)
- Learning patterns → historical success rate refinement

### 2. ProviderRouter (`src/agent-core/routing/provider-router.ts`)

Task-aware provider selection with configurable presets.

```typescript
type RoutingPreset = "budget" | "balanced" | "performance";

class ProviderRouter {
  resolve(task: TaskClassification, phase?: AgentPhase): IAIProvider;
}
```

Routing logic per preset (balanced example):

| Task Type | Preference Order |
|-----------|-----------------|
| planning | Widest context window (Claude > GPT > Gemini) |
| code-generation | Strong tool calling (Claude > Kimi > OpenAI) |
| code-review | DIFFERENT model than executor (diversity bias) |
| simple-question | Fastest/cheapest (Groq > Kimi > Ollama) |
| destructive-op | Most capable (safety-critical) |
| debugging | Strong error analysis (from provider-knowledge.ts) |

PAOR phase integration:
- PLANNING phase → planning-optimized provider
- EXECUTING phase → tool-calling-optimized provider
- REFLECTING phase → different provider (self-review diversity, must match streaming capability of session)

**Conversation History Portability**: The PAOR loop currently captures `provider` once before iterating. Phase switching requires that `ConversationMessage[]` is provider-agnostic — which it already is at the interface level (role/content/tool_calls). Each provider normalizes internally on `chat()` call. The fix: instead of capturing `const provider` once, call `ProviderRouter.resolve(task, agentState.phase)` on each iteration to get the phase-appropriate provider. The message history format (`ConversationMessage`) is already the shared contract — no new normalization needed since providers parse from this common type.

**Streaming Constraint**: When REFLECTING phase switches provider in interactive mode, the new provider must support streaming if the session is streaming. If not, fall back to same provider as EXECUTING (no switch). This prevents confusing mid-conversation streaming interruptions.

**Constructor Dependency**: ProviderRouter requires `ProviderManager` injection to call `isAvailable(name)` and `getProvider(chatId)`. Without this, it cannot know which providers exist at runtime.

```typescript
class ProviderRouter {
  constructor(
    private providerManager: ProviderManager,
    private preset: RoutingPreset,
  ) {}

  resolve(task: TaskClassification, phase?: AgentPhase): IAIProvider;
}
```

Single provider: `resolve()` calls `providerManager.listAvailable()` — if only 1, returns it immediately. Zero overhead.

### 3. Routing Presets (`src/agent-core/routing/routing-presets.ts`)

```typescript
const PRESETS: Record<RoutingPreset, RoutingWeights> = {
  budget: {
    costWeight: 0.6,      // Strongly prefer cheap
    capabilityWeight: 0.2,
    speedWeight: 0.2,
    diversityWeight: 0.0, // No diversity concern
  },
  balanced: {
    costWeight: 0.2,
    capabilityWeight: 0.4, // Match task to capability
    speedWeight: 0.1,
    diversityWeight: 0.3, // Diversity for review
  },
  performance: {
    costWeight: 0.0,
    capabilityWeight: 0.6, // Always most capable
    speedWeight: 0.2,
    diversityWeight: 0.2,
  },
};
```

### 4. ConfidenceEstimator (`src/agent-core/routing/confidence-estimator.ts`)

Heuristic scoring of agent output confidence (no LLM call).

```typescript
class ConfidenceEstimator {
  constructor(
    private learningStorage?: LearningStorage,  // For historical success rate lookup
  ) {}

  estimate(context: {
    taskClassification: TaskClassification;
    modelTier: string;
    agentState: AgentState;           // Provides consecutiveErrors + stepResults (from PAOR)
    responseLength: number;
    expectedResponseRange: [number, number];
  }): number; // 0.0 - 1.0
}
```

**Data Access Path:**
- `sessionErrorCount` → derived from `agentState.stepResults.filter(s => !s.success).length` (already tracked by PAOR)
- `consecutiveErrors` → from `agentState.consecutiveErrors` (already on AgentState)
- `historicalSuccessRate` → from `learningStorage.getTaskTypeSuccessRate(classification.type)` (new query, non-blocking with fallback 0.5 if unavailable)
- No new fields needed on AgentState — all data already exists in the PAOR loop scope

Factors:
- Tool call success rate this session (from agentState.stepResults) → low = lower confidence
- Task complexity "complex" + model tier "cheap" → capability mismatch → lower confidence
- Learning historical success rate for this task type (from learningStorage) → low = lower confidence
- Response length vs expected → too short/long → lower confidence
- Consecutive PAOR errors (from agentState.consecutiveErrors, 2+) → lower confidence

### 5. ConsensusManager (`src/agent-core/routing/consensus-manager.ts`)

Multi-provider verification triggered by low confidence.

```typescript
/** Original output can be text, tool calls, or both */
interface OriginalOutput {
  text?: string;
  toolCalls?: Array<{ name: string; input: Record<string, unknown> }>;
}

class ConsensusManager {
  async verify(params: {
    originalOutput: OriginalOutput;   // Text AND/OR tool calls
    originalProvider: string;
    task: TaskClassification;
    confidence: number;
    availableProviders: IAIProvider[];
    prompt: string;                   // Original prompt for re-execute strategy
  }): Promise<ConsensusResult>;
}
```

**Tool Call Consensus**: When the original output contains tool calls (especially destructive operations like `file_delete`, `shell_exec`), the consensus "review" strategy serializes the tool calls as human-readable text: `"Agent wants to execute: file_delete(path='/src/foo.cs'). Is this the correct action?"`. This gives Provider B the actual operation intent, not just the response text which may be empty for tool-producing turns.

Strategies by scenario:

| Scenario | Strategy | Cost |
|----------|----------|------|
| confidence < 0.4 | **Re-execute**: Same prompt to different provider, compare results | High |
| confidence < 0.6 + destructive op | **Review**: Ask Provider B "Is this correct?" | Medium |
| 2 providers agree | Confirmed — proceed | N/A |
| 2 providers disagree | Third provider arbitrates OR escalate to user | High |

Graceful degradation:
- 1 provider → skip entirely, confidence logged only
- 2 providers → re-execute or review possible, no arbitration
- 3+ providers → full consensus pipeline

Budget protection:
- Near budget floor → consensus skip
- "Review" strategy preferred over "re-execute" (cheaper)

### 6. Configuration

```bash
# Routing
ROUTING_PRESET=balanced              # budget | balanced | performance
ROUTING_PHASE_SWITCHING=true         # Different providers per PAOR phase

# Consensus
CONSENSUS_MODE=auto                  # auto | critical-only | always | disabled
CONSENSUS_THRESHOLD=0.5              # Confidence below this triggers consensus
CONSENSUS_MAX_PROVIDERS=3            # Max providers consulted per decision
```

### 7. Chat Commands

```
/routing                    — Show current routing status + preset
/routing preset balanced    — Switch preset
/routing info               — Show last 10 routing decisions
```

### 8. Web Portal Additions

**SettingsPage:**
- Routing Preset selector (Budget / Balanced / Performance buttons)
- Consensus Mode selector (Auto / Critical Only / Always / Disabled)

**Dashboard:**
- Provider usage breakdown chart
- Consensus trigger history
- Per-provider success rate

## Integration Points

| Existing Component | Change |
|-------------------|--------|
| `ProviderManager` | Injected into ProviderRouter as dependency (for `isAvailable()` + `listAvailable()` + `getProvider()`) |
| `TierRouter` | Preserved as internal sub-component of ProviderRouter (facade pattern, not removed) |
| `AgentCore.tick()` | Uses ProviderRouter.resolve() instead of fixed provider |
| `Orchestrator PAOR loop` | Phase-aware provider switching via ProviderRouter |
| `provider-knowledge.ts` | Data source for routing decisions (strengths, context window, cost) |
| `DelegationManager` | Uses ProviderRouter instead of TierRouter |
| `config.ts` | New fields: routing.preset, consensus.mode, consensus.threshold |

## New Files

```
src/agent-core/routing/
├── task-classifier.ts          — Heuristic task classification
├── provider-router.ts          — Task-aware provider selection
├── routing-presets.ts           — budget/balanced/performance definitions
├── confidence-estimator.ts     — Output confidence scoring
├── consensus-manager.ts        — Multi-provider verification
└── index.ts
```

## Implementation Phases

### Phase 1: TaskClassifier + ProviderRouter
- Heuristic classification (no LLM)
- Provider routing with presets
- Graceful single-provider path
- Wire into Orchestrator + AgentCore
- Tests

### Phase 2: PAOR Phase Switching
- Different provider per PAOR phase
- Diversity constraint for REFLECTING phase
- Integration with existing PAOR loop

### Phase 3: ConfidenceEstimator + ConsensusManager
- Heuristic confidence scoring
- Review and re-execute strategies
- Multi-provider comparison logic
- Budget-aware skip

### Phase 4: Configuration + UI
- Env vars + Zod validation
- /routing chat command
- SettingsPage routing controls
- Dashboard provider analytics

### Phase 5: TierRouter Integration
- ProviderRouter wraps TierRouter as internal sub-component (facade pattern)
- TierRouter preserved for DelegationManager escalation chain (`getEscalationTier`, `getTypeEffectiveTier`, `resolveProviderConfig`)
- DelegationManager optionally uses ProviderRouter for initial tier selection, falls back to TierRouter escalation on failure
- TierRouter NOT removed — it becomes an internal implementation detail of ProviderRouter

## Success Criteria

1. 2+ provider configured → agent automatically uses different providers for planning vs execution vs review
2. Single provider → zero behavioral change, zero errors, zero warnings
3. Agent detects low confidence → automatically consults second provider
4. `/routing preset budget` → measurable cost reduction vs balanced
5. Consensus prevents incorrect destructive operations (agent was wrong, second model catches it)
6. All existing tests continue passing
7. Provider routing decisions logged and visible in dashboard

## Risk Analysis

| Risk | Mitigation |
|------|-----------|
| Routing overhead slows response | TaskClassifier is heuristic (sub-ms). Provider switch is cached in ProviderManager |
| Consensus doubles LLM cost | Budget-aware skip + "review" strategy (cheaper than re-execute) + configurable threshold |
| Wrong provider selected for task | Fallback: if selected provider fails, escalate to next capable (existing chain logic) |
| Consensus deadlock (A says yes, B says no, C says maybe) | Max 3 providers. If no agreement after 3, escalate to user |
| Single provider users confused by routing config | All routing config has sensible defaults. Single provider = zero visible difference |
