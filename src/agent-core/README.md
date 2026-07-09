# Agent Core

The autonomous reasoning engine for Strada.Brain. Provides environment observation, task-aware multi-provider routing, confidence-based consensus, and proactive agent behavior.

> **Note:** This is the **OODA loop** (proactive, daemon-triggered). The reactive user-facing loop (PAOR) lives in `src/agents/orchestrator.ts`. See CONTRIBUTING.md for how they relate.

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
├── routing/
│   ├── task-classifier.ts     — Heuristic prompt/tool classification
│   ├── provider-router.ts     — Task+phase→provider selection with presets
│   ├── routing-presets.ts     — budget/balanced/performance weight definitions
│   ├── routing-types.ts       — TaskClassification, RoutingPreset, ConsensusResult
│   ├── confidence-estimator.ts — Heuristic output confidence scoring
│   ├── consensus-manager.ts   — Multi-provider review/re-execute verification
│   └── index.ts
├── control/                   — Agent Core v2 control plane: ONE owner per cross-cutting concern
│   ├── run-clock.ts           — wall-clock deadlines (per-call timers + task-scope silence accumulator)
│   ├── budget.ts              — output-token / cost budget (input never gates)
│   ├── failure-ledger.ts      — continue/retry/ask/pause/stop/done verdict precedence (the one arbiter)
│   ├── cancel-reason.ts       — the single typed CancelReason union + isBenign()
│   ├── cancel-token.ts        — linked AbortController tree (first-writer-wins fan-out)
│   ├── clock.ts               — injectable Clock (SystemClock in prod / FakeClock for deterministic tests)
│   ├── policy.ts              — RunBudgetPolicy resolved once from config (clamp-and-warn on bad ordering)
│   └── index.ts
└── runner/                    — Agent Core v2 strangler seam: the AgentRunner façade
    ├── agent-runner.ts        — AgentRunner / IOStrategy / AgentRunRequest / AgentRunResult contract
    ├── v1-agent-runner.ts     — pass-through adapter over the existing v1 orchestrator entry methods
    ├── flags.ts               — LEGAL_FLAG_SETS (enumerated, reject-at-boot) gating the staged migration
    └── index.ts
```

## Key Components

### AgentCore
Runs as part of HeartbeatLoop.tick(). Each tick: collect observations → score priorities → LLM reasoning → act or wait. Protected by tickInFlight guard, 30s rate limit, budget floor (10%), and priority threshold (30).
AgentCore does not directly take over an in-flight PAOR execution loop. Its job is to notice opportunities, submit proactive goals, and feed the orchestrator more work; the orchestrator still owns code-edit execution, verification, and loop recovery for those tasks.
When a foreground user task is already active, AgentCore now treats human-visible `notify` / `escalate` actions as deferrable control-plane signals instead of printing into the live session. The observation is re-queued for later review so OODA stays proactive without hijacking PAOR execution.

### ObservationEngine
Collects from registered observers, deduplicates within 60s window, maintains history (100 entries max). Priority-sorted output.

### ProviderRouter
Scores available providers against task classification using configurable preset weights plus learned control-plane signals. Preset workload weights (`cost`, `capability`, `speed`, `diversity`) are now combined with runtime phase telemetry, explicit phase-local verdict scores, verifier cleanliness, rollback pressure, retry cost, provider-catalog freshness, official alignment, and persisted execution replay signals. Terminal replay bias also blends the strongest available trajectory verdict, preferring trusted judge types before recency, so a later weak review can down-weight a branch that only looked successful in its original runtime window without punishing earlier non-terminal phases. Supports PAOR phase switching, so planning, execution, clarification-review, review, and synthesis can favor different workers without provider-specific hardcoding.
These routing decisions are internal worker assignments only. The user still talks only to Strada; provider traces and phase outcomes are evidence of the control plane, not a direct chat identity switch.

### ConsensusManager
When ConfidenceEstimator scores output below threshold, ConsensusManager verifies with a second provider. Strategies: "review" (ask if correct) or "re-execute" (same prompt to different provider). Graceful degradation: 1 provider = skip entirely.

## Agent Core v2 — Control Plane & AgentRunner Seam (staged migration, in progress)

`control/` and `runner/` are the foundation of the **Agent Core v2** migration: a strangler-fig
rewrite of the three drift-prone seams in v1's reactive loop (the two ~600-line driver shells, the
fragmented control plane of 5 timeouts + 3 failure counters, and the triplicated provider scorers)
into one coherent fabric — **without** discarding the incident-hardening that the kept components
earned (the 3h27m runaway, the ~70min silent-stall, audits #6–#18). v1 and v2 coexist behind
**per-concern / per-route flags** consuming the same unversioned dependencies until v2 has absorbed
every path. See [`plans/agent-core-v2/`](../../plans/agent-core-v2/) for the architecture + phased plan.

- **`control/` — the one control plane (P-A).** Exactly one owner per cross-cutting concern:
  `RunClock` (every wall-clock deadline, deadlines nested by `min(child, parentRemaining)`, plus a
  task-scope *silence accumulator* that the per-call ceiling can't livelock), `Budget`,
  `FailureLedger` (a single deterministic verdict precedence — the arbiter v1 lacked), and one typed
  `CancelReason` union. Timers are real per-scope `AbortSignal.timeout`s re-armed on change (no
  sampler); the injectable `Clock` makes the incident regressions deterministic under a `FakeClock`.
- **`runner/` — the strangler boundary.** `AgentRunner` is the single entry both engines implement.
  `V1AgentRunner` is a behavior-preserving pass-through over the existing v1 orchestrator methods
  (Phase 0); `V2AgentRunner` (Phase 2) is the unified strategy-parameterized driver. `IOStrategy`
  captures the one axis of variation (interactive vs background I/O) so the loop body never forks.
  `LEGAL_FLAG_SETS` enumerates the valid flag combinations and **rejects anything else at boot**, so
  untested combinations are unreachable by construction.

**Migration status — the V2 spine IS the engine (cutover Step 5 complete).** Phase 0 (the
`AgentRunner` seam), Phase 1 (the control plane — `failureLedger`, `runClock`,
`silenceAccumulator`, `typedCancelReason`), Phase 2 (the unified `V2AgentRunner` spine +
`ModelGateway` + `EventBus`, the faithful `OrchestratorPort`), Step 3 (the interactive driver),
Step 4 (THE FLIP: production default `v2-all-routes+full-control-plane`), and **Step 5 (the v1
engine DELETED — `runAgentLoop`/`runBackgroundTask`/`runWorkerTask`/`V1AgentRunner` and the v1
rollout flag sets are gone)** have all shipped. Every route (interactive/background/worker/
supervisor-node) runs the V2 spine on the full control plane; there is no v1 fallback.
**Deprecated ids:** a stale `AGENT_CORE_FLAG_SET` revert value (`all-v1`,
`v1-driver+full-control-plane`, the 1a–1c rollout steps, the partial v2-worker stages) resolves
to the production default instead of crash-looping the boot. Scoring/capability unification
(Phase 3) and streaming visibility (Phase 5) are pending; next: relocate the engine out of
`orchestrator.ts` into `src/agent-core/engine/`.

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `AGENT_CORE_FLAG_SET` | `v2-all-routes+full-control-plane` | Active stage — a `LEGAL_FLAG_SETS` id (v2 ladder only). Unset → the production default. Deprecated v1-era ids alias to the default. Unknown id → reject-at-boot. |
| `ROUTING_PRESET` | `balanced` | budget / balanced / performance |
| `ROUTING_PHASE_SWITCHING` | `true` | Different providers per PAOR phase (orchestrator phases, not OODA) |
| `CONSENSUS_MODE` | `auto` | auto / critical-only / always / disabled |
| `CONSENSUS_THRESHOLD` | `0.5` | Confidence below this triggers consensus |
| `CONSENSUS_MAX_PROVIDERS` | `3` | Max providers consulted per decision |

## Tests

```bash
npx vitest run src/agent-core/            # All agent-core tests
npx vitest run src/agent-core/routing/    # Routing tests only
npx vitest run src/agent-core/observers/  # Observer tests only
```
