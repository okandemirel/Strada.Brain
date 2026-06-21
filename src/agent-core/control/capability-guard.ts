/**
 * Agent Core v2 — CapabilityRegistry write-path guard (Phase 3b, ARCHITECTURE §7).
 *
 * `guardExecute` is the write path the spec describes: on a call to a non-live capability, attempt
 * `adapter.revive()` **once** (generalizing StradaMcp's lazy-reconnect), then either run or return a
 * typed `BLOCKED needs=<cap>` result. **Heartbeat-through-revive** (critique fix #4): a heartbeat is
 * emitted around the revive so a hung reconnect can never be a silent window the heartbeat invariant
 * misses. `classifyToolError` (critique fix #5) disambiguates a SUBSTRATE failure (cools the
 * capability) from TOOL-LOGIC (never cools a healthy capability) using the typed `CancelReason` carried
 * on the call scope — a tool's own returned/thrown error is tool-logic by default.
 *
 * ADDITIVE + UNWIRED: nothing calls this yet. The call-site wiring (into `executeAndTrackTools`, with
 * the real bus heartbeat + the CallScope token's reason + the `McpBridgeAdapter`) is the next
 * increment; here the logic is built + tested in isolation against the registry + a mock adapter.
 */

import type { CancelReason } from "./cancel-reason.js";
import {
  type BlockedCapabilityResult,
  buildBlocked,
  type CapabilityRegistry,
} from "./capability-registry.js";

/**
 * A health-probed substrate behind a CapabilityRegistry capability — the uniform interface
 * `StradaMcpRuntime` is demoted to (as `McpBridgeAdapter`) in the wiring increment; a future
 * Jira/Linear MCP is a new adapter with zero loop changes.
 */
export interface CapabilityAdapter {
  readonly capabilityId: string;
  /** Attempt to bring the capability back (lazy reconnect / probe). Resolves true iff it answered. */
  revive(): Promise<boolean>;
}

export type ToolErrorClass = "capability-failure" | "tool-logic";

/** Transport/connection signatures that attribute a thrown error to the substrate, not tool logic. */
const TRANSPORT_SIGNATURES = [
  "econnrefused",
  "econnreset",
  "etimedout",
  "enotfound",
  "ehostunreach",
  "epipe",
  "socket hang up",
  "network error",
  "fetch failed",
  "connection closed",
  "connection refused",
];

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * Classify a thrown tool error as a CAPABILITY failure (cool the substrate) or TOOL-LOGIC (leave a
 * healthy capability alone). It is a capability failure iff the abort carried a SUBSTRATE-attributed
 * `CancelReason` (`provider-stall` / `hard-timeout` — wall-clock / inactivity on the call scope) OR
 * the error text matches a transport/connection signature. Everything else — including a tool's own
 * thrown/returned error — is tool-logic by default (§7 critique fix #5: the decidable case).
 */
export function classifyToolError(error: unknown, cancelReason?: CancelReason | null): ToolErrorClass {
  // A typed CancelReason on the abort is AUTHORITATIVE (§7: "decidable when the abort carries its
  // reason"). Only the substrate/wall-clock kinds cool the capability; EVERY other kind — benign
  // control-plane cancels (user-cancel / first-success-satisfied / task-winddown) included — is
  // tool-logic and must NEVER poison capability health (cancel-reason.ts: "benign never poisons").
  // This rules out the case where a benign cancel that tears down a connection produces transport-y
  // error text and would otherwise wrongly cool a healthy capability via the heuristic below.
  if (cancelReason) {
    return cancelReason.kind === "provider-stall" || cancelReason.kind === "hard-timeout"
      ? "capability-failure"
      : "tool-logic";
  }
  // No typed reason: fall back to the transport/connection text heuristic.
  const text = errorText(error).toLowerCase();
  return TRANSPORT_SIGNATURES.some((sig) => text.includes(sig)) ? "capability-failure" : "tool-logic";
}

export interface GuardExecuteParams<T> {
  readonly registry: CapabilityRegistry;
  readonly capabilityId: string;
  /** Adapter used to revive a still-cooling `down` capability ONCE. Omitted ⇒ no revive (→ BLOCKED). */
  readonly adapter?: CapabilityAdapter;
  /** Emit a heartbeat event — called around `revive()` so a hung reconnect is never a silent window. */
  readonly emitHeartbeat?: () => void;
  /** The actual tool call. */
  readonly run: () => Promise<T>;
  /** The CancelReason on the call scope's token, if any — read lazily for `classifyToolError`. */
  readonly cancelReason?: () => CancelReason | null;
}

export type GuardExecuteResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "blocked"; readonly blocked: BlockedCapabilityResult };

/**
 * Run a tool call under capability guarding.
 * - If the capability can be attempted (live / degraded / cooled-down), run it directly.
 * - If it is `down` and still cooling, attempt `revive()` ONCE (heartbeat-emitting); on success the
 *   capability heals to `degraded` (a probe is not proof of a real call) and the run proceeds; on
 *   failure (or no adapter) return a typed `BLOCKED`.
 * - On a successful run → `recordRealSuccess` (fully heal to `live`).
 * - On a thrown error → `classifyToolError`: a capability-failure cools the substrate (and, if that
 *   knocks it `down`, returns `BLOCKED`); a tool-logic error leaves capability health UNCHANGED and is
 *   rethrown for the caller's normal handling. A tool that *returns* an error (not thrown) resolves
 *   normally → the substrate served the call → `recordRealSuccess` (returned-error is tool-logic).
 */
export async function guardExecute<T>(params: GuardExecuteParams<T>): Promise<GuardExecuteResult<T>> {
  const { registry, capabilityId, adapter, emitHeartbeat, run, cancelReason } = params;

  if (!registry.canAttempt(capabilityId)) {
    emitHeartbeat?.();
    const revived = adapter ? await adapter.revive().catch(() => false) : false;
    emitHeartbeat?.();
    if (revived) {
      registry.recordProbeSuccess(capabilityId); // answered → degraded; a real call will heal to live
    } else {
      return {
        kind: "blocked",
        blocked: buildBlocked(capabilityId, `${capabilityId} is unavailable and could not be revived`),
      };
    }
  }

  try {
    const value = await run();
    registry.recordRealSuccess(capabilityId);
    return { kind: "ok", value };
  } catch (error) {
    const text = errorText(error); // single source for both recordFailure + the BLOCKED reason
    if (classifyToolError(error, cancelReason?.()) === "capability-failure") {
      registry.recordFailure(capabilityId, text);
      if (!registry.canAttempt(capabilityId)) {
        return {
          kind: "blocked",
          blocked: buildBlocked(capabilityId, `${capabilityId} failed: ${text.slice(0, 120)}`),
        };
      }
    }
    // Tool-logic error, or a capability blip that did not knock the substrate down → rethrow.
    throw error;
  }
}
