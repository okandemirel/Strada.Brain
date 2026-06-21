/**
 * Agent Core v2 — the heartbeat invariant mechanism (ARCHITECTURE §1.2, §10.2).
 *
 * THE INVARIANT: the loop cannot advance, sleep, roll an epoch, or terminate without first
 * emitting an event. Enforced STRUCTURALLY, two layers:
 *
 *  1. Bus-level: emit() stamps seq + appends to the ring SYNCHRONOUSLY before any sink runs
 *     (append-THEN-sink). There is no async gap between "decide to emit" and "it is in the
 *     log", so the watchdog (reading the ring) and the UI (a live sink) observe the SAME
 *     ordered stream. (Lives in event-bus.ts.)
 *
 *  2. Wait-point wrap (this file): every place the loop can pause routes its sleep through
 *     guardedSleep, whose heartbeat event is a REQUIRED argument emitted BEFORE the timer
 *     arms. It is structurally impossible to reach the sleep without first emitting.
 *
 * PURELY ADDITIVE: nothing in v1 imports this yet (Phase 2 foundation).
 */

import type { AgentRunEventBus } from "./event-bus.js";
import type { Clock } from "../control/clock.js";
import type { EmittableEvent } from "./agent-event.js";

/** Promise-wrap a Clock timer so the run-scoped sleep is fake-able under FakeClock. */
function sleep(clock: Clock, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    clock.setTimer(ms, resolve);
  });
}

/**
 * The ONLY sanctioned wait primitive inside an agent run. It is structurally impossible to
 * reach the sleep without first emitting: the heartbeat event is a REQUIRED argument, and the
 * emit happens before the timer arms. Raw setTimeout/await between wait-points is a pattern an
 * ESLint no-restricted-syntax rule should forbid in the loop spine (the only allowed sleep is
 * this guarded one). This kills silent runs BY CONSTRUCTION — it is NOT a tuned timeout ratio.
 *
 * `clock` is the injected, fake-able timer (control plane) — no raw setTimeout here either.
 */
export async function guardedSleep(
  bus: AgentRunEventBus,
  clock: Clock,
  ms: number,
  beat: EmittableEvent, // REQUIRED: cannot sleep without an event to emit first
): Promise<void> {
  bus.emit(beat); // append THEN sink — heartbeat is in the log first
  if (ms <= 0) return;
  await sleep(clock, ms);
}

/**
 * Dev-time tripwire used in tests + the loop's wait boundaries: asserts that between two
 * observed wait-points the bus head advanced. If `headSeq` did not move across a sleep
 * boundary, a silent path slipped through — fail loudly so the regression is caught.
 */
export function assertEmittedSince(bus: AgentRunEventBus, priorHead: number, where: string): void {
  if (bus.headSeq <= priorHead) {
    throw new Error(`Heartbeat invariant violated: no event emitted before wait-point at ${where}`);
  }
}
