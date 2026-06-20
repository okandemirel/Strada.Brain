# Strada.Brain Agent Core v2 — Architecture

> Status: synthesized v2 architecture. This document supersedes the five independent sub-specs (RunClock, AgentLoop, EventBus, CapabilityRegistry, Planner/Delegator) and the migration spec. It exists because the adversarial critique proved those five sketches described **three mutually incompatible control planes** drawn to incompatible blueprints. This document fixes that: it defines **one** control plane that every component imports, and reconciles every conflict the critique raised.
>
> The single highest-value decision recorded here: **there is exactly one owner of each cross-cutting concern — one clock, one event stream, one capability registry, one failure ledger, one cancel-reason union — and components are *clients* of those owners, never co-owners.** v1's core sin was multiple owners of the same concern coherent only by convention; v2 forecloses that by construction.

---

## 0. The synthesis problem this document solves

The five sub-specs were individually well-argued but written by different sessions. They each re-defined the same primitives with different names, shapes, and ownership trees:

- **Deadline owner** was specced five ways: `BudgetScope` tree (sampled, no timers) vs `Budget`/`Deadline` (per-node `AbortSignal.timeout`) vs opaque consumed `Deadline` vs `RunClock`/`RunClockView` vs `RunBudget` (derived hierarchy).
- **Timer model** was specced two contradictory ways: one 1000ms `setInterval` sampler vs a real OS timer per carve. The critique correctly showed these are opposed, and that the 1000ms sampler is a *correctness regression* for a stall-killing system (a 90s bound fires at up to 91s; deadlines are silent between samples).
- **Cancel-reason type** was defined four times with four disjoint variant sets that disagree on semantics (a `budget-exhausted` is a cancellation in one spec and a return value in another).
- **Failure owner** was specced four ways (`StopController` / `FailureHeadroom` / `FailureMonitor`+`FailureBudget` / `FailureLedger`).

This architecture **picks one of each** and makes the rest import it. The resolutions (all from the critique's fix list):

1. A **Control Plane** module (§2) is defined *first* and owns `RunClock`, `Budget`, `FailureLedger`, and the single `CancelReason` union. Every other component imports these; none re-defines them.
2. **One timer model**: per-scope `AbortSignal.timeout` with live re-arm-on-config-change. The 1000ms sampler is dropped (kills the granularity regression and the first-token race).
3. The silence ceiling is a **task-scope accumulated-silent-ms budget**, not a per-call re-armable counter (kills the delegation livelock the critique found).
4. **Heartbeat is wired through tool-revive** so a hung MCP reconnect can never be silent.
5. `classifyToolError` disambiguates via the typed `CancelReason` carried on the abort.
6. EventBus durable replay is cut to an **in-memory ring buffer**; the NDJSON/SQLite/WAL persistence subsystem is deferred to a separate post-migration feature.
7. The scope tree collapses to **two levels (task, call)** for v2; the tool/model-call split is deferred until a real cancellation-granularity need materializes. Planner triage LLM call is **off by default**.
8. `ask_user`-in-background resolves to **one owner** (the loop, via a yield).
9. A defined **equivalence relation** replaces "byte-identical transcript" parity, and fake-clock injection is a prerequisite.
10. The feature-flag matrix is constrained to an **enumerated legal set, rejected-at-boot**.
11. Acceptance gate: **net-zero new lines in `orchestrator.ts`** during the early phases — all v2 code lands in `src/agent-core/`.

---

## 1. The one-clock / one-stream / one-capability-registry model

v2 is organized around three singleton authorities and two thin engines that consult them. The mental model:

```
                          ┌──────────────────────────────────────────────┐
                          │              CONTROL PLANE (§2)                │
                          │   one owner per cross-cutting concern          │
                          │                                                │
   ┌──────────────┐       │   RunClock ── Budget ── FailureLedger          │
   │  AgentRunner │       │       │         │            │                 │
   │   façade     │──run──┼──▶ CancelToken (one CancelReason union) ───────┤
   └──────────────┘       │                                                │
          │               └──────────────────────────────────────────────┘
          │                      ▲          ▲          ▲          ▲
          ▼                      │ reads     │ reads    │ reads    │ reads
   ┌──────────────┐   advances   │           │          │          │
   │  AgentLoop   │── Step ───────┘           │          │          │
   │  (one driver)│      │                    │          │          │
   └──────────────┘      │ emits              │          │          │
          │              ▼                    │          │          │
          │       ┌──────────────┐            │          │          │
          │       │  ModelGateway│── calls ───┼──▶ provider (FallbackChain, KEEP)
          │       └──────┬───────┘            │          │          │
          │              │ emits AgentEvent    │          │          │
          ▼              ▼                    │          │          │
   ┌─────────────────────────────────────────┼──────────┼──────────┘
   │              EventBus (§5)               │          │
   │   one typed stream, many sinks           │          │
   │   (web · chat · ring-buffer observ.)     │          │
   └──────────────────────────────────────────┘          │
          │                                                │
          ▼                                                │
   ┌──────────────┐   advertise/guardExecute               │
   │ Capability   │◀───────────────────────────────────────┘
   │ Registry (§7)│   one owner of "which tools are live"
   └──────────────┘

   Planner (§8) — pure gate: single-loop vs decomposed
   Delegator (§8) — bounded fan-out; children are AgentLoop instances
                    sharing the SAME RunClock/Budget/CancelToken/EventBus
```

### 1.1 One clock

There is exactly **one** `RunClock` per run, created at run admission. It owns every wall-clock deadline as a *derived* hierarchy: a child deadline is always `min(requestedChild, parentRemaining)` — never independently configured. This subtractive-`min()` carving (the one genuinely good idea the critique singled out from Spec 1) makes the nesting invariant `attempt ⊂ call ⊂ task` **enforced by construction** instead of by hand-tuned cross-file ratios. Children (sub-agents) receive a **read-only view** of the same clock; they cannot extend the deadline. Fan-out does not multiply the deadline — N children share the parent's remaining wall-clock, which is what makes the multi-agent shape *bounded*.

Timers are **real `AbortSignal.timeout` per active scope, re-armed on config change** — not a sampler. There is no 1000ms tick. A `/token`-style live raise mutates the policy and the affected scope re-arms its timeout immediately (the live-re-read property the sampler was claimed to provide, achieved without the granularity regression).

### 1.2 One stream

Every observable thing the agent does — model tokens, tool boundaries, phase transitions, narratives, heartbeats, errors — is **one typed `AgentEvent`** published to **one `EventBus`**. Liveness and progress are the *same channel*: the watchdog observes the same event stream the UI observes. This is the heartbeat invariant — *the loop cannot advance, sleep, roll an epoch, or terminate without first emitting an event* — and it is the mechanism that kills silent runs by construction rather than by tuning timeout ratios. Visibility is a **sink decision, never an event field**: the web sink renders live tokens, the chat sink renders throttled summaries, the observability sink records everything, all from one neutral emission.

### 1.3 One capability registry

There is exactly **one** owner of "which tools exist, are they live, and what happens when one isn't": the `CapabilityRegistry`. It is the tool-side analogue of the (KEEP) `ProviderHealthRegistry`, reusing its proven `live`/`degraded`/`down` state machine and probe-vs-real-success healing. A tool is advertised to the model **only when its capability is provably live**; everything else is either silently withheld or surfaced as a typed `BLOCKED(needs:X)` outcome the agent can reason about — never a stack-trace blob mid-loop. The registry is the *only* mutator of tool-capability health; the loop reads, never writes (no triplicated counters).

---

## 2. The Control Plane (the spec the others assumed and none defined)

This is the blocking gap the critique identified. It is defined **first** and is the single source of truth every component imports. It lives in `src/agent-core/control/`.

### 2.1 `CancelReason` — one union, carried not inferred

The death of v1's `externalSignal.aborted` text heuristic and the supervisor's divergent `timeout-or-node-abort` strings. One typed union, carried on the token, read by everyone:

```
type CancelReason =
  // control-plane — benign, NEVER poisons provider/capability health
  | { kind: "user-cancel" }
  | { kind: "task-winddown" }            // daemon/session shutdown
  | { kind: "first-success-satisfied" }  // a redundant sibling won (Delegator-raised)
  | { kind: "parent-cancelled"; rootCause: CancelReason }
  // genuine — may affect health / classification
  | { kind: "provider-stall"; scope: ScopeLevel }   // inactivity deadline on a call
  | { kind: "hard-timeout"; scope: ScopeLevel }      // wall-clock blown
  | { kind: "task-inactivity" }                      // task-level silence ceiling
  | { kind: "budget-exhausted"; resource: "tokens" | "cost" }
  | { kind: "verdict-stop"; cause: "health" | "loop-detected" };

type ScopeLevel = "task" | "call";   // two levels only (critique fix #7)
```

`isBenign(reason)` is `true` for the four control-plane kinds (a `parent-cancelled` is benign iff its `rootCause` is benign). This single predicate replaces every scattered benign-check in v1. A `budget-exhausted` is a **cancellation reason** in v2 (resolving the Spec 1/Spec 2 disagreement in favor of "it aborts the call; the loop then decides finalize mode" — see §2.4).

### 2.2 `CancelToken` — the abort fabric

One linked tree of `AbortController`s. Children are linked nodes; aborting any node fans out to all descendants and every registered in-flight op (the live `fetch`, a spawned subprocess, an SSE reader).

```
interface CancelToken {
  readonly signal: AbortSignal;          // handed to fetch()
  readonly reason: CancelReason | null;  // null while live; set atomically, first-writer-wins
  readonly aborted: boolean;
  isBenign(): boolean;
  child(): CancelToken;                  // linked descendant
  cancel(reason: CancelReason): void;
  registerInFlight(label: string, abort: (r: CancelReason) => void): Disposable;
  onAbort(cb: (r: CancelReason) => void): () => void;
}
```

The v1 dual-signal provider contract (`chat(..., {signal, externalSignal})`, `provider.interface.ts`) is **preserved at the provider boundary** — both signals now derive from the same tree: `signal` = the **call** token (fires on first-token/stall/hard for this call), `externalSignal` = the **task** token (fires on user-cancel/winddown/parent). FallbackChain's existing `externalSignal?.aborted` benign-check stays correct *and* gains the typed `reason` for richer logging.

### 2.3 `RunClock` + `Budget` — one deadline/resource owner

Two scope levels only (critique fix #7): **task** and **call**. (The four-level task→step→tool→model-call tree from Spec 1 is deferred; tool/model-call split is added later only if a real cancellation-granularity need appears.)

```
interface RunClock {
  readonly view: RunClockView;            // read-only; handed to child sub-agents
  enterCall(limits: CallLimits): CallScope;  // subtractive-min carve from task remaining
  remainingTaskMs(): number;
  touchTask(): void;                       // re-arm task inactivity (any progress)
  reArmOnConfigChange(): void;             // live re-read; re-arms active scope timeouts
  dispose(): void;                         // aborts tree, clears timeouts
}

interface CallScope {
  readonly token: CancelToken;             // call-level abort node
  firstTokenSeen(): void;                  // clears 90s first-response, flips inactivity → stall
  touch(): void;                           // re-arm call inactivity (a chunk arrived)
  registerInFlight(label, abort): Disposable;
  leave(): void;                           // auto-disposes registrations, clears its timeout
}
```

`Budget` (resources, distinct from wall-clock) is owned per-run and tracks the two non-time limits v1 got right:

```
interface Budget {
  remainingOutputTokens(): number;   // cumulative OUTPUT only (input re-counts growing context — NOT a gate)
  remainingCostUsd(): number;        // real billed cost, threaded from usage (not fabricated tier×duration)
  inputTokensSeen(): number;          // observability only, feeds compaction; NEVER a gate
  debit(usage: TokenUsage): void;     // decrements output+cost; propagates to parent on delegation
  carveChild(weight: number, totalWeight: number): BudgetSlice;  // up-front deterministic slice
}
```

**Derivation, one place, one ratio.** All base numbers come from existing config (`config-types.ts` defaults preserved as seed) resolved once into a `RunBudgetPolicy` at run construction, parameterized by `mode: "interactive" | "background" | "supervisor-node" | "delegate"`. The single surviving ratio (`taskInactivityMs ≥ 2 × callStallMs`) is applied **once, as a guarded clamp with a logged warning** — the critique is right that this is v1's existing `Math.max(...)` mechanism *relocated*, not eliminated; we claim only relocation-to-one-place, not elimination. Every other deadline is a `min()` slice, so a config that violates ordering is clamped, not silently honored (kills the "override `streamInitialTimeoutMs` alone silently breaks the ordering" trap).

**The silence ceiling is a task-scope accumulator** (critique fix #3). `MAX_SILENT_THINKING_WINDOWS` is *not* a per-call re-armable counter — that broke the anchor and created a delegation livelock (a flaky provider across a 5-deep FallbackChain resets the ceiling on every fresh call scope, so it never trips, while the busy-retrying loop keeps re-arming task-inactivity). Instead the clock accumulates **total silent ms across all child calls within the task**; when the accumulator exceeds the ceiling, the task is stopped with `{kind:"task-inactivity"}` regardless of how many fresh call scopes were created.

### 2.4 `FailureLedger` — one failure-accounting owner + verdict

Subsumes v1's triplicated state: the loop's `consecutiveProviderFailures` (#8, **deleted**), `IterationHealthTracker` (#9, **kept as the implementation core**), and coordinates with `ProviderHealthRegistry` (kept, subordinate — per-provider recovery vs per-task termination, communicating via the typed empty-response signal so they cannot disagree). One instance per run.

```
interface FailureLedger {
  recordSuccess(provider: string, kind: "real" | "probe"): void;
  recordFailure(provider: string, benign: boolean): void;  // benign (control-plane) never poisons
  // the SINGLE place 3→ask/guide and 5→abort thresholds live (was hardcoded identically in 2 places)
  verdict(input: VerdictInput): RunVerdict;
  get health(): { statusLevel; failureRate; consecutive };  // for prompt injection
}

type RunVerdict =
  | { decision: "continue" }
  | { decision: "retry"; backoffMs: number; guidance?: string }
  | { decision: "ask_user"; backoffMs: number; reason: string }
  | { decision: "pause"; reason: CancelReason }                  // recoverable: drop this call, retry under fresh scope
  | { decision: "stop"; reason: CancelReason; finalize: "graceful" | "hard" };
```

`backoffIndex` lifetime is a **named behavioral delta, not a silent dedup** (critique fix E2): v1 reset `consecutiveProviderFailures` and the tracker's `backoffIndex` at *different call sites*; merging them into one counter changes *when* the count resets relative to backoff. This is audited explicitly and covered by a dedicated test (§ verification), not assumed equivalent.

### 2.5 The verdict algorithm — deterministic precedence (the explicit arbiter v1 lacked)

`FailureLedger.verdict()` is the single owner of "continue / pause / ask / stop, and why." Evaluated top-down, first match wins. This precedence *is* the reconciliation of v1's termination-vs-continuation tug-of-war (the reflection override #7 vs the breakers #8/#9, which v1 ran with no arbiter):

1. **Benign cancel** (task/call token aborted, `isBenign()`) → `stop, graceful`. Never counted as failure.
2. **Hard wall-clock blown** at call *or* task (the absolute ceiling) → `stop, graceful`. **Overrides the reflection override.**
3. **Resource exhausted** (output tokens or cost ≤ 0) → `stop, graceful`.
4. **Task-inactivity accumulator ceiling exceeded** → `stop, graceful` (the §2.3 silence accumulator; kills the 70-min-stall vector *and* the delegation livelock).
5. **Health abort** (tracker `shouldAbort()`: ≥80% rate AND ≥5 consecutive) → `stop, hard`. Subsumes #8's abort.
6. **Per-task pause→retry budget** (critique fix D2): a call-level `provider-stall` returns `pause`, and the number of pause→retry cycles within one task is **bounded by a per-task retry budget feeding the ledger**. When that budget is exhausted, the next stall escalates from `pause` to `stop, graceful`. This is the explicit bound the livelock analysis demanded.
7. **Health ask_user / retry** (3 consecutive or 40% rate → ask; else retry with backoff + health-context guidance, reusing the centralized message formatting).
8. **Reflection arbitration** (the #7-vs-#8/#9 tie-break): the DONE→CONTINUE override is consulted **only here, after rules 2–5 already ran** — so it can only extend a run that is otherwise healthy and within budget. If `loopDetectionBlocked` is set (the v1 runaway-bug guard, **untouched**), the override is suppressed and DONE is honored → `stop, graceful`. This is the structural guarantee v1 lacked: the extender is gated behind the terminators.
9. **Default** → `continue`.

The 3h27m runaway cannot recur (rule 2 + rule 8's `loopDetectionBlocked`). The 70-min stall cannot recur (rule 4 + rule 6's bounded retry). Threshold drift cannot occur (one tracker).

---

## 3. RunController / BudgetLedger / StopController

These three from Spec 1 are **folded into the Control Plane** rather than kept as separate top-level objects:

- **RunController** → the `RunClock` + the `AgentRunner` façade (§4). The public lifecycle API (`enterCall`/`touch`/`cancel`/`view`/`dispose`) lives on `RunClock`; the run-open/run-close lifecycle lives on `AgentRunner`.
- **BudgetLedger** → `Budget` (§2.3), pure accounting, sampled not timer-driven.
- **StopController** → `FailureLedger.verdict()` (§2.4/§2.5), the verdict engine owning the (KEEP) `IterationHealthTracker`.

This collapse is deliberate: the critique showed Spec 1's four-object graph and Spec 6's `RunBudget`/`FailureLedger` were two different control planes both claiming to be the source of truth. We pick Spec 6's shapes (most migration-realistic — they *wrap* the kept tracker rather than replace it) and adopt Spec 1's subtractive-`min()` carving as the *internal derivation algorithm* inside `RunClock`. One control plane, not two.

---

## 4. AgentLoop / Step — the single driver

One loop body replaces v1's two ~600-line shells (`runAgentLoop` / `runBackgroundTask`). Interactive vs background is an injected **`IOStrategy`**, never a forked control flow.

### 4.1 The strangler boundary: `AgentRunner` façade

The single entry both v1 and v2 implement, so callers are decoupled from which engine runs:

```
interface AgentRunner {
  run(request: AgentRunRequest, io: IOStrategy): Promise<AgentRunResult>;
}
```

`AgentRunResult` is the **structured return that kills the `__workerCollector` cast-through side-channel** (`{ status, finalText, touchedFiles, reason, provider, model, usage, verification, artifacts }`). `WorkerRunResult` becomes a pure projection of it.

### 4.2 `IOStrategy` — the one axis of variation

Exactly three responsibilities, no control-flow knobs (iteration limits live in the Control Plane, not here):

```
interface IOStrategy {
  onEvent(e: AgentEvent): void;                 // EVERY event (the heartbeat sink): portal WS | bg onProgress
  visibleSink?: (chunk: VisibleChunk) => void;  // OPTIONAL token sink: streaming channel | undefined (narrative-only)
  deliverFinal(text: string, state: AgentState): void;  // interactive render | bg no-op (string is the return)
  readonly mode: "interactive" | "background" | "worker" | "supervisor-node";
  readonly externalSignal: AbortSignal;          // control-plane cancel (= task token)
}
```

`onEvent` and `visibleSink` are distinct *on purpose* — this is the architectural fix for v1's token-stream-vs-progress-stream seam. `visibleSink` receives only non-empty token text; empty/keepalive chunks are liveness and reach only `onEvent` as `heartbeat`.

### 4.3 `Step` — the observe→decide→act→record quantum

A `Step` is one full turn (one model response + its tool batch), a first-class object instead of a `for`-body. It **reports** a structured `StepOutcome`; the **loop is the sole writer of `AgentState`** (via the KEEP `transitionPhase`). The step never mutates phase. Provider errors are caught *inside* the step and surfaced as `StepOutcome` variants; the only thing that crosses the step boundary is a `CancelReason`-bearing abort — cancel-vs-stall is data, never re-inferred.

### 4.4 The single loop spine

```
run(request, io):
  clock   = controlPlane.openRun(policyFor(io.mode), request.parentClock?)   // §2.3
  ledger  = controlPlane.failureLedger()
  bus     = controlPlane.openBus(io)                                          // §5
  state   = request.initialState ?? createInitialState(request.task)
  emit    = bus.emit                                                          // append THEN sink (§5)

  emit(run.started); intentAck(bus, request)        // §6: <=2s ack contract

  while (true):
    verdict = ledger.verdict({ activeScope: "task", now, loopDetectionBlocked })   // GATE before any step
    if verdict.decision == "stop":  emit(run.ending{verdict.reason}); break
    if verdict.decision in {retry,pause,ask_user}:  handleYield(verdict); continue  // every yield is an event

    call = clock.enterCall(deriveCallLimits())                  // subtractive-min carve
    ctx  = assembleStepContext(state, call, io, emit)           // KEEP prepareIteration etc.
    emit(step.started)

    outcome = await new TurnStep(ctx).run()                     // model call via ModelGateway (§ below)
    call.leave()

    budget.debit(outcome.usage)
    (state, transition) = applyOutcome(state, outcome)          // KEEP recordStepResults + transitionPhase
    emit(step.completed)

    // reflection boundary — override gated behind the verdict (§2.5 rule 8)
    verdict = ledger.verdict({ activeScope: "task", reflectionIntent: outcome.intent, loopDetectionBlocked })
    if verdict.decision == "stop":  emit(run.ending{verdict.reason}); break
    if outcome.kind == "ended":     emit(run.ending{outcome.reason}); break

  final = synthesizeFinal(state)                                // KEEP terminal-text assembly
  io.deliverFinal(final.text, state)
  emit(run.ended)
  await persistTerminal(state, bus.log)        // fire-and-forget kicked at run.ending; joined here (not before deliverFinal)
  clock.dispose()
  return buildAgentRunResult(state, final, bus.log)
```

The outer epoch `while` exists **only when `io.mode !== "interactive"`** — interactive is the degenerate single-epoch case. Epoch rollover (background/worker), backoff sleeps, and `ask_user` all flow through `handleYield`, which emits before and after it sleeps/rolls (no silent spin). **`ask_user` in background resolves to one owner: the loop yields** (`AgentRunResult` status `"blocked"`); it does not block, and the bus does not "auto-handle" it (resolving the three-way contradiction the critique found — critique fix #8).

`silentStream` stays **frozen** (KEEP). The reconciliation of the three specs that each claimed the "only" change to its `onChunk` (critique E3): the frozen function's `onChunk` is wrapped by **ModelGateway** (§5.2), which is the single place that (a) calls `call.touch()` for liveness, (b) emits the `model.delta`/`heartbeat` event, and (c) routes to `visibleSink`. `silentStream`'s own body is untouched; the wiring lives in the gateway wrapper, so there is *one* sanctioned change point, not three competing ones.

---

## 5. EventBus / ModelGateway

### 5.1 EventBus — one typed stream, many sinks

`AgentEvent` is a closed discriminated union, JSON-serializable by construction, every member carrying `{ runId, seq, ts, parentRunId? }`. `seq` is assigned **inside the bus under a per-run lock** so it is gap-free and total-ordered even under concurrent emitters (gateway + tool executor + reflection all emit into one run). The variant set is small and exhaustively switched (TS `never` check): lifecycle (`run.*`, `step.*`, `phase.changed`, `epoch.rolled`, `backoff`), intent (`intent.ack`), model I/O (`model.call.started`, `model.delta` with `channel: "answer"|"reasoning"|"tool-args"`, `model.tool_call`, `model.call.finished`), tooling (`tool.started`, `tool.finished`), and control (`narrative` — v1's `TaskProgressSignal` verbatim, `heartbeat` — its own variant so it can never be mistaken for content, `ask_user`, `show_plan`, `error`, `capability` — for mid-task bridge-drop narration).

**Two delivery classes:**
- **Live sinks** (web/chat) — best-effort, fire-and-forget, **never block `emit`**, never block the agent loop. Per-sink bounded queues; `model.delta` coalesces lossy-newest under back-pressure (a slow WS client gets merged deltas, never a memory blowup); non-delta variants are bounded-lossless.
- **Observability sink** — **an in-memory ring buffer** (critique fix #6). This is the deliberate de-scoping: the NDJSON-per-run + SQLite index + write-ahead log + crash-torn-line reconciliation + `replayTo(realtime)` durable-replay subsystem from Spec 3 §6 is **cut**. None of the four v1 failures requires it; it tripled the blast radius of the riskiest component and is a database with a WAL masquerading as "free." The ring buffer satisfies the heartbeat/observability need and powers same-process portal rehydration (a reconnecting tab catches up from a `seq` cursor while the run is live). **Durable cross-restart replay is deferred to a separate post-migration feature** designed against actual portal requirements.

`persistTerminal` (memory writes) is **fire-and-forget with a join-before-return barrier**: kicked off on `run.ending`, runs concurrently with `synthesizeFinal`/`deliverFinal`, awaited only at the very end — so durability is guaranteed before the result returns, but user-visible delivery is never blocked on it. This fixes v1's inline-awaited persist on the hot exit path.

### 5.2 ModelGateway — the single LLM entry point

Replaces `silentStream` as the *only* way the agent core calls an LLM (the two v1 call sites collapse to one). Streaming-default (`supportsStreaming && typeof chatStream === "function"`). It does **not** pick providers (FallbackChain, KEEP) and does **not** know what a channel is (channel-awareness lives in sinks).

Its core job — the inversion of v1 — is **chunk → event translation**: where v1's `silentStream` does exactly one thing per chunk (drive the watchdog, *discard* the text), the gateway does **two**: drives the watchdog *and* emits the typed delta:
- visible text → `emit(model.delta {channel:"answer"})` + `call.touch()` (progress) + route to `visibleSink`;
- `reasoning_content` → `emit(model.delta {channel:"reasoning"})` + `call.touch()` (liveness; preserves long thinking);
- tool-arg delta → `emit(model.delta {channel:"tool-args"})` + `call.touch()`;
- empty keepalive → `emit(heartbeat)` + `call.touch()` (≥20s throttle on the watchdog-forward, but every keepalive pulses).

This makes the dead-in-v1 `IStructuredStreamingProvider.StreamChunk` capability **load-bearing**. The watchdog semantics (`markProgress`/`markAlive`, the silence ceiling) are preserved bit-for-bit (they encode fixed incidents) — but the ceiling now feeds the **task-scope accumulator** (§2.3), not a per-call counter. The gateway computes `empty = isEmptyProviderResponse(response)` **once** and routes the health record, so breaker and registry read one flag, never re-infer. Dual-signal abort is preserved verbatim; the timeout *numbers* now come from the one `CallScope` instead of five independent constants.

---

## 6. The <=2s intent-acknowledgement contract

For every run, an `intent.ack` event MUST be emitted within **2000ms** of `run.started`, and it MUST be the first user-facing event — enforced by the bus, not by hope. `openRun` arms a 2s `unref`'d timer: the fast path is the orchestrator's existing intent-classification calling `bus.ackIntent({intent, planHint?, estimatedSteps?})`; the fallback is the bus auto-emitting a generic ack derived from the prompt's first clause if 2s elapses. `ackIntent` is idempotent (a late real classification emits a refinement `narrative`, not a second ack). This replaces v1's heartbeat ladder's first rung (where `phase-driven` mode could leave the user waiting up to 20s) with a hard guarantee, independent of channel and interaction mode. The existing `ProgressReporter` heartbeat machinery is retained for *subsequent* liveness (it becomes the chat sink's coalescing engine).

---

## 7. CapabilityRegistry

Single owner of tool liveness, between the (KEEP) `ToolRegistry` and the loop. Splits the v1-conflated `ITool` into a **Capability** (a health-probed substrate: `unity-bridge`, `dotnet-cli`, `mcp:strada`, `network`, in-process) and a **Tool** that binds to zero-or-one capability. `CapabilityState` mirrors `ProviderHealthEntry` field-for-field (`live`/`degraded`/`down`/`unknown`, escalating cooldown, `downEpisodes`) with the crucial borrowed nuance: **probe-success heals only to `degraded`; real-call-success heals to `live`** (a TCP ping proving the bridge answers is not proof a real compile will succeed).

`StradaMcpRuntime` is **demoted to one `McpBridgeAdapter`** behind a uniform `CapabilityAdapter` interface (the critique's confirmed-correct generalization) — its reconnect/dormant/capability logic is *reused, not rebuilt*; a future Jira/Linear MCP is a new adapter with zero loop changes. `ToolMetadata.available` becomes a *projection* of `CapabilityState`, written by one owner (ending v1's three-places availability problem).

**Advertise** (read path, per iteration): live → advertise; degraded → advertise with a one-clause warning suffix; down/unknown → withhold (zero tokens) or, if demand-relevant, surface as one compact `## Capability Status` line. Withheld tools never enter the prompt — only demand-relevant blocked capabilities do.

**guardExecute** (write path, the BLOCKED flow): on a call to a non-live capability, attempt `adapter.revive()` **once** (generalizing StradaMcp lazy-reconnect), then either succeed or return a typed `BLOCKED needs=<cap>#<feature>` result — a stable, parseable contract read by three consumers (the model, to re-plan; the reflection layer, to *not* escalate; the partial-result surfacer). **Critique fix #4 — heartbeat through revive**: `revive`/`guardExecute` emit `heartbeat` events on the bus, and the call scope carries the inactivity re-arm contract, so a hung MCP reconnect can never be a silent window the heartbeat invariant misses.

**`classifyToolError` is specified against the typed `CancelReason`** (critique fix #5 — the undecidable case): a deadline-driven `AbortError` is ambiguous (substrate-stall vs the tool legitimately taking too long) *unless* the abort carries its reason. Because the `CallScope` token's `CancelReason` distinguishes `provider-stall`/`hard-timeout` (substrate/wall-clock) from a tool's own returned `isError`, the classifier is decidable: only transport/connection signatures **and** substrate-attributed cancel reasons count as capability failures; a tool's returned error is tool-logic by default and never cools a healthy capability.

**Reflection contract** (consistency with KEEP): a `BLOCKED`-on-down-capability step is *non-progress, non-fatal* — `validateReflectionDecision` learns one rule: do **not** treat it as a blocking failure that forces CONTINUE→REPLAN re-calling the dead tool (the loop-thrash shape behind the 3h27m incident); instead re-plan *around* the capability. `loopDetectionBlocked` is untouched as the ultimate backstop. **Partial-result surfacing**: a per-task `BlockedLedger` → `PartialResultDigest` gives the user accurate "I did X, couldn't do W because the Unity bridge was down, here's how to unblock" facts (the agent owns the prose; the facts come from the ledger, never hallucinated).

---

## 8. Planner / Delegator

### 8.1 Planner — the pure decompose gate

Decides single-loop vs decomposed; **strongly biased toward single-loop** (decomposition is a cost that must pay for itself). A **pure gate**: no side effects on state, and the triage LLM call is **off by default** (critique fix #7 — it's a latency tax on a gate that should bias to single). A short-circuit ladder: hard caps (real `maxDepth`, budget-too-thin, clock-too-thin — all derived, never literal) → deterministic heuristic score (conjunctive clauses, breadth markers, dependency markers; weights in one tunable record) → (optional, off-by-default) triage → emit a bounded `ExecutionPlan` DAG. `maxDepth` is now a *real* threaded bound (children at the cap get a Planner that always returns `single`), replacing v1's dead `maxDepth>1` config + tool-strip hack.

### 8.2 Delegator — bounded fan-out sharing one everything

Executes the plan as a wave-scheduled fan-out where every child is **an `AgentLoop` instance** (not a fresh Orchestrator) sharing the **same `RunClock` (read-only view), `Budget` (sliced), `CancelToken` (child node), and `EventBus` (scoped)**. It owns **no timers** and **scores nothing** (defers to the one `ProviderRouter`, killing the third scoring engine). It lifts the proven `Semaphore`/`FailureBudget`/`computeWaves`/transient-retry from the (KEEP) `SupervisorDispatcher` into a shared wave-engine. Budget is **sliced up front by weight** and reconciled on settle (real measured `UsageDelta`, not fabricated cost); a cheap child returns its unspent reservation. `DelegationResult` (returned by value) replaces the `__workerCollector` out-param. Any child's `token-activity` event re-arms the **one** task-inactivity watchdog — a busy run is busy even if one child is mid-reasoning.

---

## 9. End-to-end run flow

```
1. Channel/daemon/supervisor builds AgentRunRequest + IOStrategy → AgentRunner.run(...)

2. Control Plane opens the run:
   - RunClock created from RunBudgetPolicy(mode); parentClock view threaded if delegated/supervisor-node
   - Budget resolved (output-token cap, cost cap from config seed)
   - FailureLedger instantiated (owns the KEEP IterationHealthTracker)
   - EventBus opened with the IOStrategy's sinks + the in-memory ring buffer
   - root CancelToken minted; externalSignal (control-plane cancel) linked as task token

3. emit(run.started) → within 2s: intent.ack (fast path: classifier; fallback: bus auto-ack)
   → web sink shows a status bubble; chat sink opens its transient message — user acknowledged on every channel

4. Planner.decide(): single-loop (common) OR decomposed
   - decomposed → Delegator runs children as AgentLoop instances sharing clock/budget/token/bus;
     each child's token-activity re-arms the one watchdog; result aggregated → folded back as ONE step

5. AgentLoop spine (per iteration):
   a. FailureLedger.verdict({task}) GATE → continue | retry/pause/ask_user (yield, emitted) | stop
   b. RunClock.enterCall() → subtractive-min carve; CallScope token = signal, task token = externalSignal
   c. prepareIteration (KEEP) → CapabilityRegistry.advertise() → live tools (+degraded-annotated) only
   d. ModelGateway.call():
        - silentStream (KEEP, frozen) wrapped: every chunk → call.touch() + emit(model.delta|heartbeat)
        - visible answer deltas → visibleSink (web: live tokens; chat: coalesced "writing…")
        - first token → call.firstTokenSeen() (clears 90s, flips inactivity→stall)
        - empty=isEmptyProviderResponse computed once → routes health
   e. tools execute via CapabilityRegistry.guardExecute():
        - non-live capability → revive() once (emits heartbeat — never silent) → BLOCKED(needs:X) or run
        - classifyToolError via CancelReason: substrate-stall vs tool-logic (decidable)
   f. applyOutcome (KEEP): loop writes AgentState; reflection boundary →
      FailureLedger.verdict({reflectionIntent, loopDetectionBlocked}) — override gated behind terminators

6. Termination (one of):
   - benign cancel → stop graceful (emit partial)
   - hard wall-clock / resource / task-inactivity-accumulator → stop graceful
   - health abort (80%+5) → stop hard
   - pause→retry budget exhausted → stop graceful
   - DONE (override-eligible & healthy & in-budget) → stop graceful

7. synthesizeFinal → io.deliverFinal → emit(run.ended)
   persistTerminal kicked at run.ending, joined before return (never blocks deliverFinal)
   RunClock.dispose() fans out abort to any stragglers; CapabilityRegistry.summarizePartial() → PartialResultDigest
   → AgentRunResult returned by value (no out-param)
```

---

## 10. The unified models (the three the critique demanded be made one)

### 10.1 Unified deadline model

- **One `RunClock`** per run; two scope levels (task, call). Children get a read-only view; fan-out shares, never multiplies.
- **Derived, not stacked**: `attempt ⊂ call ⊂ task` enforced by subtractive `min()` at carve; a config override that violates ordering is clamped + warned, never silently honored.
- **One timer model**: per-scope `AbortSignal.timeout`, re-armed on config change. No sampler (no granularity regression, no first-token race).
- **One surviving ratio** (`taskInactivity ≥ 2 × callStall`), applied once at policy resolution — claimed as *relocated to one place*, not eliminated.
- **Silence ceiling = task-scope accumulated-silent-ms**, not a per-call counter (no delegation livelock).
- **Bounded pause→retry budget** per task feeds the verdict; exhaustion escalates pause→stop.

### 10.2 Unified streaming model

- **One `AgentEvent` stream**, one `EventBus`, many sinks. Liveness and progress are the same channel.
- **Heartbeat invariant**: no path between wait-points skips `emit` — including tool-revive, which emits `heartbeat`.
- **Visibility is a sink decision**, never an event field. `visibleSink` (token-granular, web) is distinct from `onEvent` (every event, the watchdog + narrative sink).
- **ModelGateway** is the one LLM entry point; it adds `emit` to the frozen `silentStream`'s chunk handling — the *single* sanctioned wiring point (not three).
- **Observability = in-memory ring buffer**; durable cross-restart replay deferred.

### 10.3 Unified capability model

- **One `CapabilityRegistry`** owns tool liveness; `ToolMetadata.available` is its projection.
- **One state machine**, mirrored from `ProviderHealthRegistry` (probe→degraded, real→live).
- **`StradaMcpRuntime` = one adapter** behind a uniform interface; new MCP servers are new adapters.
- **`BLOCKED(needs:X)`** is a typed contract read by model + reflection + surfacer; `classifyToolError` is decidable via `CancelReason`.
- **One failure owner**: the loop reads capability/provider health, never writes it. `FailureLedger` is the single per-task failure-accounting + verdict authority.

---

## 11. What v2 deliberately does NOT touch (KEEP, frozen)

`agent-state.ts` PAOR machine and `VALID_TRANSITIONS` (no new phases) · reflection override `validateReflectionDecision` + `MAX_REFLECTION_OVERRIDES=2` + `loopDetectionBlocked` (logic unchanged; only its *gating* moves into the verdict precedence) · `silentStream` (frozen; only the gateway wrapper adds `emit`) · `session-compaction.ts` (independent; consumes `inputTokensSeen` observability) · budget/epoch math semantics · `SupervisorDispatcher`/`ResultAggregator`/`ConsensusManager` (untouched; Delegator *reuses* the wave engine) · `ProviderRouter` scoring math (only *who calls* it changes) · `FallbackChainProvider`/provider interfaces/`ProviderHealthRegistry` (the dual-signal contract preserved) · `SessionManager`/AgentDB memory (same methods, same call points; persist made fire-and-forget-with-barrier).
