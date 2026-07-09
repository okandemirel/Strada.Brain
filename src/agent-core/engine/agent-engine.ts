/**
 * Agent Core v2 — the AgentEngine facade (relocation blueprint: project_v2_engine_relocation).
 *
 * Owns the relocated port method clusters over an injected {@link EngineDeps}; Step 9 moves
 * `createAgentCorePort` itself so the shell's runner hook becomes `this.engine.createPort()`.
 * Every method is a thin binding over its cluster module — the bodies live in the per-cluster
 * files (accounting.ts, …), matching the repo's *Deps-helper house style.
 */

import type { EngineDeps, EngineRunContext } from "./engine-deps.js";
import type { ProviderResponse } from "../../agents/providers/provider-core.interface.js";
import type { TaskUsageEvent } from "../../tasks/types.js";
import type { ClassifyFailureParams, FailureVerdictContribution } from "../runner/orchestrator-port.js";
import {
  recordProviderUsage,
  recordExecutionTrace,
  recordMetricEnd,
  recordAuxiliaryUsage,
  classifyAgentCoreFailure,
  type RecordExecutionTraceParams,
  type RecordMetricEndResult,
} from "./accounting.js";

export class AgentEngine {
  constructor(private readonly deps: EngineDeps) {}

  // ── Accounting (relocation Step 1) ────────────────────────────────────────────────────────
  recordProviderUsage(
    providerName: string,
    usage: ProviderResponse["usage"] | undefined,
    onUsage?: (usage: TaskUsageEvent) => void,
  ): void {
    recordProviderUsage(this.deps, providerName, usage, onUsage);
  }

  recordExecutionTrace(params: RecordExecutionTraceParams): void {
    recordExecutionTrace(this.deps, params);
  }

  recordMetricEnd(metricId: string | undefined, result: RecordMetricEndResult): void {
    recordMetricEnd(this.deps, metricId, result);
  }

  recordAuxiliaryUsage(
    provider: string,
    usage: ProviderResponse["usage"] | undefined,
    sink?: (usage: TaskUsageEvent) => void,
  ): void {
    recordAuxiliaryUsage(this.deps, provider, usage, sink);
  }

  classifyAgentCoreFailure(
    params: ClassifyFailureParams,
    runCtx: EngineRunContext,
  ): FailureVerdictContribution {
    return classifyAgentCoreFailure(params, runCtx);
  }
}
