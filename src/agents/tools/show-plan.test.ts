import { describe, it, expect, vi } from "vitest";
import { ShowPlanTool } from "./show-plan.js";
import { createToolContext } from "../../test-helpers.js";

describe("ShowPlanTool", () => {
  const tool = new ShowPlanTool();

  it("has correct name and schema", () => {
    expect(tool.name).toBe("show_plan");
    expect(tool.inputSchema.required).toContain("summary");
    expect(tool.inputSchema.required).toContain("steps");
  });

  it("returns an internal review result instead of waiting for approval", async () => {
    const result = await tool.execute(
      { summary: "Create combat module", steps: ["Analyze", "Create", "Build"] },
      createToolContext({ chatId: "test-chat" }),
    );

    expect(result.content).toContain("Plan surfaced for Strada's internal review");
    expect(result.content).toContain("Proceed without waiting for user approval");
    expect(result.isError).toBeUndefined();
  });

  it("shows reasoning in plan", async () => {
    const result = await tool.execute(
      { summary: "Plan", steps: ["Step 1"], reasoning: "Because X" },
      createToolContext({ chatId: "c" }),
    );

    expect(result.content).toContain("Because X");
  });

  it("shows numbered steps in plan", async () => {
    const result = await tool.execute(
      { summary: "Plan", steps: ["First", "Second", "Third"] },
      createToolContext({ chatId: "c" }),
    );

    expect(result.content).toContain("1. First");
    expect(result.content).toContain("2. Second");
    expect(result.content).toContain("3. Third");
  });

  it("returns error when summary is empty", async () => {
    const result = await tool.execute({ summary: "", steps: ["a"] }, createToolContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Error");
  });

  it("returns error when steps are empty", async () => {
    const result = await tool.execute({ summary: "Plan", steps: [] }, createToolContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Error");
  });

  it("returns error when steps are missing", async () => {
    const result = await tool.execute({ summary: "Plan" }, createToolContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Error");
  });

  it("reports plural step count in the internal review message", async () => {
    const result = await tool.execute(
      { summary: "Plan", steps: ["A", "B", "C"] },
      createToolContext({ chatId: "c" }),
    );

    expect(result.content).toContain("3 steps");
  });

  it("uses singular 'step' for a single-step plan", async () => {
    const result = await tool.execute(
      { summary: "Plan", steps: ["Only step"] },
      createToolContext({ chatId: "c" }),
    );

    expect(result.content).toContain("1 step");
  });
});
