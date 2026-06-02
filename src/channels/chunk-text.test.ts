import { describe, it, expect } from "vitest";
import { chunkText } from "./chunk-text.js";

describe("chunkText", () => {
  it("returns no chunks for empty input", () => {
    expect(chunkText("", 100)).toEqual([]);
  });

  it("returns the text unchanged when within the limit", () => {
    expect(chunkText("hello", 100)).toEqual(["hello"]);
    expect(chunkText("x".repeat(100), 100)).toEqual(["x".repeat(100)]);
  });

  it("throws on a non-positive max", () => {
    expect(() => chunkText("hi", 0)).toThrow(RangeError);
    expect(() => chunkText("hi", -5)).toThrow(RangeError);
  });

  it("never produces a chunk longer than max", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i} ${"word ".repeat(20)}`).join("\n");
    const chunks = chunkText(text, 80);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(80);
      expect(c.length).toBeGreaterThan(0);
    }
  });

  it("preserves line content (chunks rejoin to the original) when no hard-split is needed", () => {
    const text = Array.from({ length: 30 }, (_, i) => `short line ${i}`).join("\n");
    const chunks = chunkText(text, 40);
    expect(chunks.join("\n")).toBe(text);
  });

  it("hard-splits a single oversized token with no spaces", () => {
    const text = "a".repeat(250);
    const chunks = chunkText(text, 100);
    expect(chunks).toEqual(["a".repeat(100), "a".repeat(100), "a".repeat(50)]);
    expect(chunks.join("")).toBe(text);
  });

  it("breaks an oversized line on a word boundary when possible", () => {
    const text = `${"alpha ".repeat(30)}`.trim(); // one long line of words
    const chunks = chunkText(text, 50);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(50);
      // word-boundary breaks should not start or end mid-"alpha" with a partial token
      expect(c.startsWith(" ")).toBe(false);
    }
    // every "alpha" token is preserved
    expect(chunks.join(" ").split(/\s+/).filter((w) => w === "alpha").length).toBe(30);
  });
});
