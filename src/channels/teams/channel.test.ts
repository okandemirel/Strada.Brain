import { describe, expect, it } from "vitest";
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
});
