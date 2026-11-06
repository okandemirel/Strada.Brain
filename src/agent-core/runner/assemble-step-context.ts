/**
 * assembleStepContext — the step's context before its one model call (gauntlet #3,#4,#5):
 * prepareIteration, then the message-cap trim, then compaction. Extracted from
 * v2-agent-runner.ts, which is past the file-size limit (docs/contracts/file-size.md).
 */

import type { AgentState } from "../../agents/agent-state.js";
import type { RunnerMode } from "./agent-runner.js";
import type { OrchestratorPort, PreparedIteration, RunSetup } from "./orchestrator-port.js";

/** The v1 trim modes collapse to two; everything non-interactive trims as "background". */
function trimMode(mode: RunnerMode): "interactive" | "background" {
  return mode === "interactive" ? "interactive" : "background";
}

export function assembleStepContext(
  port: OrchestratorPort,
  setup: RunSetup,
  step: { readonly prompt: string; readonly state: AgentState; readonly mode: RunnerMode },
): PreparedIteration {
  const prepared = port.prepareIteration({
    prompt: step.prompt,
    identityKey: setup.identityKey,
    agentState: step.state,
    executionJournal: setup.executionJournal,
    systemPrompt: setup.systemPrompt,
    fallbackProvider: setup.fallbackProvider,
    toolTurnAffinity: null,
    enableGoalDetection: setup.enableGoalDetection,
    iterationHealth: setup.iterationHealth,
  });
  port.trimContextWindow(setup.session, trimMode(step.mode));
  port.maybeCompactSession(
    setup.session,
    prepared.currentAssignment.providerName,
    prepared.currentAssignment.modelId,
    // Everything the call sends besides the history: the turn context rides at its end.
    prepared.activePrompt + prepared.turnContext,
    prepared.currentToolDefinitions.reduce((chars, d) => chars + JSON.stringify(d).length, 0),
  );
  return prepared;
}
