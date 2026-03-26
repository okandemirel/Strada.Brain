/**
 * Reasoning Prompt Builder
 *
 * Constructs the prompt for AgentCore's LLM reasoning call.
 * The LLM sees observations, budget state, and learned patterns,
 * then decides what action to take.
 */

import type { AgentObservation } from "./observation-types.js";
import type { ActionDecision, ActionType, AdjustmentSpec } from "./agent-core-types.js";

const VALID_ACTIONS: readonly ActionType[] = ["execute", "wait", "notify", "escalate", "batch", "defer", "adjust"];

/**
 * Build the reasoning prompt from observations and context.
 */
export function buildReasoningPrompt(params: {
  observations: AgentObservation[];
  budgetRemainingPct: number;
  activeTaskCount: number;
  activeForegroundTaskCount: number;
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
    lines.push(`- [${obs.source}] (id: ${obs.id}, priority: ${obs.priority}) ${obs.summary}`);
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
    `- Foreground user tasks: ${params.activeForegroundTaskCount}`,
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
    "OR",
    "",
    "```json",
    '{ "action": "batch", "batchObservationIds": ["id1", "id2"], "goal": "combined goal for these observations", "reasoning": "why batch" }',
    "```",
    "",
    "OR",
    "",
    "```json",
    '{ "action": "defer", "deferMinutes": 15, "reasoning": "why defer — will re-check later" }',
    "```",
    "",
    "OR",
    "",
    "```json",
    '{ "action": "adjust", "adjustments": { "priorityThreshold": 50, "sourceBoost": { "source": "build", "delta": 10 }, "reasoningIntervalMs": 15000 }, "reasoning": "why adjust" }',
    "```",
    "",
    "Rules:",
    "- Prefer 'wait' when observations are low-priority or informational",
    "- Prefer 'execute' only for actionable, high-priority observations",
    "- Prefer 'notify' when the user should know about something but no action is needed",
    "- Prefer 'escalate' when you need user input to decide",
    "- Prefer 'batch' when multiple observations are related and should be handled together (max 20 IDs)",
    "- Prefer 'defer' when an observation is not urgent now but should be re-checked later (1-120 minutes)",
    "- Prefer 'adjust' to tune runtime parameters: priorityThreshold (0-100), sourceBoost per source, reasoningIntervalMs (5000-300000)",
    "- If budget is below 20%, only execute for critical issues (build failures, test failures)",
    "- If there are already active tasks, prefer waiting unless something urgent appeared",
    "- If a foreground user task is already running, avoid notify/escalate unless the situation is truly urgent and cannot wait",
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

  // Parse batchObservationIds (array of strings, max 20)
  let batchObservationIds: string[] | undefined;
  if (Array.isArray(obj.batchObservationIds)) {
    batchObservationIds = obj.batchObservationIds
      .filter((id): id is string => typeof id === "string")
      .slice(0, 20);
    if (batchObservationIds.length === 0) batchObservationIds = undefined;
  }

  // Parse deferMinutes (clamped 1-120)
  let deferMinutes: number | undefined;
  if (typeof obj.deferMinutes === "number" && !Number.isNaN(obj.deferMinutes)) {
    deferMinutes = Math.min(120, Math.max(1, Math.round(obj.deferMinutes)));
  }

  // Parse adjustments
  let adjustments: AdjustmentSpec | undefined;
  if (obj.adjustments && typeof obj.adjustments === "object") {
    const adj = obj.adjustments as Record<string, unknown>;
    const spec: AdjustmentSpec = {};

    if (typeof adj.priorityThreshold === "number" && !Number.isNaN(adj.priorityThreshold)) {
      spec.priorityThreshold = Math.min(100, Math.max(0, Math.round(adj.priorityThreshold)));
    }

    if (adj.sourceBoost && typeof adj.sourceBoost === "object") {
      const sb = adj.sourceBoost as Record<string, unknown>;
      if (typeof sb.source === "string" && typeof sb.delta === "number" && !Number.isNaN(sb.delta)) {
        spec.sourceBoost = { source: sb.source, delta: Math.min(50, Math.max(-50, Math.round(sb.delta))) };
      }
    }

    if (typeof adj.reasoningIntervalMs === "number" && !Number.isNaN(adj.reasoningIntervalMs)) {
      spec.reasoningIntervalMs = Math.min(300_000, Math.max(5_000, Math.round(adj.reasoningIntervalMs)));
    }

    if (Object.keys(spec).length > 0) adjustments = spec;
  }

  return {
    action: action as ActionDecision["action"],
    goal: typeof obj.goal === "string" ? obj.goal.slice(0, 2000) : undefined,
    message: typeof obj.message === "string" ? obj.message.slice(0, 2000) : undefined,
    question: typeof obj.question === "string" ? obj.question.slice(0, 2000) : undefined,
    reasoning: typeof obj.reasoning === "string" ? obj.reasoning.slice(0, 2000) : "No reasoning provided",
    batchObservationIds,
    deferMinutes,
    adjustments,
  };
}
