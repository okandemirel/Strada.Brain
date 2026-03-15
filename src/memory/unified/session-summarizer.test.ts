/**
 * Tests for SessionSummarizer
 *
 * Covers: LLM summarization, profile update, error handling,
 * malformed JSON, empty messages.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { SessionSummarizer } from "./session-summarizer.js";
import type { SessionSummary } from "./session-summarizer.js";
import type { IAIProvider } from "../../agents/providers/provider.interface.js";
import type { UserProfileStore } from "./user-profile-store.js";

// =============================================================================
// MOCK SETUP
// =============================================================================

const VALID_SUMMARY: SessionSummary = {
  summary: "User discussed combat system design",
  keyDecisions: ["Use ECS pattern"],
  openItems: ["Implement DamageCalculator"],
  topics: ["combat", "ECS"],
};

function createMockProvider(
  responseText: string = JSON.stringify(VALID_SUMMARY),
): IAIProvider {
  return {
    chat: vi.fn().mockResolvedValue({
      text: responseText,
      toolCalls: [],
      stopReason: "end_turn" as const,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    }),
    name: "test",
    capabilities: {
      maxTokens: 4096,
      streaming: false,
      structuredStreaming: false,
      toolCalling: false,
      vision: false,
      systemPrompt: true,
    },
  } as unknown as IAIProvider;
}

function createMockProfileStore(): UserProfileStore {
  return {
    updateContextSummary: vi.fn(),
    upsertProfile: vi.fn(),
    getProfile: vi.fn().mockReturnValue(null),
    setActivePersona: vi.fn(),
    touchLastSeen: vi.fn(),
  } as unknown as UserProfileStore;
}

// =============================================================================
// TESTS
// =============================================================================

describe("SessionSummarizer", () => {
  let provider: IAIProvider;
  let profileStore: UserProfileStore;
  let summarizer: SessionSummarizer;

  beforeEach(() => {
    provider = createMockProvider();
    profileStore = createMockProfileStore();
    summarizer = new SessionSummarizer(provider, profileStore);
  });

  // ---------------------------------------------------------------------------
  // summarize
  // ---------------------------------------------------------------------------

  describe("summarize", () => {
    it("calls LLM and parses JSON response into SessionSummary", async () => {
      const messages = [
        { role: "user" as const, content: "Let's design a combat system" },
        { role: "assistant" as const, content: "Sure, I suggest using ECS pattern" },
        { role: "user" as const, content: "Good idea, what about damage calc?" },
      ];

      const result = await summarizer.summarize("chat-1", messages);

      expect(result.summary).toBe("User discussed combat system design");
      expect(result.keyDecisions).toEqual(["Use ECS pattern"]);
      expect(result.openItems).toEqual(["Implement DamageCalculator"]);
      expect(result.topics).toEqual(["combat", "ECS"]);

      // Verify LLM was called with system prompt and formatted messages
      expect(provider.chat).toHaveBeenCalledTimes(1);
      const callArgs = (provider.chat as ReturnType<typeof vi.fn>).mock.calls[0];
      // System prompt should ask for JSON
      expect(callArgs[0]).toContain("JSON");
      // Messages should be passed
      expect(callArgs[1]).toBeDefined();
      // Tools should be empty array
      expect(callArgs[2]).toEqual([]);
    });

    it("returns empty summary without calling LLM when messages is empty", async () => {
      const result = await summarizer.summarize("chat-2", []);

      expect(result.summary).toBe("");
      expect(result.keyDecisions).toEqual([]);
      expect(result.openItems).toEqual([]);
      expect(result.topics).toEqual([]);
      expect(provider.chat).not.toHaveBeenCalled();
    });

    it("handles LLM failure gracefully (returns empty summary, does not throw)", async () => {
      const failingProvider = createMockProvider();
      (failingProvider.chat as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("API rate limit exceeded"),
      );
      const failSummarizer = new SessionSummarizer(failingProvider, profileStore);

      const messages = [
        { role: "user" as const, content: "Hello" },
      ];

      const result = await failSummarizer.summarize("chat-3", messages);

      expect(result.summary).toBe("");
      expect(result.keyDecisions).toEqual([]);
      expect(result.openItems).toEqual([]);
      expect(result.topics).toEqual([]);
    });

    it("handles malformed LLM JSON response (returns empty summary)", async () => {
      const malformedProvider = createMockProvider("This is not JSON at all {{{");
      const malformedSummarizer = new SessionSummarizer(malformedProvider, profileStore);

      const messages = [
        { role: "user" as const, content: "Hello" },
      ];

      const result = await malformedSummarizer.summarize("chat-4", messages);

      expect(result.summary).toBe("");
      expect(result.keyDecisions).toEqual([]);
      expect(result.openItems).toEqual([]);
      expect(result.topics).toEqual([]);
    });

    it("strips markdown fencing from LLM response before parsing", async () => {
      const fencedJson = "```json\n" + JSON.stringify(VALID_SUMMARY) + "\n```";
      const fencedProvider = createMockProvider(fencedJson);
      const fencedSummarizer = new SessionSummarizer(fencedProvider, profileStore);

      const messages = [
        { role: "user" as const, content: "Hello" },
      ];

      const result = await fencedSummarizer.summarize("chat-5", messages);

      expect(result.summary).toBe("User discussed combat system design");
      expect(result.topics).toEqual(["combat", "ECS"]);
    });

    it("defaults missing fields to empty arrays", async () => {
      const partialProvider = createMockProvider(
        JSON.stringify({ summary: "Partial response" }),
      );
      const partialSummarizer = new SessionSummarizer(partialProvider, profileStore);

      const messages = [
        { role: "user" as const, content: "Hello" },
      ];

      const result = await partialSummarizer.summarize("chat-6", messages);

      expect(result.summary).toBe("Partial response");
      expect(result.keyDecisions).toEqual([]);
      expect(result.openItems).toEqual([]);
      expect(result.topics).toEqual([]);
    });

    it("handles MessageContent[] content in user messages", async () => {
      const messages = [
        {
          role: "user" as const,
          content: [
            { type: "text" as const, text: "Check this image" },
            { type: "image" as const, source: { type: "url" as const, url: "https://example.com/img.png" } },
          ],
        },
        { role: "assistant" as const, content: "I see the image" },
      ];

      const result = await summarizer.summarize("chat-7", messages);

      expect(result.summary).toBe("User discussed combat system design");
      // Verify chat was called (messages were formatted correctly)
      expect(provider.chat).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // summarizeAndUpdateProfile
  // ---------------------------------------------------------------------------

  describe("summarizeAndUpdateProfile", () => {
    it("calls summarize then updates profile store", async () => {
      const messages = [
        { role: "user" as const, content: "Let's discuss shaders" },
        { role: "assistant" as const, content: "Sure, let's start with vertex shaders" },
      ];

      const result = await summarizer.summarizeAndUpdateProfile("chat-10", messages);

      expect(result.summary).toBe("User discussed combat system design");
      expect(profileStore.updateContextSummary).toHaveBeenCalledTimes(1);
      expect(profileStore.updateContextSummary).toHaveBeenCalledWith(
        "chat-10",
        "User discussed combat system design\n\nOpen items: Implement DamageCalculator",
        ["combat", "ECS"],
      );
    });

    it("does not update profile when summary is empty (empty messages)", async () => {
      const result = await summarizer.summarizeAndUpdateProfile("chat-11", []);

      expect(result.summary).toBe("");
      expect(profileStore.updateContextSummary).not.toHaveBeenCalled();
    });

    it("returns summary even when profile update fails", async () => {
      (profileStore.updateContextSummary as ReturnType<typeof vi.fn>).mockImplementation(
        () => {
          throw new Error("Database write failed");
        },
      );

      const messages = [
        { role: "user" as const, content: "Hello" },
      ];

      const result = await summarizer.summarizeAndUpdateProfile("chat-12", messages);

      // Summary should still be returned despite profile update failure
      expect(result.summary).toBe("User discussed combat system design");
      expect(result.topics).toEqual(["combat", "ECS"]);
    });
  });
});
