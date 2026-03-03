import { describe, it, expect } from "vitest";
import {
  formatToSlackMrkdwn,
  truncateForSlack,
  escapeSlackText,
  escapeSlackMrkdwn,
  formatFilePath,
  formatCodeBlock,
  formatErrorMessage,
  formatSuccessMessage,
  formatList,
  formatUserMention,
  formatChannelMention,
  formatLink,
  formatQuote,
  stripFormatting,
  containsCodeBlock,
  extractCodeBlocks,
  formatFileSize,
  formatDuration,
} from "../formatters.js";

describe("Slack Formatters", () => {
  describe("formatToSlackMrkdwn", () => {
    it("should convert headers to bold", () => {
      const result = formatToSlackMrkdwn("# Header");
      // Headers become *Header* in Slack (bold)
      expect(result).toContain("Header");
    });

    it("should convert bold syntax", () => {
      const result = formatToSlackMrkdwn("**bold text**");
      // ** becomes *bold text* in Slack (bold)
      expect(result).toContain("bold text");
    });

    it("should convert bullet lists", () => {
      const result = formatToSlackMrkdwn("- item 1\n- item 2");
      expect(result).toContain("• item 1");
      expect(result).toContain("• item 2");
    });

    it("should convert links", () => {
      const result = formatToSlackMrkdwn("[text](https://example.com)");
      expect(result).toBe("<https://example.com|text>");
    });

    it("should preserve code blocks", () => {
      const result = formatToSlackMrkdwn("```\ncode\n```");
      expect(result).toContain("```");
      expect(result).toContain("code");
    });
  });

  describe("truncateForSlack", () => {
    it("should not truncate short text", () => {
      const text = "Short text";
      const result = truncateForSlack(text, 100);
      expect(result).toBe(text);
    });

    it("should truncate long text", () => {
      const text = "x".repeat(50000);
      const result = truncateForSlack(text);
      expect(result.length).toBeLessThan(text.length);
      expect(result).toContain("...(truncated)");
    });
  });

  describe("escapeSlackText", () => {
    it("should escape angle brackets", () => {
      const result = escapeSlackText("<script>alert('test')</script>");
      expect(result).toContain("&lt;");
      expect(result).toContain("&gt;");
    });

    it("should escape ampersand", () => {
      const result = escapeSlackText("A & B");
      expect(result).toContain("&amp;");
    });

    it("should handle plain text", () => {
      const result = escapeSlackText("Hello world");
      expect(result).toBe("Hello world");
    });
  });

  describe("escapeSlackMrkdwn", () => {
    it("should escape special characters", () => {
      const result = escapeSlackMrkdwn("<test>");
      expect(result).toBe("&lt;test&gt;");
    });
  });

  describe("formatFilePath", () => {
    it("should format short path", () => {
      const result = formatFilePath("/path/to/file.cs");
      expect(result).toBe("`/path/to/file.cs`");
    });

    it("should truncate long path", () => {
      const longPath = "/very/long/path/".repeat(10) + "file.cs";
      const result = formatFilePath(longPath, 50);
      expect(result.length).toBeLessThanOrEqual(55);
      expect(result).toContain("...");
    });
  });

  describe("formatCodeBlock", () => {
    it("should format code without language", () => {
      const result = formatCodeBlock("const x = 1;");
      expect(result).toContain("```");
      expect(result).toContain("const x = 1;");
    });

    it("should format code with language", () => {
      const result = formatCodeBlock("const x = 1;", "javascript");
      expect(result).toContain("```javascript");
    });
  });

  describe("formatErrorMessage", () => {
    it("should format error string", () => {
      const result = formatErrorMessage("Something went wrong");
      expect(result).toContain("❌ *Error*");
      expect(result).toContain("Something went wrong");
    });

    it("should format Error object", () => {
      const error = new Error("Test error");
      const result = formatErrorMessage(error);
      expect(result).toContain("Test error");
    });

    it("should include context", () => {
      const result = formatErrorMessage("Error", "file.cs");
      expect(result).toContain("file.cs");
    });
  });

  describe("formatSuccessMessage", () => {
    it("should format success message", () => {
      const result = formatSuccessMessage("Operation completed");
      expect(result).toContain("✅ *Success*");
      expect(result).toContain("Operation completed");
    });

    it("should include details", () => {
      const result = formatSuccessMessage("Done", "File saved");
      expect(result).toContain("File saved");
    });
  });

  describe("formatList", () => {
    it("should format unordered list", () => {
      const result = formatList(["Item 1", "Item 2", "Item 3"]);
      expect(result).toContain("• Item 1");
      expect(result).toContain("• Item 2");
      expect(result).toContain("• Item 3");
    });

    it("should format ordered list", () => {
      const result = formatList(["Item 1", "Item 2"], true);
      expect(result).toContain("1. Item 1");
      expect(result).toContain("2. Item 2");
    });
  });

  describe("formatUserMention", () => {
    it("should format user mention", () => {
      const result = formatUserMention("U123456");
      expect(result).toBe("<@U123456>");
    });
  });

  describe("formatChannelMention", () => {
    it("should format channel mention", () => {
      const result = formatChannelMention("C123456");
      expect(result).toBe("<#C123456>");
    });
  });

  describe("formatLink", () => {
    it("should format link with text", () => {
      const result = formatLink("https://example.com", "Example");
      expect(result).toBe("<https://example.com|Example>");
    });

    it("should format link without text", () => {
      const result = formatLink("https://example.com");
      expect(result).toBe("<https://example.com>");
    });
  });

  describe("formatQuote", () => {
    it("should format quote", () => {
      const result = formatQuote("Line 1\nLine 2");
      expect(result).toContain(">Line 1");
      expect(result).toContain(">Line 2");
    });
  });

  describe("stripFormatting", () => {
    it("should remove bold formatting", () => {
      const result = stripFormatting("*bold* **bold2**");
      expect(result).not.toContain("*");
      expect(result).toContain("bold");
    });

    it("should remove code blocks", () => {
      const result = stripFormatting("Some `code` here");
      expect(result).not.toContain("`");
    });

    it("should remove links", () => {
      const result = stripFormatting("[text](https://example.com)");
      expect(result).toBe("text");
    });

    it("should unescape HTML entities", () => {
      const result = stripFormatting("&lt;test&gt; &amp;");
      expect(result).toContain("<test>");
      expect(result).toContain("&");
    });
  });

  describe("containsCodeBlock", () => {
    it("should detect code blocks", () => {
      expect(containsCodeBlock("```code```")).toBe(true);
      expect(containsCodeBlock("Some text")).toBe(false);
    });
  });

  describe("extractCodeBlocks", () => {
    it("should extract code blocks", () => {
      const blocks = extractCodeBlocks("```js\ncode\n```");
      expect(blocks.length).toBe(1);
      expect(blocks[0].language).toBe("js");
      expect(blocks[0].code).toBe("code");
    });

    it("should extract multiple code blocks", () => {
      const blocks = extractCodeBlocks("```a\n1\n```\n```b\n2\n```");
      expect(blocks.length).toBe(2);
    });
  });

  describe("formatFileSize", () => {
    it("should format bytes", () => {
      expect(formatFileSize(100)).toBe("100.00 B");
    });

    it("should format kilobytes", () => {
      expect(formatFileSize(1024)).toBe("1.00 KB");
    });

    it("should format megabytes", () => {
      expect(formatFileSize(1024 * 1024)).toBe("1.00 MB");
    });

    it("should format gigabytes", () => {
      expect(formatFileSize(1024 * 1024 * 1024)).toBe("1.00 GB");
    });
  });

  describe("formatDuration", () => {
    it("should format milliseconds", () => {
      expect(formatDuration(500)).toBe("500ms");
    });

    it("should format seconds", () => {
      expect(formatDuration(5000)).toBe("5.0s");
    });

    it("should format minutes", () => {
      expect(formatDuration(90000)).toBe("1m 30s");
    });
  });
});
