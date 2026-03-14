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

  it("returns approved when user approves", async () => {
    const context = createToolContext({
      chatId: "test-chat",
      channel: { requestConfirmation: vi.fn().mockResolvedValue("Approve") },
    });

    const result = await tool.execute(
      { summary: "Create combat module", steps: ["Analyze", "Create", "Build"] },
      context,
    );

    expect(result.content).toContain("approved");
    expect(result.isError).toBeUndefined();
  });

  it("returns rejected when user rejects", async () => {
    const context = createToolContext({
      chatId: "test-chat",
      channel: { requestConfirmation: vi.fn().mockResolvedValue("Reject") },
    });

    const result = await tool.execute(
      { summary: "Delete files", steps: ["Delete A", "Delete B"] },
      context,
    );

    expect(result.content).toContain("rejected");
  });

  it("returns modify feedback", async () => {
    const context = createToolContext({
      chatId: "test-chat",
      channel: { requestConfirmation: vi.fn().mockResolvedValue("Modify") },
    });

    const result = await tool.execute(
      { summary: "Refactor", steps: ["Step 1"] },
      context,
    );

    expect(result.content).toContain("modifications");
  });

  it("handles timeout", async () => {
    const context = createToolContext({
      chatId: "test-chat",
      channel: { requestConfirmation: vi.fn().mockResolvedValue("timeout") },
    });

    const result = await tool.execute(
      { summary: "Plan", steps: ["Step 1"] },
      context,
    );

    expect(result.content).toContain("did not respond");
    expect(result.content).toContain("Do NOT proceed");
    expect(result.isError).toBe(true);
  });

  it("shows reasoning in plan", async () => {
    const mockChannel = {
      requestConfirmation: vi.fn().mockResolvedValue("Approve"),
    };
    const context = createToolContext({ chatId: "c", channel: mockChannel });

    await tool.execute(
      { summary: "Plan", steps: ["Step 1"], reasoning: "Because X" },
      context,
    );

    const question = mockChannel.requestConfirmation.mock.calls[0][0].question;
    expect(question).toContain("Because X");
  });

  it("shows numbered steps in plan", async () => {
    const mockChannel = {
      requestConfirmation: vi.fn().mockResolvedValue("Approve"),
    };
    const context = createToolContext({ chatId: "c", channel: mockChannel });

    await tool.execute(
      { summary: "Plan", steps: ["First", "Second", "Third"] },
      context,
    );

    const question = mockChannel.requestConfirmation.mock.calls[0][0].question;
    expect(question).toContain("1. First");
    expect(question).toContain("2. Second");
    expect(question).toContain("3. Third");
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

  it("falls back gracefully when channel has no interactivity", async () => {
    const context = createToolContext({ chatId: "c" });

    const result = await tool.execute(
      { summary: "Plan", steps: ["Step 1"] },
      context,
    );

    expect(result.content).toContain("Unable to get plan approval");
    expect(result.content).toContain("Proceeding");
  });

  it("passes step count in details", async () => {
    const mockChannel = {
      requestConfirmation: vi.fn().mockResolvedValue("Approve"),
    };
    const context = createToolContext({ chatId: "c", channel: mockChannel });

    await tool.execute(
      { summary: "Plan", steps: ["A", "B", "C"] },
      context,
    );

    const details = mockChannel.requestConfirmation.mock.calls[0][0].details;
    expect(details).toContain("3 steps planned");
  });

  it("uses singular 'step' for single step", async () => {
    const mockChannel = {
      requestConfirmation: vi.fn().mockResolvedValue("Approve"),
    };
    const context = createToolContext({ chatId: "c", channel: mockChannel });

    await tool.execute(
      { summary: "Plan", steps: ["Only step"] },
      context,
    );

    const details = mockChannel.requestConfirmation.mock.calls[0][0].details;
    expect(details).toBe("1 step planned");
  });

  it("offers Approve/Modify/Reject options", async () => {
    const mockChannel = {
      requestConfirmation: vi.fn().mockResolvedValue("Approve"),
    };
    const context = createToolContext({ chatId: "c", channel: mockChannel });

    await tool.execute(
      { summary: "Plan", steps: ["Step 1"] },
      context,
    );

    const options = mockChannel.requestConfirmation.mock.calls[0][0].options;
    expect(options).toEqual(["Approve", "Modify", "Reject"]);
  });
});
