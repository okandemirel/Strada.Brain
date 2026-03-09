# Roadmap: Strada.Brain

## Milestones

- ✅ **v1.0 Agent Evolution (Level 3 -> 4)** -- Phases 1-9 (shipped 2026-03-08)
- [ ] **v2.0 Full Daemon (Level 4 -> 5)** -- Phases 10-19 (in progress)

## Phases

<details>
<summary>v1.0 Agent Evolution (Phases 1-9) -- SHIPPED 2026-03-08</summary>

- [x] Phase 1: AgentDB Activation (2/2 plans) -- completed 2026-03-06
- [x] Phase 2: Memory Migration & HNSW Hardening (3/3 plans) -- completed 2026-03-06
- [x] Phase 3: Auto-Tiering & Embedding Infrastructure (3/3 plans) -- completed 2026-03-06
- [x] Phase 4: Event-Driven Learning (2/2 plans) -- completed 2026-03-06
- [x] Phase 5: Metrics Instrumentation (2/2 plans) -- completed 2026-03-07
- [x] Phase 6: Bayesian Confidence System (3/3 plans) -- completed 2026-03-07
- [x] Phase 7: Recursive Goal Decomposition (3/3 plans) -- completed 2026-03-07
- [x] Phase 8: Goal Progress & Execution (3/3 plans) -- completed 2026-03-07
- [x] Phase 9: Tool Chain Synthesis (3/3 plans) -- completed 2026-03-07

**32/32 requirements delivered. 2142 tests. 97K LOC.**
**Archive:** `milestones/v1.0-ROADMAP.md`, `milestones/v1.0-REQUIREMENTS.md`

</details>

### v2.0 Full Daemon (Level 4 -> 5)

**Milestone Goal:** Transform Strada.Brain from a reactive Level 4 agent into a proactive Level 5 daemon that runs 24/7 -- monitors, learns, acts, and reports autonomously without being asked.

- [x] **Phase 10: WebSocket Security Hardening** - Fix known vulnerability patterns before adding daemon control surfaces (completed 2026-03-08)
- [x] **Phase 11: LLM Self-Awareness + Identity Foundation** - Agent knows its own capabilities and can introspect its state (completed 2026-03-08)
- [x] **Phase 12: Persistent Identity + Startup Recovery** - Agent persists identity across restarts and recovers from crashes (completed 2026-03-08)
- [x] **Phase 13: Cross-Session Learning Transfer** - Instincts flow across sessions with provenance and project-scope filtering (completed 2026-03-08)
- [x] **Phase 14: Heartbeat Daemon Loop** - Core daemon loop with trigger evaluation, security policy, and cost guards (completed 2026-03-08)
- [x] **Phase 15: Proactive Triggers** - File watcher, webhook, checklist, and deduplication extend the daemon's senses (completed 2026-03-09)
- [x] **Phase 16: Interactive Goal Execution + Replanning** - Goals execute inline during chat with mid-execution replanning (completed 2026-03-09)
- [ ] **Phase 17: Dynamic Memory Re-retrieval** - Context refreshes during long PAOR loops to prevent stale reasoning
- [ ] **Phase 18: Dual Reporting + Dashboard** - Periodic digest to chat and daemon endpoint on dashboard
- [ ] **Phase 19: Tool Validation Feedback Loop** - Composite tools validated post-synthesis with auto-deprecation on failure

## Phase Details

### Phase 10: WebSocket Security Hardening
**Goal**: WebSocket dashboard is secure against cross-site hijacking and brute-force attacks
**Depends on**: Nothing (security prerequisite for all daemon work)
**Requirements**: SEC-01, SEC-02
**Success Criteria** (what must be TRUE):
  1. WebSocket server rejects connections with mismatched or missing Origin headers
  2. After 5 failed auth attempts from an IP, that IP is blocked for 5 minutes
  3. Existing dashboard functionality continues to work for legitimate connections
**Plans**: 1 plan

Plans:
- [ ] 10-01-PLAN.md -- Origin validation + brute-force protection + security tests

### Phase 11: LLM Self-Awareness + Identity Foundation
**Goal**: Agent understands its own capabilities and can report its internal state to users
**Depends on**: Phase 10
**Requirements**: IDENT-03, IDENT-04
**Success Criteria** (what must be TRUE):
  1. System prompt includes a capability manifest describing goals, learning, and chain synthesis abilities
  2. User can ask "what can you do?" and agent responds with awareness of its goal decomposition, learning pipeline, and tool synthesis
  3. Agent can invoke introspection tools (agent_status, learning_stats) and report its own state accurately
**Plans**: 2 plans

Plans:
- [ ] 11-01-PLAN.md -- Capability manifest in system prompt (buildCapabilityManifest)
- [ ] 11-02-PLAN.md -- Introspection tools (AgentStatusTool, LearningStatsTool) + registration

### Phase 12: Persistent Identity + Startup Recovery
**Goal**: Agent maintains continuous identity across restarts and recovers interrupted work after crashes
**Depends on**: Phase 11
**Requirements**: IDENT-01, IDENT-02
**Success Criteria** (what must be TRUE):
  1. Agent persists boot count, cumulative uptime, and last activity timestamp in SQLite across restarts
  2. After an unclean shutdown, agent detects the crash on next startup and resumes interrupted goal trees
  3. Agent's identity state (boot number, uptime) is available to the self-awareness system from Phase 11
**Plans**: 2 plans

Plans:
- [x] 12-01-PLAN.md -- IdentityStateManager + config + system prompt + AgentStatusTool + bootstrap wiring
- [x] 12-02-PLAN.md -- Crash detection + recovery context + system prompt injection + bootstrap wiring

### Phase 13: Cross-Session Learning Transfer
**Goal**: Learned patterns persist across sessions with provenance tracking and project-scope filtering
**Depends on**: Phase 12
**Requirements**: INTEL-01, INTEL-02
**Success Criteria** (what must be TRUE):
  1. Instinct retrieval returns relevant patterns from previous sessions, not just the current one
  2. Each retrieved pattern includes provenance metadata (originating session, age, usage count)
  3. Patterns are filterable by scope (project-specific vs universal) to prevent cross-project contamination
**Plans**: 3 plans

Plans:
- [x] 13-01-PLAN.md -- Types, config, migration runner, and schema migration for cross-session foundation
- [x] 13-02-PLAN.md -- Scope-filtered retrieval, provenance formatting, eager deduplication, weighted scoring
- [x] 13-03-PLAN.md -- Bootstrap wiring, metrics integration, CLI cross-session subcommand

### Phase 14: Heartbeat Daemon Loop
**Goal**: Agent runs as a persistent daemon with periodic self-activation, pluggable trigger evaluation, security constraints, and cost controls
**Depends on**: Phase 13
**Requirements**: DAEMON-01, DAEMON-02, DAEMON-03, DAEMON-04, DAEMON-05, SEC-03, SEC-04, SEC-05, TRIG-01
**Success Criteria** (what must be TRUE):
  1. HeartbeatLoop runs at configurable intervals, evaluating registered triggers each tick without calling the LLM unless a trigger fires
  2. Daemon-initiated tool calls are read-only by default; write operations queue for user approval visible in dashboard
  3. When daily LLM budget is exceeded, daemon halts proactive actions and notifies the user
  4. CronTrigger fires at scheduled times with timezone support
  5. After repeated trigger failures, exponential backoff and circuit breaker prevent runaway re-evaluation
**Plans**: 5 plans

Plans:
- [x] 14-01-PLAN.md -- Types, config schema, DaemonStorage, DaemonEvents foundation
- [x] 14-02-PLAN.md -- CircuitBreaker, HEARTBEAT.md parser, CronTrigger, TriggerRegistry
- [x] 14-03-PLAN.md -- BudgetTracker, DaemonSecurityPolicy, ApprovalQueue
- [x] 14-04-PLAN.md -- HeartbeatLoop core + bootstrap wiring + --daemon CLI flag
- [x] 14-05-PLAN.md -- Daemon CLI commands + dashboard /api/daemon + AgentStatusTool extension

### Phase 15: Proactive Triggers
**Goal**: Daemon responds to real-world events through file changes, webhooks, checklists, and deduplication
**Depends on**: Phase 14
**Requirements**: TRIG-02, TRIG-03, TRIG-04, TRIG-05
**Success Criteria** (what must be TRUE):
  1. FileWatchTrigger detects changes in configured directories with debouncing (no duplicate events for rapid saves)
  2. ChecklistTrigger evaluates a natural-language task list (HEARTBEAT.md) and fires when items are due
  3. WebhookTrigger accepts HTTP POST on the dashboard server to initiate agent actions
  4. Duplicate trigger actions within a configurable time window are suppressed
**Plans**: 3 plans

Plans:
- [ ] 15-01-PLAN.md -- Types, config, parser extension, deduplicator, and event map foundation
- [ ] 15-02-PLAN.md -- FileWatchTrigger (chokidar event buffering) + ChecklistTrigger (NL time eval)
- [ ] 15-03-PLAN.md -- WebhookTrigger + dashboard endpoints + HeartbeatLoop dedup + bootstrap wiring + CLI

### Phase 16: Interactive Goal Execution + Replanning
**Goal**: Users trigger goal decomposition and execution directly in chat with progress reporting and mid-execution replanning on failure
**Depends on**: Phase 11
**Requirements**: EXEC-01, EXEC-02, EXEC-03, EXEC-04
**Success Criteria** (what must be TRUE):
  1. User can say "build me X" in chat and GoalExecutor runs inline, not just via /task submit
  2. During multi-step execution, user sees progress reports for each completed goal step
  3. When a goal subtree fails, it re-decomposes with current context instead of simply failing
  4. When failure budget is exhausted, user receives an escalation prompt asking how to proceed
**Plans**: 3 plans

Plans:
- [ ] 16-01-PLAN.md -- Types, config, events, storage migration, /goal command foundation
- [ ] 16-02-PLAN.md -- PAOR goal detection short-circuit + pre-decomposed tree path + wave progress
- [ ] 16-03-PLAN.md -- LLM-driven re-decomposition on failure + enhanced escalation with auto-abort

### Phase 17: Dynamic Memory Re-retrieval
**Goal**: Agent refreshes its memory context during long execution loops to prevent stale reasoning
**Depends on**: Phase 16
**Requirements**: INTEL-03, INTEL-04
**Success Criteria** (what must be TRUE):
  1. During long PAOR loops, memory context is refreshed every N iterations (configurable)
  2. When the current topic shifts significantly (cosine distance above threshold), memory re-retrieval triggers automatically
  3. Re-retrieved memories are deduplicated against already-injected context
**Plans**: TBD

Plans:
- [ ] 17-01: TBD
- [ ] 17-02: TBD

### Phase 18: Dual Reporting + Dashboard
**Goal**: Users get visibility into daemon behavior through periodic chat digests and a real-time dashboard endpoint
**Depends on**: Phase 14
**Requirements**: RPT-01, RPT-02, RPT-03, RPT-04
**Success Criteria** (what must be TRUE):
  1. DigestReporter sends periodic summary to a chat channel on a configurable schedule
  2. Dashboard exposes /api/daemon endpoint showing identity state, trigger history, and uptime
  3. Notifications have urgency levels (silent/low/medium/high/critical) that determine delivery channel
  4. During quiet hours, notifications are buffered and delivered as a morning digest
**Plans**: TBD

Plans:
- [ ] 18-01: TBD
- [ ] 18-02: TBD

### Phase 19: Tool Validation Feedback Loop
**Goal**: Composite tools are validated after synthesis and auto-deprecate when they consistently fail
**Depends on**: Phase 14
**Requirements**: INTEL-05, INTEL-06
**Success Criteria** (what must be TRUE):
  1. After synthesis, composite tools are validated against historical input/output pairs
  2. Composite tools with Bayesian confidence below 0.3 after validation failure are automatically deprecated
  3. Validation results feed back into the learning pipeline via EventBus
**Plans**: TBD

Plans:
- [ ] 19-01: TBD
- [ ] 19-02: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 10 -> 11 -> 12 -> 13 -> 14 -> 15 -> 16 -> 17 -> 18 -> 19
Note: Phases 15, 16, 18, 19 have partially independent dependencies (see phase details).

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. AgentDB Activation | v1.0 | 2/2 | Complete | 2026-03-06 |
| 2. Memory Migration & HNSW Hardening | v1.0 | 3/3 | Complete | 2026-03-06 |
| 3. Auto-Tiering & Embedding Infrastructure | v1.0 | 3/3 | Complete | 2026-03-06 |
| 4. Event-Driven Learning | v1.0 | 2/2 | Complete | 2026-03-06 |
| 5. Metrics Instrumentation | v1.0 | 2/2 | Complete | 2026-03-07 |
| 6. Bayesian Confidence System | v1.0 | 3/3 | Complete | 2026-03-07 |
| 7. Recursive Goal Decomposition | v1.0 | 3/3 | Complete | 2026-03-07 |
| 8. Goal Progress & Execution | v1.0 | 3/3 | Complete | 2026-03-07 |
| 9. Tool Chain Synthesis | v1.0 | 3/3 | Complete | 2026-03-07 |
| 10. WebSocket Security Hardening | v2.0 | 1/1 | Complete | 2026-03-08 |
| 11. LLM Self-Awareness + Identity Foundation | v2.0 | Complete    | 2026-03-08 | 2026-03-08 |
| 12. Persistent Identity + Startup Recovery | v2.0 | Complete    | 2026-03-08 | 2026-03-08 |
| 13. Cross-Session Learning Transfer | v2.0 | Complete    | 2026-03-08 | 2026-03-08 |
| 14. Heartbeat Daemon Loop | v2.0 | Complete    | 2026-03-08 | 2026-03-08 |
| 15. Proactive Triggers | 3/3 | Complete    | 2026-03-09 | - |
| 16. Interactive Goal Execution + Replanning | 3/3 | Complete   | 2026-03-09 | - |
| 17. Dynamic Memory Re-retrieval | v2.0 | 0/TBD | Not started | - |
| 18. Dual Reporting + Dashboard | v2.0 | 0/TBD | Not started | - |
| 19. Tool Validation Feedback Loop | v2.0 | 0/TBD | Not started | - |

---
*Roadmap created: 2026-03-06*
*v2.0 phases added: 2026-03-08*
*Last updated: 2026-03-09*
