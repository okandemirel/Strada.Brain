import { describe, expect, it } from "vitest";
import {
  INBOUND_TEXT_KEEP_LENGTH,
  MAX_INCOMING_TEXT_LENGTH,
  limitIncomingText,
} from "./channel-messages.interface.js";

describe("limitIncomingText", () => {
  it("returns short text unchanged", () => {
    expect(limitIncomingText("hello")).toBe("hello");
  });

  it("returns text exactly at the cap unchanged (no marker when nothing was dropped)", () => {
    const exact = "a".repeat(MAX_INCOMING_TEXT_LENGTH);
    expect(limitIncomingText(exact)).toBe(exact);
  });

  it("discloses truncation in-band with the exact dropped count and stays within the cap (audited 2026-09-02)", () => {
    // A 40k paste used to come back as the first 16k characters with nothing —
    // no marker, no log — saying 24k were dropped.
    const longText = "a".repeat(40_000);
    const limited = limitIncomingText(longText);

    expect(limited.length).toBeLessThanOrEqual(MAX_INCOMING_TEXT_LENGTH);
    expect(limited.startsWith("a".repeat(INBOUND_TEXT_KEEP_LENGTH))).toBe(true);
    const dropped = 40_000 - INBOUND_TEXT_KEEP_LENGTH;
    expect(limited).toContain(`[TRUNCATED: ${dropped} characters dropped by the ${MAX_INCOMING_TEXT_LENGTH}-char inbound limit`);
    // The kept body + the marker account for the whole input: nothing is lost silently.
    const body = limited.slice(0, INBOUND_TEXT_KEEP_LENGTH);
    expect(body.length + dropped).toBe(longText.length);
  });

  it("does not leave a lone high surrogate when the cap splits a surrogate pair", () => {
    // 😀 is U+1F600, encoded as a surrogate pair (2 code units).
    // Place the pair straddling the kept length so a naive slice keeps only the high surrogate.
    const head = "a".repeat(INBOUND_TEXT_KEEP_LENGTH - 1);
    const longText = `${head}😀${"b".repeat(300)}`;
    const limited = limitIncomingText(longText);

    // The lone high surrogate at the boundary is dropped, leaving valid UTF-16.
    expect(limited.startsWith(head)).toBe(true);
    const boundary = limited.charCodeAt(head.length - 1);
    expect(boundary < 0xd800 || boundary > 0xdbff).toBe(true);
    expect(limited.charAt(head.length)).toBe("\n");
    expect(limited).toContain(`[TRUNCATED: ${longText.length - head.length} characters dropped`);
  });

  it("keeps a complete surrogate pair that ends exactly at the kept length", () => {
    const head = "a".repeat(INBOUND_TEXT_KEEP_LENGTH - 2);
    const longText = `${head}😀${"b".repeat(300)}`;
    const limited = limitIncomingText(longText);

    expect(limited.startsWith(`${head}😀`)).toBe(true);
    expect(limited).toContain("[TRUNCATED: 300 characters dropped");
  });
});
