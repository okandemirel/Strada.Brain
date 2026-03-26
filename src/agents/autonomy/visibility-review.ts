import type { TaskClassification } from "../../agent-core/routing/routing-types.js";
import type { CompletionReviewEvidence } from "./completion-review.js";

export type VisibilityReviewDecisionKind =
  | "allow"
  | "internal_continue";

export interface VisibilityReviewDecision {
  readonly decision?: VisibilityReviewDecisionKind;
  readonly reason?: string;
  readonly recommendedNextAction?: string;
}

export interface VisibilityReviewRequestParams {
  readonly prompt: string;
  readonly draft: string;
  readonly evidence: CompletionReviewEvidence;
  readonly task: TaskClassification;
  readonly canInspectLocally: boolean;
}

const EXECUTABLE_TASK_TYPES = new Set<TaskClassification["type"]>([
  "analysis",
  "debugging",
  "code-generation",
  "refactoring",
  "destructive-operation",
]);

export const VISIBILITY_REVIEW_SYSTEM_PROMPT = `You are Strada Brain's visibility reviewer.
Decide whether a worker draft is truly safe to surface as the final user-facing output.

This review must work across any user language.

Choose "internal_continue" when the draft is still any of these:
- an internal plan, checklist, or orchestration artifact
- a milestone or progress memo instead of the final result
- a handoff that gives the next engineering step back to the user
- an invitation to continue or start the next engineering step later without a real blocker
- an unfinished audit or investigation summary where Strada can still continue locally

Choose "allow" only when the draft is already one of these:
- the actual completed result
- a concise user-facing blocker that truly requires external action
- a plan review only when the user explicitly asked to see the plan first

Return JSON only:
{"decision":"allow"|"internal_continue","reason":"short reason","recommendedNextAction":"short concrete next action when continuing"}`;

export function shouldRunVisibilityReview(params: {
  draft: string;
  evidence: CompletionReviewEvidence;
  task: TaskClassification;
  canInspectLocally: boolean;
}): boolean {
  return params.draft.trim().length > 0
    && params.evidence.totalStepCount > 0
    && EXECUTABLE_TASK_TYPES.has(params.task.type);
}

export function buildVisibilityReviewRequest(
  params: VisibilityReviewRequestParams,
): string {
  return [
    "Decide whether the current worker draft is safe to surface as the final user-facing result.",
    "",
    `User request:\n${params.prompt}`,
    "",
    `Candidate visible draft:\n${params.draft}`,
    "",
    `Task type: ${params.task.type}`,
    `Local inspection path still exists: ${params.canInspectLocally ? "yes" : "no"}`,
    "",
    `Evidence summary:\n- Total tool steps: ${params.evidence.totalStepCount}\n- Inspection steps: ${params.evidence.inspectionStepCount}\n- Verification steps: ${params.evidence.verificationStepCount}\n- Mutation steps: ${params.evidence.mutationStepCount}`,
    "",
    `Recent steps:\n${formatList(params.evidence.recentSteps, "(none)")}`,
    "",
    `Touched files:\n${formatList(params.evidence.touchedFiles, "(none)")}`,
    "",
    "If the draft still hands the next engineering move back to the user in any language, choose internal_continue.",
    "If Strada can keep inspecting, editing, verifying, or auditing locally, choose internal_continue.",
  ].join("\n");
}

export function parseVisibilityReviewDecision(
  text: string,
): VisibilityReviewDecision | null {
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
      return JSON.parse(candidate) as VisibilityReviewDecision;
    } catch {
      // Try next candidate.
    }
  }

  return null;
}

export function sanitizeVisibilityReviewDecision(
  decision: VisibilityReviewDecision | null,
): VisibilityReviewDecision | null {
  if (!decision) {
    return null;
  }

  return {
    decision: decision.decision,
    reason: typeof decision.reason === "string" ? decision.reason.trim().slice(0, 220) : undefined,
    recommendedNextAction:
      typeof decision.recommendedNextAction === "string"
        ? decision.recommendedNextAction.trim().slice(0, 220)
        : undefined,
  };
}

export function buildVisibilityReviewGate(
  decision: VisibilityReviewDecision | null,
  evidence: CompletionReviewEvidence,
): string {
  const reason = decision?.reason?.trim()
    || "The current draft is still an internal memo or handoff, not the final user-facing outcome.";
  const nextAction = decision?.recommendedNextAction?.trim()
    || "Continue internally until the work is actually finished or a real external blocker remains.";

  return [
    "[VISIBILITY REVIEW REQUIRED] The current draft is not safe to surface yet.",
    reason,
    `Evidence so far:\n- Tool steps observed: ${evidence.totalStepCount}\n- Inspection steps: ${evidence.inspectionStepCount}\n- Verification steps: ${evidence.verificationStepCount}`,
    `Required next action: ${nextAction}`,
  ].join("\n\n");
}

function formatList(items: readonly string[], fallback: string): string {
  if (items.length === 0) {
    return fallback;
  }
  return items.map((item) => `- ${item}`).join("\n");
}
