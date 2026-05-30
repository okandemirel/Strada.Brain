import { describe, it, expect } from "vitest";
import { buildCanvas } from "./canvas-generator.js";
import type { VaultFile, VaultSymbol, VaultWikilink } from "./vault.interface.js";

function file(path: string): VaultFile {
  return { path, blobHash: "h", mtimeMs: 0, size: 1, lang: "markdown", kind: "doc", indexedAt: 0 };
}

function symbol(i: number, path: string): VaultSymbol {
  return {
    symbolId: `s${i}`, path, kind: "note", name: `s${i}`,
    display: `s${i}`, startLine: 1, endLine: 1, doc: null,
  };
}

describe("buildCanvas file-graph edge direction", () => {
  it("stores deduped file edges in canonical (deterministic) order", () => {
    // >500 symbols forces the file-level graph path.
    const symbols: VaultSymbol[] = Array.from({ length: 501 }, (_, i) => symbol(i, "A.md"));
    const files = [file("A.md"), file("B.md")];
    // The wikilink points B -> A. Canonical order is A < B, so the rendered
    // file edge must be A -> B regardless of the link's direction — previously
    // it kept the first-seen B -> A ordering (non-deterministic arrow).
    const wikilinks: VaultWikilink[] = [{ fromNote: "B.md", target: "A.md", resolved: true }];

    const canvas = buildCanvas({ symbols, edges: [], files, wikilinks });
    const fileEdges = canvas.edges.filter(
      (e) =>
        (e.fromNode === "A.md" || e.fromNode === "B.md") &&
        (e.toNode === "A.md" || e.toNode === "B.md"),
    );
    expect(fileEdges).toHaveLength(1);
    expect(fileEdges[0]!.fromNode).toBe("A.md");
    expect(fileEdges[0]!.toNode).toBe("B.md");
  });
});
