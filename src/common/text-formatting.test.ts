import { describe, expect, it } from "vitest";
import {
  fenceCodeBlock,
  formatChannelMention,
  formatUserMention,
  prefixLines,
  splitAtBoundaries,
  truncateText,
  type SplitOptions,
} from "./text-formatting.js";

/** Discord splitMessage option values (see src/channels/discord/formatters.ts). */
const DISCORD_SPLIT: SplitOptions = {
  paragraphRatio: 0.5,
  newlineRatio: 0.7,
  sentenceRatio: 0.8,
  spaceRatio: 0.8,
  trimChunks: true,
  sentenceSplitOffset: 1,
  keepEmptyInput: true,
};

/** Slack chunkText option values (see src/channels/slack/formatters.ts). */
const SLACK_SPLIT: SplitOptions = {
  paragraphRatio: 0.5,
  newlineRatio: 0.5,
  sentenceRatio: 0.5,
  trimChunks: false,
  inclusiveRatioGate: true,
};

describe("splitAtBoundaries", () => {
  it("passes through text under the limit unchanged", () => {
    expect(splitAtBoundaries("short", 100, DISCORD_SPLIT)).toEqual(["short"]);
    expect(splitAtBoundaries("  short  ", 100, SLACK_SPLIT)).toEqual(["  short  "]);
  });

  it("returns [\"\"] for empty input when keepEmptyInput is set (Discord)", () => {
    expect(splitAtBoundaries("", 100, DISCORD_SPLIT)).toEqual([""]);
  });

  it("returns [] for empty input without keepEmptyInput (Slack)", () => {
    expect(splitAtBoundaries("", 100, SLACK_SPLIT)).toEqual([]);
  });

  it("prefers a paragraph break past the gate", () => {
    const input = "a".repeat(60) + "\n\n" + "b".repeat(80);
    expect(splitAtBoundaries(input, 100, DISCORD_SPLIT)).toEqual([
      "a".repeat(60),
      "b".repeat(80),
    ]);
  });

  it("falls back to a newline when the paragraph break is before the gate", () => {
    // paragraph break at 10 (<= 50), newline at 80 (> 70)
    const input = "a".repeat(10) + "\n\n" + "c".repeat(67) + "\n" + "b".repeat(80);
    expect(splitAtBoundaries(input, 100, DISCORD_SPLIT)).toEqual([
      "a".repeat(10) + "\n\n" + "c".repeat(67),
      "b".repeat(80),
    ]);
  });

  it("falls back to a sentence end, honoring sentenceSplitOffset", () => {
    const sentence = "x".repeat(89) + ". ";
    const input = sentence + "y".repeat(60);
    // sentence end at 89 (> 80); Discord offset keeps the "." in the chunk
    expect(splitAtBoundaries(input, 100, DISCORD_SPLIT)).toEqual([
      "x".repeat(89) + ".",
      "y".repeat(60),
    ]);
    // Slack (offset 0) splits before the ". ", leaving it on the next chunk
    expect(splitAtBoundaries(input, 100, SLACK_SPLIT)).toEqual([
      "x".repeat(89),
      ". " + "y".repeat(60),
    ]);
  });

  it("hard-cuts at maxLength when no boundary qualifies", () => {
    const input = "z".repeat(250);
    expect(splitAtBoundaries(input, 100, DISCORD_SPLIT)).toEqual([
      "z".repeat(100),
      "z".repeat(100),
      "z".repeat(50),
    ]);
  });

  it("trims chunks only when trimChunks is set (remainder always trimmed)", () => {
    const input = "a".repeat(59) + " " + "\n\n" + "b".repeat(80);
    // paragraph break at index 60
    expect(splitAtBoundaries(input, 100, { ...DISCORD_SPLIT, trimChunks: true })).toEqual([
      "a".repeat(59),
      "b".repeat(80),
    ]);
    expect(splitAtBoundaries(input, 100, { ...DISCORD_SPLIT, trimChunks: false })).toEqual([
      "a".repeat(59) + " ",
      "b".repeat(80),
    ]);
  });

  it("applies a strict gate by default and an inclusive gate when configured", () => {
    // paragraph break at exactly 50 = 0.5 * 100
    const input = "a".repeat(50) + "\n\n" + "b".repeat(40) + " " + "c".repeat(40);
    // strict (> 50): boundary rejected -> falls through (space at 92 > 80)
    expect(splitAtBoundaries(input, 100, DISCORD_SPLIT)).toEqual([
      "a".repeat(50) + "\n\n" + "b".repeat(40),
      "c".repeat(40),
    ]);
    // inclusive (>= 50): paragraph boundary accepted
    expect(splitAtBoundaries(input, 100, SLACK_SPLIT)).toEqual([
      "a".repeat(50),
      "b".repeat(40) + " " + "c".repeat(40),
    ]);
  });

  it("skips the space boundary entirely when spaceRatio is omitted", () => {
    const input = "w".repeat(85) + " " + "v".repeat(60);
    // Slack has no space boundary and nothing else qualifies -> hard cut at 100
    expect(splitAtBoundaries(input, 100, SLACK_SPLIT)).toEqual([
      "w".repeat(85) + " " + "v".repeat(14),
      "v".repeat(46),
    ]);
    // Discord accepts the space at 85 (> 80)
    expect(splitAtBoundaries(input, 100, DISCORD_SPLIT)).toEqual([
      "w".repeat(85),
      "v".repeat(60),
    ]);
  });
});

describe("truncateText", () => {
  it("returns text under the limit unchanged", () => {
    expect(truncateText("short", 100, { marker: "..." })).toBe("short");
  });

  it("hard-cuts and appends the marker in plain mode", () => {
    expect(truncateText("a".repeat(150), 100, { marker: "..." })).toBe(
      "a".repeat(100) + "..."
    );
  });

  it("keeps result within maxLength when reserveMarkerSpace is set (Discord)", () => {
    const result = truncateText("a".repeat(150), 100, {
      marker: "...",
      reserveMarkerSpace: true,
    });
    expect(result).toBe("a".repeat(97) + "...");
    expect(result.length).toBeLessThanOrEqual(100);
  });

  it("prefers boundaries in order, honoring per-boundary minRatio (Slack)", () => {
    const options = {
      marker: "\n\n...(truncated)",
      boundaries: [
        { marker: "\n\n", minRatio: 0.8 },
        { marker: "\n", minRatio: 0.8 },
        { marker: " " },
      ],
    };
    // paragraph break at 90 (>= 80) wins
    const paragraphInput = "a".repeat(90) + "\n\n" + "b".repeat(50);
    expect(truncateText(paragraphInput, 100, options)).toBe(
      "a".repeat(90) + "\n\n...(truncated)"
    );
    // paragraph break at 10 (< 80) rejected; newline at 85 (>= 80) wins
    const newlineInput = "a".repeat(10) + "\n\n" + "c".repeat(73) + "\n" + "b".repeat(50);
    expect(truncateText(newlineInput, 100, options)).toBe(
      "a".repeat(10) + "\n\n" + "c".repeat(73) + "\n\n...(truncated)"
    );
    // the un-gated space boundary is accepted wherever found, even early
    const spaceInput = "a".repeat(5) + " " + "b".repeat(150);
    expect(truncateText(spaceInput, 100, options)).toBe(
      "a".repeat(5) + "\n\n...(truncated)"
    );
    // no boundary at all -> hard cut at maxLength
    expect(truncateText("b".repeat(150), 100, options)).toBe(
      "b".repeat(100) + "\n\n...(truncated)"
    );
  });

  it("supports an empty marker (Discord addEllipsis=false)", () => {
    expect(
      truncateText("a".repeat(150), 100, { marker: "", reserveMarkerSpace: true })
    ).toBe("a".repeat(100));
  });
});

describe("fenceCodeBlock", () => {
  const nested = "console.log(\"hi\");\n```\nnested fence\n```";

  it("fences with trimmed code and no surrounding newlines (Discord)", () => {
    expect(fenceCodeBlock("  padded  ", "ts", { trimCode: true })).toBe(
      "```ts\npadded\n```"
    );
    expect(fenceCodeBlock(nested, "js", { trimCode: true })).toBe(
      "```js\nconsole.log(\"hi\");\n```\nnested fence\n```\n```"
    );
  });

  it("fences untrimmed code with surrounding newlines (Slack)", () => {
    expect(fenceCodeBlock("  padded  ", undefined, { surroundingNewlines: true })).toBe(
      "\n```\n  padded  \n```\n"
    );
    expect(fenceCodeBlock(nested, "js", { surroundingNewlines: true })).toBe(
      "\n```js\nconsole.log(\"hi\");\n```\nnested fence\n```\n```\n"
    );
  });

  it("defaults to no language tag, no trim, no surrounding newlines", () => {
    expect(fenceCodeBlock(" x ")).toBe("```\n x \n```");
  });
});

describe("prefixLines", () => {
  it("prefixes every line without a transform", () => {
    expect(prefixLines("Line 1\nLine 2", "> ")).toBe("> Line 1\n> Line 2");
  });

  it("applies the transform to each line before prefixing", () => {
    const escape = (line: string): string =>
      line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    expect(prefixLines("a < b\nc & d", ">", escape)).toBe(">a &lt; b\n>c &amp; d");
  });

  it("preserves trailing empty lines exactly like the originals", () => {
    expect(prefixLines("a\n", "> ")).toBe("> a\n> ");
  });
});

describe("mentions", () => {
  it("formats user mentions as <@id>", () => {
    expect(formatUserMention("U123")).toBe("<@U123>");
  });

  it("formats channel mentions as <#id>", () => {
    expect(formatChannelMention("C9")).toBe("<#C9>");
  });
});
