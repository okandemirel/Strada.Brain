import { describe, it, expect, vi } from "vitest";
import { chunkMarkdown, chunkXmlDocs, chunkCSharpExample } from "./doc-chunker.js";
import { rerankWithFrameworkPriority, DEFAULT_FRAMEWORK_RERANKER_CONFIG } from "./framework-reranker.js";
import { discoverPackageRoots, hasVersionChanged } from "./version-tagger.js";
import { isFrameworkDocChunk, DOC_SOURCE_PRIORITY } from "./doc-rag.interface.js";
import type { FrameworkDocChunk, PackageRoot, DocSourceType } from "./doc-rag.interface.js";
import type { VectorSearchHit, DocumentationChunk } from "../rag.interface.js";
import type { StradaDepsStatus } from "../../config/strada-deps.js";
import type { NormalizedScore, FilePath, TimestampMs } from "../../types/index.js";

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

function makePkg(overrides: Partial<PackageRoot> = {}): PackageRoot {
  return {
    name: "strada.core",
    path: "/mock/strada-core",
    version: "1.2.3",
    ...overrides,
  };
}

function makeDocChunk(overrides: Partial<FrameworkDocChunk> = {}): FrameworkDocChunk {
  return {
    id: "doc-chunk-1",
    content: "Framework documentation content",
    contentHash: "abc123",
    filePath: "docs/README.md" as FilePath,
    indexedAt: Date.now() as TimestampMs,
    kind: "readme",
    title: "Getting Started",
    packageName: "strada.core",
    packageVersion: "1.0.0",
    docSource: "framework_readme",
    ...overrides,
  };
}

function makeVectorHit(
  score: number,
  chunkOverrides: Partial<FrameworkDocChunk | DocumentationChunk> = {},
): VectorSearchHit {
  const chunk = makeDocChunk(chunkOverrides as Partial<FrameworkDocChunk>);
  return { id: chunk.id, chunk, score: score as NormalizedScore };
}

function makeCodeHit(
  score: number,
  overrides: Partial<{ id: string; content: string; kind: string }> = {},
): VectorSearchHit {
  return {
    id: overrides.id ?? "code-hit",
    chunk: {
      id: overrides.id ?? "code-hit",
      content: overrides.content ?? "public class Foo {}",
      contentHash: "xyz789",
      filePath: "Assets/Foo.cs" as FilePath,
      indexedAt: Date.now() as TimestampMs,
      kind: (overrides.kind as "class") ?? "class",
      startLine: 1,
      endLine: 10,
      language: "csharp",
    },
    score: score as NormalizedScore,
  };
}

// ---------------------------------------------------------------------------
// Sample content strings
// ---------------------------------------------------------------------------

const sampleMarkdown = `# Installation

Install via npm:

\`\`\`bash
npm install strada.core
\`\`\`

## Configuration

Set up your config file:

\`\`\`json
{
  "framework": "strada",
  "version": "1.0"
}
\`\`\`

### Advanced Options

Enable debug mode for verbose output.

## API Reference

Use the main entry point.`;

const markdownWithCodeFence = `# Usage

Here is a complete example:

\`\`\`csharp
public class GameManager : MonoBehaviour
{
    private void Start()
    {
        var system = new DamageSystem();
        system.Initialize();
    }
}
\`\`\`

That concludes the usage section.`;

const sampleXmlDocsCSharp = `using UnityEngine;

namespace Strada.Core.ECS
{
    /// <summary>
    /// Manages entity lifecycle including creation, destruction, and pooling.
    /// </summary>
    /// <param name="capacity">Initial pool capacity for entity recycling.</param>
    /// <returns>A configured EntityManager instance.</returns>
    public class EntityManager
    {
        private int _capacity;

        /// <summary>
        /// Creates a new entity with the specified archetype.
        /// </summary>
        /// <param name="archetype">The component archetype to apply.</param>
        /// <returns>The newly created entity ID.</returns>
        public int CreateEntity(Archetype archetype)
        {
            return 0;
        }
    }
}`;

const csharpNoXmlDocs = `using UnityEngine;

namespace Game.Utils
{
    public static class MathHelper
    {
        public static float Lerp(float a, float b, float t)
        {
            return a + (b - a) * t;
        }
    }
}`;

const smallCSharpExample = `using NUnit.Framework;

[TestFixture]
public class SmallTest
{
    [Test]
    public void ItWorks()
    {
        Assert.IsTrue(true);
    }
}`;

const largeCSharpExample = `using NUnit.Framework;
using Strada.Core;

namespace Strada.Tests
{
    [TestFixture]
    public class EntityTests
    {
        private EntityManager _manager;

        [SetUp]
        public void SetUp()
        {
            _manager = new EntityManager();
        }

        [Test]
        public void CreateEntity_ReturnsValidId()
        {
            var id = _manager.CreateEntity(Archetype.Default);
            Assert.That(id, Is.GreaterThan(0));
        }

        [Test]
        public void DestroyEntity_RemovesFromPool()
        {
            var id = _manager.CreateEntity(Archetype.Default);
            _manager.DestroyEntity(id);
            Assert.IsFalse(_manager.HasEntity(id));
        }

        [TestCase(1)]
        [TestCase(5)]
        [TestCase(100)]
        public void CreateMultiple_AllValid(int count)
        {
            for (int i = 0; i < count; i++)
            {
                var id = _manager.CreateEntity(Archetype.Default);
                Assert.That(id, Is.GreaterThan(0));
            }
        }
    }
}`.repeat(2); // Repeat to exceed default 2000 char limit

const largeCSharpNoTestMethods = `using UnityEngine;
using System.Collections.Generic;

namespace Game.Rendering
{
    public class RenderPipeline
    {
        private List<RenderPass> _passes = new();
        private Camera _mainCamera;
        private RenderTexture _target;

        public void Initialize(Camera cam, RenderTexture rt)
        {
            _mainCamera = cam;
            _target = rt;
        }

        public void AddPass(RenderPass pass)
        {
            _passes.Add(pass);
        }

        public void Execute()
        {
            foreach (var pass in _passes)
            {
                pass.Render(_mainCamera, _target);
            }
        }

        public void Cleanup()
        {
            _passes.Clear();
            _target = null;
        }
    }
}`.repeat(3); // Repeat to exceed default 2000 char limit

// ===========================================================================
// 1. Doc Chunker Tests
// ===========================================================================

describe("Doc Chunker", () => {
  const pkg = makePkg();

  describe("chunkMarkdown", () => {
    it("splits by headings", () => {
      const chunks = chunkMarkdown(sampleMarkdown, "docs/README.md", pkg, "framework_readme");

      // Should produce one chunk per heading-delimited section
      expect(chunks.length).toBeGreaterThanOrEqual(3);

      const titles = chunks.map((c) => c.title).filter(Boolean);
      expect(titles).toContain("Installation");
      expect(titles).toContain("Configuration");
      expect(titles).toContain("API Reference");
    });

    it("preserves code fences within sections", () => {
      const chunks = chunkMarkdown(markdownWithCodeFence, "docs/usage.md", pkg, "framework_docs");

      // The code fence should remain inside the section, not cause a split
      const usageChunk = chunks.find((c) => c.content.includes("GameManager"));
      expect(usageChunk).toBeDefined();
      expect(usageChunk!.content).toContain("```csharp");
      expect(usageChunk!.content).toContain("system.Initialize()");
    });

    it("splits large sections by paragraph", () => {
      // Build a markdown section with many paragraphs exceeding maxChunkChars
      const longParagraphs = Array.from({ length: 20 }, (_, i) =>
        `Paragraph ${i}: ${"Lorem ipsum dolor sit amet. ".repeat(10)}`
      ).join("\n\n");
      const largeMd = `# Overview\n\n${longParagraphs}`;

      const chunks = chunkMarkdown(largeMd, "docs/large.md", pkg, "framework_docs", 500);

      // With a 500-char limit, the large section should be split into multiple chunks
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        // Each chunk should not vastly exceed the limit (some tolerance for unsplittable paragraphs)
        expect(chunk.content.length).toBeLessThan(1500);
      }
    });

    it("assigns correct hierarchy", () => {
      const chunks = chunkMarkdown(sampleMarkdown, "docs/README.md", pkg, "framework_readme");

      // "Advanced Options" is an h3 under "Configuration" (h2) under "Installation" (h1)
      const advancedChunk = chunks.find((c) => c.title === "Advanced Options");
      expect(advancedChunk).toBeDefined();
      expect(advancedChunk!.hierarchy).toBeDefined();
      expect(advancedChunk!.hierarchy!.length).toBe(3);
      expect(advancedChunk!.hierarchy![0]).toBe("Installation");
      expect(advancedChunk!.hierarchy![1]).toBe("Configuration");
      expect(advancedChunk!.hierarchy![2]).toBe("Advanced Options");
    });

    it("uses correct docSource and chunk kind", () => {
      const readmeChunks = chunkMarkdown("# Hi\n\nWorld", "README.md", pkg, "framework_readme");
      expect(readmeChunks[0]!.docSource).toBe("framework_readme");
      expect(readmeChunks[0]!.kind).toBe("readme");

      const changelogChunks = chunkMarkdown("# Changelog\n\nv1.0", "CHANGELOG.md", pkg, "framework_changelog");
      expect(changelogChunks[0]!.docSource).toBe("framework_changelog");
      expect(changelogChunks[0]!.kind).toBe("changelog");

      const docsChunks = chunkMarkdown("# API\n\nDetails", "docs/api.md", pkg, "framework_docs");
      expect(docsChunks[0]!.docSource).toBe("framework_docs");
      expect(docsChunks[0]!.kind).toBe("markdown");
    });
  });

  describe("chunkXmlDocs", () => {
    it("extracts summary/param/returns", () => {
      const chunks = chunkXmlDocs(sampleXmlDocsCSharp, "EntityManager.cs", pkg);

      expect(chunks.length).toBeGreaterThanOrEqual(1);
      const entityMgrChunk = chunks.find((c) => c.title === "EntityManager");
      expect(entityMgrChunk).toBeDefined();
      expect(entityMgrChunk!.content).toContain("entity lifecycle");
      expect(entityMgrChunk!.content).toContain("**capacity**");
      expect(entityMgrChunk!.content).toContain("**Returns**");
    });

    it("associates with following declaration", () => {
      const chunks = chunkXmlDocs(sampleXmlDocsCSharp, "EntityManager.cs", pkg);

      // The CreateEntity method's doc should use the symbol from the declaration line
      const createChunk = chunks.find((c) => c.title === "CreateEntity");
      expect(createChunk).toBeDefined();
      expect(createChunk!.content).toContain("CreateEntity");
      expect(createChunk!.content).toContain("archetype");
      expect(createChunk!.kind).toBe("xml_doc");
      expect(createChunk!.docSource).toBe("xml_doc_comment");
    });

    it("ignores files without doc comments", () => {
      const chunks = chunkXmlDocs(csharpNoXmlDocs, "MathHelper.cs", pkg);
      expect(chunks).toHaveLength(0);
    });
  });

  describe("chunkCSharpExample", () => {
    it("small file becomes single chunk", () => {
      const chunks = chunkCSharpExample(smallCSharpExample, "Tests/SmallTest.cs", pkg);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.content).toBe(smallCSharpExample);
      expect(chunks[0]!.kind).toBe("api_doc");
      expect(chunks[0]!.docSource).toBe("framework_example");
      expect(chunks[0]!.title).toBe("SmallTest");
    });

    it("splits by [Test] methods", () => {
      const chunks = chunkCSharpExample(largeCSharpExample, "Tests/EntityTests.cs", pkg);

      // Should produce multiple chunks (one per test method)
      expect(chunks.length).toBeGreaterThan(1);

      const titles = chunks.map((c) => c.title);
      expect(titles).toContain("CreateEntity_ReturnsValidId");
      expect(titles).toContain("DestroyEntity_RemovesFromPool");
    });

    it("fallback for files without test methods", () => {
      const chunks = chunkCSharpExample(largeCSharpNoTestMethods, "Examples/RenderPipeline.cs", pkg);

      // No [Test] methods, so falls back to single truncated chunk
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.kind).toBe("api_doc");
      expect(chunks[0]!.title).toBe("RenderPipeline");
    });
  });
});

// ===========================================================================
// 2. Framework Reranker Tests
// ===========================================================================

describe("Framework Reranker", () => {
  describe("rerankWithFrameworkPriority", () => {
    it("framework docs ranked above code", () => {
      const docHit = makeVectorHit(0.7, {
        id: "doc-hit",
        content: "Entity management documentation",
        docSource: "framework_docs",
      });
      const codeHit = makeCodeHit(0.7, {
        id: "code-hit",
        content: "public class EntityManager {}",
      });

      const results = rerankWithFrameworkPriority("entity management", [codeHit, docHit]);

      // Doc hit should rank first due to source boost (framework_docs = 0.95 vs code = 0.50)
      expect(results[0]!.chunk.id).toBe("doc-hit");
    });

    it("readme scored highest", () => {
      const readmeHit = makeVectorHit(0.6, {
        id: "readme",
        content: "Framework overview and setup",
        docSource: "framework_readme",
      });
      const docsHit = makeVectorHit(0.6, {
        id: "docs",
        content: "Framework API details",
        docSource: "framework_docs",
      });
      const exampleHit = makeVectorHit(0.6, {
        id: "example",
        content: "Framework usage example",
        docSource: "framework_example",
      });

      const results = rerankWithFrameworkPriority("framework", [exampleHit, docsHit, readmeHit]);

      // framework_readme (1.0) > framework_docs (0.95) > framework_example (0.80)
      expect(results[0]!.chunk.id).toBe("readme");
    });

    it("keyword matching boosts relevant results", () => {
      const relevantHit = makeVectorHit(0.5, {
        id: "relevant",
        content: "ECS entity component system architecture overview",
        docSource: "framework_docs",
      });
      const irrelevantHit = makeVectorHit(0.8, {
        id: "irrelevant",
        content: "Unrelated rendering pipeline setup instructions",
        docSource: "framework_docs",
      });

      const results = rerankWithFrameworkPriority("entity component system", [irrelevantHit, relevantHit]);

      // Despite lower vector score, keyword match should push relevant hit higher
      expect(results[0]!.chunk.id).toBe("relevant");
    });

    it("structural matching boosts title matches", () => {
      const titleMatch = makeVectorHit(0.6, {
        id: "title-match",
        content: "Some content about systems",
        title: "EntityManager API",
        docSource: "framework_docs",
        kind: "markdown",
      });
      const noTitleMatch = makeVectorHit(0.6, {
        id: "no-title",
        content: "Some content about systems",
        title: "Unrelated Section",
        docSource: "framework_docs",
        kind: "markdown",
      });

      const results = rerankWithFrameworkPriority("entity", [noTitleMatch, titleMatch]);

      // Title containing "entity" gets structural boost
      expect(results[0]!.chunk.id).toBe("title-match");
    });

    it("respects custom config weights", () => {
      const highVector = makeVectorHit(0.9, {
        id: "high-vec",
        content: "Unrelated content here",
        docSource: "project_docs",
      });
      const lowVectorKeyword = makeVectorHit(0.2, {
        id: "keyword-match",
        content: "damage health combat system",
        docSource: "project_docs",
      });

      // Give all weight to keywords
      const results = rerankWithFrameworkPriority("damage health combat", [highVector, lowVectorKeyword], {
        vectorWeight: 0,
        keywordWeight: 1,
        structuralWeight: 0,
        sourceBoostWeight: 0,
        recencyWeight: 0,
      });

      expect(results[0]!.chunk.id).toBe("keyword-match");
    });
  });
});

// ===========================================================================
// 3. Version Tagger Tests
// ===========================================================================

describe("Version Tagger", () => {
  describe("discoverPackageRoots", () => {
    it("finds installed packages", () => {
      const deps: StradaDepsStatus = {
        coreInstalled: true,
        corePath: "/mock/strada-core",
        modulesInstalled: true,
        modulesPath: "/mock/strada-modules",
        mcpInstalled: true,
        mcpPath: "/mock/strada-mcp",
        mcpVersion: "2.0.0",
        warnings: [],
      };

      // Mock readPackageVersion since it does FS I/O
      // discoverPackageRoots calls readPackageVersion internally, but will fall
      // back to "0.0.0" when the path doesn't exist on disk — that's acceptable.
      const roots = discoverPackageRoots(deps);

      expect(roots).toHaveLength(3);
      expect(roots.map((r) => r.name)).toEqual(["strada.core", "strada.modules", "strada.mcp"]);
      expect(roots[0]!.path).toBe("/mock/strada-core");
      expect(roots[1]!.path).toBe("/mock/strada-modules");
      expect(roots[2]!.path).toBe("/mock/strada-mcp");
      // MCP should use the mcpVersion from deps status
      expect(roots[2]!.version).toBe("2.0.0");
    });

    it("skips uninstalled packages", () => {
      const deps: StradaDepsStatus = {
        coreInstalled: true,
        corePath: "/mock/strada-core",
        modulesInstalled: false,
        modulesPath: null,
        mcpInstalled: false,
        mcpPath: null,
        mcpVersion: null,
        warnings: [],
      };

      const roots = discoverPackageRoots(deps);

      expect(roots).toHaveLength(1);
      expect(roots[0]!.name).toBe("strada.core");
    });
  });

  describe("hasVersionChanged", () => {
    it("detects version change", () => {
      const current = makePkg({ version: "2.0.0" });
      expect(hasVersionChanged(current, "1.0.0")).toBe(true);
    });

    it("detects no change", () => {
      const current = makePkg({ version: "1.2.3" });
      expect(hasVersionChanged(current, "1.2.3")).toBe(false);
    });

    it("returns true when stored version is null", () => {
      const current = makePkg({ version: "1.0.0" });
      expect(hasVersionChanged(current, null)).toBe(true);
    });
  });
});

// ===========================================================================
// 4. Doc RAG Interface Tests
// ===========================================================================

describe("Doc RAG Interface", () => {
  describe("isFrameworkDocChunk", () => {
    it("returns true for framework doc chunks", () => {
      const chunk = makeDocChunk();
      expect(isFrameworkDocChunk(chunk)).toBe(true);
    });

    it("returns false for plain objects", () => {
      expect(isFrameworkDocChunk({})).toBe(false);
      expect(isFrameworkDocChunk(null)).toBe(false);
      expect(isFrameworkDocChunk(undefined)).toBe(false);
      expect(isFrameworkDocChunk("string")).toBe(false);
      expect(isFrameworkDocChunk(42)).toBe(false);
    });

    it("returns false for objects missing required fields", () => {
      expect(isFrameworkDocChunk({ packageName: "foo" })).toBe(false);
      expect(isFrameworkDocChunk({ docSource: "framework_readme" })).toBe(false);
    });

    it("returns true for objects with both required fields", () => {
      expect(isFrameworkDocChunk({ packageName: "foo", docSource: "framework_docs" })).toBe(true);
    });
  });

  describe("DOC_SOURCE_PRIORITY", () => {
    it("framework_readme is highest (1.0)", () => {
      expect(DOC_SOURCE_PRIORITY.framework_readme).toBe(1.0);
    });

    it("all doc source types have defined priority", () => {
      const expectedSources: DocSourceType[] = [
        "framework_readme",
        "framework_changelog",
        "framework_docs",
        "xml_doc_comment",
        "framework_example",
        "api_summary",
        "project_readme",
        "project_docs",
      ];

      for (const source of expectedSources) {
        expect(DOC_SOURCE_PRIORITY[source]).toBeDefined();
        expect(DOC_SOURCE_PRIORITY[source]).toBeGreaterThan(0);
        expect(DOC_SOURCE_PRIORITY[source]).toBeLessThanOrEqual(1.0);
      }
    });

    it("framework sources outrank project sources", () => {
      expect(DOC_SOURCE_PRIORITY.framework_readme).toBeGreaterThan(DOC_SOURCE_PRIORITY.project_readme);
      expect(DOC_SOURCE_PRIORITY.framework_docs).toBeGreaterThan(DOC_SOURCE_PRIORITY.project_docs);
    });

    it("priorities are in expected descending order", () => {
      expect(DOC_SOURCE_PRIORITY.framework_readme).toBeGreaterThanOrEqual(DOC_SOURCE_PRIORITY.framework_docs);
      expect(DOC_SOURCE_PRIORITY.framework_docs).toBeGreaterThanOrEqual(DOC_SOURCE_PRIORITY.api_summary);
      expect(DOC_SOURCE_PRIORITY.api_summary).toBeGreaterThanOrEqual(DOC_SOURCE_PRIORITY.xml_doc_comment);
      expect(DOC_SOURCE_PRIORITY.xml_doc_comment).toBeGreaterThanOrEqual(DOC_SOURCE_PRIORITY.framework_example);
      expect(DOC_SOURCE_PRIORITY.framework_example).toBeGreaterThanOrEqual(DOC_SOURCE_PRIORITY.framework_changelog);
    });
  });
});
