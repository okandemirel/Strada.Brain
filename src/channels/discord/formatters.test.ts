import { describe, it, expect } from "vitest";
import {
  formatToDiscordMarkdown,
  truncateForDiscord,
  truncateForEmbedDescription,
  splitMessage,
  formatCodeBlock,
  formatInlineCode,
  formatSpoiler,
  formatUserMention,
  formatRoleMention,
  formatChannelMention,
  formatTimestamp,
  escapeDiscordMarkdown,
  formatFilePath,
  formatDiff,
  formatQuote,
  formatMultiLineQuote,
} from "./formatters.js";

describe("formatToDiscordMarkdown", () => {
  it("should convert headers to bold", () => {
    const input = "# Header 1\n## Header 2\n### Header 3";
    const result = formatToDiscordMarkdown(input);
    expect(result).toContain("**Header 1**");
    expect(result).toContain("**Header 2**");
    expect(result).toContain("**Header 3**");
  });

  it("should preserve code blocks", () => {
    const input = "```typescript\nconst x = 1;\n```";
    const result = formatToDiscordMarkdown(input);
    expect(result).toContain("```typescript");
    expect(result).toContain("const x = 1;");
    expect(result).toContain("```");
  });

  it("should convert spoilers", () => {
    const input = "<!-- spoiler -->hidden content<!-- /spoiler -->";
    const result = formatToDiscordMarkdown(input);
    expect(result).toBe("||hidden content||");
  });

  it("should clean up excessive newlines", () => {
    const input = "Line 1\n\n\n\nLine 2";
    const result = formatToDiscordMarkdown(input);
    expect(result).not.toContain("\n\n\n");
  });
});

describe("truncateForDiscord", () => {
  it("should not truncate short messages", () => {
    const input = "Short message";
    expect(truncateForDiscord(input, 2000)).toBe(input);
  });

  it("should truncate long messages", () => {
    const input = "a".repeat(2500);
    const result = truncateForDiscord(input, 2000);
    expect(result.length).toBeLessThanOrEqual(2000);
    expect(result.endsWith("...")).toBe(true);
  });

  it("should not add ellipsis when disabled", () => {
    const input = "a".repeat(2500);
    const result = truncateForDiscord(input, 2000, false);
    expect(result.endsWith("...")).toBe(false);
  });

  it("never exceeds maxLength even when maxLength is smaller than the ellipsis", () => {
    // Regression: with addEllipsis=true and maxLength < 3 the old code returned
    // "..." (length 3), exceeding maxLength. It must now clamp to a hard cut.
    expect(truncateForDiscord("abcdef", 2).length).toBeLessThanOrEqual(2);
    expect(truncateForDiscord("abcdef", 2)).toBe("ab");
    expect(truncateForDiscord("abcdef", 0)).toBe("");
    expect(truncateForDiscord("abcdef", 1)).toBe("a");
  });
});

describe("truncateForEmbedDescription", () => {
  it("should use 4096 as default limit", () => {
    const input = "a".repeat(5000);
    const result = truncateForEmbedDescription(input);
    expect(result.length).toBeLessThanOrEqual(4096);
  });
});

describe("splitMessage", () => {
  it("should not split short messages", () => {
    const input = "Short message";
    const result = splitMessage(input, 2000);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(input);
  });

  it("should split long messages at paragraph breaks", () => {
    const paragraph = "word ".repeat(400); // ~2000 chars
    const input = `${paragraph}\n\n${paragraph}`;
    const result = splitMessage(input, 2000);
    expect(result.length).toBeGreaterThan(1);
  });

  it("should split at sentence ends when no paragraph break", () => {
    const sentence = "This is a test. ".repeat(200);
    const input = sentence.repeat(2);
    const result = splitMessage(input, 2000);
    expect(result.length).toBeGreaterThan(1);
  });
});

describe("formatCodeBlock", () => {
  it("should format code with language", () => {
    const code = "const x = 1;";
    const result = formatCodeBlock(code, "typescript");
    expect(result).toBe("```typescript\nconst x = 1;\n```");
  });

  it("should format code without language", () => {
    const code = "const x = 1;";
    const result = formatCodeBlock(code);
    expect(result).toBe("```\nconst x = 1;\n```");
  });

  it("should trim code", () => {
    const code = "  const x = 1;  ";
    const result = formatCodeBlock(code);
    expect(result).toContain("const x = 1;");
    expect(result).not.toContain("  const x = 1;  ");
  });
});

describe("formatInlineCode", () => {
  it("should wrap in backticks", () => {
    expect(formatInlineCode("test")).toBe("`test`");
  });

  it("should use double backticks for content with backticks", () => {
    expect(formatInlineCode("test`code")).toBe("``test`code``");
  });
});

describe("formatSpoiler", () => {
  it("should wrap in spoiler tags", () => {
    expect(formatSpoiler("secret")).toBe("||secret||");
  });
});

describe("formatUserMention", () => {
  it("should format user mention", () => {
    expect(formatUserMention("123456789")).toBe("<@123456789>");
  });
});

describe("formatRoleMention", () => {
  it("should format role mention", () => {
    expect(formatRoleMention("123456789")).toBe("<@&123456789>");
  });
});

describe("formatChannelMention", () => {
  it("should format channel mention", () => {
    expect(formatChannelMention("123456789")).toBe("<#123456789>");
  });
});

describe("formatTimestamp", () => {
  it("should format timestamp with default style", () => {
    const date = new Date("2024-01-15T12:00:00Z");
    const result = formatTimestamp(date);
    const unixTime = Math.floor(date.getTime() / 1000);
    expect(result).toBe(`<t:${unixTime}:f>`);
  });

  it("should format timestamp with custom style", () => {
    const date = new Date("2024-01-15T12:00:00Z");
    const result = formatTimestamp(date, "R");
    const unixTime = Math.floor(date.getTime() / 1000);
    expect(result).toBe(`<t:${unixTime}:R>`);
  });
});

describe("escapeDiscordMarkdown", () => {
  it("should escape asterisks", () => {
    expect(escapeDiscordMarkdown("*bold*")).toBe("\\*bold\\*");
  });

  it("should escape underscores", () => {
    expect(escapeDiscordMarkdown("_italic_")).toBe("\\_italic\\_");
  });

  it("should escape backticks", () => {
    expect(escapeDiscordMarkdown("`code`")).toBe("\\`code\\`");
  });

  it("should escape tildes", () => {
    expect(escapeDiscordMarkdown("~~strike~~")).toBe("\\~\\~strike\\~\\~");
  });

  it("should escape pipes", () => {
    expect(escapeDiscordMarkdown("|spoiler|")).toBe("\\|spoiler\\|");
  });

  it("should escape backslashes", () => {
    expect(escapeDiscordMarkdown("path\\to\\file")).toBe("path\\\\to\\\\file");
  });
});

describe("formatFilePath", () => {
  it("should escape and format file path", () => {
    const result = formatFilePath("path/to/file*name.cs");
    expect(result).toContain("`");
    expect(result).toContain("\\*");
  });
});

describe("formatDiff", () => {
  it("should format diff with filename", () => {
    const diff = "+ added\n- removed";
    const result = formatDiff(diff, "file.cs");
    expect(result).toContain("--- file.cs ---");
    expect(result).toContain("```diff");
  });

  it("should format diff without filename", () => {
    const diff = "+ added";
    const result = formatDiff(diff);
    expect(result).toBe("```diff\n+ added\n```");
  });
});

describe("formatQuote", () => {
  it("should add quote prefix to each line", () => {
    const input = "Line 1\nLine 2";
    const result = formatQuote(input);
    expect(result).toBe("> Line 1\n> Line 2");
  });
});

describe("formatMultiLineQuote", () => {
  it("should use >>> prefix", () => {
    const input = "Multi\nLine\nQuote";
    const result = formatMultiLineQuote(input);
    expect(result).toBe(">>> Multi\nLine\nQuote");
  });
});

describe("characterization (plan 013)", () => {
  // Expected values were generated by running the pre-extraction formatters
  // once and pasting their exact outputs. Do NOT update these expectations to
  // make a refactor pass — a mismatch means user-visible behavior drifted.
  const sentence = "The quick brown fox jumps over the lazy dog. ";
  const paragraph = sentence.repeat(10).trim();
  const oversized = Array(11).fill(paragraph).join("\n\n"); // 4959 chars

  it("splits oversized paragraph text into 3 chunks at default 2000 limit", () => {
    const chunks = splitMessage(oversized);
    expect(chunks.map((c) => [c.length, c.slice(0, 10), c.slice(-10)])).toEqual([
      [1802, "The quick ", " lazy dog."],
      [1802, "The quick ", " lazy dog."],
      [1351, "The quick ", " lazy dog."],
    ]);
  });

  it("truncateForDiscord cuts mid-word with plain substring + ellipsis", () => {
    expect(truncateForDiscord(oversized, 100)).toBe(
      "The quick brown fox jumps over the lazy dog. The quick brown fox jumps over the lazy dog. The qui..."
    );
  });

  it("prefers a paragraph break found past 50% of maxLength", () => {
    const input = "a".repeat(1200) + "\n\n" + "b".repeat(1500);
    expect(splitMessage(input, 2000)).toEqual(["a".repeat(1200), "b".repeat(1500)]);
  });

  it("formatCodeBlock keeps inner fences verbatim and trims the code", () => {
    const nested = "console.log(\"hi\");\n```\nnested fence\n```";
    expect(formatCodeBlock(nested, "js")).toBe(
      "```js\nconsole.log(\"hi\");\n```\nnested fence\n```\n```"
    );
    expect(formatCodeBlock("  padded  ")).toBe("```\npadded\n```");
  });

  it("truncates multi-byte text by UTF-16 length (may split surrogate pairs)", () => {
    const uni = "ğüşİö🦉".repeat(43); // 301 UTF-16 code units
    expect(truncateForDiscord(uni, 100)).toBe(
      "ğüşİö🦉".repeat(13) + "ğüşİö\ud83e" + "..."
    );
  });

  it("formatQuote prefixes lines with '> ' and does not escape", () => {
    expect(formatQuote("if a < b && c & d\nsecond <line>")).toBe(
      "> if a < b && c & d\n> second <line>"
    );
  });

  it("mentions are byte-identical to the Slack formatter's output", () => {
    expect(formatUserMention("U123")).toBe("<@U123>");
    expect(formatChannelMention("C9")).toBe("<#C9>");
  });
});
