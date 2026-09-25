import { describe, expect, it } from "vitest";
import { InteractionPolicyStateMachine } from "./interaction-policy.js";

describe("InteractionPolicyStateMachine", () => {
  it("blocks write operations while explicit plan review is pending", () => {
    const policy = new InteractionPolicyStateMachine();
    policy.requirePlanReview("chat-1", "user explicitly asked to review a plan first", undefined, "user-a");

    expect(policy.getWriteBlock("chat-1", true)).toEqual({
      kind: "plan-review-required",
      reason: "user explicitly asked to review a plan first",
    });
    expect(policy.getWriteBlock("chat-1", false)).toBeNull();
  });

  it("clears a pending plan-review gate after an approval-like user message", () => {
    const policy = new InteractionPolicyStateMachine();
    policy.requirePlanReview("chat-1", "review the plan before any writes", undefined, "user-a");

    const cleared = policy.noteUserMessage("chat-1", "tamam, proceed", "user-a");

    expect(cleared).toMatchObject({
      kind: "plan-review-required",
      reason: "review the plan before any writes",
    });
    expect(policy.get("chat-1")).toBeUndefined();
    expect(policy.getWriteBlock("chat-1", true)).toBeNull();
  });

  it("keeps the gate for replies that only start with an approval word (AUT-9)", () => {
    // The approval test used to be a prefix match, so a reply that began with
    // "ok"/"yes"/"continue"/"tamam" cleared the write block even when the rest
    // of it was a condition, a question or an outright "no".
    const feedback = [
      "ok but don't touch the save system yet, change step 3 first",
      "Continue reviewing — no writes yet",
      "yes? what does step 2 do",
      "tamam değil, planı değiştir",
      "go ahead with step 1 only",
      "devam etme",
      "approve after you swap steps 2 and 3",
    ];
    for (const text of feedback) {
      const policy = new InteractionPolicyStateMachine();
      policy.requirePlanReview("chat-1", "review the plan before any writes", undefined, "user-a");
      expect(policy.noteUserMessage("chat-1", text, "user-a"), text).toBeNull();
      expect(policy.getWriteBlock("chat-1", true), text).not.toBeNull();
    }
  });

  it("still clears the gate on short, unconditional approvals (AUT-9)", () => {
    const approvals = [
      "ok",
      "Yes, go ahead",
      "Approve",
      "looks good!",
      "LGTM, ship it",
      "tamam devam et",
      "Evet, onaylıyorum.",
      "sounds good, please proceed",
    ];
    for (const text of approvals) {
      const policy = new InteractionPolicyStateMachine();
      policy.requirePlanReview("chat-1", "review the plan before any writes", undefined, "user-a");
      expect(policy.noteUserMessage("chat-1", text, "user-a"), text).not.toBeNull();
      expect(policy.getWriteBlock("chat-1", true), text).toBeNull();
    }
  });

  it("retains the latest concrete plan text for deferred plan-review surfacing", () => {
    const policy = new InteractionPolicyStateMachine();
    policy.requirePlanReview(
      "chat-1",
      "user explicitly asked to review a plan first",
      "Plan: Inspect the failing path\n\nSteps:\n1. Read the logs\n2. Patch the bug",
      "user-a",
    );
    policy.requirePlanReview("chat-1", "user explicitly asked to review a plan first", undefined, "user-a");

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
    policy.requirePlanReview("chat-1", "user explicitly asked to review a plan first", undefined, "user-a");

    // A tool name the static list has never heard of, classified as a write by
    // the orchestrator, is blocked exactly like file_write.
    expect(policy.getWriteBlock("chat-1", true)).toEqual({
      kind: "plan-review-required",
      reason: "user explicitly asked to review a plan first",
    });
    // No verdict is smuggled in through a tool-name argument.
    expect((policy.getWriteBlock as unknown as (a: string, b: string) => unknown)("chat-1", "file_edit")).toBeNull();
  });

  it("only the user who asked for the plan can approve it (AUT-9)", () => {
    // The gate is keyed by chat, so in a shared Discord/Slack channel another member's
    // "ok" used to approve someone else's plan and unblock writes they never agreed to.
    const policy = new InteractionPolicyStateMachine();
    policy.requirePlanReview("chat-1", "review the plan before any writes", "Plan: rename the module", "user-a");

    expect(policy.noteUserMessage("chat-1", "ok", "user-b")).toBeNull();
    expect(policy.noteUserMessage("chat-1", "Yes, go ahead", "user-b")).toBeNull();
    expect(policy.getWriteBlock("chat-1", true)).not.toBeNull();

    expect(policy.noteUserMessage("chat-1", "ok", "user-a")).toMatchObject({ requestedBy: "user-a" });
    expect(policy.getWriteBlock("chat-1", true)).toBeNull();
  });

  it("a re-parked plan keeps its latest requester", () => {
    const policy = new InteractionPolicyStateMachine();
    policy.requirePlanReview("chat-1", "review the plan before any writes", "Plan A", "user-a");
    policy.requirePlanReview("chat-1", "review the plan before any writes", "Plan B", "user-b");

    expect(policy.noteUserMessage("chat-1", "approve", "user-a")).toBeNull();
    expect(policy.noteUserMessage("chat-1", "approve", "user-b")).not.toBeNull();
  });
});
