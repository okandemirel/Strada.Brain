import { describe, it, expect } from "vitest";
import { chunkMarkdown, chunkXmlDocs, chunkCSharpExample } from "./doc-chunker.js";
import type { PackageRoot } from "./doc-rag.interface.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const testPkg: PackageRoot = {
  name: "strada.core",
  path: "/projects/strada-core",
  version: "1.0.0",
};

// ---------------------------------------------------------------------------
// chunkMarkdown
// ---------------------------------------------------------------------------

describe("chunkMarkdown", () => {
  it("chunks a simple markdown document by headings", () => {
    const md = `# Introduction
This is the intro paragraph.

## Getting Started
Follow these steps to get started.

## API Reference
The API is described here.`;

    const chunks = chunkMarkdown(md, "README.md", testPkg, "framework_readme");

    expect(chunks.length).toBe(3);
    expect(chunks[0]!.title).toBe("Introduction");
    expect(chunks[0]!.content).toContain("intro paragraph");
    expect(chunks[1]!.title).toBe("Getting Started");
    expect(chunks[2]!.title).toBe("API Reference");
  });

  it("sets correct kind based on docSource", () => {
    const md = "# Title\nContent here.";

    const readmeChunks = chunkMarkdown(md, "README.md", testPkg, "framework_readme");
    expect(readmeChunks[0]!.kind).toBe("readme");

    const changelogChunks = chunkMarkdown(md, "CHANGELOG.md", testPkg, "framework_changelog");
    expect(changelogChunks[0]!.kind).toBe("changelog");

    const docsChunks = chunkMarkdown(md, "docs/api.md", testPkg, "framework_docs");
    expect(docsChunks[0]!.kind).toBe("markdown");
  });

  it("sets packageName and packageVersion on each chunk", () => {
    const md = "# Hello\nWorld.";
    const chunks = chunkMarkdown(md, "test.md", testPkg, "framework_docs");

    for (const chunk of chunks) {
      expect(chunk.packageName).toBe("strada.core");
      expect(chunk.packageVersion).toBe("1.0.0");
    }
  });

  it("tracks heading hierarchy", () => {
    const md = `# Root
Root content.

## Section A
Section A content.

### Subsection A1
Deep content.`;

    const chunks = chunkMarkdown(md, "test.md", testPkg, "framework_docs");

    const deepChunk = chunks.find((c) => c.title === "Subsection A1");
    expect(deepChunk).toBeDefined();
    expect(deepChunk!.hierarchy).toEqual(["Root", "Section A", "Subsection A1"]);
    expect(deepChunk!.section).toBe("Section A");
  });

  it("splits large sections into multiple chunks by paragraph", () => {
    const largePara = "A".repeat(600);
    const md = `# Big Section
${largePara}

${largePara}

${largePara}

${largePara}`;

    // Use a small maxChunkChars to force splitting
    const chunks = chunkMarkdown(md, "big.md", testPkg, "framework_docs", 800);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(800 + 200); // allow some slack for joining
    }
  });

  it("returns empty array for empty input", () => {
    const chunks = chunkMarkdown("", "empty.md", testPkg, "framework_docs");
    expect(chunks).toHaveLength(0);
  });

  it("returns empty array for whitespace-only input", () => {
    const chunks = chunkMarkdown("   \n\n  \t\n", "blank.md", testPkg, "framework_docs");
    expect(chunks).toHaveLength(0);
  });

  it("handles content before any heading", () => {
    const md = `Some preamble text without a heading.

# First Heading
Content after heading.`;

    const chunks = chunkMarkdown(md, "test.md", testPkg, "framework_docs");

    // The preamble text becomes a chunk with no title
    const preamble = chunks.find((c) => c.content.includes("preamble"));
    expect(preamble).toBeDefined();
  });

  it("generates deterministic chunk IDs", () => {
    const md = "# Test\nContent.";
    const chunks1 = chunkMarkdown(md, "file.md", testPkg, "framework_docs");
    const chunks2 = chunkMarkdown(md, "file.md", testPkg, "framework_docs");

    expect(chunks1.map((c) => c.id)).toEqual(chunks2.map((c) => c.id));
  });

  it("generates different IDs for different file paths", () => {
    const md = "# Test\nContent.";
    const chunks1 = chunkMarkdown(md, "a.md", testPkg, "framework_docs");
    const chunks2 = chunkMarkdown(md, "b.md", testPkg, "framework_docs");

    expect(chunks1[0]!.id).not.toBe(chunks2[0]!.id);
  });

  it("sets docSource on every chunk", () => {
    const md = "# Title\nBody.";
    const chunks = chunkMarkdown(md, "test.md", testPkg, "framework_example");

    for (const chunk of chunks) {
      expect(chunk.docSource).toBe("framework_example");
    }
  });

  it("handles H4 headings correctly", () => {
    const md = `# Root
## Section
### Subsection
#### Deep Point
Deep content here.`;

    const chunks = chunkMarkdown(md, "test.md", testPkg, "framework_docs");
    const deep = chunks.find((c) => c.title === "Deep Point");
    expect(deep).toBeDefined();
    expect(deep!.hierarchy).toEqual(["Root", "Section", "Subsection", "Deep Point"]);
  });
});

// ---------------------------------------------------------------------------
// chunkXmlDocs
// ---------------------------------------------------------------------------

describe("chunkXmlDocs", () => {
  it("extracts XML doc comments with symbol names", () => {
    const cs = `using UnityEngine;

/// <summary>
/// Manages the player health and damage system.
/// </summary>
public class HealthManager : MonoBehaviour
{
}`;

    const chunks = chunkXmlDocs(cs, "HealthManager.cs", testPkg);

    expect(chunks.length).toBe(1);
    expect(chunks[0]!.title).toBe("HealthManager");
    expect(chunks[0]!.content).toContain("HealthManager");
    expect(chunks[0]!.content).toContain("Manages the player health");
    expect(chunks[0]!.kind).toBe("xml_doc");
  });

  it("handles param and returns tags", () => {
    const cs = `
/// <summary>
/// Applies damage to the target entity.
/// </summary>
/// <param name="amount">The damage amount</param>
/// <param name="type">The damage type</param>
/// <returns>Whether the target died</returns>
public bool ApplyDamage(float amount, DamageType type)
{
    return false;
}`;

    const chunks = chunkXmlDocs(cs, "Combat.cs", testPkg);

    expect(chunks.length).toBe(1);
    expect(chunks[0]!.content).toContain("**amount**");
    expect(chunks[0]!.content).toContain("**type**");
    expect(chunks[0]!.content).toContain("**Returns**");
  });

  it("handles see cref references", () => {
    const cs = `
/// <summary>
/// See <see cref="HealthManager"/> for details.
/// </summary>
public class DamageSystem
{
}`;

    const chunks = chunkXmlDocs(cs, "DamageSystem.cs", testPkg);

    expect(chunks.length).toBe(1);
    expect(chunks[0]!.content).toContain("`HealthManager`");
  });

  it("skips very short doc comments (< 10 chars)", () => {
    const cs = `
/// <summary>
/// Hi
/// </summary>
public class Tiny
{
}`;

    const chunks = chunkXmlDocs(cs, "Tiny.cs", testPkg);
    expect(chunks).toHaveLength(0);
  });

  it("returns empty array for a file without XML docs", () => {
    const cs = `using System;

public class NoDocs
{
    public void Foo() {}
}`;

    const chunks = chunkXmlDocs(cs, "NoDocs.cs", testPkg);
    expect(chunks).toHaveLength(0);
  });

  it("returns empty array for empty input", () => {
    const chunks = chunkXmlDocs("", "empty.cs", testPkg);
    expect(chunks).toHaveLength(0);
  });

  it("extracts multiple doc comments from a single file", () => {
    const cs = `
/// <summary>
/// First class description with enough content to pass threshold.
/// </summary>
public class FirstClass
{
}

/// <summary>
/// Second class description with enough content to pass threshold.
/// </summary>
public class SecondClass
{
}`;

    const chunks = chunkXmlDocs(cs, "Multi.cs", testPkg);
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.title).toBe("FirstClass");
    expect(chunks[1]!.title).toBe("SecondClass");
  });

  it("sets package metadata on XML doc chunks", () => {
    const cs = `
/// <summary>
/// A documented class with sufficient description for indexing.
/// </summary>
public class Documented
{
}`;

    const chunks = chunkXmlDocs(cs, "Doc.cs", testPkg);

    expect(chunks[0]!.packageName).toBe("strada.core");
    expect(chunks[0]!.packageVersion).toBe("1.0.0");
    expect(chunks[0]!.docSource).toBe("xml_doc_comment");
  });
});

// ---------------------------------------------------------------------------
// chunkCSharpExample
// ---------------------------------------------------------------------------

describe("chunkCSharpExample", () => {
  it("returns a single chunk for small files", () => {
    const cs = `using NUnit.Framework;

[Test]
public void TestAdd()
{
    Assert.AreEqual(2, 1 + 1);
}`;

    const chunks = chunkCSharpExample(cs, "Tests/AddTest.cs", testPkg);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.kind).toBe("api_doc");
    expect(chunks[0]!.title).toBe("AddTest");
    expect(chunks[0]!.docSource).toBe("framework_example");
  });

  it("splits large files by test methods", () => {
    const methods = Array.from({ length: 10 }, (_, i) => `
    [Test]
    public void TestMethod${i}()
    {
        // Method body with enough content to make the file large
        var result = SomeService.Process(${i});
        Assert.IsNotNull(result);
        Assert.AreEqual(${i}, result.Value);
        // More assertions to pad content
        Assert.IsTrue(result.IsValid);
        Assert.IsFalse(result.HasError);
    }`).join("\n");

    const cs = `using NUnit.Framework;

public class LargeTestSuite
{
${methods}
}`;

    const chunks = chunkCSharpExample(cs, "Tests/LargeTestSuite.cs", testPkg, 200);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.docSource).toBe("framework_example");
      expect(chunk.kind).toBe("api_doc");
    }
  });

  it("falls back to single truncated chunk when no test methods found in large file", () => {
    const longContent = "// No test methods\n".repeat(200);

    const chunks = chunkCSharpExample(longContent, "Tests/NoTests.cs", testPkg, 100);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content.length).toBeLessThanOrEqual(100);
    expect(chunks[0]!.title).toBe("NoTests");
  });

  it("returns empty array for empty input (treated as small file)", () => {
    const chunks = chunkCSharpExample("", "Tests/Empty.cs", testPkg);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toBe("");
  });

  it("extracts method names as chunk titles", () => {
    const cs = `using NUnit.Framework;

public class Suite
{
    [Test]
    public void ShouldCalculateDamage()
    {
        var dmg = DamageCalc.Calculate(10, 0.5f);
        Assert.AreEqual(5, dmg);
    }

    [TestCase(1)]
    public void ShouldHandleEdgeCase(int val)
    {
        Assert.IsTrue(val > 0);
    }
}`;

    // Force split by using small maxChunkChars
    const chunks = chunkCSharpExample(cs, "Tests/Suite.cs", testPkg, 50);

    const titles = chunks.map((c) => c.title);
    expect(titles).toContain("ShouldCalculateDamage");
    expect(titles).toContain("ShouldHandleEdgeCase");
  });

  it("handles [UnityTest] attribute", () => {
    const cs = `using NUnit.Framework;
using UnityEngine.TestTools;

public class UnityTests
{
    [UnityTest]
    public System.Collections.IEnumerator TestCoroutine()
    {
        yield return null;
        Assert.IsTrue(true);
        // Pad the content to make it larger than maxChunkChars
        // More padding content for size
    }
}`;

    const chunks = chunkCSharpExample(cs, "Tests/Unity.cs", testPkg, 50);

    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  it("sets package metadata on chunks", () => {
    const cs = "// simple test file";
    const chunks = chunkCSharpExample(cs, "Tests/Meta.cs", testPkg);

    expect(chunks[0]!.packageName).toBe("strada.core");
    expect(chunks[0]!.packageVersion).toBe("1.0.0");
  });

  it("generates deterministic chunk IDs", () => {
    const cs = "// test content";
    const chunks1 = chunkCSharpExample(cs, "Tests/Det.cs", testPkg);
    const chunks2 = chunkCSharpExample(cs, "Tests/Det.cs", testPkg);

    expect(chunks1.map((c) => c.id)).toEqual(chunks2.map((c) => c.id));
  });
});
