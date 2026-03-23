import { describe, it, expect } from "vitest";
import { parseFrontmatter } from "./frontmatter-parser.js";

// ---------------------------------------------------------------------------
// Basic key: value pairs
// ---------------------------------------------------------------------------

describe("parseFrontmatter", () => {
  it("parses basic key: value pairs", () => {
    const raw = `---
name: gmail
version: 1.0.0
description: Gmail integration
---
`;
    const { data, content } = parseFrontmatter(raw);
    expect(data.name).toBe("gmail");
    expect(data.version).toBe("1.0.0");
    expect(data.description).toBe("Gmail integration");
    expect(content).toBe("");
  });

  // -------------------------------------------------------------------------
  // JSON arrays
  // -------------------------------------------------------------------------

  it("parses JSON-style arrays", () => {
    const raw = `---
capabilities: ["email.read", "email.send"]
---
`;
    const { data } = parseFrontmatter(raw);
    expect(data.capabilities).toEqual(["email.read", "email.send"]);
  });

  it("parses empty arrays", () => {
    const raw = `---
tags: []
---
`;
    const { data } = parseFrontmatter(raw);
    expect(data.tags).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Nested objects
  // -------------------------------------------------------------------------

  it("parses nested objects via 2-space indentation", () => {
    const raw = `---
requires:
  bins: ["node"]
  env: ["API_KEY", "API_SECRET"]
  config: ["llm.provider"]
---
`;
    const { data } = parseFrontmatter(raw);
    const requires = data.requires as Record<string, unknown>;
    expect(requires.bins).toEqual(["node"]);
    expect(requires.env).toEqual(["API_KEY", "API_SECRET"]);
    expect(requires.config).toEqual(["llm.provider"]);
  });

  it("parses multiple nested objects", () => {
    const raw = `---
requires:
  bins: ["node"]
settings:
  timeout: 30
---
`;
    const { data } = parseFrontmatter(raw);
    const requires = data.requires as Record<string, unknown>;
    const settings = data.settings as Record<string, unknown>;
    expect(requires.bins).toEqual(["node"]);
    expect(settings.timeout).toBe(30);
  });

  // -------------------------------------------------------------------------
  // Quoted strings with colons
  // -------------------------------------------------------------------------

  it("handles double-quoted strings containing colons", () => {
    const raw = `---
description: "foo: bar"
---
`;
    const { data } = parseFrontmatter(raw);
    expect(data.description).toBe("foo: bar");
  });

  it("handles double-quoted strings with complex content", () => {
    const raw = `---
description: "Supports: read, write, and delete operations"
---
`;
    const { data } = parseFrontmatter(raw);
    expect(data.description).toBe("Supports: read, write, and delete operations");
  });

  // -------------------------------------------------------------------------
  // No frontmatter markers
  // -------------------------------------------------------------------------

  it("returns empty data when no frontmatter markers exist", () => {
    const raw = `# Hello World
This is just content.`;
    const { data, content } = parseFrontmatter(raw);
    expect(data).toEqual({});
    expect(content).toBe(raw);
  });

  it("returns empty data when first line is not ---", () => {
    const raw = `name: test
---
something
---`;
    const { data, content } = parseFrontmatter(raw);
    expect(data).toEqual({});
    expect(content).toBe(raw);
  });

  // -------------------------------------------------------------------------
  // Empty frontmatter
  // -------------------------------------------------------------------------

  it("returns empty data for empty frontmatter block", () => {
    const raw = `---
---
Content here.`;
    const { data, content } = parseFrontmatter(raw);
    expect(data).toEqual({});
    expect(content).toBe("Content here.");
  });

  // -------------------------------------------------------------------------
  // Content after frontmatter preserved
  // -------------------------------------------------------------------------

  it("preserves content after frontmatter", () => {
    const raw = `---
name: test
---
# Title

Paragraph one.

Paragraph two.`;
    const { data, content } = parseFrontmatter(raw);
    expect(data.name).toBe("test");
    expect(content).toBe("# Title\n\nParagraph one.\n\nParagraph two.");
  });

  it("preserves multiline content with blank lines", () => {
    const raw = `---
name: test
---

First line after blank.

Another section.`;
    const { data, content } = parseFrontmatter(raw);
    expect(data.name).toBe("test");
    expect(content).toBe("\nFirst line after blank.\n\nAnother section.");
  });

  // -------------------------------------------------------------------------
  // Boolean and number values
  // -------------------------------------------------------------------------

  it("parses boolean values", () => {
    const raw = `---
enabled: true
disabled: false
---
`;
    const { data } = parseFrontmatter(raw);
    expect(data.enabled).toBe(true);
    expect(data.disabled).toBe(false);
  });

  it("parses numeric values", () => {
    const raw = `---
timeout: 30
rate: 1.5
---
`;
    const { data } = parseFrontmatter(raw);
    expect(data.timeout).toBe(30);
    expect(data.rate).toBe(1.5);
  });

  // -------------------------------------------------------------------------
  // Full SKILL.md example from spec
  // -------------------------------------------------------------------------

  it("parses full SKILL.md example from spec", () => {
    const raw = `---
name: gmail
version: 1.0.0
description: Gmail integration
author: okandemirel
requires:
  bins: ["node"]
  env: ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET"]
capabilities: ["email.read", "email.send"]
---
# Gmail Skill
Documentation here...`;

    const { data, content } = parseFrontmatter(raw);

    expect(data.name).toBe("gmail");
    expect(data.version).toBe("1.0.0");
    expect(data.description).toBe("Gmail integration");
    expect(data.author).toBe("okandemirel");

    const requires = data.requires as Record<string, unknown>;
    expect(requires.bins).toEqual(["node"]);
    expect(requires.env).toEqual(["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET"]);

    expect(data.capabilities).toEqual(["email.read", "email.send"]);

    expect(content).toBe("# Gmail Skill\nDocumentation here...");
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it("handles missing closing fence", () => {
    const raw = `---
name: broken
no closing fence here`;
    const { data, content } = parseFrontmatter(raw);
    expect(data).toEqual({});
    expect(content).toBe(raw);
  });

  it("handles empty string input", () => {
    const { data, content } = parseFrontmatter("");
    expect(data).toEqual({});
    expect(content).toBe("");
  });

  it("handles nested object followed by top-level key", () => {
    const raw = `---
requires:
  bins: ["git", "node"]
  skills: ["core"]
homepage: https://example.com
---
`;
    const { data } = parseFrontmatter(raw);
    const requires = data.requires as Record<string, unknown>;
    expect(requires.bins).toEqual(["git", "node"]);
    expect(requires.skills).toEqual(["core"]);
    expect(data.homepage).toBe("https://example.com");
  });

  it("skips blank lines inside frontmatter", () => {
    const raw = `---
name: test

version: 2.0.0
---
`;
    const { data } = parseFrontmatter(raw);
    expect(data.name).toBe("test");
    expect(data.version).toBe("2.0.0");
  });
});
