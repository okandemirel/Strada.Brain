# Roadmap: Strada.Brain

## Milestones

- ✅ **v1.0 Agent Evolution (Level 3 -> 4)** -- Phases 1-9 (shipped 2026-03-08)
- ✅ **v2.0 Full Daemon (Level 4 -> 5)** -- Phases 10-19 (shipped 2026-03-10)
- ✅ **v2.0 Gap Closure** -- Phase 20 (shipped 2026-03-10)
- [ ] **v3.0 Multi-Agent & Hardening** -- Phases 21-25 (in progress)

## Phases

<details>
<summary>v1.0 Agent Evolution (Phases 1-9) -- SHIPPED 2026-03-08</summary>

**32/32 requirements delivered. 2142 tests. 97K LOC.**
**Archive:** `milestones/v1.0-ROADMAP.md`, `milestones/v1.0-REQUIREMENTS.md`, `milestones/v1.0-phases/`

</details>

<details>
<summary>v2.0 Full Daemon (Phases 10-19) -- SHIPPED 2026-03-10</summary>

**33/33 requirements delivered. 2,775 tests. 118K LOC.**
**Archive:** `milestones/v2.0-ROADMAP.md`, `milestones/v2.0-REQUIREMENTS.md`, `milestones/v2.0-MILESTONE-AUDIT.md`

</details>

<details>
<summary>v2.0 Gap Closure (Phase 20) -- SHIPPED 2026-03-10</summary>

**3 integration gaps closed. 1 plan.**

</details>

### v3.0 Multi-Agent & Hardening (Phases 21-25)

**Milestone Goal:** Harden existing subsystems (memory decay, chain resilience) and extend Strada.Brain from single-agent depth to multi-agent breadth with task delegation, channel routing, and autonomous deployment.

- [x] **Phase 21: Operational Health & Memory Decay** - Fix trigger history pruning and add time-based memory decay with per-tier rates
- [x] **Phase 22: Tool Chain Resilience** - Add saga-pattern rollback for reversible chains and parallel branch execution via DAG topology
- [x] **Phase 23: Multi-Agent Foundation** - Establish per-agent session isolation, channel routing, budget tracking, and backward-compatible activation
- [ ] **Phase 24: Task Delegation** - Enable sub-agent spawning with depth limits and difficulty-aware model routing
- [ ] **Phase 25: Memory Consolidation & Deployment** - Add idle-time memory consolidation and approval-gated autonomous deployment

## Phase Details

### Phase 21: Operational Health & Memory Decay
**Goal**: Agent maintains healthy operational state through automatic pruning and applies intelligent time-based decay to memory importance scores
**Depends on**: Nothing (first v3 phase)
**Requirements**: OPS-01, OPS-02, MEM-08, MEM-09, MEM-10, MEM-11
**Success Criteria** (what must be TRUE):
  1. Trigger fire history entries older than the configured retention period are automatically deleted during heartbeat maintenance
  2. Memory importance scores decrease over time following exponential decay, with memories unused for extended periods scoring lower than recently accessed ones
  3. Each memory tier (Working, Ephemeral, Persistent) decays at a different rate configurable via environment variables
  4. Accessing a memory resets its decay clock, preserving frequently-used memories from decay
  5. Instincts are completely unaffected by time-based decay regardless of how long since last access
**Plans**: 4 plans

Plans:
- [x] 21-01-PLAN.md -- Trigger fire history time-based pruning (OPS-01, OPS-02)
- [x] 21-02-PLAN.md -- Memory decay core: exponential decay with per-tier rates (MEM-08, MEM-09, MEM-10, MEM-11)
- [x] 21-03-PLAN.md -- Decay observability: dashboard Maintenance section + CLI decay-status command
- [ ] 21-04-PLAN.md -- Gap closure: wire decay config in bootstrap + fix config test regression

### Phase 22: Tool Chain Resilience
**Goal**: Agent recovers gracefully from chain failures through compensating rollback and executes independent chain steps in parallel
**Depends on**: Nothing (independent from Phase 21)
**Requirements**: CHAIN-01, CHAIN-02, CHAIN-03, CHAIN-04
**Success Criteria** (what must be TRUE):
  1. When a chain step fails, all previously completed reversible steps execute their compensating actions in reverse order
  2. Tools are classified as reversible or irreversible, and chains containing any irreversible step skip rollback entirely (forward-recovery only)
  3. Independent chain steps with no data dependencies execute concurrently, reducing total chain execution time
  4. The agent detects parallel opportunities in tool chains and represents them as DAG structures with explicit dependency edges
**Plans**: 5 plans

Plans:
- [x] 22-01-PLAN.md -- Foundation: V2 schemas, config, DAG validator, rollback executor (CHAIN-01, CHAIN-02, CHAIN-03, CHAIN-04)
- [x] 22-02-PLAN.md -- Synthesis: V2 LLM prompt with compensation + reversibility + DAG, V1->V2 migration (CHAIN-01, CHAIN-02, CHAIN-04)
- [x] 22-03-PLAN.md -- Execution: DAG parallel execution + saga rollback in CompositeTool, rollback confidence penalty (CHAIN-01, CHAIN-02, CHAIN-03)
- [x] 22-04-PLAN.md -- Observability: dashboard Chain Resilience section + CLI chain:status + bootstrap wiring (CHAIN-01, CHAIN-02, CHAIN-03, CHAIN-04)
- [x] 22-05-PLAN.md -- Gap closure: fix V2 metadata wiring in ChainSynthesizer/ChainManager + integration tests (CHAIN-01, CHAIN-02, CHAIN-03, CHAIN-04)

### Phase 23: Multi-Agent Foundation
**Goal**: Agent supports isolated per-channel sessions with independent budget tracking while maintaining full backward compatibility with single-agent mode
**Depends on**: Phase 21
**Requirements**: AGENT-01, AGENT-02, AGENT-06, AGENT-07
**Success Criteria** (what must be TRUE):
  1. Each agent's LLM token usage and cost is tracked independently with hierarchical rollup to a global budget total
  2. An agent that exceeds its per-agent budget cap is stopped, preventing further LLM calls without affecting other agents
  3. Incoming messages on different channels are routed to isolated agent sessions that do not share conversation state
  4. With multi-agent mode disabled, the system behaves identically to v2.0 with zero observable differences
**Plans**: 3 plans

Plans:
- [x] 23-01-PLAN.md -- Agent types, config, registry, budget tracker, and event bus extensions (AGENT-01, AGENT-02, AGENT-07)
- [x] 23-02-PLAN.md -- AgentManager: routing, isolation, budget enforcement, lifecycle management (AGENT-01, AGENT-02, AGENT-06)
- [x] 23-03-PLAN.md -- Bootstrap wiring, CLI agent commands, Dashboard Agents section, backward compat verification (AGENT-01, AGENT-02, AGENT-06, AGENT-07)

### Phase 24: Task Delegation
**Goal**: Agent delegates bounded subtasks to sub-agents with enforced depth limits and cost-aware model selection
**Depends on**: Phase 23
**Requirements**: AGENT-03, AGENT-04, AGENT-05
**Success Criteria** (what must be TRUE):
  1. The agent delegates bounded subtasks to sub-agents that appear as registered tools in the tool registry
  2. Delegation depth is hard-capped at 2 -- sub-agents cannot delegate further, preventing unbounded spawning
  3. Delegated tasks are routed to appropriate model tiers based on task difficulty, using cheaper models for simpler sub-tasks
**Plans**: 3 plans

Plans:
- [x] 24-01-PLAN.md -- Delegation types, config schema, tier router, and audit log (AGENT-03, AGENT-04, AGENT-05)
- [ ] 24-02-PLAN.md -- DelegationTool (ITool) and DelegationManager with sub-agent orchestration (AGENT-03, AGENT-04, AGENT-05)
- [ ] 24-03-PLAN.md -- Bootstrap wiring, CLI delegation commands, Dashboard Delegations panel (AGENT-03, AGENT-04, AGENT-05)

### Phase 25: Memory Consolidation & Deployment
**Goal**: Agent consolidates similar memories during idle periods and can execute approval-gated deployments when readiness is detected
**Depends on**: Phase 23, Phase 24
**Requirements**: MEM-12, MEM-13, DEPLOY-01, DEPLOY-02, DEPLOY-03
**Success Criteria** (what must be TRUE):
  1. During idle periods, the agent clusters similar memories via HNSW and consolidates them using LLM summarization, reducing memory redundancy
  2. Memory consolidation interrupts immediately when user activity resumes, with no perceptible delay to the user
  3. The agent detects deployment readiness and proposes deployment through the existing approval queue
  4. Deployment executes only after explicit human approval via any connected channel, never autonomously
  5. Deployment capability is disabled by default and requires explicit opt-in configuration
**Plans**: TBD

Plans:
- [ ] 25-01: TBD
- [ ] 25-02: TBD
- [ ] 25-03: TBD

## Progress

**Execution Order:**
Phases 21 and 22 can execute in parallel (independent subsystems). Phase 23 follows Phase 21. Phase 24 follows Phase 23. Phase 25 follows Phase 24.

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1-9 | v1.0 | 24/24 | Complete | 2026-03-06..08 |
| 10-19 | v2.0 | 26/26 | Complete | 2026-03-08..10 |
| 20 | v2.0 gap closure | 1/1 | Complete | 2026-03-10 |
| 21. Operational Health & Memory Decay | 4/4 | Complete    | 2026-03-10 | 2026-03-10 |
| 22. Tool Chain Resilience | 5/5 | Complete    | 2026-03-11 | 2026-03-11 |
| 23. Multi-Agent Foundation | 3/3 | Complete    | 2026-03-11 | 2026-03-11 |
| 24. Task Delegation | v3.0 | 1/3 | In progress | - |
| 25. Memory Consolidation & Deployment | v3.0 | 0/TBD | Not started | - |

---
*Roadmap created: 2026-03-06*
*Last updated: 2026-03-12 after Phase 24 planning complete (3 plans in 3 waves)*
