/**
 * Agent Core v2 — Runner seam public surface (ARCHITECTURE §4.1–§4.2).
 *
 * The engine boundary: the `AgentRunner` façade + its I/O contract, the `V2AgentRunner`
 * spine, the runner factory, and the `LEGAL_FLAG_SETS` matrix with its reject-at-boot
 * validator. Cutover Step 5 deleted the v1 pass-through — the V2 spine is THE engine.
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

export { toWorkerRunResult } from "./agent-runner.js";

export {
  LEGAL_FLAG_SETS,
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
