import type { AgentState } from "../agent-state.js";
import type { VerificationState } from "./self-verification.js";
import type { LogEntry } from "../../utils/logger.js";

export interface CompletionReviewEvidence {
  readonly touchedFiles: readonly string[];
  readonly recentFailures: readonly string[];
  readonly recentLogIssues: readonly LogEntry[];
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

  return {
    touchedFiles,
    recentFailures,
    recentLogIssues: params.logEntries
      .filter((entry) => isRelevantLogIssue(entry, params.chatId, reviewCutoff))
      .slice(-8),
    verificationState: params.verificationState,
  };
}

export function shouldRunCompletionReview(evidence: CompletionReviewEvidence): boolean {
  return (
    evidence.touchedFiles.length > 0 ||
    evidence.recentFailures.length > 0 ||
    evidence.recentLogIssues.length > 0
  );
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
    `Recent unresolved failures:\n${recentFailures}`,
    "",
    `Recent log issues since the latest clean verification:\n${recentLogs}`,
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

export function hasOpenReviewFindings(decision: CompletionReviewDecision | null): boolean {
  if (!decision) {
    return true;
  }
  if (decision.decision === "approve") {
    return false;
  }
  return true;
}
