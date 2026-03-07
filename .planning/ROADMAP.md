# Roadmap: Strada.Brain Phase 2 — Agent Evolution (Level 3 → 4)

**Created:** 2026-03-06
**Granularity:** Fine (9 phases)
**Coverage:** 32/32 v1 requirements mapped

## Phases

- [ ] **Phase 1: AgentDB Activation** - Wire AgentDB into bootstrap, align interfaces with IMemoryManager, add unified memory config
- [ ] **Phase 2: Memory Migration & HNSW Hardening** - Migrate FileMemoryManager data, enable HNSW semantic search, add write mutex for index safety
- [ ] **Phase 3: Auto-Tiering & Embedding Infrastructure** - Activate 3-tier memory promotion, standardize SQLite pragmas, wire embedding provider to learning pipeline
- [ ] **Phase 4: Event-Driven Learning** - Replace 5-minute batch timer with event-driven triggers, add event bus, enable online confidence updates
- [ ] **Phase 5: Metrics Instrumentation** - Instrument task completion rate, iterations per task, and pattern reuse rate
- [ ] **Phase 6: Bayesian Confidence System** - Wire Bayesian updates from real outcomes, auto-deprecate/promote patterns, enforce confidence threshold gap
- [ ] **Phase 7: Recursive Goal Decomposition** - Enable mid-execution sub-goals with DAG dependencies, cycle detection, and depth limits
- [ ] **Phase 8: Goal Progress & Execution** - Track progress at each decomposition level, execute sub-goals in topological order
- [ ] **Phase 9: Tool Chain Synthesis** - Detect recurring tool sequences, store as instincts, register and execute as composite tools

## Phase Details

### Phase 1: AgentDB Activation
**Goal**: The agent uses AgentDB as its persistent memory backend instead of FileMemoryManager
**Depends on**: Nothing (first phase)
**Requirements**: MEM-01, MEM-05, MEM-07
**Success Criteria** (what must be TRUE):
  1. Agent boots with AgentDB as the memory backend and serves conversations without errors
  2. AgentDB implements the IMemoryManager contract (or adapter bridges the gap) so all existing orchestrator code works unchanged
  3. Unified memory config options (tier thresholds, auto-tiering toggle) are present in Zod schema and validated at startup
**Plans:** 2 plans
Plans:
- [ ] 01-01-PLAN.md — Extend Zod config with unified memory options + create AgentDBAdapter implementing IMemoryManager
- [ ] 01-02-PLAN.md — Wire AgentDB into bootstrap with self-healing initialization + learning.db migration fix + .bak cleanup

### Phase 2: Memory Migration & HNSW Hardening
**Goal**: Existing conversation history is preserved in AgentDB and retrieval uses vector similarity
**Depends on**: Phase 1
**Requirements**: MEM-02, MEM-03, MEM-06
**Success Criteria** (what must be TRUE):
  1. All existing FileMemoryManager JSON data is imported into AgentDB with zero data loss (record counts match, content verified)
  2. Conversation retrieval returns semantically similar results via HNSW vector search (not TF-IDF)
  3. Concurrent HNSW writes from memory and learning systems do not corrupt the index (mutex serializes writes)
**Plans:** 3 plans
Plans:
- [x] 02-01-PLAN.md — HNSW write mutex + semantic-first retrieval routing in AgentDBAdapter
- [x] 02-02-PLAN.md — FileMemoryManager-to-AgentDB migration with idempotency, validation, and bootstrap wiring
- [x] 02-03-PLAN.md — Gap closure: wrap 3 unprotected HNSW remove() calls with writeMutex (MEM-06)

### Phase 3: Auto-Tiering & Embedding Infrastructure
**Goal**: Memory entries auto-promote/demote across tiers and the learning pipeline can generate embeddings for instincts
**Depends on**: Phase 2
**Requirements**: MEM-04, LRN-03, LRN-04, LRN-07
**Success Criteria** (what must be TRUE):
  1. Memory entries move between Working (hot), Ephemeral (warm), and Persistent (cold) tiers based on access patterns without manual intervention
  2. Every new instinct stored in the learning pipeline has an embedding vector populated in the instincts table
  3. All SQLite databases use consistent pragmas (WAL mode, appropriate cache_size, busy_timeout) preventing lock contention
  4. CachedEmbeddingProvider is wired to the learning pipeline and generates embeddings for instinct HNSW indexing
**Plans:** 3/3 plans executed
Plans:
- [x] 03-01-PLAN.md — SQLite pragma standardization with centralized helper (16/16/8/2 MB cache, 5s busy_timeout)
- [x] 03-02-PLAN.md — Async embedding queue + CachedEmbeddingProvider wiring from RAG to learning pipeline
- [x] 03-03-PLAN.md — Auto-tiering sweep with promotion/demotion logic, config knobs, and bootstrap wiring

### Phase 4: Event-Driven Learning
**Goal**: The agent learns immediately from tool outcomes instead of waiting for a 5-minute batch timer
**Depends on**: Phase 3
**Requirements**: LRN-01, LRN-02, LRN-05, LRN-06
**Success Criteria** (what must be TRUE):
  1. When a tool succeeds or fails, a learning event fires and the corresponding pattern is stored within the same execution cycle (no batch delay)
  2. Confidence scores update immediately from real tool outcomes (not deferred to next batch)
  3. An event bus decouples the orchestrator, learning pipeline, and memory subsystems (no direct cross-references)
  4. Multiple rapid tool results do not cause lost updates or SQLite lock errors (serial async queue handles ordering)
**Plans:** 2 plans
Plans:
- [x] 04-01-PLAN.md — TypedEventBus + LearningQueue infrastructure (event bus with typed interfaces, serial async queue)
- [x] 04-02-PLAN.md — Wire event-driven learning (orchestrator emission, pipeline subscription, confidence attribution, bootstrap wiring)

### Phase 5: Metrics Instrumentation
**Goal**: The agent's performance is measurable through objective metrics
**Depends on**: Phase 4
**Requirements**: EVAL-01, EVAL-02, EVAL-03
**Success Criteria** (what must be TRUE):
  1. Task completion rate (success/failure/partial) is tracked per session and queryable
  2. Iterations per task (number of PAOR cycles to completion) is recorded for every task
  3. Pattern reuse rate (how often instincts influence the planning phase) is tracked and queryable
**Plans:** 2 plans
Plans:
- [x] 05-01-PLAN.md — MetricsStorage + MetricsRecorder + InstinctRetriever modification + orchestrator instrumentation + bootstrap wiring
- [x] 05-02-PLAN.md — Dashboard /api/agent-metrics endpoint + CLI 'strata-brain metrics' command

### Phase 6: Bayesian Confidence System
**Goal**: Pattern confidence reflects real-world outcomes and the system self-curates its instinct library
**Depends on**: Phase 5
**Requirements**: EVAL-04, EVAL-05, EVAL-06, EVAL-07
**Success Criteria** (what must be TRUE):
  1. Confidence updates use Bayesian Beta distribution from real tool outcomes, not LLM-only judgment
  2. Patterns with confidence below 0.3 are automatically deprecated after a cooling period (not immediately)
  3. Patterns with confidence above 0.95 are automatically promoted to permanent status
  4. New patterns start at a maximum confidence of 0.5 (not 0.8), preventing premature promotion before sufficient observations
**Plans:** 2/3 plans executed
Plans:
- [ ] 06-01-PLAN.md — Types, config, schema migration, event bus extensions, ConfidenceScorer pure Beta posterior refactor
- [ ] 06-02-PLAN.md — Cooling/promotion state machine in pipeline, lifecycle events, appliedInstinctIds orchestrator wiring
- [ ] 06-03-PLAN.md — InstinctRetriever filtering/boost, CLI lifecycle section, dashboard lifecycle stats

### Phase 7: Recursive Goal Decomposition
**Goal**: The agent can break complex tasks into sub-goals mid-execution with explicit dependency ordering
**Depends on**: Phase 4
**Requirements**: GOAL-01, GOAL-02, GOAL-04, GOAL-05
**Success Criteria** (what must be TRUE):
  1. When a subtask reveals unexpected complexity during execution, the orchestrator decomposes it further into sub-goals (not only at task start)
  2. Sub-goals form a directed acyclic graph with explicit dependency edges (not a flat list)
  3. Decomposition depth is hard-capped at 3 levels to prevent runaway recursion
  4. Circular dependencies between sub-goals are detected and rejected before execution begins
**Plans**: TBD

### Phase 8: Goal Progress & Execution
**Goal**: Sub-goals execute in correct dependency order with visible progress at every level
**Depends on**: Phase 7
**Requirements**: GOAL-03, GOAL-06
**Success Criteria** (what must be TRUE):
  1. Progress is tracked at each decomposition level with completion percentage visible to the orchestrator
  2. Sub-goals execute in topological order respecting dependency edges (a sub-goal never starts before its dependencies complete)
**Plans**: TBD

### Phase 9: Tool Chain Synthesis
**Goal**: The agent detects, stores, and can execute recurring tool sequences as composite operations
**Depends on**: Phase 6
**Requirements**: TOOL-01, TOOL-02, TOOL-03, TOOL-04, TOOL-05
**Success Criteria** (what must be TRUE):
  1. Tool sequences that recur 3+ times with >80% success rate are automatically detected from trajectory data
  2. Detected tool chains are stored as instincts with chain metadata (tool names, parameter mappings, success rate)
  3. Stored tool chains are registered as composite ITool implementations in the tool registry at runtime
  4. Composite tools execute their chain sequentially, passing each step's output as input to the next
  5. Tool chain validation confirms all referenced tools exist before registration (invalid chains are rejected)
**Plans**: TBD

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. AgentDB Activation | 2/2 | Complete | 2026-03-06 |
| 2. Memory Migration & HNSW Hardening | 3/3 | Complete | 2026-03-06 |
| 3. Auto-Tiering & Embedding Infrastructure | 3/3 | Complete | 2026-03-06 |
| 4. Event-Driven Learning | 2/2 | Complete | 2026-03-06 |
| 5. Metrics Instrumentation | 2/2 | Complete | 2026-03-07 |
| 6. Bayesian Confidence System | 2/3 | In Progress|  |
| 7. Recursive Goal Decomposition | 0/? | Not started | - |
| 8. Goal Progress & Execution | 0/? | Not started | - |
| 9. Tool Chain Synthesis | 0/? | Not started | - |

## Coverage Map

| Requirement | Phase | Category |
|-------------|-------|----------|
| MEM-01 | Phase 1 | Real Memory |
| MEM-05 | Phase 1 | Real Memory |
| MEM-07 | Phase 1 | Real Memory |
| MEM-02 | Phase 2 | Real Memory |
| MEM-03 | Phase 2 | Real Memory |
| MEM-06 | Phase 2 | Real Memory |
| MEM-04 | Phase 3 | Real Memory |
| LRN-03 | Phase 3 | Real-Time Learning |
| LRN-04 | Phase 3 | Real-Time Learning |
| LRN-07 | Phase 3 | Real-Time Learning |
| LRN-01 | Phase 4 | Real-Time Learning |
| LRN-02 | Phase 4 | Real-Time Learning |
| LRN-05 | Phase 4 | Real-Time Learning |
| LRN-06 | Phase 4 | Real-Time Learning |
| EVAL-01 | Phase 5 | Self-Evaluation |
| EVAL-02 | Phase 5 | Self-Evaluation |
| EVAL-03 | Phase 5 | Self-Evaluation |
| EVAL-04 | Phase 6 | Self-Evaluation |
| EVAL-05 | Phase 6 | Self-Evaluation |
| EVAL-06 | Phase 6 | Self-Evaluation |
| EVAL-07 | Phase 6 | Self-Evaluation |
| GOAL-01 | Phase 7 | Recursive Goals |
| GOAL-02 | Phase 7 | Recursive Goals |
| GOAL-04 | Phase 7 | Recursive Goals |
| GOAL-05 | Phase 7 | Recursive Goals |
| GOAL-03 | Phase 8 | Recursive Goals |
| GOAL-06 | Phase 8 | Recursive Goals |
| TOOL-01 | Phase 9 | Tool Synthesis |
| TOOL-02 | Phase 9 | Tool Synthesis |
| TOOL-03 | Phase 9 | Tool Synthesis |
| TOOL-04 | Phase 9 | Tool Synthesis |
| TOOL-05 | Phase 9 | Tool Synthesis |

**Mapped: 32/32 -- No orphans**

## Dependency Graph

```
Phase 1 (AgentDB Activation)
  └── Phase 2 (Migration & HNSW Hardening)
        └── Phase 3 (Auto-Tiering & Embedding Infrastructure)
              └── Phase 4 (Event-Driven Learning)
                    ├── Phase 5 (Metrics Instrumentation)
                    │     └── Phase 6 (Bayesian Confidence System)
                    │           └── Phase 9 (Tool Chain Synthesis)
                    └── Phase 7 (Recursive Goal Decomposition)
                          └── Phase 8 (Goal Progress & Execution)
```

---
*Roadmap created: 2026-03-06*
*Last updated: 2026-03-07 (Phase 6 planned)*
