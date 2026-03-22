import { describe, it, expect, vi } from "vitest";
import { SessionManager, type SessionManagerDeps } from "./orchestrator-session-manager.js";

function createMockDeps(overrides?: Partial<SessionManagerDeps>): SessionManagerDeps {
  return {
    channel: {
      sendText: vi.fn().mockResolvedValue(undefined),
      sendMarkdown: vi.fn().mockResolvedValue(undefined),
    },
    interactionPolicy: { get: vi.fn().mockReturnValue(undefined) },
    activeGoalTrees: new Map(),
    pendingResumeTrees: new Map(),
    instinctRetriever: null,
    eventEmitter: null,
    ...overrides,
  };
}

describe("SessionManager", () => {
  it("creates a new session for unknown chatId", () => {
    const sm = new SessionManager(createMockDeps());
    const session = sm.getOrCreateSession("chat-new");

    expect(session.messages).toEqual([]);
    expect(session.visibleMessages).toEqual([]);
    expect(sm.sessions.has("chat-new")).toBe(true);
  });

  it("returns existing session and refreshes LRU order", () => {
    const sm = new SessionManager(createMockDeps());
    sm.getOrCreateSession("chat-1");
    sm.getOrCreateSession("chat-2");

    // Access chat-1 again to move it to the end (most recent)
    sm.getOrCreateSession("chat-1");

    const keys = [...sm.sessions.keys()];
    expect(keys).toEqual(["chat-2", "chat-1"]);
  });

  it("appendVisibleAssistantMessage adds to both messages and visibleMessages", () => {
    const sm = new SessionManager(createMockDeps());
    const session = sm.getOrCreateSession("chat-1");

    sm.appendVisibleAssistantMessage(session, "Hello there");

    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]).toEqual({ role: "assistant", content: "Hello there" });
    expect(session.visibleMessages).toHaveLength(1);
    expect(session.visibleMessages![0]).toBe(session.messages[0]);
  });

  it("getVisibleTranscript returns visible messages", () => {
    const sm = new SessionManager(createMockDeps());
    const session = sm.getOrCreateSession("chat-1");

    sm.appendVisibleUserMessage(session, "Hi");
    sm.appendVisibleAssistantMessage(session, "Hello!");

    const transcript = sm.getVisibleTranscript(session);
    expect(transcript).toHaveLength(2);
    expect(transcript[0]!.role).toBe("user");
    expect(transcript[1]!.role).toBe("assistant");
  });

  it("sendVisibleAssistantMarkdown appends message and calls channel", async () => {
    const deps = createMockDeps();
    const sm = new SessionManager(deps);
    const session = sm.getOrCreateSession("chat-1");

    await sm.sendVisibleAssistantMarkdown("chat-1", session, "**bold**");

    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]).toEqual({ role: "assistant", content: "**bold**" });
    expect(deps.channel.sendMarkdown).toHaveBeenCalledWith("chat-1", "**bold**");
  });

  it("extractLastUserMessage returns last user string content", () => {
    const sm = new SessionManager(createMockDeps());
    const session = sm.getOrCreateSession("chat-1");

    sm.appendVisibleUserMessage(session, "first");
    sm.appendVisibleAssistantMessage(session, "response");
    sm.appendVisibleUserMessage(session, "second");

    expect(sm.extractLastUserMessage(session)).toBe("second");
  });

  it("extractLastUserMessage returns empty string for empty session", () => {
    const sm = new SessionManager(createMockDeps());
    const session = sm.getOrCreateSession("chat-1");

    expect(sm.extractLastUserMessage(session)).toBe("");
  });

  it("trimSession returns empty array when under limit", () => {
    const sm = new SessionManager(createMockDeps());
    const session = sm.getOrCreateSession("chat-1");

    sm.appendVisibleUserMessage(session, "hello");

    const trimmed = sm.trimSession(session, 10);
    expect(trimmed).toEqual([]);
  });

  it("trimSession removes oldest messages when exceeding max", () => {
    const sm = new SessionManager(createMockDeps());
    const session = sm.getOrCreateSession("chat-1");

    // Add 6 messages (3 user-assistant pairs)
    sm.appendVisibleUserMessage(session, "user-1");
    sm.appendVisibleAssistantMessage(session, "assistant-1");
    sm.appendVisibleUserMessage(session, "user-2");
    sm.appendVisibleAssistantMessage(session, "assistant-2");
    sm.appendVisibleUserMessage(session, "user-3");
    sm.appendVisibleAssistantMessage(session, "assistant-3");

    const trimmed = sm.trimSession(session, 4);

    // Should have trimmed some messages
    expect(session.messages.length).toBeLessThan(6);
    expect(trimmed.length).toBeGreaterThan(0);
  });

  it("getPendingPlanReviewVisibleText returns null when no gate", () => {
    const sm = new SessionManager(createMockDeps());

    expect(sm.getPendingPlanReviewVisibleText("chat-1")).toBeNull();
  });

  it("getPendingPlanReviewVisibleText returns formatted plan when gate has planText", () => {
    const deps = createMockDeps({
      interactionPolicy: {
        get: vi.fn().mockReturnValue({
          kind: "plan-review-required",
          planText: "Step 1\nStep 2",
        }),
      },
    });
    const sm = new SessionManager(deps);

    const result = sm.getPendingPlanReviewVisibleText("chat-1");

    expect(result).not.toBeNull();
    expect(result).toContain("Plan review requested");
    expect(result).toContain("Step 1");
    expect(result).toContain("Step 2");
  });

  it("cleanupSessions removes expired sessions", () => {
    const sm = new SessionManager(createMockDeps());
    const session = sm.getOrCreateSession("chat-1");

    // Set lastActivity to 2 hours ago
    session.lastActivity = new Date(Date.now() - 2 * 60 * 60 * 1000);

    sm.cleanupSessions(3_600_000);

    expect(sm.sessions.has("chat-1")).toBe(false);
  });

  it("cleanupSessions skips locked sessions", () => {
    const sm = new SessionManager(createMockDeps());
    const session = sm.getOrCreateSession("chat-1");

    // Set lastActivity to 2 hours ago
    session.lastActivity = new Date(Date.now() - 2 * 60 * 60 * 1000);

    // Add a session lock
    sm.sessionLocks.set("chat-1", Promise.resolve());

    sm.cleanupSessions(3_600_000);

    expect(sm.sessions.has("chat-1")).toBe(true);
  });
});
