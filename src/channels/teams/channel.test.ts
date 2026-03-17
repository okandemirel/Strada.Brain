import { describe, expect, it, vi } from "vitest";
import { TeamsChannel } from "./channel.js";

describe("TeamsChannel", () => {
  it("allows all inbound users when no allowlist is configured", () => {
    const channel = new TeamsChannel("app-id", "app-password");

    expect((channel as any).isAllowedInboundUser("user-1")).toBe(true);
  });

  it("restricts inbound users to the configured allowlist", () => {
    const channel = new TeamsChannel("app-id", "app-password", 3978, ["user-1", "user-2"]);

    expect((channel as any).isAllowedInboundUser("user-1")).toBe(true);
    expect((channel as any).isAllowedInboundUser("user-3")).toBe(false);
  });

  it("uses the active Teams turn context to send replies during a conversation", async () => {
    const channel = new TeamsChannel("app-id", "app-password");
    const sendActivity = vi.fn().mockResolvedValue(undefined);

    (channel as unknown as {
      activeTurnContexts: Map<string, { sendActivity: (text: string) => Promise<void> }>;
    }).activeTurnContexts.set("chat-1", {
      sendActivity,
    });

    await channel.sendText("chat-1", "hello from teams");

    expect(sendActivity).toHaveBeenCalledWith("hello from teams");
  });

  it("fails explicitly when no active Teams turn context is available", async () => {
    const channel = new TeamsChannel("app-id", "app-password");

    await expect(channel.sendText("missing-chat", "hello")).rejects.toThrow(
      "No active Teams turn context for conversation: missing-chat",
    );
  });
});
