import { describe, expect, it, vi } from "vitest";
import {
  createSupervisorNodeVerifier,
  parseSupervisorVerificationVerdict,
} from "../supervisor-verification.js";
import type { NodeResult } from "../supervisor-types.js";

function makeNodeResult(overrides: Partial<NodeResult> = {}): NodeResult {
  return {
    nodeId: "node-1" as any,
    status: "ok",
    output: "Implemented the endpoint.",
    artifacts: [{ path: "src/api/auth.ts", action: "modify" }],
    toolResults: [],
    provider: "claude",
    model: "sonnet",
    cost: 0.1,
    duration: 100,
    ...overrides,
  };
}

describe("parseSupervisorVerificationVerdict", () => {
  it("parses strict JSON verdicts", () => {
    expect(
      parseSupervisorVerificationVerdict(
        '{"verdict":"reject","issues":["Missing tests"]}',
        "deepseek",
      ),
    ).toEqual({
      verdict: "reject",
      issues: ["Missing tests"],
      verifierProvider: "deepseek",
    });
  });

  it("falls back to advisory flagging for non-JSON verifier output", () => {
    expect(
      parseSupervisorVerificationVerdict("I am not comfortable approving this.", "deepseek"),
    ).toMatchObject({
      verdict: "flag_issues",
      verifierProvider: "deepseek",
    });
  });
});

describe("createSupervisorNodeVerifier", () => {
  it("selects a different canonical provider and forwards the review prompt", async () => {
    const reviewer = {
      name: "kimi",
      capabilities: {
        maxTokens: 4096,
        streaming: true,
        structuredStreaming: false,
        toolCalling: true,
        vision: false,
        systemPrompt: true,
      },
      chat: vi.fn().mockResolvedValue({
        text: '{"verdict":"approve"}',
        toolCalls: [],
        stopReason: "end_turn",
        usage: undefined,
      }),
    };
    const verifyNode = createSupervisorNodeVerifier({
      listExecutionCandidates: () => [
        { name: "Claude", defaultModel: "sonnet" },
        { name: "Kimi (Moonshot)", defaultModel: "kimi-for-coding" },
      ],
      listAvailable: () => [{ name: "Kimi (Moonshot)", defaultModel: "kimi-for-coding" }],
      getProviderByName: (name: string) => (name === "kimi" ? reviewer as any : null),
    });

    const verdict = await verifyNode(
      makeNodeResult({ provider: "claude" }),
      { chatId: "chat-1" } as any,
    );

    expect(verdict).toEqual({
      verdict: "approve",
      verifierProvider: "kimi",
    });
    expect(reviewer.chat).toHaveBeenCalledTimes(1);
  });
});
