# Strada.Brain Agent Core v2 — Incremental Migration Plan

> Strangler-fig, not big-bang. v1 is **over-grown, not rotten**: its components (PAOR state machine, reflection override, compaction, `silentStream`, budget/epoch math, `SupervisorDispatcher`, `ProviderRouter`, `FallbackChain`, memory) are sound and battle-hardened by named incidents (3h27m runaway, ~70min silent-stall, audits #6–#18, commit `515ac6e`). The liability is concentrated in three drift-prone seams: the two ~600-line driver shells, the fragmented control plane (5 timeouts + 3 failure counters), and the triplicated provider scorers. A rewrite would discard the incident hardening — the most expensive knowledge in the system. So we **wrap what is sound, replace only the three seams**, and let v1 + v2 coexist behind per-route flags consuming shared, unversioned dependencies until v2 has absorbed every path.
>
> Each phase ships value, de-risks the next, and is independently revertable. Every phase ends with the mandatory `/simplify` + `/security-review` + `code-review` gate, fixing **all** findings. The only irreversible step (deleting v1) happens last, after a clean soak.

---

## Status (2026-06-21)

**SHIPPED to main** — each behind a default-off flag (flag-off ≡ v1), through the mandatory review trio + CI green:
- **P-A** Control Plane (`src/agent-core/control/`: `RunClock` / `Budget` / `FailureLedger` / `CancelReason` / `Clock` / `policy`).
- **Phase 0** — the `AgentRunner` seam + `V1AgentRunner` pass-through (`src/agent-core/runner/`), rerouting worker / background / supervisor-node; `__workerCollector` superseded by `AgentRunResult`.
- **Phase 1** — the control plane wired into the live v1 loop one concern at a time: **1a** `FailureLedger` (one verdict arbiter over the kept `IterationHealthTracker`), **1b** `RunClock` per-call deadlines (replacing the scattered `AbortSignal.timeout` sites), **1c** the silence-accumulator task-inactivity verdict (bounds the delegation livelock), **1d** typed `CancelReason`. The full-control-plane `LEGAL_FLAG_SET` is now reachable.

**Deferred to Phase 2 (v2-driver concern):** the fallback-chain `RunClock` sites (**P-1b-2**) and the supervisor-path `CancelReason` adoption — both need a `CancelToken` threaded through the chain / supervisor pipeline (which has no per-run token today).

**Pending:** Phase 2 (unified `V2AgentRunner` + ModelGateway + EventBus, per-route rollout: worker → background → interactive), Phase 3 (scoring + capability unification), Phase 4 (v1 deletion — soak-gated, the only irreversible step), Phase 5 (streaming visibility).

---

## 0. Non-negotiable prerequisites (the critique's blocking findings)

These are **gates on starting Phase 1+**, not phases themselves. They exist because the adversarial critique proved the five sub-specs were three incompatible control planes, and that two of the proposed mechanisms had latent defects.

| Prereq | Why (critique) | Done-when |
|---|---|---|
| **P-A. Control Plane spec exists and is implemented in `src/agent-core/control/`** | BLOCKING: two specs each defined a *different* "source of truth" control plane and both claimed primacy. Nothing below is buildable until one exists. | `RunClock`, `Budget`, `FailureLedger`, and the single `CancelReason` union compile; unit-tested in isolation; no other module re-defines these types. |
| **P-B. One timer model chosen: per-scope `AbortSignal.timeout` + live re-arm** | The 1000ms sampler is a correctness regression for a stall-killer (90s fires at up to 91s; deadlines silent between samples; first-token race). | No `setInterval`-based deadline sampler exists anywhere in `agent-core`; deadlines are `AbortSignal.timeout` re-armed on config change. |
| **P-C. Silence ceiling = task-scope accumulated-silent-ms** | Per-call ceiling resets on every fallover → delegation livelock (ceiling never trips, task-inactivity keeps re-arming). | A test reproduces "flaky provider × 5-deep chain" and asserts the task stops via the accumulator, not via timeout luck. |
| **P-D. Fake-clock injection confirmed/added in the kept code** | The migration equivalence oracle and the incident regression tests need deterministic time; no spec confirmed the kept code supports it. | `silentStream`, `IterationHealthTracker`, and the new `RunClock` accept an injectable clock; incident scenarios run under fake time. |
| **P-E. Migration equivalence relation defined** | "byte-identical transcript" parity produces false diffs on every streamed turn (provider token timing is non-deterministic; v2 *changes* when tokens emit and *intentionally* differs at deadline boundaries). | A written `EquivalenceRelation`: **same tool-call sequence + same phase-transition sequence + same terminal status** (explicitly NOT byte-identical timing). Replay harness asserts this relation. |
| **P-F. Enumerated legal flag set + reject-at-boot** | Per-route × per-concern flags form a combinatorial matrix where shippable-but-untested configs are reachable. | Boot rejects any flag combination not in the enumerated `LEGAL_FLAG_SETS`; the matrix is closed, not free-form. |

---

## 1. Keep / Wrap / Replace ledger (binding contract for the whole migration)

Nothing outside the **REPLACE** column gets rewritten.

| v1 asset | Verdict | v2 treatment |
|---|---|---|
| `agent-state.ts` (PAOR, `VALID_TRANSITIONS`, `transitionPhase`) | **KEEP verbatim** | Imported unchanged. v2 adds no phases. |
| Reflection override (`validateReflectionDecision`, `MAX_REFLECTION_OVERRIDES=2`, `loopDetectionBlocked`) | **KEEP verbatim** | Called at the identical gauntlet point; only its *gating* moves into the verdict precedence. `loopDetectionBlocked` is load-bearing and frozen. |
| `prepareIteration`, `orchestrator-loop-utils.ts`, reflection-handler dispatch | **KEEP** | v2 is the consumer that finally calls them from *one* place instead of two; the `handleBg*`/`handleInteractive*` pairs collapse into single handlers parameterized by `IOStrategy`. |
| `silentStream` + dual watchdog + `isEmptyProviderResponse` + reasoning-content | **KEEP (FROZEN)** | Body untouched. The *only* sanctioned change is the **ModelGateway wrapper** adding `emit` + `call.touch()` around it (one wiring point, not the three competing ones the specs proposed). |
| `session-compaction.ts` | **KEEP** | Called per-iteration unchanged; consumes `inputTokensSeen` (observability). |
| Budget/epoch math, mutation-gated amnesty, output-token gating | **KEEP, de-dup** | Logic preserved; the duplicated input/output dual-counter written once. `cumulativeInputTokens` dropped unless a metric consumer exists. |
| `SupervisorDispatcher` (waves/`Semaphore`/`FailureBudget`/retry/skip-propagation) | **KEEP** | Best-engineered engine; untouched. Delegator *reuses* the wave engine. |
| `ProviderRouter` scoring + learning | **KEEP, promote to sole scorer** | Scorer math unchanged; only its callers change (§ Phase 3). |
| `ResultAggregator`, `ConsensusManager`, `TierRouter` | **KEEP** | Untouched. |
| `FallbackChainProvider`, provider interfaces, `ProviderHealthRegistry` | **KEEP** | Same `IAIProvider` dual-signal contract; signals now derive from one token tree. |
| Memory (`SessionManager`, AgentDB, `persistSessionToMemory`) | **KEEP, decouple persist** | Same methods/call points; terminal persist becomes fire-and-forget-with-join-barrier (off the hot exit path). |
| `StradaMcpRuntime` | **KEEP, demote to adapter** | Becomes the body of one `McpBridgeAdapter`; reconnect/dormant/capability logic reused, not rebuilt. |
| **`runAgentLoop` / `runBackgroundTask` driver bodies** | **REPLACE** | Collapsed into one `AgentLoop.run` parameterized by `IOStrategy`. |
| **`runWorkerTask` `__workerCollector`/`__workerMode` cast-through** | **REPLACE** | Eliminated by `AgentRunResult` structured return. |
| **5 timeout layers + 3 failure counters** | **REPLACE → unify** | One `RunClock`/`Budget` + one `FailureLedger` (Control Plane, P-A). |
| **3 provider-scoring engines** (`ProviderAssigner`, `scoreDelegationCandidate`) | **REPLACE → route to `ProviderRouter`** | Shadow-compare before flip. |
| Token-stream discarded in `silentStream`; web `stream_*` never connected | **REPLACE → ModelGateway emits `model.delta` → web sink** | The seam v1 never connected. |
| Delegation `maxDepth>1` dead config + fabricated `estimateDelegationCost` | **REPLACE (low priority)** | Real `maxDepth` threading; measured `UsageDelta`. |
| EventBus durable replay (NDJSON/SQLite/WAL) | **DEFER (out of this migration)** | In-memory ring buffer only; durable replay is a separate post-migration feature. |
| Scope tree levels 3–4 (tool, model-call split) | **DEFER** | Two levels (task, call) for v2; split added only on a real need. |
| Planner triage LLM call | **OFF BY DEFAULT** | Deterministic heuristic gate; triage opt-in only. |

---

## 2. The strangler boundary

**The boundary is the loop driver.** The trunk we cut is v1's two driver bodies. Everything they *call* (helpers, state machine, compaction, streaming, providers, memory) becomes a stable v2 dependency, unchanged. Everything that *calls them* (`handleMessage`, `background-executor`, supervisor node-bridge, delegation) is rerouted one caller at a time through the `AgentRunner` façade.

`AgentRunner` is the single entry both engines implement:
- **`V1AgentRunner`** — a thin pass-through adapter over the existing three v1 entry methods, mapping `IOStrategy` onto their closures. Ships in Phase 0; zero behavioral change.
- **`V2AgentRunner`** — the unified strategy-parameterized driver (ARCHITECTURE §4). Introduced Phase 2, selected per-route by flag.

Shared dependencies are **version-agnostic**: because V1 and V2 consume the *same* kept helpers/providers/memory through unchanged interfaces, there is no "v1 memory vs v2 memory" duplication — only the *driver* and the *control plane* have two implementations, and only transiently. `RunClock`/`FailureLedger` are the bridge that makes the swap safe: in Phase 1 they run *inside* v1; in Phase 2 the same instances run inside V2. They are never duplicated.

---

## 3. Phase list (ordered, each shippable, each de-risking)

> **Acceptance gate on every early phase (B3 / critique fix #11): net-zero new lines in `orchestrator.ts`.** All v2 code lands in `src/agent-core/`. Without this, Phases 0–2 would bloat the very 7167-line file they exist to drain. CI asserts `orchestrator.ts` line count is non-increasing through Phase 3.

### Phase 0 — Install the seam (zero behavior change)
- Define `AgentRunner`, `IOStrategy`, `AgentRunRequest`, `AgentRunResult` in `src/agent-core/`.
- Implement `V1AgentRunner` as a pass-through over existing v1 entry methods.
- Reroute `handleMessage`, `background-executor`, supervisor node-bridge, delegation through `runner.run(...)`.
- **v1 disposition:** keep all three driver bodies untouched; wrap, don't touch.
- **Coexistence:** only `V1AgentRunner` exists; nothing to coexist yet.
- **Ships:** nothing visible changes; the seam exists. **De-risks:** proves `IOStrategy` captures every real I/O divergence *before* any logic moves.
- **Verify gate:** full existing suite green; equivalence-relation replay (P-E) green on a recorded corpus (interactive + background + worker).
- **Rollback:** revert the rerouting commit; v1 entry methods were never modified.

### Phase 1 — Control Plane, behind the seam (behavior-preserving consolidation)
- Land the Control Plane (P-A) and hand `RunClock` + `Budget` + `FailureLedger` *into the existing v1 loop* via `V1AgentRunner`, replacing scattered mechanisms **one at a time**, each behind a sub-flag defaulting **off**:
  - **1a** — `FailureLedger` wrapping `IterationHealthTracker` + breaker (lowest risk, shared-state only). **Audit the `backoffIndex`/`consecutiveProviderFailures` reset-timing delta (E2) as a real behavioral change**, with a dedicated test asserting backoff timing pre/post merge — not assumed-equivalent.
  - **1b** — `RunClock.enterCall`/first-response replacing per-call `AbortSignal.timeout` sites (orchestrator L4505, L3185, fallback-chain L263/L339 including the orphan 15s probe timeout).
  - **1c** — task-inactivity as the silence accumulator (P-C) + the single derived ratio clamp.
  - **1d** — typed `CancelReason` on aborts + supervisor-path adoption (the supervisor node joins the one fabric; its divergent abort strings are deleted).
- **v1 disposition:** loop body unchanged; it *consults* the new owners instead of its own scattered timers/counters.
- **Coexistence:** v1 driver + new control plane, each concern flag-gated; flip any flag off to restore the exact v1 path (zero rollback cost, no redeploy of logic).
- **Ships:** identical behavior with one owner per concern; config-override clamping warnings become observable. **De-risks:** the highest-coherence-risk area is consolidated *while v1's proven loop still runs it*.
- **Verify gate:** incident regression suite under fake clock (P-D) — 3h27m runaway and ~70min silent-stall assert termination at the *same bound* under the unified plane; control-plane invariant tests (clamp-and-warn on ordering violation; `FailureLedger.verdict()` matches legacy 3/5 thresholds; livelock test P-C).
- **Rollback:** per-concern flag flip; each sub-flag independently revertable.

### Phase 2 — Unify the driver (`V2AgentRunner`)
- Build the single strategy-parameterized loop (ARCHITECTURE §4) consuming the now-stable Control Plane and all KEEP helpers.
- Build **ModelGateway** as the one LLM entry point (the frozen-`silentStream` wrapper, the single `emit` wiring point) and the **EventBus** with live sinks + in-memory ring buffer (no durable replay).
- Eliminate `__workerCollector` via `AgentRunResult`.
- Flag `useV2Runner` **per-route**, default off. Rollout order by blast radius: **worker first** (smallest; structured-result consumer already wants it) → background → **interactive last** (most user-visible).
- **v1 disposition:** driver bodies still in-tree (dead once a route is fully on V2, deleted in Phase 4).
- **Coexistence:** per-route flag; a bad V2 behavior on one route never forces the others back. Same `RunClock`/`FailureLedger` instances now run inside V2.
- **Ships:** the orchestrator file *starts* shrinking only when bodies are deleted (Phase 4) — **this phase does not shrink `orchestrator.ts`; it adds V2 in `src/agent-core/` under the net-zero gate.** Live token streaming to the web portal becomes possible (gated, see Phase 5).
- **Verify gate:** equivalence-relation replay (P-E) per route before flipping that route's flag; heartbeat-invariant test (no path between wait-points skips `emit`, including tool-revive).
- **Rollback:** per-route flag flip back to `V1AgentRunner`.

### Phase 3 — Scoring + capability unification
- **3a — scoring:** route `ProviderAssigner` and delegation `auto` scoring through the one `ProviderRouter`; shadow-compare (log both rankings, no behavior change) on live traffic; flip when ranking-agreement exceeds threshold. Delete `scoreDelegationCandidate`.
- **3b — CapabilityRegistry:** introduce the registry wrapping `ToolRegistry`; demote `StradaMcpRuntime` to `McpBridgeAdapter`; route `executeAndTrackTools` through `guardExecute`; wire `advertise` into `prepareIteration` and `summarizePartial` into `finish()`. **Heartbeat-through-revive (P-C sibling, critique #4)** and **`classifyToolError` against `CancelReason` (critique #5)** are part of this phase's definition of done.
- **v1 disposition:** `ProviderAssigner` becomes a thin post-filter over `ProviderRouter` (vision filter, diversity cap, dependency affinity retained); `ToolMetadata.available` becomes a projection of `CapabilityState`.
- **Coexistence:** scoring behind a shadow→flip flag; capability behind `useCapabilityRegistry` (default off until 3b verified).
- **Ships:** one scorer (weight-drift impossible); `BLOCKED(needs:X)` + `PartialResultDigest` (the "couldn't do W, here's the fix" UX); graceful degradation when an optional capability is absent.
- **Verify gate:** shadow-ranking agreement threshold; capability tests (advertise-only-when-live; BLOCKED contract parseable by model + reflection + surfacer; `classifyToolError` does not cool a healthy capability on a tool-logic error; revive emits heartbeat).
- **Rollback:** flag flip per sub-concern.

### Phase 4 — Reclaim & decommission (the only irreversible step)
- After a defined **soak** with V2 default-on across all routes and **zero flag-flips**: delete `V1AgentRunner` and the now-dead `runAgentLoop`/`runBackgroundTask`/`runWorkerTask` bodies.
- Delete dead delegation `maxDepth>1` surface; replace `estimateDelegationCost` with real `AgentRunResult.usage`.
- Remove behind-flag dead branches; collapse the flag set.
- **v1 disposition:** deleted.
- **Coexistence:** ends here.
- **Ships:** `orchestrator.ts` drops toward target size; dead config gone. **This is where the file-shrink the architecture promised actually happens.**
- **Verify gate:** full suite + equivalence replay green with v1 code removed; line-count assertion now *decreasing*.
- **Rollback:** git revert of the deletion commits (the only step requiring code redeploy to undo) — gated on the clean soak precisely because it is the point of no return.

### Phase 5 — Streaming visibility (optional, off critical path)
- Wire `IOStrategy.visibleSink` through ModelGateway's non-empty `model.delta {channel:"answer"}` path for channels supporting `IChannelStreaming`, gated by `streamVisibleTokens`. Empty chunks remain liveness-only.
- **Ships:** live token-by-token web output. **Explicitly deferred** so the additive change to the frozen-`silentStream` wrapper never blocks the structural migration.
- **Verify gate:** web sink renders deltas; back-pressure coalescing under a slow client never throttles the agent.
- **Rollback:** flag flip.

### Deferred (separate feature specs, NOT in this migration)
- **Durable cross-restart EventBus replay** (NDJSON/SQLite/WAL) — designed against actual portal requirements, not asserted here.
- **Scope tree tool/model-call split** — added only if a real cancellation-granularity need materializes.
- **Unifying the three multi-step *entry points* into one policy** — orthogonal to strangling the driver; would expand blast radius.
- **Async memory persistence beyond the join-barrier** — a post-migration optimization, deliberately excluded so it can't destabilize the swap.

---

## 4. How v1 and v2 coexist (mechanics)

- **Flag granularity:** per-route (`interactive`/`background`/`worker`/`supervisor-node`) for the driver; per-concern sub-flags for the control plane; shadow→flip for scoring.
- **Enumerated legal set (P-F):** the cross product of flags is **not** free-form. `LEGAL_FLAG_SETS` enumerates the valid combinations (e.g. "all v1", "v1 driver + full control plane", "V2 worker only + full control plane", "V2 all routes + scoring + capability"); boot **rejects** anything else. Reversibility ≠ correctness-in-combination, so untested combinations are unreachable by construction.
- **Supervisor coexistence is free:** the node-bridge already calls the orchestrator with `supervisorMode:"off"`; it simply targets `runner.run(...)`. Supervisor itself is a KEEP with no v1/v2 fork.
- **Budget/ledger coexistence:** never duplicated — they are the bridge instances shared across the driver swap.

---

## 5. Verification gates (binding, per phase)

1. **Equivalence-relation replay (P-E):** recorded interactive/background/worker corpus replayed against v1 and the new path; assert **same tool-call sequence + same phase-transition sequence + same terminal status** (NOT byte-identical timing). The divergence surface is finite because every gauntlet step calls the *same* kept helper.
2. **Incident regression suite (under fake clock, P-D):** 3h27m runaway and ~70min silent-stall encoded as tests asserting termination at the same bound under the unified `RunClock`/`FailureLedger`; plus the P-C delegation-livelock test.
3. **Control-plane invariant tests:** clamp-and-warn on ordering-violating config; `FailureLedger.verdict()` matches legacy 3/5 thresholds; backoff-timing delta (E2) explicitly asserted, not assumed.
4. **Heartbeat-invariant test:** no path between wait-points skips `emit` — including tool-revive (a hung MCP reconnect must emit `heartbeat`).
5. **Shadow-scoring agreement (Phase 3):** ranking-agreement above threshold before flip.
6. **Capability tests (Phase 3):** advertise-only-when-live; BLOCKED parseability; `classifyToolError` conservatism (no healthy-capability cooldown on tool-logic errors).
7. **Mandatory review chain:** `/simplify` + `/security-review` + `code-review` at the end of every phase before push; fix **all** findings (standing project rule).
8. **Net-zero `orchestrator.ts` gate (Phases 0–3):** CI asserts the file's line count is non-increasing until Phase 4 deletion.
9. **Soak before deletion (Phase 4):** V2 default-on, all routes, zero flag-flips for a defined window before any v1 code is deleted.

---

## 6. Rollback summary

- **Phases 0–3:** every change behind a per-route or per-concern flag defaulting to the v1 path. Rollback = flip the flag; **no logic redeploy, no data migration** (state machine, memory, providers shared and unversioned).
- **Control-plane rollback is per-concern:** a regression in, say, the derived task-inactivity ratio reverts without touching the failure ledger.
- **Phase 4 (deletion) is the only irreversible step** and is gated on a clean soak. Until Phase 4, the v1 driver bodies remain in-tree and one flag away.
- **No point of no return before Phase 4.**

---

## 7. What this migration explicitly does NOT do

Does not refactor `silentStream`'s logic (only the gateway wrapper adds `emit`) · does not add PAOR phases or touch `VALID_TRANSITIONS` · does not change compaction stages/thresholds · does not rewrite `SupervisorDispatcher`/`ResultAggregator`/`ConsensusManager`/`ProviderRouter` math (only *who calls* the scorer) · does not unify the three multi-step *entry points* (named out-of-scope follow-up) · does not make memory persistence async beyond the join-barrier · does not build durable EventBus replay (deferred feature) · does not add a third/fourth scope level (two levels for v2).

---

## 8. Open questions for the user

1. **Control Plane shapes — confirm the pick.** The architecture adopts Spec 6's `RunBudget`/`FailureLedger` shapes (migration-realistic, *wrap* the kept `IterationHealthTracker`) with Spec 1's subtractive-`min()` carving as the internal derivation, and **drops Spec 1's 1000ms sampler** in favor of per-scope `AbortSignal.timeout`. Do you accept this resolution, or do you want the sampler retained for any reason (e.g. an external constraint I'm not aware of)?

2. **The single surviving ratio — relocate vs. truly eliminate.** `taskInactivity ≥ 2 × callStall` is v1's existing `Math.max(...)` clamp relocated to one place, not eliminated. Acceptable as "one owner," or do you want a design pass to remove the ratio entirely (would require deriving task-inactivity purely from call-stall × a structural factor, with no independent task-inactivity config knob)?

3. **Soak window length for Phase 4.** Deleting v1 is the only irreversible step. What soak duration / criteria do you want before the cut — calendar time (e.g. 2 weeks default-on), a number of clean production runs, or a manual sign-off?

4. **Scope-tree depth.** v2 ships two levels (task, call). The deferred tool/model-call split would let cancellation abort an in-flight model call without tearing down the enclosing tool. Do you have a near-term need for that granularity (e.g. very long tool batches), or is two-level fine to start?

5. **Durable replay priority.** EventBus durable cross-restart replay (background-run "watch it again", crash recovery) is deferred to a separate feature. Is that a near-term portal requirement that should be scheduled right after Phase 4, or genuinely later?

6. **`ask_user` in background = yield-as-blocked.** The architecture resolves background `ask_user` to the loop yielding an `AgentRunResult` status `"blocked"` (not blocking, not bus-auto-handled). Confirm this matches the desired UX, or specify the intended background-clarification behavior.

7. **Flag-set governance.** The legal flag combinations are enumerated and rejected-at-boot. Who owns adding a new legal combination (you, or can the implementer add them as rollout proceeds), and do you want the active flag-set surfaced in the portal/dashboard during migration?

---

## 9. Resolved decisions (owner deferred to engineering judgment; priority = a flawlessly-working system, bias to lowest regression risk)

**Approach LOCKED: strangler-fig.** It is the path that yields a flawless system: it replaces the three broken seams (driver, control plane, scorers) from scratch into the v2 architecture, but cannot regress the incident-hardening (3h27m runaway, ~70min stall, audits #6–#18) that a full from-scratch rewrite would re-derive and risk re-breaking. Every phase is flag-reversible and equivalence/incident-verified.

1. **Control Plane shapes — ACCEPTED.** Spec 6 `RunBudget`/`FailureLedger` shapes wrapping the kept `IterationHealthTracker`, with Spec 1 subtractive-`min()` carving as the internal derivation. The **1000ms sampler is dropped** (it was a stall-killer correctness regression); timer model = per-scope `AbortSignal.timeout` re-armed on config change.
2. **Surviving ratio — RELOCATE, not eliminate (now).** `taskInactivity ≥ 2×callStall` moves to one owner; a pass to derive it purely structurally (no independent knob) is a post-migration follow-up, not a migration blocker.
3. **Phase-4 soak — CONSERVATIVE.** V2 default-on across all routes with **zero flag-flips for ≥2 weeks** + a clean incident-regression run under fake clock, THEN explicit manual sign-off before deleting v1 (strictest gate on the only irreversible step).
4. **Scope depth — TWO LEVELS (task, call).** Tool/model-call split deferred until a concrete cancellation-granularity need appears.
5. **Durable replay — DEFER.** In-memory ring buffer for v2; durable cross-restart replay is a separate post-migration feature, scheduled only against a real portal requirement.
6. **Background `ask_user` — yield-as-`blocked` ACCEPTED.** The loop yields `AgentRunResult` status `"blocked"`; recoverable on resume.
7. **Flag governance — enumerated + rejected-at-boot.** New legal combinations added by the implementer as rollout proceeds; the active flag-set is surfaced in the dashboard during migration (observability is part of "flawless").

**Next step:** the prerequisites P-A..P-F, beginning with **P-A — the Control Plane** (`src/agent-core/control/`: `RunClock`, `Budget`, `FailureLedger`, `CancelReason`), the blocking foundation everything else imports. Then **Phase 0** (the `AgentRunner` seam, zero behavior change). Each phase ends with the mandatory `/simplify` + `/security-review` + `code-review` gate; fix all findings.
