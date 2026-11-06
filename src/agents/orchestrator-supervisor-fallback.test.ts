import { describe, it, expect, vi } from "vitest";
import { announceSupervisorFallback } from "./orchestrator-supervisor-fallback.js";
import type { IChannelSender } from "../channels/channel-core.interface.js";

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const PROMPT = "Draft the quarterly bakery inventory report and the supplier summary";
const SENTENCE = "Planning across several agents failed, so one agent is handling this request on its own.";
const NOTE = "Supervisor failed; one agent takes the request over. Error: planner crashed";

function channel(overrides: Partial<IChannelSender> = {}): IChannelSender & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    sendText: vi.fn(async (_chatId: string, text: string) => { sent.push(text); }),
    sendMarkdown: vi.fn(async () => {}),
    ...overrides,
  } as IChannelSender & { sent: string[] };
}

describe("announceSupervisorFallback", () => {
  it("records the error in the task's progress and tells the chat in one sentence", async () => {
    const ch = channel();
    const reportUpdate = vi.fn();
    await announceSupervisorFallback(ch, { chatId: "chat-1", prompt: PROMPT, reportUpdate }, new Error("planner crashed"));
    expect(reportUpdate.mock.calls).toEqual([[NOTE]]);
    expect(ch.sendText).toHaveBeenCalledWith("chat-1", SENTENCE);
    expect(ch.sent).toEqual([SENTENCE]);
  });

  it("uses the channel's system notice when it has one", async () => {
    const sendSystemMessage = vi.fn(async () => {});
    const ch = channel({ sendSystemMessage });
    await announceSupervisorFallback(ch, { chatId: "chat-1", prompt: PROMPT }, new Error("planner crashed"));
    expect(sendSystemMessage).toHaveBeenCalledWith("chat-1", SENTENCE);
    expect(ch.sent).toEqual([]);
  });

  it("says nothing and records nothing when the run was cancelled", async () => {
    const ch = channel();
    const reportUpdate = vi.fn();
    const cancelled = new AbortController();
    cancelled.abort(new Error("user cancelled"));
    await announceSupervisorFallback(
      ch,
      { chatId: "chat-1", prompt: PROMPT, reportUpdate, signal: cancelled.signal },
      new Error("aborted"),
    );
    expect(reportUpdate).not.toHaveBeenCalled();
    expect(ch.sent).toEqual([]);
  });

  it("still tells the user when the record write throws, and never rejects when the send fails", async () => {
    const ch = channel();
    const reportUpdate = vi.fn(() => { throw new Error("storage closed"); });
    await announceSupervisorFallback(ch, { chatId: "chat-1", prompt: PROMPT, reportUpdate }, new Error("planner crashed"));
    expect(ch.sent).toEqual([SENTENCE]);

    const broken = channel({ sendText: vi.fn(() => { throw new Error("channel down"); }) });
    await expect(
      announceSupervisorFallback(broken, { chatId: "chat-1", prompt: PROMPT }, new Error("planner crashed")),
    ).resolves.toBeUndefined();
  });
});
