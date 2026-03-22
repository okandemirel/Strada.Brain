import type { AgentState } from "./agent-state.js";

/**
 * Builds a planning prompt that asks the LLM to create a numbered plan.
 * Optionally includes learned insights from previous iterations.
 * When enableGoalDetection is true, appends goal classification instructions
 * so the LLM can identify complex multi-step goals in the same call.
 */
export function buildPlanningPrompt(
  taskDescription: string,
  learnedInsights?: readonly string[],
  options?: { enableGoalDetection?: boolean },
): string {
  const lines: string[] = [
    "## PLAN Phase",
    "",
    "**Task type (identify before planning):** implementation | debugging | refactoring | explanation | Unity/ECS. Shape your approach accordingly.",
    "",
    "Create a detailed numbered plan to accomplish the following task:",
    "",
    taskDescription,
    "",
    "Provide a clear, step-by-step PLAN with numbered steps.",
    "Each step should be a concrete, actionable item.",
    "Start with one sentence stating your approach before listing steps.",
    "",
    "### Verification Protocol",
    "- After editing code or config, run the most relevant verification available (for example dotnet_build, dotnet_test, shell-based build/test/lint/typecheck, or a runtime smoke).",
    "- After bug fixes, verify the specific failing behavior is now clean, not just that the patch was applied.",
    "- If verification fails, keep iterating until it passes or you can clearly explain the blocker.",
    "- NEVER declare done based only on the patch; finish only after a relevant clean verification signal.",
    "",
    "### Error Recovery Order",
    "- When build/test fails, fix in dependency order: missing types → undefined symbols → type mismatches → logic errors.",
    "- After each fix, verify again. If stuck after 3 attempts, try a fundamentally different approach.",
  ];

  if (learnedInsights && learnedInsights.length > 0) {
    lines.push("", "### Learned Patterns", "");
    for (const insight of learnedInsights) {
      lines.push(`- ${insight}`);
    }
  }

  if (options?.enableGoalDetection) {
    lines.push(
      "",
      "### Goal Classification",
      "",
      "After creating the plan, evaluate if this request is a complex multi-step goal",
      "that would benefit from autonomous background execution (3+ steps, multiple tools, or",
      "significant time investment).",
      "",
      "If YES (complex goal worth autonomous execution), also output a goal tree:",
      "```goal",
      '{"isGoal": true, "estimatedMinutes": N, "nodes": [{"id": "s1", "task": "...", "dependsOn": []}]}',
      "```",
      "",
      "If NO (simple question, quick action, single tool call), do NOT output a goal block.",
      "Most messages are NOT goals. Only classify as a goal when the task genuinely requires",
      "multiple independent steps that benefit from background parallel execution.",
    );
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

  if (failCount > 0) {
    lines.push("**Root cause:** For each FAIL above, state the root cause in one sentence.", "");
  }

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
    "**Key insight from this iteration (one sentence):** What is the most important thing you learned?",
    "",
    "Based on the results above, state your reasoning then end with EXACTLY one of these on its own line:",
    "- **CONTINUE** - proceed with the current plan",
    "- **REPLAN** - the current approach needs a new plan",
    "- **DONE** - the task is complete",
    "- **DONE_WITH_SUGGESTIONS** - task complete, but include proactive next-step recommendations for the user",
    "",
    "Only use DONE_WITH_SUGGESTIONS after you have already completed and verified the user's requested work. Never use suggestions as a substitute for continuing the task.",
    "Only choose DONE or DONE_WITH_SUGGESTIONS when recent failures are resolved and the final state has a relevant clean verification signal.",
    "If a bug fix still has failing tool output, missing verification, or contradictory evidence, choose CONTINUE or REPLAN.",
    "Your final line MUST be one of: **CONTINUE**, **REPLAN**, **DONE**, or **DONE_WITH_SUGGESTIONS**",
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
    "The previous approach did not work. In one sentence, state WHY it failed and what root cause must change.",
    "Then create a fundamentally different plan that addresses that root cause.",
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

  if (state.lastReflection) {
    const reflection = state.lastReflection.length > 800
      ? state.lastReflection.slice(0, 800) + "..."
      : state.lastReflection;
    lines.push("", "### Last Reflection", "", reflection);
  }

  return lines.join("\n");
}
