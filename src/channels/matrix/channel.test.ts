import { describe, expect, it } from "vitest";
import { MatrixChannel } from "./channel.js";

describe("MatrixChannel", () => {
  it("allows all inbound events when no allowlists are configured", () => {
    const channel = new MatrixChannel("https://matrix.example", "token", "@bot:example");

    expect((channel as any).isAllowedInboundMessage("@alice:example", "!room:example")).toBe(true);
  });

  it("requires both allowed user and allowed room when allowlists are configured", () => {
    const channel = new MatrixChannel(
      "https://matrix.example",
      "token",
      "@bot:example",
      ["@alice:example"],
      ["!allowed:example"],
    );

    expect((channel as any).isAllowedInboundMessage("@alice:example", "!allowed:example")).toBe(true);
    expect((channel as any).isAllowedInboundMessage("@bob:example", "!allowed:example")).toBe(false);
    expect((channel as any).isAllowedInboundMessage("@alice:example", "!other:example")).toBe(false);
  });
});
