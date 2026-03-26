import type { AgentState } from "./agent-state.js";
import { MUTATION_TOOLS, isVerificationToolName } from "./autonomy/constants.js";
import { isTerminalFailureReport } from "./autonomy/index.js";
import type { ProviderResponse } from "./providers/provider.interface.js";
import { redactSensitiveText } from "./orchestrator-text-utils.js";

const MAX_TOOL_RESULT_LENGTH = 8192;
const REFLECTION_DECISION_RE = /\*\*\s*(DONE_WITH_SUGGESTIONS|DONE|REPLAN|CONTINUE)\s*\*\*/;
const BLOCKING_STEP_FAILURE_RE = /\b(?:build|test|check|verify|lint|typecheck|compile|smoke|permission denied|access denied|workspace|read-only|validation|security)\b/iu;

export type ReflectionDecision = "CONTINUE" | "REPLAN" | "DONE" | "DONE_WITH_SUGGESTIONS";

const VALID_DECISIONS = new Set<ReflectionDecision>(["CONTINUE", "REPLAN", "DONE", "DONE_WITH_SUGGESTIONS"]);

/**
 * Replace a section delimited by XML markers in a prompt string.
 * Markers: `<!-- {tag}:start -->` and `<!-- {tag}:end -->`.
 * If markers are not found, appends the section.
 */
export function replaceSection(prompt: string, tag: string, newContent: string): string {
  const startMarker = `<!-- ${tag}:start -->`;
  const endMarker = `<!-- ${tag}:end -->`;
  const sanitized = newContent
    .replace(/<!--\s*[\w:-]+:start\s*-->/g, "")
    .replace(/<!--\s*[\w:-]+:end\s*-->/g, "");
  const startIdx = prompt.indexOf(startMarker);
  const endIdx = prompt.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1) {
    return prompt + `\n\n${startMarker}\n${sanitized}\n${endMarker}\n`;
  }
  return prompt.substring(0, startIdx) + startMarker + "\n" + sanitized + "\n" + endMarker + prompt.substring(endIdx + endMarker.length);
}

export function parseReflectionDecision(text: string | null | undefined): ReflectionDecision {
  if (!text) return "CONTINUE";
  const match = text.match(REFLECTION_DECISION_RE);
  if (match) return match[1] as ReflectionDecision;
  const lastLine = (text.trim().split("\n").pop() ?? "").toUpperCase() as ReflectionDecision;
  if (VALID_DECISIONS.has(lastLine)) return lastLine;
  return "CONTINUE";
}

export function validateReflectionDecision(
  decision: ReflectionDecision,
  state: AgentState,
): { decision: ReflectionDecision; overrideReason?: string } {
  if (decision !== "DONE" && decision !== "DONE_WITH_SUGGESTIONS") {
    return { decision };
  }
  // Evidence-based override: only blocking recent failures should keep the loop open.
  const recentSteps = state.stepResults.slice(-3);
  const blockingFailures = recentSteps.filter(isBlockingStepFailure);
  if (blockingFailures.length > 0) {
    return {
      decision: "CONTINUE",
      overrideReason: `DONE overridden: ${blockingFailures.length} blocking recent step(s) failed`,
    };
  }
  return { decision };
}

function isBlockingStepFailure(step: AgentState["stepResults"][number]): boolean {
  if (step.success) {
    return false;
  }

  if (MUTATION_TOOLS.has(step.toolName) || isVerificationToolName(step.toolName)) {
    return true;
  }

  if (step.errorCategory && BLOCKING_STEP_FAILURE_RE.test(step.errorCategory)) {
    return true;
  }

  return BLOCKING_STEP_FAILURE_RE.test(step.summary);
}

export function shouldSurfaceTerminalFailureFromReflection(response: ProviderResponse): boolean {
  return (
    response.stopReason === "end_turn" &&
    response.toolCalls.length === 0 &&
    isTerminalFailureReport(response.text)
  );
}

export function extractApproachSummary(state: AgentState): string {
  const recentSteps = state.stepResults.slice(-5);
  const tools = recentSteps.map((step) => step.toolName + "(" + (step.success ? "OK" : "FAIL") + ")").join(" → ");
  return (state.plan?.slice(0, 100) ?? "Unknown plan") + ": " + tools;
}

export function mergeLearnedInsights(
  base: readonly string[] | null | undefined,
  extra: readonly string[] | null | undefined,
): string[] {
  const merged = new Set<string>();
  for (const value of base ?? []) {
    const normalized = value.trim();
    if (normalized) {
      merged.add(normalized);
    }
  }
  for (const value of extra ?? []) {
    const normalized = value.trim();
    if (normalized) {
      merged.add(normalized);
    }
  }
  return [...merged].slice(-12);
}

export function normalizeFailureFingerprint(text: string | null | undefined): string {
  if (!text) {
    return "";
  }
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 180);
}

/** Sanitize tool input for learning events: cap size, strip API keys */
export function sanitizeEventInput(input: Record<string, unknown>): Record<string, unknown> {
  const serialized = JSON.stringify(input);
  if (serialized.length > 2048) {
    return { _truncated: true, _keys: Object.keys(input) };
  }
  const scrubbed = redactSensitiveText(serialized);
  return JSON.parse(scrubbed) as Record<string, unknown>;
}

/**
 * Sanitize tool results before feeding back to LLM.
 * Caps length and strips potential API key patterns.
 */
export function sanitizeToolResult(content: string, maxLength = MAX_TOOL_RESULT_LENGTH): string {
  let result = redactSensitiveText(content);
  if (result.length > maxLength) {
    result = result.substring(0, maxLength) + "\n... (truncated)";
  }
  return result;
}
