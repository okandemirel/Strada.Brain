export type LoopRecoveryDecisionKind =
  | "continue_local"
  | "replan_local"
  | "delegate_analysis"
  | "delegate_code_review"
  | "blocked";

export interface LoopRecoveryReviewDecision {
  readonly decision?: LoopRecoveryDecisionKind;
  readonly reason?: string;
  readonly recommendedNextAction?: string;
  readonly delegationTask?: string;
  readonly summary?: string;
}

export interface LoopRecoveryBrief {
  readonly fingerprint: string;
  readonly latestReason?: string;
  readonly verifierSummary?: string;
  readonly requiredActions: readonly string[];
  readonly recentToolSummaries: readonly string[];
  readonly touchedFiles: readonly string[];
  readonly recentUserFacingProgress: readonly string[];
  readonly recoveryEpisode: number;
  readonly availableDelegations: readonly string[];
}

export const LOOP_RECOVERY_REVIEW_SYSTEM_PROMPT = `You are Strada Brain's loop recovery reviewer.
Your job is to detect repeated internal control loops and choose the safest recovery path.

Allowed decisions:
- "continue_local": only when you can point to one concrete next action that has not already been tried.
- "replan_local": the worker should create a meaningfully different plan now.
- "delegate_analysis": ask a helper agent for root-cause analysis.
- "delegate_code_review": ask a helper agent for code-level review of touched files.
- "blocked": stop with an honest checkpoint because recovery is exhausted.

Rules:
- Prefer replan_local over continue_local when the same verifier or clarification reason keeps repeating.
- Prefer delegation on later recovery episodes when delegation is available.
- Use blocked only when the same loop has already been through recovery and still lacks a clean verification path.

Return JSON only:
{"decision":"continue_local"|"replan_local"|"delegate_analysis"|"delegate_code_review"|"blocked","reason":"short reason","recommendedNextAction":"concrete next action when relevant","delegationTask":"task text for the delegated worker when relevant","summary":"short checkpoint or diagnosis summary"}`;

export function buildLoopRecoveryReviewRequest(brief: LoopRecoveryBrief): string {
  return [
    "Evaluate the repeated control-loop evidence and choose the next recovery action.",
    "",
    `Loop fingerprint: ${brief.fingerprint}`,
    `Recovery episode: ${brief.recoveryEpisode}`,
    `Latest reason: ${brief.latestReason ?? "(none)"}`,
    `Verifier memory: ${brief.verifierSummary ?? "(none)"}`,
    "",
    `Required verifier actions:\n${formatList(brief.requiredActions, "(none)")}`,
    "",
    `Recent tool evidence:\n${formatList(brief.recentToolSummaries, "(none)")}`,
    "",
    `Touched files:\n${formatList(brief.touchedFiles, "(none)")}`,
    "",
    `Recent user-facing progress summaries:\n${formatList(brief.recentUserFacingProgress, "(none)")}`,
    "",
    `Available delegations: ${brief.availableDelegations.length > 0 ? brief.availableDelegations.join(", ") : "(none)"}`,
    "",
    "Choose continue_local only if there is a novel, concrete verification or evidence-gathering action.",
    "Choose blocked only if recovery is exhausted and another internal pass would just repeat the loop.",
  ].join("\n");
}

export function parseLoopRecoveryReviewDecision(text: string): LoopRecoveryReviewDecision | null {
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
      return JSON.parse(candidate) as LoopRecoveryReviewDecision;
    } catch {
      // Try next candidate.
    }
  }
  return null;
}

export function sanitizeLoopRecoveryReviewDecision(
  decision: LoopRecoveryReviewDecision | null,
): LoopRecoveryReviewDecision | null {
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
    delegationTask:
      typeof decision.delegationTask === "string"
        ? decision.delegationTask.trim().slice(0, 600)
        : undefined,
    summary: typeof decision.summary === "string" ? decision.summary.trim().slice(0, 220) : undefined,
  };
}

function formatList(items: readonly string[], fallback: string): string {
  if (items.length === 0) {
    return fallback;
  }
  return items.map((item) => `- ${item}`).join("\n");
}
