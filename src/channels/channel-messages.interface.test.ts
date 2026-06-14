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

  it("does not leave a lone high surrogate when the cap splits a surrogate pair", () => {
    // 😀 is U+1F600, encoded as the surrogate pair 😀 (2 code units).
    // Place the pair straddling the cap so a naive slice keeps only the high surrogate.
    const head = "a".repeat(MAX_INCOMING_TEXT_LENGTH - 1);
    const longText = `${head}😀${"b".repeat(50)}`;
    const limited = limitIncomingText(longText);

    // The lone high surrogate at the boundary is dropped, leaving valid UTF-16.
    expect(limited).toHaveLength(MAX_INCOMING_TEXT_LENGTH - 1);
    expect(limited).toBe(head);
    const lastCharCode = limited.charCodeAt(limited.length - 1);
    expect(lastCharCode < 0xd800 || lastCharCode > 0xdbff).toBe(true);
  });

  it("keeps a complete surrogate pair that ends exactly at the cap", () => {
    // Pair fully inside the cap (occupies the last two code units): keep it intact.
    const head = "a".repeat(MAX_INCOMING_TEXT_LENGTH - 2);
    const longText = `${head}😀${"b".repeat(50)}`;
    const limited = limitIncomingText(longText);

    expect(limited).toHaveLength(MAX_INCOMING_TEXT_LENGTH);
    expect(limited).toBe(`${head}😀`);
  });
});
