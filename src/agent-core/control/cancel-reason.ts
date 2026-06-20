/**
 * Agent Core v2 — Control Plane: CancelReason
 *
 * The single typed cancellation-reason union, carried on the CancelToken — never
 * inferred from error-message text the way v1 did (`externalSignal?.aborted` heuristic,
 * supervisor `timeout-or-node-abort` strings). One owner; every component imports this,
 * none re-defines it. See plans/agent-core-v2/ARCHITECTURE.md §2.1.
 */

/** The two scope levels v2 supports. The tool/model-call split is deferred (§2.3). */
export type ScopeLevel = "task" | "call";

export type CancelReason =
  // Control-plane — benign; MUST NOT poison provider/capability health.
  | { kind: "user-cancel" }
  | { kind: "task-winddown" } // daemon / session shutdown
  | { kind: "first-success-satisfied" } // a redundant sibling won (Delegator-raised)
  | { kind: "parent-cancelled"; rootCause: CancelReason }
  // Genuine — may affect health / classification.
  | { kind: "provider-stall"; scope: ScopeLevel } // inactivity deadline on a call
  | { kind: "hard-timeout"; scope: ScopeLevel } // wall-clock ceiling blown
  | { kind: "task-inactivity" } // task-level silence-accumulator ceiling
  | { kind: "budget-exhausted"; resource: "tokens" | "cost" }
  | { kind: "verdict-stop"; cause: "health" | "loop-detected" };

/**
 * True for the four control-plane kinds (a `parent-cancelled` is benign iff its
 * `rootCause` is benign). This single predicate replaces every scattered benign-check
 * in v1 — a benign cancel never poisons provider/capability health or forces fall-over.
 */
export function isBenign(reason: CancelReason): boolean {
  switch (reason.kind) {
    case "user-cancel":
    case "task-winddown":
    case "first-success-satisfied":
      return true;
    case "parent-cancelled":
      return isBenign(reason.rootCause);
    default:
      return false;
  }
}

/** Short human label for logs/events (no sensitive data). */
export function describeCancelReason(reason: CancelReason): string {
  switch (reason.kind) {
    case "parent-cancelled":
      return `parent-cancelled(${describeCancelReason(reason.rootCause)})`;
    case "provider-stall":
    case "hard-timeout":
      return `${reason.kind}:${reason.scope}`;
    case "budget-exhausted":
      return `budget-exhausted:${reason.resource}`;
    case "verdict-stop":
      return `verdict-stop:${reason.cause}`;
    default:
      return reason.kind;
  }
}
