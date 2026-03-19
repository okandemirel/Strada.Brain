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
  readonly closureStatus?: "verified" | "partial" | "unverified";
  readonly openInvestigations?: readonly string[];
  readonly reviews?: {
    readonly security?: string;
    readonly code?: string;
    readonly simplify?: string;
  };
  readonly logStatus?: string;
}

export interface AutonomyBoundaryContext {
  readonly toolNames?: Iterable<string>;
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
4. The draft does not leave open runtime hypotheses, likely causes, or "remaining potential issues" that Strada should continue investigating internally.

Return JSON only:
{"decision":"approve"|"continue"|"replan"|"fail","summary":"short summary","findings":["..."],"requiredActions":["..."],"closureStatus":"verified"|"partial"|"unverified","openInvestigations":["..."],"reviews":{"security":"clean|issues|not_applicable","code":"clean|issues|not_applicable","simplify":"clean|issues|not_applicable"},"logStatus":"clean|issues|not_applicable"}`;

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
const COMPLETION_CLAIM_RE = /\b(?:done|fixed|resolved|successful(?:ly)?|succeeded|complete(?:d)?|verified|root cause|tamamlandı|doğrulandı)\b/iu;
const OPEN_INVESTIGATION_HEADING_RE = /^(?:#{1,6}\s*)?(?:remaining potential issues|potential issues|open investigations|possible causes|likely causes|next checks?)\b/imu;
const HEDGED_RUNTIME_RE = /\b(?:may|might|could|possibly|potential(?:ly)?|likely)\b.*\b(?:runtime|freeze|profiler|call stack|cpu usage|frame|performance|entity scan|memory)\b|\bif\b.{0,40}\b(?:continues|still happens|persists)\b/iu;
const FOLLOW_UP_CHECK_RE = /\b(?:inspect|check|profile|verify|confirm|investigat(?:e|ing))\b.*\b(?:profiler|call stack|cpu usage|runtime|frame|performance|freeze|entity scan|memory)\b/iu;
const PLAN_HEADING_RE = /^(?:#{1,6}\s*)?(?:plan|execution plan|approach|next steps?)\b/iu;
const INTAKE_HEADING_RE = /^(?:#{1,6}\s*)?(?:minimum inputs|requirements?|objective|scope|project health check)\b/iu;
const SUBGOAL_HEADING_RE = /^(?:#{1,6}\s*)?sub-?goal\b/iu;
const STRUCTURED_STEP_RE = /(?:^|\n)\s*(?:\d+\.\s+|[A-D]\)\s+|[-*]\s+)(?:run|read|inspect|search|trace|collect|get|locate|identify|check|verify|create|update|fix|branch|treat|add|remove|ask|confirm|clarify)\b/gimu;
const INTERNAL_PLAN_RE = /\b(?:execution-ready plan|execution plan|plan to fix|next step is|first step|second step|minimum inputs to proceed)\b/iu;
const EXPLICIT_PLAN_REQUEST_RE =
  /\b(?:show|share|outline|walk me through|review)\b.{0,24}\b(?:your|the)\b.{0,16}\b(?:plan|approach|steps?|checklist)\b.{0,40}\b(?:before|first|prior to)\b|\b(?:before|first)\b.{0,40}\b(?:touch|change|edit|write|implement|execute|proceed|run)\b.{0,20}\b(?:show|share|outline|review|walk me through)\b.{0,20}\b(?:your|the)?\s*(?:plan|approach|steps?|checklist)\b|\b(?:plan[ıi]|yaklaş[ıi]m[ıi]n[ıi]|yaklas[ıi]m[ıi]n[ıi]|ad[ıi]mlar[ıi]n[ıi])\b.{0,30}\b(?:önce|once)\b.{0,30}\b(?:göster|goster|paylaş|paylas|anlat)\b/iu;
const INTERNAL_ROLE_RE = /\b(?:executor|worker|provider|orchestrator|planner|reviewer|synthesizer)\b/iu;
const OPERATIONAL_SECTION_RE = /(?:^|\n)\s*[^\n:]{1,80}:\s*[^\n]+/gmu;
const OPERATIONAL_VERB_RE = /\b(?:run|use|call|search|read|inspect|trace|collect|get|locate|identify|check|verify|create|update|fix|branch|treat|add|remove|ask|confirm|clarify|review|analy[sz]e|reproduce|arat|ara|oku|incele|kontrol et|doğrula|teyit et|çıkar|bak)\b/giu;
const INTERNAL_TOOL_NAMES = [
  "file_read",
  "file_write",
  "file_edit",
  "file_delete",
  "file_rename",
  "glob_search",
  "grep_search",
  "list_directory",
  "code_search",
  "memory_search",
  "rag_search",
  "git_status",
  "git_diff",
  "git_log",
  "git_commit",
  "git_push",
  "dotnet_build",
  "dotnet_test",
  "shell_exec",
  "show_plan",
  "ask_user",
  "strada_analyze_project",
  "strada_create_module",
  "strada_create_component",
  "strada_create_mediator",
  "strada_create_system",
] as const;
const INTERNAL_TOOL_TOKEN_RE = new RegExp(`\\b(?:${INTERNAL_TOOL_NAMES.join("|")})\\b`, "giu");

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
  context: AutonomyBoundaryContext = {},
): string | null {
  const driftKind = classifyAutonomyDrift(draft, prompt, context);
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
      ? "[AUTONOMY REQUIRED] The current draft is an internal execution plan, tool checklist, or intake checklist, not a user-facing result."
      : "[AUTONOMY REQUIRED] The current draft hands the next step back to the user without surfacing a terminal blocker.",
    "Strada must continue autonomously here.",
    driftKind === "plan"
      ? "Do not surface internal plans, tool-run checklists, requirement-gathering checklists, or execution TODOs as the final user-facing reply unless the user explicitly asked for a plan."
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
    "If the draft says the build or code fix succeeded but still lists likely causes, remaining potential issues, or profiler/runtime checks that Strada should continue investigating, mark closureStatus as partial or unverified and keep the task internal.",
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
  const openInvestigations = decision?.openInvestigations?.filter(Boolean) ?? [];
  const reviews = decision?.reviews;
  const logLines = evidence.recentLogIssues.slice(-5).map((entry) => `- [${entry.level}] ${entry.message}`);
  const summary = decision?.summary?.trim() || "Strada's completion review is not clean yet.";
  const reviewLines = [
    reviews?.security ? `- Security review: ${reviews.security}` : null,
    reviews?.code ? `- Code review: ${reviews.code}` : null,
    reviews?.simplify ? `- Simplify review: ${reviews.simplify}` : null,
    decision?.logStatus ? `- Log review: ${decision.logStatus}` : null,
    decision?.closureStatus ? `- Closure status: ${decision.closureStatus}` : null,
  ].filter((line): line is string => Boolean(line));
  const nextAction = openInvestigations.length > 0
    ? "Finish the open investigations, confirm or eliminate the remaining runtime hypotheses, and only then declare DONE."
    : "Inspect the remaining console/log issues, perform the required security/code/simplify review work, run the relevant verification again if code changed, and continue. Do not declare DONE until this review comes back clean.";

  return [
    "[COMPLETION REVIEW REQUIRED] Strada's final review has not cleared this task yet.",
    summary,
    reviewLines.length > 0 ? `Review status:\n${reviewLines.join("\n")}` : "",
    findings.length > 0 ? `Findings:\n${findings.map((finding) => `- ${finding}`).join("\n")}` : "",
    openInvestigations.length > 0 ? `Open investigations:\n${openInvestigations.map((item) => `- ${item}`).join("\n")}` : "",
    requiredActions.length > 0 ? `Required actions:\n${requiredActions.map((action) => `- ${action}`).join("\n")}` : "",
    logLines.length > 0 ? `Recent log issues:\n${logLines.join("\n")}` : "",
    nextAction,
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
  if (draftLeavesOpenInvestigations(normalized)) {
    return evidence.totalStepCount > 0;
  }
  if (draftClaimsCompletion(normalized) && evidence.inspectionStepCount > 0) {
    return true;
  }
  return SCOPE_QUALIFIER_RE.test(normalized)
    && SCOPE_COMPLETION_VERB_RE.test(normalized)
    && evidence.totalStepCount > 0;
}

export function classifyAutonomyDrift(
  draft: string,
  prompt = "",
  context: AutonomyBoundaryContext = {},
): "none" | "user_deflection" | "plan" {
  const normalized = draft.trim();
  const firstLine = normalized.split("\n", 1)[0] ?? "";
  if (!normalized) {
    return "none";
  }
  if (USER_DEFLECTION_RE.test(normalized)) {
    return "user_deflection";
  }

  const structuredSteps = (normalized.match(STRUCTURED_STEP_RE) ?? []).length;
  const looksLikeInternalPlan = draftLooksLikeInternalPlanArtifact(normalized, context);
  const subGoalScaffolding = SUBGOAL_HEADING_RE.test(firstLine);
  const userAskedForPlan = userExplicitlyAskedForPlan(prompt);

  if (
    looksLikeInternalPlan
    && (structuredSteps >= 2 || subGoalScaffolding || draftLooksLikeInternalToolingChecklist(normalized, context))
    && !userAskedForPlan
  ) {
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
  return hasOpenReviewFindingsForDraft(decision);
}

export function hasOpenReviewFindingsForDraft(
  decision: CompletionReviewDecision | null,
  draft: string | null | undefined = "",
): boolean {
  if (!decision) {
    return true;
  }
  const openInvestigations = decision.openInvestigations?.filter(Boolean) ?? [];
  if (decision.closureStatus && decision.closureStatus !== "verified") {
    return true;
  }
  if (openInvestigations.length > 0) {
    return true;
  }
  if (decision.decision === "approve" && draftLeavesOpenInvestigations(draft)) {
    return true;
  }
  if (decision.decision === "approve") {
    return false;
  }
  return true;
}

export function draftLeavesOpenInvestigations(draft: string | null | undefined): boolean {
  const normalized = draft?.trim() ?? "";
  if (!normalized) {
    return false;
  }
  return OPEN_INVESTIGATION_HEADING_RE.test(normalized)
    || HEDGED_RUNTIME_RE.test(normalized)
    || FOLLOW_UP_CHECK_RE.test(normalized);
}

function draftClaimsCompletion(draft: string): boolean {
  return COMPLETION_CLAIM_RE.test(draft);
}

export function draftLooksLikeInternalPlanArtifact(
  draft: string,
  context: AutonomyBoundaryContext = {},
): boolean {
  const normalized = draft.trim();
  if (!normalized) {
    return false;
  }
  const firstLine = normalized.split("\n", 1)[0] ?? "";
  return INTERNAL_PLAN_RE.test(normalized)
    || PLAN_HEADING_RE.test(firstLine)
    || INTAKE_HEADING_RE.test(firstLine)
    || SUBGOAL_HEADING_RE.test(firstLine)
    || draftLooksLikeInternalToolingChecklist(normalized, context);
}

export function draftLooksLikeInternalToolingChecklist(
  draft: string,
  context: AutonomyBoundaryContext = {},
): boolean {
  const toolMentions = collectInternalToolMentions(draft, context.toolNames);
  const operationalSections = (draft.match(OPERATIONAL_SECTION_RE) ?? []).length;
  const operationalVerbs = (draft.match(OPERATIONAL_VERB_RE) ?? []).length;
  return toolMentions.size >= 2
    && (
      operationalSections >= 2
      || operationalVerbs >= 3
      || INTERNAL_ROLE_RE.test(draft)
    );
}

function collectInternalToolMentions(
  draft: string,
  dynamicToolNames?: Iterable<string>,
): Set<string> {
  const mentions = new Set((draft.match(INTERNAL_TOOL_TOKEN_RE) ?? []).map((token) => token.toLowerCase()));
  const dynamicPattern = buildDynamicToolTokenPattern(dynamicToolNames);
  if (!dynamicPattern) {
    return mentions;
  }

  const dynamicMatches = draft.match(dynamicPattern) ?? [];
  for (const token of dynamicMatches) {
    mentions.add(token.toLowerCase());
  }
  return mentions;
}

function buildDynamicToolTokenPattern(toolNames?: Iterable<string>): RegExp | null {
  const escaped = [...new Set(
    [...(toolNames ?? [])]
      .map((name) => name.trim())
      .filter((name) => name.length >= 3)
      .map((name) => escapeRegExp(name)),
  )];

  if (escaped.length === 0) {
    return null;
  }

  return new RegExp(`(?<![a-z0-9_])(?:${escaped.join("|")})(?![a-z0-9_])`, "giu");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
