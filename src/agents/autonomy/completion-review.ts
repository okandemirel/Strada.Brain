import type { AgentState } from "../agent-state.js";
import type { VerificationState } from "./self-verification.js";
import type { LogEntry } from "../../utils/logger.js";
import { analyzePromptTargets } from "../prompt-targets.js";

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

export type CompletionReviewStageName = "code" | "simplify" | "security";
export type CompletionReviewStageStatus = "clean" | "issues" | "not_applicable";

export interface CompletionReviewStageResult {
  readonly stage: CompletionReviewStageName;
  readonly status: CompletionReviewStageStatus;
  readonly summary?: string;
  readonly findings?: readonly string[];
  readonly requiredActions?: readonly string[];
  readonly openInvestigations?: readonly string[];
}

export interface AutonomyBoundaryContext {
  readonly toolNames?: Iterable<string>;
}




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

const USER_DEFLECTION_RE =
  /\b(?:what should i do|what do you want me to do|do you want me to|would you like me to|should i\b|which direction|which path|want me to start on|next steps? available|ready for whichever direction|ready for whatever direction|ister misin|ne yapmalıyım|ne yapayım|ekran görüntüsü|screenshot)\b/iu;
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
const EXPLICIT_COMPLETION_REVIEW_REQUEST_RE =
  /\b(?:full|final|complete|thorough|strict)\b.{0,24}\b(?:review|verification|validation|audit|check)\b|\b(?:review|verification|validation|audit|check)\b.{0,24}\b(?:before|prior to|until|only after|after)\b.{0,24}\b(?:finish|complete|finalize|declare done|return|ship)\b|\b(?:finish|complete|finalize|declare done|return|ship)\b.{0,24}\b(?:only after|after|until)\b.{0,24}\b(?:review|verification|validation|audit|check)\b|\b(?:tam\s+inceleme|tam\s+doğrulama|tam\s+kontrol|kapsamlı\s+inceleme|kapsamlı\s+doğrulama)\b|\b(?:inceleme|doğrulama|kontrol|denetim)\b.{0,24}\b(?:önce|olmadan|bitirmeden|tamamlamadan)\b.{0,24}\b(?:bitir|tamamla|kapat|dön)\b|\b(?:bitir|tamamla|kapat|dön)\b.{0,24}\b(?:önce|olmadan|sonra)\b.{0,24}\b(?:inceleme|doğrulama|kontrol|denetim)\b/iu;
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
const SAFE_BOUNDED_DIRECT_OPERATION_TOOLS = new Set([
  "list_directory",
  "glob_search",
  "grep_search",
  "find_file",
  "file_read",
  "file_write",
  "file_edit",
  "file_delete",
  "file_manage",
  "shell_exec",
]);

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
  // Always run completion review when Unity console errors exist
  if (evidence.verificationState.unityConsoleErrors?.length > 0) {
    return true;
  }
  if (isLowRiskMutationFootprint(evidence, draft, prompt)) {
    return false;
  }
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
  if (userExplicitlyAskedForCompletionReview(prompt)) {
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

function isLowRiskMutationFootprint(
  evidence: CompletionReviewEvidence,
  draft: string,
  prompt = "",
): boolean {
  const directTargetProfile = analyzePromptTargets(prompt);
  const boundedDirectTargetOperation = isBoundedDirectTargetOperation(evidence, directTargetProfile);
  const hasMutationEvidence = evidence.mutationStepCount > 0 || boundedDirectTargetOperation;
  const hasTargetEvidence =
    evidence.touchedFiles.length > 0
    || (boundedDirectTargetOperation && directTargetProfile.hasExplicitTargets);

  if (!hasTargetEvidence || !hasMutationEvidence) {
    return false;
  }
  if (evidence.verificationState.hasCompilableChanges) {
    return false;
  }
  if (evidence.recentFailures.length > 0 || evidence.recentLogIssues.length > 0) {
    return false;
  }
  if (
    evidence.mutationStepCount > (boundedDirectTargetOperation ? 3 : 1)
    || evidence.verificationStepCount > 0
  ) {
    return false;
  }
  if (
    evidence.inspectionStepCount > (boundedDirectTargetOperation ? 4 : 2)
    || evidence.totalStepCount > (boundedDirectTargetOperation ? 8 : 4)
  ) {
    return false;
  }

  if (
    boundedDirectTargetOperation
    && (!directTargetProfile.isBoundedTargetSet || directTargetProfile.hasCompilableTarget)
  ) {
    return false;
  }

  const normalized = draft.trim();
  if (!normalized) {
    return false;
  }

  return !draftNeedsReview(normalized, evidence, prompt);
}

function isBoundedDirectTargetOperation(
  evidence: CompletionReviewEvidence,
  profile: ReturnType<typeof analyzePromptTargets>,
): boolean {
  if (!profile.hasExplicitTargets || !profile.isBoundedTargetSet) {
    return false;
  }
  if (!profile.hasEphemeralRootTarget || !profile.allTargetsNonCompilable) {
    return false;
  }

  const toolNames = extractRecentToolNames(evidence.recentSteps);
  const hasDirectMutationTool = toolNames.some((toolName) =>
    toolName === "shell_exec"
      || toolName === "file_write"
      || toolName === "file_edit"
      || toolName === "file_delete"
      || toolName === "file_manage"
  );
  if (!hasDirectMutationTool) {
    return false;
  }

  return toolNames.every((toolName) => SAFE_BOUNDED_DIRECT_OPERATION_TOOLS.has(toolName));
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

export function userExplicitlyAskedForCompletionReview(prompt: string): boolean {
  return EXPLICIT_COMPLETION_REVIEW_REQUEST_RE.test(prompt.trim());
}

function isVerificationStep(toolName: string, summary: string): boolean {
  if (toolName === "shell_exec") {
    return /\b(?:test|build|check|lint|typecheck|verify|compile|tsc|eslint|vitest|jest|pytest)\b/iu.test(summary);
  }
  return /\b(?:build|test|check|verify|lint|typecheck|compile|smoke)\b/iu.test(toolName);
}



/**
 * Deliverables the task enumerated that a completion claim never mentions.
 *
 * The sibling check above asks whether a draft admits its own loose ends. It
 * cannot ask the other question — whether the draft is silent about something
 * the task asked for — because that needs the task text, not just the draft.
 * Measured across this project's runs: a task naming five deliverables was
 * reported complete with three of them at zero files, and nothing objected,
 * because every check on the path read only the draft.
 *
 * Deliberately conservative. It fires only on a task that enumerates its
 * deliverables as a list of two or more, only when the draft claims
 * completion, and only for a label carrying a word distinctive enough to
 * look for. Silence about a named deliverable is the signal; this makes no
 * claim about whether the deliverable is any good.
 */
export function completionOmitsNamedDeliverables(
  prompt: string | null | undefined,
  draft: string | null | undefined,
): string[] {
  const draftText = draft?.trim() ?? "";
  if (!draftText || !draftClaimsCompletion(draftText)) {
    return [];
  }
  const labels = enumeratedDeliverableLabels(prompt ?? "");
  if (labels.length < 2) {
    return [];
  }
  const haystack = collapseForMention(draftText);
  return labels.filter((label) => {
    const term = distinctiveTerm(label);
    return term !== null && !haystack.includes(term);
  });
}

/** Bullet or numbered lines that read as a deliverable, in the order the task listed them. */
function enumeratedDeliverableLabels(prompt: string): string[] {
  const labels: string[] = [];
  for (const rawLine of prompt.split("\n")) {
    const item = /^\s*(?:[-*\u2022]|\d+[.)])\s+(.+)$/u.exec(rawLine.trim());
    if (!item) {
      continue;
    }
    const body = item[1] ?? "";
    // "Power-ups: 0 files. Implement them." — the label is what precedes the colon;
    // without one, the opening words carry the name.
    const head = body.includes(":") ? body.slice(0, body.indexOf(":")) : body.split(/\s+/u).slice(0, 4).join(" ");
    const label = head.trim();
    if (label) {
      labels.push(label);
    }
  }
  return labels;
}

const DELIVERABLE_STOPWORDS = new Set([
  "that", "this", "with", "from", "into", "then", "them", "they", "have", "will",
  "must", "make", "also", "each", "when", "what", "your", "there", "which", "should",
  "implement", "implements", "add", "adds", "the", "and", "for", "its", "per",
]);

/** The longest word worth searching for in a label, or null when none is distinctive. */
function distinctiveTerm(label: string): string | null {
  const words = label
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word.length >= 4 && !DELIVERABLE_STOPWORDS.has(word));
  if (words.length === 0) {
    return null;
  }
  return words.reduce((longest, word) => (word.length > longest.length ? word : longest));
}

/**
 * "Power-ups", "power ups" and "powerups" are the same word to a reader, and a
 * draft that used a different one of them has not been silent.
 */
function collapseForMention(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/gu, "");
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

function extractRecentToolNames(recentSteps: readonly string[]): string[] {
  return recentSteps.flatMap((step) => {
    const match = step.match(/^\[[A-Z]+\]\s+([^:]+):/u);
    const toolName = match?.[1]?.trim();
    return toolName ? [toolName] : [];
  });
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
