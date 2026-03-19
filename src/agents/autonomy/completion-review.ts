import type { AgentState } from "../agent-state.js";
import type { VerificationState } from "./self-verification.js";
import type { LogEntry } from "../../utils/logger.js";

export interface CompletionReviewEvidence {
  readonly touchedFiles: readonly string[];
  readonly recentFailures: readonly string[];
  readonly recentLogIssues: readonly LogEntry[];
  readonly recentSteps: readonly string[];
  readonly totalStepCount: number;
  readonly inspectionStepCount: number;
  readonly verificationStepCount: number;
  readonly mutationStepCount: number;
  readonly verificationState: VerificationState;
}

export interface CompletionReviewDecision {
  readonly decision?: "approve" | "continue" | "replan" | "fail";
  readonly summary?: string;
  readonly findings?: readonly string[];
  readonly requiredActions?: readonly string[];
  readonly reviews?: {
    readonly security?: string;
    readonly code?: string;
    readonly simplify?: string;
  };
  readonly logStatus?: string;
}

export const COMPLETION_REVIEW_SYSTEM_PROMPT = `You are Strada Brain's completion reviewer.
The executing provider is not allowed to self-certify completion.
Review the evidence dynamically and decide whether Strada can consider the task complete.

Your review must explicitly cover:
- security review
- code review
- simplify review
- recent console/log errors or warnings

Approve only when:
1. Remaining failures are either resolved or honestly surfaced as blockers.
2. Recent console/log issues do not indicate unresolved errors.
3. The implementation is coherent, safe enough for the task, and not obviously overcomplicated.

Return JSON only:
{"decision":"approve"|"continue"|"replan"|"fail","summary":"short summary","findings":["..."],"requiredActions":["..."],"reviews":{"security":"clean|issues|not_applicable","code":"clean|issues|not_applicable","simplify":"clean|issues|not_applicable"},"logStatus":"clean|issues|not_applicable"}`;

const INSPECTION_TOOL_NAMES = new Set([
  "file_read",
  "list_directory",
  "search",
  "code_search",
  "memory_search",
  "rag_search",
  "agent_status",
  "strada_analyze_project",
]);

const MUTATION_TOOL_NAMES = new Set([
  "file_write",
  "file_edit",
  "file_manage",
  "strada_create_system",
  "strada_create_component",
  "strada_create_mediator",
  "strada_create_module",
]);

const USER_DEFLECTION_RE = /\b(?:what should i do|what do you want me to do|do you want me to|would you like me to|should i\b|ne yapmalıyım|ne yapayım|ister misin|ekran görüntüsü|screenshot)\b/iu;
const SCOPE_QUALIFIER_RE = /\b(?:all|every|entire|whole|full|tüm|hepsi|bütün)\b/iu;
const SCOPE_COMPLETION_VERB_RE = /\b(?:verified|reviewed|analy[sz]ed|complete(?:d)?|tamamlandı|doğrulandı|analiz(?:i)? tamamlandı)\b/iu;
const PLAN_HEADING_RE = /^(?:#{1,6}\s*)?(?:plan|execution plan|approach|next steps?)\b/iu;
const INTAKE_HEADING_RE = /^(?:#{1,6}\s*)?(?:minimum inputs|requirements?|objective|scope|project health check)\b/iu;
const STRUCTURED_STEP_RE = /(?:^|\n)\s*(?:\d+\.\s+|[A-D]\)\s+|[-*]\s+)(?:run|read|inspect|search|trace|collect|get|locate|identify|check|verify|create|update|fix|branch|treat|add|remove|ask|confirm|clarify)\b/gimu;
const INTERNAL_PLAN_RE = /\b(?:execution-ready plan|execution plan|plan to fix|next step is|first step|second step|minimum inputs to proceed)\b/iu;
const EXPLICIT_PLAN_REQUEST_RE = /\b(?:show|give|share|outline|plan|explain|walk me through)\b.{0,30}\b(?:plan|approach|steps?|game plan)\b|\b(?:what(?:'s| is)?|how)\b.{0,25}\b(?:your|the)\b.{0,20}\b(?:plan|approach)\b|\b(?:create|make|write)\b.{0,20}\b(?:a )?(?:plan|checklist)\b/iu;

export function collectCompletionReviewEvidence(params: {
  state: AgentState;
  verificationState: VerificationState;
  logEntries: readonly LogEntry[];
  chatId: string;
  taskStartedAtMs: number;
}): CompletionReviewEvidence {
  const touchedFiles = [...params.verificationState.touchedFiles].sort();
  const reviewCutoff = Math.max(
    params.taskStartedAtMs,
    params.verificationState.lastVerificationAt ?? params.taskStartedAtMs,
  );
  const recentFailures = params.state.stepResults
    .filter((step) => !step.success && step.timestamp >= reviewCutoff)
    .slice(-5)
    .map((step) => `${step.toolName}: ${step.summary}`);
  const recentSteps = params.state.stepResults
    .slice(-8)
    .map((step) => `[${step.success ? "OK" : "FAIL"}] ${step.toolName}: ${step.summary}`);
  const inspectionStepCount = params.state.stepResults.filter((step) => INSPECTION_TOOL_NAMES.has(step.toolName)).length;
  const verificationStepCount = params.state.stepResults.filter((step) => isVerificationStep(step.toolName, step.summary)).length;
  const mutationStepCount = params.state.stepResults.filter((step) => MUTATION_TOOL_NAMES.has(step.toolName)).length;

  return {
    touchedFiles,
    recentFailures,
    recentSteps,
    totalStepCount: params.state.stepResults.length,
    inspectionStepCount,
    verificationStepCount,
    mutationStepCount,
    recentLogIssues: params.logEntries
      .filter((entry) => isRelevantLogIssue(entry, params.chatId, reviewCutoff))
      .slice(-8),
    verificationState: params.verificationState,
  };
}

export function shouldRunCompletionReview(
  evidence: CompletionReviewEvidence,
  draft: string,
  prompt = "",
): boolean {
  return (
    evidence.touchedFiles.length > 0 ||
    evidence.recentFailures.length > 0 ||
    evidence.recentLogIssues.length > 0 ||
    draftNeedsReview(draft, evidence, prompt)
  );
}

export function buildAutonomyDeflectionGate(
  draft: string,
  evidence: CompletionReviewEvidence,
  prompt = "",
): string | null {
  const driftKind = classifyAutonomyDrift(draft, prompt);
  if (driftKind === "none") {
    return null;
  }

  const evidenceSummary = [
    `- Tool steps observed: ${evidence.totalStepCount}`,
    `- Inspection steps: ${evidence.inspectionStepCount}`,
    `- Verification steps: ${evidence.verificationStepCount}`,
  ].join("\n");

  return [
    driftKind === "plan"
      ? "[AUTONOMY REQUIRED] The current draft is an internal execution plan or intake checklist, not a user-facing result."
      : "[AUTONOMY REQUIRED] The current draft hands the next step back to the user without surfacing a terminal blocker.",
    "Strada must continue autonomously here.",
    driftKind === "plan"
      ? "Do not surface internal plans, requirement-gathering checklists, or execution TODOs as the final user-facing reply unless the user explicitly asked for a plan."
      : "Do not ask the user what to do next, request a screenshot, or ask them to choose between fix paths unless there is a real external blocker or a materially risky irreversible decision.",
    `Evidence so far:\n${evidenceSummary}`,
    "Inspect the relevant files/assets directly, use another provider/reviewer if needed, verify the concrete outcome, and only then return the result.",
  ].join("\n\n");
}

export function buildCompletionReviewRequest(params: {
  prompt: string;
  draft: string;
  state: AgentState;
  evidence: CompletionReviewEvidence;
}): string {
  const touchedFiles = formatList(params.evidence.touchedFiles, "(none)");
  const recentFailures = formatList(params.evidence.recentFailures, "(none)");
  const recentLogs = params.evidence.recentLogIssues.length > 0
    ? params.evidence.recentLogIssues
      .map((entry) => {
        const level = entry.level.toUpperCase();
        const metaChatId = typeof entry.meta?.["chatId"] === "string" ? ` chatId=${entry.meta["chatId"]}` : "";
        return `- [${level}] ${entry.message}${metaChatId}`;
      })
      .join("\n")
    : "(none)";
  const recentSteps = params.state.stepResults
    .slice(-8)
    .map((step) => `- [${step.success ? "OK" : "FAIL"}] ${step.toolName}: ${step.summary}`)
    .join("\n") || "(none)";

  return [
    "Evaluate whether Strada can safely accept completion.",
    "",
    `User request:\n${params.prompt}`,
    "",
    params.state.plan ? `Current plan:\n${params.state.plan}\n` : "Current plan:\n(none)\n",
    `Worker completion draft:\n${params.draft || "(empty)"}`,
    "",
    `Touched files:\n${touchedFiles}`,
    "",
    `Recent step results:\n${recentSteps}`,
    "",
    `Step coverage summary:\n- Total tool steps: ${params.evidence.totalStepCount}\n- Inspection steps: ${params.evidence.inspectionStepCount}\n- Verification steps: ${params.evidence.verificationStepCount}\n- Mutation steps: ${params.evidence.mutationStepCount}`,
    "",
    `Recent unresolved failures:\n${recentFailures}`,
    "",
    `Recent log issues since the latest clean verification:\n${recentLogs}`,
    "",
    "Reject unsupported scope claims. If the draft claims broad completion (for example all/everything/full analysis/verified) but the evidence is too thin, force continue or replan.",
    "Reject drafts that ask the user what to do next, ask for screenshots, or defer obvious next investigations back to the user without a real blocker.",
    "",
    "Decide whether Strada should approve completion, continue execution, or replan.",
  ].join("\n");
}

export function parseCompletionReviewDecision(text: string): CompletionReviewDecision | null {
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
      const parsed = JSON.parse(candidate) as CompletionReviewDecision;
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

export function buildCompletionReviewGate(
  decision: CompletionReviewDecision | null,
  evidence: CompletionReviewEvidence,
): string {
  const findings = decision?.findings?.filter(Boolean) ?? [];
  const requiredActions = decision?.requiredActions?.filter(Boolean) ?? [];
  const reviews = decision?.reviews;
  const logLines = evidence.recentLogIssues.slice(-5).map((entry) => `- [${entry.level}] ${entry.message}`);
  const summary = decision?.summary?.trim() || "Strada's completion review is not clean yet.";
  const reviewLines = [
    reviews?.security ? `- Security review: ${reviews.security}` : null,
    reviews?.code ? `- Code review: ${reviews.code}` : null,
    reviews?.simplify ? `- Simplify review: ${reviews.simplify}` : null,
    decision?.logStatus ? `- Log review: ${decision.logStatus}` : null,
  ].filter((line): line is string => Boolean(line));

  return [
    "[COMPLETION REVIEW REQUIRED] Strada's final review has not cleared this task yet.",
    summary,
    reviewLines.length > 0 ? `Review status:\n${reviewLines.join("\n")}` : "",
    findings.length > 0 ? `Findings:\n${findings.map((finding) => `- ${finding}`).join("\n")}` : "",
    requiredActions.length > 0 ? `Required actions:\n${requiredActions.map((action) => `- ${action}`).join("\n")}` : "",
    logLines.length > 0 ? `Recent log issues:\n${logLines.join("\n")}` : "",
    "Inspect the remaining console/log issues, perform the required security/code/simplify review work, run the relevant verification again if code changed, and continue. Do not declare DONE until this review comes back clean.",
  ]
    .filter((section) => section.length > 0)
    .join("\n\n");
}

function formatList(lines: readonly string[], fallback: string): string {
  return lines.length > 0 ? lines.map((line) => `- ${line}`).join("\n") : fallback;
}

function isRelevantLogIssue(entry: LogEntry, chatId: string, cutoffMs: number): boolean {
  const timestampMs = Date.parse(entry.timestamp);
  if (!Number.isFinite(timestampMs) || timestampMs < cutoffMs) {
    return false;
  }

  const level = entry.level.toLowerCase();
  if (level !== "warn" && level !== "error") {
    return false;
  }

  const entryChatId = typeof entry.meta?.["chatId"] === "string" ? entry.meta["chatId"] : null;
  if (entryChatId !== null) {
    return entryChatId === chatId;
  }

  return entry.message.includes(chatId);
}

function draftNeedsReview(
  draft: string,
  evidence: CompletionReviewEvidence,
  prompt = "",
): boolean {
  const normalized = draft.trim();
  if (!normalized) {
    return false;
  }
  if (classifyAutonomyDrift(normalized, prompt) !== "none") {
    return true;
  }
  return SCOPE_QUALIFIER_RE.test(normalized)
    && SCOPE_COMPLETION_VERB_RE.test(normalized)
    && evidence.totalStepCount > 0;
}

function classifyAutonomyDrift(
  draft: string,
  prompt = "",
): "none" | "user_deflection" | "plan" {
  const normalized = draft.trim();
  if (!normalized) {
    return "none";
  }
  if (USER_DEFLECTION_RE.test(normalized)) {
    return "user_deflection";
  }

  const firstLine = normalized.split("\n", 1)[0] ?? "";
  const looksLikePlanHeading = PLAN_HEADING_RE.test(firstLine) || INTAKE_HEADING_RE.test(firstLine);
  const structuredSteps = (normalized.match(STRUCTURED_STEP_RE) ?? []).length;
  const looksLikeInternalPlan = INTERNAL_PLAN_RE.test(normalized) || looksLikePlanHeading;
  const userAskedForPlan = userExplicitlyAskedForPlan(prompt);

  if (looksLikeInternalPlan && structuredSteps >= 2 && !userAskedForPlan) {
    return "plan";
  }

  return "none";
}

export function userExplicitlyAskedForPlan(prompt: string): boolean {
  return EXPLICIT_PLAN_REQUEST_RE.test(prompt.trim());
}

function isVerificationStep(toolName: string, summary: string): boolean {
  if (toolName === "shell_exec") {
    return /\b(?:test|build|check|lint|typecheck|verify|compile|tsc|eslint|vitest|jest|pytest)\b/iu.test(summary);
  }
  return /\b(?:build|test|check|verify|lint|typecheck|compile|smoke)\b/iu.test(toolName);
}

export function hasOpenReviewFindings(decision: CompletionReviewDecision | null): boolean {
  if (!decision) {
    return true;
  }
  if (decision.decision === "approve") {
    return false;
  }
  return true;
}
