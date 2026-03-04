import type { AgentState } from "./agent-state.js";

/**
 * Builds a planning prompt that asks the LLM to create a numbered plan.
 * Optionally includes learned insights from previous iterations.
 */
export function buildPlanningPrompt(
  taskDescription: string,
  learnedInsights?: readonly string[],
): string {
  const lines: string[] = [
    "## PLAN Phase",
    "",
    "Create a detailed numbered plan to accomplish the following task:",
    "",
    taskDescription,
    "",
    "Provide a clear, step-by-step PLAN with numbered steps.",
    "Each step should be a concrete, actionable item.",
  ];

  if (learnedInsights && learnedInsights.length > 0) {
    lines.push("", "### Learned Patterns", "");
    for (const insight of learnedInsights) {
      lines.push(`- ${insight}`);
    }
  }

  return lines.join("\n");
}

/**
 * Builds a reflection prompt showing recent step results and asking
 * the LLM to decide whether to CONTINUE, REPLAN, or mark DONE.
 */
export function buildReflectionPrompt(state: AgentState): string {
  const lines: string[] = ["## Reflection Phase", ""];

  // Show last 5 step results
  const recentSteps = state.stepResults.slice(-5);
  if (recentSteps.length > 0) {
    lines.push("### Recent Step Results", "");
    for (const step of recentSteps) {
      const status = step.success ? "OK" : "FAIL";
      lines.push(`- [${status}] ${step.toolName}: ${step.summary}`);
    }
    lines.push("");
  }

  // Success/failure counts across all steps
  const successCount = state.stepResults.filter((s) => s.success).length;
  const failCount = state.stepResults.filter((s) => !s.success).length;
  lines.push(`Results: ${successCount} success, ${failCount} failures.`, "");

  // Consecutive error warning
  if (state.consecutiveErrors >= 3) {
    lines.push(
      "**WARNING**: Current approach is not working " +
        `(${state.consecutiveErrors} consecutive errors). Consider replanning.`,
      "",
    );
  }

  // Failed approaches
  if (state.failedApproaches.length > 0) {
    lines.push("### Failed Approaches (do NOT repeat these)", "");
    for (const approach of state.failedApproaches) {
      lines.push(`- ${approach}`);
    }
    lines.push("");
  }

  lines.push(
    "Based on the results above, respond with one of:",
    "- **CONTINUE** - proceed with the current plan",
    "- **REPLAN** - the current approach needs a new plan",
    "- **DONE** - the task is complete",
  );

  return lines.join("\n");
}

/**
 * Builds a replanning prompt showing what failed and asking for
 * a fundamentally different approach.
 */
export function buildReplanningPrompt(state: AgentState): string {
  const lines: string[] = ["## Replanning Phase", ""];

  if (state.plan) {
    lines.push("### Original Plan", "", state.plan, "");
  }

  if (state.failedApproaches.length > 0) {
    lines.push("### Failed Approaches", "");
    for (const approach of state.failedApproaches) {
      lines.push(`- ${approach}`);
    }
    lines.push("");
  }

  if (state.lastReflection) {
    lines.push("### Last Reflection", "", state.lastReflection, "");
  }

  lines.push(
    "The previous approach did not work. Create a fundamentally different plan.",
    "Avoid repeating any of the failed approaches listed above.",
    "Provide a new numbered plan with a different strategy.",
  );

  return lines.join("\n");
}

/**
 * Builds execution context showing the current plan and iteration.
 * Returns empty string if no plan exists.
 */
export function buildExecutionContext(state: AgentState): string {
  if (state.plan === null) {
    return "";
  }

  const lines: string[] = [
    "## Current Plan",
    "",
    state.plan,
    "",
    `Current iteration: ${state.iteration}`,
  ];

  return lines.join("\n");
}
