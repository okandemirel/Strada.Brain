export type InteractionGateKind = "plan-review-required";

export interface InteractionGateState {
  readonly kind: InteractionGateKind;
  readonly reason: string;
  readonly requestedAt: number;
  readonly blocksWrite: boolean;
  readonly planText?: string;
}

export interface InteractionWriteBlock {
  readonly kind: InteractionGateKind;
  readonly reason: string;
}

/**
 * Plan approval is judged on the WHOLE message, not its first word.
 *
 * A prefix match cleared the write block for replies that only began with an
 * approval-ish word and then asked a question, added a condition or said no.
 * Now every word must come from a small approval vocabulary, at least one must
 * be an actual approval, the reply must be short, and a question mark keeps the
 * gate. Anything else (a condition, a negation, a change request, a question)
 * is review feedback and leaves the plan parked.
 */
const PLAN_APPROVAL_WORDS: ReadonlySet<string> = new Set([
  "approve", "approved", "proceed", "continue", "yes", "ok", "okay", "lgtm",
  "tamam", "devam", "uygun", "evet", "onay", "onayla", "onaylıyorum", "onaylandı",
]);
const PLAN_APPROVAL_PHRASES: readonly (readonly [string, string])[] = [
  ["go", "ahead"],
  ["looks", "good"],
  ["sounds", "good"],
  ["ship", "it"],
];
/** Words that may accompany an approval without changing what it means. */
const PLAN_APPROVAL_FILLER: ReadonlySet<string> = new Set([
  "go", "ahead", "looks", "sounds", "good", "great", "fine", "perfect", "ship", "it",
  "please", "thanks", "thank", "you", "sure", "yep", "yeah", "alright", "the", "plan",
  "with", "that", "this", "lets", "let's", "let’s", "do", "all", "right",
  "lütfen", "teşekkürler", "sağol", "et", "edelim", "edebilirsin", "olur", "hadi", "başla",
]);
const PLAN_APPROVAL_MAX_WORDS = 8;

function isPlanApprovalMessage(text: string): boolean {
  const normalized = text.normalize("NFC").trim().toLowerCase();
  if (!normalized || normalized.includes("?")) {
    return false;
  }
  const words = normalized
    .replace(/[\s.,!;:()"—–-]+/gu, " ")
    .trim()
    .split(" ")
    .filter((word) => word.length > 0);
  if (words.length === 0 || words.length > PLAN_APPROVAL_MAX_WORDS) {
    return false;
  }
  if (!words.every((word) => PLAN_APPROVAL_WORDS.has(word) || PLAN_APPROVAL_FILLER.has(word))) {
    return false;
  }
  if (words.some((word) => PLAN_APPROVAL_WORDS.has(word))) {
    return true;
  }
  return PLAN_APPROVAL_PHRASES.some(([first, second]) =>
    words.some((word, index) => word === first && words[index + 1] === second),
  );
}

export class InteractionPolicyStateMachine {
  private readonly gates = new Map<string, InteractionGateState>();

  requirePlanReview(chatId: string, reason: string, planText?: string): void {
    const existingGate = this.gates.get(chatId);
    const normalizedPlanText = planText?.trim() || existingGate?.planText;
    this.gates.set(chatId, {
      kind: "plan-review-required",
      reason: reason.trim() || "user explicitly asked to review a plan first",
      requestedAt: Date.now(),
      blocksWrite: true,
      planText: normalizedPlanText,
    });
  }

  clear(chatId: string): void {
    this.gates.delete(chatId);
  }

  get(chatId: string): InteractionGateState | undefined {
    return this.gates.get(chatId);
  }

  noteUserMessage(chatId: string, text: string): InteractionGateState | null {
    const gate = this.gates.get(chatId);
    if (!gate) {
      return null;
    }
    if (gate.kind === "plan-review-required" && isPlanApprovalMessage(text)) {
      this.gates.delete(chatId);
      return gate;
    }
    return null;
  }

  /**
   * The gate does not decide what a write is — the caller does.
   *
   * Audited 2026-09-02: this used to test the static WRITE_OPERATIONS list, so a
   * file_write the gate refused went straight through when wrapped in
   * batch_execute (or issued by a runtime-registered writer) while the user
   * was still being asked to approve the plan. The orchestrator's
   * isWriteOperation() already knows registry metadata and tool shape; one
   * classifier decides for every gate, and this one only asks whether a gate
   * is parked.
   */
  getWriteBlock(chatId: string, isWriteOperation: boolean): InteractionWriteBlock | null {
    if (isWriteOperation !== true) {
      return null;
    }
    const gate = this.gates.get(chatId);
    if (!gate?.blocksWrite) {
      return null;
    }
    return {
      kind: gate.kind,
      reason: gate.reason,
    };
  }
}
