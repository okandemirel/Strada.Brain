import { describe, expect, it, vi, afterEach } from "vitest";
import { IRCChannel } from "./channel.js";

vi.mock("../../utils/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe("IRCChannel", () => {
  it("denies inbound users by default when no allowlist is configured", () => {
    const channel = new IRCChannel("irc.example.org", "strada", ["#general"]);

    expect((channel as any).isAllowedInboundUser("alice")).toBe(false);
  });

  it("supports explicit open access when configured", () => {
    const channel = new IRCChannel("irc.example.org", "strada", ["#general"], [], true);

    expect((channel as any).isAllowedInboundUser("alice")).toBe(true);
  });

  it("restricts inbound users to the configured allowlist", () => {
    const channel = new IRCChannel("irc.example.org", "strada", ["#general"], ["alice", "bob"]);

    expect((channel as any).isAllowedInboundUser("alice")).toBe(true);
    expect((channel as any).isAllowedInboundUser("mallory")).toBe(false);
  });

  describe("health state", () => {
    afterEach(() => {
      vi.doUnmock("irc");
      vi.resetModules();
    });

    it("marks unhealthy on error/netError/abort and recovers on re-registration", async () => {
      const listeners = new Map<string, (...args: unknown[]) => void>();
      const fakeClient = {
        addListener: (event: string, handler: (...args: unknown[]) => void) => {
          listeners.set(event, handler);
        },
        say: vi.fn(),
        disconnect: (_msg: string, cb: () => void) => cb(),
      };
      // Plain function (not arrow) so `new irc.Client(...)` returns fakeClient.
      function MockClient(): unknown {
        return fakeClient;
      }
      vi.doMock("irc", () => ({ Client: MockClient }));

      const channel = new IRCChannel("irc.example.org", "strada", ["#general"]);
      await channel.connect();

      // Not registered yet → unhealthy.
      expect(channel.isHealthy()).toBe(false);

      listeners.get("registered")?.();
      expect(channel.isHealthy()).toBe(true);

      // A server/protocol error drops the link.
      listeners.get("error")?.(new Error("boom"));
      expect(channel.isHealthy()).toBe(false);

      // Reconnect re-emits "registered" → self-heals.
      listeners.get("registered")?.();
      expect(channel.isHealthy()).toBe(true);

      // Socket error also drops it.
      listeners.get("netError")?.(new Error("socket reset"));
      expect(channel.isHealthy()).toBe(false);

      listeners.get("registered")?.();
      expect(channel.isHealthy()).toBe(true);

      // Exhausted reconnect retries.
      listeners.get("abort")?.();
      expect(channel.isHealthy()).toBe(false);
    });
  });
});
