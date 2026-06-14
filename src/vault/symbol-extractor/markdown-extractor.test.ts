import { describe, it, expect } from "vitest";
import { MarkdownSymbolExtractor } from "./markdown-extractor.js";

const extractor = new MarkdownSymbolExtractor();

async function frontmatterOf(content: string) {
  const out = await extractor.extract({ path: "Notes/x.md", content, lang: "markdown" });
  return out.frontmatter;
}

describe("MarkdownSymbolExtractor frontmatter line endings", () => {
  it("parses frontmatter with LF line endings", async () => {
    expect(await frontmatterOf("---\ntitle: Hello\ntag: a\n---\n\n# Body")).toEqual({
      title: "Hello",
      tag: "a",
    });
  });

  it("parses frontmatter with CRLF (Windows) line endings", async () => {
    // Regression: FRONTMATTER_RE hard-coded \n, so the opening `---\r\n`
    // never matched on Windows-authored notes and frontmatter was dropped.
    expect(await frontmatterOf("---\r\ntitle: Hello\r\ntag: a\r\n---\r\n\r\n# Body")).toEqual({
      title: "Hello",
      tag: "a",
    });
  });
});
