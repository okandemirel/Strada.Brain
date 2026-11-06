/**
 * Agent Core v2 — engine prepare-iteration (relocation Step 3; blueprint: project_v2_engine_relocation).
 *
 * The per-iteration setup the port's prepareIteration binding runs on EVERY step: resolve the
 * execution strategy (or honor a fixed pin), build the phase-aware active prompt + supervisor role
 * prompt, resolve the tool-turn assignment/provider, and compute the tool definitions. Moved
 * VERBATIM from orchestrator.ts (mechanical this.X → deps.X / imported pure helper).
 *
 * Import rule (cycle safety): orchestrator-FREE leaves only — the supervisor-routing helpers and
 * buildPhasePromptSection are all orchestrator-free; buildWorkerToolDefinitions is shell-stateful
 * (tool registry) so it is injected as a callback.
 */

import type { IAIProvider } from "../../agents/providers/provider.interface.js";
import type { AgentState } from "../../agents/agent-state.js";
import type { AgentPhase } from "../../agents/agent-state.js";
import type { ExecutionJournal } from "../../agents/autonomy/execution-journal.js";
import type { IterationHealthTracker } from "../../agents/iteration-health-tracker.js";
import type { TaskClassification } from "../routing/routing-types.js";
import type { JsonObject } from "../../types/index.js";
import {
  buildSupervisorExecutionStrategy as buildSupervisorExecutionStrategyHelper,
  getPinnedToolTurnAssignment as getPinnedToolTurnAssignmentHelper,
  buildSupervisorRolePrompt as buildSupervisorRolePromptHelper,
  type SupervisorRoutingContext,
  type SupervisorAssignment,
  type SupervisorExecutionStrategy,
} from "../../agents/orchestrator-supervisor-routing.js";
import { buildPhasePromptSection } from "../../agents/orchestrator-loop-utils.js";

/**
 * The "Provider Health Awareness" system-prompt section, present only after a failure.
 *
 * audited 2026-09-02: the previous text told the model to watch for "[Provider Health Report]"
 * messages — a string only `IterationHealthTracker.buildSessionHealthContext` produced, whose
 * every caller was deleted with the v1 engine. The section now names the signals that really
 * reach the model: this live count, and the reflection prompt's `**PROVIDER HEALTH**` line.
 */
export function buildProviderHealthAwareness(
  health: Pick<IterationHealthTracker, "getTotalFailures" | "getFailureRate">,
): string | undefined {
  const failures = health.getTotalFailures();
  if (failures <= 0) return undefined;
  const ratePct = (health.getFailureRate() * 100).toFixed(0);
  return `\n\n## Provider Health Awareness\nThe AI provider has experienced ${failures} failure(s) during this task (current failure rate: ${ratePct}%). This count and the **PROVIDER HEALTH** line in reflection prompts are the health signal you receive; there is no separate health report message. Adapt your approach: use fewer tool calls per step, simplify complex operations, and consider providing partial results if the provider remains unstable. Your goal is to deliver the best possible result despite infrastructure challenges.`;
}

export interface WorkerToolDefinition {
  name: string;
  description: string;
  input_schema: JsonObject;
}

/** The dependency slice prepare-iteration reads (grows only with this module). */
export interface PrepareIterationDeps {
  /** Shell callback — the supervisor routing context (shared with the accounting cluster). */
  readonly getSupervisorRoutingContext: () => SupervisorRoutingContext;
  /** Shell callback — the tool registry is shell state (toolDefinitions + toolMetadataByName). */
  readonly buildWorkerToolDefinitions: (
    task: TaskClassification,
    phase: AgentPhase,
    role: SupervisorAssignment["role"],
  ) => WorkerToolDefinition[];
}

export interface PrepareIterationParams {
  prompt: string;
  identityKey: string;
  agentState: AgentState;
  executionJournal: ExecutionJournal;
  systemPrompt: string;
  fallbackProvider: IAIProvider;
  toolTurnAffinity: SupervisorAssignment | null;
  projectWorldFingerprint?: string;
  enableGoalDetection: boolean;
  fixedExecutionStrategy?: SupervisorExecutionStrategy;
  /** Optional: inject health awareness into the prompt when failures have occurred. */
  iterationHealth?: IterationHealthTracker;
}

export interface PreparedIteration {
  executionStrategy: SupervisorExecutionStrategy;
  activePrompt: string;
  currentAssignment: SupervisorAssignment;
  currentProvider: IAIProvider;
  currentToolDefinitions: WorkerToolDefinition[];
  currentToolNames: string[];
}

export function prepareIteration(
  deps: PrepareIterationDeps,
  params: PrepareIterationParams,
): PreparedIteration {
  const executionStrategy =
    params.fixedExecutionStrategy ??
    buildSupervisorExecutionStrategyHelper(
      deps.getSupervisorRoutingContext(),
      params.prompt,
      params.identityKey,
      params.fallbackProvider,
      params.projectWorldFingerprint,
    );

  let activePrompt =
    params.systemPrompt +
    buildPhasePromptSection(params.agentState, params.executionJournal, {
      enableGoalDetection: params.enableGoalDetection,
    });

  const currentAssignment = getPinnedToolTurnAssignmentHelper(
    executionStrategy,
    params.agentState.phase,
    params.toolTurnAffinity,
  );
  const currentProvider = currentAssignment.provider;
  const currentToolDefinitions = deps.buildWorkerToolDefinitions(
    executionStrategy.task,
    params.agentState.phase,
    currentAssignment.role,
  );
  const currentToolNames = currentToolDefinitions.map((d) => d.name);
  activePrompt += buildSupervisorRolePromptHelper(deps.getSupervisorRoutingContext(), executionStrategy, currentAssignment);

  // Append provider health awareness when failures have occurred during this task.
  const healthAwareness = params.iterationHealth && buildProviderHealthAwareness(params.iterationHealth);
  if (healthAwareness) activePrompt += healthAwareness;

  return {
    executionStrategy,
    activePrompt,
    currentAssignment,
    currentProvider,
    currentToolDefinitions,
    currentToolNames,
  };
}
