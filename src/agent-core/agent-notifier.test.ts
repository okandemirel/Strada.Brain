import { describe, it, expect, vi } from "vitest";
import { AgentNotifier } from "./agent-notifier.js";
import { createLogger } from "../utils/logger.js";

createLogger("error", "/dev/null");

describe("AgentNotifier", () => {
  it("sends high-urgency action notifications", async () => {
    const channel = { sendText: vi.fn() };
    const notifier = new AgentNotifier(channel as any, "test-chat");

    await notifier.notifyAction("Fixing build error in src/foo.cs", "Build failed", { urgency: "high" });
    expect(channel.sendText).toHaveBeenCalledWith("test-chat", "[Agent] Fixing build error in src/foo.cs");
  });

  it("suppresses low and medium notifications in silent-first mode", async () => {
    const channel = { sendText: vi.fn() };
    const notifier = new AgentNotifier(channel as any, "test-chat");

    await notifier.notifyObservation("Background check completed");
    await notifier.notifyAction("Applied a low-priority cleanup", "reason", { urgency: "low" });

    expect(channel.sendText).not.toHaveBeenCalled();
  });

  it("rate limits notifications", async () => {
    const channel = { sendText: vi.fn() };
    const notifier = new AgentNotifier(channel as any, "test-chat");

    await notifier.notifyAction("First", "reason", { urgency: "high" });
    await notifier.notifyAction("Second", "reason", { urgency: "high" });

    expect(channel.sendText).toHaveBeenCalledTimes(1); // Second suppressed
  });

  it("bypasses silence and rate limits for hard blockers", async () => {
    const channel = { sendText: vi.fn() };
    const notifier = new AgentNotifier(channel as any, "test-chat");

    await notifier.notifyAction("High signal", "reason", { urgency: "high" });
    await notifier.notifyObservation("Credential expired", { hardBlocker: true, urgency: "medium" });

    expect(channel.sendText).toHaveBeenCalledTimes(2);
    expect(channel.sendText).toHaveBeenLastCalledWith("test-chat", "[Agent] Credential expired");
  });

  it("handles channel errors gracefully", async () => {
    const channel = { sendText: vi.fn().mockRejectedValue(new Error("no connection")) };
    const notifier = new AgentNotifier(channel as any, "test-chat");

    // Should not throw
    await notifier.notifyAction("Test", "reason", { urgency: "high" });
  });
});
