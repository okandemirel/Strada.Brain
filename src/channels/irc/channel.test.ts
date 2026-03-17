import { describe, expect, it } from "vitest";
import { IRCChannel } from "./channel.js";

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
});
