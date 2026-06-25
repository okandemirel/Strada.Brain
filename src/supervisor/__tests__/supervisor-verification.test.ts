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

  it("routes the verification review through chatStream when the reviewer streams", async () => {
    // A reasoning-capable reviewer that streams. The verification call MUST go through
    // chatStream (clears the FallbackChain first-response timer) — never the blocking chat().
    const chatStream = vi.fn(
      async (
        _system: string,
        _messages: unknown,
        _tools: unknown,
        onChunk: (chunk: string) => void,
      ) => {
        onChunk('{"verdict":');
        onChunk('"approve"}');
        return {
          text: '{"verdict":"approve"}',
          toolCalls: [],
          stopReason: "end_turn",
          usage: undefined,
        };
      },
    );
    const reviewer = {
      name: "deepseek",
      capabilities: {
        maxTokens: 4096,
        streaming: true,
        structuredStreaming: false,
        toolCalling: true,
        vision: false,
        systemPrompt: true,
      },
      chat: vi.fn(),
      chatStream,
    };
    const verifyNode = createSupervisorNodeVerifier({
      listExecutionCandidates: () => [
        { name: "Claude", defaultModel: "sonnet" },
        { name: "DeepSeek", defaultModel: "deepseek-v4-pro" },
      ],
      listAvailable: () => [{ name: "DeepSeek", defaultModel: "deepseek-v4-pro" }],
      getProviderByName: (name: string) => (name === "deepseek" ? (reviewer as any) : null),
    });

    const verdict = await verifyNode(
      makeNodeResult({ provider: "claude" }),
      { chatId: "chat-1" } as any,
    );

    expect(verdict).toEqual({ verdict: "approve", verifierProvider: "deepseek" });
    expect(chatStream).toHaveBeenCalledTimes(1);
    expect(reviewer.chat).not.toHaveBeenCalled();
  });

  it("recovers a slow reviewer that streams chunks but returns empty response.text", async () => {
    const chatStream = vi.fn(
      async (
        _system: string,
        _messages: unknown,
        _tools: unknown,
        onChunk: (chunk: string) => void,
      ) => {
        onChunk('{"verdict":"reject",');
        onChunk('"issues":["No tests"]}');
        // Provider delivered only via chunks → empty .text; the accumulator reconstructs it.
        return { text: "", toolCalls: [], stopReason: "end_turn", usage: undefined };
      },
    );
    const reviewer = {
      name: "deepseek",
      capabilities: {
        maxTokens: 4096,
        streaming: true,
        structuredStreaming: false,
        toolCalling: true,
        vision: false,
        systemPrompt: true,
      },
      chat: vi.fn(),
      chatStream,
    };
    const verifyNode = createSupervisorNodeVerifier({
      listExecutionCandidates: () => [
        { name: "Claude", defaultModel: "sonnet" },
        { name: "DeepSeek", defaultModel: "deepseek-v4-pro" },
      ],
      listAvailable: () => [{ name: "DeepSeek", defaultModel: "deepseek-v4-pro" }],
      getProviderByName: (name: string) => (name === "deepseek" ? (reviewer as any) : null),
    });

    const verdict = await verifyNode(
      makeNodeResult({ provider: "claude" }),
      { chatId: "chat-1" } as any,
    );

    expect(verdict).toMatchObject({ verdict: "reject", verifierProvider: "deepseek" });
    expect(chatStream).toHaveBeenCalledTimes(1);
  });
});
