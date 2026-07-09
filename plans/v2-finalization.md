# Agent Core v2 — Finalization Master Plan (soak-driven, 2026-06-22)

Consolidates 5 parallel audits + the overnight soak fixes into one prioritized, gated execution plan to finish the v2 product. Each increment keeps the mandatory gate: **tsc=0 + eslint=0 + full vitest suite green + review trio (correctness/security/simplify, ALL findings fixed) + merge + CI green.** Reviews at END of increment. Never push broken code.

Written against commit `bbd2baf` (main). The v2 routes are soak-gated/default-off (`AGENT_CORE_FLAG_SET=v2-all-routes+full-control-plane`), so all v2-path bugs bite **on flip**, not in production today — but they are the flip-blockers.

---

## STEP-5 DELETION STATUS (2026-07-09, IN PROGRESS — working tree)
FLIP shipped (`a3de7d1`) + parity-adds (`5b35062`) + CI stabilization (`eaad4c6`) all on main/CI-green.
**Step-5 v1 deletion (this tree, uncommitted):** orchestrator.ts −3,046 (runWorkerTask+runBackgroundTask+runAgentLoop+10 loop-only helpers+branch flatten+unused sweep); v1-agent-runner.ts+test DELETED (toWorkerRunResult→agent-runner.ts, legacy branch dropped); runner-factory = V2-always (hooks REQUIRED, descriptive throw); flags.ts collapsed to the 3 v2 sets + DEPRECATED-id alias (all-v1/v1-driver+… resolve to production default, no boot crash); IOrchestrator re-cut to the runner-seam hooks; delegation probe re-pointed (createAgentCorePort); PARITY KEEPS: goal-tree upsert moved INTO the decomposition helper, v2 run collector wired (verifier/review projection). TESTS: 74+1 logger mocks +getLoggerSafe; integration.test/flags.test/factory.test/phase3 retargeted to v2 semantics (plan-first call #1); phase1a/1b/1c rollout-era files deleted. IN-FLIGHT: 3 workflow agents retargeting orchestrator.test.ts (28 fails), orchestrator-integration+bootstrap-supervisor, background-executor+delegation+unified+parallel-tools. THEN: full suite → trio review → README/CHANGELOG → commit+push.
FOLLOW-UPS flagged: AdaptiveLoopDetector was v1-only (v2 loop protection = controlLoopTracker+FailureLedger; re-wire the fingerprint detector = follow-up); STREAMING_ENABLED no longer gates the engine (v2 streams by provider capability); v1 degraded/critical health-status disclosure belongs at the spine failure-gate seam.

## Cross-cutting root causes (most findings trace to these)
- **(A) v2 moved teardown from v1's `finally` to straight-line code after `break epochLoop`** → leaks + skipped writeback on any throw. (v2 robustness P1 #2/#3)
- **(B) the spine's RunClock CallScope + external signal are never wired to the gateway** → cancel misclassification + streaming false-abort. (v2 robustness P1 #1/#4)
- **(C) the monitor is conversation-scoped, not task-scoped + the agent loop never drives goal-node status** → DAG static + new-request view clobber. (monitor BUG#1/#5)
- **(D) embedding sub-steps aren't isolated from the lexical path** → a broken/empty vector store pollutes BM25 (vault) and v2 drops instinct attribution (learning).

---

## PHASE 0 — DONE (overnight, on main, CI green)
- ✅ **Background livelock** (`bbc6e2b`): unified the FailureLedger health tracker with the spine's in createAgentCorePort → rules 5/7/retry live again. D2 regression test.
- ✅ **H2 decompose idempotency** (`bbd2baf`): per-run `goalsDecomposed` guard → proactive decompose once/run → stops the DAG/Kanban spray.
- ✅ **H1 (REPLAN loop)** audited → BOUNDED by the control-loop-tracker (no fix needed).

---

## PHASE 1 — v2 P1 robustness (HIGHEST severity; flip-blockers). ✅ DONE 2026-06-22 (each gated + trio-clean + CI): 1a `4a3cf94`, 1b `7af4ba2`, 1c `ce32c11`. All in v2-agent-runner.ts + the port.
**1a. `runInner` has no try/finally → RunClock timer + event-bus sink leak, AND journal-snapshot writeback skipped on any throw (silent multi-turn corruption).** [root cause A]
- v1 disposes + writes back in `finally` (orchestrator.ts:4645-4666 / 6217-6236). v2's `dispose()`+`bus.close()`+`persistTerminal` are straight-line after the loop (v2-agent-runner.ts:587-593), reachable only via `break epochLoop`. Every awaited port call (setupRun:220, prepareIteration:314, executeTools:529, persistTerminal:587, …) is unguarded.
- Symptom: a throw leaks the armed `taskHardTimer` (retains the whole run graph; fires later on an ended run) + an undrained BoundedSink; and skips `session.lastJournalSnapshot` writeback → turn N+1 reads a stale snapshot (orchestrator.ts:8622).
- FIX: wrap the epoch loop + terminal in `try { … } finally { runClock.dispose(); await bus.close(); /* + persistTerminal guarded by a `persisted` flag */ }` (dispose + close are idempotent). Fixes BOTH leaks + the corruption at once.

**1b. Mid-run `/cancel` is misclassified as a provider health failure.** [root cause B]
- silentStream rethrows the benign cancel (orchestrator.ts:6482/6555); the spine catches it as `{kind:"threw"}` (v2-agent-runner.ts:354) → verdict arm → `classifyAgentCoreFailure` runs `healthAdapter.recordFailure()` + returns `benign:false` (orchestrator.ts:8747-8762). The cancel reason lives on `io.externalSignal`, never on `runClock.taskToken`; `control-plane.openRun` ignores `parentClockView` (control-plane.ts:81). `AgentRunResult.cancelReason` (v2-agent-runner.ts:595) comes back `undefined`; `recordMetricEnd` logs the cancelled run as COMPLETE.
- FIX: at run open, `externalSignal.addEventListener("abort", () => runClock.taskToken.cancel({kind:"user-cancel"}), {once:true})` so the gate sees the benign typed reason and short-circuits before recordFailure.

**1c. Spine CallScope orphaned on the streaming path → premature `task-inactivity` / `provider-stall`.** [root cause B]
- `gateway.call` passes `undefined` for the runClock slot (model-gateway.ts:187); the spine never calls `call.touch()`/`firstTokenSeen()`. `CallScopeImpl.leave()` commits `now()-lastActivityAt` as silent ms with `lastActivityAt` frozen (run-clock.ts:146) → every v2 streaming call commits its FULL wall-clock as silent ms → a long-but-productive run (>10min wall-clock) is killed with `task-inactivity` (failure-ledger.ts:128). v1 keeps it ~0 via `touch()`.
- FIX: thread the live `call` scope through `ModelCallRequest` → forward as silentStream's 8th arg (reuse the proven v1 flag-ON re-arm + signal threading), OR drive `call.firstTokenSeen()/touch()` from the gateway's chunk `observe` callback. MUST land before soaking the v2 streaming route.

---

## PHASE 2 — v2 faithfulness gaps (flip-blockers; user-visible). orchestrator.ts + spine.
**STATUS: ✅ COMPLETE 2026-06-22 — GAP1 `34198f6` (per-turn instinct attribution, closes the v2 self-learning loop; SIBLING A trajectory-credit reverted → follow-up #22), GAP3 `3db5f3a` (epoch-rollover side effects via port.onEpochRollover), GAP4 `04a018c` (reason-aware finalText, no false "Task completed."; cosmetic follow-up #23). Each gated + trio-clean + CI. ⇒ PHASE 1 + PHASE 2 DONE = ALL v2 FLIP-BLOCKERS SHIPPED; the cutover is unblocked (pending the user's re-soak). Phases 3-6 are polish/features, NOT flip-blockers.**
**2a. GAP1 [HIGH] — v2 drops interactive instinct attribution → self-learning OPEN-LOOP on v2.**
- setupAgentCoreRun retrieves insights (orchestrator.ts:8596) but discards `matchedInstinctIds`; startTask gets `instinctIds:[]` (:8643); every v2 `tool:result` carries `appliedInstinctIds:[]` → learning-pipeline.ts:333 confidence reinforcement is a no-op.
- FIX: capture `insightResult.matchedInstinctIds` → `currentSessionInstinctIds.set` + `propagateInstinctIdsToChannel` + real `instinctIds` to startTask + CLEAR on v2 teardown (symmetric to v1 finally :6232, co-locate in the Phase-1a finally).
- SIBLING (MED, v1+v2): `TaskPlanner.endTask`→`recordTrajectory` never passes `appliedInstinctIds` (task-planner.ts:184) → trajectory credit empty on both. Thread the session IDs in.
- SIBLING (MED, v2 background): learning-bridge.ts:25 emits impoverished `tool:result` (input:{},output:"",no appliedInstinctIds) → background learning degrades if worker flipped.

**2b. GAP3 [MED] — v2 background epoch-rollover drops v1 side effects.**
- v1 end-of-epoch (orchestrator.ts:4586-4622): recordPhaseOutcome + persistExecutionMemory + taskPlanner.resetBudgetWindow + loop-detector amnesty. v2 rollover is a bare `epoch++` (v2-agent-runner.ts:577-582).
- FIX: add a `port.onEpochRollover(continued)` hook the spine calls between epochs.

**2c. GAP4 [MED] — v2 worker/background finalText falls back to "Task completed." on unhappy-path terminals.** (= chat audit 2c)
- synthesizeFinal (orchestrator.ts:8388) is a pure read-back of the last visible ASSISTANT message; verdict-stop terminals that bypass dispatch leave none → generic string. Also breaks on non-string/structured content.
- FIX: fall back to the spine-accumulated terminalReason/text; handle non-string content before the generic string.

**2d. P2 — v2 worker/supervisor-node ignores the provider pin (`assignedProvider`/`assignedModel`).**
- Threaded into AgentRunSetupInput (v2-agent-runner.ts:766) then dropped; setupAgentCoreRun always uses the identity default (orchestrator.ts:8551) + `executionStrategy:undefined` (:8679). Symptom: a supervisor pinning a vision model for an image subtask is ignored → the vision gate runs on the wrong provider → image downgraded to text. v1 warns; v2 is silent.
- FIX: replicate orchestrator.ts:3378-3382 in setupAgentCoreRun (resolve pinned provider as fallbackProvider + pass a fixedExecutionStrategy through prepareIteration).

**2e. P3 — Budget-exceeded checkpoint stores `used:0`/`budget:~0`.** Display-only.
- budgetCheckpoint() hardcodes used:0 + budget:remainingOutputTokens() (~0 at the stop) (v2-agent-runner.ts:781). FIX: thread the live cumulative output + the enforced cap.

---

## PHASE 3 — Vault embedding-optional (user requirement: Obsidian-like vault must work without embeddings). [root cause D] v1/v2-shared.
**3a. [PRIMARY] EmbeddingAdapter.search has no try/catch + the in-memory vector store is broken.**
- The index is FULL (10175 chunks, FTS built); the vault "seems unused" because (1) the bootstrap in-memory vector store (bootstrap.ts:718-728) `search()` IGNORES the query vector (returns slice(0,k) score:1 = arbitrary chunks) + isn't persisted → via rrfFuse it POLLUTES the correct BM25 ranking; (2) EmbeddingAdapter.search (embedding-adapter.ts:148) has no try/catch → a real provider (Ollama) down → query() rejects → buildVaultProjectContext drops the whole vault (FTS included).
- FIX: (A.1) try/catch in EmbeddingAdapter.search → return [] on failure/empty; (A.2) add a `semantic` capability flag → skip embed/HNSW entirely when no real vector backend; (B) fix or disable the broken in-memory search (real cosine scan OR semantic:false); (C) persist vectors or stop writing dangling vault_embeddings rows; (D) log dropped allSettled rejections (strada-knowledge.ts:462).
- Order: A.1 → B+A.2 → C/D. After A+B the vault runs pure-lexical (FTS/BM25 + wikilinks/PPR), embeddings only enhance.

---

## PHASE 4 — Monitor task-scoped + live (BUG#1 + BUG#5; pre-existing, v1/v2-shared). [root cause C] backend + web-portal.
**STATUS: P0 ✅ `317614f` — removed the start-of-run `monitor:clear` board-clobber (BUG#5 override fixed; prior cards now linger instead of being wiped) + `buildAlignedDagTree` hardens the supervisor dag_init↔task_update id-alignment (the audit's id-mismatch hypothesis was wrong — buildVisibleGoalTree already preserves ids; this makes it robust). Backend-only, trio-clean. NEXT: P1 (task-scope the monitor — backend MonitorLifecycle keyed by taskRunId not conversationScope + decompose re-root as dag_restructure + per-root replay snapshot in channel.ts; FRONTEND dagsByRoot multi-root store + tag tasks by rootId — the FULL BUG#5 fix + segregates the lingering cards into active/done). Then P2 (live plan-step DAG at the shared executeToolCalls/bus seam — the FULL BUG#1 live-update fix for the non-supervisor path, where the loop emits no per-node status today). P1 is backend+frontend, Medium-High; P2 Medium.**
**4a. P0 — remove/scope the view clobber + fix the supervisor DAG id-mismatch.**
- supervisor-brain.ts:275 `monitor:clear` wipes the whole board on every run (worst clobber); the per-node `task_update` (decomposedGoalTree ids) ≠ the `dag_init` payload (visibleGoalTree ids) → DAG node patch misses while Kanban updates. FIX: remove/scope monitor:clear; guarantee the dag_init payload + the status stream share node ids.

**4b. P1 — task-scope the monitor.**
- Backend: key MonitorLifecycle by `taskRunId` not conversationScope; re-root decompose as `dag_restructure` (not a fresh dag_init); per-root replay snapshot (channel.ts:566). Frontend: `dagsByRoot` multi-root store (monitor-store.ts) so a new task doesn't replace the prior task's view; tag tasks by rootId.

**4c. P2 — live DAG during execution.**
- The interactive loop emits no per-node status (GoalExecutor.executeTree is dead code). FIX: model the loop's plan-steps as the live DAG (emit dag_init of plan-steps + task_update per step) at the SHARED executeToolCalls/bus seam (both runners reach it — the v2 runner emits no monitor events today).

---

## PHASE 5 — Chat/UX bugs + high-leverage polish.
**5a. BUG#7 [data-loss] — background result-delivery drops the answer.**
- (2a) inactivity watchdog abort (background-executor.ts:728) → terminal branches early-return on `signal.aborted` (:1018/1036/1057/1082) → no complete/fail/block → no chat message; task stuck "executing." FIX: emit fail/block with a "no progress" message before the abort-return (distinguish from the intentionally-silent external /cancel).
- (2b) no offline delivery — sendToClient only sends to a live socket (channel.ts:600); closed tab → answer lost. FIX: replay/offline queue for terminal results (already persisted on the Task).

**5b. [HIGHEST-leverage polish] route notices/errors through `sendSystemMessage`.**
- Queue/burst notices, progress summaries, error/resilience messages all emit `type:"text"` → indistinguishable from real answers. A distinct system-pill already exists (ChatMessage.tsx:176). FIX: route them through sendSystemMessage. Single biggest clarity win.

**5c. polish — blocked/partial visual (2e), stream_update sequence number (5a, dropped-frame heal), per-task chat indicator (3c/5c).**

---

## PHASE 6 — Features (the user's explicit asks; build after the bugs).
**6a. `/run` gated shell command from chat.**
- Reuse ShellExecTool (guards exist) + requestWriteConfirmation **unconditionally** (NOT dmPolicy — it skips under autonomous mode). Add `/run`(+TR) to command-detector.ts:13 + handleRun to command-handler.ts:141 (bypasses task-submit, works mid-task); inject projectPath; surface via sendMarkdown.
**6b. one-click runnable suggestions.**
- Add `actions?: {label, command}[]` to the markdown/stream_end protocol (web-portal/src/types/messages.ts) + a ChatMessage.tsx renderer → round-trips to the /run confirm flow.

---

## Execution sequence (recommended)
Phase 1 (P1 robustness — most severe, the try/finally + 2 wirings) → Phase 2 (faithfulness, esp. GAP1 self-learning) → Phase 3 (vault) → Phase 4 (monitor) → Phase 5 (chat bugs + the sendSystemMessage polish) → Phase 6 (features). Then: re-soak → flip default to v2 → delete v1 → relocate engine. Each increment its own commit + full gate. Phases 1–2 are the hard flip-blockers; 3–5 are the "brilliant product" polish the user is after; 6 is net-new capability.

## NOT bugs / cleared (don't chase)
Port lifecycle / shared health tracker (the livelock fix is sound — one port per run), concurrent runs (serialized), interactive attachments (shared pre-branch append), context-trim, supervisor admission, lease release, max_tokens guard, learning is already embedding-optional (lexical PatternMatcher is first-class), ask_user + plan-review (work + polished). H1 REPLAN loop (bounded). GAP5 recordOutcome (daemon-only, pre-existing, low).
