/**
 * One OpenCode session per chat (2026-11-05).
 *
 * OpenCode asks for an `x-opencode-session` that stays the same for one
 * conversation, so it can route the conversation's calls to where their prefix
 * is already cached. The provider object serves every chat, and it sent the one
 * id it generated at construction, so every chat went out under one session and
 * none had its own.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { OpencodeProvider } from "./opencode.js";
import { chatSessionId, currentChatId, withChatScope } from "./chat-scope.js";
import { Orchestrator } from "../orchestrator.js";
import { createMockChannel, createMockProvider } from "../../test-helpers.js";
import { createLogger } from "../../utils/logger.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The x-opencode-session of every request sent while `send` runs, in order. */
async function sessionsSent(send: () => Promise<unknown>): Promise<string[]> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: "ok", tool_calls: [] }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 1 },
    }),
    text: async () => "",
  });
  vi.stubGlobal("fetch", fetchMock);
  await send();
  return fetchMock.mock.calls.map(([, init]) => (init as { headers: Record<string, string> }).headers["x-opencode-session"]!);
}

const ask = (provider: OpencodeProvider) => provider.chat("system", [{ role: "user", content: "hi" }], []);

describe("x-opencode-session is per chat", () => {
  it("one chat sends the same session id on every call, and two chats send different ones", async () => {
    const provider = new OpencodeProvider("sk-test", "deepseek-v4-flash", undefined, "opencode");
    const [first, again] = await sessionsSent(async () => {
      await withChatScope("chat-a", () => ask(provider));
      await withChatScope("chat-a", () => ask(provider));
    });
    const [other] = await sessionsSent(() => withChatScope("chat-b", () => ask(provider)));

    expect(first).toBe(chatSessionId("chat-a"));
    expect(again).toBe(first);
    expect(other).toBe(chatSessionId("chat-b"));
    expect(other).not.toBe(first);
  });

  it("the chat keeps its session on another account and after a restart, and the raw chat id is not sent", async () => {
    const [onFirst] = await sessionsSent(() => withChatScope("telegram-12345", () => ask(new OpencodeProvider("sk-a"))));
    const [onSecond] = await sessionsSent(() => withChatScope("telegram-12345", () => ask(new OpencodeProvider("sk-b"))));

    expect(onSecond).toBe(onFirst);
    expect(onFirst).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(onFirst).not.toContain("12345");
  });

  it("a call outside any chat keeps the provider's own id: stable per instance, different across instances", async () => {
    const provider = new OpencodeProvider("sk-test");
    const [outside, outsideAgain, otherInstance] = await sessionsSent(async () => {
      await ask(provider);
      await ask(provider);
      await ask(new OpencodeProvider("sk-test"));
    });

    expect(currentChatId()).toBeUndefined();
    expect(outsideAgain).toBe(outside);
    expect(otherInstance).not.toBe(outside);
  });

  it("the orchestrator's task scope names its chat to the provider, and a nested scope's chat wins inside it", async () => {
    const orch = new Orchestrator({
      providerManager: {
        getProvider: () => createMockProvider(),
        getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
        shutdown: vi.fn(),
      } as never,
      tools: [] as never,
      channel: createMockChannel() as never,
      projectPath: "/tmp/chat-scope-test",
      readOnly: false,
      requireConfirmation: false,
    });
    const provider = new OpencodeProvider("sk-test");

    const sent = await sessionsSent(() =>
      orch.withTaskExecutionContext({ chatId: "chat-a" }, async () => {
        await ask(provider);
        await orch.withTaskExecutionContext({ chatId: "chat-b" }, () => ask(provider));
        await ask(provider);
      }),
    );

    expect(sent).toEqual([chatSessionId("chat-a"), chatSessionId("chat-b"), chatSessionId("chat-a")]);
  });
});
