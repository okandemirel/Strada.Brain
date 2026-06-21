/**
 * Agent Core v2 — Runner seam public surface (ARCHITECTURE §4.1–§4.2).
 *
 * The strangler boundary: the `AgentRunner` façade + its I/O contract, the Phase-0
 * `V1AgentRunner` pass-through adapter over the v1 orchestrator entry methods, and the
 * enumerated `LEGAL_FLAG_SETS` rollout matrix with its reject-at-boot validator. Purely
 * additive — `orchestrator.ts` stays at net-zero (gate §3/B3).
 */

export type {
  AgentRunner,
  AgentRunRequest,
  AgentRunResult,
  AgentRunEvent,
  IOStrategy,
  VisibleChunk,
  RunnerMode,
  TerminalStatus,
} from "./agent-runner.js";

export {
  V1AgentRunner,
  projectWorkerResult,
  toWorkerRunResult,
} from "./v1-agent-runner.js";
export type {
  V1OrchestratorLike,
  InteractiveDriver,
  InteractiveOutcome,
} from "./v1-agent-runner.js";

export {
  LEGAL_FLAG_SETS,
  DEFAULT_FLAG_SET_ID,
  DEFAULT_FLAG_SET,
  PRODUCTION_DEFAULT_FLAG_SET_ID,
  resolveLegalFlagSet,
  resolveFlagSetById,
} from "./flags.js";
export type { FlagSet, RequestedFlagSet, DriverChoice } from "./flags.js";

export { V2AgentRunner, mapMode } from "./v2-agent-runner.js";
export type { V2RunnerDeps, ControlPlane, OpenRunResult } from "./v2-agent-runner.js";

export { selectAgentRunner } from "./runner-factory.js";
export type { RunnerHostOrchestrator } from "./runner-factory.js";

export type {
  OrchestratorPort,
  RunnerModeLike,
  PreparedIteration,
  RunSetup,
  FailureVerdictContribution,
  ClassifyFailureParams,
  AgentRunSetupInput,
  PrepareIterationParams,
  RecordExecutionTraceParams,
  BudgetCheckpointParams,
  DispatchReflectionParams,
  ReflectionDispatchResult,
  DispatchEndTurnParams,
  EndTurnDispatchResult,
  PlanPhaseParams,
  PlanPhaseYield,
  PlanPhaseResult,
  GoalDecompositionParams,
  SynthesizedFinal,
  ResultProjectionParams,
  AgentRunResultProjection,
  ExecuteToolCallsFn,
} from "./orchestrator-port.js";
