import { describe, it, expect, vi } from "vitest";
import { AskUserTool } from "./ask-user.js";
import { createToolContext } from "../../test-helpers.js";

describe("AskUserTool", () => {
  const tool = new AskUserTool();

  it("has correct name and schema", () => {
    expect(tool.name).toBe("ask_user");
    expect(tool.inputSchema.required).toContain("question");
  });

  it("returns user response from confirmation", async () => {
    const mockChannel = {
      requestConfirmation: vi.fn().mockResolvedValue("Turn-based"),
    };
    const context = createToolContext({ chatId: "test-chat", channel: mockChannel });

    const result = await tool.execute(
      { question: "What type?", options: ["Turn-based", "Real-time"], recommended: "Turn-based" },
      context,
    );

    expect(result.content).toBe("User answered: Turn-based");
    expect(result.isError).toBeUndefined();
    expect(mockChannel.requestConfirmation).toHaveBeenCalledOnce();
    const call = mockChannel.requestConfirmation.mock.calls[0][0];
    expect(call.options).toContain("Turn-based");
    expect(call.options).toContain("Real-time");
    expect(call.options).not.toContain("Other (I'll type my answer)");
  });

  it("handles timeout", async () => {
    const context = createToolContext({
      chatId: "test-chat",
      channel: { requestConfirmation: vi.fn().mockResolvedValue("timeout") },
    });

    const result = await tool.execute({ question: "Hello?" }, context);
    expect(result.content).toContain("did not respond");
  });

  it("handles open-ended question (no options)", async () => {
    const context = createToolContext({
      chatId: "test-chat",
      channel: { requestConfirmation: vi.fn().mockResolvedValue("Yes") },
    });

    const result = await tool.execute({ question: "Should I proceed?" }, context);
    expect(result.content).toBe("User answered: Yes");
  });

  it("returns error when question is empty", async () => {
    const result = await tool.execute({}, createToolContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Error");
  });

  it("returns error when question is whitespace-only", async () => {
    const result = await tool.execute({ question: "   " }, createToolContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Error");
  });

  it("includes recommended option in message", async () => {
    const mockChannel = {
      requestConfirmation: vi.fn().mockResolvedValue("Option A"),
    };
    const context = createToolContext({ chatId: "c", channel: mockChannel });

    await tool.execute(
      { question: "Pick?", options: ["Option A", "Option B"], recommended: "Option A" },
      context,
    );

    const question = mockChannel.requestConfirmation.mock.calls[0][0].question;
    expect(question).toContain("recommended");
  });

  it("includes context in the question message", async () => {
    const mockChannel = {
      requestConfirmation: vi.fn().mockResolvedValue("Yes"),
    };
    const context = createToolContext({ chatId: "c", channel: mockChannel });

    await tool.execute(
      { question: "Continue?", context: "The project has unsaved changes." },
      context,
    );

    const question = mockChannel.requestConfirmation.mock.calls[0][0].question;
    expect(question).toContain("unsaved changes");
  });

  it("does not include 'Other' option — user selects from provided options", async () => {
    const mockChannel = {
      requestConfirmation: vi.fn().mockResolvedValue("A"),
    };
    const context = createToolContext({ chatId: "c", channel: mockChannel });

    await tool.execute(
      { question: "Pick?", options: ["A", "B"] },
      context,
    );

    const options = mockChannel.requestConfirmation.mock.calls[0][0].options;
    expect(options).toEqual(["A", "B"]);
    expect(options).not.toContain("Other (I'll type my answer)");
  });

  it("falls back gracefully when channel has no interactivity", async () => {
    const context = createToolContext({ chatId: "c" });

    const result = await tool.execute({ question: "Pick?" }, context);
    expect(result.content).toContain("Unable to ask user interactively");
  });

  it("falls back when channel exists but lacks requestConfirmation", async () => {
    const context = createToolContext({ chatId: "c", channel: { sendText: vi.fn() } });

    const result = await tool.execute({ question: "Pick?" }, context);
    expect(result.content).toContain("Unable to ask user interactively");
  });

  it("uses Continue/Cancel default options for open-ended questions", async () => {
    const mockChannel = {
      requestConfirmation: vi.fn().mockResolvedValue("Continue"),
    };
    const context = createToolContext({ chatId: "c", channel: mockChannel });

    await tool.execute({ question: "Continue?" }, context);

    const call = mockChannel.requestConfirmation.mock.calls[0][0];
    expect(call.options).toEqual(["Continue", "Cancel"]);
  });
});
