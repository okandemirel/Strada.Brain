import { describe, expect, it } from "vitest";
import { MAX_INCOMING_TEXT_LENGTH, limitIncomingText } from "./channel-messages.interface.js";

describe("limitIncomingText", () => {
  it("returns short text unchanged", () => {
    expect(limitIncomingText("hello")).toBe("hello");
  });

  it("truncates text above the global inbound cap", () => {
    const longText = "a".repeat(MAX_INCOMING_TEXT_LENGTH + 25);
    const limited = limitIncomingText(longText);

    expect(limited).toHaveLength(MAX_INCOMING_TEXT_LENGTH);
    expect(limited).toBe(longText.slice(0, MAX_INCOMING_TEXT_LENGTH));
  });
});
