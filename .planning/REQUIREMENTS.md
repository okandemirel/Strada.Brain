# Requirements: Strada.Brain Phase 2 — Agent Evolution (Level 3 → 4)

**Defined:** 2026-03-06
**Core Value:** The agent must reason, learn, and adapt autonomously — real memory, real-time learning, recursive goals, self-evaluation, and tool synthesis transform a chatbot wrapper into a genuine autonomous agent.

## v1 Requirements

Requirements for Level 4 release. Each maps to roadmap phases.

### Real Memory

- [x] **MEM-01**: AgentDB replaces FileMemoryManager as the memory backend in bootstrap
- [x] **MEM-02**: MemoryMigrator imports all existing FileMemoryManager JSON data into AgentDB SQLite without data loss
- [x] **MEM-03**: Conversation retrieval uses HNSW semantic search via AgentDB (vector similarity, not TF-IDF)
- [x] **MEM-04**: Memory entries auto-tier between Working (hot), Ephemeral (warm), and Persistent (cold) based on access patterns
- [x] **MEM-05**: AgentDB interface aligns with IMemoryManager contract (adapter if needed to bridge IUnifiedMemory)
- [x] **MEM-06**: HNSW write mutex prevents index corruption from concurrent writes across memory and learning systems
- [x] **MEM-07**: Unified memory config options added to Zod config schema (tier thresholds, auto-tiering toggle)

### Real-Time Learning

- [x] **LRN-01**: Learning pipeline uses event-driven triggers instead of 5-minute batch timer
- [x] **LRN-02**: Tool success/failure emits events that trigger immediate pattern storage
- [x] **LRN-03**: CachedEmbeddingProvider wired to learning pipeline for instinct HNSW embedding generation
- [x] **LRN-04**: Instinct embedding column populated on every pattern store operation
- [x] **LRN-05**: Confidence updates happen online from real tool outcomes (no batch delay)
- [x] **LRN-06**: Event bus decouples orchestrator, learning pipeline, and memory subsystems
- [x] **LRN-07**: SQLite pragma standardization (WAL mode, cache_size, busy_timeout) across all databases

### Recursive Goal Decomposition

- [ ] **GOAL-01**: Orchestrator can create sub-goals mid-execution (not only at task start)
- [ ] **GOAL-02**: Sub-goals form a DAG with explicit dependency edges (not flat list)
- [ ] **GOAL-03**: Progress tracked at each decomposition level with completion percentage
- [ ] **GOAL-04**: Maximum decomposition depth of 3 enforced to prevent runaway recursion
- [ ] **GOAL-05**: Cycle detection prevents circular sub-goal dependencies
- [ ] **GOAL-06**: Sub-goals execute respecting dependency ordering (topological sort)

### Self-Evaluation Metrics

- [x] **EVAL-01**: Task completion rate instrumented and tracked per session
- [x] **EVAL-02**: Iterations per task (tool calls to completion) instrumented
- [x] **EVAL-03**: Pattern reuse rate tracked (how often instincts influence planning)
- [x] **EVAL-04**: Bayesian confidence updates from real outcomes replace LLM-only judgment
- [ ] **EVAL-05**: Patterns with confidence < 0.3 auto-deprecated after cooling period
- [ ] **EVAL-06**: Patterns with confidence > 0.95 auto-promoted to permanent status
- [x] **EVAL-07**: Confidence threshold gap enforced (new patterns start at max 0.5, not 0.8) to prevent premature promotion

### Tool Synthesis

- [ ] **TOOL-01**: Recurring tool sequences (3+ occurrences, >80% success) detected from trajectory data
- [ ] **TOOL-02**: Detected tool chains stored as instincts with chain metadata
- [ ] **TOOL-03**: Stored tool chains registered as composite ITool implementations in tool registry at runtime
- [ ] **TOOL-04**: Composite tools execute their chain sequentially, passing output of each step as input to next
- [ ] **TOOL-05**: Tool chain validation ensures all referenced tools exist before registration

## v2 Requirements

Deferred to future release. Tracked but not in current roadmap.

### Memory Intelligence

- **MEM-V2-01**: Memory decay with configurable lambda (exp(-lambda * t))
- **MEM-V2-02**: Memory consolidation during idle time (merge duplicates, extract facts)
- **MEM-V2-03**: Importance-weighted retrieval (access frequency + recency + relevance)

### Advanced Learning

- **LRN-V2-01**: Confidence calibration curves from accumulated historical data
- **LRN-V2-02**: Cross-session learning transfer (patterns from one chat improve others)
- **LRN-V2-03**: Meta-learning (learning which learning strategies work best)

### Advanced Tool Synthesis

- **TOOL-V2-01**: Tool chain rollback on partial execution failure
- **TOOL-V2-02**: Parallel tool chain branches (not just sequential)
- **TOOL-V2-03**: Tool parameter inference from context

## Out of Scope

| Feature | Reason |
|---------|--------|
| Arbitrary code generation for tools | Security risk (vm2 deprecated with CVE-2026-22709, node:vm not a security mechanism) |
| Unlimited reflection loops | Cost explosion risk; bounded by existing PAOR cycle limits |
| Remember-everything memory | Retrieval degradation; 3-tier auto-tiering with eviction is the correct pattern |
| LLM-only quality judgment | Circular reasoning; Bayesian metrics from real outcomes replace this |
| New AI provider integrations | 12 providers already cover all needs |
| New channel integrations | 6 channels sufficient for current use |
| Graph database for memory | SQLite + HNSW already implemented in AgentDB; graph DB adds unnecessary complexity |
| RxJS for event system | Node.js EventEmitter is sufficient; RxJS adds 42KB+ for no benefit in this use case |
| Docker sandboxing for tool synthesis | Overkill for composing existing tools; only needed for arbitrary code execution (out of scope) |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| MEM-01 | Phase 1: AgentDB Activation | Complete |
| MEM-05 | Phase 1: AgentDB Activation | Complete |
| MEM-07 | Phase 1: AgentDB Activation | Complete |
| MEM-02 | Phase 2: Memory Migration & HNSW Hardening | Pending |
| MEM-03 | Phase 2: Memory Migration & HNSW Hardening | Complete |
| MEM-06 | Phase 2: Memory Migration & HNSW Hardening | Complete |
| MEM-04 | Phase 3: Auto-Tiering & Embedding Infrastructure | Complete |
| LRN-03 | Phase 3: Auto-Tiering & Embedding Infrastructure | Complete |
| LRN-04 | Phase 3: Auto-Tiering & Embedding Infrastructure | Complete |
| LRN-07 | Phase 3: Auto-Tiering & Embedding Infrastructure | Complete |
| LRN-01 | Phase 4: Event-Driven Learning | Complete |
| LRN-02 | Phase 4: Event-Driven Learning | Complete |
| LRN-05 | Phase 4: Event-Driven Learning | Complete |
| LRN-06 | Phase 4: Event-Driven Learning | Complete |
| EVAL-01 | Phase 5: Metrics Instrumentation | Complete |
| EVAL-02 | Phase 5: Metrics Instrumentation | Complete |
| EVAL-03 | Phase 5: Metrics Instrumentation | Complete |
| EVAL-04 | Phase 6: Bayesian Confidence System | Complete |
| EVAL-05 | Phase 6: Bayesian Confidence System | Pending |
| EVAL-06 | Phase 6: Bayesian Confidence System | Pending |
| EVAL-07 | Phase 6: Bayesian Confidence System | Complete |
| GOAL-01 | Phase 7: Recursive Goal Decomposition | Pending |
| GOAL-02 | Phase 7: Recursive Goal Decomposition | Pending |
| GOAL-04 | Phase 7: Recursive Goal Decomposition | Pending |
| GOAL-05 | Phase 7: Recursive Goal Decomposition | Pending |
| GOAL-03 | Phase 8: Goal Progress & Execution | Pending |
| GOAL-06 | Phase 8: Goal Progress & Execution | Pending |
| TOOL-01 | Phase 9: Tool Chain Synthesis | Pending |
| TOOL-02 | Phase 9: Tool Chain Synthesis | Pending |
| TOOL-03 | Phase 9: Tool Chain Synthesis | Pending |
| TOOL-04 | Phase 9: Tool Chain Synthesis | Pending |
| TOOL-05 | Phase 9: Tool Chain Synthesis | Pending |

**Coverage:**
- v1 requirements: 32 total
- Mapped to phases: 32
- Unmapped: 0

---
*Requirements defined: 2026-03-06*
*Last updated: 2026-03-07 after 05-02 execution (Phase 5 complete, all 3 EVAL query surfaces delivered)*
