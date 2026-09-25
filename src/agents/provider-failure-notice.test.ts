/**
 * ORC-21 — a failed provider call tells the model once, without the raw error.
 *
 * The notice is a user-role turn on a persistent session: it is written to
 * disk and resent on every later call. It used to be appended once per failed
 * call with the provider's error body verbatim, and it displaced the user's
 * real last message for everything that reads "what did the user last say".
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { Orchestrator } from "./orchestrator.js";
import { SessionManager, type Session } from "./orchestrator-session-manager.js";
import { createMockChannel, createMockProvider } from "../test-helpers.js";
import { createLogger } from "../utils/logger.js";

beforeAll(() => {
  createLogger("error", "test.log");
});

const LEAKY_ERROR =
  "401 Unauthorized: invalid x-api-key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 for org acme-prod " +
  "request_id=req_42 " + "x".repeat(2_000);

function orchestrator() {
  return new Orchestrator({
    providerManager: {
      getProvider: () => createMockProvider(),
      getActiveInfo: () => ({ providerName: "mock", model: "default", isDefault: true }),
      shutdown: vi.fn(),
    } as never,
    tools: [],
    channel: createMockChannel() as never,
    projectPath: "/tmp/provider-failure-notice-test",
    readOnly: false,
    requireConfirmation: false,
  });
}

const failingProvider = () => ({
  name: "claude",
  capabilities: { maxTokens: 4096, streaming: false, toolCalling: true, vision: false, systemPrompt: true },
  chat: vi.fn().mockRejectedValue(new Error(LEAKY_ERROR)),
});

const notices = (session: Session) =>
  session.messages.filter(
    (m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("[System: The AI provider"),
  );

describe("provider-failure notice (ORC-21)", () => {
  it("repeated failures leave one redacted, bounded notice on the session", async () => {
    const orch = orchestrator();
    const session: Session = {
      messages: [{ role: "user", content: "rename the player controller" }],
      visibleMessages: [],
      lastActivity: new Date(),
    };
    const provider = failingProvider();
    const fallback = (orch as unknown as {
      silentStreamFallback: (p: unknown, prompt: string, s: Session, tools: unknown[], signal: undefined, chatId: string) => Promise<unknown>;
    }).silentStreamFallback.bind(orch);

    for (let i = 0; i < 3; i++) await fallback(provider, "system", session, [], undefined, "chat-1");

    const left = notices(session);
    expect(left).toHaveLength(1);
    const text = String(left[0]!.content);
    expect(text).toContain("claude");
    expect(text).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123");
    expect(text.length).toBeLessThan(700);
    orch.dispose();
  });

  it("the notice is not taken for the user's last message", () => {
    const sm = new SessionManager({} as never);
    const session: Session = {
      messages: [{ role: "user", content: "rename the player controller" }],
      visibleMessages: [],
      lastActivity: new Date(),
    };
    // As the fallback path leaves it after a failed call.
    session.messages.push({
      role: "user",
      content: "[System: The AI provider (claude) failed to respond. Error: timeout. Adapt your approach and continue.]",
    });

    expect(sm.extractLastUserMessage(session)).toBe("rename the player controller");
    sm.dispose();
  });
});
