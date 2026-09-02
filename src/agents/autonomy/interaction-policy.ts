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

const PLAN_APPROVAL_MESSAGE_RE = /^(?:\s*)(?:approve|approved|go ahead|proceed|continue|yes|ok|okay|looks good|ship it|tamam|devam|uygun)(?:\b|[.!])/iu;

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
    if (gate.kind === "plan-review-required" && PLAN_APPROVAL_MESSAGE_RE.test(text.trim())) {
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
