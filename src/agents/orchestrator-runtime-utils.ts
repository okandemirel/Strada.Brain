import type { AgentState } from "./agent-state.js";
import { MUTATION_TOOLS, isVerificationToolName } from "./autonomy/constants.js";
import { isTerminalFailureReport } from "./autonomy/index.js";
import type { ProviderResponse } from "./providers/provider.interface.js";
import { redactSensitiveText } from "./orchestrator-text-utils.js";

const MAX_TOOL_RESULT_LENGTH = 8192;
const REFLECTION_DECISION_RE = /\*\*\s*(DONE_WITH_SUGGESTIONS|DONE|REPLAN|CONTINUE)\s*\*\*/;
const BLOCKING_STEP_FAILURE_RE = /\b(?:build|test|check|verify|lint|typecheck|compile|smoke|permission denied|access denied|read-only|validation|security)\b/iu;
/** Failures caused by external abort signals — these should not block PAOR DONE decisions */
const ABORT_CAUSED_FAILURE_RE = /\bAborted\b|Task cancelled/i;
/** Tool unavailability or generic execution failures — not blocking because the agent cannot fix them */
const NON_BLOCKING_TOOL_FAILURE_RE = /\bunavailable\b|Tool execution failed|\bInvalid argument\b|\bECONNREFUSED\b|bridge.*(disconnect|unavailable)/i;

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

/**
 * Maximum times the PAOR loop can override DONE→CONTINUE before escalating
 * to REPLAN. Prevents infinite retry loops that burn tokens without progress
 * (OpenClaw-inspired: cap retries, then change strategy).
 */
const MAX_REFLECTION_OVERRIDES = 2;

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
    // Cap: after MAX_REFLECTION_OVERRIDES, escalate to REPLAN instead of
    // CONTINUE to avoid burning tokens on the same failing approach.
    if (state.reflectionOverrideCount >= MAX_REFLECTION_OVERRIDES) {
      return {
        decision: "REPLAN",
        overrideReason: `DONE overridden→REPLAN: ${blockingFailures.length} blocking failure(s) persist after ${state.reflectionOverrideCount} override(s) — changing strategy`,
      };
    }
    return {
      decision: "CONTINUE",
      overrideReason: `DONE overridden: ${blockingFailures.length} blocking recent step(s) failed (override ${state.reflectionOverrideCount + 1}/${MAX_REFLECTION_OVERRIDES})`,
    };
  }
  return { decision };
}

function isBlockingStepFailure(step: AgentState["stepResults"][number]): boolean {
  if (step.success) {
    return false;
  }

  if (ABORT_CAUSED_FAILURE_RE.test(step.summary)) {
    return false;
  }

  if (NON_BLOCKING_TOOL_FAILURE_RE.test(step.summary)) {
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

// =============================================================================
// PROVIDER FAILURE CIRCUIT BREAKER
// =============================================================================

const PROVIDER_FAILURE_LIMIT = 8;
export const QUOTA_LIMIT_RE = /quota|limit|billing|cycle|exceeded|usage/i;

/**
 * Detect synthetic empty responses from silentStream provider failures.
 * Returns "abort" when the failure limit is reached, "warn_continue" for
 * intermediate failures, and "ok" for real responses.
 */
export function checkProviderFailureCircuitBreaker(
  response: ProviderResponse,
  consecutiveFailures: number,
): { action: "abort" | "warn_continue" | "ok" } {
  const isEmpty = response.text === "" && response.toolCalls.length === 0
    && (response.usage.totalTokens === 0 || response.usage.outputTokens === 0);
  if (isEmpty) {
    const newCount = consecutiveFailures + 1;
    return newCount >= PROVIDER_FAILURE_LIMIT
      ? { action: "abort" }
      : { action: "warn_continue" };
  }
  return { action: "ok" };
}

/**
 * Route a provider error to the appropriate ProviderHealthRegistry method.
 * Matches the same quota-detection logic used in fallback-chain.ts.
 */
export function recordProviderHealthFailure(
  registry: { recordFailure(name: string, error: string): void; recordQuotaExhausted(name: string, error: string): void },
  providerName: string,
  errorMsg: string,
): void {
  if (/\b403\b/.test(errorMsg) && QUOTA_LIMIT_RE.test(errorMsg)) {
    registry.recordQuotaExhausted(providerName, errorMsg);
  } else {
    registry.recordFailure(providerName, errorMsg);
  }
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
