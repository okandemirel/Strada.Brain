import { WRITE_OPERATIONS } from "./constants.js";

export type InteractionGateKind = "plan-review-required";

export interface InteractionGateState {
  readonly kind: InteractionGateKind;
  readonly reason: string;
  readonly requestedAt: number;
  readonly blocksWrite: boolean;
}

export interface InteractionWriteBlock {
  readonly kind: InteractionGateKind;
  readonly reason: string;
}

const PLAN_APPROVAL_MESSAGE_RE = /^(?:\s*)(?:approve|approved|go ahead|proceed|continue|yes|ok|okay|looks good|ship it|tamam|devam|uygun)(?:\b|[.!])/iu;

export class InteractionPolicyStateMachine {
  private readonly gates = new Map<string, InteractionGateState>();

  requirePlanReview(chatId: string, reason: string): void {
    this.gates.set(chatId, {
      kind: "plan-review-required",
      reason: reason.trim() || "user explicitly asked to review a plan first",
      requestedAt: Date.now(),
      blocksWrite: true,
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

  getWriteBlock(chatId: string, toolName: string): InteractionWriteBlock | null {
    if (!WRITE_OPERATIONS.has(toolName)) {
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
