import { describe, it, expect, vi } from "vitest";
import { TaskDecomposer } from "./task-decomposer.js";

describe("TaskDecomposer", () => {
  const mockProvider = {
    name: "mock",
    capabilities: {
      maxTokens: 4096,
      toolCalling: true,
      streaming: false,
      vision: false,
      systemPrompt: true,
      structuredStreaming: false,
    },
    chat: vi.fn(),
  };

  // ─── shouldDecompose ────────────────────────────────────────────────────────

  describe("shouldDecompose", () => {
    it("should decompose complex multi-step requests", () => {
      const decomposer = new TaskDecomposer();
      expect(
        decomposer.shouldDecompose(
          "Create a new module called PlayerHealth with a HealthComponent, a DamageSystem, and unit tests for both",
        ),
      ).toBe(true);
    });

    it("should decompose requests with multiple 'and' conjunctions", () => {
      const decomposer = new TaskDecomposer();
      expect(
        decomposer.shouldDecompose(
          "Add a movement system and a collision handler and wire them together",
        ),
      ).toBe(true);
    });

    it("should decompose requests with sequential instructions", () => {
      const decomposer = new TaskDecomposer();
      expect(
        decomposer.shouldDecompose(
          "First create the interface, then implement the class, finally add tests",
        ),
      ).toBe(true);
    });

    it("should decompose requests with numbered items", () => {
      const decomposer = new TaskDecomposer();
      expect(
        decomposer.shouldDecompose("Create 3 component files for the inventory system"),
      ).toBe(true);
    });

    it("should NOT decompose simple single-step requests", () => {
      const decomposer = new TaskDecomposer();
      expect(decomposer.shouldDecompose("Read the file Player.cs")).toBe(false);
      expect(decomposer.shouldDecompose("Build the project")).toBe(false);
    });

    it("should NOT decompose very short prompts", () => {
      const decomposer = new TaskDecomposer();
      expect(decomposer.shouldDecompose("fix bug")).toBe(false);
      expect(decomposer.shouldDecompose("run tests")).toBe(false);
    });

    it("should NOT decompose simple read/show/list commands", () => {
      const decomposer = new TaskDecomposer();
      expect(decomposer.shouldDecompose("Show me the current health system implementation")).toBe(false);
      expect(decomposer.shouldDecompose("List all components in the project")).toBe(false);
      expect(decomposer.shouldDecompose("Find the PlayerMovement class")).toBe(false);
    });

    it("should NOT decompose simple build/test/compile commands", () => {
      const decomposer = new TaskDecomposer();
      expect(decomposer.shouldDecompose("Test the damage calculation module")).toBe(false);
      expect(decomposer.shouldDecompose("Compile the project with debug flags")).toBe(false);
    });
  });

  // ─── decompose ──────────────────────────────────────────────────────────────

  describe("decompose", () => {
    it("should decompose into ordered subtasks via LLM", async () => {
      mockProvider.chat.mockResolvedValueOnce({
        text: JSON.stringify({
          subtasks: [
            "Create HealthComponent.cs with base health properties",
            "Create DamageSystem.cs that references HealthComponent",
            "Create unit tests for HealthComponent",
            "Create unit tests for DamageSystem",
          ],
        }),
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 50, outputTokens: 100, totalTokens: 150 },
      });

      const decomposer = new TaskDecomposer(mockProvider as any);
      const subtasks = await decomposer.decompose(
        "Create a new module called PlayerHealth with a HealthComponent, a DamageSystem, and unit tests for both",
      );

      expect(subtasks.length).toBeGreaterThanOrEqual(3);
      expect(subtasks[0]).toContain("HealthComponent");
      expect(mockProvider.chat).toHaveBeenCalledTimes(1);
    });

    it("should pass system prompt and user message to provider", async () => {
      mockProvider.chat.mockResolvedValueOnce({
        text: JSON.stringify({ subtasks: ["step 1"] }),
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 50, outputTokens: 50, totalTokens: 100 },
      });

      const decomposer = new TaskDecomposer(mockProvider as any);
      await decomposer.decompose("do something complex");

      expect(mockProvider.chat).toHaveBeenCalledWith(
        expect.stringContaining("task decomposer"),
        expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("do something complex"),
          }),
        ]),
        [],
      );
    });

    it("falls back to single task on decomposition failure", async () => {
      mockProvider.chat.mockRejectedValueOnce(new Error("API error"));

      const decomposer = new TaskDecomposer(mockProvider as any);
      const subtasks = await decomposer.decompose("complex task");

      expect(subtasks).toEqual(["complex task"]);
    });

    it("falls back to single task when response is not valid JSON", async () => {
      mockProvider.chat.mockResolvedValueOnce({
        text: "this is not json",
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 50, outputTokens: 50, totalTokens: 100 },
      });

      const decomposer = new TaskDecomposer(mockProvider as any);
      const subtasks = await decomposer.decompose("complex task");

      expect(subtasks).toEqual(["complex task"]);
    });

    it("falls back to single task when subtasks array is empty", async () => {
      mockProvider.chat.mockResolvedValueOnce({
        text: JSON.stringify({ subtasks: [] }),
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 50, outputTokens: 50, totalTokens: 100 },
      });

      const decomposer = new TaskDecomposer(mockProvider as any);
      const subtasks = await decomposer.decompose("complex task");

      expect(subtasks).toEqual(["complex task"]);
    });

    it("falls back to single task when no provider is set", async () => {
      const decomposer = new TaskDecomposer();
      const subtasks = await decomposer.decompose("complex task");

      expect(subtasks).toEqual(["complex task"]);
    });

    it("strips markdown code fences from LLM response", async () => {
      mockProvider.chat.mockResolvedValueOnce({
        text: '```json\n{"subtasks": ["step 1", "step 2"]}\n```',
        toolCalls: [],
        stopReason: "end_turn",
        usage: { inputTokens: 50, outputTokens: 50, totalTokens: 100 },
      });

      const decomposer = new TaskDecomposer(mockProvider as any);
      const subtasks = await decomposer.decompose("complex task");

      expect(subtasks).toEqual(["step 1", "step 2"]);
    });
  });
});
