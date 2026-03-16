# Agent Core

The autonomous reasoning engine for Strada.Brain. Provides environment observation, task-aware multi-provider routing, confidence-based consensus, and proactive agent behavior.

## Architecture

```
src/agent-core/
├── agent-core.ts              — OODA reasoning loop (observe → orient → decide → act)
├── agent-core-types.ts        — ActionDecision, AgentCoreConfig, shared interfaces
├── observation-engine.ts      — Multi-source observation collection with dedup
├── observation-types.ts       — AgentObservation, Observer interface
├── priority-scorer.ts         — Learning-informed observation ranking
├── reasoning-prompt.ts        — LLM prompt building + response parsing
├── agent-notifier.ts          — Proactive user notifications
├── index.ts                   — Barrel exports
├── observers/
│   ├── file-watch-observer.ts — File system change events
│   ├── git-state-observer.ts  — Periodic git status monitoring
│   ├── build-state-observer.ts — Build pass/fail tracking
│   ├── trigger-observer.ts    — Daemon trigger events
│   ├── user-activity-observer.ts — Idle/active state changes
│   ├── test-result-observer.ts — Test execution outcomes
│   └── index.ts
└── routing/
    ├── task-classifier.ts     — Heuristic prompt/tool classification
    ├── provider-router.ts     — Task+phase→provider selection with presets
    ├── routing-presets.ts     — budget/balanced/performance weight definitions
    ├── routing-types.ts       — TaskClassification, RoutingPreset, ConsensusResult
    ├── confidence-estimator.ts — Heuristic output confidence scoring
    ├── consensus-manager.ts   — Multi-provider review/re-execute verification
    └── index.ts
```

## Key Components

### AgentCore
Runs as part of HeartbeatLoop.tick(). Each tick: collect observations → score priorities → LLM reasoning → act or wait. Protected by tickInFlight guard, 30s rate limit, budget floor (10%), and priority threshold (30).

### ObservationEngine
Collects from registered observers, deduplicates within 60s window, maintains history (100 entries max). Priority-sorted output.

### ProviderRouter
Scores available providers against task classification using configurable preset weights (cost, capability, speed, diversity). Supports PAOR phase switching — different providers for planning vs execution vs reflection.

### ConsensusManager
When ConfidenceEstimator scores output below threshold, ConsensusManager verifies with a second provider. Strategies: "review" (ask if correct) or "re-execute" (same prompt to different provider). Graceful degradation: 1 provider = skip entirely.

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `ROUTING_PRESET` | `balanced` | budget / balanced / performance |
| `ROUTING_PHASE_SWITCHING` | `true` | Different providers per PAOR phase |
| `CONSENSUS_MODE` | `auto` | auto / critical-only / always / disabled |
| `CONSENSUS_THRESHOLD` | `0.5` | Confidence below this triggers consensus |
| `CONSENSUS_MAX_PROVIDERS` | `3` | Max providers consulted per decision |

## Tests

```bash
npx vitest run src/agent-core/            # All agent-core tests
npx vitest run src/agent-core/routing/    # Routing tests only
npx vitest run src/agent-core/observers/  # Observer tests only
```
