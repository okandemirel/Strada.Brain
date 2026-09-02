import { describe, expect, it } from "vitest";
import { InteractionPolicyStateMachine } from "./interaction-policy.js";

describe("InteractionPolicyStateMachine", () => {
  it("blocks write operations while explicit plan review is pending", () => {
    const policy = new InteractionPolicyStateMachine();
    policy.requirePlanReview("chat-1", "user explicitly asked to review a plan first");

    expect(policy.getWriteBlock("chat-1", true)).toEqual({
      kind: "plan-review-required",
      reason: "user explicitly asked to review a plan first",
    });
    expect(policy.getWriteBlock("chat-1", false)).toBeNull();
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
    expect(policy.getWriteBlock("chat-1", true)).toBeNull();
  });

  it("retains the latest concrete plan text for deferred plan-review surfacing", () => {
    const policy = new InteractionPolicyStateMachine();
    policy.requirePlanReview(
      "chat-1",
      "user explicitly asked to review a plan first",
      "Plan: Inspect the failing path\n\nSteps:\n1. Read the logs\n2. Patch the bug",
    );
    policy.requirePlanReview("chat-1", "user explicitly asked to review a plan first");

    expect(policy.get("chat-1")).toMatchObject({
      kind: "plan-review-required",
      planText: "Plan: Inspect the failing path\n\nSteps:\n1. Read the logs\n2. Patch the bug",
    });
  });

  it("takes the caller's write verdict instead of re-deriving it from the static allowlist", () => {
    // Audited 2026-09-02: getWriteBlock() answered null for any tool outside
    // WRITE_OPERATIONS, so a file_write the gate refused went straight through
    // when wrapped in batch_execute (or issued by a runtime-registered writer)
    // while the user was still being asked to approve the plan. The orchestrator
    // already classifies writes from registry metadata and tool shape; the gate
    // must not have a second, narrower opinion.
    const policy = new InteractionPolicyStateMachine();
    policy.requirePlanReview("chat-1", "user explicitly asked to review a plan first");

    // A tool name the static list has never heard of, classified as a write by
    // the orchestrator, is blocked exactly like file_write.
    expect(policy.getWriteBlock("chat-1", true)).toEqual({
      kind: "plan-review-required",
      reason: "user explicitly asked to review a plan first",
    });
    // No verdict is smuggled in through a tool-name argument.
    expect((policy.getWriteBlock as unknown as (a: string, b: string) => unknown)("chat-1", "file_edit")).toBeNull();
  });
});
