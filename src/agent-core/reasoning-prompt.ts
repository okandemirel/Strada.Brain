/**
 * Reasoning Prompt Builder
 *
 * Constructs the prompt for AgentCore's LLM reasoning call.
 * The LLM sees observations, budget state, and learned patterns,
 * then decides what action to take.
 */

import type { AgentObservation } from "./observation-types.js";
import type { ActionDecision, ActionType } from "./agent-core-types.js";

const VALID_ACTIONS: readonly ActionType[] = ["execute", "wait", "notify", "escalate"];

/**
 * Build the reasoning prompt from observations and context.
 */
export function buildReasoningPrompt(params: {
  observations: AgentObservation[];
  budgetRemainingPct: number;
  activeTaskCount: number;
  learnedInsights: string[];
  recentHistory: readonly AgentObservation[];
}): string {
  const lines: string[] = [
    "## Agent Reasoning",
    "",
    "You are an autonomous agent. Review the observations below and decide what to do.",
    "",
    "### Current Observations",
    "",
  ];

  for (const obs of params.observations.slice(0, 10)) {
    lines.push(`- [${obs.source}] (priority: ${obs.priority}) ${obs.summary}`);
  }

  lines.push("");

  if (params.learnedInsights.length > 0) {
    lines.push("### Learned Patterns", "");
    for (const insight of params.learnedInsights.slice(0, 5)) {
      lines.push(`- ${insight}`);
    }
    lines.push("");
  }

  lines.push(
    "### Status",
    `- Budget remaining: ${params.budgetRemainingPct}%`,
    `- Active tasks: ${params.activeTaskCount}`,
    "",
  );

  if (params.recentHistory.length > 0) {
    lines.push("### Recent Actions (last 5)", "");
    for (const h of params.recentHistory.slice(-5)) {
      lines.push(`- [${h.source}] ${h.summary}`);
    }
    lines.push("");
  }

  lines.push(
    "### Decision",
    "",
    "Based on the above, respond with EXACTLY one JSON block:",
    "",
    "```json",
    '{ "action": "execute", "goal": "description of what to do", "reasoning": "why" }',
    "```",
    "",
    "OR",
    "",
    "```json",
    '{ "action": "wait", "reasoning": "why nothing needs doing right now" }',
    "```",
    "",
    "OR",
    "",
    "```json",
    '{ "action": "notify", "message": "what to tell the user", "reasoning": "why" }',
    "```",
    "",
    "OR",
    "",
    "```json",
    '{ "action": "escalate", "question": "what to ask the user", "reasoning": "why" }',
    "```",
    "",
    "Rules:",
    "- Prefer 'wait' when observations are low-priority or informational",
    "- Prefer 'execute' only for actionable, high-priority observations",
    "- Prefer 'notify' when the user should know about something but no action is needed",
    "- Prefer 'escalate' when you need user input to decide",
    "- If budget is below 20%, only execute for critical issues (build failures, test failures)",
    "- If there are already active tasks, prefer waiting unless something urgent appeared",
  );

  return lines.join("\n");
}

/**
 * Parse the LLM's reasoning response into an ActionDecision.
 * Returns a 'wait' decision on parse failure (safe default).
 */
export function parseReasoningResponse(text: string | null | undefined): ActionDecision {
  if (!text) {
    return { action: "wait", reasoning: "No response from LLM" };
  }

  // Extract JSON block
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (!jsonMatch?.[1]) {
    // Try bare JSON
    const bareMatch = text.match(/\{[\s\S]*"action"[\s\S]*\}/);
    if (!bareMatch) {
      return { action: "wait", reasoning: "Could not parse LLM response" };
    }
    try {
      return validateDecision(JSON.parse(bareMatch[0]));
    } catch {
      return { action: "wait", reasoning: "JSON parse failed" };
    }
  }

  try {
    return validateDecision(JSON.parse(jsonMatch[1].trim()));
  } catch {
    return { action: "wait", reasoning: "JSON parse failed" };
  }
}

function validateDecision(raw: unknown): ActionDecision {
  if (!raw || typeof raw !== "object") {
    return { action: "wait", reasoning: "Invalid response shape" };
  }

  const obj = raw as Record<string, unknown>;
  const action = String(obj.action ?? "wait");

  if (!VALID_ACTIONS.includes(action as ActionType)) {
    return { action: "wait", reasoning: `Unknown action: ${action}` };
  }

  return {
    action: action as ActionDecision["action"],
    goal: typeof obj.goal === "string" ? obj.goal : undefined,
    message: typeof obj.message === "string" ? obj.message : undefined,
    question: typeof obj.question === "string" ? obj.question : undefined,
    reasoning: typeof obj.reasoning === "string" ? obj.reasoning : "No reasoning provided",
  };
}
