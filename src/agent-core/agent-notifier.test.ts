import { describe, it, expect, vi } from "vitest";
import { AgentNotifier } from "./agent-notifier.js";
import { createLogger } from "../utils/logger.js";

createLogger("error", "/dev/null");

describe("AgentNotifier", () => {
  it("sends action notification", async () => {
    const channel = { sendText: vi.fn() };
    const notifier = new AgentNotifier(channel as any, "test-chat");

    await notifier.notifyAction("Fixing build error in src/foo.cs", "Build failed");
    expect(channel.sendText).toHaveBeenCalledWith("test-chat", "[Agent] Fixing build error in src/foo.cs");
  });

  it("rate limits notifications", async () => {
    const channel = { sendText: vi.fn() };
    const notifier = new AgentNotifier(channel as any, "test-chat");

    await notifier.notifyAction("First", "reason");
    await notifier.notifyAction("Second", "reason");

    expect(channel.sendText).toHaveBeenCalledTimes(1); // Second suppressed
  });

  it("handles channel errors gracefully", async () => {
    const channel = { sendText: vi.fn().mockRejectedValue(new Error("no connection")) };
    const notifier = new AgentNotifier(channel as any, "test-chat");

    // Should not throw
    await notifier.notifyAction("Test", "reason");
  });
});
