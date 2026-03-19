import type { ToolExecutionResult } from "./tools/tool.interface.js";

export type InteractionReviewMode = "interactive" | "background";

export interface ShellCommandReviewDecision {
  decision?: "approve" | "reject";
  reason?: string;
  taskAligned?: boolean;
  bounded?: boolean;
}

const PLAN_PLACEHOLDER_PATTERN = /\b(todo|tbd|placeholder|fixme|fill in|coming soon|later)\b/i;
const PLAN_WAIT_PATTERN = /\b(wait for|wait on|ask user|user approval|get approval|request approval|confirm with user|before proceeding)\b/i;
const PLAN_EXECUTABLE_PATTERN = /\b(analy(?:se|ze)|inspect|read|search|trace|reproduce|implement|update|edit|write|refactor|run|test|verify|compare|document|review|check|measure|create|remove|rename|build|deploy)\b/i;
const PERMISSION_QUESTION_PATTERN = /\b(approve|approval|permission|okay|ok(?:ay)? to|should i|may i|can i|do you want me to|confirm|proceed|continue|go ahead|allowed)\b/i;
const AUTO_APPROVE_OPTION_PATTERN = /\b(approve|approved|continue|proceed|yes|ok|okay|go ahead|accept)\b/i;
const AUTO_REJECT_OPTION_PATTERN = /\b(reject|deny|cancel|stop|no)\b/i;
const SAFE_SHELL_SEGMENT_PATTERN =
  /^(?:npm\s+(?:test|run\s+(?:test|build|lint|typecheck)\b)|npx\s+(?:vitest|eslint|tsc)\b|git\s+(?:status|diff|log|show|branch|rev-parse)\b|(?:rg|ls|pwd|cat|head|tail|find|sed|wc|stat|grep|test)\b|(?:vitest|eslint|tsc)\b)/i;

export const SHELL_REVIEW_SYSTEM_PROMPT = `You are the shell safety arbiter for an autonomous coding agent.
Decide whether the proposed shell command should execute automatically.

Approve only when BOTH are true:
1. The command is clearly aligned with the stated task.
2. The command is bounded and normal for software work (build, test, lint, inspect, status, search, diff).

Reject when the command is unrelated, broad, destructive, secret-seeking, privilege-escalating, remote-code-executing, or otherwise unsafe.

Return JSON only:
{"decision":"approve"|"reject","reason":"short reason","taskAligned":true|false,"bounded":true|false}`;

export function normalizeInteractiveText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function pickAutonomousChoice(options: string[], recommended?: string): string {
  const normalizedRecommended = recommended?.trim().toLowerCase();
  if (normalizedRecommended) {
    const recommendedMatch = options.find((option) => option.toLowerCase() === normalizedRecommended);
    if (recommendedMatch) {
      return recommendedMatch;
    }
  }

  const preferred = options.find((option) => AUTO_APPROVE_OPTION_PATTERN.test(option));
  if (preferred) {
    return preferred;
  }

  const fallback = options.find((option) => !AUTO_REJECT_OPTION_PATTERN.test(option));
  return fallback ?? options[0] ?? "Continue";
}

export function reviewAutonomousPlan(
  input: Record<string, unknown>,
  mode: InteractionReviewMode,
): ToolExecutionResult {
  const summary = normalizeInteractiveText(input["summary"]);
  const reasoning = normalizeInteractiveText(input["reasoning"]);
  const steps = Array.isArray(input["steps"])
    ? input["steps"]
      .map((step) => normalizeInteractiveText(step))
      .filter((step) => step.length > 0)
    : [];
  const issues: string[] = [];
  const combinedText = [summary, reasoning, ...steps].filter((text) => text.length > 0);
  const duplicatedStepCount = new Set(steps.map((step) => step.toLowerCase())).size;

  if (summary.length < 12) {
    issues.push("summary is too vague");
  }
  if (steps.length === 0) {
    issues.push("steps are missing");
  }
  if (steps.some((step) => step.length < 8)) {
    issues.push("one or more steps are too short to execute");
  }
  if (combinedText.some((text) => PLAN_PLACEHOLDER_PATTERN.test(text))) {
    issues.push("plan contains placeholder language");
  }
  if (combinedText.some((text) => PLAN_WAIT_PATTERN.test(text))) {
    issues.push("plan still waits for user approval");
  }
  if (steps.length > 0 && duplicatedStepCount !== steps.length) {
    issues.push("steps repeat instead of progressing");
  }
  if (steps.length > 0 && !steps.some((step) => PLAN_EXECUTABLE_PATTERN.test(step))) {
    issues.push("steps are not concrete enough");
  }

  if (issues.length > 0) {
    return {
      content:
        `Autonomous plan review rejected (${mode} mode): ${issues.join("; ")}. ` +
        "Revise the plan with concrete, executable, non-interactive steps and continue without waiting for user approval.",
      isError: false,
    };
  }

  return {
    content:
      `Autonomous plan review passed (${mode} mode). The ${steps.length}-step plan is concrete, ` +
      "non-interactive, and executable. Proceed without waiting for user approval.",
    isError: false,
  };
}

export function reviewAutonomousQuestion(
  input: Record<string, unknown>,
  mode: InteractionReviewMode,
): ToolExecutionResult {
  const question = normalizeInteractiveText(input["question"]);
  const context = normalizeInteractiveText(input["context"]);
  const options = Array.isArray(input["options"])
    ? input["options"]
      .map((option) => normalizeInteractiveText(option))
      .filter((option) => option.length > 0)
    : [];
  const recommended = normalizeInteractiveText(input["recommended"]);
  const combinedText = [question, context, ...options].join(" ");
  const looksLikePermissionGate =
    PERMISSION_QUESTION_PATTERN.test(combinedText) ||
    (options.some((option) => AUTO_APPROVE_OPTION_PATTERN.test(option))
      && options.some((option) => AUTO_REJECT_OPTION_PATTERN.test(option)));

  if (!question) {
    return {
      content:
        `Autonomous question review rejected (${mode} mode): question is missing. ` +
        "Do not wait for user input. Make the safest reasonable assumption from the task context and continue.",
      isError: false,
    };
  }

  if (options.length > 0) {
    const choice = pickAutonomousChoice(options, recommended);
    const rationale = looksLikePermissionGate
      ? "this is a permission/confirmation gate, not a true blocker"
      : "no interactive user is available in this execution mode";
    return {
      content:
        `Autonomous question review (${mode} mode): ${rationale}. ` +
        `Selected "${choice}" and approved continued execution.`,
      isError: false,
    };
  }

  return {
    content:
      `Autonomous question review (${mode} mode): no interactive user is available. ` +
      "Make the safest reasonable assumption, state it briefly, and continue without waiting.",
    isError: false,
  };
}

export function formatRequestedPlan(input: Record<string, unknown>): string | null {
  const summary = normalizeInteractiveText(input["summary"]);
  const reasoning = normalizeInteractiveText(input["reasoning"]);
  const steps = Array.isArray(input["steps"])
    ? input["steps"]
      .map((step) => normalizeInteractiveText(step))
      .filter((step) => step.length > 0)
    : [];

  if (!summary || steps.length === 0) {
    return null;
  }

  const sections = [`Plan: ${summary}`, "", "Steps:"];
  for (const [index, step] of steps.entries()) {
    sections.push(`${index + 1}. ${step}`);
  }
  if (reasoning) {
    sections.push("", `Reasoning: ${reasoning}`);
  }
  return sections.join("\n");
}

export function parseShellReviewDecision(text: string): ShellCommandReviewDecision | null {
  const trimmed = text.trim();
  const candidates = [
    trimmed,
    trimmed.replace(/^```json\s*/i, "").replace(/```$/i, "").trim(),
  ];
  const braceStart = trimmed.indexOf("{");
  const braceEnd = trimmed.lastIndexOf("}");
  if (braceStart >= 0 && braceEnd > braceStart) {
    candidates.push(trimmed.slice(braceStart, braceEnd + 1));
  }

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    try {
      const parsed = JSON.parse(candidate) as ShellCommandReviewDecision;
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {
      // Try the next candidate format.
    }
  }

  return null;
}

export function isSafeShellFallback(command: string): boolean {
  const normalized = command.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.includes("|") || normalized.includes(";") || normalized.includes("||")) {
    return false;
  }
  if (/(^|[^&])&([^&]|$)/.test(normalized)) {
    return false;
  }

  const segments = normalized
    .split(/\s*&&\s*/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  return segments.length > 0 && segments.every((segment) => SAFE_SHELL_SEGMENT_PATTERN.test(segment));
}
