import type { TaskClassification } from "../../agent-core/routing/routing-types.js";
import type { CompletionReviewEvidence } from "./completion-review.js";
import {
  buildAutonomyDeflectionGate,
  classifyAutonomyDrift,
  draftLeavesOpenInvestigations,
  draftLooksLikeInternalPlanArtifact,
  userExplicitlyAskedForPlan,
} from "./completion-review.js";

export type InteractionBoundaryDecisionKind =
  | "internal_continue"
  | "ask_user"
  | "blocked"
  | "plan_review"
  | "terminal_failure"
  | "final_answer";

export interface InteractionBoundaryDecision {
  readonly kind: InteractionBoundaryDecisionKind;
  readonly reason: string;
  readonly visibleText?: string;
  readonly gate?: string;
}

export interface InteractionBoundaryInput {
  readonly prompt: string;
  readonly workerDraft: string;
  readonly visibleDraft: string;
  readonly task: TaskClassification;
  readonly evidence: CompletionReviewEvidence;
  readonly canInspectLocally: boolean;
  readonly terminalFailureReported?: boolean;
  readonly availableToolNames?: Iterable<string>;
}

const EXECUTABLE_TASK_TYPES = new Set<TaskClassification["type"]>([
  "analysis",
  "debugging",
  "code-generation",
  "refactoring",
  "destructive-operation",
]);

const BLOCKER_SIGNAL_RE =
  /\b(?:blocked|blocker|missing|requires?|need(?:s)?|waiting on|pending|approval|permission|credential|token|subscription|login|access|account|external(?:ly)?|cannot|can't|could not|couldn't|unable|manual|intervention|timed out|timeout|error|errors|failed|failure|not found|corrupted|risk(?:y)?|irreversible|decision)\b/iu;
const INTERNAL_DECISION_MEMO_RE =
  /\b(?:pending|awaiting|waiting on)\b.{0,40}\b(?:decision|approval|confirmation|choice|selection)\b|\bbefore implementation\b|\b(?:approval|confirmation|decision|selection|choice)\b.{0,40}\b(?:before|prior to)\b.{0,20}\b(?:implementation|execution|proceed(?:ing)?|changes?)\b|\b(?:choose|select)\b.{0,30}\b(?:between|among)\b/iu;
const USER_ACTIONABLE_BLOCKER_RE =
  /\b(?:please|you need to|you'll need to|you must|sign in|log in|re-?authenticate|provide|share|grant|approve|confirm|choose|decide|configure|set|renew|enable|connect)\b/iu;
const EXTERNAL_DEPENDENCY_RE =
  /\b(?:credential|token|subscription|login|account|permission|approval|confirmation|access|api key|auth(?:entication)?|billing|quota|network|internet|external service|missing info|path)\b/iu;
const RISKY_IRREVERSIBLE_RE =
  /\b(?:irreversible|destructive|delete|drop|wipe|reset|migrate|deploy)\b.{0,40}\b(?:approval|permission|confirm|confirmation)\b|\b(?:need|requires?)\b.{0,40}\b(?:approval|permission|confirmation)\b/iu;
const MANUAL_INTERVENTION_RE =
  /\bmanual(?:ly)?\s+intervention\b|\brestore(?:d)?\b.{0,40}\bversion control\b|\brecreate(?:d)?\b.{0,20}\bproject\b/iu;
const LOCAL_PROGRESS_MEMO_RE =
  /\b(?:need(?:s)? to|must|should|have to|will|going to)\b.{0,50}\b(?:inspect|read|open|check|search|review|analy[sz]e|investigat(?:e|ing)|trace|run|rerun|test|build|compile|profile|instrument|compare|verify)\b/iu;
const PLAN_SECTION_RE =
  /(?:^|\n)\s*(?:plan|steps?|next steps?|follow-?up|checklist|implementation plan|execution plan)\s*:|\n\s*(?:\d+\.\s+|[A-D]\)\s+|[-*]\s+)/iu;
const PROJECT_ARTIFACT_SIGNAL_RE =
  /\b(?:file|files|path|folder|directory|repo(?:sitory)?|project|workspace|codebase|module|component|service|system|class|struct|interface|method|function|scene|asset|prefab|scriptable|package|config|migration|database|portal|wizard|setup|dashboard|page|screen|view)\b|(?:\/|\\)[\w./-]+|(?:^|[\s`'"])\w+\.(?:ts|tsx|js|jsx|cjs|mjs|cs|json|md|yml|yaml|toml|xml|sql|py|java|kt|swift|go|rs|asset|prefab|meta)\b/iu;
const RUNTIME_DIAGNOSTIC_SIGNAL_RE =
  /\b(?:build|compile|lint|typecheck|runtime|profiler|call stack|stack trace|freeze|crash|exception|editor|play mode|log|logs|warning|warnings|error|errors)\b/iu;

function buildVisibilityContinueGate(
  summary: string,
  nextAction: string,
  evidence: CompletionReviewEvidence,
): string {
  return [
    "[VISIBILITY REVIEW REQUIRED] The current draft is not safe to surface yet.",
    summary,
    `Evidence so far:\n- Tool steps observed: ${evidence.totalStepCount}\n- Inspection steps: ${evidence.inspectionStepCount}\n- Verification steps: ${evidence.verificationStepCount}`,
    nextAction,
  ].join("\n\n");
}

function shouldRequireToolEvidence(task: TaskClassification): boolean {
  return EXECUTABLE_TASK_TYPES.has(task.type);
}

function looksLikeExternalBlocker(text: string): boolean {
  if (!BLOCKER_SIGNAL_RE.test(text)) {
    return false;
  }
  if (looksLikeInternalDecisionMemo(text) || looksLikeInternalProgressMemo(text)) {
    return false;
  }
  return looksLikeUserActionableTerminalBlocker(text);
}

function looksLikeUserActionableTerminalBlocker(text: string): boolean {
  if (RISKY_IRREVERSIBLE_RE.test(text)) {
    return true;
  }
  if (MANUAL_INTERVENTION_RE.test(text)) {
    return true;
  }
  return EXTERNAL_DEPENDENCY_RE.test(text) && USER_ACTIONABLE_BLOCKER_RE.test(text);
}

function taskLooksLocallyInspectable(
  task: TaskClassification,
  prompt: string,
  canInspectLocally: boolean,
): boolean {
  if (!canInspectLocally || !shouldRequireToolEvidence(task)) {
    return false;
  }

  if (PROJECT_ARTIFACT_SIGNAL_RE.test(prompt)) {
    return true;
  }

  return (task.type === "analysis" || task.type === "debugging" || task.type === "refactoring")
    && RUNTIME_DIAGNOSTIC_SIGNAL_RE.test(prompt);
}

function extractTerminalFailureVisibleText(text: string): string | null {
  const normalized = text.trim();
  if (!normalized) {
    return null;
  }

  const match = PLAN_SECTION_RE.exec(normalized);
  const head = (match ? normalized.slice(0, match.index) : normalized)
    .replace(/\s+/g, " ")
    .trim();

  if (!head || draftLooksLikeInternalPlanArtifact(head)) {
    return null;
  }

  if (looksLikeInternalDecisionMemo(head) || looksLikeInternalProgressMemo(head)) {
    return null;
  }

  if (!looksLikeUserActionableTerminalBlocker(head)) {
    return null;
  }

  return head;
}

function looksLikeInternalDecisionMemo(text: string): boolean {
  return INTERNAL_DECISION_MEMO_RE.test(text);
}

function looksLikeInternalProgressMemo(text: string): boolean {
  return LOCAL_PROGRESS_MEMO_RE.test(text)
    && (PROJECT_ARTIFACT_SIGNAL_RE.test(text) || RUNTIME_DIAGNOSTIC_SIGNAL_RE.test(text));
}

export function decideInteractionBoundary(
  input: InteractionBoundaryInput,
): InteractionBoundaryDecision {
  const rawDraft = input.workerDraft.trim();
  const visibleDraft = input.visibleDraft.trim();
  const visibleOrRawDraft = visibleDraft || rawDraft;

  if (!visibleOrRawDraft) {
    return {
      kind: "internal_continue",
      reason: "No user-visible result exists yet.",
      gate: buildVisibilityContinueGate(
        "The current turn ended without a user-facing result.",
        "Continue internally and produce a verified result or a real blocker.",
        input.evidence,
      ),
    };
  }

  if (
    userExplicitlyAskedForPlan(input.prompt)
    && draftLooksLikeInternalPlanArtifact(rawDraft, { toolNames: input.availableToolNames })
  ) {
    return {
      kind: "plan_review",
      reason: "The user explicitly asked to review the plan before execution.",
      visibleText: rawDraft,
    };
  }

  const autonomyDrift = classifyAutonomyDrift(visibleOrRawDraft, input.prompt, {
    toolNames: input.availableToolNames,
  });
  if (autonomyDrift !== "none") {
    return {
      kind: "internal_continue",
      reason: "The current draft is still an internal orchestration artifact.",
      gate: buildAutonomyDeflectionGate(visibleOrRawDraft, input.evidence, input.prompt, {
        toolNames: input.availableToolNames,
      })
        ?? buildVisibilityContinueGate(
          "The current draft is still an internal orchestration artifact.",
          "Continue internally until the result is directly usable for the user.",
          input.evidence,
        ),
    };
  }

  if (looksLikeInternalDecisionMemo(visibleOrRawDraft)) {
    return {
      kind: "internal_continue",
      reason: "The current draft only records an unresolved internal decision or approval memo.",
      gate: buildVisibilityContinueGate(
        "The current draft still describes an unresolved internal decision rather than a user-ready blocker.",
        "Continue internally until the decision is resolved or surface one concise user-facing blocker/question only if a real external decision remains.",
        input.evidence,
      ),
    };
  }

  if (looksLikeInternalProgressMemo(visibleOrRawDraft)) {
    return {
      kind: "internal_continue",
      reason: "The current draft describes internal inspection or verification work, not a user-ready blocker.",
      gate: buildVisibilityContinueGate(
        "The current draft is still an internal progress memo about inspection or verification work.",
        "Continue internally until the work is finished or surface one concise external blocker only if user action is truly required.",
        input.evidence,
      ),
    };
  }

  if (draftLeavesOpenInvestigations(visibleOrRawDraft)) {
    return {
      kind: "internal_continue",
      reason: "The current draft still lists unresolved investigations or runtime hypotheses.",
      gate: buildVisibilityContinueGate(
        "The draft still contains open investigations, so completion is premature.",
        "Finish the remaining investigation, verify the real outcome, and then return the result.",
        input.evidence,
      ),
    };
  }

  if (
    taskLooksLocallyInspectable(input.task, input.prompt, input.canInspectLocally) &&
    input.evidence.totalStepCount === 0 &&
    !looksLikeExternalBlocker(visibleOrRawDraft)
  ) {
    return {
      kind: "internal_continue",
      reason: "An executable task tried to finish without any real tool evidence.",
      gate: buildVisibilityContinueGate(
        "Executable work cannot finish from a plain-text draft alone.",
        "Use the relevant tools or surface a real external blocker instead of returning an internal memo.",
        input.evidence,
      ),
    };
  }

  if (input.terminalFailureReported || looksLikeExternalBlocker(visibleOrRawDraft)) {
    const terminalText = extractTerminalFailureVisibleText(visibleOrRawDraft);
    if (
      terminalText
      && !looksLikeInternalDecisionMemo(terminalText)
      && !looksLikeInternalProgressMemo(terminalText)
    ) {
      return {
        kind: "terminal_failure",
        reason: "A real external blocker remains and can be surfaced cleanly.",
        visibleText: terminalText,
      };
    }
  }

  return {
    kind: "final_answer",
    reason: "The current draft is safe to surface as the user-facing result.",
    visibleText: visibleDraft || rawDraft,
  };
}
