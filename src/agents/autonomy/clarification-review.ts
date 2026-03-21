import type { AgentState } from "../agent-state.js";

export type ClarificationDecision =
  | "none"
  | "internal_continue"
  | "ask_user"
  | "blocked";

export type ClarificationBlockingType =
  | "missing_external_info"
  | "product_direction"
  | "credential_or_access"
  | "risky_irreversible_action"
  | "other";

export interface ClarificationReviewEvidence {
  readonly prompt: string;
  readonly draft: string;
  readonly projectPath: string;
  readonly recentSteps: readonly string[];
  readonly recentFailures: readonly string[];
  readonly touchedFiles: readonly string[];
  readonly hasLocalProjectAccess: boolean;
  readonly canInspectLocally: boolean;
}

export interface ClarificationReviewDecision {
  readonly decision?: ClarificationDecision;
  readonly reason?: string;
  readonly blockingType?: ClarificationBlockingType;
  readonly recommendedNextAction?: string;
  readonly question?: string;
  readonly options?: readonly string[];
  readonly recommendedOption?: string;
}

export interface ClarificationDraftSignals {
  readonly hasQuestionMark: boolean;
  readonly hasQuestionStem: boolean;
  readonly addressesUser: boolean;
  readonly requestsUserInput: boolean;
  readonly enumeratesChoices: boolean;
  readonly mentionsExternalBlocker: boolean;
  readonly gathersRequirements: boolean;
}

export const CLARIFICATION_REVIEW_SYSTEM_PROMPT = `You are Strada Brain's clarification reviewer.
Strada is the only user-facing agent. Worker providers are internal.

Your job:
- Decide whether a draft or proposed clarification should be handled internally by Strada or surfaced to the user.
- Prefer internal continuation whenever Strada still has a local inspection path: files, repo search, logs, build/test tools, runtime traces, or prior evidence can move the task forward.
- Only approve user clarification when it is truly required to continue.
- Do not allow broad intake behavior, discovery checklists, or "tell me what you want me to act on" behavior to reach the user.
- Local technical decisions stay inside Strada: package selection, refactor path, implementation sequencing, and similar engineering choices are not user escalations by default.

Allowed decisions:
- "none": this draft is not asking for clarification and can continue through normal orchestration.
- "internal_continue": the worker is asking too early; Strada must continue internally.
- "ask_user": exactly one concise, decision-ready user question is required.
- "blocked": a real external blocker must be surfaced now.

Choose "ask_user" or "blocked" only when at least one of these is true:
1. External information is missing and cannot be inferred locally.
2. Multiple valid product directions remain and the choice is materially important.
3. Credentials, access, or a risky irreversible action block progress.

Return JSON only:
{"decision":"none"|"internal_continue"|"ask_user"|"blocked","reason":"short reason","blockingType":"missing_external_info"|"product_direction"|"credential_or_access"|"risky_irreversible_action"|"other","recommendedNextAction":"short action","question":"single concise user-facing question when needed","options":["optional","decision-ready","choices"],"recommendedOption":"optional recommended choice"}`;

const QUESTION_MARK_RE = /\?/u;
const QUESTION_STEM_RE = /\b(?:what|which|who|where|when|why|how|can you|could you|would you|do you|are you|should we|should i|shall we|want me to)\b/iu;
const USER_ADDRESS_RE = /\b(?:you|your|yours|user|sen|seni|senin|siz|size|sizin)\b/iu;
const USER_INPUT_REQUEST_RE = /\b(?:clarif(?:y|ication)|confirm|choose|pick|select|decide|prefer|share|provide|tell|specify|describe|send|paste|attach|upload|rephrase|explain|mean|want|continue|approve|allow|install|need from you)\b/iu;
const EXTERNAL_BLOCKER_RE = /\b(?:missing|blocked|blocker|requires?|need|without|cannot|can't|unable|access|credential|permission|token|api[_ -]?key|login|account|subscription|approval|irreversible|external)\b/iu;
const REQUIREMENT_GATHERING_RE = /\b(?:objective|scope|requirements?|inputs?|constraints?|repro(?:duction)?|expected|actual|symptom|target behavior|project health check)\b/iu;
const CHOICE_LIST_RE = /(?:^|\n)\s*(?:[A-D]\)|[1-9]\)|[-*])\s+\S/m;
const DIRECTIVE_REQUEST_RE = /^(?:please\s+)?(?:clarify|confirm|choose|pick|select|decide|prefer|share|provide|tell|specify|describe|send|paste|attach|upload|rephrase|explain)\b/iu;

export function collectClarificationReviewEvidence(params: {
  prompt: string;
  draft: string;
  state: AgentState;
  projectPath: string;
  touchedFiles?: readonly string[];
}): ClarificationReviewEvidence {
  return {
    prompt: params.prompt,
    draft: params.draft,
    projectPath: params.projectPath,
    recentSteps: params.state.stepResults
      .slice(-8)
      .map((step) => `[${step.success ? "OK" : "FAIL"}] ${step.toolName}: ${step.summary}`),
    recentFailures: params.state.stepResults
      .filter((step) => !step.success)
      .slice(-5)
      .map((step) => `${step.toolName}: ${step.summary}`),
    touchedFiles: [...(params.touchedFiles ?? [])].sort(),
    hasLocalProjectAccess: params.projectPath.trim().length > 0,
    canInspectLocally:
      params.projectPath.trim().length > 0 ||
      params.state.stepResults.some((step) => step.toolName === "file_read" || step.toolName === "list_directory" || step.toolName.includes("search")),
  };
}

export function analyzeClarificationDraft(draft: string): ClarificationDraftSignals {
  const normalized = draft.trim();
  return {
    hasQuestionMark: QUESTION_MARK_RE.test(normalized),
    hasQuestionStem: QUESTION_STEM_RE.test(normalized),
    addressesUser: USER_ADDRESS_RE.test(normalized),
    requestsUserInput: USER_INPUT_REQUEST_RE.test(normalized),
    enumeratesChoices: CHOICE_LIST_RE.test(normalized),
    mentionsExternalBlocker: EXTERNAL_BLOCKER_RE.test(normalized),
    gathersRequirements: REQUIREMENT_GATHERING_RE.test(normalized),
  };
}

export function shouldRunClarificationReview(
  draft: string,
): boolean {
  const normalized = draft.trim();
  if (!normalized) {
    return false;
  }

  const signals = analyzeClarificationDraft(normalized);
  if (signals.enumeratesChoices) {
    return true;
  }
  if (signals.requestsUserInput && DIRECTIVE_REQUEST_RE.test(normalized)) {
    return true;
  }

  const interactionSignalCount = [
    signals.hasQuestionMark || signals.hasQuestionStem,
    signals.addressesUser || signals.requestsUserInput,
    signals.mentionsExternalBlocker || signals.gathersRequirements,
  ].filter(Boolean).length;

  return interactionSignalCount >= 2 && (
    signals.requestsUserInput
    || signals.mentionsExternalBlocker
    || signals.gathersRequirements
  );
}

export function buildClarificationReviewRequest(evidence: ClarificationReviewEvidence): string {
  return [
    "Evaluate whether this should become a user-facing clarification.",
    "",
    `User request:\n${evidence.prompt}`,
    "",
    `Candidate draft or proposed clarification:\n${evidence.draft || "(empty)"}`,
    "",
    `Local access:\n- Project path available: ${evidence.hasLocalProjectAccess ? "yes" : "no"}\n- Local inspection path exists: ${evidence.canInspectLocally ? "yes" : "no"}`,
    "",
    `Touched files:\n${formatList(evidence.touchedFiles, "(none)")}`,
    "",
    `Recent step results:\n${formatList(evidence.recentSteps, "(none)")}`,
    "",
    `Recent unresolved failures:\n${formatList(evidence.recentFailures, "(none)")}`,
    "",
    "If Strada can still inspect, search, verify, compare, or re-route internally, choose internal_continue.",
    "Never approve broad intake behavior or requirement-gathering checklists as user-facing clarification.",
  ].join("\n");
}

export function parseClarificationReviewDecision(text: string): ClarificationReviewDecision | null {
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
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as ClarificationReviewDecision;
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

export function sanitizeClarificationReviewDecision(
  decision: ClarificationReviewDecision | null,
): ClarificationReviewDecision | null {
  if (!decision) {
    return null;
  }

  const question = typeof decision.question === "string"
    ? decision.question.replace(/\s+/g, " ").trim().slice(0, 280)
    : undefined;
  const options = Array.isArray(decision.options)
    ? decision.options
      .map((option) => String(option).replace(/\s+/g, " ").trim())
      .filter((option) => option.length > 0)
      .slice(0, 4)
    : undefined;
  const recommendedOption = typeof decision.recommendedOption === "string"
    ? decision.recommendedOption.replace(/\s+/g, " ").trim().slice(0, 120)
    : undefined;

  return {
    decision: decision.decision,
    reason: typeof decision.reason === "string" ? decision.reason.trim().slice(0, 220) : undefined,
    blockingType: decision.blockingType,
    recommendedNextAction: typeof decision.recommendedNextAction === "string"
      ? decision.recommendedNextAction.trim().slice(0, 220)
      : undefined,
    question,
    options,
    recommendedOption,
  };
}

export function buildClarificationContinuationGate(
  evidence: ClarificationReviewEvidence,
  decision: ClarificationReviewDecision | null,
): string {
  const reason = decision?.reason?.trim() || "The current draft asks the user too early.";
  const nextAction = decision?.recommendedNextAction?.trim() || "Continue inspecting locally and resolve the ambiguity inside Strada.";

  return [
    "[CLARIFICATION REVIEW REQUIRED] Do not surface a clarification request yet.",
    reason,
    `Local inspection path available: ${evidence.canInspectLocally ? "yes" : "no"}.`,
    `Required next action: ${nextAction}`,
    "Continue internally. Inspect files, logs, traces, runtime state, or use another worker/reviewer as needed.",
    "Do not ask the user broad intake, requirement-gathering, or approval questions unless a real external blocker remains after that work.",
  ].join("\n\n");
}

export function formatClarificationPrompt(
  decision: ClarificationReviewDecision | null,
): string | null {
  if (!decision || (decision.decision !== "ask_user" && decision.decision !== "blocked")) {
    return null;
  }

  const question = decision.question?.trim();
  if (!question) {
    return null;
  }

  const reason = decision.reason?.trim();
  const lines = [
    reason ? `**Clarification needed:** ${reason}` : "**Clarification needed**",
    "",
    question,
  ];

  const options = decision.options?.filter((option) => option.trim().length > 0) ?? [];
  if (options.length > 0) {
    lines.push("");
    for (const [index, option] of options.entries()) {
      const recommended = decision.recommendedOption && option === decision.recommendedOption
        ? " *(recommended)*"
        : "";
      lines.push(`${index + 1}. ${option}${recommended}`);
    }
  }

  return lines.join("\n");
}

function formatList(lines: readonly string[], fallback: string): string {
  return lines.length > 0 ? lines.map((line) => `- ${line}`).join("\n") : fallback;
}
