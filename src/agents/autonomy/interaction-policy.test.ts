import { describe, expect, it } from "vitest";
import { InteractionPolicyStateMachine } from "./interaction-policy.js";

describe("InteractionPolicyStateMachine", () => {
  it("blocks write operations while explicit plan review is pending", () => {
    const policy = new InteractionPolicyStateMachine();
    policy.requirePlanReview("chat-1", "user explicitly asked to review a plan first");

    expect(policy.getWriteBlock("chat-1", "file_edit")).toEqual({
      kind: "plan-review-required",
      reason: "user explicitly asked to review a plan first",
    });
    expect(policy.getWriteBlock("chat-1", "list_directory")).toBeNull();
  });

  it("clears a pending plan-review gate after an approval-like user message", () => {
    const policy = new InteractionPolicyStateMachine();
    policy.requirePlanReview("chat-1", "review the plan before any writes");

    const cleared = policy.noteUserMessage("chat-1", "tamam, proceed");

    expect(cleared).toMatchObject({
      kind: "plan-review-required",
      reason: "review the plan before any writes",
    });
    expect(policy.get("chat-1")).toBeUndefined();
    expect(policy.getWriteBlock("chat-1", "file_edit")).toBeNull();
  });
});
