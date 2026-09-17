import { describe, it, expect, vi } from "vitest";
import type { CodeChunk, DocumentationChunk, SearchResult } from "../rag.interface.js";
import { estimateTokens } from "../rag.interface.js";
import type { RAGPipeline } from "../rag-pipeline.js";
import type { DocRAGPipeline } from "./doc-rag-pipeline.js";

vi.mock("../../utils/logger.js", () => ({
  getLoggerSafe: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  getLogger: () => ({
    info: () => undefined,
    debug: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  }),
}));

import { CompositeRAGPipeline } from "./composite-rag-pipeline.js";

function makeComposite(): CompositeRAGPipeline {
  // formatContext touches neither pipeline nor the embedder.
  return new CompositeRAGPipeline(
    {} as RAGPipeline,
    {} as DocRAGPipeline,
    { name: "stub", dimensions: 4, embed: vi.fn() } as never,
    [],
  );
}

function codeResult(id: string, content: string, score: number): SearchResult {
  const chunk: CodeChunk = {
    id,
    content,
    contentHash: `hash-${id}`,
    filePath: `Assets/${id}.cs` as never,
    indexedAt: new Date().toISOString() as never,
    kind: "class",
    startLine: 1,
    endLine: 20,
    language: "csharp",
    symbol: id,
  };
  return { chunk, vectorScore: score as never, finalScore: score as never };
}

function docResult(id: string, content: string, score: number): SearchResult {
  const chunk: DocumentationChunk = {
    id,
    content,
    contentHash: `hash-${id}`,
    filePath: `Packages/${id}.md` as never,
    indexedAt: new Date().toISOString() as never,
    kind: "markdown",
    title: `Doc ${id}`,
  };
  return { chunk, vectorScore: score as never, finalScore: score as never };
}

describe("CompositeRAGPipeline.formatContext", () => {
  /**
   * D48 / audit 05.F5: the caller reported every result it handed in as "shown",
   * while the budget loop silently dropped the tail.
   */
  it("reports exactly the spans it rendered (D48)", () => {
    const composite = makeComposite();
    const results = [
      codeResult("Big", "x".repeat(2000), 0.9),
      codeResult("Tail", "y".repeat(2000), 0.5),
    ];

    const formatted = composite.formatContextWithSpans(results, { maxTokens: 600 });

    expect(formatted.included.map((r) => r.chunk.id)).toEqual(["Big"]);
    expect(formatted.dropped.map((r) => r.chunk.id)).toEqual(["Tail"]);
    expect(formatted.text).toContain("Big");
    expect(formatted.text).not.toContain("y".repeat(2000));
    // The convenience wrapper still returns just the text.
    expect(composite.formatContext(results, { maxTokens: 600 })).toBe(formatted.text);
  });

  it("guarantees at least one span per contributing source (D48)", () => {
    const composite = makeComposite();
    // The code hit is ranked first and alone exhausts the budget, so the doc
    // source contributed nothing while the search reported it as a contributor.
    const results = [
      codeResult("Pooling", "c".repeat(2400), 0.9),
      docResult("ObjectPool", "the framework's pooling contract", 0.8),
    ];

    const formatted = composite.formatContextWithSpans(results, { maxTokens: 600 });

    expect(formatted.included.map((r) => r.chunk.id)).toEqual(
      expect.arrayContaining(["Pooling", "ObjectPool"]),
    );
    expect(formatted.text).toContain("the framework's pooling contract");
    expect(formatted.dropped).toHaveLength(0);
  });

  it("truncates the guaranteed span instead of blowing the budget (D48 guard)", () => {
    const composite = makeComposite();
    const results = [
      codeResult("Pooling", "c".repeat(2400), 0.9),
      docResult("ObjectPool", "d".repeat(4000), 0.8),
    ];

    const formatted = composite.formatContextWithSpans(results, { maxTokens: 600 });

    const doc = formatted.included.find((r) => r.chunk.id === "ObjectPool");
    expect(doc).toBeDefined();
    // Rendered, but clamped — and what it reports as included is what it rendered.
    expect(doc!.chunk.content.length).toBeLessThan(4000);
    expect(formatted.text).toContain(doc!.chunk.content);
    // Round 10 #18: the budget is a CEILING, not a target with 50% slack. The
    // separator between spans counts, and a guaranteed slice that does not fit
    // is not rendered at all.
    expect(estimateTokens(formatted.text)).toBeLessThanOrEqual(600);
  });

  it("counts the separator: a budget that fits two spans but not the joiner takes one (round 10 #18)", () => {
    const composite = makeComposite();
    // Two CODE spans, so the per-source guarantee does not enter into it.
    const first = codeResult("First", "a".repeat(200), 0.9);
    const second = codeResult("Second", "b".repeat(200), 0.8);
    const spanTokens = estimateTokens(composite.formatContextWithSpans([first], { maxTokens: 10_000 }).text);
    const bothTokens = estimateTokens(composite.formatContextWithSpans([first, second], { maxTokens: 10_000 }).text);
    const separatorTokens = bothTokens - 2 * spanTokens;
    expect(separatorTokens).toBeGreaterThan(0);

    // Exactly the two spans and nothing for the joiner: only one may be shown.
    const tight = composite.formatContextWithSpans([first, second], { maxTokens: 2 * spanTokens });
    expect(tight.included).toHaveLength(1);
    expect(estimateTokens(tight.text)).toBeLessThanOrEqual(2 * spanTokens);
    // One more token for the joiner and both fit (guard).
    const roomy = composite.formatContextWithSpans([first, second], { maxTokens: 2 * spanTokens + separatorTokens });
    expect(roomy.included).toHaveLength(2);
  });

  it("never exceeds the requested budget, separators included, down to a tiny one (round 10 #18)", () => {
    const composite = makeComposite();
    const results = [
      codeResult("Pooling", "c".repeat(2400), 0.9),
      docResult("ObjectPool", "d".repeat(4000), 0.8),
    ];
    for (const maxTokens of [400, 200, 80, 40, 12]) {
      const formatted = composite.formatContextWithSpans(results, { maxTokens });
      expect(estimateTokens(formatted.text)).toBeLessThanOrEqual(maxTokens);
      // …and what it says it included is exactly what the text carries.
      for (const included of formatted.included) {
        expect(formatted.text).toContain(included.chunk.content);
      }
      // A source that could not fit is reported as dropped, never as shown.
      const shownIds = new Set(formatted.included.map((r) => r.chunk.id));
      for (const dropped of formatted.dropped) expect(shownIds.has(dropped.chunk.id)).toBe(false);
    }
  });

  it("returns nothing for no results", () => {
    const composite = makeComposite();
    const formatted = composite.formatContextWithSpans([], { maxTokens: 600 });
    expect(formatted.text).toBe("");
    expect(formatted.included).toEqual([]);
    expect(formatted.dropped).toEqual([]);
  });
});
