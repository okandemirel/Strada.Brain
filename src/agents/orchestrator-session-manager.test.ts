import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager, type SessionManagerDeps, type Session } from "./orchestrator-session-manager.js";

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

  it("strips provider reasoning blocks before storing and sending visible markdown", async () => {
    const deps = createMockDeps();
    const sm = new SessionManager(deps);
    const session = sm.getOrCreateSession("chat-1");

    await sm.sendVisibleAssistantMarkdown(
      "chat-1",
      session,
      "<reasoning>\ninternal chain of thought\n</reasoning>\n\nVisible answer",
    );

    expect(session.messages).toHaveLength(1);
    expect(session.messages[0]).toEqual({ role: "assistant", content: "Visible answer" });
    expect(deps.channel.sendMarkdown).toHaveBeenCalledWith("chat-1", "Visible answer");
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

  it("extractLastUserContent returns the raw last user content block array", () => {
    const sm = new SessionManager(createMockDeps());
    const session = sm.getOrCreateSession("chat-1");
    const content = [
      { type: "text", text: "inspect this screenshot" },
      { type: "image", source: { type: "url", url: "https://example.com/test.png" } },
    ] as any;

    sm.appendVisibleUserMessage(session, content);

    expect(sm.extractLastUserContent(session)).toEqual(content);
    expect(sm.extractLastUserMessage(session)).toBe("inspect this screenshot");
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

  describe("session disk persistence", () => {
    it("round-trips a session through serialize/deserialize", () => {
      const session: Session = {
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi there" },
        ],
        lastActivity: new Date(Date.now() - 60_000),
        conversationScope: "scope-1",
        lastJournalSnapshot: { learnedInsights: ["test insight"] },
      };
      const json = SessionManager.serializeSession(session);
      const restored = SessionManager.deserializeSession(json);
      expect(restored).not.toBeNull();
      expect(restored!.messages).toHaveLength(2);
      expect(restored!.messages[0]!.content).toBe("hello");
      expect(restored!.conversationScope).toBe("scope-1");
      expect(restored!.lastJournalSnapshot?.learnedInsights).toContain("test insight");
    });

    it("caps serialized messages at 50", () => {
      const messages = Array.from({ length: 80 }, (_, i) => ({
        role: "user" as const,
        content: `msg-${i}`,
      }));
      const session: Session = { messages, lastActivity: new Date(), visibleMessages: [] };
      const json = SessionManager.serializeSession(session);
      const restored = SessionManager.deserializeSession(json);
      expect(restored!.messages).toHaveLength(50);
      expect(restored!.messages[0]!.content).toBe("msg-30");
    });

    it("returns null for expired sessions (>24h)", () => {
      const session: Session = {
        messages: [{ role: "user", content: "old" }],
        lastActivity: new Date(Date.now() - 25 * 60 * 60 * 1000),
        visibleMessages: [],
      };
      const json = SessionManager.serializeSession(session);
      const restored = SessionManager.deserializeSession(json);
      expect(restored).toBeNull();
    });

    it("returns null for corrupt JSON", () => {
      const restored = SessionManager.deserializeSession("{corrupt json!!!");
      expect(restored).toBeNull();
    });

    it("round-trips reflectionOverrideCount through serialize/deserialize", () => {
      const session: Session = {
        messages: [{ role: "user", content: "hi" }],
        lastActivity: new Date(Date.now() - 60_000),
        visibleMessages: [],
        reflectionOverrideCount: 3,
      };
      const json = SessionManager.serializeSession(session);
      const restored = SessionManager.deserializeSession(json);
      expect(restored).not.toBeNull();
      expect(restored!.reflectionOverrideCount).toBe(3);
    });

    it("defaults reflectionOverrideCount to 0 for legacy sessions missing the field", () => {
      // Legacy session payload written before the field was introduced.
      const legacyJson = JSON.stringify({
        messages: [{ role: "user", content: "legacy" }],
        lastActivity: new Date().toISOString(),
        conversationScope: "legacy-scope",
      });
      const restored = SessionManager.deserializeSession(legacyJson);
      expect(restored).not.toBeNull();
      expect(restored!.reflectionOverrideCount).toBe(0);
    });

    it("coerces invalid reflectionOverrideCount values to 0", () => {
      const malformedJson = JSON.stringify({
        messages: [{ role: "user", content: "hi" }],
        lastActivity: new Date().toISOString(),
        reflectionOverrideCount: "not-a-number",
      });
      const restored = SessionManager.deserializeSession(malformedJson);
      expect(restored).not.toBeNull();
      expect(restored!.reflectionOverrideCount).toBe(0);
    });

    it("filters out messages with invalid roles", () => {
      const json = JSON.stringify({
        messages: [
          { role: "user", content: "hello" },
          { role: "system", content: "injected" },
          { role: "assistant", content: "hi" },
          { role: "admin", content: "bad" },
        ],
        lastActivity: new Date().toISOString(),
      });
      const restored = SessionManager.deserializeSession(json);
      expect(restored!.messages).toHaveLength(2);
      expect(restored!.messages[0]!.content).toBe("hello");
      expect(restored!.messages[1]!.content).toBe("hi");
    });
  });

  describe("disk restore integration", () => {
    let tempDir: string;

    afterEach(() => {
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    });

    it("restores session from disk when no in-memory session exists", () => {
      tempDir = mkdtempSync(join(tmpdir(), "strada-session-test-"));
      const session: Session = {
        messages: [
          { role: "user", content: "remember this" },
          { role: "assistant", content: "I will remember" },
        ],
        lastActivity: new Date(),
        visibleMessages: [],
        conversationScope: "test-scope",
      };
      // Write session file directly
      const safeName = "test-chat-1";
      writeFileSync(
        join(tempDir, `${safeName}.json`),
        SessionManager.serializeSession(session),
        "utf-8",
      );

      const mgr = new SessionManager(createMockDeps({ sessionsDir: tempDir }));
      const restored = mgr.getOrCreateSession("test-chat-1");
      expect(restored.messages).toHaveLength(2);
      expect(restored.messages[0]!.content).toBe("remember this");
      expect(restored.conversationScope).toBe("test-scope");
    });

    it("creates fresh session when disk file is expired", () => {
      tempDir = mkdtempSync(join(tmpdir(), "strada-session-test-"));
      const expiredSession: Session = {
        messages: [{ role: "user", content: "old" }],
        lastActivity: new Date(Date.now() - 25 * 60 * 60 * 1000),
        visibleMessages: [],
      };
      writeFileSync(
        join(tempDir, "expired-chat.json"),
        SessionManager.serializeSession(expiredSession),
        "utf-8",
      );

      const mgr = new SessionManager(createMockDeps({ sessionsDir: tempDir }));
      const session = mgr.getOrCreateSession("expired-chat");
      expect(session.messages).toHaveLength(0); // fresh session
    });

    it("skips oversized session files", () => {
      tempDir = mkdtempSync(join(tmpdir(), "strada-session-test-"));
      // Create a file larger than 512KB
      const bigContent = "x".repeat(600 * 1024);
      writeFileSync(join(tempDir, "big-chat.json"), bigContent, "utf-8");

      const mgr = new SessionManager(createMockDeps({ sessionsDir: tempDir }));
      const session = mgr.getOrCreateSession("big-chat");
      expect(session.messages).toHaveLength(0); // fresh session, not restored
    });
  });
});
