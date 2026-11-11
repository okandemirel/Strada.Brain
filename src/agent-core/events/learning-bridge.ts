/**
 * Agent Core v2 — bridge to the process-wide TypedEventBus (ARCHITECTURE §5.1).
 *
 * Translates the run-scoped `tool.finished` → the process-wide learning pipeline's existing
 * "tool:result" (ToolResultEvent). Keeps the entire learning subscription graph untouched
 * (matching v1, where the orchestrator holds an IEventEmitter<LearningEventMap>). The run.* /
 * step.* vocabulary stays on the new bus; only this one variant crosses over.
 *
 * Decision (per the map): BRIDGE, don't merge. TypedEventBus stays frozen as the cross-cutting
 * learning/daemon fabric; the run-scoped bus owns seq / ring / back-pressure. These are
 * orthogonal objects. NOTE: do NOT map run.* onto LearningEventMap's agent:created/started/
 * stopped — those belong to the multi-agent manager and are a different namespace.
 *
 * PURELY ADDITIVE: nothing in v1 imports this yet (Phase 2 foundation).
 */

import type { IEventEmitter } from "../../core/event-bus.js";
import { toSignatureErrorDetails } from "../../learning/error-signature.js";
import type { LiveSink } from "./event-bus.js";

export function createLearningBridgeSink(sessionId: string, learning: IEventEmitter): LiveSink {
  return {
    id: "learning-bridge",
    deliver(e) {
      if (e.type === "tool.finished") {
        learning.emit("tool:result", {
          sessionId,
          toolName: e.toolName,
          // The rich input is supplied by the tool executor's own emit; this lifecycle mirror
          // carries only what the run-scoped event has. Phase 2 wiring may enrich it.
          input: {},
          output: "",
          success: e.success,
          // LRN-19: only a structured signature. The run-scoped category is a
          // free string, so it is mapped onto the closed enum ("unknown" if it
          // is not a member) and the message is the template, never the string.
          errorDetails: !e.success && e.errorCategory
            ? toSignatureErrorDetails({ category: e.errorCategory })
            : undefined,
          timestamp: Date.now(),
        });
      }
    },
  };
}
